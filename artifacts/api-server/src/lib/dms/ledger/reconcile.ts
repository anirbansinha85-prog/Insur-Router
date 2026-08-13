/**
 * The ten reconciliations, and the eleventh that is a product decision
 * (OBJ-45, R-114, R-115).
 *
 * ## Every one of them names rows, not a difference
 *
 * That is R-114 and it is the whole design. *"Stock is out by ₹1,87,500"* is an
 * afternoon in a spreadsheet. *"These three chassis numbers"* is a phone call.
 * A variance figure tells somebody there is a problem and nothing about where;
 * a list of documents is the work already done.
 *
 * So every function here returns **rows** and the totals are a convenience on
 * top, never the answer.
 *
 * ## What they compare, grouped
 *
 * ```
 *   inside our own books   1 inter-branch   2 stock   3 debtors
 *   money                  4 day close      5 bank    6 financier   7 the OEM
 *   statutory              8 GSTR-1         9 GSTR-3B  10 GSTR-2B
 * ```
 *
 * Several of them already exist in the module that owns the data — `inTransit`
 * is the first, `stockPositionCheck` the second, `controlAccountCheck` and
 * `ageing` the third, `dayCloseDifferences` the fourth, `inputCreditAtRisk` the
 * tenth's first half, `returnAgainstBooks` the ninth. **This file does not
 * reimplement them**; it gathers them, because a reconciliation screen that
 * computed its own version of a figure the module already computes would be the
 * ninth reconciliation's problem arriving through the front door.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  vouchersTable,
  voucherLinesTable,
  partiesTable,
  partyBillsTable,
  moneyDocumentsTable,
  purchaseInvoicesTable,
  dmsReceivablesTable,
  serviceInvoiceLinesTable,
  serviceInvoicesTable,
} from "@workspace/db";

import { branchesOfEntity, branchesOfRegistration } from "../org";
import { inTransit, stockPositionCheck } from "./moves";
import { ageing, controlAccountCheck } from "./parties";
import { dayCloseDifferences } from "./money";
import { inputCreditAtRisk } from "./purchase";
import { returnAgainstBooks, monthRange } from "./returns3b";
import { warrantyClaimable } from "./service";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * One reconciliation's answer.
 *
 * `rows` is the point and `total` is decoration. `clean` is separate from
 * `rows.length === 0` on purpose: a reconciliation that could not run — no
 * source to compare against, a month with no data — is **not** clean, and
 * reporting it as clean is how a dealership comes to believe a control is
 * working when it has never run.
 */
export interface Reconciliation {
  key: string;
  title: string;
  /** What two things this compares, in one sentence. */
  compares: string;
  ran: boolean;
  clean: boolean;
  rows: Array<{ ref: string; detail: string; amount: number | null }>;
  total: number;
  /** Why it could not run, when it could not. */
  note: string | null;
}

const empty = (
  key: string,
  title: string,
  compares: string,
  note: string,
): Reconciliation => ({
  key,
  title,
  compares,
  ran: false,
  clean: false,
  rows: [],
  total: 0,
  note,
});

export interface ReconcileInput {
  ownerId: number;
  entityId: number;
  /** `YYYY-MM`. Every one of these is a monthly control. */
  period: string;
  registrationId?: number | null;
}

/** 1 — transfers out against transfers in, chassis by chassis. */
export async function reconcileInterBranch(input: ReconcileInput): Promise<Reconciliation> {
  const { to } = monthRange(input.period);
  const open = await inTransit({ ownerId: input.ownerId, asOf: to });

  return {
    key: "INTER_BRANCH",
    title: "Inter-branch",
    compares: "what left a branch against what arrived at another",
    ran: true,
    clean: open.rows.length === 0,
    rows: open.rows.flatMap((r) =>
      r.chassisNos.map((c) => ({
        ref: r.challanNo,
        detail: `${c} — left ${r.challanDate}, ${r.days} day(s) ago, arrived nowhere`,
        amount: null,
      })),
    ),
    total: open.total,
    note:
      open.rows.length === 0
        ? null
        : "A machine that left the hub and arrived nowhere is standing in a yard nobody has recorded, or it has walked.",
  };
}

