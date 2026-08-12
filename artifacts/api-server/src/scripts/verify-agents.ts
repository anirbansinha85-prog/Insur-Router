/**
 * OBJ-29's done-when, stated so it can fail.
 *
 * > *A second agent is a principal and a set of grants. It inherits every
 * > refusal without one being re-written, stands on its own ladder, cannot do
 * > the first agent's job, and the first agent is unchanged by its arrival.*
 *
 * The last clause is the one this file exists for. It is easy to add a second
 * agent by widening the first — the diff is smaller and the outcome is worse,
 * because the ladder would then judge two unrelated acts on one count and a
 * dealership that trusts one and distrusts the other has no way to say so.
 *
 * ## Why most of it needs no database
 *
 * The claim is about the permission table, and the permission table is a pure
 * function. Sections 1 to 4 run with no connection at all, which is the same
 * property `verify:permissions` has and for the same reason: a check that needs
 * a database to answer *may this principal do that* is a check that has quietly
 * moved the answer somewhere else.
 *
 * `pnpm run verify:agents`.
 */

import { may, whyNot, permissionsFor, PERMISSION_FOR_ACTION, type RegistryActionId } from "../lib/dms/permissions";
import { AGENT_ACTIONS, CLOSED_TO_THE_AGENT } from "../lib/dms/agent";
import {
  CLOSED_TO_THE_STOCK_AGENT,
  STOCK_AGENT_ACTIONS,
  isStockAgentAction,
  suggestStockMoves,
} from "../lib/dms/stock-agent";
import { ceilingFor } from "../lib/dms/autonomy";
import type { QueueItem } from "../lib/dms/queue";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

console.log("\nOBJ-29 — a second agent, and what it cost");

// ═════════════════════════════════════════════════════════════════════════
section("1. It is a principal with grants, and nothing more");

check(
  "the stock agent holds the two transfer permissions",
  may("STOCK_AGENT", "part.request_transfer") && may("STOCK_AGENT", "vehicle.propose_transfer"),
  permissionsFor("STOCK_AGENT").join(", "),
);
check(
  "which the first agent still does not",
  !may("AGENT", "part.request_transfer") && !may("AGENT", "vehicle.propose_transfer"),
  "widening AGENT would have been the smaller diff and the worse design",
);
check(
  "and it holds nothing that asserts a person did something",
  !may("STOCK_AGENT", "enquiry.log_contact") &&
    !may("STOCK_AGENT", "job_card.mark_informed") &&
    !may("STOCK_AGENT", "registration.log_chase") &&
    !may("STOCK_AGENT", "receivable.log_chase") &&
    !may("STOCK_AGENT", "vehicle.mark_offered"),
  "a model cannot make a phone call, and that does not become less true for a different model",
);
check(
  "nor anything that reaches a customer or the dealership's own numbers",
  !may("STOCK_AGENT", "invoice.generate") &&
    !may("STOCK_AGENT", "policy.set") &&
    !may("STOCK_AGENT", "pricelist.set") &&
    !may("STOCK_AGENT", "outbox.send"),
  "an agent that could widen its own thresholds is an agent with no ceiling",
);

// ═════════════════════════════════════════════════════════════════════════
section("2. The two agents cannot do each other's work");

check(
  "the stock agent may not route people",
  !may("STOCK_AGENT", "enquiry.reassign") && !may("STOCK_AGENT", "registration.assign_agent"),
  "two agents that can do each other's work are one agent with a confusing name",
);
check(
  "and the assignment agent may not move stock",
  !may("AGENT", "part.request_transfer"),
  "so the ladder judges each on its own evidence",
);

