/**
 * The books a chartered accountant opens (OBJ-41, R-120).
 *
 * Nothing here is stored. Every report in this file is **derived from the
 * vouchers**, every time, which is the opposite posture from the vouchers
 * themselves and is right for the same reason: a voucher is a statement about a
 * moment and must never change, and a report is a view of those statements and
 * must never disagree with them. A cached trial balance is a trial balance that
 * is wrong for however long it takes somebody to notice.
 *
 * ## The trial balance is the point of this objective
 *
 * It is the cheapest possible proof that the double entry is complete. Three
 * objectives of purchases, transfers and money either add up or they do not,
 * and finding a hole here costs far less than finding it after the returns and
 * the reconciliations have been built on top of it.
 *
 * ## Every report states the level it was drawn at (R-120)
 *
 * ```
 *   entity        trial balance, profit & loss, balance sheet
 *   registration  the returns (OBJ-44)
 *   branch        day book, cash book, branch P&L
 * ```
 *
 * A figure whose scope is ambiguous is a figure somebody will eventually add to
 * another one. So `scope` comes back on the report rather than being something
 * the caller has to remember it asked for.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  vouchersTable,
  voucherLinesTable,
  ledgerAccountsTable,
  legalEntitiesTable,
  showroomsTable,
  type LedgerAccountRow,
} from "@workspace/db";

import { branchesOfEntity } from "../org";
import { financialYearOf } from "./post";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
/** Paise as integers, because summing rupees as floats is not addition. */
const paise = (x: number): number => Math.round(x * 100);

export type AccountGroup = LedgerAccountRow["group"];

export interface ReportScope {
  level: "ENTITY" | "REGISTRATION" | "BRANCH";
  id: number;
  label: string;
  from: string;
  to: string;
}

/** Which branches a report covers, and what to call the level it was drawn at. */
async function scopeFor(input: {
  ownerId: number;
  entityId?: number;
  showroomId?: number;
  from: string;
  to: string;
}): Promise<{ scope: ReportScope; branchIds: number[] }> {
  if (input.showroomId) {
    const [b] = await db
      .select({ id: showroomsTable.id, name: showroomsTable.name })
      .from(showroomsTable)
      .where(eq(showroomsTable.id, input.showroomId));
    if (!b) throw new Error(`No branch ${input.showroomId}`);
    return {
      scope: { level: "BRANCH", id: b.id, label: b.name, from: input.from, to: input.to },
      branchIds: [b.id],
    };
  }
  if (input.entityId) {
    const [e] = await db
      .select({ id: legalEntitiesTable.id, legalName: legalEntitiesTable.legalName })
      .from(legalEntitiesTable)
      .where(eq(legalEntitiesTable.id, input.entityId));
    if (!e) throw new Error(`No legal entity ${input.entityId}`);
    const branchIds = await branchesOfEntity(e.id);
    return {
      scope: { level: "ENTITY", id: e.id, label: e.legalName, from: input.from, to: input.to },
      branchIds,
    };
  }
  throw new Error(
    "A report has to be drawn at a level. An entity for the books, a branch for the till — " +
      "a figure with no scope is a figure somebody will add to another one.",
  );
}

export interface DayBookRow {
  voucherId: number;
  voucherNo: string;
  voucherDate: string;
  kind: string;
  narration: string | null;
  showroomId: number;
  totalDebit: number;
  totalCredit: number;
  status: string;
  lines: Array<{
    accountCode: string;
    accountName: string;
    debit: number;
    credit: number;
    partyName: string | null;
    narration: string | null;
  }>;
}

/**
 * Every voucher in date order, with its lines. The auditor's entry point.
 *
 * Reversed vouchers are **included**, marked. A day book that hid them would be
 * hiding exactly the entries an auditor came to look at — the whole reason
 * DDMS reverses rather than edits is so that the correction is visible, and a
 * report that then hid the correction would give that back.
 */
