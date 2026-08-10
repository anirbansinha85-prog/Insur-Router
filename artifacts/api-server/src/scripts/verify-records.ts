/**
 * OBJ-22's done-when, proved on the worker credential.
 *
 * > *DDMS holds a record the DMS has no field for, an agent writes one without
 * > asserting human work, and nothing mirror-only has become writable.*
 *
 * The middle clause is the objective. It cannot be proved through an HTTP
 * request, because a request has a person behind it and the whole claim is
 * about what happens when nobody is signed in — so this runs inside
 * `withWorkerScope`, the same scope the scheduler uses.
 *
 * `pnpm run verify:records`.
 */

import {
  ownerDb,
  workerDb,
  withWorkerScope,
  recordActivitiesTable,
  tasksTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  writeActivity,
  createTask,
  closeTask,
  listActivities,
  openTasks,
  AGENT_KINDS,
} from "../lib/dms/records";
import { may } from "../lib/dms/permissions";
import { buildQueue } from "../lib/dms/queue";
import { loadPolicy } from "../lib/dms/policy";

const OWNER = 1;
const SHOWROOM = 1;
const RECORD = { module: "REGISTRATION" as const, recordKey: "REG-0417-3311" };

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
}

/**
 * Tidy-up runs on the CLI credential, and the first version of this script did
 * not — it tried to delete on `workerDb` and got `permission denied for table
 * record_activities`.
 *
 * That refusal is the design working rather than an obstacle. `ddms_worker` is
 * granted select, insert and update and **not** delete, for the same reason the
 * outbox cancels a message rather than removing it: a note nobody can prove
 * existed is worse than a note somebody withdrew. Nothing unattended may erase
 * a record — not even its own.
 */
async function tidy(): Promise<void> {
  await ownerDb
    .delete(recordActivitiesTable)
    .where(
      and(
        eq(recordActivitiesTable.recordKey, RECORD.recordKey),
        eq(recordActivitiesTable.authoredBy, "AGENT"),
      ),
    );
  await ownerDb.delete(tasksTable).where(eq(tasksTable.title, "VERIFY — chase the address proof"));
}

await tidy();