/** 2 — the register against the DMS mirror, chassis by chassis. */
export async function reconcileStock(input: ReconcileInput): Promise<Reconciliation> {
  const { to } = monthRange(input.period);
  const pos = await stockPositionCheck({ ownerId: input.ownerId, asOf: to });

  const rows = [
    ...pos.mismatched.map((m) => ({
      ref: m.chassisNo,
      detail: `register says branch ${m.registerAt ?? "nowhere"}, the dealer's system says branch ${m.mirrorAt}`,
      amount: null,
    })),
    ...pos.onlyInRegister.map((c) => ({
      ref: c,
      detail: "in our register, not in the dealer's system",
      amount: null,
    })),
  ];

  return {
    key: "STOCK",
    title: "Stock",
    compares: "the chassis register against the dealer's own stock",
    ran: true,
    clean: rows.length === 0,
    rows,
    total: 0,
    note:
      pos.onlyInMirror.length > 0
        ? `${pos.onlyInMirror.length} machine(s) are in the dealer's system and have never been through ours — ordinary while the books are young, and the number should fall every month.`
        : null,
  };
}

/** 3 — the party ledger against the control account, and against the mirror. */
export async function reconcileDebtors(input: ReconcileInput): Promise<Reconciliation> {
  const { to } = monthRange(input.period);
  const control = await controlAccountCheck({
    ownerId: input.ownerId,
    entityId: input.entityId,
    controlCode: "1100",
    asOf: to,
  });
  const age = await ageing({
    ownerId: input.ownerId,
    entityId: input.entityId,
    direction: "RECEIVABLE",
    asOf: to,
  });

  /*
   * Two comparisons under one heading, and they catch different things. The
   * control check finds money on `1100` with no party against it - a trial
   * balance that balances and a debtors report that is wrong. The mirror check
   * finds a customer the dealer's own system is chasing that our books think
   * has paid.
   */
  const mirror = await db
    .select({
      invoiceNo: dmsReceivablesTable.invoiceNo,
      partyName: dmsReceivablesTable.partyName,
      invoiceAmount: dmsReceivablesTable.invoiceAmount,
      receivedAmount: dmsReceivablesTable.receivedAmount,
    })
    .from(dmsReceivablesTable)
    .where(
      sql`coalesce(${dmsReceivablesTable.invoiceAmount}, 0)::numeric > coalesce(${dmsReceivablesTable.receivedAmount}, 0)::numeric`,
    );

  const rows = [
    ...control.unattributed.map((u) => ({
      ref: u.voucherNo,
      detail: `${u.voucherDate} — on Sundry Debtors with no customer against it`,
      amount: u.amount,
    })),
  ];

  return {
    key: "DEBTORS",
    title: "Debtors",
    compares: "each customer's ledger against Sundry Debtors, and against the dealer's own receivables",
    ran: true,
    clean: rows.length === 0 && control.difference === 0,
    rows,
    total: round2(age.total),
    note:
      mirror.length > 0
        ? `The dealer's own system is chasing ${mirror.length} customer(s) for ₹${round2(mirror.reduce((a, m) => a + (n(m.invoiceAmount) - n(m.receivedAmount)), 0)).toLocaleString("en-IN")}. Compare that against the ₹${age.total.toLocaleString("en-IN")} our books show outstanding — while the books are young these will differ, and the gap is the graduation scorecard's subject.`
        : null,
  };
}

/** 4 — cash counted against cash booked, every evening. */
export async function reconcileDayClose(input: ReconcileInput): Promise<Reconciliation> {
  const { from, to } = monthRange(input.period);
  const diffs = await dayCloseDifferences({ ownerId: input.ownerId, from, to });

  return {
    key: "DAY_CLOSE",
    title: "Day close",
    compares: "cash counted at each branch against cash the books expected",
    ran: true,
    clean: diffs.rows.length === 0,
    rows: diffs.rows.map((r) => ({
      ref: `${r.closeDate} · branch ${r.showroomId}`,
      detail: `${n(r.difference) > 0 ? "excess" : "shortfall"} — ${r.reason.toLowerCase().replace(/_/g, " ")}${r.reasonNote ? `: ${r.reasonNote}` : ""}`,
      amount: n(r.difference),
    })),
    total: diffs.total,
    note:
      diffs.unexplained > 0
        ? `${diffs.unexplained} of these are unexplained. One is a bad evening; a pattern is the finding.`
        : null,
  };
}

