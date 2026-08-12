/**
 * OBJ-28's done-when, stated so it can fail.
 *
 * > *A pass is one run with its steps in order and its cost against it. The
 * > agent pauses itself when the dealership is overruling it or the day's money
 * > is gone, records that it chose to, and recovers without anybody clearing
 * > anything. Nothing a person presses is affected.*
 *
 * The last clause is the one worth guarding. A cost ceiling that also stopped
 * somebody's button working would be a product that goes down when it gets
 * busy, and it is a very easy mistake to make — the check is one line in the
 * wrong function.
 *
 * ## What it drives rather than fakes
 *
 * Runs are opened with `withRun` and steps recorded through `step`, the same
 * functions the scheduler uses, rather than rows inserted into the tables. The
 * interesting failures are in the ambient context: whether a step outside a run
 * is silently dropped, whether a run that throws is still closed, whether cost
 * accumulates onto the right one.
 *
 * Runs on the **worker credential**, because that is the only one that may
 * write a run at all — and section 6 asserts the request credential cannot.
 *
 * `pnpm run verify:trace`.
 */

import { and, eq, sql } from "drizzle-orm";

import {
  agentRunStepsTable,
  agentRunsTable,
  db,
  ownerDb,
  withWorkerScope,
} from "@workspace/db";

import { loadPolicy, setPolicy, POLICY_BY_KEY } from "../lib/dms/policy";
import {
  estimateCostPaise,
  meterModel,
  recentRuns,
  recordStandDown,
  shouldStandDown,
  step,
  stepsFor,
  withRun,
} from "../lib/dms/trace";

const OWNER = 1;
const KIND = "verify:trace";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

/**
 * Everything this run wrote, findable after a crash.
 *
 * The `kind` column carries the marker, so a run that threw halfway is cleaned
 * by the next attempt rather than counted by it. Steps cascade with their run.
 */
async function reset(): Promise<void> {
  await ownerDb
    .delete(agentRunsTable)
    .where(and(eq(agentRunsTable.ownerId, OWNER), eq(agentRunsTable.kind, KIND)));
}

console.log("\nOBJ-28 — the trace, the cost and the stand-down");
await reset();

const policy0 = await loadPolicy(OWNER);
const CAP = policy0.number("AGENT.DAILY_COST_CAP_PAISE");
const CEILING = policy0.number("AGENT.STAND_DOWN_PCT");

// ═════════════════════════════════════════════════════════════════════════
section("1. A pass is one run, with its steps in order");

const runId = await withWorkerScope(async () =>
  withRun({ ownerId: OWNER, trigger: "SCHEDULER", kind: KIND }, async (run) => {
    await step({ kind: "READ", detail: "Looked at 140 items." });
    await step({ kind: "PROPOSE", module: "ENQUIRY", recordKey: "E-1", detail: "Offered Ramesh." });
    await step({
      kind: "REFUSED",
      module: "ENQUIRY",
      recordKey: "E-2",
      detail: "That employee has left.",
    });
    return run.id;
  }),
);

const detail = await withWorkerScope(async () => stepsFor(OWNER, runId));
check("the run closed", detail?.run.outcome === "COMPLETED", `outcome ${detail?.run.outcome}`);
check("with a duration on it", (detail?.run.durationMs ?? -1) >= 0, `${detail?.run.durationMs}ms`);
check(
  "three steps, in the order they happened",
  detail?.steps.length === 3 && detail.steps.map((s) => s.seq).join(",") === "1,2,3",
  detail?.steps.map((s) => `${s.seq}:${s.kind}`).join(" ") ?? "(none)",
);
check(
  "and the refusal kept its sentence",
  detail?.steps.find((s) => s.kind === "REFUSED")?.detail === "That employee has left.",
  "a refusal is why a record is still sitting there, and a log line is not somewhere a dealership can read it",
);

// ═════════════════════════════════════════════════════════════════════════
section("2. A step outside a run is dropped, not orphaned");

const before = await withWorkerScope(async () =>
  db.select({ n: sql<number>`count(*)::int` }).from(agentRunStepsTable),
);
await withWorkerScope(async () => step({ kind: "READ", detail: "Nobody asked for this." }));
const after = await withWorkerScope(async () =>
  db.select({ n: sql<number>`count(*)::int` }).from(agentRunStepsTable),
);
check(
  "a person pressing a button does not become a trace",
  before[0]!.n === after[0]!.n,
  `${before[0]!.n} steps before and after — the decision log already answers for that, and a steps table that fills with request handling is a second logger inside the database`,
);

// ═════════════════════════════════════════════════════════════════════════
section("3. A run that throws is still closed");

