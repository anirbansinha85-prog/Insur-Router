/**
 * OBJ-26's done-when, earned rather than asserted.
 *
 * > *A pattern is cited with its count and date, accepting it ten times
 * > produces a consent request rather than an automatic promotion, rejecting it
 * > demotes, and no amount of precedent moves anything past the floor.*
 *
 * Four claims, and the third and fourth are the ones that make this a ladder
 * rather than a dial. Anything can be built to climb; the question is whether
 * it comes back down when the dealership stops agreeing, and whether there is
 * a height it cannot pass however loudly the evidence argues.
 *
 * ## What this drives, and what it refuses to fake
 *
 * The evidence is **written as decisions through `applyAction`** — the same
 * function a person's button calls — rather than inserted into the tables
 * directly. A ladder proved against hand-written rows would be a ladder proved
 * against a fixture, and the interesting failures live in the joins: whether a
 * decision matches a proposal, whether a cleared decision counts, whether the
 * state at the moment of deciding is the state that gets cited.
 *
 * Runs on the **worker credential**, because the claim is about what happens
 * with nobody signed in.
 *
 * `pnpm run verify:autonomy`.
 */

import {
  db,
  ownerDb,
  withWorkerScope,
  agentProposalsTable,
  autonomyConsentsTable,
  decisionLogTable,
  recordEventsTable,
  dmsEnquiriesTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  standingFor,
  earnedRung,
  ceilingFor,
  grantConsent,
  revokeConsent,
  AUTONOMY_KEYS,
  RUNG_LABEL,
  type Rung,
} from "../lib/dms/autonomy";
import { precedentFor, precedentSentence, patternKey } from "../lib/dms/precedent";
import { resolveProposals, recordProposals } from "../lib/dms/proposals";
import { applyAction, listStaff } from "../lib/dms/actions";
import { loadPolicy, setPolicy } from "../lib/dms/policy";
import { runAgentForShowroom } from "../lib/dms/agent";
import { buildQueue } from "../lib/dms/queue";

const OWNER = 1;
const SHOWROOM = 1;
const ANIRBAN = { id: 1, name: "Anirban Sinha" };

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

/**
 * Everything this run writes, marked so it can be found again.
 *
 * This verifier writes **real decisions onto real mirror rows**, because a
 * ladder proved against inserted fixture rows would not have been proved —
 * every interesting failure lives in the joins. The price is that it has more
 * to tidy than any other verifier here, and tidying by an in-memory list only
 * works for a run that finishes.
 *
 * > **A crashed run has to be cleanable by the next one.**
 *
 * The first version kept the borrowed enquiry ids in an array. A run that threw
 * halfway left twelve reassignments and eighteen decisions behind, and the next
 * run counted them: *24 decisions* where the section had made six, and three
 * checks failed for a reason that had nothing to do with the ladder. Same shape
 * as OBJ-24's non-self-healing ingest verifier, and the same fix — the marker
 * is in the data, so reset finds its own leftovers whatever happened last time.
 */
const MARKER = "verify:autonomy";
const BORROWED: string[] = [];

async function reset(): Promise<void> {
  await ownerDb.delete(agentProposalsTable).where(eq(agentProposalsTable.ownerId, OWNER));
  await ownerDb.delete(autonomyConsentsTable).where(eq(autonomyConsentsTable.ownerId, OWNER));

  // Whatever this verifier has ever written, from this run or a crashed one.
  const mine = await ownerDb
    .select({ recordKey: decisionLogTable.recordKey })
    .from(decisionLogTable)
    .where(and(eq(decisionLogTable.ownerId, OWNER), eq(decisionLogTable.note, MARKER)));

  const touched = [...new Set([...mine.map((r) => r.recordKey), ...BORROWED])];
  if (touched.length > 0) {
    await ownerDb
      .delete(decisionLogTable)
      .where(
        and(
          eq(decisionLogTable.ownerId, OWNER),
          eq(decisionLogTable.module, "ENQUIRY"),
          inArray(decisionLogTable.recordKey, touched),
        ),
      );
    await ownerDb
      .update(dmsEnquiriesTable)
      .set({ reassignedToEmpCode: null, reassignedAt: null })
      .where(
        and(
          eq(dmsEnquiriesTable.showroomId, SHOWROOM),
          inArray(dmsEnquiriesTable.enqId, touched),
        ),
      );
  }

  for (const k of Object.values(AUTONOMY_KEYS)) {
    await setPolicy(OWNER, SHOWROOM, ANIRBAN.id, k, null);
  }
  await setPolicy(OWNER, SHOWROOM, ANIRBAN.id, "AGENT.ASSIGN_ORPHANS", null);
}

