/**
 * The document DDMS issues.
 *
 * > **DDMS's document is the facts of the sale plus the commercial agreement,
 * > and no one system holds both.** A manufacturer's system does not know what
 * > was promised; DDMS does not know the chassis and the tax split. Only the
 * > join produces the document the customer should get.
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
 * ## It no longer knows where the facts came from (OBJ-30, R-96)
 *
 * The first version read `dms_deals` and returned 404 when the deal was not
 * there, which quietly meant *this product issues invoices for dealerships that
 * already have a system issuing invoices*. The sub-dealer doing five units a
 * month — the customer the standalone generator exists for — has no DMS, no
 * mirror and no deal row, and was excluded by the one line that looked up the
 * deal.
 *
 * So the facts arrive as a `SaleFacts` (`facts.ts`) and the price as a `Priced`
 * (`pricing.ts`), and **this file imports neither the deal mirror nor a price
 * list**. Everything below the resolution is identical on both paths, which is
 * the claim `verify:invoice` proves by issuing the same sale twice, once from
 * each, and comparing every figure.
 *
 * ## Three decisions the product refuses to make
 *
 * Which list to price from, how much of the dealer's own margin to give away,
 * and whether to pass on the manufacturer's scheme. All three are commercial
 * decisions belonging to whoever runs the business, and the product's job is to
 * support them and record them — not to have an opinion, and not to prevent
 * one.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  showroomsTable,
  saleDocumentsTable,
  type SaleDocumentRow,
} from "@workspace/db";
import { logger } from "../../logger";
import { may, whyNot } from "../permissions";
import type { ResolvedPolicy } from "../policy";
import { money, resolvePrice, round2, taxOn, type StatedPrice } from "./pricing";
import { decideKind, nextReference, nextTaxInvoiceNo } from "./series";
import {
  doubtful,
  factsFromForm,
  factsFromMirror,
  type FormFacts,
  type SaleFacts,
} from "./facts";

export interface GenerateInput {
  ownerId: number;
  showroomId: number;

  /**
   * Where the facts come from — **exactly one of these three**.
   *
   * `dealerCode` + `dealId` names a mirrored deal. `sale` is a form somebody
   * filled in. `facts` is a resolved set, which is how a caller that already
   * has them (the verifier proving both paths agree, or a journey acting on a
   * deal it has just read) avoids a second lookup.
   */
  dealerCode?: string | null;
  dealId?: string | null;
  sale?: FormFacts | null;
  facts?: SaleFacts | null;

  /** `SALE` becomes a tax invoice or a sale confirmation depending on the series. */
  intent: "SALE" | "QUOTATION" | "PROFORMA";
  /** The dealer's choice of list. Absent means the current one. */
  priceListId?: number | null;
  /**
   * The price, HSN and rates typed onto this document, for a dealership that
   * has no price list yet — or one overriding the list it has, which is his
   * decision and is warned about rather than refused.
   */
  statedPrice?: StatedPrice | null;
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
  const warnings: string[] = [];

  /*
   * Resolve the facts, and then forget which door they came through.
   *
   * Exactly one of the three, checked rather than assumed: a caller passing
   * both a deal reference and a typed sale has two different sales in mind, and
   * silently picking one would issue a tax invoice for whichever the code
   * happened to test first.
   */
  const asked = [
    input.facts ? "facts" : null,
    input.sale ? "sale" : null,
    input.dealerCode || input.dealId ? "deal" : null,
  ].filter(Boolean);

  if (asked.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        "Say what is being invoiced - either a deal from the dealer's own system, or the sale itself.",
    };
  }
  if (asked.length > 1) {
    return {
      ok: false,
      status: 400,
      error: `Two sales were described at once (${asked.join(" and ")}). Send one.`,
    };
  }

  let facts: SaleFacts;
  if (input.facts) {
    facts = input.facts;
  } else if (input.sale) {
    const resolved = factsFromForm({ ...input.sale, showroomId: input.showroomId });
    if (!resolved.ok) return resolved;
    facts = resolved.facts;
  } else {
    const resolved = await factsFromMirror({
      dealerCode: String(input.dealerCode ?? ""),
      dealId: String(input.dealId ?? ""),
    });
    if (!resolved.ok) return resolved;
    facts = resolved.facts;
  }

  if (!facts.modelDescription) {
    return {
      ok: false,
      status: 400,
      error: "The sale carries no model, so there is nothing to price.",
    };
  }

  const decision = decideKind(input.intent, input.policy);

  /*
   * R-97, and the only place in this product where provenance blocks rather
   * than annotates.
   *
   * > **A figure that reaches a statutory return was confirmed by a person or
   * > returned by an API. A model's read is a proposal.**
   *
   * A chassis number a model lifted off a scan at 55% goes onto a tax invoice,
   * from there to the RTO, and into GSTR-1. Being wrong there is a filing
   * offence rather than a bad morning, so the refusal names the fields and says
   * what to do about them - VeloDocs already has the screen for confirming
   * them, and OBJ-24 already writes the confidence beside the value (R-85).
   *
   * A quotation is not a statutory document, so it warns instead. The gate is
   * on the **consequence**, not on the provenance, which is the whole of R-97:
   * the same 55% read is perfectly fine on a quotation.
   */
  const unsure = doubtful(facts);
  if (unsure.length > 0) {
    const named = unsure.map((u) => `${u.field} (${Math.round(u.confidence * 100)}%)`).join(", ");
    if (decision.kind === "TAX_INVOICE" || decision.kind === "SALE_CONFIRMATION") {
      const how = facts.ingestPath === "DOCUMENT" ? "a scan" : "an exported report";
      return {
        ok: false,
        status: 400,
        error:
          `These were read off ${how} and nobody has confirmed them yet: ${named}. ` +
          "Check them against the paperwork before this goes on an invoice - a figure a model read is a proposal until a person says otherwise.",
      };
    }
    warnings.push(`Not yet confirmed by anybody: ${named}.`);
  }

  const price = await resolvePrice({
    ownerId: input.ownerId,
    showroomId: facts.showroomId,
    modelDescription: facts.modelDescription,
    onDate,
    preferListId: input.priceListId ?? null,
    stated: input.statedPrice ?? null,
  });

  if (!price.ok) {
    return { ok: false, status: 400, error: price.error };
  }
  const priced = price.priced;
  warnings.push(...price.warnings);

  /*
   * A sale confirmation with no invoice number to point at.
   *
   * Not refused, because the dealer may genuinely be issuing his own document
   * first - but said out loud, because the whole purpose of that document is to
   * be reconcilable against the one the other system issued, and a linkage
   * field left empty is a reconciliation nobody can do later.
   *
   * A dealership with no other system at all is a different case and gets a
   * different sentence: nothing is missing, the switch is simply off, and the
   * fix is to turn it on rather than to go looking for a number that was never
   * going to exist.
   */
  if (decision.kind === "SALE_CONFIRMATION" && !facts.dmsInvoiceNo) {
    warnings.push(
      facts.origin === "FORM"
        ? "This is a sale confirmation rather than a tax invoice, because this dealership's tax series is not DDMS's to hold. With no other system issuing one, the sale has no tax invoice at all - turn the series switch on if DDMS should be issuing it."
        : "The dealer's own system has not invoiced this deal yet, so this document has no tax invoice number to reference.",
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
   *
   * The subject is matched on **both** halves of its key including the null.
   * `dealer_code = null` is not a comparison SQL ever satisfies, so a
   * sub-dealer's documents would never have collided with each other and the
   * same frame could have been invoiced twice - with the check appearing to run
   * and quietly returning nothing, every time.
   */
  if (decision.kind === "TAX_INVOICE" || decision.kind === "SALE_CONFIRMATION") {
    const [existing] = await db
      .select({ reference: saleDocumentsTable.reference, status: saleDocumentsTable.status })
      .from(saleDocumentsTable)
      .where(
        and(
          eq(saleDocumentsTable.ownerId, input.ownerId),
          facts.dealerCode
            ? eq(saleDocumentsTable.dealerCode, facts.dealerCode)
            : isNull(saleDocumentsTable.dealerCode),
          eq(saleDocumentsTable.dealId, facts.dealId),
          eq(saleDocumentsTable.status, "ISSUED"),
          inArray(saleDocumentsTable.kind, ["TAX_INVOICE", "SALE_CONFIRMATION"]),
        ),
      )
      .limit(1);

    if (existing) {
      return {
        ok: false,
        status: 409,
        error: `${existing.reference} has already been issued for this sale. Cancel it before issuing another.`,
      };
    }
  }

  const [showroom] = await db
    .select()
    .from(showroomsTable)
    .where(eq(showroomsTable.id, facts.showroomId))
    .limit(1);

  const exShowroom = priced.exShowroomAmount;
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
   * The taxable value is reduced by **what the customer was given** - his own
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

  const gstRate = priced.gstRatePct;
  const cessRate = priced.cessRatePct;
  const placeOfSupply = input.placeOfSupply ?? showroom?.state ?? null;

  /*
   * Inter-state when the place of supply differs from where the dealership is.
   *
   * The honest limit: a mirrored deal carries no customer address, so unless a
   * caller says otherwise this resolves to the outlet's own state and the
   * document is intra-state. That is right for the overwhelming majority of
   * two-wheeler retail and wrong for some of it, so the field is an input
   * rather than an assumption, and the document records the answer. The typed
   * form asks for it directly - one of the few things that path knows and the
   * mirror does not.
   */
  const interState = Boolean(
    placeOfSupply &&
      showroom?.state &&
      placeOfSupply.trim().toLowerCase() !== showroom.state.trim().toLowerCase(),
  );

  const tax = taxOn({ taxable, gstRatePct: gstRate, cessRatePct: cessRate, interState });

  const otherCharges = (input.otherCharges ?? []).filter(
    (c) => c.label && Number.isFinite(c.amount),
  );
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
      showroomId: facts.showroomId,
      kind: decision.kind,
      reference,
      taxInvoiceNo,
      // Carried for linkage on every kind that is not our own tax invoice.
      dmsInvoiceNo: decision.ddmsHoldsSeries ? null : facts.dmsInvoiceNo,
      documentDate: onDate,

      factsOrigin: facts.origin,
      dealerCode: facts.dealerCode,
      dealId: facts.dealId,
      customerName: facts.customerName,
      customerMobile: facts.customerMobile,
      customerAddress: facts.customerAddress,
      customerGstin: facts.customerGstin,

      modelDescription: facts.modelDescription,
      chassisNo: facts.chassisNo,
      engineNo: facts.engineNo,
      hsn: priced.hsn,

      priceOrigin: priced.origin,
      priceListId: priced.list?.id ?? null,
      priceListName: priced.list?.name ?? null,
      priceListEffectiveFrom: priced.list?.effectiveFrom ?? null,
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
      dealId: facts.dealId,
      taxInvoiceNo,
      total,
      factsOrigin: facts.origin,
      priceOrigin: priced.origin,
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
