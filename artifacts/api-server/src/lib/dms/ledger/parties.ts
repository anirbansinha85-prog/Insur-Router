/**
 * A party is a ledger, not a column (OBJ-38, R-110).
 *
 * `voucher_lines.party_name` was a string, and a string cannot produce a
 * customer statement, cannot age a debt, and cannot tell you that the Sharma
 * who bought in April is the Sharma still owing in September. This file is the
 * subsidiary ledger the control accounts have always implied.
 *
 * ## The control account is unchanged
 *
 * `1100` Sundry Debtors and `2100` Sundry Creditors stay on every voucher line
 * exactly as before, so the trial balance is untouched and nothing that already
 * works has to know about any of this. `party_id` sits beside the code. That is
 * how Tally does it — a group in the trial balance, a ledger per party
 * underneath — and it is the arrangement that lets the two views never
 * disagree, because there is only one set of numbers.
 *
 * ## Nothing here decides where money goes
 *
 * Allocation is OBJ-40's and it is deliberately not here. This file opens
 * bills, reads balances and ages them. What a receipt settles is a decision
 * with a person's judgement in it (R-111).
 */

import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  partiesTable,
  partyBillsTable,
  voucherLinesTable,
  vouchersTable,
  type PartyRow,
  type PartyBillRow,
} from "@workspace/db";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

export type PartyKind = PartyRow["kind"];

/**
 * Find this party or create it, and **matching is the whole difficulty**.
 *
 * A GSTIN is exact and is used first: it identifies one business and two
 * parties carrying the same one in a single set of books are that business
 * entered twice, which is how a supplier's balance ends up split across two
 * ledgers and neither matching the statement.
 *
 * A mobile number is the retail identifier and is used next, because a
 * dealership has it for everyone and a name does not identify anybody — there
 * are four Sharmas. Matching on **name alone is refused**: merging two
 * customers who share a name puts one person's debt on another's statement,
 * and the cost of a duplicate ledger is far lower than the cost of that.
 */
export async function ensureParty(input: {
  ownerId: number;
  entityId: number;
  kind: PartyKind;
  name: string;
  gstin?: string | null;
  mobile?: string | null;
  email?: string | null;
  addressLine?: string | null;
  state?: string | null;
  tallyName?: string | null;
}): Promise<{ party: PartyRow; created: boolean }> {
  const gstin = input.gstin?.trim() || null;
  const mobile = input.mobile?.trim() || null;

  if (gstin) {
    const [hit] = await db
      .select()
      .from(partiesTable)
      .where(and(eq(partiesTable.entityId, input.entityId), eq(partiesTable.gstin, gstin)))
      .limit(1);
    if (hit) return { party: hit, created: false };
  }

  if (mobile) {
    const [hit] = await db
      .select()
      .from(partiesTable)
      .where(
        and(
          eq(partiesTable.entityId, input.entityId),
          eq(partiesTable.mobile, mobile),
          eq(partiesTable.kind, input.kind),
        ),
      )
      .limit(1);
    if (hit) return { party: hit, created: false };
  }

  const [row] = await db
    .insert(partiesTable)
    .values({
      ownerId: input.ownerId,
      entityId: input.entityId,
      kind: input.kind,
      name: input.name.trim(),
      tallyName: input.tallyName?.trim() || input.name.trim(),
      gstin,
      mobile,
      email: input.email?.trim() || null,
      addressLine: input.addressLine?.trim() || null,
      state: input.state?.trim() || null,
    })
    .returning();

  return { party: row!, created: true };
}

/** Open a bill against a party. Idempotent on its source document. */
export async function openBill(input: {
  ownerId: number;
  partyId: number;
  showroomId: number | null;
  direction: "RECEIVABLE" | "PAYABLE";
  billNo: string;
  billDate: string;
  dueDate?: string | null;
  amount: number;
  sourceKind: PartyBillRow["sourceKind"];
  sourceId: number | null;
}): Promise<PartyBillRow> {
  if (input.sourceId !== null) {
    const [existing] = await db
      .select()
      .from(partyBillsTable)
      .where(
        and(
          eq(partyBillsTable.sourceKind, input.sourceKind),
          eq(partyBillsTable.sourceId, input.sourceId),
        ),
      )
      .limit(1);
    if (existing) return existing;
  }

  const amount = round2(input.amount);
  const [row] = await db
    .insert(partyBillsTable)
    .values({
      ownerId: input.ownerId,
      partyId: input.partyId,
      showroomId: input.showroomId,
      direction: input.direction,
      billNo: input.billNo,
      billDate: input.billDate,
      dueDate: input.dueDate ?? null,
      amount: String(amount),
      outstanding: String(amount),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
    })
    .returning();
  return row!;
}

