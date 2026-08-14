/**
 * The central end of day (OBJ-48).
 *
 * Every branch counts its own till and closes its own day — that is OBJ-40's
 * `closeDay`, and it is the only figure in the whole product a computer cannot
 * produce, because somebody has to open a drawer and count. What was missing is
 * the half above it: **the company's evening**.
 *
 * A hub-and-spoke dealership reconciles centrally at the end of each business
 * day for a reason that has nothing to do with tidiness. Cash is counted at five
 * outlets by five people; financiers pay against sales made at whichever branch
 * the customer walked into; warranty claims are raised by a workshop and settled
 * against the company. Nobody at head office is looking at five screens. They
 * want one line — *did the day close, and if not, where.*
 *
 * ## It is derived, and there is deliberately no table
 *
 * Every other document in this module is written down because it is a statement
 * about a moment: an invoice, a voucher, a challan, a day close. This is a
 * **sum of those**, and a stored sum is a figure that can come to disagree with
 * the things it was a sum of. A branch that reopens and re-closes a day would
 * leave a stored roll-up quoting last night's answer, and it would be quoted —
 * that is what a head-office number is for.
 *
 * The same argument the mirror's reconciliation rests on: a stale *"in sync"*
 * flag is worse than none.
 *
 * ## What it will not do
 *
 * It does not close anything. There is no `closeCompanyDay` here and there is
 * not going to be one, because a company-level close would either post a
 * journal nobody at a branch authorised, or lock five branches out of correcting
 * their own evening. What it does is **read five closes and name the one that is
 * out** — which is the entire ask, and is a report rather than a document.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  showroomsTable,
  dayClosesTable,
  moneyDocumentsTable,
  partiesTable,
  legalEntitiesTable,
  type DayCloseRow,
} from "@workspace/db";

import { branchesOfEntity } from "../org";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** One branch's evening, as head office sees it. */
export interface BranchEvening {
  showroomId: number;
  branchCode: string;
  branchName: string;
  role: string;
  /** Whether anybody counted the till and closed the day. */
  closed: boolean;
  bookedCash: number;
  countedCash: number;
  difference: number;
  reason: DayCloseRow["reason"] | null;
  reasonNote: string | null;
  bankReceipts: number;
  bankPayments: number;
  /** Received today from a financier — the payout against a sale already made. */
  financierReceipts: number;
  /** Received today from the manufacturer, warranty and scheme settlements. */
  oemReceipts: number;
}

export interface CentralEndOfDay {
  entityId: number;
  entityName: string;
  closeDate: string;
  branches: BranchEvening[];
  branchCount: number;
  closedCount: number;

  /** The company's figures, which are the sum of the branches' and nothing else. */
  bookedCash: number;
  countedCash: number;
  difference: number;
  bankReceipts: number;
  bankPayments: number;
  financierReceipts: number;
  oemReceipts: number;

  /** Branches whose count did not agree with their books. Named, R-114. */
  outOfLine: Array<{
    branchCode: string;
    branchName: string;
    difference: number;
    reason: DayCloseRow["reason"];
    reasonNote: string | null;
  }>;
  /** Branches that never closed. The commonest finding, and not a zero. */
  notClosed: Array<{ branchCode: string; branchName: string }>;

  /**
   * Whether the company's evening is finished and straight.
   *
   * Two conditions and they are different failures: **every branch closed** and
   * **every close agreed**. A day where four branches balanced and the fifth
   * never counted is not a clean day, and reporting it as one because the four
   * that reported added up is exactly how a missing till goes unnoticed until
   * the month end.
   */
  reconciles: boolean;
  warnings: string[];
}

/**
 * Head office's evening for one company, on one date.
 *
 * `entityId` and not `ownerId`, because cash belongs to a **company**. A group
 * holding two legal entities has two evenings, and adding their tills together
 * would produce a figure that is not any company's money — the same reason the
 * balance sheet is drawn per entity and the day close per branch (R-119, R-120).
 */
