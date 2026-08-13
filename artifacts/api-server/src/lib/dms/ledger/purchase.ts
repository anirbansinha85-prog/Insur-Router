/**
 * Where a motorcycle enters the books (OBJ-38, R-109).
 *
 * ## The defect this closes, stated plainly
 *
 * Every sale credited `1200` Vehicle Stock and nothing ever debited it. Post a
 * month of sales against a ledger that has never seen a purchase and Vehicle
 * Stock is a large negative number on the asset side of the balance sheet —
 * every voucher balancing, the trial balance nonsense. Same for `1100` Sundry
 * Debtors, debited by every sale and credited by nothing.
 *
 * A ledger that knows one of the four money events is not a partial ledger. It
 * is an unfilable one.
 *
 * ## The entry
 *
 * ```
 *   Dr  1200  Vehicle Stock          the taxable value of the consignment
 *   Dr  1600/1610  Input CGST/SGST   intra-state
 *   Dr  1620       Input IGST        inter-state
 *   Cr  2100  Sundry Creditors       against the OEM, as a bill
 * ```
 *
 * **Input tax is an asset and not a cost.** It is money the government owes
 * back, set off against output tax on the return. A dealership that posted it
 * to an expense head would overstate its cost of sales by eighteen per cent of
 * every machine it ever bought, and understate its profit by the same — which
 * it would then pay less tax on, which is the kind of error that is discovered
 * expensively.
 *
 * ## Cost is per chassis, deliberately
 *
 * A consignment is several machines on one document and each one's cost is
 * relieved on its own sale. An average would be simpler and would report a
 * margin neither machine earned, and the stock valuation on the balance sheet
 * would drift from the units actually on the floor.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  purchaseInvoicesTable,
  purchaseInvoiceLinesTable,
  vouchersTable,
  voucherLinesTable,
  dmsVehicleStockTable,
  type PurchaseInvoiceRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { accountsByCode, ensureChart } from "./accounts";
import { openBill } from "./parties";
import { recordChassisEvent } from "./moves";
import { financialYearOf, nextVoucherNo, type Line, type PostResult } from "./post";
import { placementOf } from "../org";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const money = (v: number): string => v.toFixed(2);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

export interface PurchaseLineInput {
  modelDescription: string;
  chassisNo?: string | null;
  engineNo?: string | null;
  hsn?: string | null;
  quantity?: number;
  /** What this one machine cost, **before** tax. */
  unitCost: number;
  gstRatePct: number;
  cessRatePct?: number;
}

/**
 * Record the manufacturer's invoice. Draft until it is posted.
 *
 * The tax is computed **on top** here, which is the opposite of the sale side
 * and is correct: a purchase invoice states a taxable value and adds tax to it,
 * where an ex-showroom price includes tax and the taxable value is
 * back-calculated out of it. Those are two different documents written by two
 * different people, and treating them the same way is how one of them ends up
 * wrong by the rate.
 */
