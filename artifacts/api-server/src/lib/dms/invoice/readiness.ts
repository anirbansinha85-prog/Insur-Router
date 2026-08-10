/**
 * *Everything is in place — the invoice can be generated.*
 *
 * The first thing this product has ever put on a queue that is **not a
 * problem**. Every other row is something going wrong: a file the RTO sent
 * back, a certificate nobody collected, a part on the wrong shelf. This one is
 * an opportunity, and the argument for it is the whole reason the objective is
 * worth doing:
 *
 * > **Invoices are not late because typing is hard. They are late because
 * > nobody noticed the deal became ready.**
 *
 * A dealership working through a queue of problems has no line of sight to the
 * six deals that quietly became invoiceable overnight — a chassis got
 * allocated, a payment cleared, a document arrived — and each of those is money
 * sitting still.
 *
 * ## Every condition is a column test
 *
 * No model anywhere, and R-78 says none may arrive. Whether a deal can be
 * invoiced is knowable: is there a vehicle against it, does a price exist, has
 * it been invoiced already. What a model could *not* answer is exactly why this
 * belongs in code.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  dmsDealsTable,
  priceListsTable,
  priceListItemsTable,
  saleDocumentsTable,
  type SaleDocumentRow,
} from "@workspace/db";
import { priceFor, money } from "./pricing";

export interface ReadinessCondition {
  id: string;
  /** What this needs, in the dealership's words. */
  what: string;
  met: boolean;
  /** Why not, when it is not met. */
  missing?: string;
}

export interface Readiness {
  dealerCode: string;
  dealId: string;
  showroomId: number;
  ready: boolean;
  conditions: ReadinessCondition[];
  /** What the document would say, if it were generated now. */
  preview: {
    customerName: string | null;
    modelDescription: string | null;
    chassisNo: string | null;
    exShowroomAmount: number | null;
    priceListName: string | null;
    priceListEffectiveFrom: string | null;
    pricedOffCurrentList: boolean;
  } | null;
  /** Already issued, in which case there is nothing to offer. */
  existing: SaleDocumentRow | null;
}

/**
 * The statuses at which a sale is far enough along to be invoiced.
 *
 * `BOOKED` is deliberately included and `DELIVERED` deliberately is not — a
 * delivered vehicle should already have an invoice, and offering to raise a
 * second one is how a duplicate gets issued. Where a delivered deal has none,
 * that is a problem row rather than an opportunity, and it belongs to the
 * reconciliation screen that already exists.
 */
const INVOICEABLE = new Set(["BOOKED", "AWAITING_INSURANCE", "AWAITING_REGISTRATION"]);

