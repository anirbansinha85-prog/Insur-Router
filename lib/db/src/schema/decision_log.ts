import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { usersTable } from "./users";

/**
 * Every decision field change, with a name against it.
 *
 * The decision fields scattered across the mirror tables record *what* we
 * concluded. Until this table existed, nothing recorded **who** concluded it or
 * **when**, which matters more here than it looks:
 *
 * - "We told the customer their vehicle was ready" is a claim somebody may
 *   later dispute, and a bare timestamp on a job card cannot answer *who said
 *   so*.
 * - Every mark is reversible — a mis-click on "customer told" would otherwise
 *   quietly remove a needed phone call from the worklist forever — and a
 *   reversal without a trail is indistinguishable from the mark never having
 *   happened.
 * - It is the substrate the approval gate needs. "No message leaves without a
 *   rule permitting it or a person approving it" is only enforceable if
 *   approvals are recorded somewhere, and this is that somewhere.
 *
 * Append-only by convention rather than by constraint: nothing in the
 * application updates or deletes a row here, and `ddms_app` is granted insert
 * and select and nothing else.
 */
export const decisionLogTable = pgTable(
  "decision_log",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    /**
     * Who. Nullable only because a future automated rule may act without a
     * person — and when it does, a null here has to read as "the system did
     * this", never as "we lost track of who did".
     */
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),

    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART"],
    }).notNull(),
    /** The mirror row's own key — dealId, jcNo, enqId, regnFileNo, partNo. */
    recordKey: text("record_key").notNull(),
    /** The action id from `lib/dms/actions.ts`. */
    action: text("action").notNull(),

    /**
     * What the fields looked like before and after.
     *
     * Both stored, because "set to null" and "was already null" are different
     * events and only the pair distinguishes them. Small objects — the changed
     * fields only, not the whole row.
     */
    previousValue: jsonb("previous_value").$type<Record<string, unknown>>(),
    newValue: jsonb("new_value").$type<Record<string, unknown>>(),

    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("decision_log_record_idx").on(t.module, t.recordKey),
    index("decision_log_owner_time_idx").on(t.ownerId, t.createdAt),
  ],
).enableRLS();

export const insertDecisionLogSchema = createInsertSchema(decisionLogTable).omit({ id: true });
export type InsertDecisionLog = z.infer<typeof insertDecisionLogSchema>;
export type DecisionLogRow = typeof decisionLogTable.$inferSelect;
