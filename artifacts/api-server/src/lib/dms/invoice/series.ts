/**
 * The number on the document, and who is entitled to issue it.
 *
 * > **Only one system may hold a sequential tax-invoice series** (R-90).
 *
 * Two systems drawing on one series produces gaps or duplicates, and both are
 * audit findings. So which one holds it is a per-dealer setting, and everything
 * about the document that follows from that answer follows automatically:
 *
 * | the series is | DDMS issues | and the document is |
 * |---|---|---|
 * | DDMS's | a number from its own series | a **tax invoice** |
 * | the DMS's | no tax number at all, only a reference | a **sale confirmation**, carrying the DMS's number for linkage |
 *
 * Same generator, one flag — and the second row is not a lesser feature. A
 * dealer whose DMS numbers his invoices still wants DDMS's document, because
 * DDMS's document is the one with the commercial agreement on it.
 *
 * ## The document must say what it is
 *
 * R-89, and it is the same instinct as `SIM-` on a simulated policy number and
 * *held — nothing was delivered* on an outbox row. A sale confirmation that
 * looked like a tax invoice would be worse than no document: somebody would
 * claim input credit against it.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, saleDocumentsTable, type DocumentKind } from "@workspace/db";
import type { ResolvedPolicy } from "../policy";

/** The switch, read from the dealership's own numbers. */
export const SERIES_SWITCH = "SWITCH.DDMS_HOLDS_TAX_SERIES";

export interface SeriesDecision {
  kind: DocumentKind;
  /** What the document calls itself, on the page. Never decoration (R-89). */
  title: string;
  /**
   * The generic form, for a caller deciding before anything is issued.
   *
   * **What actually prints is `noticeFor(row)`**, because the truthful sentence
   * depends on facts this function has not got — whether there is a number to
   * point at, and whether the buyer is a business. Same vocabulary, one file.
   */
  disclaimer: string | null;
  ddmsHoldsSeries: boolean;
}

export const TITLE_FOR: Record<DocumentKind, string> = {
  TAX_INVOICE: "Tax Invoice",
  SALE_CONFIRMATION: "Sale Confirmation",
  PROFORMA: "Proforma Invoice",
  QUOTATION: "Quotation",
};

/**
 * What the **customer** is told the document is (R-89, R-104).
 *
 * Two things went wrong with the first version of this and only one of them was
 * a matter of tone.
 *
 * > *"This is not a tax invoice. The tax invoice for this sale is issued by the
 * > dealership's own system, and its number is shown above."*
 *
 * **It could be false.** A sale confirmation raised before the other system has
 * invoiced the deal carries no number, and that sentence then points at a
 * number which is not on the page — a document asserting on its own face
 * something that is not there. That is the exact failure R-89 exists to prevent,
 * arriving from inside the rule meant to prevent it, and it is the reason this
 * is now computed from the row rather than fixed per kind.
 *
 * **And it was written for us.** *The dealership's own system* is our
 * vocabulary about our integration; the customer holding the paper does not
 * know we exist and should not be able to tell. What they need is the plain
 * fact and, where there is one, the number to keep.
 *
 * The input-credit sentence appears **only for a buyer with a GST number**,
 * because they are the only reader who could try to claim it. A retail customer
 * being warned about input tax credit is a document explaining a risk that
 * cannot happen to them, in words they did not ask for.
 */
export function noticeFor(row: {
  kind: DocumentKind;
  dmsInvoiceNo?: string | null;
  customerGstin?: string | null;
}): string | null {
  const business = Boolean(row.customerGstin?.trim());

  switch (row.kind) {
    case "TAX_INVOICE":
      // It is one. Saying so twice adds nothing, and a box of small print at
      // the top of a genuine tax invoice invites the reader to doubt it.
      return null;

    case "QUOTATION":
      return "This is a quotation. It is not a tax invoice and no payment is due against it.";

    case "PROFORMA":
      return (
        "This is a proforma invoice. It is issued for payment and it is not a tax invoice." +
        (business ? " Input tax credit cannot be claimed against it." : "")
      );

    case "SALE_CONFIRMATION": {
      const linked = row.dmsInvoiceNo?.trim();
      if (linked) {
        return (
          `This is a sale confirmation. It is not a tax invoice — the tax invoice for this sale is No. ${linked}.` +
          (business ? " Please claim input tax credit against that number." : "")
        );
      }
      /*
       * No number, so nothing is claimed about one.
       *
       * Silence is the honest answer here. The alternative — *"the tax invoice
       * will follow"* — is a promise the product cannot keep, because whether
       * one is ever raised happens in a system DDMS only reads.
       */
      return (
        "This is a sale confirmation. It is not a tax invoice." +
        (business ? " Input tax credit cannot be claimed against it." : "")
      );
    }
  }
}