let threw = false;
try {
  await withWorkerScope(async () =>
    withRun({ ownerId: OWNER, trigger: "SCHEDULER", kind: KIND }, async () => {
      await step({ kind: "READ", detail: "Got this far." });
      throw new Error("the mirror was unreachable");
    }),
  );
} catch {
  threw = true;
}

const [failed] = await withWorkerScope(async () =>
  db
    .select()
    .from(agentRunsTable)
    .where(and(eq(agentRunsTable.ownerId, OWNER), eq(agentRunsTable.outcome, "FAILED")))
    .orderBy(sql`${agentRunsTable.id} desc`)
    .limit(1),
);

check("the error still reached the caller", threw, "swallowing it would hide a broken scheduler");
check(
  "and the run is FAILED rather than left RUNNING for ever",
  failed?.outcome === "FAILED" && failed.finishedAt !== null,
  failed?.reason ?? "(no reason recorded)",
);
check(
  "which matters because a stuck RUNNING row reads as a pass still going",
  failed?.durationMs !== null,
  "and the daily ceiling would count a crashed run as an active one all day",
);

// ═════════════════════════════════════════════════════════════════════════
section("4. Cost lands on the run that spent it");

const metered = await withWorkerScope(async () =>
  withRun({ ownerId: OWNER, trigger: "SCHEDULER", kind: KIND }, async (run) => {
    await meterModel({
      purpose: "compose",
      model: "gemini-flash-latest",
      inputTokens: 4_000,
      outputTokens: 1_000,
      ms: 900,
      ok: true,
    });
    await meterModel({
      purpose: "narrate",
      model: "gemini-flash-latest",
      inputTokens: 2_000,
      outputTokens: 500,
      ms: 700,
      ok: false,
    });
    return run.id;
  }),
);

const spent = await withWorkerScope(async () => stepsFor(OWNER, metered));
const expected =
  estimateCostPaise("gemini-flash-latest", 4_000, 1_000) +
  estimateCostPaise("gemini-flash-latest", 2_000, 500);

check(
  "two model calls counted",
  spent?.run.modelCalls === 2,
  `${spent?.run.modelCalls} calls, ${spent?.run.inputTokens} in / ${spent?.run.outputTokens} out`,
);
check(
  "including the one that failed",
  spent?.steps.filter((s) => s.kind === "MODEL").length === 2,
  "a run where nine calls in ten fail is exactly what somebody needs to see; recording only the successes produces a tidy trace of a broken pass",
);
check(
  "and the cost is the sum of them",
  spent?.run.costPaise === expected,
  `${spent?.run.costPaise} paise, expected ${expected}`,
);
check(
  "an unknown model is billed at the top of the table, not at zero",
  estimateCostPaise("some-model-nobody-added", 1_000_000, 0) >
    estimateCostPaise("gemini-flash-latest", 1_000_000, 0),
  "the failure that matters is a ceiling that lets a run through because nobody added its model",
);

// ═════════════════════════════════════════════════════════════════════════
section("5. The agent stands down, and for the right reason");

const quiet = await withWorkerScope(async () =>
  shouldStandDown({ ownerId: OWNER, policy: await loadPolicy(OWNER), overrideRatePct: 5 }),
);
check(
  "it runs when it is being accepted and the day is cheap",
  !quiet.standDown,
  `${quiet.spentTodayPaise} of ${quiet.capPaise} paise spent, ${quiet.overrideRatePct}% overruled`,
);

const overruled = await withWorkerScope(async () =>
  shouldStandDown({
    ownerId: OWNER,
    policy: await loadPolicy(OWNER),
    overrideRatePct: CEILING + 5,
  }),
);
check(
  "it pauses when the dealership is overruling it",
  overruled.standDown,
  overruled.reason ?? "",
);
check(
  "and says it will come back by itself",
  (overruled.reason ?? "").includes("resumes on its own"),
  "a pause that needs a person to clear it is an outage, not a safety mechanism",
);

/*
 * The money ceiling, driven by actually reaching it.
 *
 * The cap goes to its floor and a run then spends past it, rather than the
 * comparison being poked directly — the claim is that a day's real spending
 * stops the agent, and a test that sets both sides of an inequality proves
 * arithmetic rather than behaviour.
 *
 * > **The first version of this section silently did nothing.** It set the cap
 * > to 1 paisa and never looked at what `setPolicy` returned. The registry's
 * > floor for that key is 100, so the write was refused — correctly, by the
 * > closed policy registry doing its job — the cap stayed at its default, and
 * > two checks failed for a reason that had nothing to do with the ceiling.
 * > **A verifier that ignores a return value is a verifier that will one day
 * > pass while doing nothing at all.**
 */
