/**
 * Where the facts on a document come from — and the point is that the document
 * cannot tell (OBJ-30, R-96).
 *
 * OBJ-25 built the generator against `dms_deals` and returned **404** when the
 * deal was not there. Read plainly, that says: *this product issues invoices
 * for dealerships that already have a manufacturer's system issuing invoices.*
 * Which excludes the sub-dealer in Tripura doing five units a month — the
 * customer the standalone invoice generator exists for, who has no DMS, no
 * mirror, and no deal row, and who is the one actually paying for this.
 *
 * The generator was coupled to the very thing that customer does not have.
 *
 * ## The seam
 *
 * A **`SaleFacts`** is *who bought what, and which vehicle*. Two things can
 * produce one:
 *
 * | | |
 * |---|---|
 * | `factsFromMirror` | a deal row, whether it arrived by API, by an exported report or off a scan |
 * | `factsFromForm` | somebody typed the sale in |
 *
 * There is deliberately **no third resolver for a scan**. A scanned invoice
 * reaches the mirror through OBJ-24's `DOCUMENT` path and is a deal row by the
 * time anything asks to price it, carrying `ingestPath` and `fieldConfidence`
 * beside the values (R-85). Adding a separate scan resolver here would be a
 * second way into the same facts, disagreeing with the first — the shape R-81
 * refuses everywhere else in this product.
 *
 * Nothing downstream of this file branches on `origin`. The pricing, the
 * discount composition, the tax split and the series logic are the same code
 * either way, and the column on the document exists so it can *say* where its
 * facts came from, not so anything can behave differently.
 *
 * ## R-97, and where it bites
 *
 * > **A figure that reaches a statutory return was confirmed by a person or
 * > returned by an API. A model's read is a proposal.**
 *
 * A field a model lifted off a scan at 0.55 confidence is a proposal, and a tax
 * invoice is not a place for proposals: the chassis number on it goes to the
 * RTO, the taxable value goes into GSTR-1, and being wrong there is a filing
 * offence rather than a bad morning. So `doubtful()` names them and the
 * generator refuses to issue a **tax invoice or sale confirmation** on top of
 * one, saying which fields and what to do.
 *
 * A quotation is not a statutory document and is not blocked — it warns. The
 * distinction is the whole of R-97: the gate is on the consequence, not on the
 * provenance.
 */

import { and, eq } from "drizzle-orm";
import { db, dmsDealsTable } from "@workspace/db";

export type FactsOrigin = "MIRROR" | "FORM";

/**
 * Everything the document needs about the sale, and nothing about the price.
 *
 * The split matters: facts are *what was sold to whom*, pricing is *what it
 * cost*, and a sub-dealer can be missing either one independently. He may have
 * typed the sale and have a price list, or have a mirrored deal and no list
 * covering the model.
 */
export interface SaleFacts {
  origin: FactsOrigin;
  showroomId: number;

  /**
   * The manufacturer's name for the outlet, and **null when there is no
   * manufacturer's system**. A dealer code is issued by an OEM; a sub-dealer
   * buying stock from a main dealer has never been given one.
   */
  dealerCode: string | null;
  /**
   * What identifies this sale.
   *
   * A mirrored deal's number where there is one. Otherwise the chassis number,
   * because one frame sells once — which makes it a natural key that needs no
   * deal register behind it to be unique, and makes the *sold this twice* check
   * work identically on both paths.
   */
  dealId: string;

  customerName: string | null;
  customerMobile: string | null;
  customerAddress: string | null;
  /** Filled makes the sale B2B, which is a different line in GSTR-1 (OBJ-32). */
  customerGstin: string | null;

  modelDescription: string | null;
  chassisNo: string | null;
  engineNo: string | null;

  /** The DMS's own invoice number, for linkage. Null when there is no DMS. */
  dmsInvoiceNo: string | null;

  /** How the facts reached us, where that is knowable (R-85). */
  ingestPath: "API" | "REPORT" | "DOCUMENT" | "FORM";
  /** Sparse, and only below certainty. Absent means no reason to doubt it. */
  confidence: Record<string, number> | null;
}

export type FactsResult =
  | { ok: true; facts: SaleFacts }
  | { ok: false; status: 400 | 404; error: string };

/**
 * The fields that print on the document, and therefore the ones R-97 is about.
 *
 * `customerMobile` is not here on purpose. A wrong mobile number is a message
 * that does not arrive, which is a bad afternoon; a wrong chassis number is a
 * vehicle registered to the wrong frame. The gate should stop the second and
 * not the first, or it becomes something people learn to click past.
 */
