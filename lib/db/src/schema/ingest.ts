import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { usersTable } from "./users";

/**
 * How a dealership's data gets in, and it is not one answer (OBJ-24, R-84).
 *
 * DDMS was built against an OEM API because that is the tidy case. It is also
 * the minority case: **the dealers with no API are most of the market and the
 * most underserved.** A sub-dealer doing five units a month in Tripura has no
 * integration, will never be given one, and feels the pain of nobody knowing
 * where a file has got to far more sharply than a group doing eighty.
 *
 * > **Ingestion varies. Completion does not.**
 *
 * So the path is a per-outlet, per-data-type setting rather than a property of
 * the product. Stock by report, invoices by document scan, and the API two
 * years later when the OEM opens it — without breaking anything already
 * running, because nothing downstream of the mirror knows which path a value
 * arrived by.
 */
export const ingestSourcesTable = pgTable(
  "ingest_sources",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    /**
     * What kind of data. One row per (outlet, kind) — which is the whole point:
     * an OEM that exposes stock but not deals is the ordinary situation, not an
     * edge case.
     */
    dataType: text("data_type", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }).notNull(),

    /**
     * `API` is a live integration. `REPORT` is a file the dealer exports from
     * their own system and drops here. `DOCUMENT` is a scan — an invoice, an RC
     * book — read one record at a time.
     *
     * Freshness differs and the row says so rather than the screen pretending
     * otherwise: live, per export, per document.
     */
    path: text("path", { enum: ["API", "REPORT", "DOCUMENT"] }).notNull().default("API"),

    /**
     * Off is a real state. A dealership part-way through onboarding has three
     * of the seven switched on, and the four that are not must read as *not
     * connected* rather than as *nothing to show*.
     */
    isEnabled: text("is_enabled", { enum: ["Y", "N"] }).notNull().default("Y"),

    /** When this source last produced anything, for the freshness the row owes. */
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ingest_sources_unique").on(t.showroomId, t.dataType),
    index("ingest_sources_owner_idx").on(t.ownerId),
  ],
).enableRLS();

/**
 * What a dealer's column headings mean, worked out once and then fixed
 * (OBJ-24, R-86).
 *
 * Every DMS exports a different spreadsheet. One writes `Deal No`, the next
 * `DEAL_NUMBER`, the third `Order Ref`. A model reads unfamiliar headings
 * **once**, a person confirms **once**, and every file of that shape thereafter
 * is extracted by column position with no model anywhere near it.
 *
 * That is the same shape as OBJ-26's graduation, arriving early and for the
 * same reason: the expensive, fallible step is the one that only has to happen
 * on the first encounter, and the cost is per report type per dealer rather
 * than per row. A dealership dropping a thousand-row stock file every morning
 * pays for one model call, in total, ever.
 *
 * ## The fingerprint is the headings, not the file
 *
 * Keyed on a hash of the sorted column headings, so the *same shape* of export
 * matches whatever it is called and however many rows it has. A dealer who adds
 * a column gets a new fingerprint and one more confirmation — which is correct:
 * a changed export is a changed export, and silently reusing yesterday's
 * mapping across it is how a column shifts one place and a month of stock
 * lands under the wrong heading.
 */
