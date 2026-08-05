/**
 * OBJ-17, proved on the worker credential rather than through a request.
 *
 * Run with `node --env-file=.env.api scripts/…` so it reaches the database as
 * `ddms_worker` — the same role the scheduler uses. Proving it through an HTTP
 * request would prove it on `ddms_app`, which is the credential a *person*
 * holds, and the whole claim is that the agent acts with nobody signed in.
 */

import {
  workerDb,
  withWorkerScope,
  dmsEnquiriesTable,
  dmsRegistrationsTable,
  decisionLogTable,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { applyAction } from "../lib/dms/actions";
import { runAgentForShowroom, suggestForItems } from "../lib/dms/agent";
import { buildQueue } from "../lib/dms/queue";
import { loadPolicy } from "../lib/dms/policy";

const OWNER = 1;
const SHOWROOM = 1;

const API = "http://localhost:8080/api";
const KEY = process.env["API_SERVICE_KEY"]!;

/** Sign in as the owner and set the switch, because only a person may. */
async function setSwitchThroughTheApi(value: number | null): Promise<void> {
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ email: "anirban@saraswatiauto.example", password: "saraswati" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const res = await fetch(`${API}/dms/policy`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-api-key": KEY, cookie },
    body: JSON.stringify({ key: "AGENT.ASSIGN_ORPHANS", value, showroomId: SHOWROOM }),
  });
  if (!res.ok) throw new Error(`policy set failed: ${res.status} ${await res.text()}`);
}

async function line(label: string, fn: () => Promise<unknown>): Promise<void> {
  const out = await fn();
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
  console.log(out);
}

