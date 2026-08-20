/**
 * OBJ-51's done-when, stated so it can fail.
 *
 * > *The financier is the creditor, and what the floor costs is on the profit
 * > and loss.*
 *
 * Two defects and they differ in kind. The first is a **misfiled liability**:
 * `postPurchaseInvoice` credits Sundry Creditors against the supplier, always,
 * so on a floor-plan purchase the books show fifty-seven lakh owed to a company
 * the financier has already paid, and the party who can call the money in is
 * invisible. The second is a **missing cost**: the interest was calculated to
 * the rupee, put on the Inventory screen, and posted nowhere.
 *
 * §2 is the check that matters most and is the one a tidy implementation gets
 * wrong. A monthly accrual must charge **the month**, not everything accrued to
 * date — otherwise every run re-charges every earlier month and the cost triples
 * by March. And running the same month twice must be refused at the database,
 * because a doubled interest charge is exactly the size of error nobody spots.
 *
 * §4 is the one that keeps two screens honest. The Inventory screen and the
 * ledger have to be quoting the same arithmetic, or a dealership told ₹68,980 on
 * one page and something else in its own books stops believing both.
 *
 * `pnpm --filter @workspace/scripts run floorplan`.
 */

import {
  ownerDb,
  withWorkerScope,
  showroomsTable,
  partiesTable,
  purchaseInvoicesTable,
  purchaseInvoiceLinesTable,
  interestAccrualsTable,
  vouchersTable,
  voucherLinesTable,
  dmsVehicleStockTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { placementOf } from "../lib/dms/org";
import { ensureChart } from "../lib/dms/ledger/accounts";
import { createPurchaseInvoice, postPurchaseInvoice } from "../lib/dms/ledger/purchase";
import {
  floorPlanPosition,
  recordDrawdown,
  accrueFloorPlanInterest,
  FLOOR_PLAN,
  FLOOR_PLAN_INTEREST,
} from "../lib/dms/ledger/floorplan";
import { buildInventoryWorklist } from "../lib/dms/inventory-worklist";
import { profitAndLoss, trialBalance } from "../lib/dms/ledger/books";

const OWNER = 1;
const RUN_BY = "verify-floorplan";
const MARK = "verify-floorplan:";
const CHASSIS = ["VFP-0001", "VFP-0002"];
const SUPPLIER_INV = "VFP/HMC/9001";
const FINANCIER = "Verify Floorplan Finance Ltd";
const PERIOD = "2026-10";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}
const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const money = (x: number): string => `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

console.log(`\nOBJ-51 — the floor has a creditor and a cost, run by ${RUN_BY}\n`);

const [branch] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SAR-DWK")))
  .limit(1);
if (!branch) throw new Error("Fixture missing. Run db:seed-network.");
const placement = await withWorkerScope(() => placementOf(branch.id));

const [account] = await ownerDb
  .select({ code: showroomDmsAccountsTable.dealerCode })
  .from(showroomDmsAccountsTable)
  .limit(1);
const DEALER = account?.code ?? "HMC-DL-0417";

async function tidy(): Promise<void> {
  const mine = await ownerDb
    .select({ id: vouchersTable.id })
    .from(vouchersTable)
    .where(like(vouchersTable.narration, `%${MARK}%`));
  const drawdowns = await ownerDb
    .select({ id: vouchersTable.id })
    .from(vouchersTable)
    .where(like(vouchersTable.narration, `%${SUPPLIER_INV}%`));
  const accrued = await ownerDb
    .select({ voucherId: interestAccrualsTable.voucherId })
    .from(interestAccrualsTable)
    .where(eq(interestAccrualsTable.showroomId, branch.id));

  await ownerDb
    .delete(interestAccrualsTable)
    .where(eq(interestAccrualsTable.showroomId, branch.id));

  const ids = [
    ...mine.map((v) => v.id),
    ...drawdowns.map((v) => v.id),
    ...accrued.map((a) => a.voucherId).filter((x): x is number => x !== null),
  ];
  for (const id of ids) {
    await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, id));
    await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, id));
  }

  const pis = await ownerDb
    .select({ id: purchaseInvoicesTable.id })
    .from(purchaseInvoicesTable)
    .where(eq(purchaseInvoicesTable.supplierInvoiceNo, SUPPLIER_INV));
  for (const pi of pis) {
    await ownerDb
      .delete(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.purchaseInvoiceId, pi.id));
    await ownerDb.delete(purchaseInvoicesTable).where(eq(purchaseInvoicesTable.id, pi.id));
  }
  await ownerDb.delete(dmsVehicleStockTable).where(inArray(dmsVehicleStockTable.chassisNo, CHASSIS));
  await ownerDb
    .delete(partiesTable)
    .where(and(eq(partiesTable.ownerId, OWNER), eq(partiesTable.name, FINANCIER)));
}
await tidy();
await ensureChart(OWNER);

/*
 * Two machines, financed, on the floor from the first of October. Round figures
 * so the expected interest is arithmetic anybody can check by hand rather than
 * a number this file computes and then asserts against itself.
 *
 *   1,00,000 at 12%  =  ₹32.876712 a day  =  ₹1,019.18 over 31 days
 *   × 2 machines     =  ₹2,038.36 for October
 */
const COST = 100_000;
const RATE = 12;
for (const c of CHASSIS) {
  await ownerDb.insert(dmsVehicleStockTable).values({
    showroomId: branch.id,
    dealerCode: DEALER,
    chassisNo: c,
    modelCode: "VFP-MODEL",
    modelDescription: "Verify Floorplan Special",
    status: "IN_STOCK",
    costAmount: String(COST),
    isFinanced: "Y",
    interestRatePct: String(RATE),
    receivedDate: "2026-10-01",
    raw: { chassisNo: c, source: RUN_BY },
    rawHash: `${RUN_BY}-${c}`,
  });
}

// ────────────────────────────────────────────────────────────────────────────

section("1. what the floor costs, unit by unit");

const pos = await withWorkerScope(() =>
  floorPlanPosition({ ownerId: OWNER, showroomId: branch.id, asOf: "2026-10-31" }),
);
for (const u of pos.units) {
  console.log(
    `      ${u.chassisNo}  ${u.branchCode.padEnd(14)} ${money(u.costAmount)} at ${u.interestRatePct}% · ${u.days}d · ${money(u.accrued)}`,
  );
}
check(
  "both machines are on it",
  pos.unitCount === 2 && pos.costOnFloor === 200_000,
  `${pos.unitCount} units, ${money(pos.costOnFloor)} at cost`,
);
check(
  "the daily cost is the rate on the cost, and nothing cleverer",
  Math.abs(pos.interestPerDay - (2 * COST * (RATE / 100)) / 365) < 0.02,
  `${money(pos.interestPerDay)} a day against ${money((2 * COST * (RATE / 100)) / 365)} by hand`,
);
check(
  "**and interest to date is that times the days on the floor**",
  Math.abs(pos.interestToDate - ((2 * COST * (RATE / 100)) / 365) * 30) < 0.05,
  `${money(pos.interestToDate)} over 30 days`,
);

const sold = await withWorkerScope(() =>
  floorPlanPosition({ ownerId: OWNER, showroomId: branch.id, asOf: "2026-10-31" }),
);
await ownerDb
  .update(dmsVehicleStockTable)
  .set({ invoicedDate: "2026-10-15" })
  .where(eq(dmsVehicleStockTable.chassisNo, CHASSIS[0]!));
const afterSale = await withWorkerScope(() =>
  floorPlanPosition({ ownerId: OWNER, showroomId: branch.id, asOf: "2026-10-31" }),
);
check(
  "**a machine that sold stops costing interest**",
  afterSale.unitCount === sold.unitCount - 1,
  `${sold.unitCount} → ${afterSale.unitCount} — a report that kept charging it would send somebody to discount a bike that has gone`,
);
await ownerDb
  .update(dmsVehicleStockTable)
  .set({ invoicedDate: null })
  .where(eq(dmsVehicleStockTable.chassisNo, CHASSIS[0]!));

// ────────────────────────────────────────────────────────────────────────────

section("2. **the accrual charges the month, not everything to date**");

const octoberBefore = await withWorkerScope(() =>
  profitAndLoss({ ownerId: OWNER, showroomId: branch.id, from: "2026-10-01", to: "2026-10-31" }),
);

const october = await accrueFloorPlanInterest({
  ownerId: OWNER,
  showroomId: branch.id,
  period: PERIOD,
  userId: 1,
});
check("October accrues", october.ok, october.ok ? money(october.amount!) : october.error!);
check(
  "and it is one month's interest, not the whole life of the stock",
  october.ok && Math.abs(october.amount! - ((2 * COST * (RATE / 100)) / 365) * 30) < 0.05,
  `${money(october.amount ?? 0)} for 30 days on the floor — a run that charged everything accrued would triple the cost by March`,
);

const twice = await accrueFloorPlanInterest({
  ownerId: OWNER,
  showroomId: branch.id,
  period: PERIOD,
  userId: 1,
});
check(
  "**the same month twice is refused**",
  !twice.ok && (twice.error ?? "").includes("already been charged"),
  twice.error ?? "it charged October again",
);

const november = await accrueFloorPlanInterest({
  ownerId: OWNER,
  showroomId: branch.id,
  period: "2026-11",
  userId: 1,
});
check(
  "November charges only November",
  november.ok && Math.abs(november.amount! - ((2 * COST * (RATE / 100)) / 365) * 30) < 0.1,
  `${money(november.amount ?? 0)} — October's ${money(october.amount ?? 0)} is not in it`,
);

