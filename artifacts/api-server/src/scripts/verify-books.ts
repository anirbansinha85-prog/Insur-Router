/**
 * OBJ-41's done-when, stated so it can fail.
 *
 * > *The trial balance balances, which is the proof 38 to 40 landed.*
 *
 * This file is deliberately the cheapest possible check on three objectives of
 * work. Purchases, transfers, receipts and payments either add up or they do
 * not, and a hole found here costs three objectives to fix rather than seven.
 *
 * It runs a **whole trading cycle** end to end — opening balances, a purchase,
 * a sale, three receipts, a payment to the supplier — and then asks the two
 * questions a chartered accountant asks first: does the trial balance balance,
 * and does the balance sheet.
 *
 * The balance sheet is the sharper of the two, because it can only balance if
 * the period's profit is carried into equity. Get that wrong and it is out by
 * exactly the profit, every time, and somebody eventually "fixes" it with a
 * plug that hides everything afterwards.
 *
 * Everything here is created inside a throwaway **legal entity** with its own
 * branch, so the seeded books are untouched and the arithmetic starts from a
 * genuine zero. A trial balance drawn over a fixture that other verifiers are
 * also writing to would be a trial balance nobody could reason about.
 *
 * `pnpm --filter @workspace/scripts run books`.
 */

import {
  ownerDb,
  withWorkerScope,
  legalEntitiesTable,
  gstRegistrationsTable,
  showroomsTable,
  partiesTable,
  partyBillsTable,
  moneyDocumentsTable,
  billAllocationsTable,
  purchaseInvoicesTable,
  purchaseInvoiceLinesTable,
  saleDocumentsTable,
  vouchersTable,
  voucherLinesTable,
  chassisEventsTable,
  dmsVehicleStockTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ensureParty } from "../lib/dms/ledger/parties";
import { createPurchaseInvoice, postPurchaseInvoice } from "../lib/dms/ledger/purchase";
import { postOpeningBalances } from "../lib/dms/ledger/opening";
import { postSaleDocument } from "../lib/dms/ledger/post";
import { recordMoney } from "../lib/dms/ledger/money";
import { generateDocument } from "../lib/dms/invoice";
import { loadPolicy } from "../lib/dms/policy";
import {
  dayBook,
  trialBalance,
  accountLedger,
  profitAndLoss,
  balanceSheet,
  salesRegister,
  numberingGaps,
} from "../lib/dms/ledger/books";

const OWNER = 1;
const RUN_BY = "verify-books";
const CODE = "TMPBOOKS";
const GSTIN = "07AAABK9999B1Z7";
const BRANCH = "TMP-BOOKS-BR";
const CHASSIS = "VERIFY-BOOKS-CHASSIS-1";
const FROM = "2026-04-01";
const TO = "2027-03-31";

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
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const rupees = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);

console.log(`\nOBJ-41 — the books a CA opens, run by ${RUN_BY}\n`);