export async function createPurchaseInvoice(input: {
  ownerId: number;
  showroomId: number;
  supplierId: number;
  supplierInvoiceNo: string;
  invoiceDate: string;
  dueDate?: string | null;
  interState: boolean;
  lines: PurchaseLineInput[];
  otherCharges?: Array<{ label: string; amount: number }>;
  narration?: string | null;
  userId?: number | null;
}): Promise<{ ok: boolean; invoice?: PurchaseInvoiceRow; error?: string }> {
  if (input.lines.length === 0) {
    return { ok: false, error: "A purchase invoice with no lines records nothing." };
  }

  let taxable = 0;
  let gst = 0;
  let cess = 0;
  for (const l of input.lines) {
    const qty = l.quantity ?? 1;
    const value = round2(l.unitCost * qty);
    taxable = round2(taxable + value);
    gst = round2(gst + (value * l.gstRatePct) / 100);
    cess = round2(cess + (value * (l.cessRatePct ?? 0)) / 100);
  }

  /*
   * Intra-state splits the GST in halves and inter-state does not, and which
   * applies is where the supplier is rather than where we are. Honda shipping
   * from Haryana to a Delhi dealer is inter-state and carries IGST; the local
   * accessories supplier down the road carries CGST and SGST. Setting off the
   * wrong head against output tax is a mismatch the portal finds first.
   */
  const cgst = input.interState ? 0 : round2(gst / 2);
  const sgst = input.interState ? 0 : round2(gst - cgst);
  const igst = input.interState ? gst : 0;

  const charges = (input.otherCharges ?? []).filter(
    (c) => c.label && Number.isFinite(c.amount) && c.amount !== 0,
  );
  const otherTotal = round2(charges.reduce((a, c) => a + c.amount, 0));
  const total = round2(taxable + cgst + sgst + igst + cess + otherTotal);

  try {
    const [invoice] = await db
      .insert(purchaseInvoicesTable)
      .values({
        ownerId: input.ownerId,
        showroomId: input.showroomId,
        supplierId: input.supplierId,
        supplierInvoiceNo: input.supplierInvoiceNo.trim(),
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        interState: input.interState ? "Y" : "N",
        taxableAmount: money(taxable),
        cgstAmount: money(cgst),
        sgstAmount: money(sgst),
        igstAmount: money(igst),
        cessAmount: money(cess),
        otherCharges: charges.length ? charges : null,
        otherChargesTotal: money(otherTotal),
        totalAmount: money(total),
        narration: input.narration ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning();

    await db.insert(purchaseInvoiceLinesTable).values(
      input.lines.map((l, i) => ({
        purchaseInvoiceId: invoice!.id,
        seq: i + 1,
        modelDescription: l.modelDescription,
        chassisNo: l.chassisNo?.trim() || null,
        engineNo: l.engineNo?.trim() || null,
        hsn: l.hsn ?? null,
        quantity: l.quantity ?? 1,
        unitCost: money(l.unitCost),
        gstRatePct: String(l.gstRatePct),
        cessRatePct: String(l.cessRatePct ?? 0),
      })),
    );

    return { ok: true, invoice: invoice! };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === "23505") {
      const dup = cause.constraint?.includes("chassis")
        ? "One of these chassis numbers is already on another purchase invoice. A machine exists once, so it is bought once — a second entry would put a bike on the floor twice and into the stock valuation twice."
        : `Invoice ${input.supplierInvoiceNo} from this supplier is already recorded. A manufacturer does not issue the same number twice, so this is a re-entry, and a re-entered purchase doubles both the stock and the creditor.`;
      return { ok: false, error: dup };
    }
    throw err;
  }
}

/**
 * Post a purchase invoice to the ledger.
 *
 * Idempotent by the same partial unique index the sale uses — one *posted*
 * voucher per source document — so a retry loses at the database rather than
 * both attempts winning.
 */
export async function postPurchaseInvoice(input: {
  ownerId: number;
  purchaseInvoiceId: number;
  userId?: number | null;
}): Promise<PostResult> {
  const warnings: string[] = [];

  const [inv] = await db
    .select()
    .from(purchaseInvoicesTable)
    .where(
      and(
        eq(purchaseInvoicesTable.ownerId, input.ownerId),
        eq(purchaseInvoicesTable.id, input.purchaseInvoiceId),
      ),
    );
  if (!inv) return { ok: false, error: `No purchase invoice ${input.purchaseInvoiceId}`, warnings };
  if (inv.status === "CANCELLED") {
    return { ok: false, error: `Invoice ${inv.supplierInvoiceNo} is cancelled.`, warnings };
  }

  const placement = await placementOf(inv.showroomId);
  const booksFrom = placement.entity.booksFrom;
  if (booksFrom && inv.invoiceDate < booksFrom) {
    /*
     * Before the books begin is not a transaction, it is an opening balance.
     * Posting it would invent history the dealership already keeps elsewhere,
     * and the two would then both be partly right.
     */
    return {
      ok: false,
      error:
        `${inv.supplierInvoiceNo} is dated ${inv.invoiceDate}, before these books start on ${booksFrom}. ` +
        "Anything earlier belongs in the opening balances, not in a voucher.",
      warnings,
    };
  }

  await ensureChart(input.ownerId);
  const accounts = await accountsByCode(input.ownerId);
  const need = (code: string) => {
    const a = accounts.get(code);
    if (!a) throw new Error(`The ledger account ${code} is missing for this dealership.`);
    return a;
  };

  const lines: Line[] = [];
  const supplierRef = { partyId: inv.supplierId };

  const taxable = n(inv.taxableAmount);
  const cgst = n(inv.cgstAmount);
  const sgst = n(inv.sgstAmount);
  const igst = n(inv.igstAmount);
  const cess = n(inv.cessAmount);
  const otherTotal = n(inv.otherChargesTotal);
  const total = n(inv.totalAmount);

  /*
   * Which stock account, decided by what was bought.
   *
   * A consignment of motorcycles is `1200`; a carton of brake shoes is `1210`.
   * The two are different lines on a balance sheet and a dealership counting
   * them together cannot tell whether its money is tied up in bikes it cannot
   * sell or in parts it over-ordered.
   */
  const partsOnly = await db
    .select({ hsn: purchaseInvoiceLinesTable.hsn })
    .from(purchaseInvoiceLinesTable)
    .where(eq(purchaseInvoiceLinesTable.purchaseInvoiceId, inv.id));
  const isVehicles = partsOnly.some((l) => (l.hsn ?? "").startsWith("8711"));
  const stockCode = isVehicles ? "1200" : "1210";

  if (taxable > 0) {
    lines.push({
      accountCode: stockCode,
      debit: taxable,
      credit: 0,
      narration: `${inv.supplierInvoiceNo} — goods received`,
    });
  }

  // Freight and handling are part of what the stock cost, not a separate
  // expense: a bike is worth what it took to get it onto the floor.
  if (otherTotal > 0) {
    lines.push({
      accountCode: stockCode,
      debit: otherTotal,
      credit: 0,
      narration: (inv.otherCharges ?? []).map((c) => c.label).join(", ") || "Other charges",
    });
  }

  for (const [code, amount, label] of [
    ["1600", cgst, "Input CGST"],
    ["1610", sgst, "Input SGST"],
    ["1620", igst, "Input IGST"],
  ] as const) {
    if (amount > 0) lines.push({ accountCode: code, debit: amount, credit: 0, narration: label });
  }

  /*
   * Cess paid on a purchase is **not** an input credit against GST. It offsets
   * only output cess, and a two-wheeler dealership since September 2025 has no
   * output cess at all — so this sits in the stock cost rather than pretending
   * to be reclaimable. Claiming it would be claiming a credit that does not
   * exist.
   */
  if (cess > 0) {
    lines.push({
      accountCode: stockCode,
      debit: cess,
      credit: 0,
      narration: "Compensation cess — not creditable against GST, so it is part of the cost",
    });
    warnings.push(
      "Compensation cess on this purchase has been added to the stock cost rather than claimed as input credit. Cess offsets output cess only, and there is none on a two-wheeler since September 2025.",
    );
  }

  lines.push({
    accountCode: "2100",
    debit: 0,
    credit: total,
    narration: `Payable to supplier on ${inv.supplierInvoiceNo}`,
    ...supplierRef,
  });

  const totalDebit = round2(lines.reduce((a, l) => a + l.debit, 0));
  const totalCredit = round2(lines.reduce((a, l) => a + l.credit, 0));

  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    return {
      ok: false,
      error:
        `This purchase does not balance: debits ₹${totalDebit.toFixed(2)} against credits ₹${totalCredit.toFixed(2)}. ` +
        "Nothing has been posted.",
      warnings,
    };
  }

  const fy = financialYearOf(inv.invoiceDate);
  const voucherNo = await nextVoucherNo(input.ownerId, "PURCHASE", fy);

  try {
    const [voucher] = await db
      .insert(vouchersTable)
      .values({
        ownerId: input.ownerId,
        showroomId: inv.showroomId,
        kind: "PURCHASE",
        voucherNo,
        voucherDate: inv.invoiceDate,
        financialYear: fy,
        narration: `Purchase — ${inv.supplierInvoiceNo}`,
        sourceKind: "PURCHASE_INVOICE",
        sourceId: inv.id,
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

    await openBill({
      ownerId: input.ownerId,
      partyId: inv.supplierId,
      showroomId: inv.showroomId,
      direction: "PAYABLE",
      billNo: inv.supplierInvoiceNo,
      billDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      amount: total,
      sourceKind: "PURCHASE_INVOICE",
      sourceId: inv.id,
    });

    await db
      .update(purchaseInvoicesTable)
      .set({ status: "POSTED" })
      .where(eq(purchaseInvoicesTable.id, inv.id));

    /*
     * And the floor is told what it now holds.
     *
     * The stock mirror is the dealer's own system's view, and `costAmount` on it
     * is what a sale relieves. A purchase recorded here with no cost reaching
     * the mirror would leave the sale posting revenue and no cost of goods —
     * which is R-102's failure arriving through a different door.
     */
    let placed = 0;
    const lineRows = await db
      .select()
      .from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.purchaseInvoiceId, inv.id));

    for (const l of lineRows) {
      if (!l.chassisNo) continue;
      const res = await db
        .update(dmsVehicleStockTable)
        .set({ costAmount: money(n(l.unitCost)) })
        .where(
          and(
            eq(dmsVehicleStockTable.showroomId, inv.showroomId),
            eq(dmsVehicleStockTable.chassisNo, l.chassisNo),
          ),
        )
        .returning({ id: dmsVehicleStockTable.id });
      placed += res.length;

      // The register, which is written rather than derived: an auditor tracing
      // one machine wants received -> transferred -> sold on one page, and a
      // register assembled at read time would answer differently next March.
      await recordChassisEvent({
        ownerId: input.ownerId,
        chassisNo: l.chassisNo,
        showroomId: inv.showroomId,
        kind: "PURCHASED",
        eventDate: inv.invoiceDate,
        sourceKind: "PURCHASE_INVOICE",
        sourceId: inv.id,
        sourceRef: inv.supplierInvoiceNo,
        value: n(l.unitCost),
        narration: `${l.modelDescription} received`,
      });
    }
    if (lineRows.some((l) => l.chassisNo) && placed === 0) {
      warnings.push(
        "None of these chassis numbers are in this outlet's stock mirror, so their cost is recorded here and not against a unit on the floor. A sale of one will post revenue with no cost of goods until the mirror catches up.",
      );
    }

    logger.info(
      { ownerId: input.ownerId, purchaseInvoiceId: inv.id, voucherNo, units: placed },
      "Purchase posted to the ledger",
    );
    return { ok: true, voucher: voucher!, warnings };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "23505") {
      return {
        ok: false,
        error:
          "This purchase has already been posted. Correcting it means reversing the existing voucher and posting again — a posted voucher is never edited.",
        warnings,
      };
    }
    throw err;
  }
}

