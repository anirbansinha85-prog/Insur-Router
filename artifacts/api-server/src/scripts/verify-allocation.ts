/**
 * OBJ-47's done-when, stated so it can fail.
 *
 * > *One morning's allocation to three branches is one decision, not seven
 * > challans.*
 *
 * The claim has two halves and the second one is the load-bearing half. Making
 * the allocation **one decision** is easy and would be worth very little on its
 * own; what makes it worth building is that the one decision still produces the
 * right documents — a challan per destination, each carrying one consignor and
 * one consignee, because that is what a delivery challan is. A design that
 * merged three destinations onto one document would be tidier on a screen and
 * would be a document nobody could present at a checkpoint.
 *
 * §5 is the one that matters most: **a plan cannot commit itself.** Every other
 * check here protects the dealership from a bad allocation. That one is R-49
 * written as control flow — the product proposes and a person authorises — and
 * it is the difference between a morning routine and an automation somebody
 * discovers after the van has gone.
 *
 * `pnpm --filter @workspace/scripts run allocation`.
 */

import {
  ownerDb,
  withWorkerScope,
  showroomsTable,
  showroomDmsAccountsTable,
  dmsVehicleStockTable,
  saleDocumentsTable,
  stockMovesTable,
  stockMoveLinesTable,
  chassisEventsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { placementOf } from "../lib/dms/org";
import { planAllocation, commitAllocation } from "../lib/dms/ledger/allocation";

const OWNER = 1;
const RUN_BY = "verify-allocation";
const MODEL = "Verify Allocation Special";
const PLAN_DATE = "2026-08-20";
/** Six in the yard, and the fixture is built so that six is not enough. */
const YARD = ["VA-YARD-1", "VA-YARD-2", "VA-YARD-3", "VA-YARD-4", "VA-YARD-5", "VA-YARD-6"];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

console.log(`\nOBJ-47 — the morning allocation, run by ${RUN_BY}\n`);

// ── this file's own leftovers, keyed on its own constants ──────────────────
async function tidy(): Promise<void> {
  const mine = await ownerDb
    .select({ id: stockMovesTable.id })
    .from(stockMovesTable)
    .where(sql`${stockMovesTable.narration} like ${`Morning allocation ${PLAN_DATE}%`}`);
  for (const m of mine) {
    await ownerDb.delete(stockMoveLinesTable).where(eq(stockMoveLinesTable.stockMoveId, m.id));
    await ownerDb.delete(stockMovesTable).where(eq(stockMovesTable.id, m.id));
  }
  await ownerDb.delete(chassisEventsTable).where(inArray(chassisEventsTable.chassisNo, YARD));
  await ownerDb.delete(dmsVehicleStockTable).where(inArray(dmsVehicleStockTable.chassisNo, YARD));
  await ownerDb
    .delete(saleDocumentsTable)
    .where(sql`${saleDocumentsTable.reference} like ${`${RUN_BY}%`}`);
}
await tidy();

const branch = async (code: string) => {
  const [b] = await ownerDb
    .select()
    .from(showroomsTable)
    .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, code)))
    .limit(1);
  if (!b) throw new Error(`Fixture missing: ${code}. Run db:migrate-org and db:seed-network.`);
  return b;
};

const hub = await branch("DEL-SARASWATI");
const janak = await branch("DEL-SAR-JANAK");
const dwarka = await branch("DEL-SAR-DWK");
const okhla = await branch("DEL-SAR-OKHLA");

const hubP = await withWorkerScope(() => placementOf(hub.id));
console.log(
  `      ${hubP.entity.legalName} · ${hubP.registration.gstin}\n` +
    `      ${hub.code} (HUB) → ${janak.code}, ${dwarka.code} · ${okhla.code} is a workshop\n`,
);

const [dealer] = await ownerDb
  .select({ code: showroomDmsAccountsTable.dealerCode })
  .from(showroomDmsAccountsTable)
  .where(eq(showroomDmsAccountsTable.showroomId, hub.id))
  .limit(1);

/*
 * Six machines in the yard, received on six different days, so "oldest first"
 * is a claim with an answer rather than a tie.
 */
const COST = 71_400;
for (let i = 0; i < YARD.length; i++) {
  await ownerDb.insert(dmsVehicleStockTable).values({
    showroomId: hub.id,
    dealerCode: dealer?.code ?? "HMC-DL-0417",
    chassisNo: YARD[i]!,
    modelCode: "VA-SPECIAL",
    modelDescription: MODEL,
    status: "IN_STOCK",
    costAmount: String(COST),
    receivedDate: `2026-06-${String(10 + i).padStart(2, "0")}`,
    raw: { chassisNo: YARD[i], source: RUN_BY },
    rawHash: `${RUN_BY}-${YARD[i]}`,
  });
}

/*
 * Four customers have booked and nobody has picked a machine for any of them:
 * three at Janakpuri, one at Dwarka. Quotations with no chassis on them, which
 * is exactly what an open booking is.
 */