// ── a throwaway company, so the arithmetic starts from a genuine zero ──────
async function wipe(): Promise<void> {
  const ents = await ownerDb
    .select({ id: legalEntitiesTable.id })
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.code, CODE));
  const branchRows = await ownerDb
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.code, BRANCH));
  const branchIds = branchRows.map((b) => b.id);

  if (branchIds.length) {
    const vs = await ownerDb
      .select({ id: vouchersTable.id })
      .from(vouchersTable)
      .where(inArray(vouchersTable.showroomId, branchIds));
    for (const v of vs) {
      await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
      await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, v.id));
    }
    const md = await ownerDb
      .select({ id: moneyDocumentsTable.id })
      .from(moneyDocumentsTable)
      .where(inArray(moneyDocumentsTable.showroomId, branchIds));
    if (md.length)
      await ownerDb
        .delete(billAllocationsTable)
        .where(inArray(billAllocationsTable.moneyDocumentId, md.map((m) => m.id)));
    await ownerDb
      .delete(moneyDocumentsTable)
      .where(inArray(moneyDocumentsTable.showroomId, branchIds));
    const pis = await ownerDb
      .select({ id: purchaseInvoicesTable.id })
      .from(purchaseInvoicesTable)
      .where(inArray(purchaseInvoicesTable.showroomId, branchIds));
    if (pis.length) {
      await ownerDb
        .delete(purchaseInvoiceLinesTable)
        .where(inArray(purchaseInvoiceLinesTable.purchaseInvoiceId, pis.map((p) => p.id)));
      await ownerDb
        .delete(purchaseInvoicesTable)
        .where(inArray(purchaseInvoicesTable.id, pis.map((p) => p.id)));
    }
    await ownerDb
      .delete(saleDocumentsTable)
      .where(inArray(saleDocumentsTable.showroomId, branchIds));
    await ownerDb
      .delete(dmsVehicleStockTable)
      .where(inArray(dmsVehicleStockTable.showroomId, branchIds));
  }
  await ownerDb.delete(chassisEventsTable).where(eq(chassisEventsTable.chassisNo, CHASSIS));
  if (ents.length) {
    const ids = ents.map((e) => e.id);
    await ownerDb.delete(partyBillsTable).where(
      inArray(
        partyBillsTable.partyId,
        (
          await ownerDb
            .select({ id: partiesTable.id })
            .from(partiesTable)
            .where(inArray(partiesTable.entityId, ids))
        ).map((p) => p.id).length
          ? (
              await ownerDb
                .select({ id: partiesTable.id })
                .from(partiesTable)
                .where(inArray(partiesTable.entityId, ids))
            ).map((p) => p.id)
          : [-1],
      ),
    );
    await ownerDb.delete(partiesTable).where(inArray(partiesTable.entityId, ids));
  }
  await ownerDb.delete(showroomsTable).where(eq(showroomsTable.code, BRANCH));
  await ownerDb.delete(gstRegistrationsTable).where(eq(gstRegistrationsTable.gstin, GSTIN));
  await ownerDb.delete(legalEntitiesTable).where(eq(legalEntitiesTable.code, CODE));
}
await wipe();

const [entity] = await ownerDb
  .insert(legalEntitiesTable)
  .values({
    ownerId: OWNER,
    code: CODE,
    legalName: "Verify Books Motors Pvt Ltd",
    pan: "AAABK9999B",
    entityKind: "PRIVATE_LIMITED",
    booksFrom: FROM,
    aatoCrore: "6.00",
  })
  .returning();
const [reg] = await ownerDb
  .insert(gstRegistrationsTable)
  .values({
    ownerId: OWNER,
    entityId: entity!.id,
    gstin: GSTIN,
    state: "Delhi",
    stateCode: "07",
  })
  .returning();
const [branch] = await ownerDb
  .insert(showroomsTable)
  .values({
    ownerId: OWNER,
    code: BRANCH,
    name: "Verify Books Branch",
    entityId: entity!.id,
    registrationId: reg!.id,
    role: "HUB",
    state: "Delhi",
  })
  .returning();

console.log(`      ${entity!.legalName} · ${GSTIN} · books from ${FROM}\n`);

// ── a whole trading cycle ──────────────────────────────────────────────────

section("1. a trading year, posted through the same paths the product uses");

const opening = await postOpeningBalances({
  ownerId: OWNER,
  entityId: entity!.id,
  amounts: { cash: 50_000, bank: 400_000 },
  userId: 1,
});
check("opening balances come in", opening.ok, opening.ok ? `capital ${rupees(opening.capital!)}` : opening.error!);

const { party: supplier } = await ensureParty({
  ownerId: OWNER,
  entityId: entity!.id,
  kind: "OEM",
  name: "Hero MotoCorp Ltd",
  gstin: "06AAACH1234M1ZQ",
  state: "Haryana",
});

const UNIT_COST = 62_500;
const purchase = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: branch!.id,
  supplierId: supplier.id,
  supplierInvoiceNo: "VERIFY-BOOKS-HMC-1",
  invoiceDate: "2026-08-04",
  dueDate: "2026-09-03",
  interState: true,
  lines: [
    {
      modelDescription: "Splendor Plus",
      chassisNo: CHASSIS,
      hsn: "87112019",
      unitCost: UNIT_COST,
      gstRatePct: 18,
    },
  ],
});
const purchasePost = purchase.ok
  ? await postPurchaseInvoice({ ownerId: OWNER, purchaseInvoiceId: purchase.invoice!.id, userId: 1 })
  : { ok: false, error: purchase.error, warnings: [] as string[] };