export async function dayBook(input: {
  ownerId: number;
  entityId?: number;
  showroomId?: number;
  from: string;
  to: string;
}): Promise<{ scope: ReportScope; rows: DayBookRow[] }> {
  const { scope, branchIds } = await scopeFor(input);
  if (branchIds.length === 0) return { scope, rows: [] };

  const vouchers = await db
    .select()
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        inArray(vouchersTable.showroomId, branchIds),
        sql`${vouchersTable.voucherDate}::text >= ${input.from}`,
        sql`${vouchersTable.voucherDate}::text <= ${input.to}`,
      ),
    )
    .orderBy(asc(vouchersTable.voucherDate), asc(vouchersTable.id));

  if (vouchers.length === 0) return { scope, rows: [] };

  const lines = await db
    .select()
    .from(voucherLinesTable)
    .where(
      inArray(
        voucherLinesTable.voucherId,
        vouchers.map((v) => v.id),
      ),
    )
    .orderBy(asc(voucherLinesTable.voucherId), asc(voucherLinesTable.seq));

  const byVoucher = new Map<number, typeof lines>();
  for (const l of lines) {
    const list = byVoucher.get(l.voucherId) ?? [];
    list.push(l);
    byVoucher.set(l.voucherId, list);
  }

  return {
    scope,
    rows: vouchers.map((v) => ({
      voucherId: v.id,
      voucherNo: v.voucherNo,
      voucherDate: v.voucherDate,
      kind: v.kind,
      narration: v.narration,
      showroomId: v.showroomId,
      totalDebit: n(v.totalDebit),
      totalCredit: n(v.totalCredit),
      status: v.status,
      lines: (byVoucher.get(v.id) ?? []).map((l) => ({
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: n(l.debit),
        credit: n(l.credit),
        partyName: l.partyName,
        narration: l.narration,
      })),
    })),
  };
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  group: AccountGroup;
  openingDebit: number;
  openingCredit: number;
  debit: number;
  credit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalance {
  scope: ReportScope;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** The whole point. Compared in paise, because floats do not add. */
  balances: boolean;
  difference: number;
}

/**
 * The trial balance, and it either balances or this objective failed.
 *
 * Opening figures are movement **before** the from-date, which is what makes
 * this readable for a month rather than only from inception. An account is
 * shown on one side, not both: a net debit is a debit, and printing 92,400
 * against 92,400 on the same row is how a reader loses ten minutes to a row
 * that means zero.
 *
 * **Reversed vouchers are excluded.** A reversal posts its own mirroring
 * voucher, so including the original as well would count the correction twice
 * and leave a balanced-but-doubled statement, which is worse than an
 * unbalanced one because it looks right.
 */
export async function trialBalance(input: {
  ownerId: number;
  entityId?: number;
  showroomId?: number;
  from: string;
  to: string;
}): Promise<TrialBalance> {
  const { scope, branchIds } = await scopeFor(input);

  const empty: TrialBalance = {
    scope,
    rows: [],
    totalDebit: 0,
    totalCredit: 0,
    balances: true,
    difference: 0,
  };
  if (branchIds.length === 0) return empty;

  const rows = await db
    .select({
      accountCode: voucherLinesTable.accountCode,
      accountName: voucherLinesTable.accountName,
      group: ledgerAccountsTable.group,
      voucherDate: vouchersTable.voucherDate,
      debit: voucherLinesTable.debit,
      credit: voucherLinesTable.credit,
    })
    .from(voucherLinesTable)
    .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .innerJoin(ledgerAccountsTable, eq(voucherLinesTable.accountId, ledgerAccountsTable.id))
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        eq(vouchersTable.status, "POSTED"),
        inArray(vouchersTable.showroomId, branchIds),
        sql`${vouchersTable.voucherDate}::text <= ${input.to}`,
      ),
    );

  interface Acc {
    accountName: string;
    group: AccountGroup;
    openingPaise: number;
    debitPaise: number;
    creditPaise: number;
  }
  const byAccount = new Map<string, Acc>();

  for (const r of rows) {
    let a = byAccount.get(r.accountCode);
    if (!a) {
      a = {
        accountName: r.accountName,
        group: r.group,
        openingPaise: 0,
        debitPaise: 0,
        creditPaise: 0,
      };
      byAccount.set(r.accountCode, a);
    }
    const d = paise(n(r.debit));
    const c = paise(n(r.credit));
    if (r.voucherDate < input.from) a.openingPaise += d - c;
    else {
      a.debitPaise += d;
      a.creditPaise += c;
    }
  }

  const out: TrialBalanceRow[] = [];
  let totalDebitPaise = 0;
  let totalCreditPaise = 0;

  for (const [code, a] of [...byAccount.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const closing = a.openingPaise + a.debitPaise - a.creditPaise;
    const row: TrialBalanceRow = {
      accountCode: code,
      accountName: a.accountName,
      group: a.group,
      openingDebit: a.openingPaise > 0 ? a.openingPaise / 100 : 0,
      openingCredit: a.openingPaise < 0 ? -a.openingPaise / 100 : 0,
      debit: a.debitPaise / 100,
      credit: a.creditPaise / 100,
      closingDebit: closing > 0 ? closing / 100 : 0,
      closingCredit: closing < 0 ? -closing / 100 : 0,
    };
    // An account that never moved and closes at zero is noise on a page a
    // person is reading line by line.
    if (a.openingPaise === 0 && a.debitPaise === 0 && a.creditPaise === 0) continue;
    out.push(row);
    if (closing > 0) totalDebitPaise += closing;
    else totalCreditPaise += -closing;
  }

  return {
    scope,
    rows: out,
    totalDebit: totalDebitPaise / 100,
    totalCredit: totalCreditPaise / 100,
    balances: totalDebitPaise === totalCreditPaise,
    difference: (totalDebitPaise - totalCreditPaise) / 100,
  };
}

