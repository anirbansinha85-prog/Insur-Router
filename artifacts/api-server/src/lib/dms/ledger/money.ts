/**
 * Money moving, and where it was meant to go (OBJ-40, R-111).
 *
 * The third of the four events, and the one that closes `1100` Sundry Debtors.
 * Before this, a customer who had paid in full still appeared to owe the whole
 * invoice, because nothing in the product could credit him.
 *
 * ## Allocation is somebody's judgement, and the product does not take it
 *
 * The obvious shortcut is to apply a receipt to the oldest open bill. It is a
 * guess about which debt the customer meant to settle, and a customer disputing
 * one invoice while paying another is an ordinary Tuesday. Applying his money
 * to the one he is disputing takes a side in his argument and then reports the
 * result as a fact.
 *
 * So there is exactly **one** case this decides on its own: a single open bill
 * whose outstanding equals the receipt exactly. Nothing to choose between and
 * no judgement to take. Everything else is on account until a person says.
 *
 * ## Advances, and the two of them are different entries
 *
 * A booking advance against a motorcycle attracts **no** GST — the liability
 * arises at the invoice. An advance against a service job attracts it at
 * receipt. A dealership takes both routinely, so the document says which, and
 * the entry follows.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  moneyDocumentsTable,
  billAllocationsTable,
  dayClosesTable,
  partyBillsTable,
  partiesTable,
  vouchersTable,
  voucherLinesTable,
  type MoneyDocumentRow,
  type DayCloseRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { accountsByCode, ensureChart } from "./accounts";
import { financialYearOf, nextVoucherNo, type Line } from "./post";
import { placementOf } from "../org";
import { taxWithin } from "../invoice/pricing";
import { LABOUR_GST_PCT } from "@workspace/quoting/tax";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const money = (v: number): string => v.toFixed(2);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

export type MoneyMode = MoneyDocumentRow["mode"];

/** Cash hits the till; everything else hits the bank. The day close reads this. */
function accountForMode(mode: MoneyMode): string {
  return mode === "CASH" ? "1400" : "1500";
}

async function nextMoneyNo(
  ownerId: number,
  direction: "RECEIPT" | "PAYMENT",
  onDate: string,
): Promise<string> {
  const fy = financialYearOf(onDate);
  const prefix = direction === "RECEIPT" ? "RCPT" : "PAYT";
  const [last] = await db
    .select({ no: moneyDocumentsTable.documentNo })
    .from(moneyDocumentsTable)
    .where(
      and(
        eq(moneyDocumentsTable.ownerId, ownerId),
        eq(moneyDocumentsTable.direction, direction),
        sql`${moneyDocumentsTable.documentNo} like ${`${prefix}/${fy}/%`}`,
      ),
    )
    .orderBy(
      sql`length(${moneyDocumentsTable.documentNo}) desc`,
      sql`${moneyDocumentsTable.documentNo} desc`,
    )
    .limit(1);

  const next = last ? Number(last.no.split("/").pop()) + 1 : 1;
  return `${prefix}/${fy}/${String(next).padStart(4, "0")}`;
}

export interface AllocationInput {
  partyBillId: number;
  amount: number;
}

export interface MoneyResult {
  ok: boolean;
  document?: MoneyDocumentRow;
  voucherId?: number;
  error?: string;
  warnings: string[];
}

/**
 * Record money in or money out, and post it.
 *
 * Allocations may be supplied here or later. Supplying none is not an error and
 * not a warning to be suppressed — it is the *on account* state, which a person
 * resolves when they know which bill it was for.
 */