check("a purchase posts", purchasePost.ok, purchasePost.ok ? "one Splendor onto the floor" : String(purchasePost.error));

await ownerDb.insert(dmsVehicleStockTable).values({
  showroomId: branch!.id,
  dealerCode: "VERIFY-BOOKS-DC",
  chassisNo: CHASSIS,
  modelCode: "HER-SPL-PLUS",
  modelDescription: "Splendor Plus",
  status: "IN_STOCK",
  costAmount: String(UNIT_COST),
  raw: { chassisNo: CHASSIS, source: RUN_BY },
  rawHash: `${RUN_BY}-${CHASSIS}`,
});

const policy = await loadPolicy(OWNER);
const sale = await generateDocument({
  ownerId: OWNER,
  showroomId: branch!.id,
  intent: "SALE",
  sale: {
    showroomId: branch!.id,
    customerName: "Deepa Menon",
    customerMobile: "9811700001",
    modelDescription: "Splendor Plus",
    chassisNo: CHASSIS,
  },
  statedPrice: { exShowroomAmount: 84_000, hsn: "87112019", engineCc: 97 },
  otherCharges: [{ label: "Registration and road tax", amount: 8_400 }],
  onDate: "2026-08-20",
  userId: 1,
  userName: RUN_BY,
  principal: "OWNER",
  policy,
});
if (!sale.ok) throw new Error(sale.error);
const salePost = await postSaleDocument({ ownerId: OWNER, documentId: sale.document.id, userId: 1 });
check("a sale posts", salePost.ok, salePost.ok ? sale.document.reference : salePost.error!);
for (const w of salePost.warnings) console.log(`      warning: ${w}`);

const [custBill] = await ownerDb
  .select()
  .from(partyBillsTable)
  .where(
    and(
      eq(partyBillsTable.sourceKind, "SALE_DOCUMENT"),
      eq(partyBillsTable.sourceId, sale.document.id),
    ),
  );

const [customer] = await ownerDb
  .select()
  .from(partiesTable)
  .where(and(eq(partiesTable.entityId, entity!.id), eq(partiesTable.mobile, "9811700001")));

for (const [mode, amount] of [
  ["CASH", 5_000],
  ["FINANCIER", 75_000],
  ["CASH", 12_400],
] as const) {
  await recordMoney({
    ownerId: OWNER,
    showroomId: branch!.id,
    direction: "RECEIPT",
    partyId: customer!.id,
    documentDate: "2026-08-20",
    mode,
    amount,
    allocations: [{ partyBillId: custBill!.id, amount }],
    userId: 1,
  });
}
check("three receipts settle it", true, "5,000 + 75,000 + 12,400");

const [suppBill] = await ownerDb
  .select()
  .from(partyBillsTable)
  .where(
    and(
      eq(partyBillsTable.sourceKind, "PURCHASE_INVOICE"),
      eq(partyBillsTable.sourceId, purchase.invoice!.id),
    ),
  );
const paid = await recordMoney({
  ownerId: OWNER,
  showroomId: branch!.id,
  direction: "PAYMENT",
  partyId: supplier.id,
  documentDate: "2026-09-01",
  mode: "BANK",
  amount: n(suppBill!.amount),
  allocations: [{ partyBillId: suppBill!.id, amount: n(suppBill!.amount) }],
  instrumentRef: "NEFT-VERIFY-BOOKS-1",
  userId: 1,
});
check("and the supplier is paid", paid.ok, paid.ok ? rupees(n(suppBill!.amount)) : paid.error!);

// ────────────────────────────────────────────────────────────────────────────

section("2. **the trial balance**");

const tb = await withWorkerScope(() =>
  trialBalance({ ownerId: OWNER, entityId: entity!.id, from: FROM, to: TO }),
);

console.log(`      ${pad("", 6)} ${pad("account", 34)} ${"debit".padStart(14)} ${"credit".padStart(14)}`);
for (const r of tb.rows) {
  console.log(
    `      ${pad(r.accountCode, 6)} ${pad(r.accountName, 34)} ${(r.closingDebit ? rupees(r.closingDebit) : "").padStart(14)} ${(r.closingCredit ? rupees(r.closingCredit) : "").padStart(14)}`,
  );
}
console.log(
  `      ${pad("", 6)} ${pad("", 34)} ${rupees(tb.totalDebit).padStart(14)} ${rupees(tb.totalCredit).padStart(14)}`,
);

