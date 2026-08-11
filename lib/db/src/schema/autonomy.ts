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
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { usersTable } from "./users";

/**
 * What the agent offered, and what became of it (OBJ-26, R-79).
 *
 * Everyone builds autonomy as a dial somebody sets. This product earns it:
 *
 * | | the system | who decides |
 * |---|---|---|
 * | 0 · watching | notices a pattern, says nothing | nobody |
 * | 1 · recall | *"the last 7 times, you gave it to Jaswinder"* | a person, every time |
 * | 2 · pre-filled | the answer is already selected; press go | a person, faster |
 * | 3 · automatic | *"10 out of 10 — shall I just do it?"* → consent, once | a person, once, revocably |
 *
 * A count is a fact where a dial is a guess. But a count needs something
 * counted, and until this table there was nothing: the agent's suggestions rode
 * on a queue row and vanished when the page closed, so *how often is it right*
 * had no answer anywhere in the product.
 *
 * ## Why this is not a memory store, and does not breach R-67
 *
 * R-67 forbids storing anything as memory that was not already a fact. Nothing
 * here is a memory. A row is **what the agent did** — it proposed this, at this
 * rung, on this record — which is precisely what OBJ-22's rule permits an agent
 * to record about itself. There is no summarised text, no preference, no free
 * field a caller supplies: the whole poisoning surface the literature warns
 * about is the thing that is absent.
 *
 * And the other half of every row — whether a person accepted it — is **not
 * written here by anybody**. It is resolved against `decision_log`, which only
 * `applyAction` may append to. The agent cannot mark its own proposal accepted,
 * which is the property that stops the ladder being a thing it can climb by
 * itself.
 *
 * ## Precedent still comes from the decision log, not from here
 *
 * These two answer different questions and the distinction is load-bearing:
 *
 * - *What does this dealership do?* — `decision_log`, people only (R-66).
 * - *How often is the agent right about it?* — this table.
 *
 * The first is what gets cited to a person. The second is what earns a rung.
 * Reading the second as the first would be the self-reinforcement failure in
 * its exact textbook form: the agent proposing, its own proposals becoming the
 * evidence, and one early mistake settling into a belief nobody can see from
 * inside.
 */
export const agentProposalsTable = pgTable(
  "agent_proposals",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    /**
     * The unit that graduates: `MODULE:STATE:ACTION`.
     *
     * **Per pattern, not per agent and not per module** (R-79). A dealership
     * that always hands orphaned enquiries to the same person has not thereby
     * said anything about registration files, and a ladder that promoted the
     * agent as a whole would carry the confidence earned on one kind of work
     * onto every other kind.
     */
    patternKey: text("pattern_key").notNull(),

    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }).notNull(),
    recordKey: text("record_key").notNull(),
    /** The action id from `lib/dms/actions.ts`. */
    action: text("action").notNull(),

    /**
     * What was proposed, in the same shape the decision log records.
     *
     * Compared field by field against what a person actually did, which is what
     * separates *accepted* from *did something else*. Storing the rendered
     * sentence instead would have made that comparison a string match on prose.
     */
    proposedValue: jsonb("proposed_value").$type<Record<string, unknown>>(),
    /** The sentence shown beside it. Kept so a later reader sees what was read. */
    reason: text("reason"),

    /** Which rung the pattern stood on when this was offered. 0 to 3. */
    rung: integer("rung").notNull().default(1),

    /**
     * What became of it, and each value is a different fact.
     *
     * `OFFERED` is open. `ACCEPTED` is a person doing the proposed thing.
     * `OVERRIDDEN` is a person doing something else, which is the signal that
     * demotes — **not** a person doing nothing, which is `EXPIRED` and counts
     * neither way. A queue nobody had time to reach is not a rejection, and
     * treating it as one would demote the agent for the dealership being busy.
     *
     * `ACTED` is the agent itself, at rung 3 under standing consent. It is
     * separate from `ACCEPTED` because nobody accepted anything; and a person
     * reversing it afterwards turns it into `OVERRIDDEN`, which is how a
     * standing consent gets taken back by the work rather than by a meeting.
     */
    outcome: text("outcome", {
      enum: ["OFFERED", "ACCEPTED", "OVERRIDDEN", "ACTED", "EXPIRED"],
    })
      .notNull()
      .default("OFFERED"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    /** Who resolved it. Null on `ACTED` and on `EXPIRED`, and that is R-60. */
    outcomeByUserId: integer("outcome_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** The decision-log row that resolved it, so the pair is auditable. */
    outcomeDecisionId: integer("outcome_decision_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One open proposal per record per action.
     *
     * The scheduler runs repeatedly over a queue that changes slowly, so
     * without this a record nobody had time to reach would accumulate a
     * proposal every pass and a single ignored row would look like forty.
     * Partial, on `OFFERED` only, so the history stays.
     */
    uniqueIndex("agent_proposals_open_unique")
      .on(t.showroomId, t.module, t.recordKey, t.action)
      .where(sql`outcome = 'OFFERED'`),
    index("agent_proposals_pattern_idx").on(t.showroomId, t.patternKey, t.createdAt),
    index("agent_proposals_owner_idx").on(t.ownerId, t.createdAt),
  ],
).enableRLS();

/**
 * A person saying *yes, just do this one from now on* (R-79, rung 3).
 *
 * The only thing in the ladder that is stored rather than counted, and it is
 * stored because it is a **decision** rather than an observation. Rungs 0 to 2
 * are derived from the moving window and move on their own; rung 3 needs
 * somebody to have said so, and there has to be a row with their name on it
 * before an unattended process starts acting.
 *
 * > **Consent raises the ceiling. Evidence sets what has been earned. Both
 * > have to hold.**
 *
 * So a consent standing while acceptance falls does not keep a pattern at rung
 * 3 — the earned rung drops and the pattern drops with it, with the consent row
 * untouched and still true. Demotion never deletes anybody's decision, and
 * recovery does not need somebody to remember to re-grant it. That is the
 * difference between a ratchet and a ladder.
 *
 * ## Owner-scoped, where the evidence is outlet-scoped
 *
 * Deliberate asymmetry. *The last seven times you gave it to Jaswinder* is
 * about this branch — Jaswinder does not work at the other one — so precedent
 * is counted per outlet. Consent is the owner's to give, because letting an
 * unattended process act is a decision about the business rather than about a
 * branch. R-82's boundary is unchanged either way: neither crosses a group.
 */
export const autonomyConsentsTable = pgTable(
  "autonomy_consents",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    patternKey: text("pattern_key").notNull(),

    grantedByUserId: integer("granted_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    grantedByName: text("granted_by_name"),
    /** The count that was on the table when they said yes. Their evidence. */
    grantedOnCount: integer("granted_on_count").notNull().default(0),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),

    /** Revoked, never deleted — the same argument as a cancelled message. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: integer("revoked_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    index("autonomy_consents_owner_idx").on(t.ownerId, t.patternKey),
    index("autonomy_consents_live_idx").on(t.ownerId, t.revokedAt),
  ],
).enableRLS();

export const proposalOutcomeSchema = z.enum([
  "OFFERED",
  "ACCEPTED",
  "OVERRIDDEN",
  "ACTED",
  "EXPIRED",
]);
export type ProposalOutcome = z.infer<typeof proposalOutcomeSchema>;

export type AgentProposalRow = typeof agentProposalsTable.$inferSelect;
export type AutonomyConsentRow = typeof autonomyConsentsTable.$inferSelect;
