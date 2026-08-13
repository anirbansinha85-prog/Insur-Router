/**
 * OBJ-40's done-when, stated so it can fail.
 *
 * > *A customer who paid in three parts has a zero balance and no unallocated
 * > credit.*
 *
 * Three parts is the ordinary retail sale and not an edge case: a booking
 * advance, a financier's disbursement, and the balance in cash on delivery. If
 * that leaves anything behind — a rupee outstanding, or a credit sitting on
 * account — then the debtors report is wrong about a customer who has paid, and
 * somebody will ring him about it.
 *
 * §2 is the one that matters most and it is a **refusal**. Money arriving with
 * no instruction, against a customer with two open bills, must stay on account.
 * Applying it to the oldest is the obvious shortcut and it is a guess about
 * which debt he meant to settle — and a customer disputing one invoice while
 * paying another is an ordinary Tuesday. A product that applies his money to
 * the invoice he is disputing has taken a side in his argument.
 *
 * §5 is the day close, and the assertion is that a difference is **named rather
 * than absorbed**. A close that journalled the shortfall away would hide the
 * one thing it exists to surface.
 *
 * `pnpm --filter @workspace/scripts run money`.
 */

import {
  db,
  ownerDb,
  withWorkerScope,
  moneyDocumentsTable,
  billAllocationsTable,
  dayClosesTable,
  partyBillsTable,
  partiesTable,
  vouchersTable,
  voucherLinesTable,
  showroomsTable,
  showroomDmsAccountsTable,
  saleDocumentsTable,
  dmsVehicleStockTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { placementOf } from "../lib/dms/org";
import { generateDocument } from "../lib/dms/invoice";
import { postSaleDocument } from "../lib/dms/ledger/post";
import { loadPolicy } from "../lib/dms/policy";
import { ensureParty, openBill, partyStatement } from "../lib/dms/ledger/parties";
import {
  recordMoney,
  applyAllocation,
  reverseAllocation,
  onAccount,
  bookedCashFor,
  closeDay,
  dayCloseDifferences,
  allocationsFor,
} from "../lib/dms/ledger/money";

const OWNER = 1;
const RUN_BY = "verify-money";
const MOBILE = "9811900001";
const MOBILE_2 = "9811900002";
const MOBILE_3 = "9811900003";
const CHASSIS = "VERIFY-MONEY-CHASSIS-1";

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

console.log(`\nOBJ-40 — money, allocation and the day close, run by ${RUN_BY}\n`);

const [branch] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SARASWATI")))
  .limit(1);
if (!branch) throw new Error("DEL-SARASWATI is missing. Run db:migrate-org.");
const placement = await withWorkerScope(() => placementOf(branch.id));

// ── clear this file's own leftovers ────────────────────────────────────────
async function wipe(): Promise<void> {
  const parties = await ownerDb
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(inArray(partiesTable.mobile, [MOBILE, MOBILE_2, MOBILE_3]));
  const ids = parties.map((p) => p.id);
  if (ids.length) {
    const docs = await ownerDb
      .select({ id: moneyDocumentsTable.id, voucherId: moneyDocumentsTable.voucherId })
      .from(moneyDocumentsTable)
      .where(inArray(moneyDocumentsTable.partyId, ids));
    for (const d of docs) {
      await ownerDb.delete(billAllocationsTable).where(eq(billAllocationsTable.moneyDocumentId, d.id));
      if (d.voucherId) {
        await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, d.voucherId));
        await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, d.voucherId));
      }
    }
    await ownerDb.delete(moneyDocumentsTable).where(inArray(moneyDocumentsTable.partyId, ids));
    await ownerDb.delete(partyBillsTable).where(inArray(partyBillsTable.partyId, ids));
    await ownerDb.delete(partiesTable).where(inArray(partiesTable.id, ids));
  }
  const docs = await ownerDb
    .select({ id: saleDocumentsTable.id })
    .from(saleDocumentsTable)
    .where(eq(saleDocumentsTable.chassisNo, CHASSIS));
  for (const d of docs) {
    const vs = await ownerDb
      .select({ id: vouchersTable.id })
      .from(vouchersTable)
      .where(and(eq(vouchersTable.sourceKind, "SALE_DOCUMENT"), eq(vouchersTable.sourceId, d.id)));
    for (const v of vs) {
      await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
      await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, v.id));
    }
    await ownerDb
      .delete(partyBillsTable)
      .where(and(eq(partyBillsTable.sourceKind, "SALE_DOCUMENT"), eq(partyBillsTable.sourceId, d.id)));
    await ownerDb.delete(saleDocumentsTable).where(eq(saleDocumentsTable.id, d.id));
  }
  await ownerDb.delete(dmsVehicleStockTable).where(eq(dmsVehicleStockTable.chassisNo, CHASSIS));

  await ownerDb
    .delete(dayClosesTable)
    .where(
      and(
        eq(dayClosesTable.showroomId, branch!.id),
        inArray(dayClosesTable.closeDate, ["2026-08-20", "2026-08-21"]),
      ),
    );
}
await wipe();