export interface AccountLedgerRow {
  voucherId: number;
  voucherNo: string;
  voucherDate: string;
  kind: string;
  narration: string | null;
  partyName: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

/** One account's movement, with a running balance. */
export async function accountLedger(input: {
  ownerId: number;
  accountCode: string;
  entityId?: number;
  showroomId?: number;
  from: string;
  to: string;
}): Promise<{ scope: ReportScope; opening: number; rows: AccountLedgerRow[]; closing: number }> {
  const { scope, branchIds } = await scopeFor(input);
  if (branchIds.length === 0) return { scope, opening: 0, rows: [], closing: 0 };

  const all = await db
    .select({
      voucherId: vouchersTable.id,
      voucherNo: vouchersTable.voucherNo,
      voucherDate: vouchersTable.voucherDate,
      kind: vouchersTable.kind,
      narration: voucherLinesTable.narration,
      partyName: voucherLinesTable.partyName,
      debit: voucherLinesTable.debit,
      credit: voucherLinesTable.credit,
      seq: voucherLinesTable.seq,
    })
    .from(voucherLinesTable)
    .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        eq(vouchersTable.status, "POSTED"),
        inArray(vouchersTable.showroomId, branchIds),
        eq(voucherLinesTable.accountCode, input.accountCode),
        sql`${vouchersTable.voucherDate}::text <= ${input.to}`,
      ),
    )
    .orderBy(asc(vouchersTable.voucherDate), asc(vouchersTable.id), asc(voucherLinesTable.seq));

  let openingPaise = 0;
  const rows: AccountLedgerRow[] = [];
  let runningPaise = 0;

  for (const r of all) {
    const delta = paise(n(r.debit)) - paise(n(r.credit));
    if (r.voucherDate < input.from) {
      openingPaise += delta;
      continue;
    }
    if (rows.length === 0) runningPaise = openingPaise;
    runningPaise += delta;
    rows.push({
      voucherId: r.voucherId,
      voucherNo: r.voucherNo,
      voucherDate: r.voucherDate,
      kind: r.kind,
      narration: r.narration,
      partyName: r.partyName,
      debit: n(r.debit),
      credit: n(r.credit),
      runningBalance: runningPaise / 100,
    });
  }

  return {
    scope,
    opening: openingPaise / 100,
    rows,
    closing: (rows.length ? runningPaise : openingPaise) / 100,
  };
}

export interface ProfitAndLoss {
  scope: ReportScope;
  income: Array<{ accountCode: string; accountName: string; amount: number }>;
  expenses: Array<{ accountCode: string; accountName: string; amount: number }>;
  totalIncome: number;
  totalExpenses: number;
  profit: number;
}

/**
 * Profit and loss, consolidated or per branch.
 *
 * Branches are profit centres, which is the whole reason `showroomId` is an
 * option here and is deliberately **not** an option on the balance sheet
 * below: a branch earns and spends, and it does not own anything. Offering a
 * branch balance sheet would offer a statement whose assets belong to a company
 * and whose total means nothing.
 */
export async function profitAndLoss(input: {
  ownerId: number;
  entityId?: number;
  showroomId?: number;
  from: string;
  to: string;
}): Promise<ProfitAndLoss> {
  const tb = await trialBalance(input);

  const income = tb.rows
    .filter((r) => r.group === "INCOME")
    .map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      // Income is a credit balance, so it reads positive when it is a credit.
      amount: round2(r.credit - r.debit),
    }))
    .filter((r) => r.amount !== 0);

  const expenses = tb.rows
    .filter((r) => r.group === "EXPENSE")
    .map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      amount: round2(r.debit - r.credit),
    }))
    .filter((r) => r.amount !== 0);

  const totalIncome = round2(income.reduce((a, r) => a + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((a, r) => a + r.amount, 0));

  return {
    scope: tb.scope,
    income,
    expenses,
    totalIncome,
    totalExpenses,
    profit: round2(totalIncome - totalExpenses),
  };
}

