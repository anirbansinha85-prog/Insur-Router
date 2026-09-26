import { and, desc, eq, sql } from "drizzle-orm";

import {
  billAllocationsTable,
  db,
  dmsVehicleStockTable,
  moneyDocumentsTable,
  partyBillsTable,
  saleDocumentsTable,
  serviceInvoicesTable,
  voucherLinesTable,
  vouchersTable,
  type LedgerAccountRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { accountsByCode, ensureChart } from "./accounts";
import { ensureParty, openBill } from "./parties";
import { recordChassisEvent } from "./moves";
import { placementOf } from "../org";

/**
 * Turning a document DDMS issued into double entry (OBJ-31, R-100 to R-103).
 *
 * ## There is no model anywhere in this file, and there cannot be
 *
 * R-100 restates R-78 where the consequence is statutory: accounting arithmetic
 * is deterministic, tested, and has no model near it. Every branch here is a
 * comparison against a stored value or a lookup in a table declared above it.
 * The one place a judgement could creep in — deciding what an unrecognised
 * charge *is* — deliberately does not make one. It goes to suspense.
 *
 * ## The input is a `sale_document`, not a PDF
 *
 * That is the whole integration. DDMS already produces the invoice; the ledger
 * posts what DDMS issued. A dealership whose invoices never pass through DDMS
 * reaches the same place through OBJ-24's `DOCUMENT` path, which makes them a
 * mirrored deal and then a document, so there is exactly one thing to post
 * from.
 *
 * ## What a sale actually looks like
 *
 * ```
 *   Dr  Sundry Debtors                    total on the invoice
 *       Cr  Vehicle Sales                 taxable value
 *       Cr  Output CGST / SGST / IGST     the tax split as printed
 *       Cr  Output Cess                   where a bike attracts it
 *       Cr  Road Tax Payable              R-103 — collected for the RTO
 *       Cr  Insurance Premium Payable     R-103 — collected for the insurer
 *       Cr  Registration Charges Payable  R-103
 *       Cr  Suspense                      anything unrecognised, never income
 *
 *   Dr  Cost of Goods Sold                what the unit cost            R-102
 *       Cr  Vehicle Stock                 the bike has left the floor
 * ```
 *
 * ## The two things it refuses to guess
 *
 * **A charge whose label nothing recognises does not become income.** The
 * failure R-103 is written against is overstating turnover, so the default has
 * to fall the other way. It is credited to suspense and named in the warnings,
 * which is what a suspense account is for.
 *
 * **A vehicle that cannot be found in stock does not get an invented cost.**
 * The revenue posts and the cost relief does not, and the warning says so in
 * those words. Refusing the whole posting would be worse — the sale happened —
 * and inventing a cost would be a fabricated figure inside a set of books.
 */

// ── Classifying what the customer was charged on top of the vehicle ──────────

/**
 * Which account an "other charge" belongs in, by what it is called.
 *
 * A closed table, matched on a normalised label, in the same spirit as the
 * ingest vocabulary and for the same reason: the dealer's words vary and the
 * meaning does not. Everything here is either a genuine pass-through (R-103) or
 * something the dealership actually earned.
 *
 * The list is short on purpose. Adding a synonym is a two-second edit here with
 * a test behind it; letting a model decide would be a model deciding whether a
 * figure is turnover, which is the exact shape R-97 refuses.
 */
const CHARGE_ACCOUNT: Array<{ match: RegExp; code: string; why: string }> = [
  { match: /\b(road\s*tax|rto\s*tax|life\s*tax|mv\s*tax)\b/i, code: "2300", why: "road tax" },
  {
    match: /\b(registration|rto\s*(fee|charge)|hsrp|smart\s*card|number\s*plate)\b/i,
    code: "2310",
    why: "registration",
  },
  {
    match: /\b(insurance|premium|policy|tp\s*premium|od\s*premium)\b/i,
    code: "2320",
    why: "insurance premium",
  },
  {
    match: /\b(accessor|extended\s*warranty|amc|service\s*package|rsa)\b/i,
    code: "2330",
    why: "accessories or a warranty product",
  },
  {
    match: /\b(handling|logistics|documentation|doc\s*charge|processing)\b/i,
    code: "4400",
    why: "the dealership's own handling charge",
  },
];

const SUSPENSE = "2900";

export function accountForCharge(label: string): { code: string; why: string | null } {
  for (const rule of CHARGE_ACCOUNT) {
    if (rule.match.test(label)) return { code: rule.code, why: rule.why };
  }
  return { code: SUSPENSE, why: null };
}

// ── Building the voucher ─────────────────────────────────────────────────────

export interface Line {
  accountCode: string;
  debit: number;
  credit: number;
  narration?: string;
  /**
   * Which party this line is against (R-110). The control account stays on
   * `accountCode`; this is what makes the subsidiary ledger under it possible.
   */
  partyId?: number | null;
  partyName?: string | null;
  partyGstin?: string | null;
  hsn?: string | null;
  taxRatePct?: number | null;
}

const n = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
const money = (v: number): string => v.toFixed(2);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** April to March, as `2026-27`. Every statutory question in India needs it. */
export function financialYearOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export interface PostResult {
  ok: boolean;
  voucher?: typeof vouchersTable.$inferSelect;
  error?: string;
  warnings: string[];
}

/**
 * Post one issued sale document.
 *
 * Idempotent by the index rather than by a check-then-insert: the partial
 * unique on `(sourceKind, sourceId) where status = 'POSTED'` means a concurrent
 * second attempt loses at the database instead of both winning. A check-first
 * version posts the same invoice twice under a retry and overstates the month's
 * sales by the price of a motorcycle — which is precisely the error nobody
 * notices until a return is filed.
 */
export async function postSaleDocument(input: {
  ownerId: number;
  documentId: number;
  userId?: number | null;
}): Promise<PostResult> {
  const warnings: string[] = [];

  const [doc] = await db
    .select()
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, input.ownerId),
        eq(saleDocumentsTable.id, input.documentId),
      ),
    );

  if (!doc) return { ok: false, error: `No document ${input.documentId}`, warnings };

  /*
   * Only what the dealership actually issued, and only what creates a debt.
   *
   * A quotation is a price somebody was told and a proforma is a request for
   * payment; neither is a sale, and posting one would recognise revenue on a
   * conversation. A cancelled document has no entries either — it is reversed
   * if it was ever posted, which is a different path.
   */
  if (doc.status !== "ISSUED") {
    return { ok: false, error: `Document ${doc.reference} is ${doc.status}, not issued.`, warnings };
  }
  if (doc.kind !== "TAX_INVOICE" && doc.kind !== "SALE_CONFIRMATION") {
    return {
      ok: false,
      error: `A ${doc.kind.toLowerCase().replace("_", " ")} is not a sale. Nothing is owed on it yet, so there is nothing to post.`,
      warnings,
    };
  }

  await ensureChart(input.ownerId);
  const accounts = await accountsByCode(input.ownerId);

  const need = (code: string): LedgerAccountRow => {
    const a = accounts.get(code);
    if (!a) {
      // Cannot happen after `ensureChart` unless somebody deleted a system
      // account, which the route refuses. Thrown rather than skipped: a missing
      // line balances to something wrong, and a set of books that is wrong and
      // balances is worse than one that would not save.
      throw new Error(
        `The ledger account ${code} is missing for this dealership, so the voucher cannot be built.`,
      );
    }
    return a;
  };

  /*
   * The customer becomes a **ledger**, not a string on a line (R-110).
   *
   * Until this, `1100` Sundry Debtors was debited by every sale and credited by
   * nothing, so every customer who had ever paid still appeared to owe. There
   * was no row to credit. The party row and the bill opened below it are the
   * other end of that entry, and OBJ-40's receipt is what closes it.
   *
   * A retail buyer with no name and no mobile is still a real sale, so the
   * fallback is the document's own reference rather than a refusal — an
   * unnamed customer is a poor statement and a refused invoice is a lost sale.
   */
  const placement = await placementOf(doc.showroomId);
  const { party: customer } = await ensureParty({
    ownerId: input.ownerId,
    entityId: placement.entity.id,
    kind: "CUSTOMER",
    name: doc.customerName?.trim() || `Counter sale ${doc.reference}`,
    gstin: doc.customerGstin,
    mobile: doc.customerMobile,
    addressLine: doc.customerAddress,
    state: doc.placeOfSupply,
  });

  const lines: Line[] = [];
  const party = {
    partyId: customer.id,
    partyName: doc.customerName,
    partyGstin: doc.customerGstin,
  };

  const total = n(doc.totalAmount);
  const taxable = n(doc.taxableAmount);
  const cgst = n(doc.cgstAmount);
  const sgst = n(doc.sgstAmount);
  const igst = n(doc.igstAmount);
  const cess = n(doc.cessAmount);

  // The debt the customer owes, and it is one line whatever it is made of.
  lines.push({
    accountCode: "1100",
    debit: total,
    credit: 0,
    narration: `${doc.kind === "TAX_INVOICE" ? "Tax invoice" : "Sale"} ${doc.taxInvoiceNo ?? doc.reference}`,
    ...party,
  });

  lines.push({
    accountCode: "4100",
    debit: 0,
    credit: taxable,
    narration: doc.modelDescription ?? "Vehicle sale",
    hsn: doc.hsn,
    taxRatePct: n(doc.gstRatePct),
  });

  if (cgst > 0) lines.push({ accountCode: "2200", debit: 0, credit: cgst, taxRatePct: n(doc.gstRatePct) / 2 });
  if (sgst > 0) lines.push({ accountCode: "2210", debit: 0, credit: sgst, taxRatePct: n(doc.gstRatePct) / 2 });
  if (igst > 0) lines.push({ accountCode: "2220", debit: 0, credit: igst, taxRatePct: n(doc.gstRatePct) });
  if (cess > 0) lines.push({ accountCode: "2230", debit: 0, credit: cess, taxRatePct: n(doc.cessRatePct) });

  /*
   * R-103, one line per charge, and the unrecognised ones say so.
   *
   * Grouped by account so three separate RTO line items become one credit to
   * Registration Charges Payable — a voucher with eleven near-identical lines
   * is one nobody reads, and the detail is on the invoice it names.
   */
  const byAccount = new Map<string, { amount: number; labels: string[] }>();
  for (const charge of doc.otherCharges ?? []) {
    const amount = Number(charge.amount) || 0;
    if (amount === 0) continue;
    const { code, why } = accountForCharge(charge.label);
    if (why === null) {
      warnings.push(
        `“${charge.label}” (₹${amount.toFixed(2)}) is not a charge this product recognises, so it has gone to suspense rather than to income. ` +
          "Overstating turnover is the failure worth avoiding here — your accountant should move it.",
      );
    }
    const bucket = byAccount.get(code) ?? { amount: 0, labels: [] };
    bucket.amount += amount;
    bucket.labels.push(charge.label);
    byAccount.set(code, bucket);
  }
  for (const [code, bucket] of byAccount) {
    lines.push({
      accountCode: code,
      debit: 0,
      credit: bucket.amount,
      narration: bucket.labels.join(", "),
      /*
       * The customer's **name** and not his ledger (R-110).
       *
       * These lines credit a liability to the RTO, the insurer or whoever else
       * the money is being collected for. Whose road tax it is belongs in the
       * narration, and putting `partyId` here instead would post an ₹8,400
       * credit onto the customer's own account - so a statement would show him
       * owing ₹84,000 on a ₹92,400 invoice, and the eight thousand he still owes
       * would have vanished into somebody else's liability.
       *
       * Caught by `verify-parties` on the first run after the party ledger
       * existed, which is precisely what a subsidiary ledger is for: the trial
       * balance was correct throughout, and the customer's account was not.
       */
      partyName: party.partyName,
      partyGstin: party.partyGstin,
    });
  }

  /*
   * R-102 — the bike has left the floor and the floor has to know.
   *
   * Matched on the chassis number, which is the only identifier both the
   * document and the stock mirror carry. No match means either the unit was
   * never mirrored (a sub-dealer with no DMS, which is the customer OBJ-30 was
   * written for) or the chassis was typed differently on one of them.
   *
   * Either way the revenue posts and the cost does not, and the warning says it
   * in the words that describe the consequence. Inventing a cost would put a
   * fabricated figure inside a set of books; refusing the whole posting would
   * deny a sale that happened.
   */
  let costRelieved = 0;
  if (doc.chassisNo) {
    const [unit] = await db
      .select({ cost: dmsVehicleStockTable.costAmount })
      .from(dmsVehicleStockTable)
      .where(
        and(
          eq(dmsVehicleStockTable.showroomId, doc.showroomId),
          eq(dmsVehicleStockTable.chassisNo, doc.chassisNo),
        ),
      );
    costRelieved = n(unit?.cost);
  }

  if (costRelieved > 0) {
    lines.push({
      accountCode: "5100",
      debit: costRelieved,
      credit: 0,
      narration: `Cost of ${doc.modelDescription ?? "vehicle"} ${doc.chassisNo ?? ""}`.trim(),
    });
    lines.push({
      accountCode: "1200",
      debit: 0,
      credit: costRelieved,
      narration: doc.chassisNo ?? undefined,
    });
  } else {
    warnings.push(
      doc.chassisNo
        ? `Chassis ${doc.chassisNo} is not in this outlet's stock with a cost against it, so the sale is posted without relieving inventory. Until it is, the whole selling price reads as margin.`
        : "This document carries no chassis number, so inventory could not be relieved. Until it is, the whole selling price reads as margin.",
    );
  }

  /*
   * R-88's other half, and it is deliberately not posted.
   *
   * An OEM scheme is claimable whatever the customer was told, so there is a
   * receivable from the manufacturer sitting behind this sale. Whether it is
   * income or a reduction of cost of goods is a genuine accounting judgement
   * that belongs to the dealership's CA, and R-98's posture is to feed their
   * books rather than to decide their policy. It is named here so it is not
   * lost, and the claims screen is where it is worked.
   */
  const scheme = n(doc.oemSchemeAmount);
  if (scheme > 0) {
    warnings.push(
      `₹${scheme.toFixed(2)} is claimable from the manufacturer on this sale and is not in this voucher. ` +
        "Whether that is income or a reduction of cost is your accountant's call, so DDMS records the claim and does not post it. See the claims screen.",
    );
  }

  const totalDebit = lines.reduce((a, l) => a + l.debit, 0);
  const totalCredit = lines.reduce((a, l) => a + l.credit, 0);

  /*
   * A voucher that does not balance is never saved.
   *
   * Half a paisa of tolerance, because the invoice's own columns are rounded to
   * two places and the sum of rounded parts is not always the rounded sum. More
   * than that is a real defect and the right answer is to refuse — an
   * unbalanced entry in a set of books is not something to warn about.
   */
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    return {
      ok: false,
      error:
        `This document does not balance: debits ₹${totalDebit.toFixed(2)} against credits ₹${totalCredit.toFixed(2)}. ` +
        "Nothing has been posted. The difference is between the invoice's total and the sum of its parts.",
      warnings,
    };
  }

  const voucherNo = await nextVoucherNo(input.ownerId, "SALES", financialYearOf(doc.documentDate));

  try {
    const [voucher] = await db
      .insert(vouchersTable)
      .values({
        ownerId: input.ownerId,
        showroomId: doc.showroomId,
        kind: "SALES",
        voucherNo,
        voucherDate: doc.documentDate,
        financialYear: financialYearOf(doc.documentDate),
        narration: `${doc.customerName ?? "Customer"} — ${doc.modelDescription ?? "vehicle"} — ${doc.taxInvoiceNo ?? doc.reference}`,
        sourceKind: "SALE_DOCUMENT",
        sourceId: doc.id,
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
          hsn: l.hsn ?? null,
          taxRatePct: l.taxRatePct == null ? null : String(l.taxRatePct),
        };
      }),
    );

    /*
     * The debt, as a bill somebody can settle (R-111).
     *
     * A party balance alone can only be paid off oldest-first, which is a guess
     * about which invoice the customer meant to settle. A customer disputing one
     * and paying another is an ordinary Tuesday, and a product that applied his
     * money to the one he is disputing has taken a side in his argument.
     */
    await openBill({
      ownerId: input.ownerId,
      partyId: customer.id,
      showroomId: doc.showroomId,
      direction: "RECEIVABLE",
      billNo: doc.taxInvoiceNo ?? doc.reference,
      billDate: doc.documentDate,
      dueDate: null,
      amount: total,
      sourceKind: "SALE_DOCUMENT",
      sourceId: doc.id,
    });

    if (doc.chassisNo) {
      await recordChassisEvent({
        ownerId: input.ownerId,
        chassisNo: doc.chassisNo,
        showroomId: doc.showroomId,
        kind: "SOLD",
        eventDate: doc.documentDate,
        sourceKind: "SALE_DOCUMENT",
        sourceId: doc.id,
        sourceRef: doc.taxInvoiceNo ?? doc.reference,
        value: costRelieved || null,
        narration: `Sold to ${doc.customerName ?? "a customer"}`,
      });
    }

    logger.info(
      { ownerId: input.ownerId, documentId: doc.id, voucherNo, warnings: warnings.length },
      "Sale posted to the ledger",
    );
    return { ok: true, voucher: voucher!, warnings };
  } catch (err) {
    // Drizzle wraps the driver error; the sentence worth reading is on the cause.
    const refusal = postingRefusal(
      err,
      "This document has already been posted. Correcting it means reversing the existing voucher and posting again — a posted voucher is never edited.",
    );
    if (refusal) return { ok: false, error: refusal, warnings };
    throw err;
  }
}