const ON_THE_DOCUMENT = [
  "customerName",
  "modelDescription",
  "chassisNo",
  "engineNo",
  "invoiceNo",
] as const;

/** Below this a value is a proposal rather than a fact. VeloDocs' number. */
export const CERTAIN_ENOUGH = 0.7;

/**
 * Which of the document's own fields are not yet anybody's word.
 *
 * Named rather than counted, because *three fields are uncertain* is not a job
 * and *the chassis number was read off the scan at 55% — check it against the
 * bike* is.
 */
export function doubtful(facts: SaleFacts): Array<{ field: string; confidence: number }> {
  if (!facts.confidence) return [];
  const out: Array<{ field: string; confidence: number }> = [];
  for (const field of ON_THE_DOCUMENT) {
    const c = facts.confidence[field];
    if (typeof c === "number" && c < CERTAIN_ENOUGH) out.push({ field, confidence: c });
  }
  return out;
}

/** A deal in the mirror. The path every dealership with an OEM behind it takes. */
export async function factsFromMirror(input: {
  dealerCode: string;
  dealId: string;
}): Promise<FactsResult> {
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

  return {
    ok: true,
    facts: {
      origin: "MIRROR",
      showroomId: deal.showroomId,
      dealerCode: deal.dealerCode,
      dealId: deal.dealId,
      customerName: deal.customerName,
      customerMobile: deal.customerMobile,
      // The deal mirror carries no address and no GSTIN. Saying so with a null
      // is more useful than inventing a placeholder: the invoice screen can ask
      // for them, and R-96's whole argument is that a missing fact is an input
      // rather than a refusal.
      customerAddress: null,
      customerGstin: null,
      modelDescription: deal.modelDescription,
      chassisNo: deal.chassisNo,
      engineNo: deal.engineNo,
      dmsInvoiceNo: deal.invoiceNo,
      ingestPath: deal.ingestPath,
      confidence: deal.fieldConfidence ?? null,
    },
  };
}

export interface FormFacts {
  showroomId: number;
  customerName?: string | null;
  customerMobile?: string | null;
  customerAddress?: string | null;
  customerGstin?: string | null;
  modelDescription?: string | null;
  chassisNo?: string | null;
  engineNo?: string | null;
  /** For a dealership that keeps its own numbering outside DDMS. */
  dmsInvoiceNo?: string | null;
  /** Optional. Defaults to the chassis, which is the honest key. */
  dealId?: string | null;
}

/**
 * A sale somebody typed in.
 *
 * Two things are required and the rest is optional, which is the correct
 * asymmetry for a form a person fills in while a customer waits. A model is
 * required because there is nothing to price otherwise, and a **chassis number
 * is required** because it is what makes the sale identifiable: without it two
 * invoices for the same bike are indistinguishable and the *sold this twice*
 * check has nothing to check. A two-wheeler tax invoice needs one to be
 * registrable anyway, so this asks for nothing the dealer was not going to
 * write down.
 */
export function factsFromForm(input: FormFacts): FactsResult {
  const chassis = (input.chassisNo ?? "").trim().toUpperCase();
  const model = (input.modelDescription ?? "").trim();

  if (!model) {
    return { ok: false, status: 400, error: "Say which model was sold — there is nothing to price otherwise." };
  }
  if (!chassis) {
    return {
      ok: false,
      status: 400,
      error:
        "A chassis number is needed. It is what identifies the vehicle on the invoice and at the RTO, and it is what stops the same bike being invoiced twice.",
    };
  }

  const gstin = (input.customerGstin ?? "").trim().toUpperCase();

  return {
    ok: true,
    facts: {
      origin: "FORM",
      showroomId: input.showroomId,
      dealerCode: null,
      dealId: (input.dealId ?? "").trim() || chassis,
      customerName: (input.customerName ?? "").trim() || null,
      customerMobile: (input.customerMobile ?? "").trim() || null,
      customerAddress: (input.customerAddress ?? "").trim() || null,
      customerGstin: gstin || null,
      modelDescription: model,
      chassisNo: chassis,
      engineNo: (input.engineNo ?? "").trim().toUpperCase() || null,
      dmsInvoiceNo: (input.dmsInvoiceNo ?? "").trim() || null,
      ingestPath: "FORM",
      /*
       * Nothing is doubtful about a figure a person typed while looking at the
       * bike. That is not laxity — it is exactly R-97: a person's entry is a
       * confirmation, where a model's read is a proposal. The provenance the
       * document records is `FORM`, and an auditor can see whose login it was.
       */
      confidence: null,
    },
  };
}
