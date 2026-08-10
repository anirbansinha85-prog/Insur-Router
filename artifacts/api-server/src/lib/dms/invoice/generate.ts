/**
 * The document DDMS issues.
 *
 * > **DDMS's document is the DMS's facts plus the commercial agreement, and
 * > neither system holds both.** The DMS does not know what was promised; DDMS
 * > does not know the chassis and the tax split. Only the join produces the
 * > document the customer should get.
 *
 * ## One door
 *
 * This function is the only thing that writes a `sale_documents` row, and it is
 * called by a person's button (R-81). When a journey later wants an invoice
 * raised, it calls **this**, with a person's consent behind it — it does not
 * grow a second path to the same table. That rule is what made every question
 * about who may do what deferrable, and this is the first place it would have
 * been tempting to break.
 *
 * ## Three decisions the product refuses to make
 *
 * Which list to price from, how much of the dealer's own margin to give away,
 * and whether to pass on the manufacturer's scheme. All three are commercial
 * decisions belonging to whoever runs the business, and the product's job is to
 * support them and record them — not to have an opinion, and not to prevent
 * one.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  dmsDealsTable,
  showroomsTable,
  saleDocumentsTable,
  type SaleDocumentRow,
} from "@workspace/db";
import { logger } from "../../logger";
import { may, whyNot } from "../permissions";
import type { ResolvedPolicy } from "../policy";
import { money, priceFor, round2, taxOn } from "./pricing";
import { decideKind, nextReference, nextTaxInvoiceNo } from "./series";

export interface GenerateInput {
  ownerId: number;
  showroomId: number;
  dealerCode: string;
  dealId: string;
  /** `SALE` becomes a tax invoice or a sale confirmation depending on the series. */
  intent: "SALE" | "QUOTATION" | "PROFORMA";
  /** The dealer's choice of list. Absent means the current one. */
  priceListId?: number | null;
  /** The dealer's own margin, given away. His decision. */
  dealerDiscount?: number;
  /**
   * The manufacturer's scheme on this unit, and how much of it reached the
   * customer. **The two are separate numbers and that is the objective** — the
   * claim is owed on the full amount whatever was passed on (R-88).
   */
  oemSchemeAmount?: number;
  oemSchemePassedOn?: number;
  otherCharges?: Array<{ label: string; amount: number }>;
  /** Where the customer is taking delivery. Decides CGST+SGST against IGST. */
  placeOfSupply?: string | null;
  onDate?: string;

  userId: number;
  userName: string | null;
  principal: string;
  policy: ResolvedPolicy;
}

export type GenerateResult =
  | { ok: true; document: SaleDocumentRow; warnings: string[] }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