/**
 * Sequential and gapless, per owner per kind per financial year.
 *
 * Read-then-write rather than a sequence, because the numbering restarts every
 * April and has to have no holes in it. The unique index on
 * `(owner, kind, financialYear, voucherNo)` is what makes a race lose loudly
 * instead of producing two vouchers numbered 41 — a gapless series with a
 * duplicate in it is an audit finding, and so is one with a hole.
 */
export async function nextVoucherNo(
  ownerId: number,
  kind: "SALES" | "PURCHASE" | "RECEIPT" | "PAYMENT" | "JOURNAL" | "CREDIT_NOTE",
  financialYear: string,
): Promise<string> {
  /*
   * **The highest number, arithmetically, over the rows that are in the series.**
   *
   * This ordered by `length(voucher_no)` and then by the text, which is a correct
   * way to compare integers held as strings and a wrong way to find a maximum
   * once anything in the column is not an integer. A voucher numbered
   * `AUDIT-SEPTEMBER-1` — seventeen characters — won that ordering outright, the
   * digits were stripped to `1`, and the next number came back as **2**, which
   * already existed. `vouchers_owner_no_unique` then refused it, as it should,
   * and went on refusing: the series was jammed for that kind and year for ever,
   * and every journal, reversal and floor-plan posting after it failed.
   *
   * Four verifiers went red at once on exactly that, and the one that had put the
   * odd number there could no longer clean it up, because cleaning up needed a
   * posting. A dealership numbering its own journals `JV/2026-27/0001` would have
   * hit it on the first entry.
   *
   * So the series is the rows that **look like a series** — `^[0-9]+$` — compared
   * as numbers, and a prefixed number sits outside it rather than steering it.
   * `coalesce(max(...), 0) + 1` also removes the read-then-branch on whether any
   * row existed.
   */
  const [row] = await db
    .select({
      next: sql<string>`coalesce(max(case when ${vouchersTable.voucherNo} ~ '^[0-9]+$'
                                          then ${vouchersTable.voucherNo}::bigint end), 0) + 1`,
    })
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, ownerId),
        eq(vouchersTable.kind, kind),
        eq(vouchersTable.financialYear, financialYear),
      ),
    );

  return String(row?.next ?? 1);
}