export interface BalanceSheet {
  scope: ReportScope;
  assets: Array<{ accountCode: string; accountName: string; amount: number }>;
  liabilities: Array<{ accountCode: string; accountName: string; amount: number }>;
  equity: Array<{ accountCode: string; accountName: string; amount: number }>;
  /** Profit for the period, carried in. Without it nothing balances. */
  profitForPeriod: number;
  totalAssets: number;
  totalLiabilitiesAndEquity: number;
  balances: boolean;
  difference: number;
}

/**
 * The balance sheet, per entity only.
 *
 * **A branch has no balance sheet.** It holds stock and a till on behalf of a
 * company that owns them, and a statement whose assets belong to somebody else
 * is not a statement. Passing a branch here is refused rather than quietly
 * producing something that adds up and means nothing.
 *
 * The period's profit is carried into equity, which is what makes it balance:
 * income and expense accounts are not on a balance sheet, and the difference
 * they leave *is* the profit. A balance sheet that did not carry it would be
 * out by exactly the profit, every time, and somebody would eventually "fix"
 * it with a plug.
 */
export async function balanceSheet(input: {
  ownerId: number;
  entityId: number;
  from: string;
  to: string;
}): Promise<BalanceSheet> {
  const tb = await trialBalance({ ownerId: input.ownerId, entityId: input.entityId, from: input.from, to: input.to });
  const pl = await profitAndLoss({ ownerId: input.ownerId, entityId: input.entityId, from: input.from, to: input.to });

  const side = (group: AccountGroup, debitPositive: boolean) =>
    tb.rows
      .filter((r) => r.group === group)
      .map((r) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        amount: debitPositive
          ? round2(r.closingDebit - r.closingCredit)
          : round2(r.closingCredit - r.closingDebit),
      }))
      .filter((r) => r.amount !== 0);

  const assets = side("ASSET", true);
  const liabilities = side("LIABILITY", false);
  const equity = side("EQUITY", false);

  const totalAssetsPaise = assets.reduce((a, r) => a + paise(r.amount), 0);
  const totalOtherPaise =
    liabilities.reduce((a, r) => a + paise(r.amount), 0) +
    equity.reduce((a, r) => a + paise(r.amount), 0) +
    paise(pl.profit);

  return {
    scope: tb.scope,
    assets,
    liabilities,
    equity,
    profitForPeriod: pl.profit,
    totalAssets: totalAssetsPaise / 100,
    totalLiabilitiesAndEquity: totalOtherPaise / 100,
    balances: totalAssetsPaise === totalOtherPaise,
    difference: (totalAssetsPaise - totalOtherPaise) / 100,
  };
}

/**
 * The sales register, invoice-wise with the tax split.
 *
 * What GSTR-1 is checked against, and what a dealership prints when the
 * department asks. Drawn from the ledger rather than from `sale_documents`
 * deliberately: the eighth reconciliation compares the return, the register and
 * the books, and a register that read the same table as the return would make
 * two of those three the same source pretending to be two.
 */
