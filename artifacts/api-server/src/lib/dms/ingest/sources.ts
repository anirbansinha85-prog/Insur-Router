/**
 * The three ways in, each behind the same two questions.
 *
 * `list()` is cheap and answers *what can you see*. `load()` is expensive and
 * answers *give me these in full*. Every path fits that honestly, which is the
 * test of whether the abstraction is real or merely tidy:
 *
 * | | `list()` | `load()` | complete? |
 * |---|---|---|---|
 * | API | the summary endpoint | one call per deal | yes — it lists the whole book |
 * | REPORT | the file, parsed once | rows already in hand | as complete as the export |
 * | DOCUMENT | scans waiting to be read | OCR, one at a time | **no** |
 *
 * That last column is the one that would have caused real damage. A document
 * source sees one invoice and says nothing whatever about the other four
 * hundred deals in the dealership — and a sync that treats *not listed* as
 * *disappeared* would mark the entire book as vanished the first time somebody
 * scanned a single sheet of paper. The source is asked rather than assumed.
 */

import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
  ingestSourcesTable,
  ingestBatchesTable,
  ingestMappingsTable,
  type IngestBatchRow,
} from "@workspace/db";
import { logger } from "../../logger";
import { dmsList, fetchDeal } from "../client";
import { toIsoDate, toAmount as amountFromApi, assembleName } from "../hero-adapter";
import type { DmsDeal } from "../types";
import type { DataType, DealRecord, IngestPath, Listed, Source, Sourced } from "./types";
import { extract, noteMappingUse, type FieldMapping } from "./mapping";
import { parseTable } from "./table";

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/**
 * Which path an outlet uses for a kind of data.
 *
 * Defaults to `API`, so a dealership nobody has configured behaves exactly as
 * every dealership did before this objective — which is the property that made
 * it safe to change the sync at all.
 */
export async function pathFor(showroomId: number, dataType: DataType): Promise<IngestPath> {
  const [row] = await db
    .select({ path: ingestSourcesTable.path, enabled: ingestSourcesTable.isEnabled })
    .from(ingestSourcesTable)
    .where(
      and(
        eq(ingestSourcesTable.showroomId, showroomId),
        eq(ingestSourcesTable.dataType, dataType),
      ),
    )
    .limit(1);

  if (!row || row.enabled !== "Y") return "API";
  return row.path;
}

export async function setPath(input: {
  ownerId: number;
  showroomId: number;
  dataType: DataType;
  path: IngestPath;
  enabled?: boolean;
}): Promise<void> {
  await db
    .insert(ingestSourcesTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      dataType: input.dataType,
      path: input.path,
      isEnabled: input.enabled === false ? "N" : "Y",
    })
    .onConflictDoUpdate({
      target: [ingestSourcesTable.showroomId, ingestSourcesTable.dataType],
      set: {
        path: input.path,
        isEnabled: input.enabled === false ? "N" : "Y",
        updatedAt: new Date(),
      },
    });
}

// ── The API path ────────────────────────────────────────────────────────────

/** What `projectDeal` has always done, named and moved so three paths can share it. */
function fromApi(deal: DmsDeal): DealRecord {
  return {
    dealId: deal.dealId,
    status: deal.status,
    bookingDate: toIsoDate(deal.bookingDt) || null,
    plannedDeliveryDate: toIsoDate(deal.plannedDeliveryDt) || null,
    actualDeliveryDate: toIsoDate(deal.actualDeliveryDt) || null,
    customerName: assembleName(deal.customer),
    customerMobile: deal.customer.mobileNo,
    modelDescription: deal.vehicle.model.modelDesc,
    chassisNo: deal.vehicle.chassisNo,
    engineNo: deal.vehicle.engineNo,
    exShowroomAmount: amountFromApi(deal.vehicle.exShowroomAmt),
    dmsPolicyNo: deal.insurance.policyNo,
    dmsInsurerCode: deal.insurance.insurerCode,
    dmsRegNo: deal.registration.regNo,
    invoiceNo: deal.invoice.invoiceNo,
    invoiceDate: toIsoDate(deal.invoice.invoiceDt) || null,
    raw: deal as unknown as Record<string, unknown>,
  };
}