/**
 * Undo a posted voucher by posting its mirror (R-101).
 *
 * Never an edit and never a delete. The original stays, marked `REVERSED`, and
 * a new voucher carries the same lines with debit and credit swapped. That is
 * how every accounting system in the world does it and the reason is the same:
 * a set of books whose entries can be changed after the fact is not evidence of
 * anything, and the month it was closed on is already in somebody's return.
 */
export async function reverseVoucher(input: {
  ownerId: number;
  voucherId: number;
  reason: string;
  userId?: number | null;
}): Promise<PostResult> {
  const [original] = await db
    .select()
    .from(vouchersTable)
    .where(and(eq(vouchersTable.ownerId, input.ownerId), eq(vouchersTable.id, input.voucherId)));

  if (!original) return { ok: false, error: `No voucher ${input.voucherId}`, warnings: [] };
  if (original.status === "REVERSED") {
    return { ok: false, error: "That voucher has already been reversed.", warnings: [] };
  }

  const lines = await db
    .select()
    .from(voucherLinesTable)
    .where(eq(voucherLinesTable.voucherId, original.id))
    .orderBy(voucherLinesTable.seq);

  const voucherNo = await nextVoucherNo(input.ownerId, "JOURNAL", original.financialYear);

  /*
   * The period lock is a database trigger, so a refusal arrives here as an
   * exception rather than as a return value (R-112). Translating it is not
   * cosmetic: a screen has to be able to show the dealership *why* it cannot
   * undo something, and "check_violation" is not that sentence. The database's
   * own message is, so it is carried through unchanged.
   */
  let reversal: typeof vouchersTable.$inferSelect | undefined;
  try {
    [reversal] = await db
      .insert(vouchersTable)
    .values({
      ownerId: input.ownerId,
      showroomId: original.showroomId,
      kind: "JOURNAL",
      voucherNo,
      // Today's date, not the original's. Reversing an April entry in September
      // is a September event; back-dating it would silently reopen a month that
      // has already been filed on.
      voucherDate: new Date().toISOString().slice(0, 10),
      financialYear: financialYearOf(new Date().toISOString().slice(0, 10)),
      narration: `Reversal of ${original.kind} ${original.voucherNo} — ${input.reason}`,
      sourceKind: "MANUAL",
      sourceId: null,
      reversalOfId: original.id,
      reversalReason: input.reason,
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      warnings: [],
      postedByUserId: input.userId ?? null,
    })
      .returning();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "23514" && cause.message) {
      return { ok: false, error: cause.message, warnings: [] };
    }
    throw err;
  }

  await db.insert(voucherLinesTable).values(
    lines.map((l) => ({
      voucherId: reversal!.id,
      seq: l.seq,
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      // The mirror, and the whole of the reversal.
      debit: l.credit,
      credit: l.debit,
      narration: l.narration ?? undefined,
      /*
       * **`partyId` and not only `partyName`**, which is R-110 on the way back
       * out.
       *
       * The mirror carried the party name and dropped the party ledger, so a
       * reversed sale credited the debtors *control* account and credited no
       * debtor. The trial balance was right throughout and the customer account
       * was wrong: he still appeared to owe the price of a motorcycle he had
       * been invoiced for by mistake, and the statement he was sent said so.
       * Same defect the charge lines were fixed for, one direction along, and
       * the reason `verify-parties` exists.
       */
      partyId: l.partyId,
      partyName: l.partyName,
      partyGstin: l.partyGstin,
      hsn: l.hsn,
      taxRatePct: l.taxRatePct,
    })),
  );

  await db
    .update(vouchersTable)
    .set({ status: "REVERSED", reversedByVoucherId: reversal!.id, reversalReason: input.reason })
    .where(eq(vouchersTable.id, original.id));

  const warnings = await undoDocumentSideEffects(original, input.reason);

  return { ok: true, voucher: reversal!, warnings };
}

