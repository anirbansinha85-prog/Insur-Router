/**
 * The registration mirror, and what it means.
 *
 * Fourth instance of the pattern the deal mirror established: pull, keep,
 * derive on read, never write back. The sync below is the same three behaviours
 * as the other three — cheap when nothing moved, a status clock that only
 * advances on real status change, and vanishing rows marked rather than
 * deleted. There is nothing novel in it, which is the argument for having built
 * the pattern.
 *
 * The derivation is where this module earns its place. A registration file is
 * the longest-running open item in a dealership and the one with the most hands
 * in it — the customer, the dealer, an RTO agent, the state's tax counter, the
 * RTO itself — so it can stall in six different places for six different
 * reasons, and the DMS records exactly one of them: the current status label.
 *
 * Two of the states below exist nowhere in the dealer's own system:
 *
 * **RC_IN_DRAWER.** The DMS considers a vehicle finished at `REGISTERED`,
 * because that is when a number is allotted and the sale can be reported.
 * Whether the certificate ever reached its owner is two fields further down the
 * record, and no screen puts them beside each other. A card in a drawer is not
 * a state anybody's report has.
 *
 * **TAX_HELD.** Road tax is collected from the customer at invoice and remitted
 * to the state afterwards. Both dates exist; nothing subtracts them. The gap is
 * somebody else's money sitting in the dealer's account, and the customer's
 * file cannot move until it closes.
 */

import { createHash } from "node:crypto";
import { and, eq, isNull, notInArray, asc } from "drizzle-orm";
import {
  db,
  dmsRegistrationsTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { dmsRegistrations, fetchRegnFile } from "./client";
import { toIsoDate, toAmount } from "./hero-adapter";
import type { DmsRegnFile } from "./types";

export interface RegistrationSyncResult {
  showroomId: number;
  dealerCode: string;
  seen: number;
  added: number;
  changed: number;
  unchanged: number;
  disappeared: number;
  durationMs: number;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function project(f: DmsRegnFile) {
  const pending = f.docs.filter((d) => d.receivedFlg === "N");

  return {
    status: f.status,
    dealId: f.dealId,
    chassisNo: f.chassisNo,
    customerName: f.custName,
    customerMobile: f.mobileNo,
    modelDescription: f.modelDesc,
    openedDate: toIsoDate(f.openedDt) || null,
    rtoCode: f.rtoCode,
    rtoOffice: f.rtoOfficeDesc,
    agentEmpCode: f.agentEmpCode,
    tempRegNo: f.tempRegNo,
    tempRegExpiryDate: toIsoDate(f.tempRegExpiryDt) || null,
    policyNo: f.policyNo,
    roadTaxAmount: toAmount(f.roadTaxAmt),
    roadTaxCollectedDate: toIsoDate(f.roadTaxCollectedDt) || null,
    roadTaxPaidDate: toIsoDate(f.roadTaxPaidDt) || null,
    submittedDate: toIsoDate(f.submittedDt) || null,
    regNo: f.regNo,
    regDate: toIsoDate(f.regDt) || null,
    hsrpFittedDate: toIsoDate(f.hsrpFittedDt) || null,
    rcReceivedDate: toIsoDate(f.rcReceivedDt) || null,
    rcDeliveredDate: toIsoDate(f.rcDeliveredDt) || null,
    objectionDesc: f.objectionDesc,
    // Lifted out of the document lines so "waiting on the customer" is a column
    // test, and named so the row can say what is missing without a second call.
    hasPendingDoc: pending.length > 0 ? "Y" : "N",
    pendingDocDesc: pending.length > 0 ? pending.map((d) => d.docDesc).join("; ") : null,
  };
}

export async function syncShowroomRegistrations(
  showroomId: number,
): Promise<RegistrationSyncResult[]> {
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

  const results: RegistrationSyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncDealerRegistrations(showroomId, account.dealerCode));
  }
  return results;
}

