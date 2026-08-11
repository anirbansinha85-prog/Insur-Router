/**
 * What the agent offered, and what a person did about it (OBJ-26).
 *
 * The ladder is a count, and until this file there was nothing counted. The
 * agent's suggestions rode on a queue row and vanished when the page closed, so
 * *how often is it right* had no answer anywhere in the product — which is why
 * the honest version of autonomy could not be built before now.
 *
 * ## The agent records what the agent did, and never the other half
 *
 * `record()` writes what was proposed. **Nothing here writes an acceptance.**
 * `resolve()` reads `decision_log` — which only `applyAction` may append to —
 * and works out what happened by comparing what a person actually did against
 * what was on offer. The agent therefore cannot mark its own proposal accepted,
 * which is the single property that stops the ladder being a thing it can climb
 * by itself.
 *
 * That is OBJ-22's rule arriving where it matters most:
 *
 * > **An agent may record what the agent did. It may never record what a person
 * > did.**
 *
 * ## Four outcomes, and the fourth is the one people get wrong
 *
 * | | |
 * |---|---|
 * | `ACCEPTED` | somebody did the proposed thing |
 * | `OVERRIDDEN` | somebody did something else — the signal that demotes |
 * | `ACTED` | the agent did it, at rung 3, under standing consent |
 * | `EXPIRED` | **nobody got to it** — and it counts neither way |
 *
 * A queue nobody had time to reach is not a rejection. Counting it as one would
 * demote the agent for the dealership being short-staffed, which is the exact
 * circumstance this whole product exists to be sympathetic about.
 */

import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, agentProposalsTable, decisionLogTable, type ProposalOutcome } from "@workspace/db";
import { logger } from "../logger";
import { choiceOf } from "./precedent";

export interface ProposalToRecord {
  ownerId: number;
  showroomId: number;
  patternKey: string;
  module: string;
  recordKey: string;
  action: string;
  proposedValue: Record<string, unknown>;
  reason: string;
  rung: number;
}

/**
 * Write down what is being offered, once per open piece of work.
 *
 * `onConflictDoNothing` against the partial unique index rather than a read
 * first: the scheduler runs repeatedly over a queue that changes slowly, and
 * without it a record nobody had time to reach would collect a proposal every
 * pass — one ignored row reading as forty, and an override rate computed
 * against a denominator the dealership never saw.
 */