export async function recordMoney(input: {
  ownerId: number;
  showroomId: number;
  direction: "RECEIPT" | "PAYMENT";
  partyId: number;
  documentDate: string;
  mode: MoneyMode;
  amount: number;
  instrumentRef?: string | null;
  instrumentDate?: string | null;
  bankName?: string | null;
  /** GOODS attracts no tax on an advance; SERVICE does. */
  advanceFor?: "GOODS" | "SERVICE" | "NONE";
  allocations?: AllocationInput[];
  narration?: string | null;
  userId?: number | null;
}): Promise<MoneyResult> {
  const warnings: string[] = [];
  const amount = round2(input.amount);

  if (!(amount > 0)) {
    return {
      ok: false,
      error: "Money moved has to be a positive amount. Undoing a receipt is a reversal, not a negative one.",
      warnings,
    };
  }

  const placement = await placementOf(input.showroomId);
  if (placement.entity.booksFrom && input.documentDate < placement.entity.booksFrom) {
    return {
      ok: false,
      error:
        `${input.documentDate} is before these books start on ${placement.entity.booksFrom}. ` +
        "Anything earlier belongs in the opening balances.",
      warnings,
    };
  }

  const [party] = await db
    .select()
    .from(partiesTable)
    .where(and(eq(partiesTable.ownerId, input.ownerId), eq(partiesTable.id, input.partyId)));
  if (!party) return { ok: false, error: `No party ${input.partyId}`, warnings };

  const direction = input.direction;
  const billDirection = direction === "RECEIPT" ? "RECEIVABLE" : "PAYABLE";

  /*
   * The one allocation with no judgement in it.
   *
   * Exactly one open bill, outstanding equal to the amount to the paisa. There
   * is nothing to choose between, so choosing is not a decision. Anything else -
   * two bills, or one bill for a different amount - stays on account, because
   * "probably this one" is the guess this rule exists to refuse.
   */
  let allocations = input.allocations ?? [];
  let decidedBy: "PERSON" | "AUTOMATIC" = "PERSON";

  if (allocations.length === 0) {
    const open = await db
      .select()
      .from(partyBillsTable)
      .where(
        and(
          eq(partyBillsTable.partyId, input.partyId),
          eq(partyBillsTable.direction, billDirection),
          sql`${partyBillsTable.outstanding}::numeric > 0`,
        ),
      );
    if (open.length === 1 && round2(n(open[0]!.outstanding)) === amount) {
      allocations = [{ partyBillId: open[0]!.id, amount }];
      decidedBy = "AUTOMATIC";
    } else if (open.length > 0) {
      warnings.push(
        `This is on account against ${party.name}. There ${open.length === 1 ? "is" : "are"} ${open.length} open bill(s) ` +
          `and the amount does not settle ${open.length === 1 ? "it" : "any one of them"} exactly, so nothing has been applied. ` +
          "Which bill this pays is the customer's decision, not ours.",
      );
    }
  }

  const allocated = round2(allocations.reduce((a, x) => a + x.amount, 0));
  if (allocated > amount + 0.005) {
    return {
      ok: false,
      error: `₹${allocated.toFixed(2)} has been allocated out of ₹${amount.toFixed(2)}. Money cannot settle more than it is.`,
      warnings,
    };
  }
  const unallocated = round2(amount - allocated);

  await ensureChart(input.ownerId);
  const accounts = await accountsByCode(input.ownerId);
  const need = (code: string) => {
    const a = accounts.get(code);
    if (!a) throw new Error(`The ledger account ${code} is missing for this dealership.`);
    return a;
  };

  const documentNo = await nextMoneyNo(input.ownerId, direction, input.documentDate);
  const cashCode = accountForMode(input.mode);
  const controlCode = direction === "RECEIPT" ? "1100" : "2100";
  const partyRef = { partyId: party.id, partyName: party.name, partyGstin: party.gstin };

  const lines: Line[] = [];

  if (direction === "RECEIPT") {
    lines.push({
      accountCode: cashCode,
      debit: amount,
      credit: 0,
      narration: `${input.mode} from ${party.name}`,
    });

    if (allocated > 0) {
      lines.push({
        accountCode: controlCode,
        debit: 0,
        credit: allocated,
        narration: "Against bill(s)",
        ...partyRef,
      });
    }

    if (unallocated > 0) {
      /*
       * An advance is a **liability**, not revenue and not a reduction of a
       * debt that does not exist yet. Money taken for something not yet
       * delivered is money the dealership would have to give back.
       */
      if (input.advanceFor === "SERVICE") {
        /*
         * And an advance for a service carries tax at receipt, unlike one for
         * goods. The amount taken is inclusive - a customer handing over two
         * thousand rupees has handed over two thousand - so the tax comes out
         * of it by the same back-calculation an ex-showroom price uses.
         */
        const tax = taxWithin({
          inclusive: unallocated,
          gstRatePct: LABOUR_GST_PCT,
          cessRatePct: 0,
          interState: false,
        });
        lines.push({
          accountCode: "2400",
          debit: 0,
          credit: tax.taxable,
          narration: "Advance against a service job",
          ...partyRef,
        });
        if (tax.cgst > 0) lines.push({ accountCode: "2200", debit: 0, credit: tax.cgst });
        if (tax.sgst > 0) lines.push({ accountCode: "2210", debit: 0, credit: tax.sgst });
        warnings.push(
          `GST of ₹${round2(tax.cgst + tax.sgst).toFixed(2)} has been charged on this advance, because it is against a service job. An advance on a motorcycle would carry none — the liability there arises at the invoice.`,
        );
      } else {
        lines.push({
          accountCode: "2400",
          debit: 0,
          credit: unallocated,
          narration:
            input.advanceFor === "GOODS"
              ? "Booking advance — no GST until the invoice"
              : "On account",
          ...partyRef,
        });
      }
    }
  } else {
    lines.push({
      accountCode: cashCode,
      debit: 0,
      credit: amount,
      narration: `${input.mode} to ${party.name}`,
    });
    if (allocated > 0) {
      lines.push({
        accountCode: controlCode,
        debit: allocated,
        credit: 0,
        narration: "Against bill(s)",
        ...partyRef,
      });
    }
    if (unallocated > 0) {
      lines.push({
        accountCode: controlCode,
        debit: unallocated,
        credit: 0,
        narration: "On account — paid in advance of a bill",
        ...partyRef,
      });
    }
  }

  const totalDebit = round2(lines.reduce((a, l) => a + l.debit, 0));
  const totalCredit = round2(lines.reduce((a, l) => a + l.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    return {
      ok: false,
      error: `This does not balance: ₹${totalDebit.toFixed(2)} against ₹${totalCredit.toFixed(2)}. Nothing has been posted.`,
      warnings,
    };
  }

  const fy = financialYearOf(input.documentDate);
  const voucherNo = await nextVoucherNo(
    input.ownerId,
    direction === "RECEIPT" ? "RECEIPT" : "PAYMENT",
    fy,
  );

  const [voucher] = await db
    .insert(vouchersTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      kind: direction === "RECEIPT" ? "RECEIPT" : "PAYMENT",
      voucherNo,
      voucherDate: input.documentDate,
      financialYear: fy,
      narration: `${documentNo} — ${party.name}${input.instrumentRef ? ` (${input.instrumentRef})` : ""}`,
      sourceKind: "MANUAL",
      sourceId: null,
      totalDebit: money(totalDebit),
      totalCredit: money(totalCredit),
      warnings,
      postedByUserId: input.userId ?? null,
    })
    .returning();

  await db.insert(voucherLinesTable).values(
    lines.map((l, i) => {
      const a = need(l.accountCode);
      return {
        voucherId: voucher!.id,
        seq: i + 1,
        accountId: a.id,
        accountCode: a.code,
        accountName: a.name,
        debit: money(l.debit),
        credit: money(l.credit),
        narration: l.narration ?? null,
        partyId: l.partyId ?? null,
        partyName: l.partyName ?? null,
        partyGstin: l.partyGstin ?? null,
      };
    }),
  );

  const [doc] = await db
    .insert(moneyDocumentsTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      direction,
      documentNo,
      documentDate: input.documentDate,
      partyId: party.id,
      mode: input.mode,
      instrumentRef: input.instrumentRef ?? null,
      instrumentDate: input.instrumentDate ?? null,
      bankName: input.bankName ?? null,
      amount: money(amount),
      /*
       * The **whole** amount, unapplied, and then `applyAllocation` walks it
       * down below.
       *
       * Storing `amount - allocated` here and then applying the allocations was
       * the first version, and it deducted the same money twice: the loop below
       * found nothing unapplied and refused every allocation it had just been
       * handed. The receipts posted, the bills stayed open, and the only sign
       * was a warning nobody was asserting on. One place decrements this, and
       * it is the same place that reduces the bill.
       */
      unallocated: money(amount),
      advanceFor: input.advanceFor ?? "NONE",
      voucherId: voucher!.id,
      narration: input.narration ?? null,
      receivedByUserId: input.userId ?? null,
    })
    .returning();

  for (const a of allocations) {
    const applied = await applyAllocation({
      ownerId: input.ownerId,
      moneyDocumentId: doc!.id,
      partyBillId: a.partyBillId,
      amount: a.amount,
      decidedBy,
      userId: input.userId ?? null,
    });
    if (!applied.ok) warnings.push(applied.error!);
  }

  /*
   * Re-read before returning, because the allocations above changed it.
   *
   * The row from the insert still says the whole amount is unapplied - it was
   * true for the instant between the insert and the first allocation. Handing
   * that back means every caller sees a figure the database does not agree
   * with, and the only sign is a check that looks like it is testing allocation
   * and is actually testing a stale object.
   */
  const [fresh] = await db
    .select()
    .from(moneyDocumentsTable)
    .where(eq(moneyDocumentsTable.id, doc!.id));

  logger.info(
    { ownerId: input.ownerId, documentNo, voucherNo, unallocated: n(fresh?.unallocated) },
    direction === "RECEIPT" ? "Receipt recorded" : "Payment recorded",
  );
  return { ok: true, document: fresh ?? doc!, voucherId: voucher!.id, warnings };
}

