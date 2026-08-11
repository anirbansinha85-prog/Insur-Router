/**
 * The workshop mirror, and what it means.
 *
 * Second instance of the pattern `dms_deals` established: pull, keep, derive on
 * read, never write back. The sync below is the same three behaviours — cheap
 * when nothing moved, a status clock that only advances on real status change,
 * and vanishing rows marked rather than deleted.
 *
 * What is genuinely different is the derivation. Insurance reconciles by
 * comparing a policy number that either matches or does not. A workshop has no
 * such field: the question is *whether the promise is being kept and whether
 * anyone told the customer*, and no DMS records the second half because telling
 * someone is not a workshop event. That absence is the gap this reads.
 */

import { createHash } from "node:crypto";
import { and, eq, isNull, notInArray, desc } from "drizzle-orm";
import {
  db,
  dmsJobCardsTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { jobCardSourceFor } from "./ingest";
import type { Listed } from "./ingest";
import { toIsoDate, toAmount } from "./hero-adapter";
import type { DmsJobCard } from "./types";

export interface JobCardSyncResult {
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

function project(jc: DmsJobCard) {
  return {
    status: jc.status,
    jcType: jc.jcType,
    jcDate: toIsoDate(jc.jcDt) || null,
    promisedDate: toIsoDate(jc.promisedDt) || null,
    actualCloseDate: toIsoDate(jc.actualCloseDt) || null,
    customerName: jc.custName,
    customerMobile: jc.mobileNo,
    modelDescription: jc.modelDesc,
    regNo: jc.regNo,
    chassisNo: jc.chassisNo,
    advisorEmpCode: jc.advisorEmpCode,
    estimateAmount: toAmount(jc.estimateAmt),
    finalAmount: toAmount(jc.finalAmt),
    // Lifted out of the part lines so "held up by a part" is a column test
    // rather than unpacking JSON for every row on a busy day.
    hasUnissuedPart: jc.parts.some((p) => p.issuedFlg === "N") ? "Y" : "N",
    psfDone: jc.psf && jc.psf.callDt ? "Y" : "N",
  };
}

export async function syncShowroomJobCards(showroomId: number): Promise<JobCardSyncResult[]> {
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

  const results: JobCardSyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncDealerJobCards(showroomId, account.dealerCode));
  }
  return results;
}