async function syncDealerRegistrations(
  showroomId: number,
  dealerCode: string,
): Promise<RegistrationSyncResult> {
  const startedAt = Date.now();
  const summaries = await dmsRegistrations(dealerCode);

  const existing = await db
    .select({
      regnFileNo: dmsRegistrationsTable.regnFileNo,
      rawHash: dmsRegistrationsTable.rawHash,
      status: dmsRegistrationsTable.status,
    })
    .from(dmsRegistrationsTable)
    .where(eq(dmsRegistrationsTable.dealerCode, dealerCode));

  const known = new Map(existing.map((r) => [r.regnFileNo, r]));

  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const summary of summaries) {
    const summaryHash = hashOf(summary);
    const prior = known.get(summary.regnFileNo);

    if (prior && prior.rawHash === summaryHash) {
      await db
        .update(dmsRegistrationsTable)
        .set({ lastSyncedAt: new Date(), disappearedAt: null })
        .where(
          and(
            eq(dmsRegistrationsTable.dealerCode, dealerCode),
            eq(dmsRegistrationsTable.regnFileNo, summary.regnFileNo),
          ),
        );
      unchanged++;
      continue;
    }

    const file = await fetchRegnFile(summary.regnFileNo);
    if (!file) {
      logger.warn(
        { regnFileNo: summary.regnFileNo },
        "DMS listed a registration file it then could not return",
      );
      continue;
    }

    const projected = project(file);
    const now = new Date();

    if (!prior) {
      await db.insert(dmsRegistrationsTable).values({
        showroomId,
        dealerCode,
        regnFileNo: file.regnFileNo,
        ...projected,
        raw: file as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        firstSeenAt: now,
        statusSince: now,
        lastSyncedAt: now,
        lastChangedAt: null,
      });
      added++;
      continue;
    }

    // Same rule as everywhere else: a corrected mobile number must not reset how
    // long this file has been sitting at the same step.
    const statusMoved = prior.status !== projected.status;

    await db
      .update(dmsRegistrationsTable)
      .set({
        showroomId,
        ...projected,
        raw: file as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
        ...(statusMoved ? { statusSince: now } : {}),
      })
      .where(
        and(
          eq(dmsRegistrationsTable.dealerCode, dealerCode),
          eq(dmsRegistrationsTable.regnFileNo, file.regnFileNo),
        ),
      );
    changed++;
  }

  const seenIds = summaries.map((s) => s.regnFileNo);
  const gone = await db
    .update(dmsRegistrationsTable)
    .set({ disappearedAt: new Date() })
    .where(
      and(
        eq(dmsRegistrationsTable.dealerCode, dealerCode),
        isNull(dmsRegistrationsTable.disappearedAt),
        // An empty list is a fault, not a dealership with no registrations.
        ...(seenIds.length > 0 ? [notInArray(dmsRegistrationsTable.regnFileNo, seenIds)] : []),
      ),
    )
    .returning({ regnFileNo: dmsRegistrationsTable.regnFileNo });

  if (seenIds.length === 0) {
    logger.warn(
      { dealerCode },
      "DMS returned zero registration files — treating as a fault, not an empty desk",
    );
  }

  const result: RegistrationSyncResult = {
    showroomId,
    dealerCode,
    seen: summaries.length,
    added,
    changed,
    unchanged,
    disappeared: gone.length,
    durationMs: Date.now() - startedAt,
  };
  logger.info(result, "DMS registration sync complete");
  return result;
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * **Why** this registration file is not moving.
 *
 * Every one of these is a cause with a different owner: the customer, the
 * accounts desk, the insurance desk, the RTO agent, us.
 *
 * A lapsed temporary registration is deliberately **not** one of them, and the
 * first draft of this had it as two states at the top of the list. That was
 * wrong, and the fixture showed it within a minute of running: a file the RTO
 * had rejected, whose temporary registration had also lapsed, came out as
 * `TR_EXPIRED` with the advice *"get this file to the RTO today"* — which is
 * exactly what somebody had already done, and the objection that sent it back
 * had vanished off the screen.
 *
 * The lapse is not a cause. It is a consequence that raises the urgency of
 * whatever the real cause is, so it lives on the row as `tempRegDaysLeft` and
 * in the note, and the summary counts it from there. A file can be blocked on
 * insurance *and* have a vehicle riding unregistered — that is the worst row in
 * the dealership, and a state machine that can only say one of the two things
 * cannot describe it.
 */