/**
 * Put some of a receipt against a bill.
 *
 * Refuses to over-apply in either direction, because both produce a lie: more
 * than the bill is outstanding leaves a credit balance on an invoice that was
 * settled, and more than the receipt holds settles debts with money nobody
 * paid.
 */
export async function applyAllocation(input: {
  ownerId: number;
  moneyDocumentId: number;
  partyBillId: number;
  amount: number;
  decidedBy?: "PERSON" | "AUTOMATIC";
  userId?: number | null;
}): Promise<{ ok: boolean; error?: string }> {
  const amount = round2(input.amount);
  if (!(amount > 0)) return { ok: false, error: "An allocation has to be a positive amount." };

  const [doc] = await db
    .select()
    .from(moneyDocumentsTable)
    .where(
      and(
        eq(moneyDocumentsTable.ownerId, input.ownerId),
        eq(moneyDocumentsTable.id, input.moneyDocumentId),
      ),
    );
  if (!doc) return { ok: false, error: `No money document ${input.moneyDocumentId}` };

  const [bill] = await db
    .select()
    .from(partyBillsTable)
    .where(eq(partyBillsTable.id, input.partyBillId));
  if (!bill) return { ok: false, error: `No bill ${input.partyBillId}` };

  if (bill.partyId !== doc.partyId) {
    return {
      ok: false,
      error:
        "That bill belongs to a different party. Money from one customer cannot settle another's " +
        "debt without somebody deciding it should, and that is a journal rather than an allocation.",
    };
  }

  if (amount > round2(n(doc.unallocated)) + 0.005) {
    return {
      ok: false,
      error: `Only ₹${n(doc.unallocated).toFixed(2)} of ${doc.documentNo} is unapplied; ₹${amount.toFixed(2)} cannot come out of it.`,
    };
  }
  if (amount > round2(n(bill.outstanding)) + 0.005) {
    return {
      ok: false,
      error: `${bill.billNo} has ₹${n(bill.outstanding).toFixed(2)} outstanding; ₹${amount.toFixed(2)} would overpay it.`,
    };
  }

  await db.insert(billAllocationsTable).values({
    ownerId: input.ownerId,
    moneyDocumentId: doc.id,
    partyBillId: bill.id,
    amount: money(amount),
    decidedBy: input.decidedBy ?? "PERSON",
    decidedByUserId: input.userId ?? null,
  });

  await db
    .update(partyBillsTable)
    .set({ outstanding: money(round2(n(bill.outstanding) - amount)) })
    .where(eq(partyBillsTable.id, bill.id));

  await db
    .update(moneyDocumentsTable)
    .set({ unallocated: money(round2(n(doc.unallocated) - amount)) })
    .where(eq(moneyDocumentsTable.id, doc.id));

  return { ok: true };
}

