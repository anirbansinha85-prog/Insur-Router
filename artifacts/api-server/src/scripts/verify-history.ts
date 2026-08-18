/**
 * OBJ-49's done-when, stated so it can fail.
 *
 * > *Somebody who has never seen this record can tell what has already been
 * > tried, and hand it to somebody who is here.*
 *
 * §2 is the one that would have been missed by a tidier implementation and is
 * the reason the objective exists at all. The timeline that already shipped
 * reads `record_activities` — what somebody **wrote down**. Pressing *Mark
 * customer told* writes `decision_log` and nothing else, so the commonest thing
 * an advisor does left no trace on the record's own history. The check that
 * proves it closed is: **press the button, and see it on the history.**
 *
 * §3 is the one a merged timeline gets wrong. Their system changing a record and
 * our noticing it are two different clocks, and a screen that shows one column
 * of timestamps reads a three-day sync gap as three days in which nobody did
 * anything.
 *
 * §5 is the refusal the handover rests on. Handing work to somebody who has left
 * is the bug this whole family of actions exists to fix, and it does not become
 * acceptable because the workshop is short-staffed this morning.
 *
 * `pnpm --filter @workspace/scripts run history`.
 */

import {
  ownerDb,
  withWorkerScope,
  showroomsTable,
  showroomDmsAccountsTable,
  dmsJobCardsTable,
  dmsEmployeesTable,
  decisionLogTable,
  recordActivitiesTable,
  recordEventsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { applyAction } from "../lib/dms/actions";
import { recordHistory, ownerOfRecord } from "../lib/dms/history";
import { writeActivity } from "../lib/dms/records";

const OWNER = 1;
const RUN_BY = "verify-history";
const JC = "VERIFY-HIST-JC-1";
const ADVISOR = "VH-ADV-HERE";
const DEPARTED = "VH-ADV-GONE";
const COVER = "VH-ADV-COVER";
const STAFF = [ADVISOR, DEPARTED, COVER];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

console.log(`\nOBJ-49 — a record somebody else can pick up, run by ${RUN_BY}\n`);

const [branch] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SARASWATI")))
  .limit(1);
if (!branch) throw new Error("Fixture missing. Run db:seed-owners.");

const [account] = await ownerDb
  .select({ code: showroomDmsAccountsTable.dealerCode })
  .from(showroomDmsAccountsTable)
  .where(eq(showroomDmsAccountsTable.showroomId, branch.id))
  .limit(1);
const DEALER = account?.code ?? "HMC-DL-0417";

async function tidy(): Promise<void> {
  await ownerDb.delete(dmsJobCardsTable).where(eq(dmsJobCardsTable.jcNo, JC));
  await ownerDb.delete(dmsEmployeesTable).where(inArray(dmsEmployeesTable.empCode, STAFF));
  await ownerDb.delete(decisionLogTable).where(eq(decisionLogTable.recordKey, JC));
  await ownerDb.delete(recordActivitiesTable).where(eq(recordActivitiesTable.recordKey, JC));
  await ownerDb.delete(recordEventsTable).where(eq(recordEventsTable.recordKey, JC));
}
await tidy();

// ── the fixture: one card, three people, one of whom has left ──────────────
for (const [code, name, leaving] of [
  [ADVISOR, "Sunil Rawat (fixture)", null],
  [DEPARTED, "Imtiaz Khan (fixture, left)", "2026-02-14"],
  [COVER, "Meera Joshi (fixture, covering)", null],
] as const) {
  await ownerDb.insert(dmsEmployeesTable).values({
    showroomId: branch.id,
    dealerCode: DEALER,
    empCode: code,
    empName: name,
    role: "SERVICE_ADVISOR",
    isActive: leaving ? "N" : "Y",
    dateOfLeaving: leaving,
    lastSyncedAt: new Date(),
  });
}

await ownerDb.insert(dmsJobCardsTable).values({
  showroomId: branch.id,
  dealerCode: DEALER,
  jcNo: JC,
  status: "AWAITING_APPROVAL",
  jcType: "PAID",
  jcDate: "2026-07-20",
  promisedDate: "2026-07-30",
  customerName: "Mrs Kiran Rao (fixture)",
  customerMobile: "9106833887",
  modelDescription: "Splendor Plus",
  regNo: "DL4SBX5755",
  advisorEmpCode: ADVISOR,
  raw: { jcNo: JC, source: RUN_BY },
  rawHash: `${RUN_BY}-${JC}`,
});

// A derived state, so "stuck for N days" has something behind it.
await ownerDb.insert(recordEventsTable).values({
  ownerId: OWNER,
  showroomId: branch.id,
  module: "JOB_CARD",
  recordKey: JC,
  fromState: "IN_PROGRESS",
  toState: "AWAITING_APPROVAL",
  detectedAt: new Date("2026-07-31T09:00:00Z"),
});

// ────────────────────────────────────────────────────────────────────────────

section("1. a history exists at all, and says how far back it can see");

let h = await withWorkerScope(() =>
  recordHistory({ ownerId: OWNER, module: "JOB_CARD", recordKey: JC }),
);

check(
  "it resolves the outlet itself rather than being told",
  h.showroomId === branch.id,
  `${h.showroomId} — the mirror row carries it, and row-level security decides whether it may be read`,
);
check(
  "the current state and how long it has been in it",
  h.currentState === "AWAITING_APPROVAL" && Boolean(h.inCurrentStateSince),
  `${h.currentState} since ${h.inCurrentStateSince}`,
);
check(
  "**it says where its history starts**, rather than opening in the middle",
  h.limits.some((l) => l.includes("first arrived in a sync")),
  h.limits.find((l) => l.includes("first arrived")) ?? "(not stated)",
);
check(
  "and with nothing tried, it says so and says why that is ambiguous",
  h.tried.length === 0 && h.limits.some((l) => l.includes("cannot tell them apart")),
  h.limits.find((l) => l.includes("cannot tell them apart")) ?? "(not stated)",
);

// ────────────────────────────────────────────────────────────────────────────

section("2. **what somebody did appears, not only what they wrote down**");

const marked = await withWorkerScope(() =>
  applyAction({
    ownerId: OWNER,
    userId: 1,
    action: "JOB_CARD_MARK_INFORMED",
    recordKey: JC,
    showroomId: branch.id,
    userName: RUN_BY,
  }),
);
check("the button writes", marked.ok, marked.ok ? `decision ${marked.decisionId}` : marked.error);

h = await withWorkerScope(() =>
  recordHistory({ ownerId: OWNER, module: "JOB_CARD", recordKey: JC }),
);
const decision = h.entries.find((e) => e.kind === "DECISION");
check(
  "**pressing Mark customer told now shows on the record's history**",
  Boolean(decision),
  decision ? `${decision.headline} — ${decision.who}` : "(nothing on the history)",
);
check(
  "in words rather than as an action id",
  decision?.headline === "Told the customer where their vehicle is",
  decision?.headline ?? "",
);
check(
  "with a name against it, and the name of a person rather than the system",
  decision?.who !== "the agent" && Boolean(decision?.who),
  decision?.who ?? "(nobody)",
);
check(
  "**and it counts as an attempt** — which is the question a manager has",
  h.tried.some((e) => e.kind === "DECISION"),
  `${h.tried.length} attempt(s) recorded`,
);
check(
  "so the 'nobody has tried' limit is gone",
  !h.limits.some((l) => l.includes("cannot tell them apart")),
  "the limit is stated only while it is true",
);

// Undoing it is not a second attempt.
await withWorkerScope(() =>
  applyAction({
    ownerId: OWNER,
    userId: 1,
    action: "JOB_CARD_MARK_INFORMED",
    recordKey: JC,
    showroomId: branch.id,
    clear: true,
    userName: RUN_BY,
  }),
);
h = await withWorkerScope(() =>
  recordHistory({ ownerId: OWNER, module: "JOB_CARD", recordKey: JC }),
);
const undo = h.entries.find((e) => e.kind === "DECISION" && e.headline.startsWith("Took back"));
check(
  "an undo reads as an undo and is not counted as an attempt",
  Boolean(undo) && undo!.tried === false,
  undo?.headline ?? "(no undo entry)",
);
check(
  "and both the doing and the undoing are still there",
  h.entries.filter((e) => e.kind === "DECISION").length === 2,
  "a decision somebody reversed is two facts, and only one of them can be defended later",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. **every entry says which clock it is on**");

const logged = await withWorkerScope(() =>
  writeActivity({
    ownerId: OWNER,
    showroomId: branch.id,
    module: "JOB_CARD",
    recordKey: JC,
    kind: "CALL",
    body: "Rang about the revised estimate — no answer, will try after lunch.",
    userId: 1,
    authorName: RUN_BY,
    principal: "OWNER",
  }),
);
/*
 * Asserted rather than fired and forgotten. A verifier that ignores a return
 * value will one day pass while doing nothing — which this one already did:
 * the call failed, and the check that depended on it reported the *decision*
 * as the only attempt without anybody noticing the activity was never written.
 */
check("the call is logged", logged.ok, logged.ok ? "" : logged.error);

h = await withWorkerScope(() =>
  recordHistory({ ownerId: OWNER, module: "JOB_CARD", recordKey: JC }),
);

for (const e of h.entries) {
  console.log(`      ${e.at.slice(0, 16).replace("T", " ")}  ${e.clockNote.padEnd(14)} ${e.headline}`);
}

check(
  "no entry is missing its clock",
  h.entries.every((e) => e.clock && e.clockNote.length > 0),
  `${h.entries.length} entries, every one on a named clock`,
);
check(
  "the clocks are genuinely different — this is not one clock with a label",
  new Set(h.entries.map((e) => e.clock)).size >= 2,
  [...new Set(h.entries.map((e) => e.clockNote))].join(", "),
);
check(
  "a logged call is an attempt",
  h.tried.some((e) => e.kind === "ACTIVITY"),
  h.tried.map((e) => e.headline).join("; "),
);
check(
  "newest first, so the top of the page is what happened last",
  h.entries.every((e, i) => i === 0 || e.at <= h.entries[i - 1]!.at),
  "a history that is not in order is a pile",
);
check(
  "every entry names the row it came off",
  h.entries.every((e) => e.source.table.length > 0),
  [...new Set(h.entries.map((e) => e.source.table))].join(", "),
);

// ────────────────────────────────────────────────────────────────────────────

section("4. whose it is, and whether they are still here");

let owner = await withWorkerScope(() =>
  ownerOfRecord({ module: "JOB_CARD", recordKey: JC, showroomId: branch.id }),
);
check(
  "the advisor the dealer's system names",
  owner.empCode === ADVISOR && owner.origin === "MIRROR",
  `${owner.name} — ${owner.note}`,
);
check("and they are here", owner.stillHere === true, owner.note);

// Move the card to the one who left, the way the dealer's system would.
await ownerDb
  .update(dmsJobCardsTable)
  .set({ advisorEmpCode: DEPARTED })
  .where(eq(dmsJobCardsTable.jcNo, JC));

owner = await withWorkerScope(() =>
  ownerOfRecord({ module: "JOB_CARD", recordKey: JC, showroomId: branch.id }),
);
check(
  "**somebody who has left is named as having left, with the date**",
  owner.stillHere === false && owner.note.includes("2026-02-14"),
  owner.note,
);

// And the honest third answer.
await ownerDb
  .update(dmsJobCardsTable)
  .set({ advisorEmpCode: "VH-NOT-IN-ROSTER" })
  .where(eq(dmsJobCardsTable.jcNo, JC));
owner = await withWorkerScope(() =>
  ownerOfRecord({ module: "JOB_CARD", recordKey: JC, showroomId: branch.id }),
);
check(
  "**an unknown employee code is 'we cannot say', not 'they have left'**",
  owner.stillHere === null && owner.note.includes("cannot say"),
  `${owner.note} — a keying error is not a departure, and reporting it as one sends somebody to reassign work that is fine`,
);

await ownerDb
  .update(dmsJobCardsTable)
  .set({ advisorEmpCode: DEPARTED })
  .where(eq(dmsJobCardsTable.jcNo, JC));

// ────────────────────────────────────────────────────────────────────────────

section("5. the handover, and what it refuses");

const toDeparted = await withWorkerScope(() =>
  applyAction({
    ownerId: OWNER,
    userId: 1,
    action: "JOB_CARD_REASSIGN",
    recordKey: JC,
    showroomId: branch.id,
    empCode: DEPARTED,
    userName: RUN_BY,
  }),
);
check(
  "**handing a card to somebody who has left is refused**",
  !toDeparted.ok && toDeparted.status === 409,
  toDeparted.ok ? "it was handed over" : toDeparted.error,
);

const noBody = await withWorkerScope(() =>
  applyAction({
    ownerId: OWNER,
    userId: 1,
    action: "JOB_CARD_REASSIGN",
    recordKey: JC,
    showroomId: branch.id,
    userName: RUN_BY,
  }),
);
check(
  "and so is handing it to nobody",
  !noBody.ok && noBody.status === 400,
  noBody.ok ? "it was handed over" : noBody.error,
);

const handed = await withWorkerScope(() =>
  applyAction({
    ownerId: OWNER,
    userId: 1,
    action: "JOB_CARD_REASSIGN",
    recordKey: JC,
    showroomId: branch.id,
    empCode: COVER,
    userName: RUN_BY,
  }),
);
check("handing it to somebody who is here works", handed.ok, handed.ok ? "" : handed.error);

owner = await withWorkerScope(() =>
  ownerOfRecord({ module: "JOB_CARD", recordKey: JC, showroomId: branch.id }),
);
check(
  "**the handover wins over the mirror's advisor**",
  owner.empCode === COVER && owner.origin === "DDMS",
  `${owner.name} — ${owner.note}`,
);
check(
  "and it says the dealer's system still names somebody else",
  owner.note.includes("still names somebody else"),
  "the DMS has no column for a handover, which is the whole reason this field exists",
);

h = await withWorkerScope(() =>
  recordHistory({ ownerId: OWNER, module: "JOB_CARD", recordKey: JC }),
);
const handover = h.entries.find((e) => e.headline.includes("Handed the job card"));
check(
  "the handover is on the history with the name of whoever did it",
  Boolean(handover) && handover!.who !== "the agent",
  handover ? `${handover.headline} — ${handover.who}` : "(not on the history)",
);
check(
  "**and a handover is not an attempt** — moving work is not doing it",
  handover?.tried === false,
  "counting it would let a card be handed round three people and read as three attempts to help the customer",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. reading a history writes nothing");

const before = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(decisionLogTable)
    .where(eq(decisionLogTable.ownerId, OWNER))
)[0]!.c;
await withWorkerScope(() =>
  recordHistory({ ownerId: OWNER, module: "JOB_CARD", recordKey: JC }),
);
const after = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(decisionLogTable)
    .where(eq(decisionLogTable.ownerId, OWNER))
)[0]!.c;
check(
  "no decision, and no record of having looked",
  before === after,
  `${before} decisions before, ${after} after — a history that logged its own page views would drown the thing it exists to show`,
);

// ────────────────────────────────────────────────────────────────────────────

await tidy();
console.log("\n  (the job card, the three staff rows and every entry this run made, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. What was done is on the record beside what was written down, every\n" +
      "entry says which clock it is on, and a card can be handed to somebody who is here.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