export async function generateDocument(input: GenerateInput): Promise<GenerateResult> {
  if (!may(input.principal, "invoice.generate")) {
    return { ok: false, status: 403, error: whyNot(input.principal, "invoice.generate") };
  }

  const onDate = input.onDate ?? new Date().toISOString().slice(0, 10);

  const [deal] = await db
    .select()
    .from(dmsDealsTable)
    .where(
      and(eq(dmsDealsTable.dealerCode, input.dealerCode), eq(dmsDealsTable.dealId, input.dealId)),
    )
    .limit(1);

  if (!deal) {
    return { ok: false, status: 404, error: `No deal ${input.dealId} at ${input.dealerCode}.` };
  }
  if (!deal.modelDescription) {
    return { ok: false, status: 400, error: "The deal carries no model, so there is nothing to price." };
  }

  const priced = await priceFor({
    ownerId: input.ownerId,
    showroomId: deal.showroomId,
    modelDescription: deal.modelDescription,
    onDate,
    preferListId: input.priceListId ?? null,
  });

  if (!priced) {
    return {
      ok: false,
      status: 400,
      error: input.priceListId
        ? "That price list does not cover this model."
        : `No price list covers ${deal.modelDescription} on ${onDate}.`,
    };
  }

  const decision = decideKind(input.intent, input.policy);
  const warnings: string[] = [];

  /*
   * A sale confirmation with no DMS invoice number to point at.
   *
   * Not refused, because the dealer may genuinely be issuing his document
   * first — but said out loud, because the whole purpose of that document is
   * to be reconcilable against the one the DMS issued, and a linkage field
   * left empty is a reconciliation nobody can do later.
   */
  if (decision.kind === "SALE_CONFIRMATION" && !deal.invoiceNo) {
    warnings.push(
      "The dealer's own system has not invoiced this deal yet, so this document has no tax invoice number to reference.",
    );
  }

  if (!priced.isCurrent) {
    warnings.push(
      `Priced from "${priced.list.name}", effective ${priced.list.effectiveFrom}, which is not the current list.` +
        (priced.currentAmount !== null
          ? ` The current list says ₹${priced.currentAmount.toLocaleString("en-IN")}.`
          : ""),
    );
  }

  /*
   * Only a **sale** may already exist, and the first version of this checked
   * only the status.
   *
   * The comment said *a dealership may quote the same customer five times and
   * often should* and the query did not agree with it: any issued document
   * blocked, so a salesman quoting a customer in the morning made the deal
   * un-invoiceable for the rest of the day. Caught by doing exactly that
   * through the API rather than by reading the code, which is the argument for
   * driving the routes rather than only the library.
   */
  if (decision.kind === "TAX_INVOICE" || decision.kind === "SALE_CONFIRMATION") {
    const [existing] = await db
      .select({ reference: saleDocumentsTable.reference, status: saleDocumentsTable.status })
      .from(saleDocumentsTable)
      .where(
        and(
          eq(saleDocumentsTable.dealerCode, input.dealerCode),
          eq(saleDocumentsTable.dealId, input.dealId),
          eq(saleDocumentsTable.status, "ISSUED"),
          inArray(saleDocumentsTable.kind, ["TAX_INVOICE", "SALE_CONFIRMATION"]),
        ),
      )
      .limit(1);

    if (existing) {
      return {
        ok: false,
        status: 409,
        error: `${existing.reference} has already been issued for this deal. Cancel it before issuing another.`,
      };
    }
  }

  const [showroom] = await db
    .select()
    .from(showroomsTable)
    .where(eq(showroomsTable.id, deal.showroomId))
    .limit(1);

  const exShowroom = money(priced.item.exShowroomAmount);
  const dealerDiscount = round2(Math.max(0, input.dealerDiscount ?? 0));
  const schemeAmount = round2(Math.max(0, input.oemSchemeAmount ?? 0));
  const schemePassedOn = round2(Math.max(0, Math.min(input.oemSchemePassedOn ?? 0, schemeAmount)));

  if ((input.oemSchemePassedOn ?? 0) > schemeAmount) {
    warnings.push(
      "More of the manufacturer's scheme was recorded as passed on than the scheme is worth; it has been capped at the scheme amount.",
    );
  }

  /*
   * What the customer actually pays, and what the dealer is still owed.
   *
   * The taxable value is reduced by **what the customer was given** — his own
   * discount plus whatever of the scheme was passed on. The scheme the dealer
   * kept never reaches this line, because the customer was never given it.
   *
   * And `oemSchemeAmount` stays on the row at its full value whatever happened
   * here. That is R-88 and it is money: the claim to the manufacturer is owed
   * on the scheme, not on the part of it that reached the customer, and a
   * dealer who retained it has made a commercial decision and is still owed the
   * whole thing. An unclaimed scheme is money given away twice.
   */
  const givenToCustomer = round2(dealerDiscount + schemePassedOn);
  const taxable = round2(Math.max(0, exShowroom - givenToCustomer));

  const gstRate = money(priced.item.gstRatePct);
  const cessRate = money(priced.item.cessRatePct);
  const placeOfSupply = input.placeOfSupply ?? showroom?.state ?? null;

  /*
   * Inter-state when the place of supply differs from where the dealership is.
   *
   * The honest limit: the deal mirror carries no customer address, so unless a
   * caller says otherwise this resolves to the outlet's own state and the
   * document is intra-state. That is right for the overwhelming majority of
   * two-wheeler retail and wrong for some of it, so the field is an input
   * rather than an assumption, and the document records the answer.
   */
  const interState = Boolean(
    placeOfSupply && showroom?.state && placeOfSupply.trim().toLowerCase() !== showroom.state.trim().toLowerCase(),
  );

  const tax = taxOn({ taxable, gstRatePct: gstRate, cessRatePct: cessRate, interState });

  const otherCharges = (input.otherCharges ?? []).filter((c) => c.label && Number.isFinite(c.amount));
  const otherTotal = round2(otherCharges.reduce((n, c) => n + c.amount, 0));

  const total = round2(taxable + tax.total + otherTotal);

  const reference = await nextReference(input.ownerId, decision.kind, onDate);
  const taxInvoiceNo = decision.ddmsHoldsSeries
    ? await nextTaxInvoiceNo(input.ownerId, onDate)
    : null;

  const [row] = await db
    .insert(saleDocumentsTable)
    .values({
      ownerId: input.ownerId,
      showroomId: deal.showroomId,
      kind: decision.kind,
      reference,
      taxInvoiceNo,
      // Carried for linkage on every kind that is not our own tax invoice.
      dmsInvoiceNo: decision.ddmsHoldsSeries ? null : deal.invoiceNo,
      documentDate: onDate,

      dealerCode: deal.dealerCode,
      dealId: deal.dealId,
      customerName: deal.customerName,
      customerMobile: deal.customerMobile,
      customerAddress: null,

      modelDescription: deal.modelDescription,
      chassisNo: deal.chassisNo,
      engineNo: deal.engineNo,
      hsn: priced.item.hsn,

      priceListId: priced.list.id,
      priceListName: priced.list.name,
      priceListEffectiveFrom: priced.list.effectiveFrom,
      pricedOffCurrentList: priced.isCurrent ? "Y" : "N",

      exShowroomAmount: String(exShowroom),
      dealerDiscount: String(dealerDiscount),
      oemSchemeAmount: String(schemeAmount),
      oemSchemePassedOn: String(schemePassedOn),

      taxableAmount: String(taxable),
      gstRatePct: String(gstRate),
      cessRatePct: String(cessRate),
      cgstAmount: String(tax.cgst),
      sgstAmount: String(tax.sgst),
      igstAmount: String(tax.igst),
      cessAmount: String(tax.cess),

      otherCharges: otherCharges.length ? otherCharges : null,
      otherChargesTotal: String(otherTotal),
      totalAmount: String(total),

      sellerLegalName: showroom?.legalName ?? showroom?.name ?? null,
      sellerGstin: showroom?.gstin ?? null,
      placeOfSupply,

      status: "ISSUED",
      issuedByUserId: input.userId,
      issuedByName: input.userName,
    })
    .returning();

  logger.info(
    {
      reference,
      kind: decision.kind,
      dealId: deal.dealId,
      taxInvoiceNo,
      total,
      pricedOffCurrentList: !priced.isCurrent,
    },
    "Sale document issued",
  );

  return { ok: true, document: row!, warnings };
}