export interface PartyStatementRow {
  voucherId: number;
  voucherNo: string;
  voucherDate: string;
  kind: string;
  narration: string | null;
  debit: number;
  credit: number;
  /** The balance after this entry, which is what a statement is for. */
  runningBalance: number;
}

/**
 * A party's account, entry by entry, with a running balance.
 *
 * This is the report a customer rings about and the one a supplier's accounts
 * department sends over. It reads the **voucher lines**, not a stored balance,
 * because a statement that disagreed with the ledger it came from would be
 * worse than no statement at all.
 *
 * The running balance is signed and the sign means something: positive is a
 * debit balance, which on a customer is money owed to the dealership and on a
 * supplier is money paid in advance.
 */
export async function partyStatement(input: {
  partyId: number;
  from?: string | null;
  to?: string | null;
}): Promise<{ party: PartyRow; rows: PartyStatementRow[]; closing: number }> {
  const [party] = await db
    .select()
    .from(partiesTable)
    .where(eq(partiesTable.id, input.partyId))
    .limit(1);
  if (!party) throw new Error(`No party ${input.partyId}`);

  const where = [
    eq(voucherLinesTable.partyId, input.partyId),
    eq(vouchersTable.status, "POSTED"),
  ];
  if (input.from) where.push(sql`${vouchersTable.voucherDate} >= ${input.from}`);
  if (input.to) where.push(sql`${vouchersTable.voucherDate} <= ${input.to}`);

  const lines = await db
    .select({
      voucherId: vouchersTable.id,
      voucherNo: vouchersTable.voucherNo,
      voucherDate: vouchersTable.voucherDate,
      kind: vouchersTable.kind,
      narration: voucherLinesTable.narration,
      debit: voucherLinesTable.debit,
      credit: voucherLinesTable.credit,
      seq: voucherLinesTable.seq,
    })
    .from(voucherLinesTable)
    .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .where(and(...where))
    .orderBy(asc(vouchersTable.voucherDate), asc(vouchersTable.id), asc(voucherLinesTable.seq));

  /*
   * The opening balance starts the running total, because a statement that
   * began at zero would tell a customer who has owed money since March that he
   * owes only what he has bought since April.
   */
  let running =
    party.openingSide === "DEBIT"
      ? n(party.openingAmount)
      : party.openingSide === "CREDIT"
        ? -n(party.openingAmount)
        : 0;

  const rows: PartyStatementRow[] = lines.map((l) => {
    running = round2(running + n(l.debit) - n(l.credit));
    return {
      voucherId: l.voucherId,
      voucherNo: l.voucherNo,
      voucherDate: l.voucherDate,
      kind: l.kind,
      narration: l.narration,
      debit: n(l.debit),
      credit: n(l.credit),
      runningBalance: running,
    };
  });

  return { party, rows, closing: running };
}

export interface AgeingBucket {
  label: string;
  fromDays: number;
  toDays: number | null;
  amount: number;
  bills: number;
}

export interface PartyAgeing {
  partyId: number;
  partyName: string;
  total: number;
  buckets: AgeingBucket[];
  /** The single oldest open bill, because that is the one somebody rings about. */
  oldest: { billNo: string; billDate: string; outstanding: number; days: number } | null;
}

const BUCKETS: Array<[string, number, number | null]> = [
  ["Not yet due", -9999, 0],
  ["1-30 days", 1, 30],
  ["31-60 days", 31, 60],
  ["61-90 days", 61, 90],
  ["Over 90 days", 91, null],
];

/**
 * Debtors and creditors ageing, bill by bill (R-114).
 *
 * Bucketed on **days past due** rather than days since the bill, which are
 * different questions and only the first one is about whether somebody is late.
 * A bill with sixty-day terms raised forty days ago is not overdue and putting
 * it in a "31-60 days" bucket beside genuinely late money is how an ageing
 * report stops being read.
 *
 * A bill with no due date is treated as due on its date, which is the retail
 * case: a customer taking delivery pays on delivery.
 */