check(
  "it says the charge carries no financier's name, and why",
  october.warnings.some((w) => w.includes("financed and not by whom")),
  october.warnings.find((w) => w.includes("not by whom")) ?? "(not stated)",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. it lands on the branch's profit and loss");

const octoberAfter = await withWorkerScope(() =>
  profitAndLoss({ ownerId: OWNER, showroomId: branch.id, from: "2026-10-01", to: "2026-10-31" }),
);
check(
  "**the branch's expenses rose by exactly the accrual**",
  Math.abs(octoberAfter.totalExpenses - octoberBefore.totalExpenses - (october.amount ?? 0)) < 0.02,
  `${money(octoberBefore.totalExpenses)} → ${money(octoberAfter.totalExpenses)}`,
);
check(
  "on its own head, not netted into general interest",
  octoberAfter.expenses.some((e) => e.accountCode === FLOOR_PLAN_INTEREST),
  "the one figure that would make somebody discount an ageing machine, beside the term loan on the roof is a number nobody can act on",
);

// ────────────────────────────────────────────────────────────────────────────

section("4. **the ledger and the Inventory screen quote the same arithmetic**");

const worklist = await withWorkerScope(() =>
  buildInventoryWorklist({ showroomId: branch.id, ownerShowroomIds: [branch.id] }),
);
const screenRows = worklist.filter((r) => CHASSIS.includes(r.chassisNo));
const screenPerDay = screenRows.reduce((a, r) => a + (r.interestPerDay ?? 0), 0);

check(
  "the screen's per-day figure is the ledger's per-day figure",
  Math.abs(screenPerDay - pos.interestPerDay) < 0.02,
  `screen ${money(screenPerDay)} · ledger ${money(pos.interestPerDay)} — one exported function, imported by both`,
);

// ────────────────────────────────────────────────────────────────────────────

section("5. the drawdown moves the debt to whoever advanced it");

const [financier] = await ownerDb
  .insert(partiesTable)
  .values({
    ownerId: OWNER,
    entityId: placement.entity.id,
    kind: "FINANCIER",
    name: FINANCIER,
    state: "Delhi",
  })
  .returning({ id: partiesTable.id, name: partiesTable.name });

const [customer] = await ownerDb
  .select({ id: partiesTable.id })
  .from(partiesTable)
  .where(and(eq(partiesTable.ownerId, OWNER), eq(partiesTable.kind, "CUSTOMER")))
  .limit(1);

const [oem] = await ownerDb
  .select({ id: partiesTable.id })
  .from(partiesTable)
  .where(and(eq(partiesTable.ownerId, OWNER), eq(partiesTable.kind, "OEM")))
  .limit(1);

const bill = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: branch.id,
  supplierId: oem!.id,
  supplierInvoiceNo: SUPPLIER_INV,
  invoiceDate: "2026-10-01",
  // Hero invoices from Haryana into Delhi, so the credit is IGST — which is
  // why 1600/1610 carry nothing on this fixture and 1620 does.
  interState: true,
  lines: [
    {
      modelDescription: "Verify Floorplan Special",
      chassisNo: CHASSIS[0]!,
      quantity: 1,
      unitCost: COST,
      gstRatePct: 18,
      hsn: "87112019",
    },
  ],
  userId: 1,
});
check("a purchase bill exists to draw against", bill.ok, bill.ok ? SUPPLIER_INV : bill.error!);