/**
 * What kind of document this dealership may issue for a sale.
 *
 * A quotation and a proforma are never tax invoices whoever holds the series,
 * so they short-circuit — there is no version of this product in which a
 * quotation carries a GST number.
 */
export function decideKind(
  requested: "SALE" | "QUOTATION" | "PROFORMA",
  policy: ResolvedPolicy,
): SeriesDecision {
  const of = (kind: DocumentKind, ddmsHoldsSeries: boolean): SeriesDecision => ({
    kind,
    title: TITLE_FOR[kind],
    // The generic form. Nothing is known here about a linked number or a
    // business buyer, so `noticeFor` is asked with neither and returns the
    // sentence that is true whatever they turn out to be.
    disclaimer: noticeFor({ kind }),
    ddmsHoldsSeries,
  });

  if (requested === "QUOTATION") return of("QUOTATION", false);
  if (requested === "PROFORMA") return of("PROFORMA", false);
  if (policy.on(SERIES_SWITCH)) return of("TAX_INVOICE", true);
  return of("SALE_CONFIRMATION", false);
}

/**
 * The next number in the series, taken inside the insert rather than before it.
 *
 * A read-then-write would be one concurrent request away from a duplicate, and
 * a duplicate in a sequential GST series is exactly the audit finding R-90
 * exists to prevent. The unique index on `(ownerId, taxInvoiceNo)` is the
 * backstop; this is the part that makes the backstop never fire.
 *
 * The prefix carries the financial year because Indian invoice series restart
 * with it, and a series that silently ran on from March would be wrong in a way
 * nobody notices until an audit.
 */
export function financialYear(onDate: string): string {
  const [y, m] = onDate.split("-").map(Number);
  // April to March. A sale on 31 March is last year's; on 1 April, this year's.
  const startYear = (m as number) >= 4 ? (y as number) : (y as number) - 1;
  return `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`;
}

export async function nextTaxInvoiceNo(ownerId: number, onDate: string): Promise<string> {
  const prefix = `INV/${financialYear(onDate)}/`;

  /*
   * Counted from the documents themselves rather than from a counter row.
   *
   * A counter is faster and can drift from what was actually issued; the
   * documents are the thing an auditor reads. `for update` on the owner's rows
   * serialises two requests arriving together, and the unique index catches
   * anything this misses.
   */
  const [row] = await db
    .select({
      last: sql<string | null>`max(${saleDocumentsTable.taxInvoiceNo})`,
    })
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, ownerId),
        sql`${saleDocumentsTable.taxInvoiceNo} like ${prefix + "%"}`,
      ),
    );

  const lastNumber = row?.last ? Number(row.last.slice(prefix.length)) : 0;
  const next = (Number.isFinite(lastNumber) ? lastNumber : 0) + 1;
  return `${prefix}${String(next).padStart(5, "0")}`;
}

/** Ours, always present, and never mistakable for a tax number. */
export async function nextReference(
  ownerId: number,
  kind: DocumentKind,
  onDate: string,
): Promise<string> {
  const tag =
    kind === "QUOTATION" ? "QT" : kind === "PROFORMA" ? "PF" : kind === "TAX_INVOICE" ? "TI" : "SC";
  const prefix = `${tag}-${financialYear(onDate)}-`;

  const [row] = await db
    .select({ last: sql<string | null>`max(${saleDocumentsTable.reference})` })
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, ownerId),
        sql`${saleDocumentsTable.reference} like ${prefix + "%"}`,
      ),
    );

  const lastNumber = row?.last ? Number(row.last.slice(prefix.length)) : 0;
  const next = (Number.isFinite(lastNumber) ? lastNumber : 0) + 1;
  return `${prefix}${String(next).padStart(5, "0")}`;
}