await withWorkerScope(async () => {
  // Put back the enquiry the OBJ-20 test reassigned, so there is more than one
  // orphan to work with. This is the state the queue was in before that test.
  await workerDb
    .update(dmsEnquiriesTable)
    .set({ reassignedToEmpCode: null, reassignedAt: null })
    .where(
      and(eq(dmsEnquiriesTable.showroomId, SHOWROOM), eq(dmsEnquiriesTable.enqId, "ENQ-0417-9103")),
    );

  const owned = [SHOWROOM, 2];
  let policy = await loadPolicy(OWNER);

  await line("1. the switch, as the product ships", async () =>
    `AGENT.ASSIGN_ORPHANS on = ${policy.on("AGENT.ASSIGN_ORPHANS")}`,
  );

  let queue = await buildQueue({
    ownerId: OWNER,
    ownerShowroomIds: owned,
    visibleShowroomIds: [SHOWROOM],
    empCode: null,
    role: "OWNER",
    policy,
  });

  await line("2. what it would do, before it may do anything", async () =>
    [...(await suggestForItems(queue.items)).entries()]
      .map(([k, s]) => `${k}\n     → ${s.empName} (${s.empCode}), carrying ${s.carrying} of ${s.consideredCount}\n     ${s.reason}`)
      .join("\n"),
  );

  await line("3. switched off, it does nothing", async () => {
    const r = await runAgentForShowroom(OWNER, SHOWROOM, queue.items, policy);
    return `enabled=${r.enabled} considered=${r.considered} assigned=${r.assigned}`;
  });

  // The owner turns it on — through the route, signed in, because that is the
  // only way it can be turned on.
  //
  // The first version of this script wrote the row directly on `workerDb` and
  // got `permission denied for table dealer_policy`, which is the arrangement
  // working: `ddms_worker` may **read** the dealership's numbers and may not
  // set them. A switch the unattended process could turn on itself would not be
  // the dealership's switch.
  await setSwitchThroughTheApi(1);
  policy = await loadPolicy(OWNER);

  await line("4. switched on, it acts", async () => {
    const r = await runAgentForShowroom(OWNER, SHOWROOM, queue.items, policy);
    return `enabled=${r.enabled} considered=${r.considered} assigned=${r.assigned} refused=${JSON.stringify(r.refused)}`;
  });

  await line("5. the log says the system did it", async () => {
    const rows = await workerDb
      .select({
        id: decisionLogTable.id,
        userId: decisionLogTable.userId,
        action: decisionLogTable.action,
        recordKey: decisionLogTable.recordKey,
        note: decisionLogTable.note,
      })
      .from(decisionLogTable)
      .where(and(eq(decisionLogTable.ownerId, OWNER), isNull(decisionLogTable.userId)))
      .orderBy(desc(decisionLogTable.id))
      .limit(4);
    return rows
      .map((r) => `#${r.id} userId=${r.userId} ${r.action} ${r.recordKey}\n     ${r.note ?? ""}`)
      .join("\n");
  });

  await line("6. the records actually moved", async () => {
    const [enq] = await workerDb
      .select({ to: dmsEnquiriesTable.reassignedToEmpCode })
      .from(dmsEnquiriesTable)
      .where(eq(dmsEnquiriesTable.enqId, "ENQ-0417-9103"));
    const [reg] = await workerDb
      .select({ to: dmsRegistrationsTable.assignedAgentEmpCode })
      .from(dmsRegistrationsTable)
      .where(eq(dmsRegistrationsTable.regnFileNo, "REG-0417-3307"));
    return `ENQ-0417-9103 → ${enq?.to ?? "nobody"}\n   REG-0417-3307 → ${reg?.to ?? "nobody"}`;
  });

  await line("7. the orphaned band shrank", async () => {
    const before = queue.unassigned;
    queue = await buildQueue({
      ownerId: OWNER,
      ownerShowroomIds: owned,
      visibleShowroomIds: [SHOWROOM],
      empCode: null,
      role: "OWNER",
      policy,
    });
    return `nobody's band: ${before} → ${queue.unassigned}`;
  });

  await line("8. a second pass finds nothing left to do", async () => {
    const r = await runAgentForShowroom(OWNER, SHOWROOM, queue.items, policy);
    return `considered=${r.considered} assigned=${r.assigned}`;
  });

  // ── The refusals ──────────────────────────────────────────────────────────
  //
  // The agent will never reach these on its own, because `listStaff` excludes
  // anybody who has left and the queue only offers records this owner holds.
  // That is the point: they are produced here by calling `applyAction` with a
  // null user id and a bad argument, which is exactly what the agent calls.
  // The refusal is not a copy for the agent — it is the same one.

  await line("9. refused: the employee has left", async () => {
    // Imtiaz Khan, the salesman whose departure orphaned this enquiry in the
    // first place. Handing it back to him is the exact bug the queue exists to
    // surface, and the agent gets the same sentence a person would.
    const r = await applyAction({
      ownerId: OWNER,
      userId: null,
      action: "ENQUIRY_REASSIGN",
      recordKey: "ENQ-0417-9103",
      showroomId: SHOWROOM,
      empCode: "SA-0417-21",
    });
    return r.ok ? "ALLOWED — that is a bug" : `${r.status}: ${r.error}`;
  });

  await line("10. refused: another dealership's outlet", async () => {
    const r = await applyAction({
      ownerId: OWNER,
      userId: null,
      action: "ENQUIRY_REASSIGN",
      recordKey: "ENQ-0417-9103",
      showroomId: 3,
      empCode: "SA-0417-19",
    });
    return r.ok ? "ALLOWED — that is a bug" : `${r.status}: ${r.error}`;
  });

  await line("11. a person undoes what the agent did", async () => {
    const r = await applyAction({
      ownerId: OWNER,
      userId: 1,
      action: "ENQUIRY_REASSIGN",
      recordKey: "ENQ-0417-9103",
      showroomId: SHOWROOM,
      clear: true,
    });
    const [enq] = await workerDb
      .select({ to: dmsEnquiriesTable.reassignedToEmpCode })
      .from(dmsEnquiriesTable)
      .where(eq(dmsEnquiriesTable.enqId, "ENQ-0417-9103"));
    const [log] = await workerDb
      .select({ userId: decisionLogTable.userId, action: decisionLogTable.action })
      .from(decisionLogTable)
      .where(eq(decisionLogTable.recordKey, "ENQ-0417-9103"))
      .orderBy(desc(decisionLogTable.id))
      .limit(1);
    return `${r.ok ? "undone" : "FAILED"} → assignee is now ${enq?.to ?? "nobody"}\n   log: ${log?.action} by userId=${log?.userId} (a person, not null)`;
  });

  // Put the switch back where the product ships it, so the running instance is
  // not left in a state nobody chose. Null is a reset, which is a delete.
  await setSwitchThroughTheApi(null);
  console.log("\nSwitch reset to the product default (off).");
});

process.exit(0);
