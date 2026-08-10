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
 * Work somebody decided needs doing, as opposed to work the product noticed.
 *
 * The queue has never stored anything. Every row on it is **derived** — seven
 * classifiers read the mirror and compute what is wrong, on every request, and
 * nothing is written down. That is deliberate and it stays: a stored copy of
 * "this is wrong" goes stale the moment the record moves, and a queue that
 * disagrees with the screen it links to is worse than no queue.
 *
 * But it means DDMS has no way to hold *"ring Mr Pillai on Tuesday"* — a thing
 * that is true because somebody said so, not because a classifier worked it
 * out. That is this table.
 *
 * ## It is not a second list
 *
 * Open tasks appear **in the queue**, sorted with everything else. A separate
 * Tasks screen would recreate exactly the problem OBJ-15 was built to solve:
 * seven places to look and no answer to *what do I do next*. The queue stays
 * the one place, and it now has two sources instead of one.
 *
 * ## Who it belongs to
 *
 * Assigned to an employee code — the same code that sits on the enquiries and
 * job cards they already carry, which is what makes *my work* mean one thing
 * across the product. Unassigned is legitimate and lands in the queue's
 * **Nobody's** band, which is where the dealership's lost work already surfaces.
 *
 * **Nothing here reassigns anything by itself.** The queue's job is visibility
 * for two audiences — a manager sees what is stuck across the outlet, an
 * employee sees what is theirs — and moving work between people is a decision
 * held pending a conversation with a real dealership.
 *
 * ## Where a task comes from
 *
 * `source` matters more than it looks. A task a **journey** raised (OBJ-23)
 * closes itself when the journey moves on; a task a **person** raised does not,
 * because nothing but that person knows when it is done. An agent-raised task
 * is a proposal that somebody accepted, and it is the only thing an agent may
 * put on a human's list — it asks, it does not assert.
 */
export const tasksTable = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    detail: text("detail"),

    /**
     * The record it is about, when it is about one.
     *
     * Nullable, because *"chase the RTO about the three files from March"* is a
     * real task and belongs to no single row. A task with a record joins the
     * timeline; one without still reaches somebody's list.
     */
    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }),
    recordKey: text("record_key"),

    /** The dealer's own employee code. Null means nobody is carrying it. */
    assignedEmpCode: text("assigned_emp_code"),
    /** Their name at the time, for the same reason activities keep one. */
    assignedEmpName: text("assigned_emp_name"),

    /** A date, not a timestamp: dealerships work in days. */
    dueOn: text("due_on"),

    status: text("status", { enum: ["OPEN", "DONE", "CANCELLED"] })
      .notNull()
      .default("OPEN"),

    /**
     * Who raised it, and it changes what closing it means.
     *
     * `JOURNEY` tasks are closed by the journey moving on (OBJ-23). `PERSON`
     * and `AGENT` tasks are closed by a person, because nothing else can know.
     */
    source: text("source", { enum: ["PERSON", "AGENT", "JOURNEY"] })
      .notNull()
      .default("PERSON"),
    /** Null when the agent or a journey raised it — R-60, unchanged. */
    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdByName: text("created_by_name"),

    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByUserId: integer("completed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** Why it was cancelled, or what was actually done. Either is worth keeping. */
    outcome: text("outcome"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The queue's read: everything still open for this owner.
    index("tasks_owner_status_idx").on(t.ownerId, t.status, t.dueOn),
    index("tasks_assignee_idx").on(t.showroomId, t.assignedEmpCode, t.status),
    index("tasks_record_idx").on(t.module, t.recordKey),
  ],
).enableRLS();

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type TaskRow = typeof tasksTable.$inferSelect;
