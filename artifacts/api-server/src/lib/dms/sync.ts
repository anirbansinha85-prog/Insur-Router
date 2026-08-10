/**
 * Pull a showroom's whole deal list into the local mirror.
 *
 * Read-only, always. Nothing here writes to the OEM's system — that access does
 * not exist, and designing around its absence is cheaper than pretending it
 * might arrive. What the dealer still has to key back by hand becomes a tracked
 * task rather than a silent gap.
 *
 * The list is cheap; the full record needs one call per deal. That is the
 * expensive part, so a sync only loads the full record when the listing shows
 * something has changed — or when we have never seen the deal.
 *
 * ## Since OBJ-24 this file does not know where the data comes from
 *
 * It used to call the OEM's API directly. It now asks `dealSourceFor` for a
 * source and gets back one of three: the API, a spreadsheet the dealer exported
 * and dropped, or a scanned invoice. **Nothing below this line branches on
 * which**, and that is R-84 as code rather than as an intention:
 *
 * > **Ingestion varies. Completion does not.**
 *
 * The reframing behind it is Anirban's: the dealers with no API are most of the
 * market and the most underserved. Building for the tidy case and treating the
 * rest as a fallback serves the smallest part of the market.
 *
 * Two things the source is asked rather than assumed, and both would have been
 * bugs. **Whether its listing is complete** — a scanned invoice says nothing
 * about the other four hundred deals, and treating *not listed* as *gone* would
 * disappear a dealership's whole book the first time somebody scanned a sheet
 * of paper. And **whether a record is whole** — a document carries the invoice
 * and the customer and nothing about the policy, so an absent field there means
 * *the document did not say*, never *the value is gone*.
 */

import { createHash } from "node:crypto";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db, dmsDealsTable, showroomsTable, showroomDmsAccountsTable } from "@workspace/db";
import { logger } from "../logger";
import { dealSourceFor } from "./ingest";
import type { DealRecord, IngestPath, Sourced } from "./ingest";

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
 * A record, minus its key and its raw payload — the columns the mirror keeps.
 *
 * This used to be `projectDeal`, lifting fields out of the API's nested
 * payload. The shape was always the canonical one; naming it and moving it into
 * `ingest/types.ts` is most of what made three paths possible, because every
 * path now has one target to produce rather than a nested API payload to
 * imitate.
 */
function columnsOf(record: DealRecord) {
  return {
    status: record.status,
    bookingDate: record.bookingDate,
    plannedDeliveryDate: record.plannedDeliveryDate,
    actualDeliveryDate: record.actualDeliveryDate,
    customerName: record.customerName,
    customerMobile: record.customerMobile,
    modelDescription: record.modelDescription,
    chassisNo: record.chassisNo,
    engineNo: record.engineNo,
    exShowroomAmount: record.exShowroomAmount,
    dmsPolicyNo: record.dmsPolicyNo,
    dmsInsurerCode: record.dmsInsurerCode,
    dmsRegNo: record.dmsRegNo,
    invoiceNo: record.invoiceNo,
    invoiceDate: record.invoiceDate,
  };
}

/**
 * A partial record merged over what is already there.
 *
 * Only for a source that says its records are partial — a scanned invoice. An
 * absent field on a document means *the document did not mention it*, and
 * writing null over a policy number the API gave us last week because this
 * week's invoice scan did not repeat it would be the product destroying its own
 * data with a straight face.
 */