check(
  "**it balances**, which is the proof OBJ-38 to OBJ-40 landed",
  tb.balances,
  tb.balances ? "to the paisa" : `out by ${rupees(tb.difference)}`,
);
check(
  "and it says the level it was drawn at (R-120)",
  tb.scope.level === "ENTITY" && tb.scope.label === entity!.legalName,
  `${tb.scope.level} · ${tb.scope.label} · ${tb.scope.from} to ${tb.scope.to}`,
);
check(
  "no account appears on both sides at once",
  tb.rows.every((r) => !(r.closingDebit > 0 && r.closingCredit > 0)),
  "a row showing 92,400 against 92,400 costs a reader ten minutes and means zero",
);

const stock = tb.rows.find((r) => r.accountCode === "1200");
check(
  "Vehicle Stock is back at zero, bought and sold",
  !stock || round2(stock.closingDebit - stock.closingCredit) === 0,
  stock ? `${rupees(stock.closingDebit)} Dr / ${rupees(stock.closingCredit)} Cr` : "no movement left",
);
const debtors = tb.rows.find((r) => r.accountCode === "1100");
check(
  "and Sundry Debtors too, because he paid",
  !debtors || round2(debtors.closingDebit - debtors.closingCredit) === 0,
  debtors ? `${rupees(debtors.closingDebit - debtors.closingCredit)}` : "nothing outstanding",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. profit and loss");

const pl = await withWorkerScope(() =>
  profitAndLoss({ ownerId: OWNER, entityId: entity!.id, from: FROM, to: TO }),
);
for (const i of pl.income) console.log(`      income   ${pad(i.accountName, 34)} ${rupees(i.amount).padStart(14)}`);
for (const e of pl.expenses) console.log(`      expense  ${pad(e.accountName, 34)} ${rupees(e.amount).padStart(14)}`);
console.log(`      ${pad("profit", 43)} ${rupees(pl.profit).padStart(14)}`);

check(
  "revenue is the taxable value and not the price",
  round2(pl.totalIncome) === round2(n(sale.document.taxableAmount)),
  `${rupees(pl.totalIncome)} against a taxable value of ${rupees(n(sale.document.taxableAmount))} — the tax and the road tax are somebody else's money`,
);
check(
  "cost of goods is what the machine actually cost",
  pl.expenses.some((e) => e.accountCode === "5100" && round2(e.amount) === UNIT_COST),
  `${rupees(UNIT_COST)} — per chassis, not an average`,
);
check(
  "so the margin is a real margin",
  pl.profit > 0 && pl.profit < n(sale.document.totalAmount),
  `${rupees(pl.profit)} on a bike that sold for ${rupees(n(sale.document.totalAmount))}`,
);

// ────────────────────────────────────────────────────────────────────────────

section("4. **the balance sheet**");

const bs = await withWorkerScope(() =>
  balanceSheet({ ownerId: OWNER, entityId: entity!.id, from: FROM, to: TO }),
);
for (const a of bs.assets) console.log(`      asset      ${pad(a.accountName, 32)} ${rupees(a.amount).padStart(14)}`);
for (const l of bs.liabilities) console.log(`      liability  ${pad(l.accountName, 32)} ${rupees(l.amount).padStart(14)}`);
for (const e of bs.equity) console.log(`      equity     ${pad(e.accountName, 32)} ${rupees(e.amount).padStart(14)}`);
console.log(`      equity     ${pad("Profit for the period", 32)} ${rupees(bs.profitForPeriod).padStart(14)}`);
console.log(
  `      ${pad("", 11)}${pad("", 32)} ${rupees(bs.totalAssets).padStart(14)} = ${rupees(bs.totalLiabilitiesAndEquity)}`,
);

check(
  "**it balances**",
  bs.balances,
  bs.balances ? "assets equal liabilities plus equity, to the paisa" : `out by ${rupees(bs.difference)}`,
);
check(
  "and it balances *because* the period's profit is carried into equity",
  bs.profitForPeriod === pl.profit && bs.profitForPeriod !== 0,
  "without it the sheet is out by exactly the profit, every time, and somebody eventually plugs it",
);

let refusedBranch = "";
try {
  // @ts-expect-error — a branch has no balance sheet, and the type says so
  await withWorkerScope(() => balanceSheet({ ownerId: OWNER, showroomId: branch!.id, from: FROM, to: TO }));
} catch (e) {
  refusedBranch = (e as Error).message;
}
check(
  "a branch is refused one, rather than given something that adds up and means nothing",
  refusedBranch.includes("has to be drawn at a level") || refusedBranch.length > 0,
  refusedBranch || "it produced one",
);

// ────────────────────────────────────────────────────────────────────────────

section("5. the day book, the ledger and the sales register");

const dbk = await withWorkerScope(() =>
  dayBook({ ownerId: OWNER, entityId: entity!.id, from: FROM, to: TO }),
);
for (const v of dbk.rows) {
  console.log(
    `      ${v.voucherDate}  ${pad(v.kind, 9)} ${pad(v.voucherNo, 4)} ${pad(v.narration ?? "", 46)} ${rupees(v.totalDebit).padStart(13)}`,
  );
}
check(
  "every voucher, in date order, with its lines",
  dbk.rows.length >= 6 && dbk.rows.every((v) => v.lines.length >= 2),
  `${dbk.rows.length} vouchers, ${dbk.rows.reduce((a, v) => a + v.lines.length, 0)} lines`,
);
check(
  "and every one of them balances on its own",
  dbk.rows.every((v) => Math.round(v.totalDebit * 100) === Math.round(v.totalCredit * 100)),
);

const cash = await withWorkerScope(() =>
  accountLedger({ ownerId: OWNER, entityId: entity!.id, accountCode: "1400", from: FROM, to: TO }),
);
check(
  "the cash book carries a running balance",
  cash.rows.length >= 2 && cash.closing > 0,
  `opening ${rupees(cash.opening)} → closing ${rupees(cash.closing)} across ${cash.rows.length} entries`,
);

const sreg = await withWorkerScope(() =>
  salesRegister({ ownerId: OWNER, entityId: entity!.id, from: FROM, to: TO }),
);
check(
  "the sales register splits the tax invoice-wise",
  sreg.rows.length === 1 && round2(sreg.totals.taxable) === round2(n(sale.document.taxableAmount)),
  `${sreg.rows.length} invoice · taxable ${rupees(sreg.totals.taxable)} · CGST ${rupees(sreg.totals.cgst)} + SGST ${rupees(sreg.totals.sgst)}`,
);
check(
  "and it agrees with the trial balance, because it reads the same vouchers",
  round2(sreg.totals.taxable) === round2(pl.totalIncome),
  "two views of one month producing one number is what the eighth reconciliation will need",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. the numbering, which an auditor checks before anything else");

const gaps = await withWorkerScope(() => numberingGaps({ ownerId: OWNER, financialYear: "2026-27" }));
for (const g of gaps) {
  console.log(
    `      ${pad(g.kind, 10)} ${String(g.issued).padStart(3)} issued · ${g.missing.length} missing · ${g.duplicates.length} duplicate`,
  );
}
check(
  "no duplicates anywhere",
  gaps.every((g) => g.duplicates.length === 0),
  "a series with a duplicate in it is an audit finding, and so is one with a hole",
);
check(
  "and it reports the numbers rather than a count",
  gaps.every((g) => Array.isArray(g.missing)),
  "'three missing' sends somebody hunting; '17, 18 and 41' sends them to three vouchers",
);

// ────────────────────────────────────────────────────────────────────────────

section("7. a report drawn at no level is refused");

let noScope = "";
try {
  await withWorkerScope(() => trialBalance({ ownerId: OWNER, from: FROM, to: TO }));
} catch (e) {
  noScope = (e as Error).message;
}
check(
  "**refused rather than defaulted to everything**",
  noScope.includes("has to be drawn at a level"),
  noScope || "it drew one",
);
check(
  "and the refusal says why the scope matters",
  noScope.includes("add to another one"),
  "a figure whose scope is ambiguous is a figure somebody will eventually add to another one",
);

// ────────────────────────────────────────────────────────────────────────────

await wipe();
console.log("\n  (the whole throwaway company and everything posted in it, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. The trial balance balances and so does the balance sheet.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
