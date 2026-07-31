/**
 * The owner's worklist, and the DMS-versus-DDMS reconciliation.
 *
 * The integration is read-only, so the two systems *will* diverge the moment we
 * do anything — issue a policy at 10am and Hero's system still says
 * AWAITING_INSURANCE at 10.01. The design decision is not to hide that. Both
 * statuses are shown side by side and the difference is classified, because the
 * difference is exactly the thing nobody currently has time to check.
 *
 * Reconciliation is computed here at read time and never stored. A stored
 * "in sync" flag becomes a second thing to keep in sync, and a stale one is
 * worse than none.
 */

import { and, eq, isNull, desc } from "drizzle-orm";
import {
  db,
  dmsDealsTable,
  applicationsTable,
  policiesTable,
  showroomsTable,
} from "@workspace/db";

/**
 * How our record compares to the DMS for one deal.
 *
 * `AHEAD` is the interesting one and the reason the read-only constraint is
 * survivable: it means we did the work and the dealer's system does not know
 * yet. That is not an error, it is a **task** — key this number back — and
 * tracking it is the difference between a forgotten policy and a closed loop.
 */
export type ReconcileState =
  | "IN_SYNC"
  | "AHEAD"
  | "BEHIND"
  | "CONFLICT"
  | "NOT_STARTED";

export interface WorklistRow {
  dealId: string;
  dealerCode: string;
  showroomId: number;
  showroomCode: string | null;

  customerName: string | null;
  modelDescription: string | null;
  chassisNo: string | null;
  bookingDate: string | null;

  /** What the dealer's own system currently believes. */
  dms: {
    status: string;
    policyNo: string | null;
    insurerCode: string | null;
    regNo: string | null;
  };

  /** What we know, which may be more recent. */
  ddms: {
    applicationId: number | null;
    applicationStatus: string | null;
    policyNumber: string | null;
    /** True when the policy number was invented by a stub, not an insurer. */
    policySimulated: boolean;
    providerName: string | null;
  };

  reconcile: ReconcileState;
  /** Plain-English statement of the difference, for the console to render. */
  reconcileNote: string | null;
  /** The one thing to do next, when there is one. */
  actionRequired: string | null;

  /** Days since the DMS status last moved. The "nobody is watching this" number. */
  daysInStatus: number;
  lastSyncedAt: string;
  disappearedFromDms: boolean;
}