await reset();

// ────────────────────────────────────────────────────────────────────────────

section("1. the rungs, as arithmetic, with no database in the way");

/*
 * Pure first, exactly as OBJ-23 proved its walk.
 *
 * `earnedRung` is where the whole ladder actually happens, and it takes seven
 * numbers and returns one word. Proving it here means every failure further
 * down is a wiring failure rather than an argument about the rules.
 */
const NUMBERS = { recallAfter: 3, prefillAfter: 5, overrideCeiling: 20 };

const nothing = earnedRung({
  precedentTotal: 1,
  accepted: 0,
  answered: 0,
  overrideRatePct: null,
  ...NUMBERS,
});
check("one decision is not a habit", nothing.rung === "WATCHING", nothing.because);

const habit = earnedRung({
  precedentTotal: 6,
  accepted: 0,
  answered: 0,
  overrideRatePct: null,
  ...NUMBERS,
});
check("six is, and it recites rather than chooses", habit.rung === "RECALL", habit.because);

const trusted = earnedRung({
  precedentTotal: 6,
  accepted: 7,
  answered: 7,
  overrideRatePct: 0,
  ...NUMBERS,
});
check("seven accepted fills the answer in", trusted.rung === "PREFILLED", trusted.because);

/*
 * The demotion, and the ordering that makes it real.
 *
 * The override test runs **before** the promotion tests. A pattern with a long
 * good history and a bad fortnight has to come down now, and putting the
 * promotion first would let the history outvote what is happening today.
 */
const soured = earnedRung({
  precedentTotal: 20,
  accepted: 18,
  answered: 30,
  overrideRatePct: 40,
  ...NUMBERS,
});
check(
  "a long good history does not outvote a bad fortnight",
  soured.rung === "RECALL",
  soured.because,
);

check(
  "and it demotes to recall rather than to silence",
  soured.rung !== "WATCHING",
  "people disagreeing with the choice have not stopped having a habit — a product that sulks hides what it knows",
);

section("2. the floor, and no amount of evidence reaches it (R-80)");

const open = ceilingFor("ENQUIRY_REASSIGN");
check("a routing decision DDMS makes can run unattended", open.ceiling === "AUTOMATIC");

const closed = ceilingFor("JOB_CARD_MARK_INFORMED");
check(
  "asserting somebody rang a customer can never",
  closed.ceiling === "PREFILLED",
  closed.reason ?? "",
);

/*
 * The claim stated so it can fail. A thousand accepted proposals is a number
 * nothing else in this run reaches, and the pattern still stops at pre-filled.
 */
const overwhelming = earnedRung({
  precedentTotal: 1_000,
  accepted: 1_000,
  answered: 1_000,
  overrideRatePct: 0,
  ...NUMBERS,
});
check(
  "a thousand of them still stops at pre-filled",
  overwhelming.rung === "PREFILLED" && closed.ceiling === "PREFILLED",
  "the ceiling is may(\"AGENT\", …) — the same table that answers for a service advisor, not a second list",
);

const refusedConsent = await grantConsent({
  ownerId: OWNER,
  patternKey: patternKey("JOB_CARD", "READY_UNCOLLECTED", "JOB_CARD_MARK_INFORMED"),
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  onCount: 999,
  principal: "OWNER",
});
check(
  "and an owner cannot consent past it either",
  !refusedConsent.ok && refusedConsent.status === 409,
  refusedConsent.ok ? "IT WAS GRANTED" : refusedConsent.error,
);

