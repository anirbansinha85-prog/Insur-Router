/**
 * OBJ-48's done-when, stated so it can fail.
 *
 * > *The evening figure for the whole company reconciles to the sum of its
 * > branches, and names the branch that is out.*
 *
 * Both halves are checkable and the second is the one that earns its keep.
 * "Reconciles to the sum of its branches" is an arithmetic claim, and a
 * consolidation that computed its own version of a branch's cash would fail it —
 * which is precisely the failure the overall view already taught this codebase
 * (§3 of `verify-overview`). "Names the branch that is out" is R-114 one level
 * up: head office is not told that the company is short by ₹450, it is told
 * *which till*.
 *
 * §4 is the one a tidy implementation gets wrong. **A branch that never closed
 * is not a branch that closed at zero**, and the two read identically on any
 * screen that sums and moves on. A day where four branches balanced and the
 * fifth never counted is not a clean day.
 *
 * `pnpm --filter @workspace/scripts run eod`.
 */

import {
  ownerDb,
  withWorkerScope,
  showroomsTable,
  dayClosesTable,
  moneyDocumentsTable,
  partiesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { placementOf } from "../lib/dms/org";
import { centralEndOfDay, eveningsOverPeriod } from "../lib/dms/ledger/eod";

const OWNER = 1;
const RUN_BY = "verify-eod";
const DAY = "2026-08-24";
const DAY2 = "2026-08-25";
const FINANCIER_NAME = "Verify EOD Finance Ltd";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}
const money = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log(`\nOBJ-48 — head office's evening, run by ${RUN_BY}\n`);

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
const aero = await branch("DEL-SAR-BW");
const hubP = await withWorkerScope(() => placementOf(hub.id));
const ENTITY = hubP.entity.id;
const ALL = [hub.id, janak.id, dwarka.id, okhla.id, aero.id];

console.log(`      ${hubP.entity.legalName} · ${ALL.length} branches · ${DAY} and ${DAY2}\n`);

async function tidy(): Promise<void> {
  await ownerDb
    .delete(dayClosesTable)
    .where(
      and(
        inArray(dayClosesTable.showroomId, ALL),
        inArray(dayClosesTable.closeDate, [DAY, DAY2]),
      ),
    );
  await ownerDb
    .delete(moneyDocumentsTable)
    .where(sql`${moneyDocumentsTable.documentNo} like ${`${RUN_BY}%`}`);
  await ownerDb
    .delete(partiesTable)
    .where(and(eq(partiesTable.ownerId, OWNER), eq(partiesTable.name, FINANCIER_NAME)));
}
await tidy();

/*
 * Four branches close and one deliberately does not. The figures are written
 * straight into `day_closes` rather than through `closeDay` on purpose: this
 * verifier is about the **roll-up**, and driving it through the branch close
 * would make it fail for reasons belonging to OBJ-40 - which `verify-money`
 * already covers, and which would make a failure here ambiguous.
 */
const evening: Array<{ at: number; code: string; booked: number; counted: number; reason: string }> =
  [
    { at: hub.id, code: hub.code, booked: 184_500, counted: 184_500, reason: "EXACT" },
    { at: janak.id, code: janak.code, booked: 42_000, counted: 41_550, reason: "UNEXPLAINED" },
    { at: dwarka.id, code: dwarka.code, booked: 28_750, counted: 28_750, reason: "EXACT" },
    { at: okhla.id, code: okhla.code, booked: 9_640, counted: 9_890, reason: "MISCOUNT" },
    // Aerocity does not close. That is the point of §4.
  ];

for (const e of evening) {
  await ownerDb.insert(dayClosesTable).values({
    ownerId: OWNER,
    showroomId: e.at,
    closeDate: DAY,
    bookedCash: e.booked.toFixed(2),
    countedCash: e.counted.toFixed(2),
    difference: (e.counted - e.booked).toFixed(2),
    reason: e.reason as "EXACT" | "UNEXPLAINED" | "MISCOUNT",
    reasonNote: e.reason === "MISCOUNT" ? "a hundred-rupee note counted twice" : null,
    bankReceipts: "0",
    bankPayments: "0",
  });
}

// ────────────────────────────────────────────────────────────────────────────

section("1. the company figure is the sum of the branches and nothing else");