export async function salesRegister(input: {
  ownerId: number;
  entityId?: number;
  showroomId?: number;
  from: string;
  to: string;
}): Promise<{
  scope: ReportScope;
  rows: Array<{
    voucherNo: string;
    voucherDate: string;
    partyName: string | null;
    partyGstin: string | null;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    cess: number;
    total: number;
  }>;
  totals: { taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number };
}> {
  const { scope, branchIds } = await scopeFor(input);
  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 };
  if (branchIds.length === 0) return { scope, rows: [], totals };

  const lines = await db
    .select({
      voucherId: vouchersTable.id,
      voucherNo: vouchersTable.voucherNo,
      voucherDate: vouchersTable.voucherDate,
      accountCode: voucherLinesTable.accountCode,
      debit: voucherLinesTable.debit,
      credit: voucherLinesTable.credit,
      partyName: voucherLinesTable.partyName,
      partyGstin: voucherLinesTable.partyGstin,
    })
    .from(voucherLinesTable)
    .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        eq(vouchersTable.status, "POSTED"),
        eq(vouchersTable.kind, "SALES"),
        inArray(vouchersTable.showroomId, branchIds),
        sql`${vouchersTable.voucherDate}::text >= ${input.from}`,
        sql`${vouchersTable.voucherDate}::text <= ${input.to}`,
      ),
    )
    .orderBy(asc(vouchersTable.voucherDate), asc(vouchersTable.id), asc(voucherLinesTable.seq));

  const byVoucher = new Map<
    number,
    {
      voucherNo: string;
      voucherDate: string;
      partyName: string | null;
      partyGstin: string | null;
      taxable: number;
      cgst: number;
      sgst: number;
      igst: number;
      cess: number;
      total: number;
    }
  >();

  for (const l of lines) {
    let row = byVoucher.get(l.voucherId);
    if (!row) {
      row = {
        voucherNo: l.voucherNo,
        voucherDate: l.voucherDate,
        partyName: null,
        partyGstin: null,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        cess: 0,
        total: 0,
      };
      byVoucher.set(l.voucherId, row);
    }
    const credit = n(l.credit);
    if (l.accountCode === "4100" || l.accountCode === "4200" || l.accountCode === "4300")
      row.taxable = round2(row.taxable + credit);
    else if (l.accountCode === "2200") row.cgst = round2(row.cgst + credit);
    else if (l.accountCode === "2210") row.sgst = round2(row.sgst + credit);
    else if (l.accountCode === "2220") row.igst = round2(row.igst + credit);
    else if (l.accountCode === "2230") row.cess = round2(row.cess + credit);
    else if (l.accountCode === "1100") {
      row.total = round2(row.total + n(l.debit));
      if (l.partyName) row.partyName = l.partyName;
      if (l.partyGstin) row.partyGstin = l.partyGstin;
    }
  }

  const rows = [...byVoucher.values()];
  for (const r of rows) {
    totals.taxable = round2(totals.taxable + r.taxable);
    totals.cgst = round2(totals.cgst + r.cgst);
    totals.sgst = round2(totals.sgst + r.sgst);
    totals.igst = round2(totals.igst + r.igst);
    totals.cess = round2(totals.cess + r.cess);
    totals.total = round2(totals.total + r.total);
  }

  return { scope, rows, totals };
}

/**
 * The voucher numbering gap report.
 *
 * A gapless series is a statutory expectation and a hole in one is an audit
 * finding — so is a duplicate. This looks for both, per kind per financial
 * year, and reports the **numbers** rather than a count, because "three
 * missing" sends somebody hunting and "17, 18 and 41" sends them to three
 * vouchers.
 */
export async function numberingGaps(input: {
  ownerId: number;
  financialYear?: string;
  onDate?: string;
}): Promise<
  Array<{ kind: string; financialYear: string; issued: number; missing: number[]; duplicates: number[] }>
> {
  const fy = input.financialYear ?? financialYearOf(input.onDate ?? new Date().toISOString().slice(0, 10));

  const rows = await db
    .select({
      kind: vouchersTable.kind,
      financialYear: vouchersTable.financialYear,
      voucherNo: vouchersTable.voucherNo,
    })
    .from(vouchersTable)
    .where(
      and(eq(vouchersTable.ownerId, input.ownerId), eq(vouchersTable.financialYear, fy)),
    );

  const byKind = new Map<string, number[]>();
  for (const r of rows) {
    const num = Number(r.voucherNo.replace(/\D/g, ""));
    if (!Number.isFinite(num)) continue;
    const list = byKind.get(r.kind) ?? [];
    list.push(num);
    byKind.set(r.kind, list);
  }

  const out: Array<{
    kind: string;
    financialYear: string;
    issued: number;
    missing: number[];
    duplicates: number[];
  }> = [];

  for (const [kind, nums] of byKind) {
    const sorted = [...nums].sort((a, b) => a - b);
    const seen = new Set<number>();
    const duplicates: number[] = [];
    for (const x of sorted) {
      if (seen.has(x)) duplicates.push(x);
      seen.add(x);
    }
    const missing: number[] = [];
    const highest = sorted[sorted.length - 1] ?? 0;
    for (let i = 1; i <= highest; i++) if (!seen.has(i)) missing.push(i);

    out.push({ kind, financialYear: fy, issued: sorted.length, missing, duplicates });
  }

  return out.sort((a, b) => a.kind.localeCompare(b.kind));
}
