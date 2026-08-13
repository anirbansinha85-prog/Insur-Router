/**
 * Billing a job card (OBJ-42, R-123).
 *
 * A job card is a different document from a vehicle sale and this is the file
 * that admits it. A tax invoice for a motorcycle carries a chassis, one
 * ex-showroom price that already includes tax, and pass-through charges
 * collected for the RTO. A job card carries a registration plate, several lines
 * at **two classifications**, and a customer who may have left a deposit that
 * already attracted tax.
 *
 * ## Labour and parts, and the difference is not cosmetic
 *
 * ```
 *   labour   a service   SAC   credits 4300 Labour Income        no stock moves
 *   part     goods       HSN   credits 4200 Spare Parts Sales    1210 goes down
 * ```
 *
 * Both are 18% today. They were not before September 2025 and GSTR-1 reports
 * them under different codes in the same summary, so the distinction is carried
 * through to the ledger line rather than resolved away at the top.
 *
 * ## Prices here are exclusive, unlike a vehicle
 *
 * A workshop quotes labour at nine hundred rupees and adds tax; a showroom
 * quotes a bike at eighty-four thousand with the tax inside. Both are what the
 * trade means, and treating either the other way produces a document the
 * customer queries. So `taxWithin` is deliberately not used here.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  serviceInvoicesTable,
  serviceInvoiceLinesTable,
  moneyDocumentsTable,
  dmsPartStockTable,
  vouchersTable,
  voucherLinesTable,
  type ServiceInvoiceRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { accountsByCode, ensureChart } from "./accounts";
import { openBill } from "./parties";
import { financialYearOf, nextVoucherNo, type Line } from "./post";
import { placementOf } from "../org";
import { LABOUR_GST_PCT, SPARE_PART_GST_PCT } from "@workspace/quoting/tax";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const money = (v: number): string => v.toFixed(2);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * The service accounting codes.
 *
 * `9987` covers maintenance, repair and installation services, which is what a
 * two-wheeler workshop does. It is a default and sits on the line, so a
 * dealership doing something else can say so — the same posture the GST rate
 * takes on a price-list item.
 */
export const DEFAULT_LABOUR_SAC = "998714";

export interface ServiceLineInput {
  kind: "LABOUR" | "PART";
  description: string;
  sac?: string | null;
  hsn?: string | null;
  partNo?: string | null;
  quantity?: number;
  /** Per unit, **excluding** tax. A workshop quotes labour ex-tax. */
  unitRate: number;
  discount?: number;
  gstRatePct?: number;
  /** What the part cost. Relieved from 1210. Ignored on labour. */
  unitCost?: number | null;
  coverage?: "CUSTOMER" | "WARRANTY" | "FREE_SERVICE" | "GOODWILL";
}

export interface ServiceInvoiceResult {
  ok: boolean;
  invoice?: ServiceInvoiceRow;
  voucherId?: number;
  error?: string;
  warnings: string[];
}

async function nextServiceNo(ownerId: number, onDate: string): Promise<string> {
  const fy = financialYearOf(onDate);
  const [last] = await db
    .select({ no: serviceInvoicesTable.invoiceNo })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.ownerId, ownerId),
        sql`${serviceInvoicesTable.invoiceNo} like ${`SRV/${fy}/%`}`,
      ),
    )
    .orderBy(
      sql`length(${serviceInvoicesTable.invoiceNo}) desc`,
      sql`${serviceInvoicesTable.invoiceNo} desc`,
    )
    .limit(1);
  const next = last ? Number(last.no.split("/").pop()) + 1 : 1;
  return `SRV/${fy}/${String(next).padStart(4, "0")}`;
}

/**
 * Raise and post a service invoice.
 *
 * One call rather than create-then-post, unlike a purchase, because a workshop
 * bill is handed to a customer at the counter and there is no draft stage in
 * which it usefully sits. A vehicle sale has a quotation and a proforma before
 * it; a job card has a job that is either finished or not.
 */
