/**
 * One queue, worked one at a time.
 *
 * Seven screens each holding a list is a reporting product: it tells a
 * short-staffed dealership what is wrong and leaves the deciding *which of
 * these to do next* to the person who has no time to decide it. That decision
 * is the work. This is the screen that makes it, and the capacity argument the
 * whole product is sold on stands or falls here.
 *
 * ## Three bands, in this order
 *
 *   1. **Mine**       — carrying my employee code
 *   2. **Nobody's**   — carrying none, or one belonging to somebody who left
 *   3. **My outlet's** — carrying somebody else's
 *
 * The middle band is the point. Orphaned work is what a dealership actually
 * loses: an enquiry assigned to a salesman who resigned in February is not on
 * anybody's list, is not late by any measure the DMS holds, and simply stops
 * happening. R-19 has been asking for it since the register was written and
 * OBJ-10 could only refuse to *add* to it. This is where it surfaces.
 *
 * The third band is deliberately last and deliberately present. Somebody
 * covering for a colleague who is out needs to reach their work; somebody who
 * is not covering scrolls past it. Hiding it would be tidier and would mean the
 * dealership's answer to "who is looking at this while Sunil is on leave" is
 * still nobody.
 *
 * ## What is in it
 *
 * Every record across all seven modules whose own screen would show an
 * `actionRequired`. Not every mirrored row, and not a second opinion about
 * which rows matter — the classifiers already decided that, and this reads
 * their answer through the same `build…Worklist` functions the screens and the
 * event detector use. Three readings of one projection is the property worth
 * protecting: a queue that disagreed with the screen it sends you to would be
 * worse than no queue.
 *
 * ## Order
 *
 * Band, then severity, then how long it has been waiting, then a stable
 * tiebreak. Severity is a table in this file — one line per state, all seven
 * modules visible at once — rather than a number each classifier invents for
 * itself. It has to be comparable *across* modules to sort them into one list,
 * and a per-module score would make "is a stuck RC worse than a broken payment
 * promise" a question nobody ever answers in one place.
 *
 * No model anywhere. Everything here is a rule, because "what should this
 * person do next" is exactly the kind of decision R-49 says a model may not
 * make.
 */

import { inArray } from "drizzle-orm";
import { db, dmsEmployeesTable } from "@workspace/db";
import { canRead, type AccessModule } from "./access";
import { loadPolicy, type ResolvedPolicy } from "./policy";
import { buildWorklist } from "./worklist";
import { buildServiceWorklist } from "./service-worklist";
import { buildLeadWorklist } from "./lead-worklist";
import { buildRegistrationWorklist } from "./registration-worklist";
import { buildSparesWorklist } from "./spares-worklist";
import { buildReceivablesWorklist } from "./receivables-worklist";
import { buildInventoryWorklist } from "./inventory-worklist";
import type { ActionId } from "./actions";

export type QueueModule =
  | "DEAL"
  | "JOB_CARD"
  | "ENQUIRY"
  | "REGISTRATION"
  | "PART"
  | "RECEIVABLE"
  | "VEHICLE";

export type QueueBand = "MINE" | "UNASSIGNED" | "OUTLET";

/** A control the row may offer, decided here rather than by the screen. */
export interface QueueAction {
  action: ActionId;
  label: string;
  doneLabel: string;
  done: boolean;
  tone: "amber" | "red" | "slate";
  /** Extra fields the action needs — `fromShowroomId`, `enqId`, `toShowroomId`. */
  extra?: Record<string, unknown>;
}

export interface QueueItem {
  module: QueueModule;
  recordKey: string;
  showroomId: number;
  showroomCode: string | null;
  band: QueueBand;
  /** 3 now, 2 this week, 1 background. See `SEVERITY`. */
  severity: number;
  /** How long this has been waiting, in the module's own terms. */
  waitingDays: number;
  /** What the row is about — a customer, a party, a part. */
  title: string;
  /** The second line: a model, an invoice, a description. */
  subtitle: string | null;
  state: string;
  /** Why it is here, in the classifier's words. */
  note: string | null;
  /** What to do about it, in the classifier's words. */
  actionRequired: string;
  assignedEmpCode: string | null;
  assignedEmpName: string | null;
  /** True when the person it is assigned to has left. That is band 2, not 3. */
  assigneeGone: boolean;
  /** For the call and WhatsApp controls, where there is somebody to call. */
  contactName: string | null;
  contactMobile: string | null;
  actions: QueueAction[];
  /**
   * The reassignment this row supports, when it has one.
   *
   * Separate from `actions` because it is not a button — it is a picker over
   * staff who still work here, each carrying a count of what they already hold.
   * R-54 asks that work never becomes unroutable, and the honest reading is
   * that the queue that *shows* orphaned work has to be the place it can be
   * handed to somebody, or "reassign to someone still here" is advice with a
   * trip to another screen attached.
   */
  assignAction: "ENQUIRY_REASSIGN" | "REGISTRATION_ASSIGN_AGENT" | null;
  /** Which role the picker should offer. Null means everybody at the outlet. */
  assignRole: string | null;
  /** The screen this row lives on, for anyone who wants the full picture. */
  href: string;
}

