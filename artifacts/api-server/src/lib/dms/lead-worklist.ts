/**
 * The enquiry mirror, and the two things it can see that the dealer cannot.
 *
 * Third instance of the pattern, and the one with money and a contract on it.
 *
 * **The OEM response clock.** A lead the manufacturer generates and pushes down
 * is timed — thirty minutes is the industry mandate — and future lead
 * allocation depends on hitting it. The dealer's CRM records when contact
 * happened; it does not sit there counting minutes on a lead nobody has opened,
 * because no screen is watching an empty field.
 *
 * **Leads owned by people who left.** The DMS goes on showing the departed
 * executive's name against an enquiry until somebody edits every record by
 * hand, and nobody does. Their CRM screen knows the assignment and their HR
 * screen knows the leaving date; neither knows both. Mirroring both is what
 * makes the join possible, and the join is the staff-shortage argument in its
 * concrete form: not "we are stretched" but "these eleven customers have nobody
 * looking at them".
 */

import { createHash } from "node:crypto";
import { and, eq, isNull, notInArray, desc } from "drizzle-orm";
import {
  db,
  dmsEmployeesTable,
  dmsEnquiriesTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { dmsEmployees } from "./client";
import { enquirySourceFor } from "./ingest";
import { toIsoDate } from "./hero-adapter";
import type { DmsEnquiry } from "./types";
import type { Listed } from "./ingest";

/** The OEM's first-response mandate. Thirty minutes is the common figure. */
function slaMinutes(): number {
  const raw = Number(process.env["OEM_RESPONSE_SLA_MINUTES"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export interface EnquirySyncResult {
  showroomId: number;
  dealerCode: string;
  seen: number;
  added: number;
  changed: number;
  unchanged: number;
  disappeared: number;
  employees: number;
  durationMs: number;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/**
 * `DD-MM-YYYY HH:mm:ss` → Date.
 *
 * Kept here rather than reusing a date-only helper because dropping the time
 * would silently turn every SLA measurement into zero.
 */
function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
  return Number.isNaN(d.getTime()) ? null : d;
}

function project(e: DmsEnquiry) {
  return {
    enquiredAt: parseStamp(e.enqDt),
    source: e.source,
    grade: e.grade,
    stage: e.stage,
    customerName: e.custName,
    customerMobile: e.mobileNo,
    modelInterest: e.modelCodeInterest,
    assignedEmpCode: e.assignedEmpCode,
    firstContactAt: parseStamp(e.firstContactAt),
    lastContactDate: toIsoDate(e.lastContactDt) || null,
    nextFollowUpDate: toIsoDate(e.nextFollowUpDt) || null,
    lostReason: e.lostReasonDesc,
    convertedDealId: e.convertedDealId,
  };
}

export async function syncShowroomEnquiries(showroomId: number): Promise<EnquirySyncResult[]> {
  const accounts = await db
    .select({ dealerCode: showroomDmsAccountsTable.dealerCode })
    .from(showroomDmsAccountsTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, showroomDmsAccountsTable.showroomId))
    .where(
      and(
        eq(showroomDmsAccountsTable.showroomId, showroomId),
        eq(showroomDmsAccountsTable.isActive, true),
        eq(showroomsTable.isActive, true),
      ),
    );

  const results: EnquirySyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncDealerEnquiries(showroomId, account.dealerCode));
  }
  return results;
}

async function syncDealerEnquiries(
  showroomId: number,
  dealerCode: string,
): Promise<EnquirySyncResult> {
  const startedAt = Date.now();

  // Staff first: the enquiry derivation joins against it, and a stale roster
  // would report a lead as owned when its owner left last month.
  const staff = await dmsEmployees(dealerCode);
  for (const emp of staff) {
    await db
      .insert(dmsEmployeesTable)
      .values({
        showroomId,
        dealerCode,
        empCode: emp.empCode,
        empName: emp.empName,
        role: emp.role,
        dateOfJoining: toIsoDate(emp.doj) || null,
        dateOfLeaving: toIsoDate(emp.dol) || null,
        isActive: emp.activeFlg,
        mobileNo: emp.mobileNo,
        emailId: emp.emailId,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [dmsEmployeesTable.dealerCode, dmsEmployeesTable.empCode],
        set: {
          empName: emp.empName,
          role: emp.role,
          dateOfLeaving: toIsoDate(emp.dol) || null,
          isActive: emp.activeFlg,
          mobileNo: emp.mobileNo,
          emailId: emp.emailId,
          lastSyncedAt: new Date(),
        },
      });
  }

  /*
   * The one line that made three paths possible, a second time.
   *
   * Everything below is written against `Source<DmsEnquiry>` and cannot tell
   * the OEM's API from a register somebody exported this morning. A dealership
   * nobody has configured resolves to `API` and behaves exactly as it did
   * before — the property that made changing this file safe, and the same one
   * `sync.ts` relies on for deals.
   */
  const source = await enquirySourceFor(showroomId, dealerCode);
  const listed = await source.list();

  const existing = await db
    .select({
      enqId: dmsEnquiriesTable.enqId,
      rawHash: dmsEnquiriesTable.rawHash,
      stage: dmsEnquiriesTable.stage,
    })
    .from(dmsEnquiriesTable)
    .where(eq(dmsEnquiriesTable.dealerCode, dealerCode));

  const known = new Map(existing.map((r) => [r.enqId, r]));

  let added = 0;
  let changed = 0;
  let unchanged = 0;

  /*
   * Which ones to load in full.
   *
   * The listing carries a fingerprint of whatever the source could see cheaply,
   * so a lead whose fingerprint has not moved needs no expensive load. On the
   * API path that is one round trip instead of a hundred and forty; on the
   * report path the file is already in hand and this costs nothing.
   */
  const toLoad: string[] = [];
  for (const l of listed) {
    const prior = known.get(l.key);
    if (prior && prior.rawHash === l.fingerprint) {
      await db
        .update(dmsEnquiriesTable)
        .set({ lastSyncedAt: new Date(), disappearedAt: null })
        .where(and(eq(dmsEnquiriesTable.dealerCode, dealerCode), eq(dmsEnquiriesTable.enqId, l.key)));
      unchanged++;
      continue;
    }
    toLoad.push(l.key);
  }

  const fingerprintOf = new Map(listed.map((l: Listed) => [l.key, l.fingerprint]));

  for (const sourced of await source.load(toLoad)) {
    const enquiry = sourced.record;
    const summaryHash = fingerprintOf.get(sourced.key) ?? hashOf(enquiry);
    const prior = known.get(sourced.key);

    const projected = project(enquiry);
    const now = new Date();

    if (!prior) {
      await db.insert(dmsEnquiriesTable).values({
        showroomId,
        dealerCode,
        enqId: enquiry.enqId,
        ...projected,
        raw: enquiry as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        firstSeenAt: now,
        stageSince: now,
        lastSyncedAt: now,
        lastChangedAt: null,
      });
      added++;
      continue;
    }

    const stageMoved = prior.stage !== projected.stage;
    await db
      .update(dmsEnquiriesTable)
      .set({
        showroomId,
        ...projected,
        raw: enquiry as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
        ...(stageMoved ? { stageSince: now } : {}),
      })
      .where(and(eq(dmsEnquiriesTable.dealerCode, dealerCode), eq(dmsEnquiriesTable.enqId, enquiry.enqId)));
    changed++;
  }

  /*
   * Disappearance, and only where the source is entitled to claim it.
   *
   * An API lists the outlet's whole register every time, so a lead that stops
   * appearing has genuinely gone. A report that covered one month says nothing
   * about the other eleven — marking every lead outside the export as vanished
   * because somebody dropped July's file is the mistake a path-blind sync makes
   * unless it asks. Same rule as deals, and the same reason.
   */
  const seenIds = listed.map((l) => l.key);
  const gone = source.listIsComplete
    ? await db
        .update(dmsEnquiriesTable)
        .set({ disappearedAt: new Date() })
        .where(
          and(
            eq(dmsEnquiriesTable.dealerCode, dealerCode),
            isNull(dmsEnquiriesTable.disappearedAt),
            ...(seenIds.length > 0 ? [notInArray(dmsEnquiriesTable.enqId, seenIds)] : []),
          ),
        )
        .returning({ enqId: dmsEnquiriesTable.enqId })
    : [];

  // An empty *complete* listing is a fault, not an empty pipeline. An empty
  // incomplete one is a dealership that has dropped no file yet, which is the
  // ordinary state on the day they are onboarded and not worth a warning.
  if (seenIds.length === 0 && source.listIsComplete) {
    logger.warn({ dealerCode }, "DMS returned zero enquiries — treating as a fault, not an empty pipeline");
  }

  const result: EnquirySyncResult = {
    showroomId,
    dealerCode,
    seen: listed.length,
    added,
    changed,
    unchanged,
    disappeared: gone.length,
    employees: staff.length,
    durationMs: Date.now() - startedAt,
  };
  logger.info(result, "DMS enquiry sync complete");
  return result;
}

// ── Derivation ──────────────────────────────────────────────────────────────

export type LeadState =
  | "SLA_BREACHED"
  | "CLOCK_RUNNING"
  | "NO_OWNER"
  | "UNCONTACTED"
  | "FOLLOW_UP_OVERDUE"
  | "ON_TRACK"
  | "CONVERTED"
  | "LOST";

export interface LeadWorklistRow {
  enqId: string;
  dealerCode: string;
  showroomId: number;
  customerName: string | null;
  customerMobile: string | null;
  modelInterest: string | null;
  dms: {
    source: string;
    grade: string | null;
    stage: string;
    enquiredAt: string | null;
    firstContactAt: string | null;
    nextFollowUpDate: string | null;
    assignedEmpCode: string | null;
    assignedEmpName: string | null;
    assignedEmpActive: boolean;
    assignedEmpLeftOn: string | null;
    lostReason: string | null;
    convertedDealId: string | null;
  };
  ddms: {
    reassignedToEmpCode: string | null;
    /**
     * When *we* recorded a contact. Never conflated with the DMS's own
     * `firstContactAt` above — see `slaNote`.
     */
    contactedAt: string | null;
    contactChannel: string | null;
  };
  state: LeadState;
  /**
   * The honest limit, present only when it matters: we have logged a contact
   * and the dealer's CRM still has not. The manufacturer measures their field,
   * so their clock is still running however diligent the dealership has been.
   */
  slaNote: string | null;
  note: string | null;
  actionRequired: string | null;
  /**
   * Minutes taken to first contact, or minutes elapsed so far when nobody has
   * made contact. Null when the source carries no response mandate.
   */
  responseMinutes: number | null;
  /** Minutes left before the OEM window closes. Negative once it has. */
  minutesToSla: number | null;
  followUpDaysOverdue: number;
  lastSyncedAt: string;
}

/** "by phone", "over WhatsApp" — for a sentence rather than a badge. */
function describeContact(channel: string | null): string {
  switch (channel) {
    case "WHATSAPP": return "over WhatsApp";
    case "SMS": return "by text";
    case "EMAIL": return "by email";
    case "VISIT": return "in person";
    default: return "by phone";
  }
}

function classify(args: {
  source: string;
  stage: string;
  enquiredAt: Date | null;
  firstContactAt: Date | null;
  contactedAt: Date | null;
  ownerActive: boolean;
  ownerName: string | null;
  ownerLeftOn: string | null;
  reassignedTo: string | null;
  followUpDaysOverdue: number;
  minutesToSla: number | null;
  responseMinutes: number | null;
  slaMinutes: number;
  now: Date;
}): { state: LeadState; note: string | null; action: string | null } {
  const {
    source, stage, firstContactAt, contactedAt, ownerActive, ownerName, ownerLeftOn,
    reassignedTo, followUpDaysOverdue, minutesToSla, responseMinutes,
  } = args;

  // Either system having a contact means somebody rang them. Only the DMS's
  // field stops the manufacturer's clock, and `slaNote` on the row says so —
  // but for "is anybody working this lead", ours counts.
  const anyContact = firstContactAt ?? contactedAt;

  if (stage === "BOOKED") {
    return { state: "CONVERTED", note: "Booked. Converted to a deal.", action: null };
  }
  if (stage === "LOST") {
    return { state: "LOST", note: args.enquiredAt ? "Closed as lost." : null, action: null };
  }

  const oemMandated = source === "OEM_PORTAL";

  // The clock first, because it is the only thing here measured in minutes and
  // the only one with the manufacturer watching.
  //
  // Deliberately keyed on the DMS's `firstContactAt` and not on ours. The
  // manufacturer measures their own field; a call we logged and nobody keyed
  // into the OEM portal does not stop their clock, and a screen that pretended
  // otherwise would tell an owner they were compliant while the manufacturer's
  // report said they were not. What our record changes is the *advice*.
  if (oemMandated && !firstContactAt) {
    const keyIn = `Key the contact into the OEM portal against this lead`;

    if (minutesToSla !== null && minutesToSla <= 0) {
      return contactedAt
        ? {
            state: "SLA_BREACHED",
            note: `Contacted and recorded here, but the manufacturer's record still shows no contact and the window closed ${Math.abs(minutesToSla)} minutes ago.`,
            action: keyIn,
          }
        : {
            state: "SLA_BREACHED",
            note: `Manufacturer lead, ${responseMinutes} minutes old and still not contacted. The response window closed ${Math.abs(minutesToSla)} minutes ago.`,
            action: "Call now — this is already reportable to the OEM",
          };
    }

    return contactedAt
      ? {
          state: "CLOCK_RUNNING",
          note: `Contacted and recorded here. ${minutesToSla} minutes left to get it into the manufacturer's portal.`,
          action: keyIn,
        }
      : {
          state: "CLOCK_RUNNING",
          note: `Manufacturer lead. ${minutesToSla} minutes left to make first contact.`,
          action: "Call now, before the response window closes",
        };
  }

  // Contacted, but too late. Nothing to do now — it is already a number in the
  // OEM's report, and counting it is the only way the owner ever learns.
  if (oemMandated && firstContactAt && responseMinutes !== null && minutesToSla !== null && minutesToSla < 0) {
    return {
      state: "SLA_BREACHED",
      note: `First contact took ${responseMinutes} minutes, against the ${args.slaMinutes}-minute mandate.`,
      action: null,
    };
  }

  // Nobody is looking at this at all — worse than late, because late implies
  // someone is on it.
  if (!ownerActive && !reassignedTo) {
    return {
      state: "NO_OWNER",
      note: ownerLeftOn
        ? `Assigned to ${ownerName ?? "an employee"}, who left on ${ownerLeftOn}. It has not been reassigned.`
        : `Assigned to ${ownerName ?? "someone"} who is no longer active.`,
      action: "Reassign to someone still here",
    };
  }

  if (!anyContact) {
    return {
      state: "UNCONTACTED",
      note: "No contact has been recorded yet.",
      action: "Make first contact",
    };
  }

  if (followUpDaysOverdue > 0) {
    return {
      state: "FOLLOW_UP_OVERDUE",
      note: `Follow-up was due ${followUpDaysOverdue} day${followUpDaysOverdue === 1 ? "" : "s"} ago.`,
      action: "Make the follow-up call",
    };
  }

  return { state: "ON_TRACK", note: null, action: null };
}

function wholeDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

export async function buildLeadWorklist(opts: {
  showroomId: number;
  stage?: string;
}): Promise<LeadWorklistRow[]> {
  const rows = await db
    .select({ e: dmsEnquiriesTable, emp: dmsEmployeesTable })
    .from(dmsEnquiriesTable)
    // Left join: an enquiry can name an employee code the staff master has
    // never heard of, and that is itself worth showing rather than dropping.
    .leftJoin(
      dmsEmployeesTable,
      and(
        eq(dmsEmployeesTable.dealerCode, dmsEnquiriesTable.dealerCode),
        eq(dmsEmployeesTable.empCode, dmsEnquiriesTable.assignedEmpCode),
      ),
    )
    .where(
      and(
        eq(dmsEnquiriesTable.showroomId, opts.showroomId),
        opts.stage ? eq(dmsEnquiriesTable.stage, opts.stage) : undefined,
        isNull(dmsEnquiriesTable.disappearedAt),
      ),
    )
    .orderBy(desc(dmsEnquiriesTable.enquiredAt));

  const now = new Date();
  const sla = slaMinutes();

  return rows.map(({ e, emp }) => {
    const elapsedMinutes = e.enquiredAt
      ? Math.floor((now.getTime() - e.enquiredAt.getTime()) / 60_000)
      : null;
    const responseMinutes =
      e.enquiredAt && e.firstContactAt
        ? Math.floor((e.firstContactAt.getTime() - e.enquiredAt.getTime()) / 60_000)
        : elapsedMinutes;

    const minutesToSla =
      e.source === "OEM_PORTAL" && responseMinutes !== null ? sla - responseMinutes : null;

    const followUpDaysOverdue =
      e.nextFollowUpDate && e.stage !== "BOOKED" && e.stage !== "LOST"
        ? Math.max(0, wholeDaysBetween(new Date(e.nextFollowUpDate), now))
        : 0;

    const { state, note, action } = classify({
      source: e.source,
      stage: e.stage,
      enquiredAt: e.enquiredAt,
      firstContactAt: e.firstContactAt,
      ownerActive: emp ? emp.isActive === "Y" : true,
      ownerName: emp?.empName ?? null,
      ownerLeftOn: emp?.dateOfLeaving ?? null,
      reassignedTo: e.reassignedToEmpCode,
      // Our own contact record counts for the derived state — a lead somebody
      // has actually rung is not "uncontacted", whatever their CRM says.
      contactedAt: e.contactedAt,
      followUpDaysOverdue,
      minutesToSla,
      responseMinutes,
      slaMinutes: sla,
      now,
    });

    return {
      enqId: e.enqId,
      dealerCode: e.dealerCode,
      showroomId: e.showroomId,
      customerName: e.customerName,
      customerMobile: e.customerMobile,
      modelInterest: e.modelInterest,
      dms: {
        source: e.source,
        grade: e.grade,
        stage: e.stage,
        enquiredAt: e.enquiredAt?.toISOString() ?? null,
        firstContactAt: e.firstContactAt?.toISOString() ?? null,
        nextFollowUpDate: e.nextFollowUpDate,
        assignedEmpCode: e.assignedEmpCode,
        assignedEmpName: emp?.empName ?? null,
        assignedEmpActive: emp ? emp.isActive === "Y" : true,
        assignedEmpLeftOn: emp?.dateOfLeaving ?? null,
        lostReason: e.lostReason,
        convertedDealId: e.convertedDealId,
      },
      ddms: {
        reassignedToEmpCode: e.reassignedToEmpCode,
        contactedAt: e.contactedAt?.toISOString() ?? null,
        contactChannel: e.contactChannel,
      },
      state,
      note,
      actionRequired: action,
      // Said only when it is true and only when it matters: we have a contact
      // logged and the dealer's CRM does not. The integration is read-only, so
      // this gap cannot be closed by us — and the manufacturer measures their
      // field, not ours.
      slaNote:
        e.contactedAt && !e.firstContactAt && e.source === "OEM_PORTAL"
          ? `Contacted ${describeContact(e.contactChannel)} and recorded here. ` +
            `The manufacturer's clock only stops once this is keyed into their ` +
            `portal against ${e.enqId} — their record still shows no contact.`
          : null,
      responseMinutes,
      minutesToSla,
      followUpDaysOverdue,
      lastSyncedAt: e.lastSyncedAt.toISOString(),
    };
  });
}

export interface LeadWorklistSummary {
  total: number;
  byState: Record<LeadState, number>;
  needsAction: number;
  /** OEM leads whose response window has already closed. */
  slaBreached: number;
  /** Live leads with nobody active against them. */
  orphaned: number;
  slaMinutes: number;
  lastSyncedAt: string | null;
}

export function summariseLeads(rows: LeadWorklistRow[]): LeadWorklistSummary {
  const byState = {
    SLA_BREACHED: 0, CLOCK_RUNNING: 0, NO_OWNER: 0, UNCONTACTED: 0,
    FOLLOW_UP_OVERDUE: 0, ON_TRACK: 0, CONVERTED: 0, LOST: 0,
  } as Record<LeadState, number>;

  let needsAction = 0;
  let lastSynced: string | null = null;

  for (const r of rows) {
    byState[r.state]++;
    if (r.actionRequired) needsAction++;
    if (!lastSynced || r.lastSyncedAt > lastSynced) lastSynced = r.lastSyncedAt;
  }

  return {
    total: rows.length,
    byState,
    needsAction,
    slaBreached: byState.SLA_BREACHED,
    orphaned: byState.NO_OWNER,
    slaMinutes: slaMinutes(),
    lastSyncedAt: lastSynced,
  };
}
