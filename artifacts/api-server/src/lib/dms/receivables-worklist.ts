/**
 * Money the dealership is owed, read across the whole group.
 *
 * Sixth instance of the mirror pattern, and the second one — after spares — to
 * answer a question a single branch **cannot** answer rather than one it merely
 * failed to.
 *
 * A DMS keys the ledger to a dealer code. Own two outlets and one insurer owes
 * you money in two places; each branch sees a bill worth chasing, and nobody
 * sees an insurer holding a six-figure sum of the group's money. Those are
 * different conversations, and only one of them gets a phone call returned.
 *
 * ## What the states are, and what they are not
 *
 * Ageing is a **consequence**, not a cause, and the registration module already
 * paid for learning the difference. So `daysOverdue` lives on the row and the
 * states name causes: nobody has chased it, they broke a promise, we are
 * disputing it. A screen that ranked by age alone would put a disputed bill and
 * an unchased one in the same queue, and send somebody to have an argument they
 * cannot win.
 *
 * `chasedAt` is a **recency** test, like `rtoChasedAt` before it. A chase three
 * months ago is not a reason to leave a bill alone.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import {
  db,
  dmsReceivablesTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { policyForShowroom, type ResolvedPolicy } from "./policy";
import { dmsReceivables } from "./client";
import { toIsoDate } from "./hero-adapter";
import type { DmsReceivable } from "./types";

export interface ReceivablesSyncResult {
  showroomId: number;
  dealerCode: string;
  seen: number;
  added: number;
  changed: number;
  unchanged: number;
  disappeared: number;
  durationMs: number;
}

/**
 * A DMS amount string, kept as a string.
 *
 * The sibling `dms_part_stock` stores money in `real`, and that is a defect
 * worth not repeating here: float4 carries about seven significant digits, so
 * a fleet invoice of ₹1,27,400.50 is already past what it can hold exactly.
 * These columns are `numeric` and the value arrives from the DMS as a decimal
 * string, so the honest thing is to not convert it at all.
 */
function toDecimal(a: string | null | undefined): string | null {
  if (a === null || a === undefined || a.trim() === "") return null;
  return Number.isFinite(Number(a)) ? a.trim() : null;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function project(r: DmsReceivable) {
  return {
    partyType: r.partyType,
    partyCode: r.partyCode,
    partyName: r.partyName,
    partyEmail: r.partyEmailId,
    invoiceNo: r.invoiceNo,
    invoiceDate: toIsoDate(r.invoiceDt) || null,
    invoiceAmount: toDecimal(r.invoiceAmt),
    receivedAmount: toDecimal(r.receivedAmt),
    dueDate: toIsoDate(r.dueDt) || null,
    againstType: r.againstType,
    againstKey: r.againstKey,
    narration: r.narrationDesc,
    status: r.status,
    lastReceiptDate: toIsoDate(r.lastReceiptDt) || null,
    promisedDate: toIsoDate(r.promisedDt) || null,
  };
}

export async function syncShowroomReceivables(
  showroomId: number,
): Promise<ReceivablesSyncResult[]> {
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

  const results: ReceivablesSyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncDealerReceivables(showroomId, account.dealerCode));
  }
  return results;
}

