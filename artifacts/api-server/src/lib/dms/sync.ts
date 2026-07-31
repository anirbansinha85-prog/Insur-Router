/**
 * Pull a showroom's whole deal list into the local mirror.
 *
 * Read-only, always. Nothing here writes to the OEM's system — that access does
 * not exist, and designing around its absence is cheaper than pretending it
 * might arrive. What the dealer still has to key back by hand becomes a tracked
 * task rather than a silent gap.
 *
 * The list endpoint returns summaries; the full record needs one call per deal.
 * That is the expensive part, so a sync only fetches the full record when the
 * summary shows something has changed — or when we have never seen the deal.
 */

import { createHash } from "node:crypto";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db, dmsDealsTable, showroomsTable, showroomDmsAccountsTable } from "@workspace/db";
import { logger } from "../logger";
import { fetchDeal, dmsList } from "./client";
import { toIsoDate, toAmount, assembleName } from "./hero-adapter";
import type { DmsDeal } from "./types";

export interface SyncResult {
  showroomId: number;
  dealerCode: string;
  /** Deals the DMS returned. */
  seen: number;
  added: number;
  changed: number;
  unchanged: number;
  /** Rows in the mirror the DMS no longer lists. Marked, never deleted. */
  disappeared: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** Stable hash of the payload, so "did anything move" is one comparison. */
function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/**
 * Lift the fields the worklist sorts and filters on out of the raw payload.
 * Everything else stays in `raw` — this is a query convenience, not a second
 * source of truth.
 */
function projectDeal(deal: DmsDeal) {
  return {
    status: deal.status,
    bookingDate: toIsoDate(deal.bookingDt) || null,
    plannedDeliveryDate: toIsoDate(deal.plannedDeliveryDt) || null,
    actualDeliveryDate: toIsoDate(deal.actualDeliveryDt) || null,
    customerName: assembleName(deal.customer),
    customerMobile: deal.customer.mobileNo,
    modelDescription: deal.vehicle.model.modelDesc,
    chassisNo: deal.vehicle.chassisNo,
    engineNo: deal.vehicle.engineNo,
    exShowroomAmount: toAmount(deal.vehicle.exShowroomAmt),
    dmsPolicyNo: deal.insurance.policyNo,
    dmsInsurerCode: deal.insurance.insurerCode,
    dmsRegNo: deal.registration.regNo,
    invoiceNo: deal.invoice.invoiceNo,
    invoiceDate: toIsoDate(deal.invoice.invoiceDt) || null,
  };
}

/**
 * Sync one showroom.
 *
 * A showroom can hold several DMS accounts (two brands at one address), so this
 * walks each active account. Today every seeded showroom has exactly one.
 */
export async function syncShowroom(showroomId: number): Promise<SyncResult[]> {
  const accounts = await db
    .select({
      dealerCode: showroomDmsAccountsTable.dealerCode,
      oemCode: showroomDmsAccountsTable.oemCode,
    })
    .from(showroomDmsAccountsTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, showroomDmsAccountsTable.showroomId))
    .where(
      and(
        eq(showroomDmsAccountsTable.showroomId, showroomId),
        eq(showroomDmsAccountsTable.isActive, true),
        eq(showroomsTable.isActive, true),
      ),
    );

  const results: SyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncDealerCode(showroomId, account.dealerCode));
  }
  return results;
}

async function syncDealerCode(showroomId: number, dealerCode: string): Promise<SyncResult> {
  const startedAt = new Date();
  const summaries = await dmsList(dealerCode);

  const existing = await db
    .select({
      dealId: dmsDealsTable.dealId,
      rawHash: dmsDealsTable.rawHash,
      status: dmsDealsTable.status,
    })
    .from(dmsDealsTable)
    .where(eq(dmsDealsTable.dealerCode, dealerCode));

  const known = new Map(existing.map((r) => [r.dealId, r]));

  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const summary of summaries) {
    // The summary is enough to tell "nothing moved" from "fetch the full
    // record". On a busy dealership most deals are untouched most of the time,
    // and this is what keeps a sync from being N full round trips.
    const summaryHash = hashOf(summary);
    const prior = known.get(summary.dealId);

    if (prior && prior.rawHash === summaryHash) {
      await db
        .update(dmsDealsTable)
        .set({ lastSyncedAt: new Date(), disappearedAt: null })
        .where(
          and(eq(dmsDealsTable.dealerCode, dealerCode), eq(dmsDealsTable.dealId, summary.dealId)),
        );
      unchanged++;
      continue;
    }

    const deal = await fetchDeal(summary.dealId);
    if (!deal) {
      logger.warn({ dealId: summary.dealId }, "DMS listed a deal it then could not return");
      continue;
    }

    const projected = projectDeal(deal);
    const now = new Date();

    if (!prior) {
      await db.insert(dmsDealsTable).values({
        showroomId,
        dealerCode,
        dealId: deal.dealId,
        ...projected,
        raw: deal as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        firstSeenAt: now,
        statusSince: now,
        lastSyncedAt: now,
        lastChangedAt: null,
      });
      added++;
      continue;
    }

    // Only move the status clock when the status itself moved. Any other edit
    // — a corrected phone number, a late invoice — must not reset how long
    // this deal has been sitting where it is, because that number is the
    // whole point of the mirror.
    const statusMoved = prior.status !== projected.status;

    await db
      .update(dmsDealsTable)
      .set({
        showroomId,
        ...projected,
        raw: deal as unknown as Record<string, unknown>,
        rawHash: summaryHash,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
        ...(statusMoved ? { statusSince: now } : {}),
      })
      .where(and(eq(dmsDealsTable.dealerCode, dealerCode), eq(dmsDealsTable.dealId, deal.dealId)));
    changed++;
  }

  // A deal the DMS has stopped listing is marked, not removed. Vanishing is
  // itself information — cancelled, reassigned, or an integration fault — and
  // deleting the row would throw away the history that explains it.
  const seenIds = summaries.map((s) => s.dealId);
  const disappearedResult = await db
    .update(dmsDealsTable)
    .set({ disappearedAt: new Date() })
    .where(
      and(
        eq(dmsDealsTable.dealerCode, dealerCode),
        isNull(dmsDealsTable.disappearedAt),
        // An empty list means the DMS returned nothing at all. That is far more
        // likely to be an integration fault than a dealership with zero deals,
        // so nothing is marked as gone — a bad sync must not look like a
        // business event.
        ...(seenIds.length > 0 ? [notInArray(dmsDealsTable.dealId, seenIds)] : []),
      ),
    )
    .returning({ dealId: dmsDealsTable.dealId });

  if (seenIds.length === 0) {
    logger.warn({ dealerCode }, "DMS returned zero deals — treating as a fault, not an empty yard");
  }

  const finishedAt = new Date();
  const result: SyncResult = {
    showroomId,
    dealerCode,
    seen: summaries.length,
    added,
    changed,
    unchanged,
    disappeared: disappearedResult.length,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  logger.info(result, "DMS sync complete");
  return result;
}