export const ingestMappingsTable = pgTable(
  "ingest_mappings",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    dataType: text("data_type", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }).notNull(),

    /** SHA-256 of the sorted, normalised column headings. */
    fingerprint: text("fingerprint").notNull(),
    /** The headings themselves, so a person confirming can see what they are confirming. */
    headings: jsonb("headings").$type<string[]>().notNull(),

    /**
     * `ourField -> { column, confidence }`. A field the model could not place
     * is simply absent, which is honest: a mapping with a guessed column in it
     * is worse than a mapping with a gap, because the gap is visible.
     */
    mapping: jsonb("mapping")
      .$type<Record<string, { column: string; confidence: number }>>()
      .notNull(),

    /**
     * `PROPOSED` until a person has looked at it. **Nothing is extracted from a
     * proposed mapping** — the model reads headings, a person decides what they
     * mean, and that division is R-49 applied to onboarding.
     */
    status: text("status", { enum: ["PROPOSED", "CONFIRMED", "REJECTED"] })
      .notNull()
      .default("PROPOSED"),

    /** `MODEL` when a model read the headings, `PERSON` when somebody mapped them by hand. */
    proposedBy: text("proposed_by", { enum: ["MODEL", "PERSON"] }).notNull().default("MODEL"),
    /** Which model, so a mapping made by a since-retired one can be found. */
    proposedByModel: text("proposed_by_model"),

    confirmedByUserId: integer("confirmed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    confirmedByName: text("confirmed_by_name"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Why it was rejected. A rejected mapping is evidence about the export. */
    note: text("note"),

    /** How many files have been extracted with it. The graduation, counted. */
    usedCount: integer("used_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ingest_mappings_unique").on(t.showroomId, t.dataType, t.fingerprint),
    index("ingest_mappings_owner_idx").on(t.ownerId, t.status),
  ],
).enableRLS();

/**
 * One file, dropped once, and what came of it.
 *
 * The API path needs no equivalent because a live integration has no *event* to
 * record — it is simply true continuously. A report does: somebody exported a
 * file at a moment, from a system in a state, and every row that came out of it
 * inherits that moment. When a figure is later disputed, *which drop did this
 * come from* is the question, and without this table the answer is nowhere.
 *
 * Append-only in practice: a batch is never edited, a bad one is superseded by
 * the next drop.
 */
export const ingestBatchesTable = pgTable(
  "ingest_batches",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    dataType: text("data_type", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }).notNull(),
    path: text("path", { enum: ["API", "REPORT", "DOCUMENT"] }).notNull(),

    /** What the dealer called the file. Theirs, not ours. */
    filename: text("filename"),
    /** SHA-256 of the bytes — the same file dropped twice is the same batch. */
    contentHash: text("content_hash").notNull(),
    /** Which mapping read it. Null on a document or an API pull. */
    mappingId: integer("mapping_id").references(() => ingestMappingsTable.id, {
      onDelete: "set null",
    }),

    rowsSeen: integer("rows_seen").notNull().default(0),
    rowsAccepted: integer("rows_accepted").notNull().default(0),
    /**
     * Rows that could not be read into a record. Kept as a count rather than
     * discarded silently: a drop that accepted 40 of 300 rows is a mapping
     * problem, and a screen that showed only the 40 would look like success.
     */
    rowsRejected: integer("rows_rejected").notNull().default(0),
    /** The first few reasons, for somebody fixing the export. */
    rejections: jsonb("rejections").$type<string[]>(),

    /**
     * `PENDING_MAPPING` when the headings are new and nobody has confirmed what
     * they mean. The file is held, not dropped — an import that silently did
     * nothing because it did not understand the file is the worst of the three
     * possible outcomes.
     */
    status: text("status", {
      enum: ["PENDING_MAPPING", "ACCEPTED", "REJECTED"],
    })
      .notNull()
      .default("ACCEPTED"),

    /** Null when a scheduler pulled it. R-60, unchanged. */
    uploadedByUserId: integer("uploaded_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    uploadedByName: text("uploaded_by_name"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ingest_batches_recent_idx").on(t.showroomId, t.dataType, t.createdAt),
    index("ingest_batches_owner_idx").on(t.ownerId, t.createdAt),
    uniqueIndex("ingest_batches_content_unique").on(t.showroomId, t.dataType, t.contentHash),
  ],
).enableRLS();

export const ingestPathSchema = z.enum(["API", "REPORT", "DOCUMENT"]);
export type IngestPath = z.infer<typeof ingestPathSchema>;

export type IngestSourceRow = typeof ingestSourcesTable.$inferSelect;
export type IngestMappingRow = typeof ingestMappingsTable.$inferSelect;
export type IngestBatchRow = typeof ingestBatchesTable.$inferSelect;