export async function issueServiceInvoice(input: {
  ownerId: number;
  showroomId: number;
  customerId: number;
  invoiceDate: string;
  lines: ServiceLineInput[];
  jobCardRef?: string | null;
  registrationNo?: string | null;
  chassisNo?: string | null;
  modelDescription?: string | null;
  odometerKm?: number | null;
  customerGstin?: string | null;
  placeOfSupply?: string | null;
  /** A deposit taken earlier against this job, to come off what is payable. */
  advanceMoneyDocumentId?: number | null;
  narration?: string | null;
  userId?: number | null;
}): Promise<ServiceInvoiceResult> {
  const warnings: string[] = [];

  if (input.lines.length === 0) {
    return { ok: false, error: "A job card with no lines bills nothing.", warnings };
  }

  const placement = await placementOf(input.showroomId);

  /*
   * The setting that decides whether this document exists at all.
   *
   * If the dealership's service outlets bill through their own system, ours
   * issuing an invoice under the same GSTIN would put two documents into one
   * statutory series - which is R-90's failure with a different door on it.
   */
  if (placement.registration.serviceInvoicing !== "Y") {
    return {
      ok: false,
      error:
        `${placement.registration.gstin} is set to bill service through the dealership's own system, ` +
        "so this product does not issue workshop invoices for it. Two systems numbering one series " +
        "produces gaps or duplicates, and both are audit findings.",
      warnings,
    };
  }

  if (placement.entity.booksFrom && input.invoiceDate < placement.entity.booksFrom) {
    return {
      ok: false,
      error: `${input.invoiceDate} is before these books start on ${placement.entity.booksFrom}.`,
      warnings,
    };
  }

  const interState = Boolean(
    input.placeOfSupply &&
      input.placeOfSupply.trim().toLowerCase() !== placement.registration.state.trim().toLowerCase(),
  );

  interface Computed extends ServiceLineInput {
    seq: number;
    quantity: number;
    taxable: number;
    rate: number;
    cgst: number;
    sgst: number;
    igst: number;
    coverage: NonNullable<ServiceLineInput["coverage"]>;
  }

  const computed: Computed[] = input.lines.map((l, i) => {
    const quantity = l.quantity ?? 1;
    const coverage = l.coverage ?? "CUSTOMER";
    /*
     * Work done under warranty or a free service has a real cost and **no
     * revenue**: the customer is charged nothing and the dealership claims it
     * from the manufacturer. Billing him would be wrong and pretending the work
     * never happened would lose the claim.
     */
    const gross = coverage === "CUSTOMER" ? round2(l.unitRate * quantity) : 0;
    const taxable = round2(Math.max(0, gross - (coverage === "CUSTOMER" ? (l.discount ?? 0) : 0)));
    const rate =
      l.gstRatePct ?? (l.kind === "LABOUR" ? LABOUR_GST_PCT : SPARE_PART_GST_PCT);
    const tax = round2((taxable * rate) / 100);
    const cgst = interState ? 0 : round2(tax / 2);
    return {
      ...l,
      seq: i + 1,
      quantity,
      coverage,
      taxable,
      rate,
      cgst,
      sgst: interState ? 0 : round2(tax - cgst),
      igst: interState ? tax : 0,
    };
  });

  const labourAmount = round2(
    computed.filter((l) => l.kind === "LABOUR").reduce((a, l) => a + l.taxable, 0),
  );
  const partsAmount = round2(
    computed.filter((l) => l.kind === "PART").reduce((a, l) => a + l.taxable, 0),
  );
  const taxable = round2(labourAmount + partsAmount);
  const cgst = round2(computed.reduce((a, l) => a + l.cgst, 0));
  const sgst = round2(computed.reduce((a, l) => a + l.sgst, 0));
  const igst = round2(computed.reduce((a, l) => a + l.igst, 0));
  const total = round2(taxable + cgst + sgst + igst);

  /*
   * The deposit, and the tax already paid on it.
   *
   * An advance for a service attracted GST at receipt, so by now part of this
   * invoice's tax is already with the government. Charging it again would
   * charge the customer twice and overstate the month's output tax.
   */
  let advanceAdjusted = 0;
  let advanceTaxAdjusted = 0;
  if (input.advanceMoneyDocumentId) {
    const [adv] = await db
      .select()
      .from(moneyDocumentsTable)
      .where(
        and(
          eq(moneyDocumentsTable.ownerId, input.ownerId),
          eq(moneyDocumentsTable.id, input.advanceMoneyDocumentId),
        ),
      );
    if (!adv) {
      warnings.push(`No advance ${input.advanceMoneyDocumentId} was found, so nothing was adjusted.`);
    } else if (adv.partyId !== input.customerId) {
      return {
        ok: false,
        error: "That advance was taken from a different customer. Money from one cannot settle another's job.",
        warnings,
      };
    } else {
      advanceAdjusted = Math.min(round2(n(adv.unallocated)), total);
      // The advance was taken inclusive of tax, so the tax inside it comes out
      // by the same proportion the ledger credited when it was received.
      const rate = adv.advanceFor === "SERVICE" ? LABOUR_GST_PCT : 0;
      advanceTaxAdjusted = rate
        ? round2(advanceAdjusted - advanceAdjusted / (1 + rate / 100))
        : 0;
      warnings.push(
        `₹${advanceAdjusted.toFixed(2)} of ${adv.documentNo} has come off this bill` +
          (advanceTaxAdjusted > 0
            ? `, including ₹${advanceTaxAdjusted.toFixed(2)} of GST already paid when the deposit was taken.`
            : "."),
      );
    }
  }

  const payable = round2(total - advanceAdjusted);
  const invoiceNo = await nextServiceNo(input.ownerId, input.invoiceDate);

  await ensureChart(input.ownerId);
  const accounts = await accountsByCode(input.ownerId);
  const need = (code: string) => {
    const a = accounts.get(code);
    if (!a) throw new Error(`The ledger account ${code} is missing for this dealership.`);
    return a;
  };

  const lines: Line[] = [];
  const partyRef = { partyId: input.customerId, partyGstin: input.customerGstin ?? null };

  if (total > 0) {
    lines.push({
      accountCode: "1100",
      debit: total,
      credit: 0,
      narration: `Service invoice ${invoiceNo}`,
      ...partyRef,
    });
  }
  if (labourAmount > 0) {
    lines.push({
      accountCode: "4300",
      debit: 0,
      credit: labourAmount,
      narration: "Labour",
      hsn: computed.find((l) => l.kind === "LABOUR")?.sac ?? DEFAULT_LABOUR_SAC,
      taxRatePct: LABOUR_GST_PCT,
    });
  }
  if (partsAmount > 0) {
    lines.push({
      accountCode: "4200",
      debit: 0,
      credit: partsAmount,
      narration: "Parts",
      hsn: computed.find((l) => l.kind === "PART")?.hsn ?? null,
      taxRatePct: SPARE_PART_GST_PCT,
    });
  }
  if (cgst > 0) lines.push({ accountCode: "2200", debit: 0, credit: cgst });
  if (sgst > 0) lines.push({ accountCode: "2210", debit: 0, credit: sgst });
  if (igst > 0) lines.push({ accountCode: "2220", debit: 0, credit: igst });

  /*
   * Parts fitted come off the shelf, at cost.
   *
   * `1210` Spare Parts Stock has exactly the defect `1200` had before OBJ-38 if
   * nothing ever credits it. Warranty and free-service parts are relieved too,
   * because the shelf does not care who paid - the cost is real either way, and
   * it is the manufacturer's claim that makes it back.
   */
  const partsCost = round2(
    computed
      .filter((l) => l.kind === "PART")
      .reduce((a, l) => a + round2((l.unitCost ?? 0) * l.quantity), 0),
  );
  if (partsCost > 0) {
    lines.push({
      accountCode: "5110",
      debit: partsCost,
      credit: 0,
      narration: "Cost of parts issued",
    });
    lines.push({ accountCode: "1210", debit: 0, credit: partsCost, narration: "Parts issued" });
  } else if (computed.some((l) => l.kind === "PART")) {
    warnings.push(
      "No cost was recorded against the parts on this job, so they have been billed without relieving spare parts stock. Until it is, the whole of the parts revenue reads as margin.",
    );
  }

  /*
   * The advance moves from a liability to settling the debt this invoice just
   * created, and the tax charged on it earlier is reversed so it is not
   * collected twice.
   */
  if (advanceAdjusted > 0) {
    lines.push({
      accountCode: "2400",
      debit: round2(advanceAdjusted - advanceTaxAdjusted),
      credit: 0,
      narration: "Advance applied to this job",
      ...partyRef,
    });
    if (advanceTaxAdjusted > 0) {
      const half = round2(advanceTaxAdjusted / 2);
      lines.push({
        accountCode: "2200",
        debit: half,
        credit: 0,
        narration: "GST already paid on the deposit",
      });
      lines.push({
        accountCode: "2210",
        debit: round2(advanceTaxAdjusted - half),
        credit: 0,
        narration: "GST already paid on the deposit",
      });
    }
    lines.push({
      accountCode: "1100",
      debit: 0,
      credit: advanceAdjusted,
      narration: "Advance set against this invoice",
      ...partyRef,
    });
  }

  const totalDebit = round2(lines.reduce((a, l) => a + l.debit, 0));
  const totalCredit = round2(lines.reduce((a, l) => a + l.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    return {
      ok: false,
      error: `This job card does not balance: ₹${totalDebit.toFixed(2)} against ₹${totalCredit.toFixed(2)}. Nothing has been posted.`,
      warnings,
    };
  }

  const fy = financialYearOf(input.invoiceDate);
  const voucherNo = await nextVoucherNo(input.ownerId, "SALES", fy);

  const [voucher] = await db
    .insert(vouchersTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      kind: "SALES",
      voucherNo,
      voucherDate: input.invoiceDate,
      financialYear: fy,
      narration: `Service ${invoiceNo}${input.registrationNo ? ` — ${input.registrationNo}` : ""}`,
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
        hsn: l.hsn ?? null,
        taxRatePct: l.taxRatePct == null ? null : String(l.taxRatePct),
      };
    }),
  );

  const [invoice] = await db
    .insert(serviceInvoicesTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      customerId: input.customerId,
      invoiceNo,
      invoiceDate: input.invoiceDate,
      jobCardRef: input.jobCardRef ?? null,
      registrationNo: input.registrationNo ?? null,
      chassisNo: input.chassisNo ?? null,
      modelDescription: input.modelDescription ?? null,
      odometerKm: input.odometerKm ?? null,
      placeOfSupply: input.placeOfSupply ?? placement.registration.state,
      customerGstin: input.customerGstin ?? null,
      labourAmount: money(labourAmount),
      partsAmount: money(partsAmount),
      taxableAmount: money(taxable),
      cgstAmount: money(cgst),
      sgstAmount: money(sgst),
      igstAmount: money(igst),
      advanceAdjusted: money(advanceAdjusted),
      advanceTaxAdjusted: money(advanceTaxAdjusted),
      totalAmount: money(total),
      payableAmount: money(payable),
      sellerLegalName: placement.entity.legalName,
      sellerGstin: placement.registration.gstin,
      voucherId: voucher!.id,
      narration: input.narration ?? null,
      issuedByUserId: input.userId ?? null,
    })
    .returning();

  await db.insert(serviceInvoiceLinesTable).values(
    computed.map((l) => ({
      serviceInvoiceId: invoice!.id,
      seq: l.seq,
      kind: l.kind,
      description: l.description,
      sac: l.kind === "LABOUR" ? (l.sac ?? DEFAULT_LABOUR_SAC) : null,
      hsn: l.kind === "PART" ? (l.hsn ?? null) : null,
      partNo: l.partNo ?? null,
      quantity: String(l.quantity),
      unitRate: money(l.unitRate),
      discount: money(l.discount ?? 0),
      taxableAmount: money(l.taxable),
      gstRatePct: String(l.rate),
      cgstAmount: money(l.cgst),
      sgstAmount: money(l.sgst),
      igstAmount: money(l.igst),
      unitCost: l.unitCost == null ? null : money(l.unitCost),
      coverage: l.coverage,
    })),
  );

  if (payable > 0) {
    await openBill({
      ownerId: input.ownerId,
      partyId: input.customerId,
      showroomId: input.showroomId,
      direction: "RECEIVABLE",
      billNo: invoiceNo,
      billDate: input.invoiceDate,
      amount: payable,
      sourceKind: "MANUAL",
      sourceId: null,
    });
  }

  /* Parts off the shelf in the mirror too, so the stock report agrees. */
  for (const l of computed.filter((x) => x.kind === "PART" && x.partNo)) {
    await db
      .update(dmsPartStockTable)
      .set({ qtyOnHand: sql`greatest(0, ${dmsPartStockTable.qtyOnHand} - ${Math.round(l.quantity)})` })
      .where(
        and(
          eq(dmsPartStockTable.showroomId, input.showroomId),
          eq(dmsPartStockTable.partNo, l.partNo!),
        ),
      );
  }

  logger.info(
    { ownerId: input.ownerId, invoiceNo, voucherNo, labourAmount, partsAmount },
    "Service invoice issued",
  );
  return { ok: true, invoice: invoice!, voucherId: voucher!.id, warnings };
}