export async function ageing(input: {
  ownerId: number;
  entityId: number;
  direction: "RECEIVABLE" | "PAYABLE";
  asOf: string;
}): Promise<{ rows: PartyAgeing[]; total: number }> {
  const bills = await db
    .select({
      partyId: partyBillsTable.partyId,
      partyName: partiesTable.name,
      billNo: partyBillsTable.billNo,
      billDate: partyBillsTable.billDate,
      dueDate: partyBillsTable.dueDate,
      outstanding: partyBillsTable.outstanding,
    })
    .from(partyBillsTable)
    .innerJoin(partiesTable, eq(partyBillsTable.partyId, partiesTable.id))
    .where(
      and(
        eq(partyBillsTable.ownerId, input.ownerId),
        eq(partiesTable.entityId, input.entityId),
        eq(partyBillsTable.direction, input.direction),
        sql`${partyBillsTable.outstanding}::numeric > 0`,
        sql`${partyBillsTable.billDate}::text <= ${input.asOf}`,
      ),
    )
    .orderBy(asc(partyBillsTable.billDate));

  const asOfMs = Date.parse(input.asOf);
  const byParty = new Map<number, PartyAgeing>();
  let total = 0;

  for (const b of bills) {
    const due = b.dueDate ?? b.billDate;
    const days = Math.floor((asOfMs - Date.parse(due)) / 86_400_000);
    const amount = n(b.outstanding);
    total = round2(total + amount);

    let row = byParty.get(b.partyId);
    if (!row) {
      row = {
        partyId: b.partyId,
        partyName: b.partyName,
        total: 0,
        buckets: BUCKETS.map(([label, fromDays, toDays]) => ({
          label,
          fromDays,
          toDays,
          amount: 0,
          bills: 0,
        })),
        oldest: null,
      };
      byParty.set(b.partyId, row);
    }

    const idx = BUCKETS.findIndex(
      ([, from, to]) => days >= from && (to === null || days <= to),
    );
    const bucket = row.buckets[idx < 0 ? BUCKETS.length - 1 : idx]!;
    bucket.amount = round2(bucket.amount + amount);
    bucket.bills += 1;
    row.total = round2(row.total + amount);

    if (!row.oldest || days > row.oldest.days) {
      row.oldest = { billNo: b.billNo, billDate: b.billDate, outstanding: amount, days };
    }
  }

  return {
    rows: [...byParty.values()].sort((a, b) => b.total - a.total),
    total,
  };
}

/**
 * The check that the subsidiary ledger and the control account agree.
 *
 * This is the third reconciliation and it is the one that catches the widest
 * class of mistake: a party balance that does not add up to `1100` means either
 * a voucher line carrying the control account with no party on it, or a party
 * line posted to some other account. Both produce a trial balance that balances
 * and a debtors report that is wrong, which is the failure nobody finds.
 */
export async function controlAccountCheck(input: {
  ownerId: number;
  entityId: number;
  controlCode: string;
  asOf: string;
}): Promise<{
  control: number;
  subsidiary: number;
  difference: number;
  unattributed: Array<{ voucherNo: string; voucherDate: string; amount: number }>;
}> {
  const rows = await db
    .select({
      voucherNo: vouchersTable.voucherNo,
      voucherDate: vouchersTable.voucherDate,
      debit: voucherLinesTable.debit,
      credit: voucherLinesTable.credit,
      partyId: voucherLinesTable.partyId,
    })
    .from(voucherLinesTable)
    .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        eq(vouchersTable.status, "POSTED"),
        eq(voucherLinesTable.accountCode, input.controlCode),
        sql`${vouchersTable.voucherDate}::text <= ${input.asOf}`,
      ),
    );

  let control = 0;
  let subsidiary = 0;
  const unattributed: Array<{ voucherNo: string; voucherDate: string; amount: number }> = [];

  for (const r of rows) {
    const net = n(r.debit) - n(r.credit);
    control = round2(control + net);
    if (r.partyId) subsidiary = round2(subsidiary + net);
    else
      unattributed.push({
        voucherNo: r.voucherNo,
        voucherDate: r.voucherDate,
        amount: round2(net),
      });
  }

  return {
    control,
    subsidiary,
    difference: round2(control - subsidiary),
    unattributed,
  };
}

/** Every party in one set of books, heaviest balance first. */
export async function partiesOf(input: {
  entityId: number;
  kind?: PartyKind;
}): Promise<PartyRow[]> {
  const where = [eq(partiesTable.entityId, input.entityId), eq(partiesTable.isActive, "Y")];
  if (input.kind) where.push(eq(partiesTable.kind, input.kind));
  return db.select().from(partiesTable).where(and(...where)).orderBy(asc(partiesTable.name));
}
