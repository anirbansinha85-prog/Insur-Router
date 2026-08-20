/**
 * OBJ-50's done-when, stated so it can fail.
 *
 * > *A dealership can book the month's rent, and it lands in the branch's
 * > profit and loss.*
 *
 * That sentence is small and the gap behind it was not. The chart had **three
 * expense heads, two of them cost of goods sold**, and seven doors into the
 * ledger — every one of which starts from a document DDMS itself issued. So a
 * five-branch dealership's P&L was a gross-margin statement with a P&L's title,
 * and nothing could be done about it from inside the product: no route in the
 * product touched `ledger_accounts` at all.
 *
 * §5 is the check that would be missed by a tidier implementation. Booking rent
 * is easy; booking it **against a branch** is what makes it appear in that
 * branch's column, and a journal with no branch on it lands in the consolidated
 * figure and in none of the five — which is exactly the comparison an owner is
 * trying to make.
 *
 * §6 is the one that matters for trust. The trial balance still balanced
 * afterwards. An entry door that can produce an unbalanced set of books is not
 * a door, it is a hole.
 *
 * `pnpm --filter @workspace/scripts run journal`.
 */

import {
  ownerDb,
  withWorkerScope,
  showroomsTable,
  legalEntitiesTable,
  ledgerAccountsTable,
  vouchersTable,
  voucherLinesTable,
  partiesTable,
} from "@workspace/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import {
  createAccount,
  setAccountActive,
  ensureChart,
  offerStarterChart,
  chartFor,
  STARTER,
  SYSTEM_CODES,
} from "../lib/dms/ledger/accounts";
import { postJournal } from "../lib/dms/ledger/journal";
import { trialBalance, profitAndLoss } from "../lib/dms/ledger/books";
import { placementOf } from "../lib/dms/org";