export async function recordProposals(rows: ProposalToRecord[]): Promise<number> {
  if (rows.length === 0) return 0;

  const written = await db
    .insert(agentProposalsTable)
    .values(
      rows.map((r) => ({
        ownerId: r.ownerId,
        showroomId: r.showroomId,
        patternKey: r.patternKey,
        module: r.module as "DEAL",
        recordKey: r.recordKey,
        action: r.action,
        proposedValue: r.proposedValue,
        reason: r.reason,
        rung: r.rung,
        outcome: "OFFERED" as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: agentProposalsTable.id });

  return written.length;
}

/**
 * Mark what the agent itself did, at rung 3.
 *
 * Separate from an acceptance because nobody accepted anything. Conflating the
 * two would let a pattern running unattended keep re-earning the consent that
 * lets it run unattended — the loop R-66 exists to prevent, arriving through
 * the one door R-66 does not cover.
 */
export async function markActed(input: {
  ownerId: number;
  showroomId: number;
  module: string;
  recordKey: string;
  action: string;
}): Promise<void> {
  await db
    .update(agentProposalsTable)
    .set({ outcome: "ACTED", outcomeAt: new Date() })
    .where(
      and(
        eq(agentProposalsTable.ownerId, input.ownerId),
        eq(agentProposalsTable.showroomId, input.showroomId),
        eq(agentProposalsTable.module, input.module as "DEAL"),
        eq(agentProposalsTable.recordKey, input.recordKey),
        eq(agentProposalsTable.action, input.action),
        eq(agentProposalsTable.outcome, "OFFERED"),
      ),
    );
}

export interface ResolveResult {
  accepted: number;
  overridden: number;
  expired: number;
  /** A person undoing what the agent did unattended. The sharpest signal there is. */
  reversed: number;
}

/**
 * Work out what became of every open proposal, deterministically.
 *
 * No model anywhere near this. Whether somebody accepted a suggestion is a
 * comparison between two stored objects, and a model asked to judge it would be
 * a model deciding how much autonomy the agent has earned — which is R-49's
 * refusal in its purest form.
 *
 * Runs in the scheduler after the agent pass, on `ddms_worker`.
 */
export async function resolveProposals(input: {
  ownerId: number;
  showroomIds: number[];
  /** Proposals older than this with nothing against them are `EXPIRED`. */
  expireAfterDays: number;
}): Promise<ResolveResult> {
  const result: ResolveResult = { accepted: 0, overridden: 0, expired: 0, reversed: 0 };
  if (input.showroomIds.length === 0) return result;

  const open = await db
    .select()
    .from(agentProposalsTable)
    .where(
      and(
        eq(agentProposalsTable.ownerId, input.ownerId),
        inArray(agentProposalsTable.showroomId, input.showroomIds),
        inArray(agentProposalsTable.outcome, ["OFFERED", "ACTED"]),
      ),
    )
    .orderBy(asc(agentProposalsTable.createdAt));

  if (open.length === 0) return result;

  const oldest = open[0]!.createdAt;
  const keys = [...new Set(open.map((p) => p.recordKey))];

  /*
   * Only decisions a **person** made, and only ones after the oldest proposal.
   *
   * A null `userId` is the agent, and the agent's own write is what produced
   * the `ACTED` row in the first place; reading it back as an acceptance would
   * be the self-reinforcement loop with an extra step in it.
   */
  const decisions = await db
    .select({
      id: decisionLogTable.id,
      showroomId: decisionLogTable.showroomId,
      module: decisionLogTable.module,
      recordKey: decisionLogTable.recordKey,
      action: decisionLogTable.action,
      newValue: decisionLogTable.newValue,
      userId: decisionLogTable.userId,
      createdAt: decisionLogTable.createdAt,
    })
    .from(decisionLogTable)
    .where(
      and(
        eq(decisionLogTable.ownerId, input.ownerId),
        inArray(decisionLogTable.showroomId, input.showroomIds),
        inArray(decisionLogTable.recordKey, keys),
        gt(decisionLogTable.createdAt, oldest),
      ),
    )
    .orderBy(asc(decisionLogTable.createdAt));

  const settle = async (
    id: number,
    outcome: ProposalOutcome,
    at: Date,
    userId: number | null,
    decisionId: number | null,
  ) => {
    await db
      .update(agentProposalsTable)
      .set({ outcome, outcomeAt: at, outcomeByUserId: userId, outcomeDecisionId: decisionId })
      .where(eq(agentProposalsTable.id, id));
  };

  for (const p of open) {
    // The person's decision about this record and this action, after it was
    // offered. Cleared counts, and counts as the opposite of accepting.
    const theirs = decisions.find(
      (d) =>
        d.userId !== null &&
        d.showroomId === p.showroomId &&
        d.module === p.module &&
        d.recordKey === p.recordKey &&
        (d.action === p.action || d.action === `${p.action}_CLEARED`) &&
        d.createdAt > p.createdAt,
    );

    if (!theirs) {
      /*
       * Nothing happened. Expire it once it is old enough, and leave it open
       * until then — a proposal made an hour ago that nobody has reached is
       * not evidence of anything yet, in either direction.
       *
       * An `ACTED` row is never expired: the agent did the work, and *no
       * person objected within the window* is exactly what the outcome
       * already says.
       */
      const age = (Date.now() - p.createdAt.getTime()) / 86_400_000;
      if (p.outcome === "OFFERED" && age > input.expireAfterDays) {
        await settle(p.id, "EXPIRED", new Date(), null, null);
        result.expired++;
      }
      continue;
    }

    const undone = theirs.action.endsWith("_CLEARED");
    const same = !undone && choiceOf(p.action, theirs.newValue) === choiceOf(p.action, p.proposedValue);

    if (p.outcome === "ACTED") {
      /*
       * A person undoing what the agent did on its own.
       *
       * The sharpest demotion signal in the product, and the reason `clear` was
       * built reversible in the first place: the dealership takes back a
       * standing consent by *working*, not by finding a settings screen. An
       * `ACTED` row that a person left alone stays `ACTED` and keeps counting
       * for the pattern.
       */
      if (undone || !same) {
        await settle(p.id, "OVERRIDDEN", theirs.createdAt, theirs.userId, theirs.id);
        result.overridden++;
        result.reversed++;
        logger.info(
          { patternKey: p.patternKey, recordKey: p.recordKey },
          "A person undid what the agent did unattended",
        );
      }
      continue;
    }

    if (same) {
      await settle(p.id, "ACCEPTED", theirs.createdAt, theirs.userId, theirs.id);
      result.accepted++;
    } else {
      await settle(p.id, "OVERRIDDEN", theirs.createdAt, theirs.userId, theirs.id);
      result.overridden++;
    }
  }

  return result;
}

/**
 * Close proposals about records that have moved on.
 *
 * A pattern that stops being offered leaves rows sitting `OFFERED` for ever,
 * and they would sink the override rate's denominator without ever being
 * answered. Kept separate from `resolveProposals` because *nobody answered* and
 * *this is no longer a live question* are different facts, even though both end
 * `EXPIRED`.
 */
export async function expireStale(input: {
  ownerId: number;
  beforeDays: number;
}): Promise<number> {
  const rows = await db
    .update(agentProposalsTable)
    .set({ outcome: "EXPIRED", outcomeAt: new Date() })
    .where(
      and(
        eq(agentProposalsTable.ownerId, input.ownerId),
        eq(agentProposalsTable.outcome, "OFFERED"),
        lt(
          agentProposalsTable.createdAt,
          new Date(Date.now() - input.beforeDays * 86_400_000),
        ),
      ),
    )
    .returning({ id: agentProposalsTable.id });
  return rows.length;
}

/** What has been proposed lately, newest first. For the screen. */
export async function recentProposals(input: {
  ownerId: number;
  showroomIds: number[];
  patternKey?: string;
  limit?: number;
}): Promise<
  Array<{
    id: number;
    patternKey: string;
    module: string;
    recordKey: string;
    action: string;
    reason: string | null;
    rung: number;
    outcome: string;
    createdAt: string;
    outcomeAt: string | null;
  }>
> {
  if (input.showroomIds.length === 0) return [];
  const rows = await db
    .select()
    .from(agentProposalsTable)
    .where(
      and(
        eq(agentProposalsTable.ownerId, input.ownerId),
        inArray(agentProposalsTable.showroomId, input.showroomIds),
        ...(input.patternKey ? [eq(agentProposalsTable.patternKey, input.patternKey)] : []),
      ),
    )
    .orderBy(sql`${agentProposalsTable.createdAt} desc`)
    .limit(input.limit ?? 50);

  return rows.map((r) => ({
    id: r.id,
    patternKey: r.patternKey,
    module: r.module,
    recordKey: r.recordKey,
    action: r.action,
    reason: r.reason,
    rung: r.rung,
    outcome: r.outcome,
    createdAt: r.createdAt.toISOString(),
    outcomeAt: r.outcomeAt?.toISOString() ?? null,
  }));
}