function mergeOver<T extends Record<string, unknown>>(fresh: T, existing: T): T {
  const out = { ...existing };
  for (const [k, v] of Object.entries(fresh)) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
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

  /*
   * The one line that made three paths possible.
   *
   * Everything below is written against `Source<DealRecord>` and cannot tell an
   * OEM API from a spreadsheet somebody exported this morning. A dealership
   * nobody has configured resolves to `API` and behaves exactly as it did
   * before this objective, which is the property that made changing this file
   * safe.
   */
  const source = await dealSourceFor(showroomId, dealerCode);
  const listed = await source.list();

  const existing = await db
    .select({
      dealId: dmsDealsTable.dealId,
      rawHash: dmsDealsTable.rawHash,
      status: dmsDealsTable.status,
    })
    .from(dmsDealsTable)
    .where(eq(dmsDealsTable.dealerCode, dealerCode));

  const known = new Map(existing.map((r) => [r.dealId, r]));

  /*
   * Which ones to load in full.
   *
   * The listing carries a fingerprint of whatever the source could see cheaply,
   * so a deal whose fingerprint has not moved needs no expensive load. On the
   * API path that is the difference between one round trip and four hundred
   * against an ERP that returns 503 at month end; on the report path the file
   * is already in hand and this simply costs nothing.
   */
  let unchanged = 0;
  const toLoad: string[] = [];
  const fingerprintOfKey = new Map(listed.map((l) => [l.key, l.fingerprint]));

  for (const item of listed) {
    const prior = known.get(item.key);
    if (prior && prior.rawHash === item.fingerprint) {
      await db
        .update(dmsDealsTable)
        .set({ lastSyncedAt: new Date(), disappearedAt: null })
        .where(and(eq(dmsDealsTable.dealerCode, dealerCode), eq(dmsDealsTable.dealId, item.key)));
      unchanged++;
      continue;
    }
    toLoad.push(item.key);
  }

  const loaded = await source.load(toLoad);

  let added = 0;
  let changed = 0;

  for (const item of loaded) {
    const prior = known.get(item.key);
    const now = new Date();
    const fingerprint = fingerprintOfKey.get(item.key) ?? "";

    /*
     * Provenance, written beside the value and never into it (R-85).
     *
     * The projected columns are identical whichever path produced them — the
     * worklist reads `invoiceNo`, not `invoiceNo.value` — and what kind of fact
     * this row is holding lives in three columns of its own. Same instinct as
     * the `SIM-` prefix: the record says what it is.
     */
    const provenance = {
      ingestPath: item.path,
      fieldConfidence: item.confidence ?? null,
      ingestBatchId: item.batchId ?? null,
    };

    if (!prior) {
      await db.insert(dmsDealsTable).values({
        showroomId,
        dealerCode,
        dealId: item.key,
        ...columnsOf(item.record),
        ...provenance,
        raw: item.record.raw,
        rawHash: fingerprint,
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
    const statusMoved = prior.status !== item.record.status;

    /*
     * A partial source merges; a complete one replaces.
     *
     * A scanned invoice carries the deal, the customer, the model and the
     * price, and says nothing whatever about the policy or the registration.
     * Writing null over a policy number the API gave us last week because this
     * week's scan did not repeat it would be the product destroying its own
     * data with a straight face.
     */
    const columns = source.listIsComplete
      ? columnsOf(item.record)
      : mergeOver(columnsOf(item.record), {
          status: prior.status,
        } as ReturnType<typeof columnsOf>);

    await db
      .update(dmsDealsTable)
      .set({
        showroomId,
        ...columns,
        ...provenance,
        raw: item.record.raw,
        rawHash: fingerprint,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
        ...(statusMoved ? { statusSince: now } : {}),
      })
      .where(and(eq(dmsDealsTable.dealerCode, dealerCode), eq(dmsDealsTable.dealId, item.key)));
    changed++;
  }

  /*
   * A deal the source has stopped listing is marked, not removed — and only
   * when the source says its listing was complete.
   *
   * Vanishing is itself information: cancelled, reassigned, or an integration
   * fault. Deleting the row would throw away the history that explains it.
   *
   * **`listIsComplete` is what OBJ-24 added, and it prevents the worst bug in
   * this file.** A document source sees one invoice. Treating everything it did
   * not mention as gone would mark a dealership's entire book as disappeared
   * the first time somebody scanned a sheet of paper.
   */
  const seenIds = listed.map((l) => l.key);
  const disappearedResult =
    source.listIsComplete && seenIds.length > 0
      ? await db
          .update(dmsDealsTable)
          .set({ disappearedAt: new Date() })
          .where(
            and(
              eq(dmsDealsTable.dealerCode, dealerCode),
              isNull(dmsDealsTable.disappearedAt),
              notInArray(dmsDealsTable.dealId, seenIds),
            ),
          )
          .returning({ dealId: dmsDealsTable.dealId })
      : [];

  // An empty list from a source that claims completeness is far more likely to
  // be a fault than a dealership with zero deals, so nothing is marked as gone
  // — a bad sync must not look like a business event.
  if (seenIds.length === 0) {
    logger.warn(
      { dealerCode, path: source.path },
      source.listIsComplete
        ? "Source returned zero deals — treating as a fault, not an empty yard"
        : "Nothing waiting on this source yet",
    );
  }

  const finishedAt = new Date();
  const result: SyncResult = {
    showroomId,
    dealerCode,
    seen: listed.length,
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