const OWNER = 1;
const RUN_BY = "verify-journal";
const MARK = "verify-journal:";
const DATE = "2026-11-20";
const OWN_CODE = "5450";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}
const money = (x: number): string => `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

console.log(`\nOBJ-50 — the cost side gets a door, run by ${RUN_BY}\n`);

const [hub] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SARASWATI")))
  .limit(1);
const [janak] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SAR-JANAK")))
  .limit(1);
if (!hub || !janak) throw new Error("Fixture missing. Run db:seed-owners and db:seed-network.");

const placement = await withWorkerScope(() => placementOf(hub.id));
const ENTITY = placement.entity.id;

async function tidy(): Promise<void> {
  const mine = await ownerDb
    .select({ id: vouchersTable.id })
    .from(vouchersTable)
    .where(like(vouchersTable.narration, `${MARK}%`));
  for (const v of mine) {
    await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
    await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, v.id));
  }
  await ownerDb
    .delete(ledgerAccountsTable)
    .where(and(eq(ledgerAccountsTable.ownerId, OWNER), eq(ledgerAccountsTable.code, OWN_CODE)));
}
await tidy();

// ────────────────────────────────────────────────────────────────────────────

section("1. the chart now has a cost side");

/*
 * On the owner credential, not the worker's. §7 proves the scheduler cannot
 * raise a journal, and `ddms_worker` has no write on `ledger_accounts` either —
 * creating an account is a person's act. The fixture has to respect that rather
 * than route around it.
 */
await ensureChart(OWNER);
const offered = await offerStarterChart(OWNER);
console.log(`      offered the starter chart: ${offered.added.length} added, ${offered.alreadyThere.length} already there`);
const chart = await chartFor(OWNER);
const expenses = chart.filter((a) => a.group === "EXPENSE");
const cogs = expenses.filter((a) => a.name.startsWith("Cost of Goods Sold"));

console.log(`      ${chart.length} accounts · ${expenses.length} expense heads`);
check(
  "**there is more than cost of goods sold on the expense side**",
  expenses.length - cogs.length >= 10,
  `${expenses.length - cogs.length} operating heads beside ${cogs.length} cost-of-goods heads`,
);
for (const want of ["Rent", "Salaries & Wages", "Electricity & Water", "Interest Paid"]) {
  check(`  ${want}`, expenses.some((a) => a.name === want));
}
/*
 * Checked against the code list rather than by reading the names.
 *
 * The first version of this asserted that every expense head which is not cost
 * of goods sold is the dealership's - and failed, correctly, on `5200 Discount
 * Allowed`, which a posting rule does name and which is neither. The check was
 * wrong, not the code. Grouping accounts by what their names look like is
 * exactly the habit `tallyName` exists to let a dealership break.
 */
const starterCodes = new Set(STARTER.map((a) => a.code));
const starterHeads = chart.filter((a) => starterCodes.has(a.code));
check(
  "**the operating heads are the dealership's, not ours** — none is a system account",
  starterHeads.length === STARTER.length && starterHeads.every((a) => a.isSystem === "N"),
  `${starterHeads.length} of ${STARTER.length} present, ${starterHeads.filter((a) => a.isSystem === "N").length} of them theirs — a system account is undeletable because a rule breaks without it, and nothing names these`,
);
check(
  "every account a posting rule names is still ours",
  chart.filter((a) => SYSTEM_CODES.has(a.code)).every((a) => a.isSystem === "Y"),
  `${SYSTEM_CODES.size} named by rules, all isSystem`,
);

// ────────────────────────────────────────────────────────────────────────────

section("2. a dealership can add an account of its own");

const made = await createAccount({
  ownerId: OWNER,
  code: OWN_CODE,
  name: "Workshop Consumables",
  group: "EXPENSE",
});
check("it is created", made.ok, made.ok ? `${made.account!.code} ${made.account!.name}` : made.error!);
check("and it is not a system account", made.account?.isSystem === "N");

const dupe = await createAccount({ ownerId: OWNER, code: OWN_CODE, name: "Something else", group: "EXPENSE" });
check("the same code twice is refused", !dupe.ok, dupe.error ?? "it created a second");

const stolen = await createAccount({ ownerId: OWNER, code: "1100", name: "My Debtors", group: "ASSET" });
check(
  "**a code a posting rule names is refused**",
  !stolen.ok && (stolen.error ?? "").includes("posting rule"),
  stolen.error ?? "it took 1100",
);

const oddNumber = await createAccount({ ownerId: OWNER, code: "7777", name: "Oddly Numbered", group: "EXPENSE" });
check(
  "an off-convention code is warned about and permitted, not refused",
  oddNumber.ok && oddNumber.warnings.length > 0,
  oddNumber.warnings[0] ?? "(no warning)",
);
if (oddNumber.ok) {
  await ownerDb
    .delete(ledgerAccountsTable)
    .where(and(eq(ledgerAccountsTable.ownerId, OWNER), eq(ledgerAccountsTable.code, "7777")));
}

const retireSystem = await setAccountActive({ ownerId: OWNER, code: "1200", active: false });
check(
  "**a system account cannot be retired**",
  !retireSystem.ok,
  retireSystem.error ?? "Vehicle Stock was retired",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. what a journal refuses");

const base = { ownerId: OWNER, showroomId: hub.id, voucherDate: DATE, userId: 1 };

const noNarration = await postJournal({
  ...base,
  narration: "",
  lines: [
    { accountCode: "5300", debit: 100 },
    { accountCode: "1400", credit: 100 },
  ],
});
check("no narration", !noNarration.ok, noNarration.error ?? "posted");

const oneLine = await postJournal({ ...base, narration: `${MARK} one line`, lines: [{ accountCode: "5300", debit: 100 }] });
check("one line", !oneLine.ok, oneLine.error ?? "posted");

const unbalanced = await postJournal({
  ...base,
  narration: `${MARK} unbalanced`,
  lines: [
    { accountCode: "5300", debit: 100 },
    { accountCode: "1400", credit: 90 },
  ],
});
check(
  "**it does not balance**, and the refusal shows both totals",
  !unbalanced.ok && (unbalanced.error ?? "").includes("10.00"),
  unbalanced.error ?? "posted",
);

const bothColumns = await postJournal({
  ...base,
  narration: `${MARK} both columns`,
  lines: [
    { accountCode: "5300", debit: 100, credit: 40 },
    { accountCode: "1400", credit: 60 },
  ],
});
check("a line that is both a debit and a credit", !bothColumns.ok, bothColumns.error ?? "posted");

const negative = await postJournal({
  ...base,
  narration: `${MARK} negative`,
  lines: [
    { accountCode: "5300", debit: -100 },
    { accountCode: "1400", debit: 100 },
  ],
});
check(
  "**a negative amount** — and the refusal names the real problem",
  !negative.ok && (negative.error ?? "").includes("negative"),
  negative.error ?? "posted",
);

const unknown = await postJournal({
  ...base,
  narration: `${MARK} unknown account`,
  lines: [
    { accountCode: "9999", debit: 100 },
    { accountCode: "1400", credit: 100 },
  ],
});
check("an account that is not in the chart", !unknown.ok, unknown.error ?? "posted");

await setAccountActive({ ownerId: OWNER, code: OWN_CODE, active: false });
const retired = await postJournal({
  ...base,
  narration: `${MARK} retired account`,
  lines: [
    { accountCode: OWN_CODE, debit: 100 },
    { accountCode: "1400", credit: 100 },
  ],
});
check(
  "**a retired account** — the chart says it is closed",
  !retired.ok,
  retired.error ?? "posted",
);
await setAccountActive({ ownerId: OWNER, code: OWN_CODE, active: true });

// ────────────────────────────────────────────────────────────────────────────

section("4. a control account with nobody's name on it is warned about, not refused");

const [customer] = await ownerDb
  .select({ id: partiesTable.id, name: partiesTable.name })
  .from(partiesTable)
  .where(and(eq(partiesTable.ownerId, OWNER), eq(partiesTable.kind, "CUSTOMER")))
  .limit(1);

const orphanControl = await postJournal({
  ...base,
  narration: `${MARK} provision for doubtful debts`,
  lines: [
    { accountCode: "5900", debit: 5_000, narration: "Provision" },
    { accountCode: "1100", credit: 5_000, narration: "Against debtors generally" },
  ],
});
check(
  "it posts, because a provision is a real entry against the control account",
  orphanControl.ok,
  orphanControl.ok ? orphanControl.voucher!.voucherNo : orphanControl.error!,
);
check(
  "**and it says the debtors reconciliation will name it**",
  orphanControl.warnings.some((w) => w.includes("reconciles to no party ledger")),
  orphanControl.warnings[0] ?? "(no warning)",
);

if (customer) {
  const named = await postJournal({
    ...base,
    narration: `${MARK} write-off against a named customer`,
    lines: [
      { accountCode: "5900", debit: 1_200 },
      { accountCode: "1100", credit: 1_200, partyId: customer.id },
    ],
  });
check(
  "a control line with a party against it draws no warning",
  named.ok && named.warnings.length === 0,
  named.ok ? `against ${customer.name}` : named.error!,
);
const [line] = await ownerDb
  .select({ partyName: voucherLinesTable.partyName })
  .from(voucherLinesTable)
  .where(
    and(
      eq(voucherLinesTable.voucherId, named.voucher!.id),
      eq(voucherLinesTable.accountCode, "1100"),
    ),
  );
check(
  "and the party's name is carried onto the line, not just the id",
  line?.partyName === customer.name,
  `${line?.partyName} — a subsidiary ledger under the control account needs the name (R-110)`,
);
}

// ────────────────────────────────────────────────────────────────────────────

section("5. **the month's rent, at a branch, in that branch's P&L**");

const before = await profitAndLoss({ ownerId: OWNER, showroomId: janak.id, from: "2026-11-01", to: "2026-11-30" });

const rent = await postJournal({
  ownerId: OWNER,
  showroomId: janak.id,
  voucherDate: DATE,
  narration: `${MARK} November rent, Janakpuri`,
  lines: [
    { accountCode: "5300", debit: 60_000, narration: "Shop rent, November" },
    { accountCode: "2500", credit: 6_000, narration: "TDS 194-I at 10%" },
    { accountCode: "1500", credit: 54_000, narration: "Paid by transfer" },
  ],
  userId: 1,
});
check("rent posts", rent.ok, rent.ok ? rent.voucher!.voucherNo : rent.error!);
check(
  "it is numbered from the journal series, sequential and per financial year",
  /^\d+$/.test(rent.voucher?.voucherNo ?? "") && rent.voucher?.financialYear === "2026-27",
  `${rent.voucher?.voucherNo} in ${rent.voucher?.financialYear} — a bare number rather than JV/2026-27/0001, which is what every kind in these books uses today and is worth revisiting before a real audit`,
);

const after = await profitAndLoss({ ownerId: OWNER, showroomId: janak.id, from: "2026-11-01", to: "2026-11-30" });
check(
  "**Janakpuri's expenses went up by exactly the rent**",
  Math.round((after.totalExpenses - before.totalExpenses) * 100) === 60_000_00,
  `${money(before.totalExpenses)} → ${money(after.totalExpenses)}`,
);
check(
  "and its profit fell by the same",
  Math.round((before.profit - after.profit) * 100) === 60_000_00,
  `${money(before.profit)} → ${money(after.profit)} — a branch is a profit centre, and rent booked with no branch on it appears in none of the five columns`,
);

const hubPandl = await profitAndLoss({ ownerId: OWNER, showroomId: hub.id, from: "2026-11-01", to: "2026-11-30" });
check(
  "the hub's figures did not move — the rent went to one branch only",
  !hubPandl.expenses.some((r) => r.accountCode === "5300" && Math.abs(r.amount) >= 60_000),
  "Naraina pays its own rent, and Janakpuri's is not it",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. the books still balance");

const tb = await trialBalance({ ownerId: OWNER, entityId: ENTITY, from: "2026-04-01", to: "2027-03-31" });
console.log(
  `      debit ${money(tb.totalDebit)} · credit ${money(tb.totalCredit)} · ${tb.balances ? "balances" : "DOES NOT BALANCE"}`,
);
check(
  "**the trial balance balances after everything above**",
  tb.balances,
  "an entry door that can produce an unbalanced set of books is not a door, it is a hole",
);
check(
  "and Rent is on it",
  tb.rows.some((r) => r.accountCode === "5300" && r.closingDebit > 0),
  tb.rows.find((r) => r.accountCode === "5300")
    ? `${money(tb.rows.find((r) => r.accountCode === "5300")!.closingDebit)} on 5300`
    : "(not on the trial balance)",
);

// ────────────────────────────────────────────────────────────────────────────

section("7. nothing unattended raises a journal");

let denied = "";
try {
  await withWorkerScope(async () => {
    const r = await postJournal({
      ownerId: OWNER,
      showroomId: hub.id,
      voucherDate: DATE,
      narration: `${MARK} the scheduler should not be here`,
      lines: [
        { accountCode: "5300", debit: 1 },
        { accountCode: "1400", credit: 1 },
      ],
    });
    denied = r.ok ? "it posted" : (r.error ?? "");
  });
} catch (e) {
  const chain: string[] = [];
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    chain.push(String((err as Error).message ?? err));
  }
  denied = chain.join(" | ");
}
check(
  "the worker credential is refused by the database",
  denied.includes("permission denied"),
  denied.split(" | ").find((m) => m.includes("permission denied")) ?? denied,
);

// ────────────────────────────────────────────────────────────────────────────

await tidy();
console.log("\n  (every journal and the account this run created, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. A dealership can add its own accounts and book what it costs to open the\n" +
      "doors, against the branch that paid it, and the trial balance still balances.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