const bookings: Array<{ at: number; who: string }> = [
  { at: janak.id, who: "Booking A" },
  { at: janak.id, who: "Booking B" },
  { at: janak.id, who: "Booking C" },
  { at: dwarka.id, who: "Booking D" },
];
for (let i = 0; i < bookings.length; i++) {
  const b = bookings[i]!;
  await ownerDb.insert(saleDocumentsTable).values({
    ownerId: OWNER,
    showroomId: b.at,
    kind: "QUOTATION",
    reference: `${RUN_BY}-Q${i + 1}`,
    documentDate: "2026-08-18",
    factsOrigin: "FORM",
    dealId: `${RUN_BY}-DEAL-${i + 1}`,
    customerName: b.who,
    modelDescription: MODEL,
    exShowroomAmount: "84000.00",
    taxableAmount: "71186.44",
    gstRatePct: "18",
    totalAmount: "84000.00",
    status: "ISSUED",
  });
}

// ────────────────────────────────────────────────────────────────────────────

section("1. the plan reads demand from bookings, and says how it got each figure");

const plan = await withWorkerScope(() =>
  planAllocation({
    ownerId: OWNER,
    entityId: hubP.entity.id,
    hubShowroomId: hub.id,
    planDate: PLAN_DATE,
  }),
);

for (const d of plan.demand.filter((x) => x.modelDescription === MODEL)) {
  console.log(
    `      ${d.branchCode.padEnd(15)} ${d.modelDescription.padEnd(26)} ` +
      `booked ${d.committed} · on the floor ${d.onFloor} · keeps ${d.floor} · wants ${d.want}`,
  );
}

const janakWant = plan.demand.find(
  (d) => d.showroomId === janak.id && d.modelDescription === MODEL,
);
const dwarkaWant = plan.demand.find(
  (d) => d.showroomId === dwarka.id && d.modelDescription === MODEL,
);
check(
  "three bookings at Janakpuri are counted as three",
  janakWant?.committed === 3,
  `committed ${janakWant?.committed ?? "(no row)"}`,
);
check(
  "and the display floor is added on top of them, not instead of them",
  janakWant !== undefined && janakWant.want === janakWant.committed + janakWant.floor,
  `wants ${janakWant?.want} = ${janakWant?.committed} booked + ${janakWant?.floor} on the floor`,
);
check(
  "one booking at Dwarka is counted as one — demand is per branch, not per company",
  dwarkaWant?.committed === 1,
  `committed ${dwarkaWant?.committed ?? "(no row)"}`,
);
check(
  "the plan prints the numbers it was built on",
  plan.usedNumbers.displayFloor >= 0 && plan.usedNumbers.maxPerBranch > 0,
  `floor ${plan.usedNumbers.displayFloor}, ceiling ${plan.usedNumbers.maxPerBranch} per branch per morning`,
);

// ────────────────────────────────────────────────────────────────────────────

section("2. **nothing is allocated to a workshop**, decided by role and not by name");

check(
  "Okhla gets nothing",
  !plan.lines.some((l) => l.showroomId === okhla.id),
  "a motorcycle in a workshop is a motorcycle somebody moves out of the way",
);
check(
  "and it is said out loud rather than silently skipped",
  plan.warnings.some((w) => w.includes("SERVICE")),
  plan.warnings.find((w) => w.includes("SERVICE")) ?? "(no warning)",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. oldest first, and every line says why it is on the plan");

const mineLines = plan.lines.filter((l) => l.modelDescription === MODEL);
for (const l of mineLines) {
  console.log(
    `      ${l.branchCode.padEnd(15)} ${l.chassisNo.padEnd(12)} ${String(l.daysInYard).padStart(3)}d  ${l.because}`,
  );
}
check(
  "the machine that has stood longest is the first one proposed",
  mineLines[0]?.chassisNo === YARD[0],
  `${mineLines[0]?.chassisNo} at ${mineLines[0]?.daysInYard} days — ageing stock is stock the dealership is paying interest on`,
);
check(
  "the proposal is in descending age order",
  mineLines.every((l, i) => i === 0 || (l.daysInYard ?? 0) <= (mineLines[i - 1]!.daysInYard ?? 0)),
  mineLines.map((l) => l.daysInYard).join(" ≥ "),
);
check(
  "**every line carries the sentence that made it**",
  mineLines.length > 0 && mineLines.every((l) => l.because.length > 20),
  "an instruction with no reason behind it cannot be overruled on the evidence",
);
check(
  "a customer who has booked outranks an empty spot on a plinth",
  mineLines.filter((l) => l.because.includes("booked")).length === 4,
  `${mineLines.filter((l) => l.because.includes("booked")).length} lines serve a booking, before any line serves a floor`,
);

// ────────────────────────────────────────────────────────────────────────────

section("4. the plan writes nothing, and running it twice says the same thing");

const movesBefore = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(stockMovesTable)
    .where(eq(stockMovesTable.ownerId, OWNER))
)[0]!.c;