/**
 * The half of a reversal that is not double entry.
 *
 * Posting a document does four things and only one of them is a voucher. It
 * opens a **bill** somebody can settle (R-111), it may relieve **stock** and
 * write the chassis register, and money already received against that bill is
 * **allocated** to it. A mirror voucher undoes the first and none of the rest,
 * so before this the books and the sub-ledger parted company the moment
 * anything was reversed: the trial balance was corrected, the receivables report
 * still showed the debt, the ageing still counted it, and a customer who had
 * paid could not have his money applied to the invoice that replaced it.
 *
 * ## The bill is closed rather than deleted, and its allocations are reversed
 *
 * A bill that no longer exists cannot hold money. So every live allocation
 * against it is reversed first, which returns that money to *on account* where
 * it is free to settle the corrected invoice, and only then is the bill taken
 * out of the ageing. The allocation rows stay, reversal beside decision, because
 * *somebody decided this cheque paid that invoice and then the invoice was
 * withdrawn* is the sequence an auditor has to be able to read.
 *
 * ## Why a function rather than four lines inside the reversal
 *
 * Every posting door will need it, and a reversal that undoes three quarters of
 * a posting is worse than one that refuses outright: the first leaves books that
 * look corrected.
 */
async function undoDocumentSideEffects(
  original: typeof vouchersTable.$inferSelect,
  reason: string,
): Promise<string[]> {
  const warnings: string[] = [];

  /*
   * Which bill this voucher opened. A service invoice opens its bill with no
   * source on it, so that one is found by invoice number instead. Named here
   * rather than quietly skipped: a silent miss is how the first version of this
   * would have passed its own test.
   */
  let bill: typeof partyBillsTable.$inferSelect | undefined;
  const src = original.sourceId;

  if (src !== null && (original.sourceKind === "SALE_DOCUMENT" || original.sourceKind === "PURCHASE_INVOICE")) {
    [bill] = await db
      .select()
      .from(partyBillsTable)
      .where(
        and(
          eq(partyBillsTable.sourceKind, original.sourceKind),
          eq(partyBillsTable.sourceId, src),
        ),
      );
  } else if (src !== null && original.sourceKind === "SERVICE_INVOICE") {
    const [inv] = await db
      .select({
        invoiceNo: serviceInvoicesTable.invoiceNo,
        customerId: serviceInvoicesTable.customerId,
      })
      .from(serviceInvoicesTable)
      .where(eq(serviceInvoicesTable.id, src));
    if (inv) {
      [bill] = await db
        .select()
        .from(partyBillsTable)
        .where(
          and(
            eq(partyBillsTable.partyId, inv.customerId),
            eq(partyBillsTable.billNo, inv.invoiceNo),
          ),
        );
    }
  }

  if (bill) {
    const live = await db
      .select()
      .from(billAllocationsTable)
      .where(eq(billAllocationsTable.partyBillId, bill.id));

    const undone = new Set(
      live.map((a) => a.reversalOfId).filter((x): x is number => x !== null),
    );
    const open = live.filter((a) => a.reversalOfId === null && !undone.has(a.id));

    for (const a of open) {
      const amount = round2(n(a.amount));
      if (amount <= 0) continue;
      await db.insert(billAllocationsTable).values({
        ownerId: a.ownerId,
        moneyDocumentId: a.moneyDocumentId,
        partyBillId: a.partyBillId,
        amount: money(-amount),
        reversalOfId: a.id,
        decidedBy: "PERSON",
      });
      await db
        .update(moneyDocumentsTable)
        .set({
          unallocated: sql`(${moneyDocumentsTable.unallocated}::numeric + ${amount})::numeric`,
        })
        .where(eq(moneyDocumentsTable.id, a.moneyDocumentId));
      warnings.push(
        `₹${amount.toFixed(2)} that had been applied to ${bill.billNo} is back on account against this party, so it can go against whatever replaces it.`,
      );
    }

    /*
     * Out of the ageing, with `amount` left standing as the record of what was
     * billed. A bill has no cancelled state, only `outstanding = 0` for settled,
     * so the reversal voucher is what says this was withdrawn rather than paid
     * and the trace is what joins the two.
     */
    await db
      .update(partyBillsTable)
      .set({ outstanding: "0.00" })
      .where(eq(partyBillsTable.id, bill.id));
    warnings.push(`${bill.billNo} is no longer an open bill — ${reason}`);
  }

  /*
   * The register learns the machine is back, using the event kind the schema has
   * carried since OBJ-46 and nothing has ever written. Without it the register
   * says sold, the ledger says in stock, and `stockPositionCheck` reports a
   * mismatch against the manufacturer mirror that nobody can account for.
   */
  if (original.sourceKind === "SALE_DOCUMENT" && src !== null) {
    const [doc] = await db
      .select({
        chassisNo: saleDocumentsTable.chassisNo,
        showroomId: saleDocumentsTable.showroomId,
        reference: saleDocumentsTable.reference,
        taxInvoiceNo: saleDocumentsTable.taxInvoiceNo,
      })
      .from(saleDocumentsTable)
      .where(eq(saleDocumentsTable.id, src));

    if (doc?.chassisNo) {
      await recordChassisEvent({
        ownerId: original.ownerId,
        chassisNo: doc.chassisNo,
        showroomId: doc.showroomId,
        kind: "SALE_REVERSED",
        eventDate: new Date().toISOString().slice(0, 10),
        sourceKind: "SALE_DOCUMENT",
        sourceId: src,
        sourceRef: doc.taxInvoiceNo ?? doc.reference,
        narration: `Sale reversed — ${reason}`,
      });
      warnings.push(
        `${doc.chassisNo} is back on the floor in the chassis register. Whether the manufacturer's own system agrees is the stock reconciliation's question.`,
      );
    }
  }

  return warnings;
}