/**
 * Undo an allocation by posting its opposite.
 *
 * Never a delete. Somebody decided in April that this cheque paid that invoice,
 * and if they were wrong the record should say they decided it and then changed
 * their mind — not that they never decided anything.
 */
export async function reverseAllocation(input: {
  ownerId: number;
  allocationId: number;
  userId?: number | null;
}): Promise<{ ok: boolean; error?: string }> {
  const [alloc] = await db
    .select()
    .from(billAllocationsTable)
    .where(
      and(
        eq(billAllocationsTable.ownerId, input.ownerId),
        eq(billAllocationsTable.id, input.allocationId),
      ),
    );
  if (!alloc) return { ok: false, error: `No allocation ${input.allocationId}` };
  if (alloc.reversalOfId) return { ok: false, error: "That is itself a reversal." };

  const [already] = await db
    .select({ id: billAllocationsTable.id })
    .from(billAllocationsTable)
    .where(eq(billAllocationsTable.reversalOfId, alloc.id))
    .limit(1);
  if (already) return { ok: false, error: "That allocation has already been reversed." };

  const amount = round2(n(alloc.amount));

  await db.insert(billAllocationsTable).values({
    ownerId: input.ownerId,
    moneyDocumentId: alloc.moneyDocumentId,
    partyBillId: alloc.partyBillId,
    amount: money(-amount),
    reversalOfId: alloc.id,
    decidedBy: "PERSON",
    decidedByUserId: input.userId ?? null,
  });

  await db
    .update(partyBillsTable)
    .set({ outstanding: sql`(${partyBillsTable.outstanding}::numeric + ${amount})::numeric` })
    .where(eq(partyBillsTable.id, alloc.partyBillId));
  await db
    .update(moneyDocumentsTable)
    .set({ unallocated: sql`(${moneyDocumentsTable.unallocated}::numeric + ${amount})::numeric` })
    .where(eq(moneyDocumentsTable.id, alloc.moneyDocumentId));

  return { ok: true };
}