function apiSource(dealerCode: string): Source<DealRecord> {
  return {
    path: "API",
    listIsComplete: true,

    async list(): Promise<Listed[]> {
      const summaries = await dmsList(dealerCode);
      // The summary is enough to tell "nothing moved" from "fetch the full
      // record", and on a busy dealership most deals are untouched most of the
      // time. This is the whole reason `list` and `load` are separate.
      return summaries.map((s) => ({ key: s.dealId, fingerprint: hashOf(s) }));
    },

    async load(keys: string[]): Promise<Array<Sourced<DealRecord>>> {
      const out: Array<Sourced<DealRecord>> = [];
      for (const key of keys) {
        const deal = await fetchDeal(key);
        if (!deal) {
          logger.warn({ dealId: key }, "DMS listed a deal it then could not return");
          continue;
        }
        // No confidence map at all: an API field is what the system of record
        // says it is, and a row of 1.0s would be a megabyte of JSON asserting
        // nothing.
        out.push({ key, record: fromApi(deal), path: "API" });
      }
      return out;
    },
  };
}

// ── The report path ─────────────────────────────────────────────────────────

/**
 * The newest accepted drop for this outlet and data type.
 *
 * A report source reads what was last dropped rather than fetching anything —
 * so its freshness is *as at the last export*, and the screen says exactly
 * that. A dealership that exports weekly has week-old data and needs to know
 * it; the alternative is a timestamp that says the sync ran five minutes ago
 * and means nothing.
 */
async function latestBatch(
  showroomId: number,
  dataType: DataType,
): Promise<{ batch: IngestBatchRow; mapping: FieldMapping; text: string } | null> {
  const [batch] = await db
    .select()
    .from(ingestBatchesTable)
    .where(
      and(
        eq(ingestBatchesTable.showroomId, showroomId),
        eq(ingestBatchesTable.dataType, dataType),
        eq(ingestBatchesTable.status, "ACCEPTED"),
      ),
    )
    .orderBy(desc(ingestBatchesTable.id))
    .limit(1);

  if (!batch || !batch.mappingId) return null;

  const [mapping] = await db
    .select()
    .from(ingestMappingsTable)
    .where(eq(ingestMappingsTable.id, batch.mappingId))
    .limit(1);

  if (!mapping || mapping.status !== "CONFIRMED") return null;

  const text = REPORT_BODIES.get(batch.contentHash);
  if (!text) return null;

  return { batch, mapping: mapping.mapping, text };
}

/**
 * The bytes of a drop, held for the life of the process.
 *
 * **A deliberate limitation, written down rather than hidden.** The file itself
 * belongs in object storage, and there is none wired up — so a restart loses
 * the bodies and the dealer drops the file again. That is an honest gap: what
 * had to be built here is *whether three paths can produce one record*, and a
 * bucket is plumbing that answers nothing. `ingest_batches` keeps the audit
 * trail either way, which is the part that must not be lost.
 */
const REPORT_BODIES = new Map<string, string>();

export function rememberReportBody(contentHash: string, text: string): void {
  REPORT_BODIES.set(contentHash, text);
}

function reportSource(showroomId: number): Source<DealRecord> {
  let cached: Array<{ record: DealRecord; confidence: Record<string, number> }> | null = null;
  let batchId: number | undefined;
  let complete = true;

  async function rows() {
    if (cached) return cached;
    const found = await latestBatch(showroomId, "DEAL");
    if (!found) {
      cached = [];
      // Nothing dropped yet is not the same as *the dealership has no deals*,
      // and treating it as a complete listing would disappear the whole mirror.
      complete = false;
      return cached;
    }
    const table = parseTable(found.text);
    const { records } = extract(table, found.mapping);
    cached = records;
    batchId = found.batch.id;
    return cached;
  }

  return {
    path: "REPORT",
    get listIsComplete() {
      return complete;
    },

    async list(): Promise<Listed[]> {
      // Parsed once. The file is already in hand, so listing and loading cost
      // the same — which is exactly why `load` below returns from the cache
      // rather than re-reading.
      return (await rows()).map((r) => ({ key: r.record.dealId, fingerprint: hashOf(r.record) }));
    },

    async load(keys: string[]): Promise<Array<Sourced<DealRecord>>> {
      const wanted = new Set(keys);
      return (await rows())
        .filter((r) => wanted.has(r.record.dealId))
        .map((r) => ({
          key: r.record.dealId,
          record: r.record,
          path: "REPORT" as const,
          confidence: Object.keys(r.confidence).length ? r.confidence : undefined,
          batchId,
        }));
    },
  };
}