/**
 * What a refusal from the database actually said, in the words it said it in.
 *
 * Two of the constraints on `vouchers` are load-bearing and neither of them can
 * be a return value, because neither is checked in this process: the period
 * lock is a trigger (R-112, OBJ-43) and the source uniqueness that makes
 * posting idempotent is a partial unique index (R-101). Both arrive as a driver
 * error on an insert.
 *
 * Seven functions insert a voucher and only three translated them. The other
 * four re-threw, so a dealership posting a receipt into a month it had closed
 * got HTTP 500 and a stack trace — the refusal was right and unreadable, which
 * is the same as a product that lost the sentence. This is that sentence, in
 * one place, so the next posting door cannot be written without it.
 *
 * The lock's message is carried through **unchanged**, because it names the
 * dates it is refusing. Restating it here would make two sentences for one rule
 * and the one somebody reads would not be the one that refused.
 */
export function postingRefusal(err: unknown, duplicate?: string): string | null {
  const cause = (err as {
    cause?: { code?: string; message?: string; constraint?: string };
  }).cause;
  if (!cause) return null;
  /*
   * The lock is a `raise exception ... using errcode = 'check_violation'`, so it
   * carries a message and **no constraint name**. A named check constraint is
   * somebody else's rule about the shape of a row, and guessing at its sentence
   * here would put the wrong words on a different refusal.
   */
  if (cause.code === "23514" && !cause.constraint && cause.message) return cause.message;
  if (cause.code === "23505" && duplicate) return duplicate;
  return null;
}

/**
 * The voucher a sale document is posted as, if it is posted.
 *
 * `status` is in the filter rather than checked afterwards, because a document
 * posted, reversed and posted again has several vouchers and only one of them is
 * standing. Every caller that wants *the* voucher for a document wants that one.
 *
 * Returns a `PostResult` rather than a row so that it reads interchangeably with
 * `postSaleDocument` at a call site whose question is **which voucher is this
 * document in the books as** — which, now that issuing posts, is what most of
 * those call sites were actually asking.
 */
export async function postedVoucherFor(input: {
  ownerId: number;
  documentId: number;
}): Promise<PostResult> {
  const [voucher] = await db
    .select()
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        eq(vouchersTable.sourceKind, "SALE_DOCUMENT"),
        eq(vouchersTable.sourceId, input.documentId),
        eq(vouchersTable.status, "POSTED"),
      ),
    );

  if (!voucher) {
    return {
      ok: false,
      error: `Document ${input.documentId} is not in the books. Issuing posts it, so either the posting was refused — a closed period is the ordinary reason — or it has been reversed.`,
      warnings: [],
    };
  }
  return { ok: true, voucher, warnings: voucher.warnings ?? [] };
}