export type RegistrationState =
  | "OBJECTION"
  | "BLOCKED_NO_INSURANCE"
  | "AWAITING_DOCS"
  | "TAX_HELD"
  | "RC_IN_DRAWER"
  | "RTO_SILENT"
  | "HSRP_PENDING"
  | "ON_TRACK"
  | "CLOSED";

/** Days a temporary registration may have left before it counts as urgent. */
const TR_WARNING_DAYS = 7;
/** Working days a lodged file may sit at the RTO before it is worth asking. */
const RTO_QUIET_DAYS = 10;
/** How recently a chase counts as still being handled. */
const CHASE_FRESH_DAYS = 7;

export interface RegistrationWorklistRow {
  regnFileNo: string;
  dealerCode: string;
  showroomId: number;
  showroomCode: string | null;
  dealId: string;
  customerName: string | null;
  customerMobile: string | null;
  modelDescription: string | null;
  chassisNo: string | null;
  agentEmpCode: string | null;
  dms: {
    status: string;
    openedDate: string | null;
    rtoCode: string | null;
    rtoOffice: string | null;
    tempRegNo: string | null;
    tempRegExpiryDate: string | null;
    policyNo: string | null;
    roadTaxAmount: number | null;
    roadTaxCollectedDate: string | null;
    roadTaxPaidDate: string | null;
    submittedDate: string | null;
    regNo: string | null;
    regDate: string | null;
    hsrpFittedDate: string | null;
    rcReceivedDate: string | null;
    rcDeliveredDate: string | null;
    objectionDesc: string | null;
    pendingDoc: string | null;
  };
  ddms: {
    customerNotifiedAt: string | null;
    rtoChasedAt: string | null;
  };
  state: RegistrationState;
  note: string | null;
  actionRequired: string | null;
  /** Days since the file was opened. What "this has taken too long" means. */
  ageDays: number;
  /** Days a temporary registration has left. Negative means already lapsed. */
  tempRegDaysLeft: number | null;
  /** Days the certificate has been at the dealership undelivered. */
  rcHeldDays: number | null;
  /** Road tax taken from the customer and not yet remitted. */
  taxHeldAmount: number | null;
  daysInStatus: number;
  lastSyncedAt: string;
  disappearedFromDms: boolean;
}

function wholeDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface ClassifyInput {
  status: string;
  policyNo: string | null;
  objectionDesc: string | null;
  hasPendingDoc: boolean;
  pendingDocDesc: string | null;
  tempRegDaysLeft: number | null;
  rcHeldDays: number | null;
  daysSinceSubmitted: number | null;
  taxHeldAmount: number | null;
  taxHeldDays: number | null;
  hsrpFitted: boolean;
  customerNotifiedAt: Date | null;
  rtoChasedAt: Date | null;
  now: Date;
}

/**
 * The temporary-registration warning, if there is one.
 *
 * Prefixed onto whatever the cause turns out to be, rather than replacing it.
 * Only meaningful while the vehicle is not yet registered — once a permanent
 * number exists the temporary one is irrelevant and saying it has lapsed would
 * be alarming and wrong.
 */
function tempRegWarning(i: ClassifyInput): string | null {
  if (i.status === "REGISTERED" || i.status === "RC_RECEIVED" || i.status === "RC_DELIVERED") return null;
  if (i.tempRegDaysLeft === null) return null;

  if (i.tempRegDaysLeft < 0) {
    return `The temporary registration lapsed ${plural(-i.tempRegDaysLeft, "day")} ago, so the vehicle is on the road unregistered.`;
  }
  if (i.tempRegDaysLeft <= TR_WARNING_DAYS) {
    return `The temporary registration expires in ${plural(i.tempRegDaysLeft, "day")}.`;
  }
  return null;
}

