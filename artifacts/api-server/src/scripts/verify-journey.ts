/**
 * OBJ-23's done-when, walked rather than asserted.
 *
 * > *One journey runs end to end across a simulated month, survives a restart
 * > mid-flight, an RTO objection sends a file backwards with its reason
 * > attached, and every queue row for that journey is produced by the runtime
 * > rather than written by a classifier.*
 *
 * Four claims, and they need two different kinds of proof. The first is about
 * the **map** and needs no database at all — a month of facts fed to a pure
 * function. The other three are about **durability** and are run on the worker
 * credential, because a journey advances when the RTO answers and nobody is
 * signed in when that happens.
 *
 * `pnpm run verify:journey`.
 */

import {
  ownerDb,
  workerDb,
  withWorkerScope,
  journeysTable,
  journeyStepsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  VEHICLE_DELIVERY,
  positionOf,
  needsSomebody,
  advanceJourneys,
  journeyQueueRows,
  loadDeliveryFacts,
  traceFor,
  liveSubjects,
  type DeliveryFacts,
} from "../lib/dms/journeys";
import { buildQueue } from "../lib/dms/queue";
import { buildRegistrationWorklist } from "../lib/dms/registration-worklist";
import { loadPolicy } from "../lib/dms/policy";

const OWNER = 1;
const SHOWROOMS = [1, 2];

/**
 * The file the RTO rejected. Real, in the fixture since the registration mirror
 * was built, and the reason the loop can be proved on something that actually
 * happened rather than on something invented for the occasion.
 */
const OBJECTED = "REG-0417-3304";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. A simulated month, with no database anywhere near it
// ────────────────────────────────────────────────────────────────────────────

const DAY0 = Date.parse("2026-06-01T00:00:00Z");
const on = (d: number) => new Date(DAY0 + d * 86_400_000).toISOString().slice(0, 10);

/**
 * One vehicle's month, as a set of facts that changes by the day.
 *
 * Every date below is something that happens in a dealership: the invoice, the
 * policy, the last document, the tax remittance, the trip to the RTO — and on
 * day nine, the RTO sending it back.
 */
function factsOnDay(d: number): DeliveryFacts {
  const objectionLive = d >= 9 && d < 11;
  return {
    regnFileNo: "SIM-REG-0001",
    showroomId: 1,
    dealerCode: "SIM",
    status: objectionLive ? "REJECTED" : d >= 23 ? "REGISTERED" : d >= 6 ? "SUBMITTED" : "OPEN",
    dealId: "SIM-DEAL-0001",
    customerName: "Simulated customer",
    customerMobile: null,
    modelDescription: "HF Deluxe",
    chassisNo: "SIMCHASSIS0001",
    agentEmpCode: "RT-0417-02",
    assignedAgentEmpCode: null,

    invoiceNo: d >= 0 ? "SIM-INV-0001" : null,
    invoiceDate: d >= 0 ? on(0) : null,
    dealKnown: true,
    policyNo: d >= 2 ? "SIM-POL-0001" : null,

    // The last document arrives on day 4 and the objection re-opens this step
    // on day 9 — which is the whole mechanic, expressed as two column tests.
    hasPendingDoc: d < 4,
    pendingDocDesc: d < 4 ? "Address proof" : null,
    objectionDesc: objectionLive ? "Address proof does not match the KYC document" : null,

    roadTaxAmount: 9_400,
    roadTaxCollectedDate: on(0),
    roadTaxPaidDate: d >= 5 ? on(5) : null,

    // Lodged on day 6, sent back on day 9, lodged again on day 11.
    submittedDate: d >= 11 ? on(11) : d >= 6 ? on(6) : null,
    regNo: d >= 23 ? "MH12SIM0001" : null,
    regDate: d >= 23 ? on(23) : null,
    hsrpFittedDate: d >= 24 ? on(24) : null,
    rcReceivedDate: d >= 27 ? on(27) : null,
    rcDeliveredDate: d >= 29 ? on(29) : null,

    tempRegExpiryDate: on(30),
    customerNotifiedAt: null,
    rtoChasedAt: null,
    disappeared: false,

    today: on(d),
    rtoQuietDays: 10,
  };
}

section("1. a month, one file, no database");

let last: string | null = null;
const seen = new Set<string>();
const waitKinds = new Set<string>();
let backwards = 0;
let finishedOn: number | null = null;

