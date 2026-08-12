import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * One pass of something unattended, end to end (OBJ-28, R-92, R-93).
 *
 * ## Why the decision log is not enough
 *
 * `decision_log` answers *what happened to this record* and answers it well.
 * It cannot answer *what did the agent do at half past two*, because a run is a
 * narrative **across** records — it looked at a hundred and forty, suggested
 * eleven, was refused on two, acted on one, and called a model four times —
 * and that shape does not exist anywhere in a per-record table. Reconstructing
 * it means sorting the decision log by timestamp and guessing where a pass
 * began, which is a guess that gets worse the busier the dealership is.
 *
 * > **You cannot supervise what you cannot watch.**
 *
 * ## The cost lives here because the run is the thing that has one
 *
 * A model call costs a fraction of a paisa and a runaway loop costs a
 * dealership real money. Neither figure means anything per record; both mean
 * something per pass, per day and per owner. R-92 asks for a per-run cost, a
 * daily ceiling and attribution, and this row is all three.
 *
 * `costPaise` is an **estimate** and is named so nobody mistakes it for an
 * invoice: it is tokens multiplied by a rate table in code, the provider bills
 * on their own count, and the two will differ in the third decimal place. What
 * it is good for is noticing that today cost forty times yesterday.
 *
 * ## Append-only, like everything else that records what happened
 *
 * A run is opened, its steps accumulate, and it is closed once. Nothing edits a
 * finished run — the same argument as `decision_log` and `record_events`: a
 * record of what a process did is answering a different question if the process
 * can rewrite it afterwards.
 */
export const agentRunsTable = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /** Null for a pass that spans the group rather than one outlet. */
    showroomId: integer("showroom_id").references(() => showroomsTable.id, {
      onDelete: "cascade",
    }),

    /**
     * What set it going, and it is the first question anybody asks of a trace.
     *
     * `SCHEDULER` is the timer. `PERSON` is somebody pressing a button, and it
     * carries their id — R-91's third mode, where accountability is unambiguous
     * from the start. `WEBHOOK` is the outside world arriving.
     */
    trigger: text("trigger", { enum: ["SCHEDULER", "PERSON", "WEBHOOK"] }).notNull(),
    triggeredByUserId: integer("triggered_by_user_id"),

    /**
     * Which agent. One today, and the column exists because OBJ-29 adds more
     * and a trace that cannot say which of them acted is a trace of nothing.
     */
    actor: text("actor").notNull().default("AGENT"),
    /** Free-form name of the pass: `assign-orphans`, `rules`, `sync`. */
    kind: text("kind").notNull(),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /**
     * `STOOD_DOWN` is the one worth naming (R-94).
     *
     * It means the agent declined to run — because the dealership has been
     * overruling it, or because the day's ceiling is reached — and it is
     * recorded as a run rather than as nothing, because *the agent chose not to
     * act* and *nothing was scheduled* are different facts and only one of them
     * needs looking into.
     */
    outcome: text("outcome", {
      enum: ["RUNNING", "COMPLETED", "FAILED", "STOOD_DOWN"],
    })
      .notNull()
      .default("RUNNING"),
    /** Why it stood down or failed, in a sentence somebody can act on. */
    reason: text("reason"),

    considered: integer("considered").notNull().default(0),
    proposed: integer("proposed").notNull().default(0),
    acted: integer("acted").notNull().default(0),
    refused: integer("refused").notNull().default(0),

    modelCalls: integer("model_calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Estimated, from a rate table in code. Not an invoice. */
    costPaise: integer("cost_paise").notNull().default(0),

    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("agent_runs_owner_time_idx").on(t.ownerId, t.startedAt),
    index("agent_runs_outcome_idx").on(t.ownerId, t.outcome),
  ],
).enableRLS();

export type AgentRunRow = typeof agentRunsTable.$inferSelect;

/**
 * What happened inside a run, in order (OBJ-28, R-93).
 *
 * ## It is a narrative, not a log level
 *
 * Each step is one thing the run did to one record, or one call it made. Read
 * top to bottom it answers the question a per-record table cannot: *it looked
 * at these, it suggested that, it was refused here and this is what the refusal
 * said.* A supervisor's question is almost always about the shape of a pass
 * rather than the fate of a row.
 *
 * ## What it deliberately is not
 *
 * Not application logging. Nothing writes a step to say a function was entered,
 * and there is no severity column — a steps table with a `DEBUG` level becomes
 * a second logger inside the database within a month, and then a retention
 * problem. Five kinds, closed, each corresponding to something a person would
 * want to see on a screen.
 *
 * Not a second decision log either. A step recording an action **names the
 * decision row** rather than duplicating it: the authoritative record of what
 * happened to a record stays in one place (R-81's instinct), and this points at
 * it. Two tables telling the story of one write is how they come to disagree.
 */
export const agentRunStepsTable = pgTable(
  "agent_run_steps",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => agentRunsTable.id, { onDelete: "cascade" }),
    /** Order within the run. Timestamps collide at this resolution. */
    seq: integer("seq").notNull(),

    /**
     * `READ` looked at something · `PROPOSE` offered a value · `ACT` wrote one
     * through `applyAction` · `REFUSED` was told no, and by what · `MODEL` called
     * a model and what it cost.
     */
    kind: text("kind", { enum: ["READ", "PROPOSE", "ACT", "REFUSED", "MODEL"] }).notNull(),

    module: text("module"),
    recordKey: text("record_key"),
    action: text("action"),

    /** One sentence. What a person reading the trace actually wants. */
    detail: text("detail"),
    /** The decision this step produced, where it produced one. Never a copy of it. */
    decisionId: integer("decision_id"),

    /** MODEL steps only. */
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costPaise: integer("cost_paise"),
    ms: integer("ms"),

    /** Anything structured worth keeping. Nothing queries inside it. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_run_steps_run_idx").on(t.runId, t.seq)],
).enableRLS();

export type AgentRunStepRow = typeof agentRunStepsTable.$inferSelect;