function classify(
  i: ClassifyInput,
): { state: RegistrationState; note: string | null; action: string | null } {
  const warning = tempRegWarning(i);
  const withWarning = (note: string | null) =>
    warning ? (note ? `${warning} ${note}` : warning) : note;

  const out = (state: RegistrationState, note: string | null, action: string | null) => ({
    state,
    note: withWarning(note),
    action,
  });

  // Terminal first, so nothing below has to keep excluding it.
  if (i.status === "RC_DELIVERED") {
    return out("CLOSED", "Certificate handed over. File closed.", null);
  }

  // The RTO sent it back. Whatever else is true, this is what has to be dealt
  // with — and it is the one a lapsed temporary registration used to hide.
  if (i.status === "REJECTED") {
    return out(
      "OBJECTION",
      i.objectionDesc ?? "The RTO returned this file with an objection.",
      "Rework the objection and resubmit",
    );
  }

  // The only blockage on this screen the dealership can clear from its own
  // desk, which is why it sits above the ones that need somebody else.
  if (!i.policyNo && i.status !== "REGISTERED" && i.status !== "RC_RECEIVED") {
    const alsoDocs = i.hasPendingDoc ? ` The customer also owes ${i.pendingDocDesc}.` : "";
    return out(
      "BLOCKED_NO_INSURANCE",
      `The RTO will not accept this file without a policy, and there is no policy.${alsoDocs}`,
      "Issue the insurance — nothing else on this file can move first",
    );
  }

  if (i.hasPendingDoc) {
    return out(
      "AWAITING_DOCS",
      `Waiting on the customer: ${i.pendingDocDesc ?? "a document"}.`,
      "Chase the customer for the outstanding document",
    );
  }

  if (i.taxHeldAmount !== null && i.taxHeldAmount > 0) {
    const held = i.taxHeldDays === null ? "" : ` It has been ${plural(i.taxHeldDays, "day")}.`;
    return out(
      "TAX_HELD",
      `₹${i.taxHeldAmount.toLocaleString("en-IN")} of road tax was collected from the customer and has not been paid to the RTO.${held}`,
      "Remit the road tax — the file cannot be lodged until it clears",
    );
  }

  // The quiet failure, and the reason this module exists. Same shape as a
  // finished job card nobody rang about.
  if (i.rcHeldDays !== null) {
    return i.customerNotifiedAt
      ? out(
          "RC_IN_DRAWER",
          `Certificate here ${plural(i.rcHeldDays, "day")}. The customer has been told and has not come in.`,
          null,
        )
      : out(
          "RC_IN_DRAWER",
          `Certificate has been in the office ${plural(i.rcHeldDays, "day")} and the customer does not know.`,
          "Call the customer — their registration certificate is here",
        );
  }

  if (i.status === "SUBMITTED" && i.daysSinceSubmitted !== null && i.daysSinceSubmitted > RTO_QUIET_DAYS) {
    // Recency, not presence. A file lodged three weeks ago and chased yesterday
    // is being handled; the same file chased once, a fortnight back, is not.
    const chasedDaysAgo =
      i.rtoChasedAt === null ? null : wholeDaysBetween(i.rtoChasedAt, i.now);

    if (chasedDaysAgo !== null && chasedDaysAgo <= CHASE_FRESH_DAYS) {
      return out(
        "ON_TRACK",
        `At the RTO ${plural(i.daysSinceSubmitted, "day")}, chased ${plural(chasedDaysAgo, "day")} ago.`,
        null,
      );
    }

    return out(
      "RTO_SILENT",
      `Lodged ${plural(i.daysSinceSubmitted, "day")} ago with nothing back. ` +
        (chasedDaysAgo === null ? "Never chased." : `Last chased ${plural(chasedDaysAgo, "day")} ago.`),
      // The action changes when the clock is against it, because "ask where it
      // has got to" is too mild for a vehicle already riding unregistered.
      warning && i.tempRegDaysLeft !== null && i.tempRegDaysLeft < 0
        ? "Escalate at the RTO — the file is lodged and the vehicle is unregistered"
        : "Ask the agent where this file has got to",
    );
  }

  // Registered, reported as done, and on the road without a legal plate.
  if ((i.status === "REGISTERED" || i.status === "RC_RECEIVED") && !i.hsrpFitted) {
    return out(
      "HSRP_PENDING",
      "Number allotted, high-security plate not fitted.",
      "Book the plate fitment and tell the customer",
    );
  }

  return out("ON_TRACK", null, null);
}