/** What is sitting on account and needs somebody to say where it goes. */
export async function onAccount(input: {
  ownerId: number;
  direction: "RECEIPT" | "PAYMENT";
  asOf: string;
}): Promise<{
  rows: Array<{
    documentNo: string;
    documentDate: string;
    partyId: number;
    partyName: string;
    amount: number;
    unallocated: number;
    days: number;
  }>;
  total: number;
}> {
  const rows = await db
    .select({
      documentNo: moneyDocumentsTable.documentNo,
      documentDate: moneyDocumentsTable.documentDate,
      partyId: moneyDocumentsTable.partyId,
      partyName: partiesTable.name,
      amount: moneyDocumentsTable.amount,
      unallocated: moneyDocumentsTable.unallocated,
    })
    .from(moneyDocumentsTable)
    .innerJoin(partiesTable, eq(moneyDocumentsTable.partyId, partiesTable.id))
    .where(
      and(
        eq(moneyDocumentsTable.ownerId, input.ownerId),
        eq(moneyDocumentsTable.direction, input.direction),
        eq(moneyDocumentsTable.status, "POSTED"),
        sql`${moneyDocumentsTable.unallocated}::numeric > 0`,
        sql`${moneyDocumentsTable.documentDate}::text <= ${input.asOf}`,
      ),
    )
    .orderBy(asc(moneyDocumentsTable.documentDate));

  const asOfMs = Date.parse(input.asOf);
  const out = rows.map((r) => ({
    documentNo: r.documentNo,
    documentDate: r.documentDate,
    partyId: r.partyId,
    partyName: r.partyName,
    amount: n(r.amount),
    unallocated: n(r.unallocated),
    days: Math.floor((asOfMs - Date.parse(r.documentDate)) / 86_400_000),
  }));

  return { rows: out, total: round2(out.reduce((a, r) => a + r.unallocated, 0)) };
}