for (let d = 0; d <= 30; d++) {
  const f = factsOnDay(d);
  const p = positionOf(VEHICLE_DELIVERY, f);
  const here = p.step?.id ?? "FINISHED";

  if (p.wait) waitKinds.add(p.wait.kind);

  if (here !== last) {
    const priorIndex = last === null ? -1 : VEHICLE_DELIVERY.steps.findIndex((s) => s.id === last);
    const back = last !== null && p.step !== null && p.index < priorIndex;
    if (back) backwards++;
    if (here === "FINISHED" && finishedOn === null) finishedOn = d;

    const arrow = last === null ? "start" : back ? "◀ BACK" : "▶";
    const wait = p.wait ? `${p.wait.kind.padEnd(7)} ${p.wait.who}` : "—";
    console.log(
      `  day ${String(d).padStart(2)}  ${arrow.padEnd(6)} ${here.padEnd(12)} ${wait}` +
        (back && p.returnedTo ? `\n              reason: ${p.returnedTo.reason}` : ""),
    );
    seen.add(here);
    last = here;
  }
}

check("it started at the beginning and finished at the end", finishedOn !== null, `finished on day ${finishedOn}`);
check("the RTO sent it backwards exactly once", backwards === 1);
check(
  "and the objection travelled with it",
  positionOf(VEHICLE_DELIVERY, factsOnDay(9)).returnedTo?.reason ===
    "Address proof does not match the KYC document",
);

/*
 * All four kinds of waiting, on one file, in one month. This is the claim the
 * old model could not make at all: `RTO_SILENT` is a state, not a wait, and
 * nothing in the product could distinguish *the RTO has it and that is normal*
 * from *the RTO has it and has gone quiet*.
 */
check(
  "all four kinds of waiting occurred",
  ["PERSON", "OUTSIDE", "JOURNEY", "TIME"].every((k) => waitKinds.has(k)),
  [...waitKinds].sort().join(", "),
);

section("1b. a TIME wait is never somebody's work, and then it is");

const lodgedDay14 = factsOnDay(14);
const lodgedDay22 = factsOnDay(22);
const w14 = positionOf(VEHICLE_DELIVERY, lodgedDay14).wait!;
const w22 = positionOf(VEHICLE_DELIVERY, lodgedDay22).wait!;

console.log(`  day 14  ${w14.kind.padEnd(7)} ${w14.why}`);
console.log(`  day 22  ${w22.kind.padEnd(7)} ${w22.why}`);
check("day 14 raises nothing", !needsSomebody(w14, lodgedDay14.today));
check("day 22 raises a row", needsSomebody(w22, lodgedDay22.today));
check(
  "and the changeover is the dealership's own number, not ours",
  w14.notBefore === on(21),
  `not before ${w14.notBefore}, which is 10 days after it was lodged`,
);

// ────────────────────────────────────────────────────────────────────────────
// 2. The durable half, on the worker credential
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reset the one file this script drives, so it is repeatable.
 *
 * On the CLI credential, because `ddms_worker` may not delete — the same
 * refusal `verify:records` ran into and the same reason it was right: nothing
 * unattended erases a record, not even its own.
 */
async function resetSubject(): Promise<void> {
  const rows = await ownerDb
    .select({ id: journeysTable.id })
    .from(journeysTable)
    .where(eq(journeysTable.subjectKey, OBJECTED));
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  await ownerDb.delete(journeyStepsTable).where(inArray(journeyStepsTable.journeyId, ids));
  await ownerDb.delete(journeysTable).where(inArray(journeysTable.id, ids));
}

await resetSubject();