export interface RegistrationWorklistOptions {
  showroomId: number;
  status?: string;
  includeDisappeared?: boolean;
}

export async function buildRegistrationWorklist(
  opts: RegistrationWorklistOptions,
): Promise<RegistrationWorklistRow[]> {
  const rows = await db
    .select({ f: dmsRegistrationsTable, showroomCode: showroomsTable.code })
    .from(dmsRegistrationsTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, dmsRegistrationsTable.showroomId))
    .where(
      and(
        eq(dmsRegistrationsTable.showroomId, opts.showroomId),
        opts.status ? eq(dmsRegistrationsTable.status, opts.status) : undefined,
        opts.includeDisappeared ? undefined : isNull(dmsRegistrationsTable.disappearedAt),
      ),
    )
    // Oldest file first. On this screen age *is* the severity — nothing here is
    // urgent because it is new.
    .orderBy(asc(dmsRegistrationsTable.openedDate));

  const now = new Date();

  return rows.map(({ f, showroomCode }) => {
    const tempRegDaysLeft =
      f.tempRegExpiryDate === null ? null : wholeDaysBetween(now, new Date(f.tempRegExpiryDate));

    const rcHeldDays =
      f.rcReceivedDate !== null && f.rcDeliveredDate === null
        ? wholeDaysBetween(new Date(f.rcReceivedDate), now)
        : null;

    const daysSinceSubmitted =
      f.submittedDate === null ? null : wholeDaysBetween(new Date(f.submittedDate), now);

    // Collected from the customer and not yet remitted. Both dates have to be
    // read together to see it, which is why nobody does.
    const taxHeld =
      f.roadTaxCollectedDate !== null && f.roadTaxPaidDate === null ? f.roadTaxAmount : null;
    const taxHeldDays =
      taxHeld !== null && f.roadTaxCollectedDate !== null
        ? wholeDaysBetween(new Date(f.roadTaxCollectedDate), now)
        : null;

    const { state, note, action } = classify({
      status: f.status,
      policyNo: f.policyNo,
      objectionDesc: f.objectionDesc,
      hasPendingDoc: f.hasPendingDoc === "Y",
      pendingDocDesc: f.pendingDocDesc,
      tempRegDaysLeft,
      rcHeldDays,
      daysSinceSubmitted,
      taxHeldAmount: taxHeld,
      taxHeldDays,
      hsrpFitted: f.hsrpFittedDate !== null,
      customerNotifiedAt: f.customerNotifiedAt,
      rtoChasedAt: f.rtoChasedAt,
      now,
    });

    return {
      regnFileNo: f.regnFileNo,
      dealerCode: f.dealerCode,
      showroomId: f.showroomId,
      showroomCode,
      dealId: f.dealId,
      customerName: f.customerName,
      customerMobile: f.customerMobile,
      modelDescription: f.modelDescription,
      chassisNo: f.chassisNo,
      agentEmpCode: f.agentEmpCode,
      dms: {
        status: f.status,
        openedDate: f.openedDate,
        rtoCode: f.rtoCode,
        rtoOffice: f.rtoOffice,
        tempRegNo: f.tempRegNo,
        tempRegExpiryDate: f.tempRegExpiryDate,
        policyNo: f.policyNo,
        roadTaxAmount: f.roadTaxAmount,
        roadTaxCollectedDate: f.roadTaxCollectedDate,
        roadTaxPaidDate: f.roadTaxPaidDate,
        submittedDate: f.submittedDate,
        regNo: f.regNo,
        regDate: f.regDate,
        hsrpFittedDate: f.hsrpFittedDate,
        rcReceivedDate: f.rcReceivedDate,
        rcDeliveredDate: f.rcDeliveredDate,
        objectionDesc: f.objectionDesc,
        pendingDoc: f.pendingDocDesc,
      },
      ddms: {
        customerNotifiedAt: f.customerNotifiedAt?.toISOString() ?? null,
        rtoChasedAt: f.rtoChasedAt?.toISOString() ?? null,
      },
      state,
      note,
      actionRequired: action,
      ageDays: f.openedDate === null ? 0 : wholeDaysBetween(new Date(f.openedDate), now),
      tempRegDaysLeft,
      rcHeldDays,
      taxHeldAmount: taxHeld,
      daysInStatus: wholeDaysBetween(f.statusSince, now),
      lastSyncedAt: f.lastSyncedAt.toISOString(),
      disappearedFromDms: f.disappearedAt !== null,
    };
  });
}