/**
 * Cancelled, never deleted, and the number stays spent.
 *
 * A sequential series with a hole in it is an audit finding, so a cancelled tax
 * invoice keeps its number and says it was cancelled — the same argument as a
 * cancelled outbox message staying a row. *We chose not to issue this* and
 * *nobody ever issued anything* are different facts and only one of them can be
 * defended later.
 */
export async function cancelDocument(input: {
  ownerId: number;
  id: number;
  reason: string;
  principal: string;
}): Promise<{ ok: true; document: SaleDocumentRow } | { ok: false; status: 403 | 404 | 400; error: string }> {
  if (!may(input.principal, "invoice.generate")) {
    return { ok: false, status: 403, error: whyNot(input.principal, "invoice.generate") };
  }
  const reason = input.reason.trim();
  if (!reason) {
    return { ok: false, status: 400, error: "Say why it is being cancelled — the number stays spent either way." };
  }

  const [row] = await db
    .update(saleDocumentsTable)
    .set({ status: "CANCELLED", cancelledReason: reason })
    .where(and(eq(saleDocumentsTable.id, input.id), eq(saleDocumentsTable.ownerId, input.ownerId)))
    .returning();

  if (!row) return { ok: false, status: 404, error: "No such document." };
  return { ok: true, document: row };
}

/**
 * What the manufacturer still owes this dealership (R-88).
 *
 * The number nobody currently has, because it lives in two places at once: the
 * scheme is the manufacturer's and the decision about passing it on is the
 * dealer's, and only DDMS's document holds both. A dealer who kept the scheme
 * on forty units and never claimed it has given the money away twice.
 */
export async function unclaimedSchemes(
  ownerId: number,
  showroomIds: number[],
): Promise<{
  documents: Array<{
    reference: string;
    dealId: string;
    modelDescription: string | null;
    schemeAmount: number;
    passedOn: number;
    retained: number;
    documentDate: string;
  }>;
  totalClaimable: number;
  totalRetained: number;
}> {
  if (showroomIds.length === 0) {
    return { documents: [], totalClaimable: 0, totalRetained: 0 };
  }

  const rows = await db
    .select()
    .from(saleDocumentsTable)
    .where(and(eq(saleDocumentsTable.ownerId, ownerId), eq(saleDocumentsTable.status, "ISSUED")));

  const documents = rows
    .filter((r) => showroomIds.includes(r.showroomId) && money(r.oemSchemeAmount) > 0)
    .map((r) => ({
      reference: r.reference,
      dealId: r.dealId,
      modelDescription: r.modelDescription,
      schemeAmount: money(r.oemSchemeAmount),
      passedOn: money(r.oemSchemePassedOn),
      retained: round2(money(r.oemSchemeAmount) - money(r.oemSchemePassedOn)),
      documentDate: r.documentDate,
    }));

  return {
    documents,
    // The full scheme on every unit, because that is what is owed.
    totalClaimable: round2(documents.reduce((n, d) => n + d.schemeAmount, 0)),
    totalRetained: round2(documents.reduce((n, d) => n + d.retained, 0)),
  };
}