const again = await withWorkerScope(() =>
  planAllocation({
    ownerId: OWNER,
    entityId: hubP.entity.id,
    hubShowroomId: hub.id,
    planDate: PLAN_DATE,
  }),
);
const movesAfter = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(stockMovesTable)
    .where(eq(stockMovesTable.ownerId, OWNER))
)[0]!.c;

check(
  "planning raised no document",
  movesBefore === movesAfter,
  `${movesBefore} challans before, ${movesAfter} after — it can be run, looked at and ignored`,
);
check(
  "and the second run proposes exactly the same machines",
  JSON.stringify(again.lines.map((l) => [l.branchCode, l.chassisNo])) ===
    JSON.stringify(plan.lines.map((l) => [l.branchCode, l.chassisNo])),
  "a plan whose rows move between runs is one nobody can compare to the one they read ten minutes ago",
);

// ────────────────────────────────────────────────────────────────────────────

section("5. **a plan cannot commit itself**");

const unapproved = await withWorkerScope(() =>
  commitAllocation({ plan, approvedByUserId: null, approvedByName: "nobody" }),
);
check(
  "committing with nobody's name against it is refused",
  !unapproved.ok && unapproved.moves.length === 0,
  unapproved.error ?? "it despatched",
);
check(
  "and the refusal says what a plan is, rather than naming a missing parameter",
  (unapproved.error ?? "").includes("proposal"),
  unapproved.error ?? "",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. one decision, one challan per destination");

const committed = await commitAllocation({
  plan,
  approvedByUserId: 1,
  approvedByName: RUN_BY,
});
check("the approved plan goes out", committed.ok, committed.failures.map((f) => f.error).join("; "));

const destinations = new Set(plan.lines.map((l) => l.showroomId));
check(
  "as many challans as there are destinations, and no more",
  committed.moves.length === destinations.size,
  `${destinations.size} branch(es) → ${committed.moves.length} challan(s): ${committed.moves.map((m) => m.challanNo).join(", ")}`,
);
check(
  "each one names one consignor and one consignee",
  committed.moves.every((m) => m.fromShowroomId === hub.id) &&
    new Set(committed.moves.map((m) => m.toShowroomId)).size === committed.moves.length,
  "a challan carrying two destinations is not a document anybody can present at a checkpoint",
);
check(
  "every one of them is out of the yard rather than sitting in draft",
  committed.moves.every((m) => m.status === "IN_TRANSIT"),
  "a challan left in draft is a machine the branch is expecting and the yard still thinks it has",
);
check(
  "**and not one of them posted a voucher** — same GSTIN, still not a supply",
  committed.moves.every((m) => m.isSupply === "N" && m.voucherId === null),
  committed.moves.map((m) => `${m.challanNo} ${m.isSupply}`).join(", "),
);
check(
  "the approver's name is on the document",
  committed.moves.every((m) => (m.narration ?? "").includes(RUN_BY)),
  committed.moves[0]?.narration ?? "",
);

// ────────────────────────────────────────────────────────────────────────────

section("7. the second run does not propose what the first one sent");

const afterCommit = await withWorkerScope(() =>
  planAllocation({
    ownerId: OWNER,
    entityId: hubP.entity.id,
    hubShowroomId: hub.id,
    planDate: PLAN_DATE,
  }),
);
const sent = new Set(plan.lines.map((l) => l.chassisNo));
check(
  "a machine already on an open challan is out of the yard for planning purposes",
  !afterCommit.lines.some((l) => sent.has(l.chassisNo)),
  `${afterCommit.lines.length} line(s) proposed now, none of them among the ${sent.size} already on a van`,
);

// ────────────────────────────────────────────────────────────────────────────

section("8. what the yard cannot supply is named, not quietly dropped");

const short = afterCommit.shortfalls.filter((s) => s.modelDescription === MODEL);
for (const s of short) {
  console.log(`      ${s.branchCode.padEnd(15)} wanted ${s.wanted}, got ${s.allocated} — ${s.note}`);
}
check(
  "a booking with no machine behind it is reported as an order to place",
  short.length === 0 || short.some((s) => s.note.includes("order to place")),
  short.map((s) => `${s.branchCode} ${s.modelDescription}`).join(", ") || "(the yard covered everything)",
);
check(
  "and a shortfall names the branch and the model rather than a count",
  short.every((s) => s.branchCode.length > 0 && s.modelDescription.length > 0),
  "R-114 — a variance figure is an afternoon in a spreadsheet",
);

// ────────────────────────────────────────────────────────────────────────────

await tidy();
console.log("\n  (every challan, plan document, mirror row and booking this run made, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. The morning is one decision, the documents are as many as the law\n" +
      "requires, and nothing goes out without somebody's name against it.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