/**
 * What input credit is at risk, which is the tenth reconciliation's first half.
 *
 * A purchase in our books that has not appeared in GSTR-2B is credit the
 * supplier has not filed for, and it is only claimable if they do. Worth
 * chasing before the deadline rather than after, which is the entire reason
 * this is a report and not a footnote.
 */
export async function inputCreditAtRisk(input: {
  ownerId: number;
  from: string;
  to: string;
}): Promise<{
  rows: Array<{
    supplierInvoiceNo: string;
    invoiceDate: string;
    supplierId: number;
    credit: number;
    status: string;
  }>;
  total: number;
}> {
  const rows = await db
    .select({
      supplierInvoiceNo: purchaseInvoicesTable.supplierInvoiceNo,
      invoiceDate: purchaseInvoicesTable.invoiceDate,
      supplierId: purchaseInvoicesTable.supplierId,
      cgst: purchaseInvoicesTable.cgstAmount,
      sgst: purchaseInvoicesTable.sgstAmount,
      igst: purchaseInvoicesTable.igstAmount,
      status: purchaseInvoicesTable.gstr2bStatus,
    })
    .from(purchaseInvoicesTable)
    .where(
      and(
        eq(purchaseInvoicesTable.ownerId, input.ownerId),
        eq(purchaseInvoicesTable.status, "POSTED"),
        sql`${purchaseInvoicesTable.gstr2bStatus} <> 'MATCHED'`,
        sql`${purchaseInvoicesTable.invoiceDate}::text >= ${input.from}`,
        sql`${purchaseInvoicesTable.invoiceDate}::text <= ${input.to}`,
      ),
    );

  const out = rows.map((r) => ({
    supplierInvoiceNo: r.supplierInvoiceNo,
    invoiceDate: r.invoiceDate,
    supplierId: r.supplierId,
    credit: round2(n(r.cgst) + n(r.sgst) + n(r.igst)),
    status: r.status,
  }));

  return { rows: out, total: round2(out.reduce((a, r) => a + r.credit, 0)) };
}