export interface RegistrationWorklistSummary {
  total: number;
  byState: Record<RegistrationState, number>;
  needsAction: number;
  /**
   * The leading number, and the one nobody could previously see: registration
   * certificates the dealership is holding that their owners do not have.
   */
  rcInDrawer: number;
  /** Files that cannot move until a policy exists. Straight into InsurRouter. */
  blockedOnInsurance: number;
  /** Vehicles on the road with no valid registration at all, temporary or permanent. */
  tempRegLapsed: number;
  /** Temporary registrations expiring within the week. */
  tempRegAtRisk: number;
  /** Customers' road tax sitting in the dealer's account, in rupees. */
  taxHeldAmount: number;
  /** Age of the oldest open file, in days. */
  oldestOpenDays: number;
  lastSyncedAt: string | null;
}

export function summariseRegistrations(
  rows: RegistrationWorklistRow[],
): RegistrationWorklistSummary {
  const byState = {
    OBJECTION: 0,
    BLOCKED_NO_INSURANCE: 0,
    AWAITING_DOCS: 0,
    TAX_HELD: 0,
    RC_IN_DRAWER: 0,
    RTO_SILENT: 0,
    HSRP_PENDING: 0,
    ON_TRACK: 0,
    CLOSED: 0,
  } as Record<RegistrationState, number>;

  let needsAction = 0;
  let taxHeldAmount = 0;
  let tempRegLapsed = 0;
  let tempRegAtRisk = 0;
  let oldestOpenDays = 0;
  let lastSynced: string | null = null;

  for (const r of rows) {
    byState[r.state]++;
    if (r.actionRequired) needsAction++;

    // Both of these are counted across every row rather than off the state,
    // because they are consequences rather than causes and can coexist with any
    // of them. A file blocked on insurance may also be holding the customer's
    // road tax and have a vehicle riding on a lapsed temporary registration —
    // one state cannot say that, and all three are true.
    if (r.taxHeldAmount) taxHeldAmount += r.taxHeldAmount;
    if (r.state !== "CLOSED" && r.tempRegDaysLeft !== null && r.dms.regNo === null) {
      if (r.tempRegDaysLeft < 0) tempRegLapsed++;
      else if (r.tempRegDaysLeft <= 7) tempRegAtRisk++;
    }

    if (r.state !== "CLOSED" && r.ageDays > oldestOpenDays) oldestOpenDays = r.ageDays;
    if (!lastSynced || r.lastSyncedAt > lastSynced) lastSynced = r.lastSyncedAt;
  }

  return {
    total: rows.length,
    byState,
    needsAction,
    rcInDrawer: byState.RC_IN_DRAWER,
    blockedOnInsurance: byState.BLOCKED_NO_INSURANCE,
    tempRegLapsed,
    tempRegAtRisk,
    taxHeldAmount,
    oldestOpenDays,
    lastSyncedAt: lastSynced,
  };
}