const eod = await withWorkerScope(() =>
  centralEndOfDay({ ownerId: OWNER, entityId: ENTITY, closeDate: DAY }),
);

for (const b of eod.branches) {
  console.log(
    `      ${b.branchCode.padEnd(15)} ${b.role.padEnd(8)} ` +
      (b.closed
        ? `booked ${money(b.bookedCash).padStart(14)}  counted ${money(b.countedCash).padStart(14)}  ${b.difference === 0 ? "" : money(b.difference)}`
        : "did not close"),
  );
}

const sumBooked = eod.branches.reduce((a, b) => a + b.bookedCash, 0);
const sumCounted = eod.branches.reduce((a, b) => a + b.countedCash, 0);
const sumDiff = eod.branches.reduce((a, b) => a + b.difference, 0);

check(
  "booked cash equals the branches' booked cash",
  Math.round(eod.bookedCash * 100) === Math.round(sumBooked * 100),
  `${money(eod.bookedCash)} against ${money(sumBooked)}`,
);
check(
  "counted cash equals the branches' counted cash",
  Math.round(eod.countedCash * 100) === Math.round(sumCounted * 100),
  `${money(eod.countedCash)} against ${money(sumCounted)}`,
);
check(
  "**and the company's difference is the sum of the branches' differences**",
  Math.round(eod.difference * 100) === Math.round(sumDiff * 100),
  `${money(eod.difference)} — a consolidation that computed its own version of a branch's cash would be a second answer to a question that already has one`,
);

// ────────────────────────────────────────────────────────────────────────────

section("2. it names the branch that is out, not the amount it is out by");

for (const b of eod.outOfLine) {
  console.log(`      ${b.branchCode.padEnd(15)} ${money(b.difference).padStart(12)}  ${b.reason}`);
}
check(
  "the short till is named",
  eod.outOfLine.some((b) => b.branchCode === janak.code && b.difference === -450),
  `${janak.code} short ${money(-450)}`,
);
check(
  "the over till is named too — an excess is a finding as much as a shortfall",
  eod.outOfLine.some((b) => b.branchCode === okhla.code && b.difference === 250),
  `${okhla.code} over ${money(250)}`,
);
check(
  "and each carries the reason the branch gave, including 'nobody said why'",
  eod.outOfLine.every((b) => b.reason !== null) &&
    eod.warnings.some((w) => w.includes("nobody has said why")),
  eod.warnings.find((w) => w.includes("nobody has said why")) ?? "(not stated)",
);
check(
  "the two differences do not cancel each other out into a tidy company figure",
  eod.outOfLine.length === 2,
  `${money(-450)} and ${money(250)} net to ${money(eod.difference)}, which is why the net is not the report`,
);

// ────────────────────────────────────────────────────────────────────────────

section("3. money held for somebody else is separated from the company's own");

/*
 * The financier is created here rather than looked for. A version of this
 * section that skipped when the fixture happened to have none would pass on an
 * empty case for ever, and the threading path it exists to prove would be
 * untested from the day it broke — which is the lesson `verify:channels`
 * already paid for once.
 */
const [financier] = await ownerDb
  .insert(partiesTable)
  .values({
    ownerId: OWNER,
    entityId: ENTITY,
    kind: "FINANCIER",
    name: FINANCIER_NAME,
    state: "Delhi",
  })
  .returning({ id: partiesTable.id, name: partiesTable.name });

await ownerDb.insert(moneyDocumentsTable).values({
  ownerId: OWNER,
  showroomId: janak.id,
  direction: "RECEIPT",
  documentNo: `${RUN_BY}-RCT-1`,
  documentDate: DAY,
  partyId: financier!.id,
  mode: "BANK",
  amount: "88400.00",
  unallocated: "88400.00",
  narration: `${RUN_BY} financier payout`,
});

const withPayout = await withWorkerScope(() =>
  centralEndOfDay({ ownerId: OWNER, entityId: ENTITY, closeDate: DAY }),
);
check(
  "a financier's payout is reported as one, by who paid rather than by which account",
  withPayout.financierReceipts === 88_400,
  `${money(withPayout.financierReceipts)} from ${financier!.name}`,
);
check(
  "**and it is not added to the till**, which nobody counted it into",
  withPayout.countedCash === eod.countedCash,
  "a bank payout inside the cash figure is money somebody would go looking for in a drawer",
);
check(
  "it lands against the branch that made the sale, not at head office",
  withPayout.branches.find((b) => b.branchCode === janak.code)?.financierReceipts === 88_400,
  `${janak.code} — the customer walked into a branch, and the payout is against that sale`,
);
check(
  "and no other branch picked it up",
  withPayout.branches.filter((b) => b.financierReceipts !== 0).length === 1,
  withPayout.branches
    .filter((b) => b.financierReceipts !== 0)
    .map((b) => b.branchCode)
    .join(", "),
);