async function syncDealerReceivables(
  showroomId: number,
  dealerCode: string,
): Promise<ReceivablesSyncResult> {
  const startedAt = Date.now();
  const rows = await dmsReceivables(dealerCode);

  const existing = await db
    .select({
      receivableId: dmsReceivablesTable.receivableId,
      rawHash: dmsReceivablesTable.rawHash,
    })
    .from(dmsReceivablesTable)
    .where(eq(dmsReceivablesTable.showroomId, showroomId));

  const known = new Map(existing.map((r) => [r.receivableId, r]));

  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const row of rows) {
    const rowHash = hashOf(row);
    const prior = known.get(row.receivableId);
    const now = new Date();

    if (prior && prior.rawHash === rowHash) {
      await db
        .update(dmsReceivablesTable)
        .set({ lastSyncedAt: now, disappearedAt: null })
        .where(
          and(
            eq(dmsReceivablesTable.showroomId, showroomId),
            eq(dmsReceivablesTable.receivableId, row.receivableId),
          ),
        );
      unchanged++;
      continue;
    }

    const projected = project(row);

    if (!prior) {
      await db.insert(dmsReceivablesTable).values({
        showroomId,
        dealerCode,
        receivableId: row.receivableId,
        ...projected,
        raw: row as unknown as Record<string, unknown>,
        rawHash: rowHash,
        firstSeenAt: now,
        lastSyncedAt: now,
        lastChangedAt: null,
      });
      added++;
      continue;
    }

    await db
      .update(dmsReceivablesTable)
      .set({
        dealerCode,
        ...projected,
        raw: row as unknown as Record<string, unknown>,
        rawHash: rowHash,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
      })
      .where(
        and(
          eq(dmsReceivablesTable.showroomId, showroomId),
          eq(dmsReceivablesTable.receivableId, row.receivableId),
        ),
      );
    changed++;
  }

  const seenIds = rows.map((r) => r.receivableId);
  const gone = await db
    .update(dmsReceivablesTable)
    .set({ disappearedAt: new Date() })
    .where(
      and(
        eq(dmsReceivablesTable.showroomId, showroomId),
        isNull(dmsReceivablesTable.disappearedAt),
        ...(seenIds.length > 0
          ? [notInArray(dmsReceivablesTable.receivableId, seenIds)]
          : []),
      ),
    )
    .returning({ receivableId: dmsReceivablesTable.receivableId });

  if (seenIds.length === 0) {
    logger.warn(
      { dealerCode },
      "DMS returned zero receivables — treating as a fault, not a paid-up ledger",
    );
  }

  const result: ReceivablesSyncResult = {
    showroomId,
    dealerCode,
    seen: rows.length,
    added,
    changed,
    unchanged,
    disappeared: gone.length,
    durationMs: Date.now() - startedAt,
  };
  logger.info(result, "DMS receivables sync complete");
  return result;
}

// ── Derivation ──────────────────────────────────────────────────────────────

export type ReceivableState =
  | "DISPUTED"
  | "PROMISE_BROKEN"
  | "UNCHASED"
  | "BEING_CHASED"
  | "DUE_SOON"
  | "CURRENT"
  | "SETTLED";

/* The dealership's, since OBJ-18 — a group with a tight cash position wants a
 * different answer here from one without. `lib/dms/policy.ts` holds both. */
const CHASE_FRESH_DAYS = "THRESHOLD.RECEIVABLE_CHASE_FRESH_DAYS";
const DUE_SOON_DAYS = "THRESHOLD.DUE_SOON_DAYS";

export interface PartyExposure {
  partyCode: string;
  partyName: string;
  /** Every outlet this party owes at, and how much. */
  outlets: Array<{ showroomId: number; showroomCode: string | null; balance: number; open: number }>;
  totalBalance: number;
  outletCount: number;
}

export interface ReceivablesWorklistRow {
  receivableId: string;
  dealerCode: string;
  showroomId: number;
  showroomCode: string | null;
  partyType: string;
  partyCode: string;
  partyName: string;
  /** Null for a walk-in customer, and that is why a statement cannot always go. */
  partyEmail: string | null;
  dms: {
    invoiceNo: string;
    invoiceDate: string | null;
    invoiceAmount: number | null;
    receivedAmount: number | null;
    dueDate: string | null;
    againstType: string | null;
    againstKey: string | null;
    narration: string | null;
    status: string;
    lastReceiptDate: string | null;
    promisedDate: string | null;
  };
  ddms: {
    chasedAt: string | null;
    disputedAt: string | null;
    disputeNote: string | null;
  };
  state: ReceivableState;
  note: string | null;
  actionRequired: string | null;
  /** Invoice minus received. The number the screen is actually about. */
  balance: number;
  /** Days past the due date. Negative means it has not fallen due yet. */
  daysOverdue: number;
  /** Days since the invoice. What an ageing bucket is built from. */
  ageDays: number;
  /**
   * Set only when this party owes at more than one outlet. The whole reason
   * this module reads across the group, and absent on every row where it would
   * be noise.
   */
  groupExposure: PartyExposure | null;
  lastSyncedAt: string;
  disappearedFromDms: boolean;
}

function wholeDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function classify(
  status: string,
  balance: number,
  daysOverdue: number,
  promisedDate: string | null,
  chasedAt: Date | null,
  disputedAt: Date | null,
  disputeNote: string | null,
  now: Date,
  policy: ResolvedPolicy,
): { state: ReceivableState; note: string | null; action: string | null } {
  if (status === "SETTLED" || status === "WRITTEN_OFF" || balance <= 0) {
    return { state: "SETTLED", note: null, action: null };
  }

  // A dispute outranks everything, including a very old bill. It is a cause;
  // the age is a consequence of it, and chasing is the wrong instruction.
  if (disputedAt) {
    return {
      state: "DISPUTED",
      note: disputeNote ?? "Marked disputed here, and not resolved.",
      action: "Resolve the dispute — this cannot be collected until it is",
    };
  }

  const chaseDays = chasedAt ? wholeDaysBetween(chasedAt, now) : null;
  const chasedRecently = chaseDays !== null && chaseDays <= policy.days(CHASE_FRESH_DAYS);

  // A broken promise beats a stale chase, because it is newer information and
  // it came from the party rather than from us.
  if (promisedDate) {
    const promised = new Date(`${promisedDate}T00:00:00`);
    const daysPast = wholeDaysBetween(promised, now);
    if (daysPast > 0) {
      return {
        state: "PROMISE_BROKEN",
        note: `They said they would pay by ${promisedDate} and did not. ${daysPast} day${daysPast === 1 ? "" : "s"} ago.`,
        action: `Ring them about ${inr(balance)} — the date they gave has passed`,
      };
    }
  }

  if (daysOverdue > 0) {
    if (chasedRecently) {
      return {
        state: "BEING_CHASED",
        note: `${inr(balance)} outstanding, ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} past due. Chased ${chaseDays === 0 ? "today" : `${chaseDays} day${chaseDays === 1 ? "" : "s"} ago`}.`,
        action: null,
      };
    }
    return {
      state: "UNCHASED",
      note:
        `${inr(balance)} outstanding, ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} past due.` +
        (chaseDays === null
          ? " No follow-up has been recorded."
          : ` Last chased ${chaseDays} days ago.`),
      action: `Chase ${inr(balance)}`,
    };
  }

  if (daysOverdue > -policy.days(DUE_SOON_DAYS)) {
    return {
      state: "DUE_SOON",
      note: `${inr(balance)} falls due in ${Math.abs(daysOverdue)} day${daysOverdue === -1 ? "" : "s"}.`,
      action: null,
    };
  }

  return { state: "CURRENT", note: null, action: null };
}

export interface ReceivablesWorklistOptions {
  /** The dealership's numbers. Resolved from the outlet when absent — see
   *  `policyForShowroom`, and note that it is never silently defaulted. */
  policy?: ResolvedPolicy;
  showroomId: number;
  /**
   * Every showroom this owner holds. The group-exposure lookup reads all of
   * them, and the scope comes from the session rather than the request.
   */
  ownerShowroomIds: number[];
  includeDisappeared?: boolean;
}

