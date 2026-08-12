import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import {
  agentRunStepsTable,
  agentRunsTable,
  db,
  type AgentRunRow,
} from "@workspace/db";

import { logger } from "../logger";
import type { ResolvedPolicy } from "./policy";

/**
 * Watching what runs unattended, and what it costs (OBJ-28, R-92, R-93).
 *
 * ## The trace is ambient, for the same reason the database handle is
 *
 * `withRun()` opens a run and puts it in an `AsyncLocalStorage`, exactly as
 * `sessionScope` does with the request's connection. Everything underneath —
 * the agent, the composer, the mapping model — records against it by calling
 * `step()` and knows nothing about run ids.
 *
 * The alternative was threading a run id through `runAgentForShowroom`,
 * `suggestForItems`, `composeFor` and `rewriteWithModel`, which is four
 * signatures changed to carry something none of them care about, and a fifth
 * call site that forgets and silently records nothing. `lib/db/src/scope.ts`
 * makes the same argument about the connection and it applies here unchanged.
 *
 * **Outside a run, every function here is a no-op.** A person pressing a button
 * is not a trace and must not become one — the decision log already answers for
 * that, and a steps table that fills up with request handling is a second
 * logger inside the database.
 *
 * ## Cost is an estimate and is named as one
 *
 * Tokens times a rate table in code. The provider bills on their own count and
 * the two differ in the third decimal place. What the figure is *for* is
 * noticing that today cost forty times yesterday, and for a ceiling — both of
 * which work fine on an estimate and neither of which is an invoice.
 */

interface RunContext {
  runId: number;
  ownerId: number;
  seq: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costPaise: number;
}

const runStore = new AsyncLocalStorage<RunContext>();

/**
 * Paise per million tokens, and the numbers are deliberately conservative.
 *
 * A rate table in code rather than in the policy registry: these are the
 * provider's prices, not the dealership's judgement, and R-58's line is that
 * numbers belonging to the dealership go in the registry while numbers
 * belonging to the world go here. An unknown model is billed at the highest
 * rate in the table — the failure that matters is a ceiling that lets a run
 * through because nobody added its model.
 */
const RATE_PAISE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gemini-flash-latest": { input: 625, output: 2_500 },
  "gemini-2.0-flash": { input: 625, output: 2_500 },
  "gpt-4o": { input: 208_000, output: 833_000 },
};
const FALLBACK_RATE = { input: 208_000, output: 833_000 };

export function estimateCostPaise(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATE_PAISE_PER_MTOK[model] ?? FALLBACK_RATE;
  return Math.ceil((inputTokens * rate.input + outputTokens * rate.output) / 1_000_000);
}

export interface StartRun {
  ownerId: number;
  showroomId?: number | null;
  trigger: "SCHEDULER" | "PERSON" | "WEBHOOK";
  triggeredByUserId?: number | null;
  actor?: string;
  /** `assign-orphans`, `rules`, `sync` — the name of the pass. */
  kind: string;
}

/**
 * Open a run, do the work, close it whatever happens.
 *
 * The `finally` is load-bearing. A pass that throws halfway is the one somebody
 * most needs to see, and a run left `RUNNING` for ever is indistinguishable
 * from one still going — which would make the daily cost ceiling read a
 * crashed run as an active one for the rest of the day.
 */
export async function withRun<T>(
  input: StartRun,
  fn: (run: { id: number }) => Promise<T>,
): Promise<T> {
  const [row] = await db
    .insert(agentRunsTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId ?? null,
      trigger: input.trigger,
      triggeredByUserId: input.triggeredByUserId ?? null,
      actor: input.actor ?? "AGENT",
      kind: input.kind,
    })
    .returning();

  const ctx: RunContext = {
    runId: row!.id,
    ownerId: input.ownerId,
    seq: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costPaise: 0,
  };
  const startedAt = Date.now();

  return runStore.run(ctx, async () => {
    try {
      const out = await fn({ id: ctx.runId });
      await close(ctx, "COMPLETED", null, startedAt);
      return out;
    } catch (err) {
      await close(ctx, "FAILED", (err as Error).message, startedAt);
      throw err;
    }
  });
}