/**
 * What the till should hold, from the books.
 *
 * Cash receipts less cash payments for that branch on that day, plus whatever
 * the previous close left behind. Read from the money documents rather than
 * from the ledger, deliberately: the ledger's `1400` is the whole owner's cash
 * across every branch, and a day close is about one till.
 */
export async function bookedCashFor(input: {
  ownerId: number;
  showroomId: number;
  closeDate: string;
}): Promise<{ opening: number; receipts: number; payments: number; expected: number }> {
  const [prev] = await db
    .select()
    .from(dayClosesTable)
    .where(
      and(
        eq(dayClosesTable.showroomId, input.showroomId),
        sql`${dayClosesTable.closeDate}::text < ${input.closeDate}`,
      ),
    )
    .orderBy(desc(dayClosesTable.closeDate))
    .limit(1);

  /*
   * The opening float is what was *counted* last night, not what was booked.
   *
   * The money in the drawer this morning is the money that was in it when it
   * was locked, whatever the books said. Carrying the booked figure forward
   * would make yesterday's unexplained difference reappear today and every day
   * after, so one bad evening would haunt the till forever.
   */
  const opening = prev ? round2(n(prev.countedCash)) : 0;

  const rows = await db
    .select({
      direction: moneyDocumentsTable.direction,
      amount: moneyDocumentsTable.amount,
    })
    .from(moneyDocumentsTable)
    .where(
      and(
        eq(moneyDocumentsTable.showroomId, input.showroomId),
        eq(moneyDocumentsTable.mode, "CASH"),
        eq(moneyDocumentsTable.status, "POSTED"),
        eq(moneyDocumentsTable.documentDate, input.closeDate),
      ),
    );

  let receipts = 0;
  let payments = 0;
  for (const r of rows) {
    if (r.direction === "RECEIPT") receipts = round2(receipts + n(r.amount));
    else payments = round2(payments + n(r.amount));
  }

  return { opening, receipts, payments, expected: round2(opening + receipts - payments) };
}

/**
 * Close the day. The difference is named, never absorbed.
 *
 * A close that quietly journalled the difference away would hide the one thing
 * it exists to surface. `UNEXPLAINED` is a permitted answer and an honest one:
 * a real unexplained difference is worth more than a fabricated explanation,
 * and a pattern of them is itself the finding.
 */