/**
 * 5 — the bank statement against the bank book.
 *
 * **This one cannot run**, and saying so is the honest answer. Nothing in the
 * product imports a bank statement, so there is no second side to compare
 * against. Producing a "reconciliation" from one source would be producing a
 * tick beside a control that has never been performed — which is worse than the
 * gap, because a dealership would stop looking.
 *
 * What it *can* do is show what a statement would be compared against, so the
 * work is a spreadsheet rather than an archaeology.
 */
export async function reconcileBank(input: ReconcileInput): Promise<Reconciliation> {
  const { from, to } = monthRange(input.period);
  const branchIds = await branchesOfEntity(input.entityId);
  if (branchIds.length === 0)
    return empty("BANK", "Bank", "the bank statement against the bank book", "No branches.");

  const rows = await db
    .select({
      documentNo: moneyDocumentsTable.documentNo,
      documentDate: moneyDocumentsTable.documentDate,
      direction: moneyDocumentsTable.direction,
      mode: moneyDocumentsTable.mode,
      instrumentRef: moneyDocumentsTable.instrumentRef,
      amount: moneyDocumentsTable.amount,
    })
    .from(moneyDocumentsTable)
    .where(
      and(
        eq(moneyDocumentsTable.ownerId, input.ownerId),
        inArray(moneyDocumentsTable.showroomId, branchIds),
        eq(moneyDocumentsTable.status, "POSTED"),
        sql`${moneyDocumentsTable.mode} <> 'CASH'`,
        sql`${moneyDocumentsTable.documentDate}::text >= ${from}`,
        sql`${moneyDocumentsTable.documentDate}::text <= ${to}`,
      ),
    )
    .orderBy(asc(moneyDocumentsTable.documentDate));

  const noRef = rows.filter((r) => !r.instrumentRef);

  return {
    key: "BANK",
    title: "Bank",
    compares: "the bank statement against the bank book",
    ran: false,
    clean: false,
    rows: noRef.map((r) => ({
      ref: r.documentNo,
      detail: `${r.documentDate} — ${r.mode} with no UTR, cheque number or UPI reference recorded`,
      amount: n(r.amount),
    })),
    total: round2(rows.reduce((a, r) => a + n(r.amount), 0)),
    note:
      "**This reconciliation has not been performed.** Nothing imports a bank statement, so there is " +
      `no second side. ${rows.length} non-cash movement(s) this month are what a statement would be ` +
      `matched against, and ${noRef.length} of them carry no reference, which is what makes matching hard. ` +
      "Reporting this as clean would be a tick beside a control nobody has run.",
  };
}