async function syncDealerJobCards(
  showroomId: number,
  dealerCode: string,
): Promise<JobCardSyncResult> {
  const startedAt = Date.now();
  /*
   * The one line that makes three paths possible.
   *
   * Everything below is written against a `Source<T>` and cannot tell the OEM's
   * API from a register somebody exported this morning. A dealership nobody has
   * configured resolves to `API` and behaves exactly as it did before.
   */
  const source = await jobCardSourceFor(showroomId, dealerCode);
  const listed = await source.list();


  const existing = await db
    .select({
      jcNo: dmsJobCardsTable.jcNo,
      rawHash: dmsJobCardsTable.rawHash,
      status: dmsJobCardsTable.status,
    })
    .from(dmsJobCardsTable)
    .where(eq(dmsJobCardsTable.dealerCode, dealerCode));

  const known = new Map(existing.map((r) => [r.jcNo, r]));

  let added = 0;
  let changed = 0;
  let unchanged = 0;

  /*
   * Which ones to load in full.
   *
   * The listing carries a fingerprint of whatever the source could see cheaply,
   * so a record whose fingerprint has not moved needs no expensive load. On the
   * API path that is one round trip instead of a hundred; on the report path
   * the file is already in hand and this costs nothing.
   */
  const toLoad: string[] = [];
  for (const l of listed) {
    const prior = known.get(l.key);
    if (prior && prior.rawHash === l.fingerprint) {
      await db
        .update(dmsJobCardsTable)
        .set({ lastSyncedAt: new Date(), disappearedAt: null })
        .where(
          and(eq(dmsJobCardsTable.dealerCode, dealerCode), eq(dmsJobCardsTable.jcNo, l.key)),
        );
      unchanged++;
      continue;
    }
    toLoad.push(l.key);
  }

  const fingerprintOf = new Map(listed.map((l: Listed) => [l.key, l.fingerprint]));

  for (const sourced of await source.load(toLoad)) {
    const jc = sourced.record;
    const summaryHash = fingerprintOf.get(sourced.key) ?? hashOf(jc);
    const prior = known.get(sourced.key);

    const projected = project(jc);
    const now = new Date();

    if (!prior) {
      await db.insert(dmsJobCardsTable).values({
        showroomId,
        dealerCode,
        jcNo: jc.jcNo,
        ...projected,
        raw: jc as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        firstSeenAt: now,
        statusSince: now,
        lastSyncedAt: now,
        lastChangedAt: null,
      });
      added++;
      continue;
    }

    // Same rule as deals: a corrected phone number must not reset how long this
    // vehicle has been sitting in the bay.
    const statusMoved = prior.status !== projected.status;

    await db
      .update(dmsJobCardsTable)
      .set({
        showroomId,
        ...projected,
        raw: jc as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
        ...(statusMoved ? { statusSince: now } : {}),
      })
      .where(and(eq(dmsJobCardsTable.dealerCode, dealerCode), eq(dmsJobCardsTable.jcNo, jc.jcNo)));
    changed++;
  }

  /*
   * Disappearance, and only where the source is entitled to claim it.
   *
   * An API lists the outlet's whole book every time, so a record that stops
   * appearing has genuinely gone. A report covering one month says nothing
   * about the other eleven.
   */
  const seenIds = listed.map((l: Listed) => l.key);
  const gone = source.listIsComplete
    ? await db
    .update(dmsJobCardsTable)
    .set({ disappearedAt: new Date() })
    .where(
      and(
        eq(dmsJobCardsTable.dealerCode, dealerCode),
        isNull(dmsJobCardsTable.disappearedAt),
        // An empty list is a fault, not an empty workshop.
        ...(seenIds.length > 0 ? [notInArray(dmsJobCardsTable.jcNo, seenIds)] : []),
      ),
    )
    .returning({ jcNo: dmsJobCardsTable.jcNo })
    : [];

  if (seenIds.length === 0) {
    logger.warn({ dealerCode }, "DMS returned zero job cards — treating as a fault, not an empty workshop");
  }

  const result: JobCardSyncResult = {
    showroomId,
    dealerCode,
    seen: listed.length,
    added,
    changed,
    unchanged,
    disappeared: gone.length,
    durationMs: Date.now() - startedAt,
  };
  logger.info(result, "DMS job card sync complete");
  return result;
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * What this job card needs from a human.
 *
 * Ordered by what a service manager would deal with first. Every one of these
 * except `ON_TRACK` and `CLOSED` resolves to somebody picking up a phone, which
 * is the finding worth keeping: a workshop's backlog is mostly unmade calls.
 */
export type ServiceState =
  | "AWAITING_APPROVAL"
  | "AWAITING_PART"
  | "READY_UNCOLLECTED"
  | "OVERDUE"
  | "FOLLOW_UP_DUE"
  | "ON_TRACK"
  | "CLOSED";

export interface ServiceWorklistRow {
  jcNo: string;
  dealerCode: string;
  showroomId: number;
  showroomCode: string | null;
  customerName: string | null;
  customerMobile: string | null;
  modelDescription: string | null;
  regNo: string | null;
  jcType: string;
  advisorEmpCode: string | null;
  dms: {
    status: string;
    jcDate: string | null;
    promisedDate: string | null;
    actualCloseDate: string | null;
    estimateAmount: number | null;
    finalAmount: number | null;
    hasUnissuedPart: boolean;
    psfDone: boolean;
  };
  ddms: {
    customerInformedAt: string | null;
  };
  state: ServiceState;
  note: string | null;
  actionRequired: string | null;
  /** Days past the promised date. Negative means still in hand. */
  daysLate: number;
  daysInStatus: number;
  lastSyncedAt: string;
  disappearedFromDms: boolean;
}

function wholeDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

function classify(
  status: string,
  promisedDate: string | null,
  hasUnissuedPart: boolean,
  psfDone: boolean,
  customerInformedAt: Date | null,
  daysLate: number,
): { state: ServiceState; note: string | null; action: string | null } {
  const late = daysLate > 0 ? ` ${daysLate} day${daysLate === 1 ? "" : "s"} past the promised date.` : "";

  if (status === "AWAITING_APPROVAL") {
    return {
      state: "AWAITING_APPROVAL",
      note: `Work stopped — the revised estimate needs the customer's approval.${late}`,
      action: "Call the customer for approval on the revised estimate",
    };
  }

  if (status === "AWAITING_PARTS" || (hasUnissuedPart && status !== "DELIVERED" && status !== "INVOICED")) {
    return {
      state: "AWAITING_PART",
      note: `A part is not on the shelf and the vehicle cannot move.${late}`,
      action: customerInformedAt
        ? "Chase the part — the customer has been told"
        : "Chase the part, and tell the customer the new date",
    };
  }

  if (status === "READY") {
    // The quiet failure. The work is done, the bay is occupied, and the
    // customer is waiting for a call that nobody has made.
    return customerInformedAt
      ? {
          state: "READY_UNCOLLECTED",
          note: "Ready and the customer has been told. Waiting on collection.",
          action: null,
        }
      : {
          state: "READY_UNCOLLECTED",
          note: `Finished, and the customer does not know.${late}`,
          action: "Call the customer — the vehicle is ready to collect",
        };
  }

  if (status === "DELIVERED" || status === "INVOICED") {
    if (!psfDone) {
      return {
        state: "FOLLOW_UP_DUE",
        note: "Delivered, but no post-service follow-up was ever recorded.",
        action: "Make the follow-up call",
      };
    }
    return { state: "CLOSED", note: "Delivered and followed up.", action: null };
  }

  if (daysLate > 0) {
    return {
      state: "OVERDUE",
      note: `Still open,${late}`,
      action: "Re-promise a date and tell the customer",
    };
  }

  return { state: "ON_TRACK", note: null, action: null };
}

export interface ServiceWorklistOptions {
  showroomId: number;
  status?: string;
  includeDisappeared?: boolean;
}

export async function buildServiceWorklist(
  opts: ServiceWorklistOptions,
): Promise<ServiceWorklistRow[]> {
  const rows = await db
    .select({ jc: dmsJobCardsTable, showroomCode: showroomsTable.code })
    .from(dmsJobCardsTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, dmsJobCardsTable.showroomId))
    .where(
      and(
        eq(dmsJobCardsTable.showroomId, opts.showroomId),
        opts.status ? eq(dmsJobCardsTable.status, opts.status) : undefined,
        opts.includeDisappeared ? undefined : isNull(dmsJobCardsTable.disappearedAt),
      ),
    )
    .orderBy(desc(dmsJobCardsTable.statusSince));

  const today = new Date();

  return rows.map(({ jc, showroomCode }) => {
    const closed = jc.status === "DELIVERED" || jc.status === "INVOICED";
    const daysLate =
      jc.promisedDate && !closed ? wholeDaysBetween(new Date(jc.promisedDate), today) : 0;

    const { state, note, action } = classify(
      jc.status,
      jc.promisedDate,
      jc.hasUnissuedPart === "Y",
      jc.psfDone === "Y",
      jc.customerInformedAt,
      daysLate,
    );

    return {
      jcNo: jc.jcNo,
      dealerCode: jc.dealerCode,
      showroomId: jc.showroomId,
      showroomCode,
      customerName: jc.customerName,
      customerMobile: jc.customerMobile,
      modelDescription: jc.modelDescription,
      regNo: jc.regNo,
      jcType: jc.jcType,
      advisorEmpCode: jc.advisorEmpCode,
      dms: {
        status: jc.status,
        jcDate: jc.jcDate,
        promisedDate: jc.promisedDate,
        actualCloseDate: jc.actualCloseDate,
        estimateAmount: jc.estimateAmount,
        finalAmount: jc.finalAmount,
        hasUnissuedPart: jc.hasUnissuedPart === "Y",
        psfDone: jc.psfDone === "Y",
      },
      ddms: {
        customerInformedAt: jc.customerInformedAt?.toISOString() ?? null,
      },
      state,
      note,
      actionRequired: action,
      daysLate,
      daysInStatus: wholeDaysBetween(jc.statusSince, today),
      lastSyncedAt: jc.lastSyncedAt.toISOString(),
      disappearedFromDms: jc.disappearedAt !== null,
    };
  });
}

