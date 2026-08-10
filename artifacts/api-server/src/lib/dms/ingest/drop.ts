/**
 * Somebody drops a file, and what happens next.
 *
 * The whole of OBJ-24's commercial argument lives in one branch below: if this
 * export's shape has been confirmed before, the file is read by column position
 * and **no model is called**. If it has not, the file is *held* — not silently
 * dropped, not partially imported — and a person is asked what the headings
 * mean, once.
 *
 * > An import that quietly did nothing because it did not understand the file
 * > is the worst of the three possible outcomes.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  ingestBatchesTable,
  ingestMappingsTable,
  ingestSourcesTable,
  type IngestBatchRow,
  type IngestMappingRow,
} from "@workspace/db";
import type { DataType } from "./types";
import { fingerprintOf, hashOfBytes, parseTable } from "./table";
import { extract, gapsIn, mappingFor, noteMappingUse } from "./mapping";
import { rememberReportBody } from "./sources";

export interface DropResult {
  batch: IngestBatchRow;
  mapping: IngestMappingRow;
  /** True when the shape was already confirmed — the claim OBJ-24 rests on. */
  wasKnown: boolean;
  /** True when a model was called to read the headings. */
  usedModel: boolean;
  /** Required fields the mapping still cannot fill. */
  gaps: string[];
  rowsSeen: number;
  rowsAccepted: number;
  rowsRejected: number;
  rejections: string[];
}

export async function dropReport(input: {
  ownerId: number;
  showroomId: number;
  dataType: DataType;
  filename: string | null;
  text: string;
  userId: number | null;
  userName: string | null;
}): Promise<
  | { ok: true; result: DropResult }
  | { ok: false; status: 400 | 409; error: string; batch?: IngestBatchRow }
> {
  const table = parseTable(input.text);

  if (table.headings.length === 0) {
    return { ok: false, status: 400, error: "That file has no column headings this can read." };
  }
  if (table.rows.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `Found the headings (${table.headings.length} columns) and no rows beneath them.`,
    };
  }

  const contentHash = hashOfBytes(input.text);

  /*
   * The same file dropped twice is the same drop.
   *
   * Not a nicety: an export re-uploaded because somebody was not sure it worked
   * the first time would otherwise be a second batch, and every row in the
   * mirror would carry the wrong provenance for no reason.
   */
  const [already] = await db
    .select()
    .from(ingestBatchesTable)
    .where(
      and(
        eq(ingestBatchesTable.showroomId, input.showroomId),
        eq(ingestBatchesTable.dataType, input.dataType),
        eq(ingestBatchesTable.contentHash, contentHash),
      ),
    )
    .limit(1);

  if (already) {
    rememberReportBody(contentHash, input.text);
    return {
      ok: false,
      status: 409,
      error: "This exact file has already been taken in.",
      batch: already,
    };
  }

  const found = await mappingFor({
    ownerId: input.ownerId,
    showroomId: input.showroomId,
    dataType: input.dataType,
    headings: table.headings,
  });

  const confirmed = found.row.status === "CONFIRMED";
  const gaps = gapsIn(found.row.mapping);

  // Held, with everything a person needs to finish it, rather than a partial
  // import nobody asked for.
  if (!confirmed) {
    const [batch] = await db
      .insert(ingestBatchesTable)
      .values({
        ownerId: input.ownerId,
        showroomId: input.showroomId,
        dataType: input.dataType,
        path: "REPORT",
        filename: input.filename,
        contentHash,
        mappingId: found.row.id,
        rowsSeen: table.rows.length,
        status: "PENDING_MAPPING",
        uploadedByUserId: input.userId,
        uploadedByName: input.userName,
      })
      .returning();

    rememberReportBody(contentHash, input.text);
    return {
      ok: true,
      result: {
        batch: batch!,
        mapping: found.row,
        wasKnown: false,
        usedModel: found.usedModel,
        gaps,
        rowsSeen: table.rows.length,
        rowsAccepted: 0,
        rowsRejected: 0,
        rejections: [],
      },
    };
  }

  const { records, rejected } = extract(table, found.row.mapping);

  const [batch] = await db
    .insert(ingestBatchesTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      dataType: input.dataType,
      path: "REPORT",
      filename: input.filename,
      contentHash,
      mappingId: found.row.id,
      rowsSeen: table.rows.length,
      rowsAccepted: records.length,
      rowsRejected: rejected.length,
      // The first few only. A mapping that rejects three hundred rows needs
      // three examples and a count, not three hundred sentences.
      rejections: rejected.slice(0, 5),
      status: "ACCEPTED",
      uploadedByUserId: input.userId,
      uploadedByName: input.userName,
    })
    .returning();

  rememberReportBody(contentHash, input.text);
  await noteMappingUse(found.row.id);
  await db
    .insert(ingestSourcesTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      dataType: input.dataType,
      path: "REPORT",
      lastIngestedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [ingestSourcesTable.showroomId, ingestSourcesTable.dataType],
      set: { lastIngestedAt: new Date(), updatedAt: new Date() },
    });

  return {
    ok: true,
    result: {
      batch: batch!,
      mapping: found.row,
      wasKnown: true,
      usedModel: found.usedModel,
      gaps,
      rowsSeen: table.rows.length,
      rowsAccepted: records.length,
      rowsRejected: rejected.length,
      rejections: rejected.slice(0, 5),
    },
  };
}