async function close(
  ctx: RunContext,
  outcome: "COMPLETED" | "FAILED" | "STOOD_DOWN",
  reason: string | null,
  startedAt: number,
): Promise<void> {
  await db
    .update(agentRunsTable)
    .set({
      outcome,
      reason,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt,
      modelCalls: ctx.modelCalls,
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      costPaise: ctx.costPaise,
    })
    .where(eq(agentRunsTable.id, ctx.runId));
}

export interface StepInput {
  kind: "READ" | "PROPOSE" | "ACT" | "REFUSED" | "MODEL";
  module?: string | null;
  recordKey?: string | null;
  action?: string | null;
  detail?: string | null;
  /** The decision row this produced. Named, never copied. */
  decisionId?: number | null;
  payload?: Record<string, unknown>;
}

/** Append a step to the ambient run. Silent no-op outside one. */
export async function step(input: StepInput): Promise<void> {
  const ctx = runStore.getStore();
  if (!ctx) return;
  ctx.seq += 1;
  await db.insert(agentRunStepsTable).values({
    runId: ctx.runId,
    seq: ctx.seq,
    kind: input.kind,
    module: input.module ?? null,
    recordKey: input.recordKey ?? null,
    action: input.action ?? null,
    detail: input.detail ?? null,
    decisionId: input.decisionId ?? null,
    payload: input.payload ?? null,
  });
}

/**
 * Record what a model call cost, wherever it was made.
 *
 * Called from the one place model calls go through, so a new call site is
 * metered by construction rather than by whoever adds it remembering. Outside a
 * run it still returns the estimate — a person pressing *explain* pays for a
 * model call too, and the figure is worth having even where there is no trace
 * to hang it on.
 */
export async function meterModel(input: {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  ok: boolean;
  detail?: string;
}): Promise<number> {
  const costPaise = estimateCostPaise(input.model, input.inputTokens, input.outputTokens);
  const ctx = runStore.getStore();
  if (!ctx) return costPaise;

  ctx.modelCalls += 1;
  ctx.inputTokens += input.inputTokens;
  ctx.outputTokens += input.outputTokens;
  ctx.costPaise += costPaise;
  ctx.seq += 1;

  await db.insert(agentRunStepsTable).values({
    runId: ctx.runId,
    seq: ctx.seq,
    kind: "MODEL",
    action: input.purpose,
    detail: input.detail ?? (input.ok ? null : "The call failed; the template wording was used."),
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costPaise,
    ms: input.ms,
  });
  return costPaise;
}

// ── Standing down ───────────────────────────────────────────────────────────

export interface StandDown {
  /** True when the agent should not run at all right now. */
  standDown: boolean;
  reason: string | null;
  /** Everything the screen needs to explain it, whichever way it went. */
  spentTodayPaise: number;
  capPaise: number;
  overrideRatePct: number | null;
  ceilingPct: number;
}

/**
 * Whether the agent should pause itself (R-94).
 *
 * ## Two reasons, and they are different in kind
 *
 * **Money**: today's runs have reached the dealership's ceiling. A flat,
 * arithmetic stop, and the only defence against a loop that would otherwise
 * spend all night.
 *
 * **Being wrong**: people here have been overruling it. That is the interesting
 * one, and it is the counterpart to the ladder coming down. The ladder demotes
 * a *pattern* somebody keeps overruling; this stops the *agent* when it is
 * being overruled broadly, because a product that keeps proposing while a
 * dealership keeps saying no is one they stop reading and then stop trusting.
 *
 * ## Why it is not a switch a person flips
 *
 * `AGENT.ASSIGN_ORPHANS` already exists for *should this run at all*, and it is
 * the dealership's decision. This is the agent's own, made on evidence, and it
 * recovers by itself: acceptance improves inside the window, or the day turns
 * over, and it runs again with nobody re-enabling anything. A stand-down that
 * needed a person to clear it would be an outage.
 *
 * ## It is recorded as a run
 *
 * A stand-down writes an `agent_runs` row with outcome `STOOD_DOWN` and the
 * reason. *The agent chose not to act* and *nothing was scheduled* are
 * different facts, and only one of them needs looking into.
 */