/**
 * What the manufacturer owes for warranty and free-service work.
 *
 * Cost incurred with no revenue against it, which is only not a loss because
 * there is a claim behind it. This is the list that feeds the OEM
 * reconciliation, and it names the job cards rather than a total (R-114) —
 * warranty money is exactly where a dealer's income quietly goes missing.
 */
export async function warrantyClaimable(input: {
  ownerId: number;
  from: string;
  to: string;
}): Promise<{
  rows: Array<{
    invoiceNo: string;
    invoiceDate: string;
    registrationNo: string | null;
    coverage: string;
    description: string;
    value: number;
  }>;
  total: number;
}> {
  const rows = await db
    .select({
      invoiceNo: serviceInvoicesTable.invoiceNo,
      invoiceDate: serviceInvoicesTable.invoiceDate,
      registrationNo: serviceInvoicesTable.registrationNo,
      coverage: serviceInvoiceLinesTable.coverage,
      description: serviceInvoiceLinesTable.description,
      quantity: serviceInvoiceLinesTable.quantity,
      unitRate: serviceInvoiceLinesTable.unitRate,
    })
    .from(serviceInvoiceLinesTable)
    .innerJoin(
      serviceInvoicesTable,
      eq(serviceInvoiceLinesTable.serviceInvoiceId, serviceInvoicesTable.id),
    )
    .where(
      and(
        eq(serviceInvoicesTable.ownerId, input.ownerId),
        eq(serviceInvoicesTable.status, "ISSUED"),
        sql`${serviceInvoiceLinesTable.coverage} in ('WARRANTY','FREE_SERVICE')`,
        sql`${serviceInvoicesTable.invoiceDate}::text >= ${input.from}`,
        sql`${serviceInvoicesTable.invoiceDate}::text <= ${input.to}`,
      ),
    )
    .orderBy(asc(serviceInvoicesTable.invoiceDate));

  const out = rows.map((r) => ({
    invoiceNo: r.invoiceNo,
    invoiceDate: r.invoiceDate,
    registrationNo: r.registrationNo,
    coverage: r.coverage,
    description: r.description,
    value: round2(n(r.unitRate) * n(r.quantity)),
  }));

  return { rows: out, total: round2(out.reduce((a, r) => a + r.value, 0)) };
}

/** One job card's lines, so a document can be reprinted exactly. */
export async function serviceInvoiceLines(serviceInvoiceId: number) {
  return db
    .select()
    .from(serviceInvoiceLinesTable)
    .where(eq(serviceInvoiceLinesTable.serviceInvoiceId, serviceInvoiceId))
    .orderBy(asc(serviceInvoiceLinesTable.seq));
}