section("3. what this outlet actually did, from the decision log (R-66, R-68)");

const staff = await withWorkerScope(async () => listStaff(SHOWROOM, "SALES_EXEC"));
check("there are salespeople to hand work to", staff.length >= 2, `${staff.length} still here`);

/*
 * Real enquiries in a real state, decided on through the real function.
 *
 * The state has to come from `record_events` because that is where precedent
 * reads it from — a decision on a record the detector has never classified is
 * skipped rather than filed under an invented state, and borrowing rows the
 * detector has already seen is what makes the pattern key mean anything.
 */
const classified = await withWorkerScope(async () =>
  ownerDb
    .select({
      recordKey: recordEventsTable.recordKey,
      state: recordEventsTable.toState,
      at: recordEventsTable.detectedAt,
    })
    .from(recordEventsTable)
    .where(
      and(
        eq(recordEventsTable.ownerId, OWNER),
        eq(recordEventsTable.showroomId, SHOWROOM),
        eq(recordEventsTable.module, "ENQUIRY"),
      ),
    )
    .orderBy(desc(recordEventsTable.detectedAt))
    .limit(400),
);

const newest = new Map<string, string>();
for (const e of classified) if (!newest.has(e.recordKey)) newest.set(e.recordKey, e.state);

const byState = new Map<string, string[]>();
for (const [key, state] of newest) {
  byState.set(state, [...(byState.get(state) ?? []), key]);
}
const [chosenState, pool] =
  [...byState.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? ["", []];

check(
  "a state this outlet has plenty of",
  pool.length >= 8,
  `${chosenState} — ${pool.length} enquiries`,
);

const JASWINDER = staff[0]!;
const OTHER = staff[1] ?? staff[0]!;
const PATTERN = patternKey("ENQUIRY", chosenState, "ENQUIRY_REASSIGN");

/** Somebody at the dealership handing an enquiry to a named person. */
async function personDecides(enqId: string, empCode: string): Promise<boolean> {
  BORROWED.push(enqId);
  const r = await applyAction({
    ownerId: OWNER,
    userId: ANIRBAN.id,
    action: "ENQUIRY_REASSIGN",
    recordKey: enqId,
    showroomId: SHOWROOM,
    empCode,
    note: MARKER,
  });
  return r.ok;
}

const habitRows = pool.slice(0, 6);
let wrote = 0;
await withWorkerScope(async () => {
  for (const enqId of habitRows) {
    if (await personDecides(enqId, JASWINDER.empCode)) wrote++;
  }
});
check("six of them handed to one person, by a person", wrote === 6, `${JASWINDER.empName}`);

const precedent = await withWorkerScope(async () =>
  precedentFor({ ownerId: OWNER, showroomIds: [SHOWROOM], windowDays: 60 }),
);
const p = precedent.get(PATTERN);
check("the pattern exists, keyed on the state they were in", Boolean(p), PATTERN);
check("and it counted every one", p?.total === 6, `${p?.total ?? 0} decisions`);
check(
  "with one dominant answer",
  p?.dominant?.value === JASWINDER.empCode && p.dominant.count === 6,
);

const sentence = p ? precedentSentence(p, (c) => staff.find((s) => s.empCode === c)?.empName ?? null) : null;
check(
  "the sentence carries a count and a date, or it is not shown (R-68)",
  Boolean(sentence && /\d/.test(sentence) && sentence.includes(JASWINDER.empName)),
  sentence ?? "nothing",
);

section("4. the agent's own work is not evidence about the dealership (R-66)");

/*
 * The self-reinforcement failure, in its textbook form: the agent proposes, its
 * own output becomes the evidence, and one early mistake settles into a belief
 * nobody can see from inside. One predicate closes it, and this is the check
 * that the predicate is actually there.
 */
const before = p?.total ?? 0;
await withWorkerScope(async () => {
  const enqId = pool[6]!;
  BORROWED.push(enqId);
  await applyAction({
    ownerId: OWNER,
    userId: null, // the agent
    action: "ENQUIRY_REASSIGN",
    recordKey: enqId,
    showroomId: SHOWROOM,
    empCode: JASWINDER.empCode,
    note: MARKER,
  });
});

const after = await withWorkerScope(async () =>
  precedentFor({ ownerId: OWNER, showroomIds: [SHOWROOM], windowDays: 60 }),
);
check(
  "the agent doing the same thing changes nothing",
  (after.get(PATTERN)?.total ?? 0) === before,
  `still ${before} — a null userId is the system, and the system is not the dealership`,
);

section("5. accepting it earns a rung, and the earning is a count (R-79)");

const policy = await loadPolicy(OWNER);

/*
 * The loop as it actually runs: the agent offers, a person does the same thing,
 * the ledger settles, the rung moves. Nothing here inserts an acceptance —
 * `resolveProposals` works it out by comparing what a person did against what
 * was on offer, which is the property that stops the ladder being climbable
 * from inside.
 */
async function agentOffers(enqId: string, empCode: string): Promise<void> {
  await recordProposals([
    {
      ownerId: OWNER,
      showroomId: SHOWROOM,
      patternKey: PATTERN,
      module: "ENQUIRY",
      recordKey: enqId,
      action: "ENQUIRY_REASSIGN",
      proposedValue: { reassignedToEmpCode: empCode },
      reason: "test offer",
      rung: 1,
    },
  ]);
}

const accepted = pool.slice(8, 14);
await withWorkerScope(async () => {
  for (const enqId of accepted) {
    await agentOffers(enqId, JASWINDER.empCode);
    await personDecides(enqId, JASWINDER.empCode);
  }
});

const settled = await withWorkerScope(async () =>
  resolveProposals({ ownerId: OWNER, showroomIds: [SHOWROOM], expireAfterDays: 30 }),
);
check(
  "six offers, six people agreeing, six acceptances worked out rather than declared",
  settled.accepted === 6 && settled.overridden === 0,
  `${settled.accepted} accepted, ${settled.overridden} overridden`,
);

let standing = await withWorkerScope(async () =>
  standingFor({ ownerId: OWNER, showroomIds: [SHOWROOM], policy }),
);
let s = standing.get(PATTERN);
check(
  "the pattern has climbed to pre-filled",
  s?.rung === "PREFILLED",
  `${RUNG_LABEL[s?.rung ?? "WATCHING"]} — ${s?.because}`,
);
check("and nobody has been asked anything yet", s?.consentDue === false, `${s?.accepted} accepted, 10 needed`);

section("6. at the threshold it asks. It never promotes itself");

const more = pool.slice(14, 20);
await withWorkerScope(async () => {
  for (const enqId of more) {
    await agentOffers(enqId, JASWINDER.empCode);
    await personDecides(enqId, JASWINDER.empCode);
  }
  await resolveProposals({ ownerId: OWNER, showroomIds: [SHOWROOM], expireAfterDays: 30 });
});

standing = await withWorkerScope(async () =>
  standingFor({ ownerId: OWNER, showroomIds: [SHOWROOM], policy }),
);
s = standing.get(PATTERN);

check("twelve accepted, past this dealership's ten", (s?.accepted ?? 0) >= 10, `${s?.accepted} accepted`);
check(
  "**it is still pre-filled**",
  s?.rung === "PREFILLED",
  "the whole objective in one assertion: evidence asks, it does not promote",
);
check("and the product is asking", s?.consentDue === true, s?.because);

/*
 * On the CLI credential, and the first version of this was on the worker's.
 *
 * It threw: `permission denied for table autonomy_consents`. Which is the
 * design working — `ddms_worker` holds **select and no insert** on that table,
 * because an unattended process that could grant itself standing permission to
 * act unattended is the entire failure the ladder exists to prevent. The
 * verifier was wrong to ask for it as the scheduler.
 *
 * Same shape as OBJ-24, where the worker was refused an insert on
 * `ingest_mappings` and the fix was to stop pretending the scheduler was a
 * person. A consent is a person's act and arrives on the request path.
 */
const granted = await grantConsent({
  ownerId: OWNER,
  patternKey: PATTERN,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  onCount: s?.accepted ?? 0,
  principal: "OWNER",
});
check("a person says yes", granted.ok, granted.ok ? `granted by ${granted.consent.grantedByName}` : granted.error);

let workerTried = "it inserted one";
try {
  await withWorkerScope(async () =>
    // `db` inside a worker scope **is** the worker connection. `ownerDb` is the
    // table owner and bypasses every policy — reaching for it here would have
    // proved nothing except that the CLI credential works, which is not in
    // doubt and is not what the claim is about.
    db.insert(autonomyConsentsTable).values({
      ownerId: OWNER,
      patternKey: `${PATTERN}:SELF-GRANTED`,
      grantedByName: "the scheduler",
      grantedOnCount: 0,
    }),
  );
} catch (err) {
  // Drizzle wraps the driver error, so the sentence that matters is on the
  // cause. Reading only the wrapper gives "Failed query: insert into …", which
  // is true of a failure for any reason at all — including a typo in the table
  // name, which is the version of this check that passes while proving nothing.
  const cause = (err as { cause?: { message?: string } })?.cause?.message;
  workerTried = cause ?? (err instanceof Error ? err.message : String(err));
}
check(
  "and nothing unattended can grant one to itself",
  workerTried.includes("permission denied"),
  workerTried,
);

standing = await withWorkerScope(async () =>
  standingFor({ ownerId: OWNER, showroomIds: [SHOWROOM], policy }),
);
s = standing.get(PATTERN);
check("now it is automatic", s?.rung === "AUTOMATIC", s?.because);

const advisor = await grantConsent({
  ownerId: OWNER,
  patternKey: PATTERN,
  userId: 2,
  userName: "A service advisor",
  onCount: 12,
  principal: "SERVICE_ADVISOR",
});
check(
  "and it was never a service advisor's to give",
  !advisor.ok && advisor.status === 403,
  advisor.ok ? "IT WAS GRANTED" : advisor.error,
);

section("7. rejecting it demotes, with the consent left standing");

/*
 * Enough disagreement to cross the dealership's own ceiling. The consent row is
 * deliberately **not** revoked: the claim is that evidence alone brings a
 * pattern down, and that recovery afterwards needs nobody to remember to
 * re-grant anything.
 */
const contested = pool.slice(20, 30);
await withWorkerScope(async () => {
  for (const enqId of contested) {
    await agentOffers(enqId, JASWINDER.empCode);
    await personDecides(enqId, OTHER.empCode);
  }
  await resolveProposals({ ownerId: OWNER, showroomIds: [SHOWROOM], expireAfterDays: 30 });
});

standing = await withWorkerScope(async () =>
  standingFor({ ownerId: OWNER, showroomIds: [SHOWROOM], policy }),
);
s = standing.get(PATTERN);

check(
  "people are changing the answer",
  (s?.overrideRatePct ?? 0) > 20,
  `${s?.overrideRatePct}% changed, above the 20% this dealership allows`,
);
check("it has come back down", s?.rung === "RECALL", s?.because);
check(
  "and nobody's decision was deleted to do it",
  s?.consent !== null,
  "the consent still stands and still says who gave it — evidence sets what is earned, consent only raises the ceiling",
);

const revoked = await revokeConsent({
  ownerId: OWNER,
  patternKey: PATTERN,
  userId: ANIRBAN.id,
  reason: "Taking it back while we work out why.",
  principal: "OWNER",
});
check("and it can still be taken back explicitly", revoked.ok);

section("8. the queue carries it, and does not let it move anything");

const queue = await withWorkerScope(async () =>
  buildQueue({
    ownerId: OWNER,
    ownerShowroomIds: [SHOWROOM, 2],
    visibleShowroomIds: [SHOWROOM, 2],
    empCode: null,
    role: "OWNER",
    policy,
  }),
);

const cited = queue.items.filter((i) => i.learned !== null);
console.log(`      ${cited.length} of ${queue.total} rows carry something this outlet has done before`);
check("a row cites the habit", cited.length > 0, cited[0]?.learned?.sentence ?? "");
check(
  "every citation has a count and a date on it",
  cited.every((i) => !i.learned?.sentence || /\d/.test(i.learned.sentence)),
);
check(
  "at recall nothing is pre-filled",
  cited.filter((i) => i.learned?.rung === "RECALL").every((i) => i.learned?.prefill === null),
);

/*
 * R-69, stated as a sort. Precedent informs and never decides — so a row that
 * carries a habit must sit exactly where severity, band and waiting time put
 * it, and nowhere else.
 */
const ordered = [...queue.items].sort(
  (a, b) =>
    ({ MINE: 0, UNASSIGNED: 1, OUTLET: 2 })[a.band] - ({ MINE: 0, UNASSIGNED: 1, OUTLET: 2 })[b.band] ||
    b.severity - a.severity ||
    b.waitingDays - a.waitingDays ||
    a.module.localeCompare(b.module) ||
    a.showroomId - b.showroomId ||
    a.recordKey.localeCompare(b.recordKey),
);
check(
  "and it moved nothing up the list (R-69)",
  ordered.every((i, n) => queue.items[n] === i),
  "band, then severity, then how long it has waited — a habit is not urgency",
);

section("9. the switch and the ladder both have to hold");

await withWorkerScope(async () => {
  const off = await runAgentForShowroom(OWNER, SHOWROOM, queue.items, policy);
  check("with the agent switched off, nothing is assigned", off.assigned === 0 && !off.enabled);
  check(
    "but it still writes down what it would have done",
    off.proposed >= 0,
    `${off.proposed} offers recorded — this is what earns the rung, so it cannot wait for the rung`,
  );
});

await setPolicy(OWNER, SHOWROOM, ANIRBAN.id, "AGENT.ASSIGN_ORPHANS", 1);
const on = await loadPolicy(OWNER);

const fresh = await withWorkerScope(async () =>
  buildQueue({
    ownerId: OWNER,
    ownerShowroomIds: [SHOWROOM, 2],
    visibleShowroomIds: [SHOWROOM, 2],
    empCode: null,
    role: "OWNER",
    policy: on,
  }),
);

const run = await withWorkerScope(async () => runAgentForShowroom(OWNER, SHOWROOM, fresh.items, on));
check(
  "switched on, it still holds back what has not been earned",
  run.enabled && run.assigned === 0 && run.held.length > 0,
  run.held[0] ? `${run.held[0].rung} — ${run.held[0].because}` : "nothing held",
);
console.log(
  "      a dealership that switches the agent on and has no history gets suggestions, not actions",
);

section("10. a pattern that stops, stops being shown (R-71)");

const narrow = await withWorkerScope(async () =>
  precedentFor({ ownerId: OWNER, showroomIds: [SHOWROOM], windowDays: 1 }),
);
const wide = await withWorkerScope(async () =>
  precedentFor({ ownerId: OWNER, showroomIds: [SHOWROOM], windowDays: 3650 }),
);
check(
  "the window is what decides, and it is the dealership's number",
  (wide.get(PATTERN)?.total ?? 0) >= (narrow.get(PATTERN)?.total ?? 0),
  `${narrow.get(PATTERN)?.total ?? 0} in a day, ${wide.get(PATTERN)?.total ?? 0} over ten years`,
);

const noConsentByWorker = await withWorkerScope(async () =>
  ownerDb
    .select({ n: sql<number>`count(*)::int` })
    .from(autonomyConsentsTable)
    .where(and(eq(autonomyConsentsTable.ownerId, OWNER), isNull(autonomyConsentsTable.revokedAt))),
);
check(
  "and nothing unattended holds a live consent it granted itself",
  (noConsentByWorker[0]?.n ?? 0) === 0,
  "`ddms_worker` has select and no insert on consents — refused by the grant, not by the code being careful",
);

await reset();
console.log("  (proposals, consents, borrowed decisions and the numbers all reset, on the CLI credential)");

console.log(
  failures === 0
    ? "\nAll checks passed. Autonomy earned by evidence, lost the same way, and a floor no evidence reaches.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
