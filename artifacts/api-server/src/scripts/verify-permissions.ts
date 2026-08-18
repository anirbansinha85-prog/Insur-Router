/**
 * OBJ-21's done-when, checked rather than asserted.
 *
 * The objective is a refactor: **one table must answer every permission
 * question, and nothing may behave differently than it did before.** The second
 * half is the risky half, so the numbers below are the ones the two old tables
 * produced, written down here as the thing that must not move.
 *
 * Run with `pnpm run verify:permissions`. No database and no server — this is a
 * pure function of one file, which is itself part of the point.
 */

import {
  may,
  whyNot,
  modulesFor,
  canRead,
  seesEveryOutlet,
  permissionsFor,
  PERMISSION_FOR_ACTION,
  type Permission,
  type RegistryActionId,
} from "../lib/dms/permissions";
import { AGENT_ACTIONS, CLOSED_TO_THE_AGENT, isAgentAction } from "../lib/dms/agent";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok ? "" : `\n      expected ${e}\n      got      ${a}`}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

// ── 1. Reading, exactly as access.ts answered it ────────────────────────────
//
// Copied from the table that was deleted. If any of these move, a role's
// sidebar changed and somebody lost a screen they had yesterday.

section("1. every role reads exactly what it read before");

const BEFORE: Record<string, string[]> = {
  OWNER: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE", "OUTBOX"],
  MANAGER: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE", "OUTBOX"],
  SALES_EXEC: ["DEAL", "ENQUIRY", "VEHICLE", "OUTBOX"],
  SERVICE_ADVISOR: ["JOB_CARD", "PART", "OUTBOX"],
  RTO_AGENT: ["REGISTRATION", "OUTBOX"],
  ACCOUNTS: ["DEAL", "RECEIVABLE", "OUTBOX"],
  TECHNICIAN: ["JOB_CARD"],
  PLATFORM_ADMIN: [],
};

for (const [role, expected] of Object.entries(BEFORE)) {
  // Sorted both sides: `modulesFor` returns them in table order, and the old
  // one returned them in the order they were written.
  check(role.padEnd(16), [...modulesFor(role)].sort(), [...expected].sort());
}

check("an unknown role reads nothing", modulesFor("JANITOR"), []);
check("canRead agrees with modulesFor", canRead("RTO_AGENT", "REGISTRATION"), true);
check("and refuses what it should", canRead("TECHNICIAN", "RECEIVABLE"), false);

// ── 2. Who sees across outlets ──────────────────────────────────────────────

section("2. cross-outlet visibility is unchanged");

check("owner", seesEveryOutlet("OWNER"), true);
check("manager", seesEveryOutlet("MANAGER"), true);
check("service advisor", seesEveryOutlet("SERVICE_ADVISOR"), false);
check("agent", seesEveryOutlet("AGENT"), false);

// ── 3. The separation the objective introduced ──────────────────────────────
//
// `policy.set` and `outlet.view_all` had one implementation and two meanings.
// They still have the same holders — that is the point of "nothing changed" —
// but they are now two questions, so the day one of them moves the other does
// not have to.

section("3. policy.set and outlet.view_all are separate questions");

for (const role of ["OWNER", "MANAGER"]) {
  check(`${role} holds both`, [may(role, "policy.set"), may(role, "outlet.view_all")], [true, true]);
}
for (const role of ["SALES_EXEC", "SERVICE_ADVISOR", "RTO_AGENT", "ACCOUNTS", "TECHNICIAN"]) {
  check(`${role} holds neither`, [may(role, "policy.set"), may(role, "outlet.view_all")], [false, false]);
}

// ── 4. The agent, still two of thirteen ─────────────────────────────────────

section("4. the agent still holds exactly two of the thirteen");

check(
  "its actions",
  [...AGENT_ACTIONS].sort(),
  ["ENQUIRY_REASSIGN", "REGISTRATION_ASSIGN_AGENT"],
);
/*
 * Eleven since OBJ-49, and the new one is refused for a different reason from
 * the other ten. Those assert a person did something; `JOB_CARD_REASSIGN`
 * asserts nothing false and is held back because a card in progress carries
 * context in somebody's head that a reassignment cannot move with it.
 */
check("closed to it", Object.keys(CLOSED_TO_THE_AGENT).length, 11);
check("isAgentAction says yes", isAgentAction("ENQUIRY_REASSIGN"), true);
check("isAgentAction says no", isAgentAction("RECEIVABLE_MARK_DISPUTED"), false);
check("and no to nonsense", isAgentAction("DELETE_EVERYTHING"), false);

// Every one of the thirteen is accounted for, in one direction or the other.
const allActions = Object.keys(PERMISSION_FOR_ACTION) as RegistryActionId[];
check("thirteen actions, no more", allActions.length, 13);
check(
  "each is either granted or refused, never neither",
  allActions.filter((a) => isAgentAction(a) || CLOSED_TO_THE_AGENT[a]).length,
  13,
);

// ── 5. The ten reasons survived the move ────────────────────────────────────

section("5. the ten reasons are still readable");