// ────────────────────────────────────────────────────────────────────────────

section("4. **a branch that never closed is an absence, not a zero**");

check(
  "the branch that did not close is named",
  eod.notClosed.some((b) => b.branchCode === aero.code),
  eod.notClosed.map((b) => b.branchCode).join(", ") || "(none)",
);
check(
  "the count says four of five, so nobody reads the total as complete",
  eod.closedCount === 4 && eod.branchCount === 5,
  `${eod.closedCount} of ${eod.branchCount} closed`,
);
check(
  "and the warning says the company figure is short by whatever was in that till",
  eod.warnings.some((w) => w.includes("not a zero, it is an absence")),
  eod.warnings.find((w) => w.includes("absence")) ?? "(not stated)",
);
check(
  "**the evening does not reconcile**, because two things have to hold and neither did",
  eod.reconciles === false,
  "every branch closed, and every close agreed — a day where four balanced and the fifth never counted is not a clean day",
);

// ── and the clean case, so the check above is not passing for free ─────────

for (const b of ALL) {
  await ownerDb.insert(dayClosesTable).values({
    ownerId: OWNER,
    showroomId: b,
    closeDate: DAY2,
    bookedCash: "12000.00",
    countedCash: "12000.00",
    difference: "0.00",
    reason: "EXACT",
    bankReceipts: "0",
    bankPayments: "0",
  });
}
const clean = await withWorkerScope(() =>
  centralEndOfDay({ ownerId: OWNER, entityId: ENTITY, closeDate: DAY2 }),
);
check(
  "a day where every branch closed and every close agreed does reconcile",
  clean.reconciles === true && clean.closedCount === 5 && clean.outOfLine.length === 0,
  `${clean.closedCount} of ${clean.branchCount} closed, ${money(clean.countedCash)} counted, nothing out`,
);

// ────────────────────────────────────────────────────────────────────────────

section("5. a pattern is a different fact from a bad afternoon");

const period = await withWorkerScope(() =>
  eveningsOverPeriod({ ownerId: OWNER, entityId: ENTITY, from: DAY, to: DAY2 }),
);
for (const b of period.byBranch) {
  console.log(
    `      ${b.branchCode.padEnd(15)} closed ${b.daysClosed} day(s), out on ${b.daysOut}, net ${money(b.netDifference)}`,
  );
}
check(
  "the branch that missed an evening shows fewer days closed than the rest",
  period.byBranch.find((b) => b.branchCode === aero.code)?.daysClosed === 1 &&
    period.byBranch.find((b) => b.branchCode === hub.code)?.daysClosed === 2,
  "one short till is a bad afternoon; the same branch short nine evenings in ten is a different fact",
);
check(
  "and the days that carried a difference are counted",
  period.daysWithAnyDifference === 1,
  `${period.daysWithAnyDifference} of ${period.days.length} day(s)`,
);

// ────────────────────────────────────────────────────────────────────────────

section("6. it reads, and it closes nothing");

const closesBefore = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(dayClosesTable)
    .where(eq(dayClosesTable.ownerId, OWNER))
)[0]!.c;
await withWorkerScope(() =>
  centralEndOfDay({ ownerId: OWNER, entityId: ENTITY, closeDate: DAY }),
);
const closesAfter = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(dayClosesTable)
    .where(eq(dayClosesTable.ownerId, OWNER))
)[0]!.c;
check(
  "consolidating writes no close of its own",
  closesBefore === closesAfter,
  `${closesBefore} closes before, ${closesAfter} after — a company-level close would post a journal nobody at a branch authorised`,
);

// ────────────────────────────────────────────────────────────────────────────

await tidy();
console.log("\n  (every day close, receipt and party this run made, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. The company's evening is the sum of its branches, the branch that is\n" +
      "out is named, and a till nobody counted is an absence rather than a zero.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