export async function shouldStandDown(input: {
  ownerId: number;
  policy: ResolvedPolicy;
  /** Override rate across every pattern in the window, from `standingFor`. */
  overrideRatePct: number | null;
}): Promise<StandDown> {
  const capPaise = input.policy.number("AGENT.DAILY_COST_CAP_PAISE");
  const ceilingPct = input.policy.number("AGENT.STAND_DOWN_PCT");

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const [spent] = await db
    .select({ total: sql<number>`coalesce(sum(${agentRunsTable.costPaise}), 0)::int` })
    .from(agentRunsTable)
    .where(and(eq(agentRunsTable.ownerId, input.ownerId), gte(agentRunsTable.startedAt, since)));

  const spentTodayPaise = spent?.total ?? 0;
  const base: Omit<StandDown, "standDown" | "reason"> = {
    spentTodayPaise,
    capPaise,
    overrideRatePct: input.overrideRatePct,
    ceilingPct,
  };

  if (spentTodayPaise >= capPaise) {
    return {
      ...base,
      standDown: true,
      reason:
        `Today's runs have reached the dealership's ceiling of ₹${(capPaise / 100).toFixed(2)}. ` +
        "Nothing further runs unattended until tomorrow; anything a person presses still works.",
    };
  }

  if (input.overrideRatePct !== null && input.overrideRatePct >= ceilingPct) {
    return {
      ...base,
      standDown: true,
      reason:
        `People here have overruled ${input.overrideRatePct}% of what was suggested, against a ceiling of ${ceilingPct}%. ` +
        "The agent has paused itself rather than keep proposing. It resumes on its own once acceptance recovers — nobody has to re-enable anything.",
    };
  }

  return { ...base, standDown: false, reason: null };
}

/** Write the stand-down down, so *chose not to* is distinguishable from *nothing happened*. */
export async function recordStandDown(input: StartRun & { reason: string }): Promise<void> {
  const [row] = await db
    .insert(agentRunsTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId ?? null,
      trigger: input.trigger,
      triggeredByUserId: input.triggeredByUserId ?? null,
      actor: input.actor ?? "AGENT",
      kind: input.kind,
      outcome: "STOOD_DOWN",
      reason: input.reason,
      finishedAt: new Date(),
      durationMs: 0,
    })
    .returning();
  logger.warn({ ownerId: input.ownerId, runId: row?.id, reason: input.reason }, "Agent stood down");
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface TraceSummary {
  runs: AgentRunRow[];
  /** Today's spend against today's ceiling, for the header. */
  spentTodayPaise: number;
  capPaise: number;
  /** The most recent stand-down that has not been superseded by a good run. */
  standingDown: { reason: string; at: string } | null;
}

export async function recentRuns(input: {
  ownerId: number;
  showroomIds: number[];
  limit?: number;
  policy: ResolvedPolicy;
}): Promise<TraceSummary> {
  const runs = await db
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.ownerId, input.ownerId))
    .orderBy(desc(agentRunsTable.startedAt))
    .limit(input.limit ?? 50);

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const spentTodayPaise = runs
    .filter((r) => r.startedAt >= since)
    .reduce((n, r) => n + r.costPaise, 0);

  /*
   * Standing down only counts while it is still the newest thing that happened.
   *
   * A stand-down three days ago followed by six good runs is history, not a
   * state — showing it as a live warning would leave a banner on the screen
   * that nothing ever clears, which is how people learn to ignore banners.
   */
  const newest = runs[0];
  const standingDown =
    newest?.outcome === "STOOD_DOWN" && newest.reason
      ? { reason: newest.reason, at: newest.startedAt.toISOString() }
      : null;

  return {
    runs,
    spentTodayPaise,
    capPaise: input.policy.number("AGENT.DAILY_COST_CAP_PAISE"),
    standingDown,
  };
}

export async function stepsFor(ownerId: number, runId: number) {
  const [run] = await db
    .select()
    .from(agentRunsTable)
    .where(and(eq(agentRunsTable.ownerId, ownerId), eq(agentRunsTable.id, runId)));
  if (!run) return null;

  const steps = await db
    .select()
    .from(agentRunStepsTable)
    .where(eq(agentRunStepsTable.runId, runId))
    .orderBy(agentRunStepsTable.seq);

  return { run, steps };
}