await withWorkerScope(async () => {
  const policy = await loadPolicy(OWNER);

  section("2. the runtime discovers what is in flight");

  let classifierRows = 0;
  const classifierStates = new Map<string, number>();
  for (const showroomId of SHOWROOMS) {
    for (const r of await buildRegistrationWorklist({ showroomId, policy })) {
      if (!r.actionRequired) continue;
      if (!policy.severity("REGISTRATION", r.state)) continue;
      classifierRows++;
      classifierStates.set(r.state, (classifierStates.get(r.state) ?? 0) + 1);
    }
  }

  /*
   * The file as it stood a week ago: lodged with the RTO, nothing back yet, no
   * objection. Every one of those is true of REG-0417-3304 before the RTO
   * answered, and supplying it here is supplying exactly what the previous
   * sync did.
   */
  const nowFacts = await loadDeliveryFacts(SHOWROOMS, policy);
  const real = nowFacts.get(OBJECTED);
  if (!real) throw new Error(`${OBJECTED} is not in the mirror — reseed first.`);

  const lastWeek: DeliveryFacts = {
    ...real,
    status: "SUBMITTED",
    objectionDesc: null,
    hasPendingDoc: false,
    pendingDocDesc: null,
  };

  const opening = await advanceJourneys({
    ownerId: OWNER,
    showroomIds: SHOWROOMS,
    policy,
    facts: new Map([[OBJECTED, lastWeek]]),
    /*
     * One map, because OBJ-25 added a second one.
     *
     * A supplied fact-set belongs to the definition it was gathered for, and
     * handing registration facts to the sale journey would be handing it a map
     * of somewhere else. The runtime walks every definition by default; a
     * caller supplying facts has to say which.
     */
    only: VEHICLE_DELIVERY.id,
  });
  check("the file's journey opened", opening.started === 1, JSON.stringify(opening));

  const first = await traceFor("REGISTRATION", OBJECTED, policy);
  console.log(`      ${OBJECTED} → ${first?.standingOn} (${first?.wait?.kind} · ${first?.wait?.who})`);

  section("3. the RTO answers, and the file goes backwards carrying why");

  const pass = await advanceJourneys({
    ownerId: OWNER,
    showroomIds: SHOWROOMS,
    policy,
    only: VEHICLE_DELIVERY.id,
  });
  console.log(
    `      ${pass.started} opened · ${pass.advanced} moved on · ${pass.looped} sent back · ` +
      `${pass.finished} finished · ${pass.live} still going`,
  );

  const trace = await traceFor("REGISTRATION", OBJECTED, policy);
  const back = trace?.arrivals.find((a) => a.direction === "BACKWARD");

  check("it went backwards", Boolean(back), back ? `${back.fromStepId} → ${back.stepId}` : "no BACKWARD arrival");
  check(
    "and the objection is attached to the move, not looked up later",
    Boolean(back?.reason && back.reason.length > 10),
    back?.reason ?? "",
  );
  check("the trace counts it as a loop", (trace?.loops ?? 0) === 1);
  for (const a of trace?.arrivals ?? []) {
    console.log(
      `      ${a.direction.padEnd(8)} ${a.stepId.padEnd(12)}${a.reason ? ` — ${a.reason}` : ""}`,
    );
  }

  section("4. it survives a restart mid-flight");

  /*
   * There is nothing to restart, and that is the proof.
   *
   * No journey is held open between passes: the position is two rows in
   * Postgres and the facts come from the mirror. So this reads everything back
   * from the database as a cold process would and checks it is the same
   * journey standing in the same place — and then advances again, which is what
   * the scheduler would do a minute after coming back up.
   */
  const cold = await traceFor("REGISTRATION", OBJECTED, policy);
  check(
    "the same journey, in the same place, read cold",
    cold?.id === trace?.id && cold?.standingOn === trace?.standingOn,
    `${cold?.standingOn} · started ${cold?.startedAt.slice(0, 10)} · ${cold?.arrivals.length} arrivals`,
  );

  const again = await advanceJourneys({
    ownerId: OWNER,
    showroomIds: SHOWROOMS,
    policy,
    only: VEHICLE_DELIVERY.id,
  });
  const after = await traceFor("REGISTRATION", OBJECTED, policy);
  check(
    "a second pass changes nothing when the world has not",
    after?.arrivals.length === cold?.arrivals.length,
    `${again.advanced} moved, ${again.looped} sent back — both should be 0`,
  );
  check("and it did not quietly re-open the journey", again.started === 0);

  section("5. the queue rows come from the runtime, not from a classifier");

  const rows = (
    await journeyQueueRows({ ownerId: OWNER, showroomIds: SHOWROOMS, policy })
  ).filter((r) => r.definitionId === VEHICLE_DELIVERY.id);
  const kinds = new Map<string, number>();
  const steps = new Map<string, number>();
  for (const r of rows) {
    kinds.set(r.waitKind, (kinds.get(r.waitKind) ?? 0) + 1);
    steps.set(r.stepId, (steps.get(r.stepId) ?? 0) + 1);
  }

  console.log(`      ${rows.length} journey rows, standing on:`);
  for (const [step, n] of [...steps.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`        ${String(n).padStart(3)}  ${step}`);
  }
  console.log(`      by kind of waiting: ${[...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(" · ")}`);

  check("no TIME wait reached the queue", !kinds.has("TIME"));
  check(
    "the objected file is on it, saying what the RTO said",
    rows.some((r) => r.subjectKey === OBJECTED && r.why.includes("returned this file")),
  );

  const owned = await liveSubjects(OWNER, SHOWROOMS);
  check("the runtime is answering for every live file", owned.size > 0, `${owned.size} subjects`);

  /*
   * An ordinary pass, walking every map rather than the one this script drives.
   *
   * The checks above deliberately narrow to `VEHICLE_DELIVERY` because they
   * supply their own facts, and a fact-set belongs to the definition it was
   * gathered for. The queue is the one place that has to hold both at once, so
   * it is checked after a pass that walks both — which is what the scheduler
   * does every time.
   */
  await advanceJourneys({ ownerId: OWNER, showroomIds: SHOWROOMS, policy });

  const queue = await buildQueue({
    ownerId: OWNER,
    ownerShowroomIds: SHOWROOMS,
    visibleShowroomIds: SHOWROOMS,
    empCode: null,
    role: "OWNER",
    policy,
  });

  const regRows = queue.items.filter((i) => i.module === "REGISTRATION");
  const fromRuntime = regRows.filter((i) => i.source === "JOURNEY");
  const fromClassifier = regRows.filter((i) => i.source === "DERIVED");

  console.log(
    `      ${queue.total} on the queue — ${regRows.length} registration rows, ` +
      `${fromRuntime.length} from the runtime, ${fromClassifier.length} from the classifier`,
  );
  console.log(
    `      (the classifier alone would have raised ${classifierRows}: ` +
      `${[...classifierStates.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(" · ")})`,
  );

  check(
    "every registration row on the queue is the runtime's",
    fromClassifier.length === 0,
    fromClassifier.map((r) => `${r.recordKey} ${r.state}`).join(", "),
  );
  check(
    "and the sale journey is on the same queue beside it (OBJ-25)",
    queue.items.some((i) => i.journey?.definitionId === "VEHICLE_SALE"),
    `${queue.items.filter((i) => i.journey?.definitionId === "VEHICLE_SALE").length} rows from the second map`,
  );
  check("and they are sorted among everything else, not appended", queue.items.some((i, n) => i.source === "JOURNEY" && n < queue.items.length - 1));

  const objected = fromRuntime.find((i) => i.recordKey === OBJECTED);
  check(
    "an objection is still the dealership's most urgent registration state",
    objected?.severity === policy.severity("REGISTRATION", "OBJECTION"),
    `severity ${objected?.severity}, and the dealership rates OBJECTION ${policy.severity("REGISTRATION", "OBJECTION")}`,
  );

  const example = objected;
  if (example) {
    console.log(
      `      "${example.title}" · ${example.journey?.stepTitle} · step ${example.journey?.completed}/${example.journey?.total} · ` +
        `${example.journey?.loops} loop · severity ${example.severity} · ${example.band}`,
    );
    console.log(`        ${example.note}`);
    console.log(`        → ${example.actionRequired}`);
  }

  section("6. nothing outside DDMS's own records was written");

  /*
   * The runtime writes `journeys` and `journey_steps` and nothing else. This is
   * the same check OBJ-22 ended on, one level up: the worker may advance a
   * journey and may not erase one, because a process that runs unattended must
   * not be able to remove the evidence of what it did.
   */
  let deleted = false;
  try {
    await workerDb.delete(journeyStepsTable).where(eq(journeyStepsTable.id, -1));
    deleted = true;
  } catch {
    deleted = false;
  }
  check(
    "the worker cannot erase an arrival",
    !deleted,
    "select and insert, never delete — the newest arrival *is* the position",
  );

  let updated = false;
  try {
    await workerDb
      .update(journeyStepsTable)
      .set({ reason: "rewritten" })
      .where(eq(journeyStepsTable.id, -1));
    updated = true;
  } catch {
    updated = false;
  }
  check(
    "and cannot rewrite one",
    !updated,
    "an update here would not lose history, it would change what the runtime believes now",
  );
});

console.log(
  failures === 0
    ? "\nAll checks passed. A journey knows where it is, and a stalled step is the queue row.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