if (bill.ok) {
  await postPurchaseInvoice({ ownerId: OWNER, purchaseInvoiceId: bill.invoice!.id, userId: 1 });
  const total = n(bill.invoice!.totalAmount);

  const toCustomer = await recordDrawdown({
    ownerId: OWNER,
    purchaseInvoiceId: bill.invoice!.id,
    financierPartyId: customer!.id,
    amount: total,
    drawdownDate: "2026-10-02",
    userId: 1,
  });
  check(
    "**a drawdown against somebody who is not a financier is refused**",
    !toCustomer.ok,
    toCustomer.error ?? "it booked a lakh against a customer",
  );

  const tooMuch = await recordDrawdown({
    ownerId: OWNER,
    purchaseInvoiceId: bill.invoice!.id,
    financierPartyId: financier!.id,
    amount: total + 1,
    drawdownDate: "2026-10-02",
    userId: 1,
  });
  check("more than the bill is refused", !tooMuch.ok, tooMuch.error ?? "it advanced more than the bill");

  const drawn = await recordDrawdown({
    ownerId: OWNER,
    purchaseInvoiceId: bill.invoice!.id,
    financierPartyId: financier!.id,
    amount: total,
    drawdownDate: "2026-10-02",
    userId: 1,
  });
  check("the drawdown posts", drawn.ok, drawn.ok ? drawn.voucher!.voucherNo : drawn.error!);

  if (drawn.ok) {
    const lines = await ownerDb
      .select({
        code: voucherLinesTable.accountCode,
        debit: voucherLinesTable.debit,
        credit: voucherLinesTable.credit,
        partyName: voucherLinesTable.partyName,
      })
      .from(voucherLinesTable)
      .where(eq(voucherLinesTable.voucherId, drawn.voucher!.id));
    for (const l of lines) {
      console.log(
        `      ${l.code}  Dr ${String(l.debit).padStart(12)}  Cr ${String(l.credit).padStart(12)}  ${l.partyName ?? ""}`,
      );
    }
    check(
      "the supplier is debited — the financier has settled them",
      lines.some((l) => l.code === "2100" && n(l.debit) === Math.round(total * 100) / 100),
      "Hero shows fifty-seven lakh owed until this runs, against a company that has already been paid",
    );
    check(
      "**and the floor-plan account is credited, with the financier's name on it**",
      lines.some((l) => l.code === FLOOR_PLAN && n(l.credit) > 0 && l.partyName === FINANCIER),
      lines.find((l) => l.code === FLOOR_PLAN)?.partyName ?? "(nobody named)",
    );
    check(
      "no money moved — the bank is untouched",
      !lines.some((l) => l.code === "1400" || l.code === "1500"),
      "a liability swap, which is exactly why it is easy to forget and why the creditor stays wrong for months",
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────

section("6. the books still balance");

const tb = await withWorkerScope(() =>
  trialBalance({
    ownerId: OWNER,
    entityId: placement.entity.id,
    from: "2026-04-01",
    to: "2027-03-31",
  }),
);
check(
  "**the trial balance balances after all of it**",
  tb.balances,
  `debit ${money(tb.totalDebit)} · credit ${money(tb.totalCredit)}`,
);
check(
  "Floor Plan Payable is on it",
  tb.rows.some((r) => r.accountCode === FLOOR_PLAN),
  tb.rows.find((r) => r.accountCode === FLOOR_PLAN)
    ? money(tb.rows.find((r) => r.accountCode === FLOOR_PLAN)!.closingCredit)
    : "(not on it)",
);

// ────────────────────────────────────────────────────────────────────────────

section("7. nothing unattended charges a dealership interest");

let denied = "";
try {
  await withWorkerScope(async () => {
    const r = await accrueFloorPlanInterest({
      ownerId: OWNER,
      showroomId: branch.id,
      period: "2026-12",
    });
    denied = r.ok ? "it accrued" : (r.error ?? "");
  });
} catch (e) {
  const chain: string[] = [];
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    chain.push(String((err as Error).message ?? err));
  }
  denied = chain.join(" | ");
}
check(
  "the scheduler is refused by the database",
  denied.includes("permission denied"),
  denied.split(" | ").find((m) => m.includes("permission denied")) ?? denied,
);

// ────────────────────────────────────────────────────────────────────────────

await tidy();
console.log("\n  (every voucher, accrual, bill, machine and party this run made, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. The financier holds the debt, the month is charged once, and what the\n" +
      "floor costs is on the branch's profit and loss rather than only on a screen.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