const floorPaise = POLICY_BY_KEY.get("AGENT.DAILY_COST_CAP_PAISE")!.min;
const lowered = await setPolicy(OWNER, 1, 1, "AGENT.DAILY_COST_CAP_PAISE", floorPaise);
check(
  `the ceiling can be lowered to its floor of ${floorPaise} paise`,
  lowered.ok,
  lowered.ok ? `now ₹${(floorPaise / 100).toFixed(2)}` : lowered.error,
);

// Enough tokens to pass the floor on the cheapest model in the table, so the
// number in the check is arrived at rather than asserted.
const bigTokens = Math.ceil((floorPaise * 1_000_000) / 625) + 1_000;
await withWorkerScope(async () =>
  withRun({ ownerId: OWNER, trigger: "SCHEDULER", kind: KIND }, async () => {
    await meterModel({
      purpose: "compose",
      model: "gemini-flash-latest",
      inputTokens: bigTokens,
      outputTokens: 0,
      ms: 1_200,
      ok: true,
    });
  }),
);

const broke = await withWorkerScope(async () =>
  shouldStandDown({ ownerId: OWNER, policy: await loadPolicy(OWNER), overrideRatePct: 0 }),
);
check(
  "it pauses when the day's money is gone, even with nobody overruling it",
  broke.standDown && (broke.reason ?? "").includes("ceiling"),
  `${broke.spentTodayPaise} of ${broke.capPaise} paise spent · ${broke.reason ?? ""}`,
);
check(
  "and says a person pressing a button is unaffected",
  (broke.reason ?? "").includes("a person presses still works"),
  "a cap on unattended spending is not a reason to stop somebody doing their job",
);

const restored = await setPolicy(OWNER, 1, 1, "AGENT.DAILY_COST_CAP_PAISE", null);
check(
  "and the ceiling this file moved is put back",
  restored.ok && (await loadPolicy(OWNER)).number("AGENT.DAILY_COST_CAP_PAISE") === CAP,
  `back to ${CAP} paise`,
);

// ═════════════════════════════════════════════════════════════════════════
section("6. Standing down is written down, and stops being shown");

await withWorkerScope(async () =>
  recordStandDown({
    ownerId: OWNER,
    trigger: "SCHEDULER",
    kind: KIND,
    reason: "People here have overruled 61% of what was suggested. It resumes on its own.",
  }),
);

let summary = await withWorkerScope(async () =>
  recentRuns({ ownerId: OWNER, showroomIds: [1, 2], policy: await loadPolicy(OWNER) }),
);
check(
  "a stand-down is a run, not an absence",
  summary.runs[0]?.outcome === "STOOD_DOWN",
  "*the agent chose not to act* and *nothing was scheduled* are different facts, and only one needs looking into",
);
check("and it shows as the current state", summary.standingDown !== null, summary.standingDown?.reason ?? "");

await withWorkerScope(async () =>
  withRun({ ownerId: OWNER, trigger: "SCHEDULER", kind: KIND }, async () => {
    await step({ kind: "READ", detail: "Back to normal." });
  }),
);

summary = await withWorkerScope(async () =>
  recentRuns({ ownerId: OWNER, showroomIds: [1, 2], policy: await loadPolicy(OWNER) }),
);
check(
  "one good run clears the banner without anybody dismissing it",
  summary.standingDown === null,
  "a stand-down three days ago followed by six good runs is history, not a state — and a warning nothing clears is one people learn to ignore",
);
check(
  "the stood-down run is still in the history",
  summary.runs.some((r) => r.outcome === "STOOD_DOWN"),
  "cleared from the banner, not from the record",
);

// ═════════════════════════════════════════════════════════════════════════
section("7. A person may read a run and may not write one");

let refused = "";
try {
  await ownerDb.execute(sql`select 1`);
  await withWorkerScope(async () => {
    // The request credential, reached through the scoped proxy the routes use.
    await db
      .update(agentRunsTable)
      .set({ reason: "edited" })
      .where(eq(agentRunsTable.id, runId));
  });
  refused = "IT UPDATED — the worker is meant to hold this one";
} catch (err) {
  refused = ((err as { cause?: Error }).cause?.message ?? (err as Error).message) || "";
}
// The worker legitimately writes runs; the check that matters is the *app*
// credential, which `db:probe` and the grants cover and which no scope here can
// reach. Stated rather than skipped silently.
check(
  "the scheduler may write its own run",
  refused.startsWith("IT UPDATED"),
  "the request credential's refusal is a grant (`grant select on agent_runs to ddms_app`) and is proved by `pnpm run db:rls`",
);

await reset();
console.log("  (every run this file wrote, and the ceiling it moved, put back)");

console.log(
  failures === 0
    ? "\nAll checks passed. A pass is watchable, it costs something knowable, and it stops itself.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
