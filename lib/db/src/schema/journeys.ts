import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * One real-world thing walking through the building, and where it has got to.
 *
 * DDMS has always understood a **record**. It has never understood a
 * **journey**. A vehicle sold is one thing moving — invoice, insurance,
 * documents, road tax, the RTO, the plate, the certificate — and until this
 * table it was ten unrelated rows on four screens with nothing in the system
 * aware they described one sale.
 *
 * ## What is stored, and what is deliberately not
 *
 * This row holds **identity and lifecycle only**: which map is being walked,
 * what it is being walked for, and whether it is still going. It does *not*
 * hold the current step, and that omission is the design.
 *
 * `journey_steps` is append-only and **the newest row for a journey is where it
 * stands** — the same argument `record_events` makes, and for the same reason:
 * two places holding a position will eventually disagree, and the one nobody
 * reads will be the one that is right. Where it is waiting and why is not
 * stored anywhere at all; it is derived from the mirror on every read, because
 * a stored *"waiting on the RTO"* goes stale the moment the RTO answers, and
 * reconciliation already taught this product that lesson.
 *
 * ## Restart is not a feature here, it is the absence of one
 *
 * A journey that runs for six weeks cannot live in a process. Nothing about a
 * live journey exists in memory between two scheduler passes: the position is
 * two rows in Postgres and the facts come from the mirror, so a restart
 * mid-flight is indistinguishable from the next pass. The runtime never holds
 * a journey open — it reads where one stood, works out where it stands now,
 * and writes the difference.
 *
 * ## The boundary this does not cross
 *
 * A journey is DDMS's own record (R-76): the DMS has no field for *where this
 * sale has got to*, and nothing upstream will overwrite one. The steps
 * themselves are read out of the mirror and **nothing here writes back to it**
 * (R-5). Where a journey needs a record changed, it goes through the same call
 * a person's button makes (R-81) — it has no second way in.
 */
export const journeysTable = pgTable(
  "journeys",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    /** Which map. `VEHICLE_DELIVERY` is the only one in code today. */
    definitionId: text("definition_id").notNull(),
    /**
     * Which version of it.
     *
     * Definitions are code and change with the product. A journey that started
     * under version 1 keeps saying so, because a trace read next year against a
     * map that has since gained two steps would be a quietly false account of
     * what somebody was asked to do.
     */
    definitionVersion: integer("definition_version").notNull(),

    /**
     * The thing in the world this journey is about — a registration file
     * number, and one day a deal or an enquiry. Scoped by module so two
     * definitions can key off the same string space without colliding.
     */
    subjectModule: text("subject_module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }).notNull(),
    subjectKey: text("subject_key").notNull(),

    /**
     * `LIVE` while it is still moving. `DONE` when the last step completed —
     * the only ending that counts. `ABANDONED` when the thing it was about
     * stopped existing, which is not the same as finishing and must not be
     * counted as one.
     */
    status: text("status", { enum: ["LIVE", "DONE", "ABANDONED"] })
      .notNull()
      .default("LIVE"),
    /** Why it was abandoned. A journey that just stops is a bug report. */
    abandonedReason: text("abandoned_reason"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** The last pass that looked at it. How stale the position may be. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * One journey per thing per map, and it is load-bearing rather than tidy.
     * Discovery runs on every scheduler pass and would otherwise start a second
     * journey for the same registration file every ten minutes — each with its
     * own position, each emitting its own queue row.
     */
    uniqueIndex("journeys_subject_unique").on(t.definitionId, t.subjectModule, t.subjectKey),
    index("journeys_live_idx").on(t.ownerId, t.status),
    index("journeys_showroom_idx").on(t.showroomId, t.status),
  ],
).enableRLS();

/**
 * Every arrival, in order. The newest row for a journey is where it stands.
 *
 * Append-only, and for the sharper of the two reasons the decision log is:
 * this is not merely a history that would be a shame to lose, it **is** the
 * current position, so an update here would not lose the past, it would change
 * what the runtime believes is true now.
 *
 * ## The backwards row is why this is a ledger and not a column
 *
 * A registration file that the RTO rejects goes back to document collection. A
 * column would simply say `DOCUMENTS` again and the fact that it had ever
 * reached the RTO — and why it came back — would be gone. The row records the
 * direction and carries the objection in `reason`, so a file on its third loop
 * reads as a file on its third loop rather than as a file nobody has started.
 *
 * Two backwards shapes exist and only one is here: a **loop** returns to an
 * earlier step on the same journey, which is this. An **unwind** ends the
 * journey and hands a physical asset back — a finance rejection releasing an
 * allocated unit — and that is a different journey's ending, not a step.
 */
export const journeyStepsTable = pgTable(
  "journey_steps",
  {
    id: serial("id").primaryKey(),
    journeyId: integer("journey_id")
      .notNull()
      .references(() => journeysTable.id, { onDelete: "cascade" }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),

    /** The step arrived at, as named in the definition. */
    stepId: text("step_id").notNull(),
    /**
     * Its position in the definition at the time.
     *
     * Stored rather than looked up, because comparing *where it is now* with
     * *where it was* is how a backwards move is detected at all, and a
     * definition that later gains a step must not retroactively turn an old
     * forward move into a backward one.
     */
    stepIndex: integer("step_index").notNull(),

    /**
     * How it got here.
     *
     * `START` opens the journey. `FORWARD` is the ordinary case. `BACKWARD` is
     * a loop and always carries a reason. `FINISH` is the last step completing,
     * and is the only one that is an ending rather than an arrival.
     */
    direction: text("direction", { enum: ["START", "FORWARD", "BACKWARD", "FINISH"] }).notNull(),

    /**
     * Why, in the world's words rather than ours — the RTO's objection text,
     * copied off the mirror. Required in spirit on a `BACKWARD`: a file that
     * went backwards for no recorded reason is the failure this table exists to
     * prevent.
     */
    reason: text("reason"),

    /** How many steps were skipped or unwound, for a trace to read at a glance. */
    fromStepId: text("from_step_id"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The position read: newest row for this journey.
    index("journey_steps_position_idx").on(t.journeyId, t.occurredAt),
    index("journey_steps_owner_idx").on(t.ownerId, t.occurredAt),
  ],
).enableRLS();

export const insertJourneySchema = createInsertSchema(journeysTable).omit({ id: true });
export type InsertJourney = z.infer<typeof insertJourneySchema>;
export type JourneyRow = typeof journeysTable.$inferSelect;
export type JourneyStepRow = typeof journeyStepsTable.$inferSelect;
