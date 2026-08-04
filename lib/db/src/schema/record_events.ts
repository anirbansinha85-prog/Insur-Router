import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * Every time a record's **derived state** changed, and what it changed from.
 *
 * Everything built before this is *pull*. Sync writes the mirror, screens
 * derive on read, and a registration file that crossed into `RC_IN_DRAWER` at
 * three in the morning produces nothing at all until somebody opens a page.
 * Nothing in the product can be triggered by something happening, because
 * nothing in the product records that anything happened.
 *
 * The maddening part was that sync already knew. It compares a hash of every
 * row on every pull and threw the answer away.
 *
 * ## Why this stores states and not fields
 *
 * The distinction is Salesforce's, between a platform event and change data
 * capture, and it decides the whole design. `rc_received_date changed` is a
 * fact about a column: every rule reading it would have to re-derive the
 * meaning that `classify()` has already worked out. `REGISTRATION →
 * RC_IN_DRAWER` is a fact about the business, and a rule can act on it
 * directly.
 *
 * So the event is the *classifier's* answer moving, which also means events
 * exist for changes that touched no field at all — a lead breaching its SLA
 * because time passed, a chase going stale, a temporary registration lapsing.
 * Those are the transitions nobody is watching for, and a field-diff log would
 * miss every one of them.
 *
 * ## The log is the state
 *
 * There is deliberately no companion table of "current state". The latest row
 * per `(module, showroomId, recordKey)` *is* the current state, and its
 * `detectedAt` is when the record entered it — which answers a question nothing else in the
 * product can: **how long has this been stuck**, as distinct from what it is
 * now. Keeping a second table would be faster to read and would eventually
 * disagree with this one, and of the two failure modes a slightly slower query
 * is the better.
 *
 * Append-only, and enforced the same way `decision_log` is: `ddms_app` gets
 * insert and select and nothing else.
 */
export const recordEventsTable = pgTable(
  "record_events",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    /** Same vocabulary as `decision_log` and `outbound_messages`. */
    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }).notNull(),
    recordKey: text("record_key").notNull(),

    /**
     * The state it left. **Null means this is the first time we classified it**
     * — a record appearing in the mirror, not a record changing.
     *
     * Worth distinguishing, because a rule that treats first-sight as a
     * transition would fire on every row the first time it ever ran, and a rule
     * that ignores it would never notice a lead that arrived already breaching.
     * The distinction belongs in the data so each rule can decide.
     */
    fromState: text("from_state"),
    toState: text("to_state").notNull(),

    /**
     * When the change was *detected*, which is not when it happened.
     *
     * A file that lapsed at midnight is found at the next sync, so this is
     * bounded above by the scheduler's interval. Naming the column `occurredAt`
     * would claim a precision the mirror cannot have.
     */
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The lookup the detector makes on every pass: latest row per record.
    //
    // The showroom is in the key because it is in the record's identity —
    // `dms_part_stock` is keyed on `(showroomId, partNo)`, so the same part
    // number is a different record at each branch. Omitting it made the log
    // flap between the two outlets' states on every pass.
    index("record_events_record_idx").on(t.module, t.showroomId, t.recordKey, t.id),
    index("record_events_owner_time_idx").on(t.ownerId, t.detectedAt),
  ],
).enableRLS();

export const insertRecordEventSchema = createInsertSchema(recordEventsTable).omit({ id: true });
export type InsertRecordEvent = z.infer<typeof insertRecordEventSchema>;
export type RecordEventRow = typeof recordEventsTable.$inferSelect;