export async function centralEndOfDay(input: {
  ownerId: number;
  entityId: number;
  closeDate: string;
}): Promise<CentralEndOfDay> {
  const warnings: string[] = [];
  const [entity] = await db
    .select({ legalName: legalEntitiesTable.legalName })
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.id, input.entityId));
  const branchIds = await branchesOfEntity(input.entityId);

  if (branchIds.length === 0) {
    return {
      entityId: input.entityId,
      entityName: entity?.legalName ?? `Entity ${input.entityId}`,
      closeDate: input.closeDate,
      branches: [],
      branchCount: 0,
      closedCount: 0,
      bookedCash: 0,
      countedCash: 0,
      difference: 0,
      bankReceipts: 0,
      bankPayments: 0,
      financierReceipts: 0,
      oemReceipts: 0,
      outOfLine: [],
      notClosed: [],
      reconciles: false,
      warnings: ["This company has no branches, so there is no evening to consolidate."],
    };
  }

  const branches = await db
    .select({
      id: showroomsTable.id,
      code: showroomsTable.code,
      name: showroomsTable.name,
      role: showroomsTable.role,
    })
    .from(showroomsTable)
    .where(inArray(showroomsTable.id, branchIds))
    .orderBy(asc(showroomsTable.code));

  const closes = await db
    .select()
    .from(dayClosesTable)
    .where(
      and(
        eq(dayClosesTable.ownerId, input.ownerId),
        inArray(dayClosesTable.showroomId, branchIds),
        eq(dayClosesTable.closeDate, input.closeDate),
      ),
    );
  const closeBy = new Map(closes.map((c) => [c.showroomId, c]));

  /*
   * Financier payouts and manufacturer settlements, by **who paid** rather than
   * by which account the receipt landed in.
   *
   * A bank receipt is a bank receipt; what makes it worth a line at head office
   * is that the money came from a financier against a sale a branch made, or
   * from the OEM against a claim a workshop raised. `parties.kind` already
   * carries that, so nothing here classifies anything.
   */
  const settlements = await db
    .select({
      showroomId: moneyDocumentsTable.showroomId,
      kind: partiesTable.kind,
      amount: moneyDocumentsTable.amount,
    })
    .from(moneyDocumentsTable)
    .innerJoin(partiesTable, eq(moneyDocumentsTable.partyId, partiesTable.id))
    .where(
      and(
        inArray(moneyDocumentsTable.showroomId, branchIds),
        eq(moneyDocumentsTable.direction, "RECEIPT"),
        eq(moneyDocumentsTable.status, "POSTED"),
        eq(moneyDocumentsTable.documentDate, input.closeDate),
        inArray(partiesTable.kind, ["FINANCIER", "OEM"]),
      ),
    );

  const financierAt = new Map<number, number>();
  const oemAt = new Map<number, number>();
  for (const s of settlements) {
    const into = s.kind === "FINANCIER" ? financierAt : oemAt;
    into.set(s.showroomId, round2((into.get(s.showroomId) ?? 0) + n(s.amount)));
  }

  const rows: BranchEvening[] = branches.map((b) => {
    const c = closeBy.get(b.id);
    return {
      showroomId: b.id,
      branchCode: b.code,
      branchName: b.name,
      role: b.role,
      closed: Boolean(c),
      bookedCash: c ? round2(n(c.bookedCash)) : 0,
      countedCash: c ? round2(n(c.countedCash)) : 0,
      difference: c ? round2(n(c.difference)) : 0,
      reason: c ? c.reason : null,
      reasonNote: c?.reasonNote ?? null,
      bankReceipts: c ? round2(n(c.bankReceipts)) : 0,
      bankPayments: c ? round2(n(c.bankPayments)) : 0,
      financierReceipts: financierAt.get(b.id) ?? 0,
      oemReceipts: oemAt.get(b.id) ?? 0,
    };
  });

  const sum = (of: (r: BranchEvening) => number): number =>
    round2(rows.reduce((a, r) => a + of(r), 0));

  const notClosed = rows
    .filter((r) => !r.closed)
    .map((r) => ({ branchCode: r.branchCode, branchName: r.branchName }));

  const outOfLine = rows
    .filter((r) => r.closed && r.difference !== 0)
    .map((r) => ({
      branchCode: r.branchCode,
      branchName: r.branchName,
      difference: r.difference,
      reason: r.reason!,
      reasonNote: r.reasonNote,
    }));

  if (notClosed.length > 0) {
    warnings.push(
      `${notClosed.map((b) => b.branchName).join(", ")} did not close on ${input.closeDate}. ` +
        "A branch that never counted contributes nothing to these totals, so the company figure is short by " +
        "whatever was in that till — it is not a zero, it is an absence, and the two read identically on a screen.",
    );
  }
  for (const b of outOfLine) {
    warnings.push(
      `${b.branchName} is ${b.difference > 0 ? "over" : "short"} by ₹${Math.abs(b.difference).toFixed(2)}` +
        `${b.reason === "UNEXPLAINED" ? " and nobody has said why" : ` — ${b.reason.toLowerCase().replace(/_/g, " ")}`}.`,
    );
  }

  return {
    entityId: input.entityId,
    entityName: entity?.legalName ?? `Entity ${input.entityId}`,
    closeDate: input.closeDate,
    branches: rows,
    branchCount: rows.length,
    closedCount: rows.filter((r) => r.closed).length,
    bookedCash: sum((r) => r.bookedCash),
    countedCash: sum((r) => r.countedCash),
    difference: sum((r) => r.difference),
    bankReceipts: sum((r) => r.bankReceipts),
    bankPayments: sum((r) => r.bankPayments),
    financierReceipts: sum((r) => r.financierReceipts),
    oemReceipts: sum((r) => r.oemReceipts),
    outOfLine,
    notClosed,
    reconciles: notClosed.length === 0 && outOfLine.length === 0,
    warnings,
  };
}