export async function readinessFor(input: {
  ownerId: number;
  showroomIds: number[];
  onDate: string;
}): Promise<Readiness[]> {
  if (input.showroomIds.length === 0) return [];

  const deals = await db
    .select()
    .from(dmsDealsTable)
    .where(inArray(dmsDealsTable.showroomId, input.showroomIds));

  const issued = await db
    .select()
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, input.ownerId),
        ne(saleDocumentsTable.status, "CANCELLED"),
        inArray(saleDocumentsTable.kind, ["TAX_INVOICE", "SALE_CONFIRMATION"]),
      ),
    );

  const already = new Map(issued.map((d) => [`${d.dealerCode}:${d.dealId}`, d]));

  const out: Readiness[] = [];

  for (const deal of deals) {
    if (deal.disappearedAt) continue;

    const existing = already.get(`${deal.dealerCode}:${deal.dealId}`) ?? null;

    const priced = deal.modelDescription
      ? await priceFor({
          ownerId: input.ownerId,
          showroomId: deal.showroomId,
          modelDescription: deal.modelDescription,
          onDate: input.onDate,
        })
      : null;

    const conditions: ReadinessCondition[] = [
      {
        id: "STAGE",
        what: "The deal is far enough along to invoice",
        met: INVOICEABLE.has(deal.status),
        missing: INVOICEABLE.has(deal.status)
          ? undefined
          : deal.status === "DELIVERED" || deal.status === "INVOICED"
            ? `Already ${deal.status.toLowerCase()} in the dealer's system.`
            : `The deal is ${deal.status}.`,
      },
      {
        id: "VEHICLE",
        what: "A vehicle is allocated to it",
        met: Boolean(deal.chassisNo),
        missing: deal.chassisNo ? undefined : "No chassis number against this deal.",
      },
      {
        id: "CUSTOMER",
        what: "We know who to bill",
        met: Boolean(deal.customerName),
        missing: deal.customerName ? undefined : "No customer name on the deal.",
      },
      {
        id: "PRICE",
        what: "A price list covers this model",
        met: Boolean(priced),
        missing: priced
          ? undefined
          : deal.modelDescription
            ? `No price list covers ${deal.modelDescription}.`
            : "No model on the deal, so nothing to price.",
      },
      {
        id: "NOT_ALREADY",
        what: "Nothing has been issued for it yet",
        met: existing === null,
        missing: existing ? `${existing.reference} was issued on ${existing.documentDate}.` : undefined,
      },
    ];

    out.push({
      dealerCode: deal.dealerCode,
      dealId: deal.dealId,
      showroomId: deal.showroomId,
      ready: conditions.every((c) => c.met),
      conditions,
      existing,
      preview: priced
        ? {
            customerName: deal.customerName,
            modelDescription: deal.modelDescription,
            chassisNo: deal.chassisNo,
            exShowroomAmount: money(priced.item.exShowroomAmount),
            priceListName: priced.list.name,
            priceListEffectiveFrom: priced.list.effectiveFrom,
            pricedOffCurrentList: priced.isCurrent,
          }
        : null,
    });
  }

  return out;
}

/** One deal's answer, for the panel on its screen. */
export async function readinessOf(input: {
  ownerId: number;
  showroomId: number;
  dealerCode: string;
  dealId: string;
  onDate: string;
}): Promise<Readiness | null> {
  const all = await readinessFor({
    ownerId: input.ownerId,
    showroomIds: [input.showroomId],
    onDate: input.onDate,
  });
  return all.find((r) => r.dealerCode === input.dealerCode && r.dealId === input.dealId) ?? null;
}

/**
 * Every price list that could price at this outlet, current first.
 *
 * The model count comes from a join and a `group by` rather than a correlated
 * subquery, and that is not a style preference. The first version wrote the
 * subquery through the ORM's SQL template and it **silently returned 1** for
 * every list — not an error, not an empty result, just a plausible wrong
 * number on a screen. It was caught by a probe against a list that had six
 * models in it, which is the whole argument for having seeded data that
 * somebody knows the shape of.
 */
export async function listPriceLists(ownerId: number, showroomId: number) {
  return db
    .select({
      id: priceListsTable.id,
      name: priceListsTable.name,
      source: priceListsTable.source,
      effectiveFrom: priceListsTable.effectiveFrom,
      effectiveTo: priceListsTable.effectiveTo,
      showroomId: priceListsTable.showroomId,
      models: sql<number>`count(${priceListItemsTable.id})::int`,
    })
    .from(priceListsTable)
    .leftJoin(priceListItemsTable, eq(priceListItemsTable.priceListId, priceListsTable.id))
    .where(
      and(
        eq(priceListsTable.ownerId, ownerId),
        or(isNull(priceListsTable.showroomId), eq(priceListsTable.showroomId, showroomId)),
      ),
    )
    .groupBy(
      priceListsTable.id,
      priceListsTable.name,
      priceListsTable.source,
      priceListsTable.effectiveFrom,
      priceListsTable.effectiveTo,
      priceListsTable.showroomId,
    )
    .orderBy(desc(priceListsTable.effectiveFrom), desc(priceListsTable.id));
}

/** What has been issued at this outlet, newest first. */
export async function listDocuments(ownerId: number, showroomId: number, limit = 100) {
  return db
    .select()
    .from(saleDocumentsTable)
    .where(and(eq(saleDocumentsTable.ownerId, ownerId), eq(saleDocumentsTable.showroomId, showroomId)))
    .orderBy(desc(saleDocumentsTable.id))
    .limit(limit);
}