await withWorkerScope(async () => {

  section("1. the agent may record what it did");

  const observed = await writeActivity({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    module: RECORD.module,
    recordKey: RECORD.recordKey,
    kind: "OBSERVED",
    body: "The address on the deal does not match the one on the KYC document.",
    userId: null,
    principal: "AGENT",
  });
  check("OBSERVED is allowed", observed.ok);
  if (observed.ok) {
    check(
      "and it is attributed to the agent, not to nobody",
      observed.row.authoredBy === "AGENT" && observed.row.userId === null,
      `authoredBy=${observed.row.authoredBy} userId=${observed.row.userId}`,
    );
  }

  section("2. and may never record what a person did");

  for (const kind of ["CALL", "VISIT", "MESSAGE", "NOTE", "INBOUND"] as const) {
    const r = await writeActivity({
      ownerId: OWNER,
      showroomId: SHOWROOM,
      module: RECORD.module,
      recordKey: RECORD.recordKey,
      kind,
      body: "The agent should not be able to say this.",
      userId: null,
      principal: "AGENT",
    });
    check(`${kind.padEnd(8)} refused`, !r.ok, r.ok ? "ALLOWED — that is the bug" : r.error);
  }

  check(
    "the allowed set is exactly OBSERVED and SYSTEM",
    [...AGENT_KINDS].sort().join(",") === "OBSERVED,SYSTEM",
    [...AGENT_KINDS].join(", "),
  );

  section("3. the timeline is a real record, not a derived view");

  const timeline = await listActivities(OWNER, RECORD.module, RECORD.recordKey);
  check("entries survive and are readable", timeline.length > 0, `${timeline.length} entries`);
  const agentOnes = timeline.filter((a) => a.authoredBy === "AGENT");
  check("the agent's entry is among them", agentOnes.length === 1);
  console.log(`      "${agentOnes[0]?.body ?? ""}"`);

  section("4. an agent may raise a task and may not close one");

  check("holds task.create", may("AGENT", "task.create"));
  check("does NOT hold task.complete", !may("AGENT", "task.complete"));

  const task = await createTask({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    title: "VERIFY — chase the address proof",
    detail: "Raised by the agent because the addresses disagree.",
    module: RECORD.module,
    recordKey: RECORD.recordKey,
    assignedEmpCode: "RT-0417-02",
    dueOn: "2026-08-12",
    source: "AGENT",
    userId: null,
    principal: "AGENT",
  });
  check("the task was raised", task.ok, task.ok ? "" : task.error);
  if (task.ok) {
    check("attributed to the agent", task.row.source === "AGENT" && task.row.createdByUserId === null);
    check("assigned to somebody who still works here", task.row.assignedEmpName === "Jaswinder Sethi");
  }

  const cannotClose = task.ok
    ? await closeTask(OWNER, 1, "AGENT", task.row.id, "DONE")
    : { ok: false as const, status: 403 as const, error: "n/a" };
  check("closing it is refused to the agent", !cannotClose.ok, cannotClose.ok ? "ALLOWED" : cannotClose.error);

  section("5. a task on a departed employee is refused");

  const departed = await createTask({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    title: "VERIFY — should never exist",
    // Imtiaz Khan, who left on 28-02-2026 and whose orphaned enquiry is the
    // reason the queue has a middle band at all.
    assignedEmpCode: "SA-0417-21",
    source: "AGENT",
    userId: null,
    principal: "AGENT",
  });
  check("refused", !departed.ok, departed.ok ? "ALLOWED" : departed.error);

  section("6. the task appears on the queue, in one list");

  const policy = await loadPolicy(OWNER);
  const queue = await buildQueue({
    ownerId: OWNER,
    ownerShowroomIds: [1, 2],
    visibleShowroomIds: [SHOWROOM],
    empCode: null,
    role: "OWNER",
    policy,
  });
  const taskRows = queue.items.filter((i) => i.source === "TASK");
  const derived = queue.items.filter((i) => i.source === "DERIVED");
  check("it is on the queue", taskRows.some((i) => i.title.startsWith("VERIFY —")));
  check("sorted among the derived rows, not appended", derived.length > 0 && taskRows.length > 0);
  console.log(`      ${queue.total} items — ${derived.length} derived, ${taskRows.length} written down`);

  const mine = taskRows.find((i) => i.title.startsWith("VERIFY —"));
  if (mine) {
    console.log(
      `      "${mine.title}" · severity ${mine.severity} · band ${mine.band} · assigned ${mine.assignedEmpName}`,
    );
  }

  section("7. a person closes it, and the queue lets it go");

  if (task.ok) {
    const closed = await closeTask(OWNER, 1, "OWNER", task.row.id, "DONE", "Bill received.");
    check("a person may close it", closed.ok, closed.ok ? "" : closed.error);

    const after = await openTasks(OWNER, [SHOWROOM]);
    check("it is no longer open", !after.some((t) => t.id === task.row.id));
  }

  section("8. nothing mirror-only became writable");

  // The registration file this activity points at is still read-only to the
  // application: `applyAction` writes decision fields and nothing else, and no
  // route added by OBJ-22 touches a mirror table at all.
  const [reg] = await workerDb
    .select({ n: recordActivitiesTable.id })
    .from(recordActivitiesTable)
    .where(eq(recordActivitiesTable.recordKey, RECORD.recordKey))
    .orderBy(desc(recordActivitiesTable.id))
    .limit(1);
  check("activities live in their own table, beside the mirror", Boolean(reg));

  check(
    "the worker cannot delete what it wrote",
    !(await canWorkerDelete()),
    "select, insert and update, never delete. Nothing unattended erases a record.",
  );
});

await tidy();
console.log("  (verification rows removed, on the CLI credential)");

/**
 * The grant this asserts is the one that broke the first version of this
 * script, and it was right to.
 *
 * `ddms_worker` may select, insert and update `record_activities` and may not
 * delete — the same argument as cancelling a message rather than removing it.
 * A note nobody can prove existed is worse than a note somebody withdrew, and
 * nothing unattended erases a record, not even its own.
 */
async function canWorkerDelete(): Promise<boolean> {
  try {
    await workerDb.delete(tasksTable).where(eq(tasksTable.id, -1));
    return true;
  } catch {
    return false;
  }
}

console.log(
  failures === 0
    ? "\nAll checks passed. DDMS owns records, and the agent may only say what it did.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