// ────────────────────────────────────────────────────────────────────────────

section("1. **a customer who paid in three parts owes nothing and holds nothing**");

const { party: buyer } = await (async () =>
  ensureParty({
    ownerId: OWNER,
    entityId: placement.entity.id,
    kind: "CUSTOMER",
    name: "Mahesh Iyer",
    mobile: MOBILE,
  }))();

/*
 * A real sale, not a hand-opened bill.
 *
 * The first version of this section called `openBill` directly, which creates
 * the debt without the debit that goes with it - so the statement showed three
 * credits and nothing else and could never have closed at zero. A bill with no
 * sale behind it is not a smaller version of a sale; it is half an entry.
 */
const policy = await loadPolicy(OWNER);
const [dealer] = await ownerDb
  .select({ code: showroomDmsAccountsTable.dealerCode })
  .from(showroomDmsAccountsTable)
  .where(eq(showroomDmsAccountsTable.showroomId, branch.id))
  .limit(1);
await ownerDb.insert(dmsVehicleStockTable).values({
  showroomId: branch.id,
  dealerCode: dealer?.code ?? "HMC-DL-0417",
  chassisNo: CHASSIS,
  modelCode: "HER-SPL-PLUS",
  modelDescription: "Splendor Plus",
  status: "IN_STOCK",
  costAmount: "62500.00",
  raw: { chassisNo: CHASSIS, source: RUN_BY },
  rawHash: RUN_BY + "-" + CHASSIS,
});