export interface QueueResult {
  items: QueueItem[];
  /** The leading number: everything waiting on a person, across every module. */
  total: number;
  mine: number;
  unassigned: number;
  outlet: number;
  /** Per module, for the strip along the top. Only modules this role may read. */
  byModule: Array<{ module: QueueModule; count: number }>;
}

/**
 * How urgent each state is — asked of the dealership, not decided here.
 *
 * This was a table in this file until OBJ-18, and it was one afternoon's
 * judgement about whether a stuck registration outranks a broken payment
 * promise, applied to every dealership that will ever use the product. That is
 * not a product question: it depends on whether this group's RTO agent is
 * snowed under or its cash position is tight, and we know neither.
 *
 * The numbers now come from `lib/dms/policy.ts` — the product's defaults are
 * still the ones this shipped with, and an owner or a showroom manager may move
 * any of them. What has not moved is the shape: three bands, a closed set of
 * states, and **a state the registry does not name produces no queue item at
 * all**, however loudly its row asks for one. That is still the single place
 * the queue's contents are decided.
 *
 * Severity has to be comparable *across* modules to sort them into one list,
 * which is why it is one table rather than a number each classifier invents.
 */

const BAND_ORDER: Record<QueueBand, number> = { MINE: 0, UNASSIGNED: 1, OUTLET: 2 };

export interface QueueInput {
  ownerId: number;
  /** Every outlet the owner holds — the cross-outlet builders need it. */
  ownerShowroomIds: number[];
  /** The outlets this session may look at. One for staff, all for an owner. */
  visibleShowroomIds: number[];
  /** The signed-in person's employee code. Null for an owner. */
  empCode: string | null;
  role: string;
  /**
   * The dealership's numbers. Loaded here when the caller has not already —
   * the seven builders and the severity table all read the same set, so a
   * caller doing a full pass should load it once and pass it down.
   */
  policy?: ResolvedPolicy;
}

/**
 * Which band a row falls into.
 *
 * A departed assignee is **nobody's**, not somebody else's. That is the whole
 * point of the middle band: the work does not become less orphaned because the
 * DMS still carries the name of the person who used to do it.
 */
function bandFor(
  assigned: string | null,
  gone: boolean,
  empCode: string | null,
): QueueBand {
  if (!assigned || gone) return "UNASSIGNED";
  if (empCode && assigned === empCode) return "MINE";
  return "OUTLET";
}

/**
 * Employee code to name, and whether they still work here.
 *
 * The bands are computed from codes because that is what the mirror rows carry,
 * but nobody in a dealership refers to a colleague as RT-0417-02. One query for
 * the whole queue rather than a lookup per row.
 *
 * The `isActive` half matters more than the name: only enquiries carry a
 * departure flag on the row, so for every other module this is the only thing
 * that can tell an orphaned file from an assigned one.
 */
async function staffIndex(
  showroomIds: number[],
): Promise<Map<string, { name: string; active: boolean }>> {
  if (showroomIds.length === 0) return new Map();
  const rows = await db
    .select({
      empCode: dmsEmployeesTable.empCode,
      empName: dmsEmployeesTable.empName,
      isActive: dmsEmployeesTable.isActive,
    })
    .from(dmsEmployeesTable)
    .where(inArray(dmsEmployeesTable.showroomId, showroomIds));

  const index = new Map<string, { name: string; active: boolean }>();
  for (const r of rows) index.set(r.empCode, { name: r.empName, active: r.isActive === "Y" });
  return index;
}