export async function buildReceivablesWorklist(
  opts: ReceivablesWorklistOptions,
): Promise<ReceivablesWorklistRow[]> {
  const policy = opts.policy ?? (await policyForShowroom(opts.showroomId));
  const scope = opts.ownerShowroomIds.length > 0 ? opts.ownerShowroomIds : [opts.showroomId];

  // One query across every outlet, then split. The group's ledger has hundreds
  // of rows, not hundreds of thousands, and reading it once is what lets the
  // exposure be computed without a second round trip per party.
  const all = await db
    .select({ r: dmsReceivablesTable, showroomCode: showroomsTable.code })
    .from(dmsReceivablesTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, dmsReceivablesTable.showroomId))
    .where(
      and(
        inArray(dmsReceivablesTable.showroomId, scope),
        opts.includeDisappeared ? undefined : isNull(dmsReceivablesTable.disappearedAt),
      ),
    );

  const now = new Date();
  const num = (v: string | null) => (v === null ? null : Number(v));
  const balanceOf = (r: typeof all[number]["r"]) =>
    Math.max(0, (num(r.invoiceAmount) ?? 0) - (num(r.receivedAmount) ?? 0));

  // Group exposure, computed once over every outlet. A party that owes at one
  // outlet gets nothing here — the finding is the plural, and attaching a
  // single-outlet "exposure" to every row would drown it.
  const byParty = new Map<string, PartyExposure>();
  for (const { r, showroomCode } of all) {
    const balance = balanceOf(r);
    if (balance <= 0) continue;
    const entry = byParty.get(r.partyCode) ?? {
      partyCode: r.partyCode,
      partyName: r.partyName,
      outlets: [],
      totalBalance: 0,
      outletCount: 0,
    };
    const outlet = entry.outlets.find((o) => o.showroomId === r.showroomId);
    if (outlet) {
      outlet.balance += balance;
      outlet.open += 1;
    } else {
      entry.outlets.push({ showroomId: r.showroomId, showroomCode, balance, open: 1 });
    }
    entry.totalBalance += balance;
    entry.outletCount = entry.outlets.length;
    byParty.set(r.partyCode, entry);
  }

  return all
    .filter(({ r }) => r.showroomId === opts.showroomId)
    .map(({ r, showroomCode }) => {
      const balance = balanceOf(r);
      const due = r.dueDate ? new Date(`${r.dueDate}T00:00:00`) : null;
      const invoiced = r.invoiceDate ? new Date(`${r.invoiceDate}T00:00:00`) : null;
      const daysOverdue = due ? wholeDaysBetween(due, now) : 0;
      const ageDays = invoiced ? wholeDaysBetween(invoiced, now) : 0;

      const { state, note, action } = classify(
        r.status,
        balance,
        daysOverdue,
        r.promisedDate,
        r.chasedAt,
        r.disputedAt,
        r.disputeNote,
        now,
        policy,
      );

      const exposure = byParty.get(r.partyCode);

      return {
        receivableId: r.receivableId,
        dealerCode: r.dealerCode,
        showroomId: r.showroomId,
        showroomCode,
        partyType: r.partyType,
        partyCode: r.partyCode,
        partyName: r.partyName,
        partyEmail: r.partyEmail,
        dms: {
          invoiceNo: r.invoiceNo,
          invoiceDate: r.invoiceDate,
          invoiceAmount: num(r.invoiceAmount),
          receivedAmount: num(r.receivedAmount),
          dueDate: r.dueDate,
          againstType: r.againstType,
          againstKey: r.againstKey,
          narration: r.narration,
          status: r.status,
          lastReceiptDate: r.lastReceiptDate,
          promisedDate: r.promisedDate,
        },
        ddms: {
          chasedAt: r.chasedAt?.toISOString() ?? null,
          disputedAt: r.disputedAt?.toISOString() ?? null,
          disputeNote: r.disputeNote,
        },
        state,
        note,
        actionRequired: action,
        balance,
        daysOverdue,
        ageDays,
        groupExposure:
          exposure && exposure.outletCount > 1 && state !== "SETTLED" ? exposure : null,
        lastSyncedAt: r.lastSyncedAt.toISOString(),
        disappearedFromDms: r.disappearedAt !== null,
      };
    });
}

export interface ReceivablesWorklistSummary {
  total: number;
  byState: Record<ReceivableState, number>;
  needsAction: number;
  /** Everything outstanding at this outlet. */
  outstanding: number;
  /** Outstanding and past its due date. The number that should be zero. */
  overdue: number;
  /** The oldest unpaid bill, in days past due. */
  worstDaysOverdue: number;
  /**
   * The largest single party's balance **across the group**, and who it is.
   * Null when no party owes at more than one outlet — in which case the number
   * would be a branch figure wearing a group label.
   */
  largestGroupExposure: { partyName: string; totalBalance: number; outletCount: number } | null;
  lastSyncedAt: string | null;
}

export function summariseReceivables(
  rows: ReceivablesWorklistRow[],
): ReceivablesWorklistSummary {
  const byState = {
    DISPUTED: 0,
    PROMISE_BROKEN: 0,
    UNCHASED: 0,
    BEING_CHASED: 0,
    DUE_SOON: 0,
    CURRENT: 0,
    SETTLED: 0,
  } as Record<ReceivableState, number>;

  let outstanding = 0;
  let overdue = 0;
  let needsAction = 0;
  let worstDaysOverdue = 0;
  let lastSyncedAt: string | null = null;
  let largest: ReceivablesWorklistSummary["largestGroupExposure"] = null;

  for (const row of rows) {
    byState[row.state]++;
    if (row.actionRequired) needsAction++;
    if (row.state !== "SETTLED") {
      outstanding += row.balance;
      if (row.daysOverdue > 0) {
        overdue += row.balance;
        worstDaysOverdue = Math.max(worstDaysOverdue, row.daysOverdue);
      }
    }
    if (row.groupExposure) {
      if (!largest || row.groupExposure.totalBalance > largest.totalBalance) {
        largest = {
          partyName: row.groupExposure.partyName,
          totalBalance: row.groupExposure.totalBalance,
          outletCount: row.groupExposure.outletCount,
        };
      }
    }
    if (!lastSyncedAt || row.lastSyncedAt > lastSyncedAt) lastSyncedAt = row.lastSyncedAt;
  }

  return {
    total: rows.length,
    byState,
    needsAction,
    outstanding,
    overdue,
    worstDaysOverdue,
    largestGroupExposure: largest,
    lastSyncedAt,
  };
}