/** 6 — disbursements expected from live bookings against disbursements received. */
export async function reconcileFinancier(input: ReconcileInput): Promise<Reconciliation> {
  const { from, to } = monthRange(input.period);
  const branchIds = await branchesOfEntity(input.entityId);
  if (branchIds.length === 0)
    return empty("FINANCIER", "Financier", "money expected from financiers against money received", "No branches.");

  /*
   * Money a dealership is owed and routinely forgets. A financier who agreed to
   * disburse and did not is a bike delivered and unpaid for, and it is invisible
   * unless somebody compares the two sides - which is precisely why this is a
   * report rather than a habit.
   */
  const received = await db
    .select({
      total: sql<string>`coalesce(sum(${moneyDocumentsTable.amount}::numeric), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(moneyDocumentsTable)
    .where(
      and(
        eq(moneyDocumentsTable.ownerId, input.ownerId),
        inArray(moneyDocumentsTable.showroomId, branchIds),
        eq(moneyDocumentsTable.mode, "FINANCIER"),
        eq(moneyDocumentsTable.status, "POSTED"),
        sql`${moneyDocumentsTable.documentDate}::text >= ${from}`,
        sql`${moneyDocumentsTable.documentDate}::text <= ${to}`,
      ),
    );

  const outstanding = await db
    .select({
      billNo: partyBillsTable.billNo,
      billDate: partyBillsTable.billDate,
      partyName: partiesTable.name,
      outstanding: partyBillsTable.outstanding,
    })
    .from(partyBillsTable)
    .innerJoin(partiesTable, eq(partyBillsTable.partyId, partiesTable.id))
    .where(
      and(
        eq(partyBillsTable.ownerId, input.ownerId),
        eq(partiesTable.entityId, input.entityId),
        eq(partyBillsTable.direction, "RECEIVABLE"),
        sql`${partyBillsTable.outstanding}::numeric > 0`,
        sql`${partyBillsTable.billDate}::text <= ${to}`,
      ),
    )
    .orderBy(asc(partyBillsTable.billDate));

  return {
    key: "FINANCIER",
    title: "Financier",
    compares: "disbursements expected against disbursements received",
    ran: true,
    clean: outstanding.length === 0,
    rows: outstanding.map((o) => ({
      ref: o.billNo,
      detail: `${o.billDate} — ${o.partyName}, still unpaid; if a financier agreed to this one, chase them`,
      amount: n(o.outstanding),
    })),
    total: round2(outstanding.reduce((a, o) => a + n(o.outstanding), 0)),
    note:
      `${n(received[0]?.count)} disbursement(s) worth ₹${round2(n(received[0]?.total)).toLocaleString("en-IN")} arrived this month. ` +
      "DDMS does not hold which bookings a financier committed to, so this lists what is unpaid rather than what is late — " +
      "narrowing it needs the financier's own sanction list, which is not in the product yet.",
  };
}

/** 7 — the manufacturer, both ways: what we owe and what they owe. */
export async function reconcileOem(input: ReconcileInput): Promise<Reconciliation> {
  const { from, to } = monthRange(input.period);

  const owed = await db
    .select({
      billNo: partyBillsTable.billNo,
      billDate: partyBillsTable.billDate,
      partyName: partiesTable.name,
      outstanding: partyBillsTable.outstanding,
    })
    .from(partyBillsTable)
    .innerJoin(partiesTable, eq(partyBillsTable.partyId, partiesTable.id))
    .where(
      and(
        eq(partyBillsTable.ownerId, input.ownerId),
        eq(partiesTable.entityId, input.entityId),
        eq(partiesTable.kind, "OEM"),
        eq(partyBillsTable.direction, "PAYABLE"),
        sql`${partyBillsTable.outstanding}::numeric > 0`,
        sql`${partyBillsTable.billDate}::text <= ${to}`,
      ),
    );

  const claims = await warrantyClaimable({ ownerId: input.ownerId, from, to });

  /*
   * Both sides, never netted. An OEM we owe for stock and that owes us for
   * warranty has two balances, and a single figure would hide the unclaimed
   * half - which is exactly where a dealer's money quietly goes missing.
   */
  return {
    key: "OEM",
    title: "The manufacturer",
    compares: "what we owe them for stock against what they owe us for warranty and schemes",
    ran: true,
    clean: claims.rows.length === 0,
    rows: claims.rows.map((c) => ({
      ref: c.invoiceNo,
      detail: `${c.invoiceDate} — ${c.coverage.toLowerCase().replace(/_/g, " ")}: ${c.description}${c.registrationNo ? ` (${c.registrationNo})` : ""}, claimable and not yet claimed`,
      amount: c.value,
    })),
    total: claims.total,
    note:
      `We owe ₹${round2(owed.reduce((a, o) => a + n(o.outstanding), 0)).toLocaleString("en-IN")} across ${owed.length} invoice(s); ` +
      `they owe us ₹${claims.total.toLocaleString("en-IN")} in claims. ` +
      "The two are kept apart deliberately — netting them hides the unclaimed half, and warranty is where a dealer's money quietly goes missing.",
  };
}

/** 8 — GSTR-1 against the sales register against the books. */
export async function reconcileGstr1(input: ReconcileInput): Promise<Reconciliation> {
  if (!input.registrationId)
    return empty(
      "GSTR1",
      "GSTR-1 against the books",
      "the return against the sales register against the ledger",
      "A return is filed per GSTIN, so this needs a registration rather than a company.",
    );

  const heads = await returnAgainstBooks({
    ownerId: input.ownerId,
    registrationId: input.registrationId,
    period: input.period,
  });

  return {
    key: "GSTR1",
    title: "GSTR-1 against the books",
    compares: "what the return reports against what the ledger holds, tax head by tax head",
    ran: true,
    clean: heads.agrees,
    rows: heads.heads
      .filter((h) => h.difference !== 0)
      .map((h) => ({
        ref: h.head,
        detail: `return ₹${h.return.toFixed(2)} against books ₹${h.books.toFixed(2)}`,
        amount: h.difference,
      })),
    total: round2(heads.heads.reduce((a, h) => a + Math.abs(h.difference), 0)),
    note: heads.agrees
      ? null
      : "Head by head, because two errors of opposite sign in CGST and SGST net to zero and are individually wrong.",
  };
}

/** 9 — GSTR-3B against GSTR-1 and the ledger, including the tax actually paid. */
export async function reconcileGstr3b(input: ReconcileInput): Promise<Reconciliation> {
  if (!input.registrationId)
    return empty(
      "GSTR3B",
      "GSTR-3B against GSTR-1",
      "the summary against the invoice-wise return",
      "A return is filed per GSTIN.",
    );

  const heads = await returnAgainstBooks({
    ownerId: input.ownerId,
    registrationId: input.registrationId,
    period: input.period,
  });

  /*
   * The department compares 3B against 1 automatically and issues a notice on a
   * difference, so this is the last chance to find one first. Both are drawn
   * from the same ledger here, which means this check confirms the *arithmetic*
   * rather than the sources - and it says so, because a check that overstates
   * its own reach is worse than one that admits its limit.
   */
  const branchIds = await branchesOfRegistration(input.registrationId);
  const { from, to } = monthRange(input.period);
  const paid = branchIds.length
    ? await db
        .select({
          total: sql<string>`coalesce(sum(${voucherLinesTable.debit}::numeric), 0)`,
        })
        .from(voucherLinesTable)
        .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
        .where(
          and(
            eq(vouchersTable.ownerId, input.ownerId),
            eq(vouchersTable.status, "POSTED"),
            inArray(vouchersTable.showroomId, branchIds),
            inArray(voucherLinesTable.accountCode, ["2200", "2210", "2220"]),
            sql`${vouchersTable.voucherDate}::text >= ${from}`,
            sql`${vouchersTable.voucherDate}::text <= ${to}`,
          ),
        )
    : [];

  return {
    key: "GSTR3B",
    title: "GSTR-3B against GSTR-1",
    compares: "the summary against the invoice-wise return, and against the tax actually paid",
    ran: true,
    clean: heads.agrees,
    rows: heads.heads
      .filter((h) => h.difference !== 0)
      .map((h) => ({ ref: h.head, detail: "summary and detail disagree", amount: h.difference })),
    total: 0,
    note:
      `₹${round2(n(paid[0]?.total)).toLocaleString("en-IN")} was debited to the output tax heads this month, which is ` +
      "what a payment against the return looks like in the books. Both sides of this check are drawn from the same " +
      "ledger, so it confirms the arithmetic rather than the sources — the sources diverge only once a return is " +
      "filed from somewhere other than these books.",
  };
}

/** 10 — GSTR-2B against the purchase register. */
export async function reconcileGstr2b(input: ReconcileInput): Promise<Reconciliation> {
  const { from, to } = monthRange(input.period);
  const risk = await inputCreditAtRisk({ ownerId: input.ownerId, from, to });

  return {
    key: "GSTR2B",
    title: "GSTR-2B against purchases",
    compares: "input credit our books claim against input credit the portal shows",
    ran: true,
    clean: risk.rows.length === 0,
    rows: risk.rows.map((r) => ({
      ref: r.supplierInvoiceNo,
      detail: `${r.invoiceDate} — ${r.status === "MISSING" ? "not in 2B; the supplier has not filed" : "not yet checked against 2B"}`,
      amount: r.credit,
    })),
    total: risk.total,
    note:
      risk.rows.length === 0
        ? null
        : "**In our books and not in 2B is credit at risk**, and it is worth chasing before the deadline rather than after. " +
          "Nothing imports 2B yet, so these are unchecked rather than confirmed missing — the distinction matters and the row says which.",
  };
}

/** All ten, in the order they are grouped. */
export async function reconcileAll(input: ReconcileInput): Promise<{
  reconciliations: Reconciliation[];
  ran: number;
  clean: number;
  needsAttention: Reconciliation[];
}> {
  const all = await Promise.all([
    reconcileInterBranch(input),
    reconcileStock(input),
    reconcileDebtors(input),
    reconcileDayClose(input),
    reconcileBank(input),
    reconcileFinancier(input),
    reconcileOem(input),
    reconcileGstr1(input),
    reconcileGstr3b(input),
    reconcileGstr2b(input),
  ]);

  return {
    reconciliations: all,
    ran: all.filter((r) => r.ran).length,
    clean: all.filter((r) => r.ran && r.clean).length,
    needsAttention: all.filter((r) => !r.ran || !r.clean),
  };
}

/**
 * The eleventh, which is a product decision rather than an accounting one
 * (R-115, R-98).
 *
 * DDMS becomes the book of record only once its numbers have reconciled against
 * whatever the dealership already keeps, for an agreed period. That needs a
 * scorecard — month by month, the figures ours produces against theirs, with
 * the difference and its cause — and **N consecutive months inside tolerance
 * before the product offers to graduate.**
 *
 * OBJ-26's ladder applied to a product decision, with the dealership's consent
 * as the thing that authorises. The product never graduates itself: it earns
 * the right to *ask*.
 */
export interface GraduationMonth {
  period: string;
  ours: number;
  theirs: number | null;
  difference: number | null;
  withinTolerance: boolean | null;
  note: string;
}

export const GRADUATION_MONTHS_REQUIRED = 3;
export const GRADUATION_TOLERANCE_PCT = 0.5;

export async function graduationScorecard(input: {
  ownerId: number;
  entityId: number;
  registrationId?: number | null;
  /** Newest month last. `["2026-08", "2026-09", "2026-10"]`. */
  periods: string[];
}): Promise<{
  months: GraduationMonth[];
  consecutiveClean: number;
  required: number;
  mayOffer: boolean;
  statement: string;
}> {
  const branchIds = await branchesOfEntity(input.entityId);
  const months: GraduationMonth[] = [];

  for (const period of input.periods) {
    const { from, to } = monthRange(period);

    const ours = branchIds.length
      ? await db
          .select({
            total: sql<string>`coalesce(sum(${voucherLinesTable.credit}::numeric - ${voucherLinesTable.debit}::numeric), 0)`,
          })
          .from(voucherLinesTable)
          .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
          .where(
            and(
              eq(vouchersTable.ownerId, input.ownerId),
              eq(vouchersTable.status, "POSTED"),
              inArray(vouchersTable.showroomId, branchIds),
              inArray(voucherLinesTable.accountCode, ["4100", "4200", "4300", "4400"]),
              sql`${vouchersTable.voucherDate}::text >= ${from}`,
              sql`${vouchersTable.voucherDate}::text <= ${to}`,
            ),
          )
      : [];

    /*
     * Their figure is **null** and not zero, and the difference matters more
     * than it looks: zero would compare as a hundred per cent variance and
     * report the month as failed, and a dealership would conclude the product
     * disagrees with its own books when in fact nobody has typed theirs in yet.
     * Nothing imports the dealership's existing system, so this is the honest
     * shape until something does.
     */
    months.push({
      period,
      ours: round2(n(ours[0]?.total)),
      theirs: null,
      difference: null,
      withinTolerance: null,
      note: "Nothing has been entered from the dealership's existing system for this month, so there is nothing to compare against.",
    });
  }

  let consecutive = 0;
  for (let i = months.length - 1; i >= 0; i--) {
    if (months[i]!.withinTolerance === true) consecutive++;
    else break;
  }

  return {
    months,
    consecutiveClean: consecutive,
    required: GRADUATION_MONTHS_REQUIRED,
    mayOffer: consecutive >= GRADUATION_MONTHS_REQUIRED,
    statement:
      consecutive >= GRADUATION_MONTHS_REQUIRED
        ? `${consecutive} consecutive months inside ${GRADUATION_TOLERANCE_PCT}%. The product may now **ask** whether it should become the book of record — it does not decide.`
        : `${consecutive} of ${GRADUATION_MONTHS_REQUIRED} consecutive months inside tolerance. Until then DDMS runs alongside whatever the dealership keeps, and says so. ` +
          "The book of record is earned by reconciling, not claimed (R-115).",
  };
}