export interface ServiceWorklistSummary {
  total: number;
  byState: Record<ServiceState, number>;
  needsAction: number;
  /** Vehicles finished but not collected — occupied bays and unmade calls. */
  readyUncollected: number;
  worstDaysLate: number;
  lastSyncedAt: string | null;
}

export function summariseService(rows: ServiceWorklistRow[]): ServiceWorklistSummary {
  const byState = {
    AWAITING_APPROVAL: 0,
    AWAITING_PART: 0,
    READY_UNCOLLECTED: 0,
    OVERDUE: 0,
    FOLLOW_UP_DUE: 0,
    ON_TRACK: 0,
    CLOSED: 0,
  } as Record<ServiceState, number>;

  let needsAction = 0;
  let worstDaysLate = 0;
  let lastSynced: string | null = null;

  for (const r of rows) {
    byState[r.state]++;
    if (r.actionRequired) needsAction++;
    if (r.daysLate > worstDaysLate) worstDaysLate = r.daysLate;
    if (!lastSynced || r.lastSyncedAt > lastSynced) lastSynced = r.lastSyncedAt;
  }

  return {
    total: rows.length,
    byState,
    needsAction,
    readyUncollected: byState.READY_UNCOLLECTED,
    worstDaysLate,
    lastSyncedAt: lastSynced,
  };
}