export async function closeDay(input: {
  ownerId: number;
  showroomId: number;
  closeDate: string;
  countedCash: number;
  reason?: DayCloseRow["reason"];
  reasonNote?: string | null;
  userId?: number | null;
}): Promise<{ ok: boolean; close?: DayCloseRow; error?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const booked = await bookedCashFor(input);
  const counted = round2(input.countedCash);
  const difference = round2(counted - booked.expected);

  const bank = await db
    .select({ direction: moneyDocumentsTable.direction, amount: moneyDocumentsTable.amount })
    .from(moneyDocumentsTable)
    .where(
      and(
        eq(moneyDocumentsTable.showroomId, input.showroomId),
        sql`${moneyDocumentsTable.mode} <> 'CASH'`,
        eq(moneyDocumentsTable.status, "POSTED"),
        eq(moneyDocumentsTable.documentDate, input.closeDate),
      ),
    );
  let bankReceipts = 0;
  let bankPayments = 0;
  for (const b of bank) {
    if (b.direction === "RECEIPT") bankReceipts = round2(bankReceipts + n(b.amount));
    else bankPayments = round2(bankPayments + n(b.amount));
  }

  let reason = input.reason ?? (difference === 0 ? "EXACT" : "UNEXPLAINED");
  if (difference === 0) reason = "EXACT";
  if (difference !== 0 && reason === "EXACT") {
    return {
      ok: false,
      error: `The count differs from the books by ₹${difference.toFixed(2)}, so it cannot be closed as exact. Say what the difference is, or record it as unexplained.`,
      warnings,
    };
  }
  if (difference !== 0) {
    warnings.push(
      `${difference > 0 ? "Excess" : "Shortfall"} of ₹${Math.abs(difference).toFixed(2)}: counted ₹${counted.toFixed(2)} against ₹${booked.expected.toFixed(2)} booked. ` +
        "It has been recorded as a difference rather than journalled away — the day close exists to surface exactly this.",
    );
  }

  try {
    const [close] = await db
      .insert(dayClosesTable)
      .values({
        ownerId: input.ownerId,
        showroomId: input.showroomId,
        closeDate: input.closeDate,
        bookedCash: money(booked.expected),
        countedCash: money(counted),
        difference: money(difference),
        reason,
        reasonNote: input.reasonNote ?? null,
        bankReceipts: money(bankReceipts),
        bankPayments: money(bankPayments),
        closedByUserId: input.userId ?? null,
      })
      .returning();

    logger.info(
      { ownerId: input.ownerId, showroomId: input.showroomId, closeDate: input.closeDate, difference },
      "Day closed",
    );
    return { ok: true, close: close!, warnings };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "23505") {
      return {
        ok: false,
        error:
          `${input.closeDate} is already closed at this branch. A day closed twice is a day whose figures ` +
          "nobody can quote, and the second close would supersede the first without anybody being told.",
        warnings,
      };
    }
    throw err;
  }
}

/** Every close with a difference on it, which is the report worth reading. */
export async function dayCloseDifferences(input: {
  ownerId: number;
  from: string;
  to: string;
}): Promise<{ rows: DayCloseRow[]; total: number; unexplained: number }> {
  const rows = await db
    .select()
    .from(dayClosesTable)
    .where(
      and(
        eq(dayClosesTable.ownerId, input.ownerId),
        sql`${dayClosesTable.difference}::numeric <> 0`,
        sql`${dayClosesTable.closeDate}::text >= ${input.from}`,
        sql`${dayClosesTable.closeDate}::text <= ${input.to}`,
      ),
    )
    .orderBy(asc(dayClosesTable.closeDate));

  return {
    rows,
    total: round2(rows.reduce((a, r) => a + n(r.difference), 0)),
    unexplained: rows.filter((r) => r.reason === "UNEXPLAINED").length,
  };
}

/** Every allocation against one bill, so a statement can show how it was paid. */
export async function allocationsFor(partyBillId: number): Promise<
  Array<{
    documentNo: string;
    documentDate: string;
    mode: string;
    amount: number;
    decidedBy: string;
  }>
> {
  const rows = await db
    .select({
      documentNo: moneyDocumentsTable.documentNo,
      documentDate: moneyDocumentsTable.documentDate,
      mode: moneyDocumentsTable.mode,
      amount: billAllocationsTable.amount,
      decidedBy: billAllocationsTable.decidedBy,
    })
    .from(billAllocationsTable)
    .innerJoin(
      moneyDocumentsTable,
      eq(billAllocationsTable.moneyDocumentId, moneyDocumentsTable.id),
    )
    .where(eq(billAllocationsTable.partyBillId, partyBillId))
    .orderBy(asc(billAllocationsTable.id));

  return rows.map((r) => ({ ...r, amount: n(r.amount) }));
}