const sale = await generateDocument({
  ownerId: OWNER,
  showroomId: branch.id,
  intent: "SALE",
  sale: {
    showroomId: branch.id,
    customerName: "Mahesh Iyer",
    customerMobile: MOBILE,
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
if (!salePost.ok) throw new Error(salePost.error);

const INVOICE = n(sale.document.totalAmount);
const [bill] = await ownerDb
  .select()
  .from(partyBillsTable)
  .where(
    and(
      eq(partyBillsTable.sourceKind, "SALE_DOCUMENT"),
      eq(partyBillsTable.sourceId, sale.document.id),
    ),
  );
console.log("      " + bill!.billNo + " " + rupees(INVOICE) + " owed by " + buyer.name);

const parts: Array<{ label: string; mode: "CASH" | "BANK" | "FINANCIER"; amount: number }> = [
  { label: "booking advance", mode: "CASH", amount: 5_000 },
  { label: "financier disbursement", mode: "FINANCIER", amount: 75_000 },
  { label: "balance on delivery", mode: "CASH", amount: 12_400 },
];

for (const p of parts) {
  const r = await recordMoney({
    ownerId: OWNER,
    showroomId: branch.id,
    direction: "RECEIPT",
    partyId: buyer.id,
    documentDate: "2026-08-20",
    mode: p.mode,
    amount: p.amount,
    allocations: [{ partyBillId: bill!.id, amount: p.amount }],
    narration: p.label,
    userId: 1,
  });
  /*
   * Asserting on the warnings too, because the first version of this check did
   * not - and a bug that refused every allocation while still returning `ok`
   * sailed straight past it. A receipt that could not do what it was told is
   * not a receipt that worked.
   */
  check(
    `${p.label}: ${rupees(p.amount)}`,
    r.ok && r.warnings.length === 0,
    r.ok ? `${r.document!.documentNo}${r.warnings.length ? ` — but: ${r.warnings.join("; ")}` : ""}` : r.error!,
  );
}

const [settled] = await ownerDb
  .select()
  .from(partyBillsTable)
  .where(eq(partyBillsTable.id, bill!.id));
check(
  "**the bill is settled to the paisa**",
  round2(n(settled!.outstanding)) === 0,
  `${rupees(n(settled!.outstanding))} outstanding on ${rupees(n(settled!.amount))}`,
);

const acct = await withWorkerScope(() =>
  onAccount({ ownerId: OWNER, direction: "RECEIPT", asOf: "2026-08-31" }),
);
check(
  "and nothing of his is sitting on account",
  !acct.rows.some((r) => r.partyId === buyer.id),
  `${acct.rows.length} receipt(s) on account across the dealership, none of them his`,
);

const st = await withWorkerScope(() => partyStatement({ partyId: buyer.id }));
check(
  "so his statement closes at zero",
  round2(st.closing) === 0,
  `${st.rows.length} entries, closing ${rupees(st.closing)}`,
);

const how = await withWorkerScope(() => allocationsFor(bill!.id));
console.log(
  `      settled by: ${how.map((h) => `${h.documentNo} ${h.mode} ${rupees(h.amount)} (${h.decidedBy.toLowerCase()})`).join(" · ")}`,
);
check(
  "and the bill can say how it was paid, receipt by receipt",
  how.length === 3,
  "one invoice settled by three receipts is why allocation is its own table",
);

// ────────────────────────────────────────────────────────────────────────────

section("2. money with no instruction stays on account, and says so");

const { party: two } = await (async () =>
  ensureParty({
    ownerId: OWNER,
    entityId: placement.entity.id,
    kind: "CUSTOMER",
    name: "Priya Nair",
    mobile: MOBILE_2,
  }))();

const billA = await openBill({
  ownerId: OWNER,
  partyId: two.id,
  showroomId: branch.id,
  direction: "RECEIVABLE",
  billNo: "VERIFY-MONEY/INV/A",
  billDate: "2026-08-10",
  amount: 40_000,
  sourceKind: "MANUAL",
  sourceId: null,
});
const billB = await openBill({
  ownerId: OWNER,
  partyId: two.id,
  showroomId: branch.id,
  direction: "RECEIVABLE",
  billNo: "VERIFY-MONEY/INV/B",
  billDate: "2026-08-18",
  amount: 22_000,
  sourceKind: "MANUAL",
  sourceId: null,
});

const vague = await recordMoney({
  ownerId: OWNER,
  showroomId: branch.id,
  direction: "RECEIPT",
  partyId: two.id,
  documentDate: "2026-08-20",
  mode: "UPI",
  amount: 22_000,
  instrumentRef: "UPI-VERIFY-MONEY-1",
  userId: 1,
});
check("it records", vague.ok, vague.ok ? vague.document!.documentNo : vague.error!);
check(
  "**and it is not applied to the older bill**, even though it settles the newer one exactly",
  vague.ok && round2(n(vague.document!.unallocated)) === 22_000,
  "two open bills means a choice, and the choice is the customer's — the amount matching one of them is a coincidence, not an instruction",
);
check(
  "the warning says whose decision it is",
  vague.warnings.some((w) => w.includes("customer's decision")),
  vague.warnings[0] ?? "",
);

const applied = await applyAllocation({
  ownerId: OWNER,
  moneyDocumentId: vague.document!.id,
  partyBillId: billB.id,
  amount: 22_000,
  decidedBy: "PERSON",
  userId: 1,
});
check("a person applies it, and then it lands", applied.ok, applied.error ?? "against INV/B");

const [bAfter] = await ownerDb.select().from(partyBillsTable).where(eq(partyBillsTable.id, billB.id));
const [aAfter] = await ownerDb.select().from(partyBillsTable).where(eq(partyBillsTable.id, billA.id));
check(
  "on the bill he chose, and not the other one",
  round2(n(bAfter!.outstanding)) === 0 && round2(n(aAfter!.outstanding)) === 40_000,
  `INV/B ${rupees(n(bAfter!.outstanding))} · INV/A ${rupees(n(aAfter!.outstanding))}`,
);

const over = await applyAllocation({
  ownerId: OWNER,
  moneyDocumentId: vague.document!.id,
  partyBillId: billA.id,
  amount: 1,
  userId: 1,
});
check(
  "and a receipt cannot settle more than it is",
  !over.ok && over.error!.includes("unapplied"),
  over.ok ? "it over-applied" : over.error!,
);

const [alloc] = await ownerDb
  .select()
  .from(billAllocationsTable)
  .where(eq(billAllocationsTable.moneyDocumentId, vague.document!.id));
const undone = await reverseAllocation({ ownerId: OWNER, allocationId: alloc!.id, userId: 1 });
check("changing their mind posts the opposite, never a delete", undone.ok, undone.error ?? "");

const rows = await ownerDb
  .select()
  .from(billAllocationsTable)
  .where(eq(billAllocationsTable.moneyDocumentId, vague.document!.id));
check(
  "so the record says they decided and then changed their mind",
  rows.length === 2 && rows.some((r) => n(r.amount) < 0),
  `${rows.length} rows: ${rows.map((r) => rupees(n(r.amount))).join(", ")}`,
);

// ────────────────────────────────────────────────────────────────────────────

section("3. the one allocation with no judgement in it");

/*
 * Its own customer, because §2 reversed an allocation and put that money back
 * on its bill - so Priya has two open bills again and the automatic path would
 * correctly decline. The premise of this section is *one* open bill.
 */
const { party: solo } = await (async () =>
  ensureParty({
    ownerId: OWNER,
    entityId: placement.entity.id,
    kind: "CUSTOMER",
    name: "Anand Rao",
    mobile: MOBILE_3,
  }))();

const soloBill = await openBill({
  ownerId: OWNER,
  partyId: solo.id,
  showroomId: branch.id,
  direction: "RECEIVABLE",
  billNo: "VERIFY-MONEY/INV/C",
  billDate: "2026-08-19",
  amount: 40_000,
  sourceKind: "MANUAL",
  sourceId: null,
});

const exact = await recordMoney({
  ownerId: OWNER,
  showroomId: branch.id,
  direction: "RECEIPT",
  partyId: solo.id,
  documentDate: "2026-08-21",
  mode: "BANK",
  amount: 40_000,
  instrumentRef: "NEFT-VERIFY-MONEY-2",
  userId: 1,
});
const [aFinal] = await ownerDb
  .select()
  .from(partyBillsTable)
  .where(eq(partyBillsTable.id, soloBill.id));
check(
  "one open bill, exactly the right amount: applied without asking",
  exact.ok && round2(n(exact.document!.unallocated)) === 0 && round2(n(aFinal!.outstanding)) === 0,
  "nothing to choose between, so choosing is not a decision",
);
const autoRows = await withWorkerScope(() => allocationsFor(soloBill.id));
check(
  "and the record says the product decided it, not a person",
  autoRows.some((r) => r.decidedBy === "AUTOMATIC"),
  autoRows.map((r) => `${r.documentNo}: ${r.decidedBy}`).join(" · "),
);

// ────────────────────────────────────────────────────────────────────────────

section("4. an advance on a bike carries no GST; one on a service job does");

const goods = await recordMoney({
  ownerId: OWNER,
  showroomId: branch.id,
  direction: "RECEIPT",
  partyId: buyer.id,
  documentDate: "2026-08-21",
  mode: "CASH",
  amount: 5_000,
  advanceFor: "GOODS",
  narration: "booking on a Splendor",
  userId: 1,
});
const goodsLines = await ownerDb
  .select({ code: voucherLinesTable.accountCode, credit: voucherLinesTable.credit })
  .from(voucherLinesTable)
  .where(eq(voucherLinesTable.voucherId, goods.voucherId!));
check(
  "**a booking advance on a motorcycle attracts none** — the liability arises at the invoice",
  !goodsLines.some((l) => l.code === "2200" || l.code === "2210"),
  goodsLines.map((l) => l.code).join(", "),
);
check(
  "and the whole of it sits as a liability, because the bike has not been delivered",
  goodsLines.some((l) => l.code === "2400" && n(l.credit) === 5_000),
  "money taken for something not yet delivered is money the dealership would have to give back",
);

const service = await recordMoney({
  ownerId: OWNER,
  showroomId: branch.id,
  direction: "RECEIPT",
  partyId: buyer.id,
  documentDate: "2026-08-21",
  mode: "CASH",
  amount: 2_360,
  advanceFor: "SERVICE",
  narration: "deposit on a restoration job",
  userId: 1,
});
const svcLines = await ownerDb
  .select({ code: voucherLinesTable.accountCode, credit: voucherLinesTable.credit })
  .from(voucherLinesTable)
  .where(eq(voucherLinesTable.voucherId, service.voucherId!));
const svcTax = round2(
  svcLines.filter((l) => l.code === "2200" || l.code === "2210").reduce((a, l) => a + n(l.credit), 0),
);
check(
  "**an advance against a service job does**, at the time of receipt",
  svcTax > 0,
  `${rupees(svcTax)} of GST on ${rupees(2_360)} taken`,
);
check(
  "and the tax comes out of what was handed over, not on top of it",
  round2(svcLines.reduce((a, l) => a + n(l.credit), 0)) === 2_360,
  "somebody handing over two thousand three hundred and sixty rupees has handed over that, and no more",
);
check(
  "with a warning that says which rule applied",
  service.warnings.some((w) => w.includes("service job")),
  service.warnings.find((w) => w.includes("service job")) ?? "",
);

// ────────────────────────────────────────────────────────────────────────────

section("5. the day close, where the difference is named and never absorbed");

const booked = await withWorkerScope(() =>
  bookedCashFor({ ownerId: OWNER, showroomId: branch.id, closeDate: "2026-08-20" }),
);
console.log(
  `      opening ${rupees(booked.opening)} + receipts ${rupees(booked.receipts)} − payments ${rupees(booked.payments)} = ${rupees(booked.expected)}`,
);

const short = await closeDay({
  ownerId: OWNER,
  showroomId: branch.id,
  closeDate: "2026-08-20",
  countedCash: round2(booked.expected - 900),
  reason: "UNEXPLAINED",
  userId: 1,
});
check("it closes", short.ok, short.ok ? `difference ${rupees(n(short.close!.difference))}` : short.error!);
check(
  "**a shortfall is recorded as a difference**, not journalled away",
  short.ok && round2(n(short.close!.difference)) === -900,
  "a close that absorbed the difference would hide the one thing it exists to surface",
);
check(
  "and unexplained is a permitted answer",
  short.ok && short.close!.reason === "UNEXPLAINED",
  "an honest unexplained difference is worth more than a fabricated explanation, and a pattern of them is the finding",
);
check(
  "the warning says which way and by how much",
  short.warnings.some((w) => w.includes("Shortfall")),
  short.warnings[0] ?? "",
);

const lying = await closeDay({
  ownerId: OWNER,
  showroomId: branch.id,
  closeDate: "2026-08-21",
  countedCash: 1,
  reason: "EXACT",
  userId: 1,
});
check(
  "a count that differs cannot be closed as exact",
  !lying.ok && lying.error!.includes("cannot be closed as exact"),
  lying.ok ? "it closed" : lying.error!,
);

const twice = await closeDay({
  ownerId: OWNER,
  showroomId: branch.id,
  closeDate: "2026-08-20",
  countedCash: booked.expected,
  userId: 1,
});
check(
  "and a day cannot be closed twice",
  !twice.ok && twice.error!.includes("already closed"),
  twice.ok ? "it closed again" : twice.error!,
);

const diffs = await withWorkerScope(() =>
  dayCloseDifferences({ ownerId: OWNER, from: "2026-08-01", to: "2026-08-31" }),
);
check(
  "and the month's differences are a list, not a total",
  diffs.rows.length >= 1 && diffs.unexplained >= 1,
  `${diffs.rows.length} day(s) out, ${diffs.unexplained} unexplained, net ${rupees(diffs.total)}`,
);

const nextDay = await withWorkerScope(() =>
  bookedCashFor({ ownerId: OWNER, showroomId: branch.id, closeDate: "2026-08-21" }),
);
check(
  "**tomorrow opens with what was counted, not with what was booked**",
  nextDay.opening === round2(booked.expected - 900),
  "carrying the booked figure forward would make one bad evening haunt the till forever",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. nothing unattended may settle a debt");

let denied = "";
try {
  await withWorkerScope(async () => {
    await db.insert(billAllocationsTable).values({
      ownerId: OWNER,
      moneyDocumentId: vague.document!.id,
      partyBillId: billA.id,
      amount: "1.00",
    });
  });
} catch (e) {
  const chain: string[] = [];
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    chain.push(String((err as Error).message ?? err));
  }
  denied = chain.join(" | ");
}
check(
  "the scheduler cannot allocate money to a bill",
  denied.includes("permission denied"),
  denied.split(" | ").find((m) => m.includes("permission denied")) ?? denied ?? "it allocated",
);

// ────────────────────────────────────────────────────────────────────────────

await wipe();
console.log("\n  (every receipt, allocation, bill and day close this run made, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. Three payments settle one invoice exactly, and money with no instruction waits.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
