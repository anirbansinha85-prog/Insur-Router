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
import { usersTable } from "./users";

/**
 * The first thing DDMS knows that the dealer's system does not.
 *
 * Every table before this one is either a **copy** of the OEM's data or a
 * **decision field** hung off one. This is neither: it is a record DDMS creates
 * outright, about something that happened, and no DMS has a field for it.
 *
 * ## Why this is the objective that unlocks the agent
 *
 * OBJ-17 opened two of the twelve registry actions to the agent. Eight of the
 * other ten are closed because they assert *a person did something* — rang the
 * customer, chased the RTO, showed the bike — against a record DDMS does not
 * own. A model cannot make a phone call, so writing those fields asserts work
 * that never happened.
 *
 * Adding more agents does not move that number. **Owning records does.** An
 * activity the agent wrote asserts only that the agent wrote it, and that is
 * true. This table is where an agent can finally say something without lying.
 *
 * ## The boundary, and how it is enforced rather than intended
 *
 * R-76: *DDMS creates nothing the DMS is the source of truth for.* Deals, job
 * cards, stock, enquiries and registration files stay mirror-only forever. What
 * the dealer's system does not hold — an observation, a note, what a customer
 * said on WhatsApp — is DDMS's own.
 *
 * The sharper rule is inside this table rather than around it:
 *
 * > **An agent may record what the agent did. It may never record what a
 * > person did.**
 *
 * That is not a comment; `AGENT_KINDS` in `lib/dms/records.ts` is the closed
 * set an agent may write, and `OBSERVED` and `SYSTEM` are the whole of it. A
 * `CALL` or a `VISIT` describes a human act and only a human may claim one.
 *
 * ## Append-only, and retracted rather than edited
 *
 * A note somebody can silently rewrite is a note nobody can rely on three
 * months later, which is the only time anybody reads one. Retraction marks the
 * row and leaves it, in the same way a cancelled message stays a row — *we
 * decided this was wrong* and *it never happened* are different facts, and only
 * one of them is defensible.
 */
export const recordActivitiesTable = pgTable(
  "record_activities",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    /**
     * What it is about, in the address the whole product already uses.
     *
     * `module` + `recordKey` is how `decision_log` and `outbound_messages`
     * point at a mirror row, and reusing it means an activity, a decision and a
     * message about one registration file can be read as one timeline without
     * anybody inventing a join.
     */
    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }).notNull(),
    recordKey: text("record_key").notNull(),

    /**
     * What kind of thing happened. A closed set, and the closure is what makes
     * the agent boundary checkable.
     *
     * - `NOTE` — somebody typed a thought. No claim beyond having thought it.
     * - `CALL` · `VISIT` · `MESSAGE` — **a person did something outside the
     *   system.** Only a person may write these; that is the whole rule.
     * - `OBSERVED` — the system compared or checked something and is recording
     *   the finding. *"The address on the deal does not match the KYC
     *   document."* An agent may write this because it is what the agent did.
     * - `INBOUND` — the customer said something. Written when a reply arrives
     *   (OBJ-27), and it is the first fact in this product that originates
     *   outside both systems.
     * - `SYSTEM` — housekeeping worth a line on the timeline.
     */
    kind: text("kind", {
      enum: ["NOTE", "CALL", "VISIT", "MESSAGE", "OBSERVED", "INBOUND", "SYSTEM"],
    }).notNull(),

    /** One line, and it is what appears on the timeline. */
    body: text("body").notNull(),

    /**
     * Who wrote it. **Null means the agent did** — R-60's convention, used
     * unchanged here: the system acting has to be distinguishable from having
     * lost track of who acted.
     */
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    /**
     * The name they had at the time.
     *
     * Denormalised for the same two reasons as on `outbound_messages`: it is an
     * audit fact that stays true after somebody is renamed or leaves, and
     * `ddms_app` — the credential every request runs on — has no grant on
     * `users` at all.
     */
    authorName: text("author_name"),
    /** `PERSON` or `AGENT`. Redundant with `userId` and worth saying anyway. */
    authoredBy: text("authored_by", { enum: ["PERSON", "AGENT"] })
      .notNull()
      .default("PERSON"),

    /**
     * Retracted rather than deleted, with who and why.
     *
     * A retracted row still renders, struck through, with the reason. Somebody
     * reading a timeline needs to know a claim was withdrawn; they do not need
     * it to have vanished.
     */
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
    retractedByUserId: integer("retracted_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    retractedReason: text("retracted_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The timeline query: everything about one record, newest first.
    index("record_activities_record_idx").on(t.module, t.recordKey, t.createdAt),
    index("record_activities_owner_idx").on(t.ownerId, t.createdAt),
  ],
).enableRLS();

export const insertRecordActivitySchema = createInsertSchema(recordActivitiesTable).omit({
  id: true,
});
export type InsertRecordActivity = z.infer<typeof insertRecordActivitySchema>;
export type RecordActivityRow = typeof recordActivitiesTable.$inferSelect;