/**
 * The same evening across a run of days, which is what a pattern looks like.
 *
 * One short till is a bad afternoon. The same branch short on nine evenings out
 * of ten is a different fact entirely, and it is invisible in any single day's
 * report — which is the argument for this function existing rather than the
 * caller looping and adding up.
 */
export async function eveningsOverPeriod(input: {
  ownerId: number;
  entityId: number;
  from: string;
  to: string;
}): Promise<{
  days: Array<{ closeDate: string; closedCount: number; branchCount: number; difference: number }>;
  byBranch: Array<{
    branchCode: string;
    branchName: string;
    daysClosed: number;
    daysOut: number;
    netDifference: number;
    worstDifference: number;
  }>;
  daysWithAnyDifference: number;
}> {
  const branchIds = await branchesOfEntity(input.entityId);
  if (branchIds.length === 0) return { days: [], byBranch: [], daysWithAnyDifference: 0 };

  const branches = await db
    .select({ id: showroomsTable.id, code: showroomsTable.code, name: showroomsTable.name })
    .from(showroomsTable)
    .where(inArray(showroomsTable.id, branchIds))
    .orderBy(asc(showroomsTable.code));

  const closes = await db
    .select()
    .from(dayClosesTable)
    .where(
      and(
        eq(dayClosesTable.ownerId, input.ownerId),
        inArray(dayClosesTable.showroomId, branchIds),
        sql`${dayClosesTable.closeDate}::text >= ${input.from}`,
        sql`${dayClosesTable.closeDate}::text <= ${input.to}`,
      ),
    )
    .orderBy(asc(dayClosesTable.closeDate));

  const byDate = new Map<string, DayCloseRow[]>();
  for (const c of closes) {
    const list = byDate.get(c.closeDate) ?? [];
    list.push(c);
    byDate.set(c.closeDate, list);
  }

  const days = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([closeDate, list]) => ({
      closeDate,
      closedCount: list.length,
      branchCount: branches.length,
      difference: round2(list.reduce((a, c) => a + n(c.difference), 0)),
    }));

  const byBranch = branches.map((b) => {
    const mine = closes.filter((c) => c.showroomId === b.id);
    const diffs = mine.map((c) => n(c.difference));
    return {
      branchCode: b.code,
      branchName: b.name,
      daysClosed: mine.length,
      daysOut: diffs.filter((d) => d !== 0).length,
      netDifference: round2(diffs.reduce((a, d) => a + d, 0)),
      worstDifference: diffs.reduce((w, d) => (Math.abs(d) > Math.abs(w) ? d : w), 0),
    };
  });

  return {
    days,
    byBranch,
    daysWithAnyDifference: days.filter((d) => d.difference !== 0).length,
  };
}