// ── The document path ───────────────────────────────────────────────────────

/**
 * One scanned invoice at a time, and the source that must never be treated as
 * a complete listing.
 *
 * This is the smallest dealer's path and the one with the least data in it: an
 * invoice PDF carries the deal number, the customer, the model, the chassis and
 * the price, and nothing at all about the registration or the policy. A record
 * from here is **partial by nature**, so the sync merges it over what is
 * already known rather than replacing the row — an absent field on a document
 * means *the document did not say*, never *the value is gone*.
 */
function documentSource(showroomId: number): Source<DealRecord> {
  let cached: Array<Sourced<DealRecord>> | null = null;

  async function pending(): Promise<Array<Sourced<DealRecord>>> {
    if (cached) return cached;

    const batches = await db
      .select()
      .from(ingestBatchesTable)
      .where(
        and(
          eq(ingestBatchesTable.showroomId, showroomId),
          eq(ingestBatchesTable.dataType, "DEAL"),
          eq(ingestBatchesTable.path, "DOCUMENT"),
          eq(ingestBatchesTable.status, "ACCEPTED"),
        ),
      )
      .orderBy(desc(ingestBatchesTable.id))
      .limit(200);

    cached = [];
    for (const batch of batches) {
      const held = DOCUMENT_RECORDS.get(batch.contentHash);
      if (!held) continue;
      cached.push({
        key: held.record.dealId,
        record: held.record,
        path: "DOCUMENT",
        confidence: held.confidence,
        batchId: batch.id,
      });
    }
    return cached;
  }

  return {
    path: "DOCUMENT",
    // Never. One invoice says nothing about the rest of the book, and a sync
    // that inferred otherwise would mark a dealership's entire mirror as
    // disappeared the first time somebody scanned a sheet of paper.
    listIsComplete: false,

    async list(): Promise<Listed[]> {
      return (await pending()).map((d) => ({ key: d.key, fingerprint: hashOf(d.record) }));
    },

    async load(keys: string[]): Promise<Array<Sourced<DealRecord>>> {
      const wanted = new Set(keys);
      return (await pending()).filter((d) => wanted.has(d.key));
    },
  };
}

/** Same limitation as the report bodies, and the same reason. */
const DOCUMENT_RECORDS = new Map<
  string,
  { record: DealRecord; confidence: Record<string, number> }
>();

export function rememberDocumentRecord(
  contentHash: string,
  record: DealRecord,
  confidence: Record<string, number>,
): void {
  DOCUMENT_RECORDS.set(contentHash, { record, confidence });
}

// ── Resolution ──────────────────────────────────────────────────────────────

export async function dealSourceFor(
  showroomId: number,
  dealerCode: string,
): Promise<Source<DealRecord>> {
  switch (await pathFor(showroomId, "DEAL")) {
    case "REPORT":
      return reportSource(showroomId);
    case "DOCUMENT":
      return documentSource(showroomId);
    default:
      return apiSource(dealerCode);
  }
}

/** For the screen that shows a dealership how it is connected, per data type. */
export async function describeSources(showroomId: number): Promise<
  Array<{
    dataType: DataType;
    path: IngestPath;
    enabled: boolean;
    lastIngestedAt: string | null;
  }>
> {
  const rows = await db
    .select()
    .from(ingestSourcesTable)
    .where(eq(ingestSourcesTable.showroomId, showroomId));
  const set = new Map(rows.map((r) => [r.dataType, r]));

  const ALL: DataType[] = [
    "DEAL",
    "JOB_CARD",
    "ENQUIRY",
    "REGISTRATION",
    "PART",
    "RECEIVABLE",
    "VEHICLE",
  ];

  return ALL.map((dataType) => {
    const row = set.get(dataType);
    return {
      dataType,
      path: (row?.path ?? "API") as IngestPath,
      enabled: row ? row.isEnabled === "Y" : true,
      lastIngestedAt: row?.lastIngestedAt ? row.lastIngestedAt.toISOString() : null,
    };
  });
}

export { noteMappingUse };