function daysSince(d: Date | null): number {
  if (!d) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/**
 * Classify one deal.
 *
 * Deliberately compares *policy numbers*, not statuses. Statuses use different
 * vocabularies on each side and always will; a policy number is the same string
 * in both systems or it is a genuine problem.
 */
function reconcile(
  dmsPolicyNo: string | null,
  ourPolicyNumber: string | null,
  ourApplicationStatus: string | null,
): { state: ReconcileState; note: string | null; action: string | null } {
  const theirs = dmsPolicyNo?.trim() || null;
  const ours = ourPolicyNumber?.trim() || null;

  if (!theirs && !ours) {
    if (!ourApplicationStatus) {
      return {
        state: "NOT_STARTED",
        note: "No insurance yet in either system.",
        action: "Start the insurance application",
      };
    }
    return {
      state: "IN_SYNC",
      note: `In progress in DDMS (${ourApplicationStatus}); nothing issued yet.`,
      action: null,
    };
  }

  if (ours && !theirs) {
    return {
      state: "AHEAD",
      note: `Issued in DDMS as ${ours}. The dealer's system still shows no policy.`,
      // The one thing read-only access cannot do for them. Making it an explicit
      // task is the difference between a closed loop and a forgotten policy.
      action: `Enter policy ${ours} against this deal in the DMS`,
    };
  }

  if (theirs && !ours) {
    return {
      state: "BEHIND",
      note: `The DMS holds policy ${theirs}, which DDMS did not issue.`,
      // Someone worked outside the system, or it predates us. Either way the
      // owner should know it happened.
      action: "Record this policy in DDMS, or confirm it was issued elsewhere",
    };
  }

  if (theirs === ours) {
    return { state: "IN_SYNC", note: `Both systems hold ${ours}.`, action: null };
  }

  return {
    state: "CONFLICT",
    note: `DDMS has ${ours}, the DMS has ${theirs}. Two different policies on one vehicle.`,
    action: "Resolve which policy is correct before delivery",
  };
}

export interface WorklistOptions {
  showroomId: number;
  /** Filter on the DMS status, e.g. AWAITING_INSURANCE. */
  status?: string;
  /** Include deals the DMS has stopped listing. Off by default. */
  includeDisappeared?: boolean;
}

export async function buildWorklist(opts: WorklistOptions): Promise<WorklistRow[]> {
  const rows = await db
    .select({
      deal: dmsDealsTable,
      showroomCode: showroomsTable.code,
      applicationId: applicationsTable.id,
      applicationStatus: applicationsTable.status,
      policyNumber: policiesTable.policyNumber,
      providerName: policiesTable.providerName,
    })
    .from(dmsDealsTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, dmsDealsTable.showroomId))
    // Our own record of the same deal, matched on the DMS identifiers rather
    // than anything we invented — those are the only keys both systems share.
    .leftJoin(
      applicationsTable,
      and(
        eq(applicationsTable.dmsDealId, dmsDealsTable.dealId),
        eq(applicationsTable.dmsDealerCode, dmsDealsTable.dealerCode),
      ),
    )
    .leftJoin(policiesTable, eq(policiesTable.applicationId, applicationsTable.id))
    .where(
      and(
        eq(dmsDealsTable.showroomId, opts.showroomId),
        opts.status ? eq(dmsDealsTable.status, opts.status) : undefined,
        opts.includeDisappeared ? undefined : isNull(dmsDealsTable.disappearedAt),
      ),
    )
    .orderBy(desc(dmsDealsTable.statusSince));

  return rows.map(({ deal, showroomCode, ...ours }) => {
    const { state, note, action } = reconcile(
      deal.dmsPolicyNo,
      ours.policyNumber,
      ours.applicationStatus,
    );

    return {
      dealId: deal.dealId,
      dealerCode: deal.dealerCode,
      showroomId: deal.showroomId,
      showroomCode,
      customerName: deal.customerName,
      modelDescription: deal.modelDescription,
      chassisNo: deal.chassisNo,
      bookingDate: deal.bookingDate,
      dms: {
        status: deal.status,
        policyNo: deal.dmsPolicyNo,
        insurerCode: deal.dmsInsurerCode,
        regNo: deal.dmsRegNo,
      },
      ddms: {
        applicationId: ours.applicationId,
        applicationStatus: ours.applicationStatus,
        policyNumber: ours.policyNumber,
        policySimulated: Boolean(ours.policyNumber?.startsWith("SIM-")),
        providerName: ours.providerName,
      },
      reconcile: state,
      reconcileNote: note,
      actionRequired: action,
      daysInStatus: daysSince(deal.statusSince),
      lastSyncedAt: deal.lastSyncedAt.toISOString(),
      disappearedFromDms: deal.disappearedAt !== null,
    };
  });
}

export interface WorklistSummary {
  total: number;
  byReconcile: Record<ReconcileState, number>;
  byDmsStatus: Record<string, number>;
  /** Deals needing a human action, which is what the console leads with. */
  needsAction: number;
  /** Longest a deal has sat in its current DMS status. */
  oldestDaysInStatus: number;
  lastSyncedAt: string | null;
}

export function summarise(rows: WorklistRow[]): WorklistSummary {
  const byReconcile = {
    IN_SYNC: 0,
    AHEAD: 0,
    BEHIND: 0,
    CONFLICT: 0,
    NOT_STARTED: 0,
  } as Record<ReconcileState, number>;
  const byDmsStatus: Record<string, number> = {};

  let needsAction = 0;
  let oldest = 0;
  let lastSynced: string | null = null;

  for (const r of rows) {
    byReconcile[r.reconcile]++;
    byDmsStatus[r.dms.status] = (byDmsStatus[r.dms.status] ?? 0) + 1;
    if (r.actionRequired) needsAction++;
    if (r.daysInStatus > oldest) oldest = r.daysInStatus;
    if (!lastSynced || r.lastSyncedAt > lastSynced) lastSynced = r.lastSyncedAt;
  }

  return {
    total: rows.length,
    byReconcile,
    byDmsStatus,
    needsAction,
    oldestDaysInStatus: oldest,
    lastSyncedAt: lastSynced,
  };
}