let missing = 0;
for (const [action, reason] of Object.entries(CLOSED_TO_THE_AGENT)) {
  if (!reason || reason.length < 40 || reason.startsWith("The agent does not hold")) {
    console.log(`  ✗ ${action} lost its written reason`);
    missing++;
  }
}
check("all ten carry a written sentence", missing, 0);
console.log(
  `\n  e.g. RECEIVABLE_MARK_DISPUTED\n       ${CLOSED_TO_THE_AGENT["RECEIVABLE_MARK_DISPUTED"]}`,
);

// ── 6. A refusal a person can act on ────────────────────────────────────────

section("6. refusals name the role and what it does cover");

const refusal = whyNot("TECHNICIAN", "receivable.log_chase");
console.log(`  TECHNICIAN → receivable.log_chase\n       ${refusal}`);
check("names the job", refusal.includes("A technician"), true);
check("names what they do have", refusal.includes("job cards"), true);

const noRole = whyNot("PLATFORM_ADMIN", "deal.view");
console.log(`  PLATFORM_ADMIN → deal.view\n       ${noRole}`);
check("a role with nothing says so", noRole.includes("no role that can read"), true);

// ── 7. The shape of the whole table ─────────────────────────────────────────

section("7. the table as a whole");

for (const p of ["OWNER", "SALES_EXEC", "SERVICE_ADVISOR", "RTO_AGENT", "ACCOUNTS", "TECHNICIAN", "AGENT"]) {
  console.log(`  ${p.padEnd(16)} ${String(permissionsFor(p).length).padStart(2)} permissions`);
}

// The agent's set is small and fully enumerable, which is the property that
// makes it reviewable.
console.log(`\n  AGENT holds: ${permissionsFor("AGENT").join(", ")}`);

// ── 7b. The records boundary, at the permission layer ───────────────────────
//
// The kind-level rule (an agent may write OBSERVED, never CALL) is checked by
// `verify:records`, which needs a database. This is the half that does not.

section("7b. the agent may write a record and may not close a task");

check("holds activity.write", may("AGENT", "activity.write"), true);
check("holds task.create", may("AGENT", "task.create"), true);
check("does NOT hold task.complete", may("AGENT", "task.complete"), false);
check("does NOT hold activity.retract", may("AGENT", "activity.retract"), false);
console.log(`  why not: ${whyNot("AGENT", "task.complete")}`);

// ── 7c. The document, and what the agent may not put a price on ─────────────

section("7c. the agent may notice a deal is ready and may not invoice it");

check("does NOT hold invoice.generate", may("AGENT", "invoice.generate"), false);
check("does NOT hold pricelist.set", may("AGENT", "pricelist.set"), false);
check("an owner does", may("OWNER", "invoice.generate"), true);
check("and so does accounts", may("ACCOUNTS", "invoice.generate"), true);
check("a technician does not", may("TECHNICIAN", "invoice.generate"), false);
check(
  "only an owner or a manager writes a price list",
  [may("OWNER", "pricelist.set"), may("ACCOUNTS", "pricelist.set"), may("SALES_EXEC", "pricelist.set")],
  [true, false, false],
);
console.log(`  why not: ${whyNot("AGENT", "invoice.generate")}`);

// ── 8. Nothing grants what nothing should ───────────────────────────────────

section("8. no principal holds a permission that does not exist");

const NAMED: Permission[] = [
  "deal.view", "job_card.view", "enquiry.view", "registration.view",
  "part.view", "receivable.view", "vehicle.view", "outbox.view",
  "enquiry.log_contact", "enquiry.reassign", "job_card.mark_informed",
  // OBJ-49. Handing a job card over — the thing a short-staffed workshop does
  // every morning and had no record of anywhere.
  "job_card.reassign",
  "registration.assign_agent", "registration.mark_notified", "registration.log_chase",
  "part.request_transfer", "part.raise_reorder", "receivable.log_chase",
  "receivable.mark_disputed", "vehicle.mark_offered", "vehicle.propose_transfer",
  "outbox.approve", "outbox.edit", "outbox.cancel", "outbox.send",
  "policy.set", "staff.view", "outlet.view_all",
  // OBJ-22. Adding these was a table edit and a line here — which is what
  // OBJ-21 was for. Before it, the same change touched three files and this
  // check did not exist to catch the one that was forgotten.
  "activity.view", "activity.write", "activity.retract",
  "task.view", "task.create", "task.complete",
  // OBJ-25. The first grants that put a number on a piece of paper a customer
  // keeps, and on some dealerships spend a tax-invoice number.
  "invoice.view", "invoice.generate", "pricelist.set",
];
const named = new Set<string>(NAMED);
let stray = 0;
for (const p of ["OWNER", "MANAGER", "SALES_EXEC", "SERVICE_ADVISOR", "RTO_AGENT", "ACCOUNTS", "TECHNICIAN", "PLATFORM_ADMIN", "AGENT"]) {
  for (const perm of permissionsFor(p)) {
    if (!named.has(perm)) {
      console.log(`  ✗ ${p} holds unnamed permission ${perm}`);
      stray++;
    }
  }
}
check("every granted permission is one of the named set", stray, 0);

console.log(
  failures === 0
    ? "\n\nAll checks passed. One table, same answers.\n"
    : `\n\n${failures} check(s) FAILED — behaviour moved.\n`,
);
process.exit(failures === 0 ? 0 : 1);