const overlap = STOCK_AGENT_ACTIONS.filter((a) => (AGENT_ACTIONS as readonly string[]).includes(a));
check(
  "their registry actions do not overlap at all",
  overlap.length === 0,
  `stock: ${STOCK_AGENT_ACTIONS.join(", ")} · assignment: ${AGENT_ACTIONS.join(", ")}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("3. Every refusal was inherited, not re-written");

/*
 * The claim R-95 actually made, and the only way to test it is to compare the
 * sentences. Two agents refused the same act for the same reason must get the
 * same words — the moment they diverge, somebody has written a second set of
 * reasons and the two will drift apart.
 */
const shared = Object.keys(CLOSED_TO_THE_STOCK_AGENT).filter(
  (id) => id in CLOSED_TO_THE_AGENT,
);
const differing = shared.filter(
  (id) =>
    CLOSED_TO_THE_STOCK_AGENT[id] !== CLOSED_TO_THE_AGENT[id] &&
    // The two that legitimately differ: refused because they belong to the
    // other agent, not because the act is illegitimate. `VEHICLE_MARK_OFFERED`
    // was exempted here too until the reasons were genuinely shared rather than
    // rewritten — a stale exemption is how a check quietly stops checking.
    id !== "ENQUIRY_REASSIGN" &&
    id !== "REGISTRATION_ASSIGN_AGENT",
);
check(
  "the shared refusals say the same thing to both agents",
  differing.length === 0,
  differing.join(", ") || `${shared.length} refusals compared, ${shared.length - differing.length} identical`,
);
check(
  "and the two that differ differ for a stated reason",
  CLOSED_TO_THE_STOCK_AGENT.ENQUIRY_REASSIGN?.includes("the other agent's job") === true,
  CLOSED_TO_THE_STOCK_AGENT.ENQUIRY_REASSIGN ?? "(no reason)",
);
check(
  "no refusal is a bare sentence with nothing in it",
  Object.values(CLOSED_TO_THE_STOCK_AGENT).every((r) => r.length > 40),
  `${Object.keys(CLOSED_TO_THE_STOCK_AGENT).length} refusals, shortest ${Math.min(...Object.values(CLOSED_TO_THE_STOCK_AGENT).map((r) => r.length))} characters`,
);

/*
 * The refusals come out of the table rather than out of a list beside it.
 *
 * Checked by asking `whyNot` directly and comparing: if the exported constant
 * ever stopped being assembled from the table, this is what would catch it.
 */
const drifted = (Object.keys(PERMISSION_FOR_ACTION) as RegistryActionId[])
  .filter((id) => !may("STOCK_AGENT", PERMISSION_FOR_ACTION[id]))
  .filter((id) => CLOSED_TO_THE_STOCK_AGENT[id] !== whyNot("STOCK_AGENT", PERMISSION_FOR_ACTION[id]));
check(
  "and the exported list is the table, not a copy of it",
  drifted.length === 0,
  drifted.join(", ") || "assembled on every import",
);

// ═════════════════════════════════════════════════════════════════════════
section("4. The ladder is the same function with a different principal");

const stockCeiling = ceilingFor("PART_REQUEST_TRANSFER", "STOCK_AGENT");
const agentCeiling = ceilingFor("PART_REQUEST_TRANSFER", "AGENT");

check(
  "the same action tops out differently for the two agents",
  stockCeiling.ceiling === "AUTOMATIC" && agentCeiling.ceiling === "PREFILLED",
  `stock: ${stockCeiling.ceiling} · assignment: ${agentCeiling.ceiling}`,
);
check(
  "and the capped one carries the permission table's own sentence",
  (agentCeiling.reason ?? "").includes("not the band this agent is pointed at"),
  agentCeiling.reason ?? "(none)",
);
check(
  "the assignment agent's own action is unchanged by any of this",
  ceilingFor("ENQUIRY_REASSIGN").ceiling === "AUTOMATIC" &&
    ceilingFor("ENQUIRY_REASSIGN", "STOCK_AGENT").ceiling === "PREFILLED",
  "defaulted to AGENT, so four existing call sites needed no edit",
);
check(
  "and the floor still holds for both",
  ceilingFor("JOB_CARD_MARK_INFORMED", "AGENT").ceiling === "PREFILLED" &&
    ceilingFor("JOB_CARD_MARK_INFORMED", "STOCK_AGENT").ceiling === "PREFILLED",
  "no amount of evidence promotes an act that asserts a person did something",
);

// ═════════════════════════════════════════════════════════════════════════
section("5. It proposes what the queue already worked out");

/*
 * The suggestion reads the row's own control rather than re-deriving which
 * branch holds the part. A second opinion about that would be a second answer
 * to a question the spares classifier already answers, and the two would drift.
 */
const item = {
  module: "PART",
  recordKey: "HR-BRK-SHOE-R",
  showroomId: 1,
  state: "AVAILABLE_ELSEWHERE",
  title: "Brake shoe, rear",
  waitingDays: 4,
  actions: [
    { action: "PART_REQUEST_TRANSFER", label: "Request from ROH-01", done: false },
    { action: "PART_RAISE_REORDER", label: "Mark reorder raised", done: false },
  ],
} as unknown as QueueItem;

const suggested = suggestStockMoves([item]);
const s = suggested.get("1:HR-BRK-SHOE-R");

check("it proposed the transfer", s?.action === "PART_REQUEST_TRANSFER", s?.fromLabel ?? "(none)");
check(
  "quoting the branch the classifier named, not one it looked up itself",
  s?.reason.includes("ROH-01") === true,
  s?.reason ?? "",
);
check(
  "and it says how long somebody has been waiting",
  s?.reason.includes("4 days") === true,
  "an instruction with no reason behind it is one nobody can overrule on the evidence",
);

const done = suggestStockMoves([
  { ...item, actions: [{ action: "PART_REQUEST_TRANSFER", label: "Request from ROH-01", done: true }] } as unknown as QueueItem,
]);
check(
  "a transfer already requested is not proposed again",
  done.size === 0,
  "the row's own `done` is the answer; asking twice is how a branch gets two vans",
);

const notOurs = suggestStockMoves([
  { ...item, module: "ENQUIRY" } as unknown as QueueItem,
]);
check(
  "and it does not touch a module it has no grant for",
  notOurs.size === 0,
  "one agent, one job",
);

check(
  "the action it proposes is one the table says it may call",
  isStockAgentAction("PART_REQUEST_TRANSFER") && !isStockAgentAction("ENQUIRY_REASSIGN"),
  "asked of the permission table, not of a list that can disagree with it",
);

// ═════════════════════════════════════════════════════════════════════════
section("6. What the second agent cost");

/*
 * R-95's claim, measured. Not a poetic summary — the two numbers below are the
 * whole of the permission-model diff, and if a third agent ever costs more than
 * this, something has been built in the wrong place.
 */
console.log(
  `      One principal, ${permissionsFor("STOCK_AGENT").length} grants, ` +
    `${Object.keys(CLOSED_TO_THE_STOCK_AGENT).length} refusals — of which ` +
    `${shared.length - differing.length} came from the first agent unchanged.`,
);
check(
  "`agent.ts` did not change: the first agent still holds exactly its two actions",
  AGENT_ACTIONS.length === 2 &&
    (AGENT_ACTIONS as readonly string[]).includes("ENQUIRY_REASSIGN") &&
    (AGENT_ACTIONS as readonly string[]).includes("REGISTRATION_ASSIGN_AGENT"),
  AGENT_ACTIONS.join(", "),
);

console.log(
  failures === 0
    ? "\nAll checks passed. A principal and a set of grants, and the first agent never noticed.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