export async function buildQueue(input: QueueInput): Promise<QueueResult> {
  const { ownerShowroomIds, visibleShowroomIds, empCode, role } = input;
  const may = (m: AccessModule): boolean => canRead(role, m);
  const policy = input.policy ?? (await loadPolicy(input.ownerId));
  const staff = await staffIndex(visibleShowroomIds);

  /** Who is carrying this, and whether they are still here to carry it. */
  const carrier = (code: string | null): { name: string | null; gone: boolean } => {
    if (!code) return { name: null, gone: false };
    const person = staff.get(code);
    // An unknown code is not a departure — same rule as the login check. The
    // staff master may simply not have synced, and treating silence as a
    // resignation would move somebody's work out from under them.
    return { name: person?.name ?? null, gone: person ? !person.active : false };
  };

  const items: QueueItem[] = [];

  for (const showroomId of visibleShowroomIds) {
    const [deals, jobCards, leads, registrations, parts, receivables, vehicles] =
      await Promise.all([
        may("DEAL") ? buildWorklist({ showroomId }) : [],
        may("JOB_CARD") ? buildServiceWorklist({ showroomId }) : [],
        may("ENQUIRY") ? buildLeadWorklist({ showroomId }) : [],
        may("REGISTRATION") ? buildRegistrationWorklist({ showroomId, policy }) : [],
        may("PART") ? buildSparesWorklist({ showroomId, ownerShowroomIds, policy }) : [],
        may("RECEIVABLE") ? buildReceivablesWorklist({ showroomId, ownerShowroomIds, policy }) : [],
        may("VEHICLE") ? buildInventoryWorklist({ showroomId, ownerShowroomIds, policy }) : [],
      ]);

    // ── Deals ───────────────────────────────────────────────────────────────
    // No assignee anywhere in the DMS's deal record, so every one of these is
    // nobody's. That is not a gap being papered over: an unissued policy is the
    // insurance desk's job by role rather than by name, and the role gate above
    // is what decides whose queue it lands in.
    for (const r of deals) {
      if (!r.actionRequired) continue;
      const severity = policy.severity("DEAL", r.reconcile);
      if (!severity) continue;
      items.push({
        module: "DEAL",
        recordKey: r.dealId,
        showroomId: r.showroomId,
        showroomCode: r.showroomCode,
        band: "UNASSIGNED",
        severity,
        waitingDays: r.daysInStatus,
        title: r.customerName ?? r.dealId,
        subtitle: r.modelDescription,
        state: r.reconcile,
        note: r.reconcileNote,
        actionRequired: r.actionRequired,
        assignedEmpCode: null,
        assignedEmpName: null,
        assigneeGone: false,
        contactName: r.customerName,
        contactMobile: null,
        // Nothing to press. Every fix for a reconciliation gap is either a
        // person keying a policy into the OEM's own system or an application
        // started in InsurRouter, and R-40 is why the first has no button.
        actions: [],
        assignAction: null,
        assignRole: null,
        href: "/worklist",
      });
    }

    // ── Workshop ────────────────────────────────────────────────────────────
    for (const r of jobCards) {
      if (!r.actionRequired) continue;
      const severity = policy.severity("JOB_CARD", r.state);
      if (!severity) continue;
      const who = carrier(r.advisorEmpCode);
      items.push({
        module: "JOB_CARD",
        recordKey: r.jcNo,
        showroomId: r.showroomId,
        showroomCode: r.showroomCode,
        band: bandFor(r.advisorEmpCode, who.gone, empCode),
        severity,
        waitingDays: Math.max(r.daysLate, r.daysInStatus),
        title: r.customerName ?? r.jcNo,
        subtitle: [r.modelDescription, r.regNo].filter(Boolean).join(" · ") || null,
        state: r.state,
        note: r.note,
        actionRequired: r.actionRequired,
        assignedEmpCode: r.advisorEmpCode,
        assignedEmpName: who.name,
        assigneeGone: who.gone,
        contactName: r.customerName,
        contactMobile: r.customerMobile,
        actions: [
          {
            action: "JOB_CARD_MARK_INFORMED",
            label: "Mark customer told",
            doneLabel: "Customer told",
            done: Boolean(r.ddms.customerInformedAt),
            tone: "amber",
          },
        ],
        assignAction: null,
        assignRole: null,
        href: "/service",
      });
    }

    // ── Enquiries ───────────────────────────────────────────────────────────
    for (const r of leads) {
      if (!r.actionRequired) continue;
      const severity = policy.severity("ENQUIRY", r.state);
      if (!severity) continue;
      // Ours overrides theirs: a reassignment made in DDMS is the current
      // answer to who is carrying this, and the DMS field is read-only.
      const assigned = r.ddms.reassignedToEmpCode ?? r.dms.assignedEmpCode;
      const gone = !r.ddms.reassignedToEmpCode && !r.dms.assignedEmpActive;
      items.push({
        module: "ENQUIRY",
        recordKey: r.enqId,
        showroomId: r.showroomId,
        showroomCode: null,
        band: bandFor(assigned, gone, empCode),
        severity,
        // A lead's clock runs in minutes, not days — the manufacturer's window
        // is measured in hours and a breach on the same morning is still a
        // breach. Days is what the queue sorts on, so a fresh breach lands at
        // zero and its severity is what carries it to the top.
        waitingDays: Math.max(
          r.followUpDaysOverdue,
          Math.floor((r.responseMinutes ?? 0) / (60 * 24)),
        ),
        title: r.customerName ?? r.enqId,
        subtitle: r.modelInterest,
        state: r.state,
        note: r.slaNote ?? r.note,
        actionRequired: r.actionRequired,
        assignedEmpCode: assigned,
        assignedEmpName: carrier(assigned).name ?? r.dms.assignedEmpName,
        assigneeGone: gone,
        contactName: r.customerName,
        contactMobile: r.customerMobile,
        actions: [
          {
            action: "ENQUIRY_LOG_CONTACT",
            label: "Log the call",
            doneLabel: "Call logged",
            done: Boolean(r.ddms.contactedAt),
            tone: "amber",
            extra: { channel: "CALL" },
          },
        ],
        assignAction: "ENQUIRY_REASSIGN",
        assignRole: "SALES_EXEC",
        href: "/enquiries",
      });
    }

    // ── Registration files ──────────────────────────────────────────────────
    for (const r of registrations) {
      if (!r.actionRequired) continue;
      const severity = policy.severity("REGISTRATION", r.state);
      if (!severity) continue;
      const assigned = r.ddms.assignedAgentEmpCode ?? r.agentEmpCode;
      const who = carrier(assigned);
      items.push({
        module: "REGISTRATION",
        recordKey: r.regnFileNo,
        showroomId: r.showroomId,
        showroomCode: r.showroomCode,
        band: bandFor(assigned, who.gone, empCode),
        severity,
        waitingDays: r.rcHeldDays ?? r.ageDays,
        title: r.customerName ?? r.regnFileNo,
        subtitle: [r.modelDescription, r.dms.regNo ?? r.dms.tempRegNo].filter(Boolean).join(" · ") || null,
        state: r.state,
        note: r.note,
        actionRequired: r.actionRequired,
        assignedEmpCode: assigned,
        assignedEmpName: who.name,
        assigneeGone: who.gone,
        contactName: r.customerName,
        contactMobile: r.customerMobile,
        actions: [
          {
            action: "REGISTRATION_MARK_NOTIFIED",
            label: "Mark customer told",
            doneLabel: "Customer told",
            done: Boolean(r.ddms.customerNotifiedAt),
            tone: "amber",
          },
          {
            action: "REGISTRATION_LOG_CHASE",
            label: "Log an RTO chase",
            doneLabel: "RTO chased",
            done: Boolean(r.ddms.rtoChasedAt),
            tone: "slate",
          },
        ],
        assignAction: "REGISTRATION_ASSIGN_AGENT",
        assignRole: "RTO_AGENT",
        href: "/registrations",
      });
    }

    // ── The parts counter ───────────────────────────────────────────────────
    for (const r of parts) {
      if (!r.actionRequired) continue;
      const severity = policy.severity("PART", r.state);
      if (!severity) continue;
      const source = r.availableAt[0];
      const waiting = r.waitingJobCards[0];
      items.push({
        module: "PART",
        recordKey: r.partNo,
        showroomId: r.showroomId,
        showroomCode: r.showroomCode,
        band: "UNASSIGNED",
        severity,
        waitingDays: waiting?.daysWaiting ?? 0,
        title: r.partDesc ?? r.partNo,
        subtitle: r.partNo,
        state: r.state,
        note: r.note,
        actionRequired: r.actionRequired,
        assignedEmpCode: null,
        assignedEmpName: null,
        assigneeGone: false,
        contactName: null,
        contactMobile: null,
        actions: [
          ...(source
            ? [
                {
                  action: "PART_REQUEST_TRANSFER" as const,
                  label: `Request from ${source.showroomCode ?? "the other branch"}`,
                  doneLabel: "Transfer requested",
                  done: Boolean(r.ddms.transferRequestedAt),
                  tone: "amber" as const,
                  extra: { fromShowroomId: source.showroomId },
                },
              ]
            : []),
          {
            action: "PART_RAISE_REORDER",
            label: "Mark reorder raised",
            doneLabel: "Reorder raised",
            done: Boolean(r.ddms.reorderRaisedAt),
            tone: "slate",
          },
        ],
        assignAction: null,
        assignRole: null,
        href: "/spares",
      });
    }

    // ── The ledger ──────────────────────────────────────────────────────────
    for (const r of receivables) {
      if (!r.actionRequired) continue;
      const severity = policy.severity("RECEIVABLE", r.state);
      if (!severity) continue;
      items.push({
        module: "RECEIVABLE",
        recordKey: r.receivableId,
        showroomId: r.showroomId,
        showroomCode: r.showroomCode,
        band: "UNASSIGNED",
        severity,
        waitingDays: Math.max(r.daysOverdue, 0),
        title: r.partyName,
        subtitle: `${r.dms.invoiceNo} · ₹${Math.round(r.balance).toLocaleString("en-IN")}`,
        state: r.state,
        note: r.note,
        actionRequired: r.actionRequired,
        assignedEmpCode: null,
        assignedEmpName: null,
        assigneeGone: false,
        contactName: r.partyName,
        contactMobile: null,
        actions: [
          {
            action: "RECEIVABLE_LOG_CHASE",
            label: "Log a chase",
            doneLabel: "Chased",
            done: Boolean(r.ddms.chasedAt),
            tone: "amber",
          },
          {
            action: "RECEIVABLE_MARK_DISPUTED",
            label: "Mark disputed",
            doneLabel: "Disputed",
            done: Boolean(r.ddms.disputedAt),
            tone: "red",
          },
        ],
        assignAction: null,
        assignRole: null,
        href: "/receivables",
      });
    }

    // ── The floor ───────────────────────────────────────────────────────────
    for (const r of vehicles) {
      if (!r.actionRequired) continue;
      const severity = policy.severity("VEHICLE", r.state);
      if (!severity) continue;
      items.push({
        module: "VEHICLE",
        recordKey: r.chassisNo,
        showroomId: r.showroomId,
        showroomCode: r.showroomCode,
        band: "UNASSIGNED",
        severity,
        waitingDays: r.ageDays,
        title: r.modelDescription ?? r.modelCode,
        subtitle: [r.variantDescription, r.colourDescription, r.chassisNo].filter(Boolean).join(" · "),
        state: r.state,
        note: r.note,
        actionRequired: r.actionRequired,
        assignedEmpCode: null,
        assignedEmpName: null,
        assigneeGone: false,
        contactName: null,
        contactMobile: null,
        actions: [
          {
            action: "VEHICLE_MARK_OFFERED",
            label: "Mark offered",
            doneLabel: "Offered",
            done: Boolean(r.ddms.offeredAt),
            tone: "amber",
          },
        ],
        assignAction: null,
        assignRole: null,
        href: "/inventory",
      });
    }
  }

  /*
   * Band, then severity, then how long it has waited, then a stable tiebreak.
   *
   * The last one is not decoration. Without it two items of equal urgency swap
   * places between refreshes, and a queue whose order changes under somebody
   * working through it is a queue they will stop trusting after the second time
   * they lose their place.
   */
  items.sort(
    (a, b) =>
      BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
      b.severity - a.severity ||
      b.waitingDays - a.waitingDays ||
      a.module.localeCompare(b.module) ||
      a.showroomId - b.showroomId ||
      a.recordKey.localeCompare(b.recordKey),
  );

  const counts = new Map<QueueModule, number>();
  for (const i of items) counts.set(i.module, (counts.get(i.module) ?? 0) + 1);

  return {
    items,
    total: items.length,
    mine: items.filter((i) => i.band === "MINE").length,
    unassigned: items.filter((i) => i.band === "UNASSIGNED").length,
    outlet: items.filter((i) => i.band === "OUTLET").length,
    byModule: [...counts.entries()]
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count),
  };
}