/**
 * A held batch, released once its mapping is confirmed.
 *
 * The file is not re-uploaded. Somebody dropped it, was asked what four columns
 * meant, answered, and the import they started completes — rather than being
 * told to go and find the file again, which is how an onboarding step becomes
 * the reason a dealer stops.
 */
export async function releaseHeld(input: {
  mappingId: number;
  text: string;
}): Promise<IngestBatchRow[]> {
  const held = await db
    .select()
    .from(ingestBatchesTable)
    .where(
      and(
        eq(ingestBatchesTable.mappingId, input.mappingId),
        eq(ingestBatchesTable.status, "PENDING_MAPPING"),
      ),
    );

  if (held.length === 0) return [];

  const [confirmed] = await db
    .select({ mapping: ingestMappingsTable.mapping })
    .from(ingestMappingsTable)
    .where(eq(ingestMappingsTable.id, input.mappingId))
    .limit(1);
  if (!confirmed) return [];

  const table = parseTable(input.text);
  const { records, rejected } = extract(table, confirmed.mapping);

  const released: IngestBatchRow[] = [];
  for (const batch of held) {
    const [updated] = await db
      .update(ingestBatchesTable)
      .set({
        status: "ACCEPTED",
        rowsAccepted: records.length,
        rowsRejected: rejected.length,
        rejections: rejected.slice(0, 5),
      })
      .where(eq(ingestBatchesTable.id, batch.id))
      .returning();
    if (updated) released.push(updated);
  }

  if (released.length > 0) await noteMappingUse(input.mappingId);
  return released;
}

export function fingerprintFor(text: string): string {
  return fingerprintOf(parseTable(text).headings);
}

/**
 * What has been taken in at this outlet, newest first.
 *
 * The answer to *where did this figure come from*, which is the question an
 * owner asks when a number on a screen is disputed and the one the API path
 * never had to answer — a live integration is simply true continuously. A drop
 * happened at a moment, from a system in a state, and every row it produced
 * inherits that moment.
 */
export async function listBatches(showroomId: number, limit = 50) {
  return db
    .select({
      id: ingestBatchesTable.id,
      dataType: ingestBatchesTable.dataType,
      path: ingestBatchesTable.path,
      filename: ingestBatchesTable.filename,
      status: ingestBatchesTable.status,
      rowsSeen: ingestBatchesTable.rowsSeen,
      rowsAccepted: ingestBatchesTable.rowsAccepted,
      rowsRejected: ingestBatchesTable.rowsRejected,
      rejections: ingestBatchesTable.rejections,
      mappingId: ingestBatchesTable.mappingId,
      uploadedByName: ingestBatchesTable.uploadedByName,
      createdAt: ingestBatchesTable.createdAt,
    })
    .from(ingestBatchesTable)
    .where(eq(ingestBatchesTable.showroomId, showroomId))
    .orderBy(desc(ingestBatchesTable.id))
    .limit(limit);
}
