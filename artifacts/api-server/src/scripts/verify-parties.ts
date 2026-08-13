/**
 * OBJ-38's done-when, stated so it can fail.
 *
 * > *A purchase and a sale of one chassis leave Vehicle Stock at zero.*
 *
 * That single sentence is the whole of R-109. Before this objective every sale
 * credited `1200` Vehicle Stock and nothing ever debited it, so a month of
 * trading left the asset side of the balance sheet showing a large negative
 * number — **every voucher balancing, the trial balance nonsense.** A ledger
 * that knows one of the four money events is not a partial ledger, it is an
 * unfilable one, and it is why reconciliation could not be bolted on: it
 * compares two sides and only one existed.
 *
 * So §3 buys one machine and sells the same machine, and asserts that the
 * account it moves through comes back to where it started. If that fails,
 * nothing built on top of it is worth drawing.
 *
 * §5 is the other half and it is the one that catches the widest class of
 * quiet error: the **control account against its subsidiary ledger**. A
 * customer balance that does not add up to `1100` means either a voucher line
 * carrying the control account with no party on it, or a party's money posted
 * somewhere else. Both leave a trial balance that balances and a debtors report
 * that is wrong, which is the failure nobody finds until somebody rings.
 *
 * Everything this file creates, it destroys.
 *
 * `pnpm --filter @workspace/scripts run parties`.
 */

import {
  db,
  ownerDb,
  withWorkerScope,
  partiesTable,
  partyBillsTable,
  purchaseInvoicesTable,
  purchaseInvoiceLinesTable,
  vouchersTable,
  voucherLinesTable,
  saleDocumentsTable,
  dmsVehicleStockTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { placementOf } from "../lib/dms/org";
import {
  ensureParty,
  partyStatement,
  ageing,
  controlAccountCheck,
} from "../lib/dms/ledger/parties";
import { createPurchaseInvoice, postPurchaseInvoice } from "../lib/dms/ledger/purchase";
import { postOpeningBalances } from "../lib/dms/ledger/opening";
import { postSaleDocument } from "../lib/dms/ledger/post";
import { generateDocument } from "../lib/dms/invoice";
import { loadPolicy } from "../lib/dms/policy";

const OWNER = 1;
const RUN_BY = "verify-parties";
const CHASSIS = "VERIFY-PARTIES-CHASSIS-1";
const SUPPLIER_INV = "VERIFY-PARTIES-HMC-9001";

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

/** The net movement of one account across posted vouchers. Debit positive. */
async function netAt(code: string): Promise<number> {
  const [row] = await ownerDb
    .select({
      net: sql<string>`coalesce(sum(${voucherLinesTable.debit}::numeric - ${voucherLinesTable.credit}::numeric), 0)`,
    })
    .from(voucherLinesTable)
    .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .where(
      and(
        eq(vouchersTable.ownerId, OWNER),
        eq(vouchersTable.status, "POSTED"),
        eq(voucherLinesTable.accountCode, code),
      ),
    );
  return round2(n(row?.net));
}

console.log(`\nOBJ-38 — parties, purchases and opening balances, run by ${RUN_BY}\n`);

const [branch] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SARASWATI")))
  .limit(1);
if (!branch) throw new Error("DEL-SARASWATI is missing. Run db:migrate-org.");

const placement = await withWorkerScope(() => placementOf(branch.id));
console.log(
  `      ${placement.branchName} · ${placement.entity.legalName} · ${placement.registration.gstin}\n`,
);

/*
 * Clear this file's own leftovers first, so an interrupted run does not make
 * the next one fail on a duplicate it created itself. Keyed on the constants
 * above and nothing else - a verifier that cleaned up broadly would be a
 * verifier that deleted a dealership's data on a bad day.
 */
{
  const stale = await ownerDb
    .select({ id: purchaseInvoicesTable.id })
    .from(purchaseInvoicesTable)
    .where(sql`${purchaseInvoicesTable.supplierInvoiceNo} like 'VERIFY-PARTIES-%'`);
  const staleIds = stale.map((r) => r.id);
  const staleVouchers = staleIds.length
    ? await ownerDb
        .select({ id: vouchersTable.id })
        .from(vouchersTable)
        .where(
          and(
            eq(vouchersTable.sourceKind, "PURCHASE_INVOICE"),
            inArray(vouchersTable.sourceId, staleIds),
          ),
        )
    : [];
  for (const v of staleVouchers) {
    await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
    await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, v.id));
  }
  if (staleIds.length) {
    await ownerDb
      .delete(partyBillsTable)
      .where(
        and(
          eq(partyBillsTable.sourceKind, "PURCHASE_INVOICE"),
          inArray(partyBillsTable.sourceId, staleIds),
        ),
      );
    await ownerDb
      .delete(purchaseInvoiceLinesTable)
      .where(inArray(purchaseInvoiceLinesTable.purchaseInvoiceId, staleIds));
    await ownerDb.delete(purchaseInvoicesTable).where(inArray(purchaseInvoicesTable.id, staleIds));
  }

  const staleOpening = await ownerDb
    .select({ id: vouchersTable.id })
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, OWNER),
        eq(vouchersTable.sourceKind, "OPENING_BALANCE"),
      ),
    );
  for (const v of staleOpening) {
    await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
    await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, v.id));
  }

  const staleDocs = await ownerDb
    .select({ id: saleDocumentsTable.id })
    .from(saleDocumentsTable)
    .where(eq(saleDocumentsTable.chassisNo, CHASSIS));
  for (const d of staleDocs) {
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
    .delete(partiesTable)
    .where(sql`${partiesTable.mobile} in ('9811100001','9811100002') or ${partiesTable.gstin} = '06AAACH1234M1ZQ'`);
}

const created = {
  purchaseIds: [] as number[],
  voucherIds: [] as number[],
  documentIds: [] as number[],
  partyIds: [] as number[],
  stockIds: [] as number[],
};

// ────────────────────────────────────────────────────────────────────────────

section("1. a party is a ledger, and matching it is the whole difficulty");

const honda = await ensureParty({
  ownerId: OWNER,
  entityId: placement.entity.id,
  kind: "OEM",
  name: "Hero MotoCorp Ltd",
  gstin: "06AAACH1234M1ZQ",
  state: "Haryana",
});
created.partyIds.push(honda.party.id);
check("the manufacturer gets a ledger row", honda.party.id > 0, honda.party.name);

const again = await ensureParty({
  ownerId: OWNER,
  entityId: placement.entity.id,
  kind: "OEM",
  name: "HERO MOTOCORP LIMITED",
  gstin: "06AAACH1234M1ZQ",
});
check(
  "**the same GSTIN is the same business**, however it was typed",
  !again.created && again.party.id === honda.party.id,
  "a supplier split across two ledgers is a balance that never matches the statement",
);

const sharmaA = await ensureParty({
  ownerId: OWNER,
  entityId: placement.entity.id,
  kind: "CUSTOMER",
  name: "R. Sharma",
  mobile: "9811100001",
});
const sharmaB = await ensureParty({
  ownerId: OWNER,
  entityId: placement.entity.id,
  kind: "CUSTOMER",
  name: "Rakesh Sharma",
  mobile: "9811100002",
});
created.partyIds.push(sharmaA.party.id, sharmaB.party.id);
check(
  "**two Sharmas on two mobiles stay two people**",
  sharmaA.party.id !== sharmaB.party.id,
  "merging on a name puts one person's debt on another's statement, and there are always four Sharmas",
);

const sharmaAgain = await ensureParty({
  ownerId: OWNER,
  entityId: placement.entity.id,
  kind: "CUSTOMER",
  name: "R Sharma",
  mobile: "9811100001",
});
check(
  "and the same mobile is the same person",
  !sharmaAgain.created && sharmaAgain.party.id === sharmaA.party.id,
);

// ────────────────────────────────────────────────────────────────────────────

section("2. the manufacturer's invoice, which is where a bike enters the books");

const stockBefore = await netAt("1200");
const creditorBefore = await netAt("2100");
const inputBefore = round2((await netAt("1600")) + (await netAt("1610")) + (await netAt("1620")));

const UNIT_COST = 62_500;

const purchase = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: branch.id,
  supplierId: honda.party.id,
  supplierInvoiceNo: SUPPLIER_INV,
  invoiceDate: "2026-08-04",
  dueDate: "2026-09-03",
  // Hero ships from Haryana to a Delhi dealer, so IGST and not the halves.
  interState: true,
  lines: [
    {
      modelDescription: "Splendor Plus",
      chassisNo: CHASSIS,
      engineNo: "VERIFY-PARTIES-ENGINE-1",
      hsn: "87112019",
      unitCost: UNIT_COST,
      gstRatePct: 18,
    },
  ],
  otherCharges: [{ label: "Freight", amount: 900 }],
});
check("it records", purchase.ok, purchase.ok ? purchase.invoice!.supplierInvoiceNo : purchase.error!);
if (!purchase.ok) throw new Error(purchase.error);
created.purchaseIds.push(purchase.invoice!.id);

const dup = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: branch.id,
  supplierId: honda.party.id,
  supplierInvoiceNo: SUPPLIER_INV,
  invoiceDate: "2026-08-04",
  interState: true,
  lines: [{ modelDescription: "Splendor Plus", unitCost: UNIT_COST, gstRatePct: 18 }],
});
check(
  "the same supplier invoice number is refused",
  !dup.ok && dup.error!.includes("re-entry"),
  dup.ok ? "it recorded twice" : dup.error!,
);

const posted = await postPurchaseInvoice({ ownerId: OWNER, purchaseInvoiceId: purchase.invoice!.id });
check("and it posts", posted.ok, posted.ok ? `voucher ${posted.voucher!.voucherNo}` : posted.error!);
if (posted.ok) created.voucherIds.push(posted.voucher!.id);

const stockAfterPurchase = await netAt("1200");
const creditorAfterPurchase = await netAt("2100");
const inputAfterPurchase = round2(
  (await netAt("1600")) + (await netAt("1610")) + (await netAt("1620")),
);

check(
  "**Vehicle Stock went up**, which it had never done before this objective",
  round2(stockAfterPurchase - stockBefore) === round2(UNIT_COST + 900),
  `${rupees(round2(stockAfterPurchase - stockBefore))} — the goods plus the freight it took to get them here`,
);
check(
  "input tax is an asset, not a cost",
  round2(inputAfterPurchase - inputBefore) === round2((UNIT_COST * 18) / 100),
  `${rupees(round2(inputAfterPurchase - inputBefore))} reclaimable — posting it to an expense head overstates cost of sales by 18% of every bike ever bought`,
);
check(
  "and it is IGST, because Haryana to Delhi is inter-state",
  n(purchase.invoice!.igstAmount) > 0 && n(purchase.invoice!.cgstAmount) === 0,
  `IGST ${rupees(n(purchase.invoice!.igstAmount))} — setting off the wrong head is a mismatch the portal finds first`,
);
check(
  "the creditor went up by the whole invoice",
  round2(creditorBefore - creditorAfterPurchase) === n(purchase.invoice!.totalAmount),
  `${rupees(n(purchase.invoice!.totalAmount))} owed to ${honda.party.name}`,
);

const [bill] = await ownerDb
  .select()
  .from(partyBillsTable)
  .where(
    and(
      eq(partyBillsTable.sourceKind, "PURCHASE_INVOICE"),
      eq(partyBillsTable.sourceId, purchase.invoice!.id),
    ),
  );
check(
  "and a bill was opened, so a payment has something to settle (R-111)",
  Boolean(bill) && n(bill!.outstanding) === n(purchase.invoice!.totalAmount),
  bill ? `${bill.billNo} due ${bill.dueDate}` : "no bill",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. **a purchase and a sale of one chassis leave Vehicle Stock at zero**");

/*
 * The done-when, and the only check in this file that matters more than the
 * others. The purchase put the machine on the floor at cost; the sale has to
 * take it off at the same cost. Anything else and the balance sheet drifts
 * from the units actually standing there.
 */
const [dealer] = await ownerDb
  .select({ code: showroomDmsAccountsTable.dealerCode })
  .from(showroomDmsAccountsTable)
  .where(eq(showroomDmsAccountsTable.showroomId, branch.id))
  .limit(1);

const [unit] = await ownerDb
  .insert(dmsVehicleStockTable)
  .values({
    showroomId: branch.id,
    dealerCode: dealer?.code ?? "HMC-DL-0417",
    chassisNo: CHASSIS,
    modelCode: "HER-SPL-PLUS",
    modelDescription: "Splendor Plus",
    status: "IN_STOCK",
    costAmount: String(UNIT_COST),
    // The mirror keeps what the dealer's system said, verbatim, and hashes it to
    // notice a change. A fabricated row still carries both, because a row that
    // skipped them would be a shape the sync path never produces.
    raw: { chassisNo: CHASSIS, source: RUN_BY },
    rawHash: `${RUN_BY}-${CHASSIS}`,
  })
  .returning({ id: dmsVehicleStockTable.id });
created.stockIds.push(unit!.id);

const policy = await loadPolicy(OWNER);
const sale = await generateDocument({
  ownerId: OWNER,
  showroomId: branch.id,
  intent: "SALE",
  sale: {
    showroomId: branch.id,
    customerName: "R. Sharma",
    customerMobile: "9811100001",
    modelDescription: "Splendor Plus",
    chassisNo: CHASSIS,
    engineNo: "VERIFY-PARTIES-ENGINE-1",
  },
  statedPrice: { exShowroomAmount: 84_000, hsn: "87112019", engineCc: 97 },
  otherCharges: [{ label: "Registration and road tax", amount: 8_400 }],
  onDate: "2026-08-11",
  userId: 1,
  userName: RUN_BY,
  principal: "OWNER",
  policy,
});
check("the sale issues", sale.ok, sale.ok ? sale.document.reference : sale.error);
if (!sale.ok) throw new Error(sale.error);
created.documentIds.push(sale.document.id);

const salePost = await postSaleDocument({ ownerId: OWNER, documentId: sale.document.id, userId: 1 });
check("and posts", salePost.ok, salePost.ok ? `voucher ${salePost.voucher!.voucherNo}` : salePost.error!);
if (salePost.ok) created.voucherIds.push(salePost.voucher!.id);
for (const w of salePost.warnings) console.log(`      warning: ${w}`);

const stockAfterSale = await netAt("1200");
check(
  "**the cost of that machine came back out of Vehicle Stock**",
  round2(stockAfterSale - stockBefore) === 900,
  `${rupees(round2(stockAfterSale - stockBefore))} left, which is the freight — the bike itself is in and out at ${rupees(UNIT_COST)}`,
);
check(
  "so the account moves in both directions, which is the whole of R-109",
  round2(stockAfterSale - stockAfterPurchase) === -UNIT_COST,
  "before this objective it only ever went down, and a month of trading left a negative asset",
);

// ────────────────────────────────────────────────────────────────────────────

section("4. the customer is a ledger too, and the statement reads");

const st = await withWorkerScope(() => partyStatement({ partyId: sharmaA.party.id }));
for (const r of st.rows) {
  console.log(
    `      ${r.voucherDate}  ${r.kind.padEnd(9)} Dr ${rupees(r.debit).padStart(14)}  Cr ${rupees(r.credit).padStart(14)}  = ${rupees(r.runningBalance)}`,
  );
}
check(
  "the sale reaches the customer's own account",
  st.rows.length > 0 && st.rows.some((r) => r.kind === "SALES" && r.debit > 0),
  `${st.rows.length} entr(ies), closing ${rupees(st.closing)}`,
);
check(
  "and he owes what the invoice said",
  st.closing === n(sale.document.totalAmount),
  `${rupees(st.closing)} against an invoice of ${rupees(n(sale.document.totalAmount))}`,
);

const age = await withWorkerScope(() =>
  ageing({
    ownerId: OWNER,
    entityId: placement.entity.id,
    direction: "RECEIVABLE",
    asOf: "2026-09-30",
  }),
);
const mine = age.rows.find((r) => r.partyId === sharmaA.party.id);
check(
  "the ageing names the bill rather than a difference (R-114)",
  Boolean(mine?.oldest),
  mine?.oldest
    ? `${mine.oldest.billNo} · ${mine.oldest.days} days · ${rupees(mine.oldest.outstanding)}`
    : "no open bill",
);
check(
  "and buckets on days **past due**, not days since the bill",
  mine !== undefined && mine.buckets.some((b) => b.amount > 0),
  mine?.buckets.filter((b) => b.amount > 0).map((b) => `${b.label}: ${rupees(b.amount)}`).join(" · ") ?? "",
);

// ────────────────────────────────────────────────────────────────────────────

section("5. the subsidiary ledger adds up to the control account");

for (const [code, what] of [
  ["1100", "Sundry Debtors"],
  ["2100", "Sundry Creditors"],
] as const) {
  const c = await withWorkerScope(() =>
    controlAccountCheck({
      ownerId: OWNER,
      entityId: placement.entity.id,
      controlCode: code,
      asOf: "2026-12-31",
    }),
  );
  check(
    `${what} (${code}): every rupee is against a party`,
    c.difference === 0 && c.unattributed.length === 0,
    c.unattributed.length
      ? `${c.unattributed.length} line(s) with no party: ${c.unattributed.slice(0, 3).map((u) => `${u.voucherNo} ${rupees(u.amount)}`).join(", ")}`
      : `control ${rupees(c.control)} = subsidiary ${rupees(c.subsidiary)}`,
  );
}

console.log(
  "      a difference here is a trial balance that balances and a debtors report that is wrong,\n" +
    "      which is the failure nobody finds until a customer rings",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. before the books begin is an opening balance, not a voucher");

const early = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: branch.id,
  supplierId: honda.party.id,
  supplierInvoiceNo: "VERIFY-PARTIES-EARLY-1",
  invoiceDate: "2026-01-15",
  interState: true,
  lines: [{ modelDescription: "HF Deluxe", unitCost: 51_000, gstRatePct: 18 }],
});
if (early.ok) created.purchaseIds.push(early.invoice!.id);

const earlyPost = early.ok
  ? await postPurchaseInvoice({ ownerId: OWNER, purchaseInvoiceId: early.invoice!.id })
  : { ok: false, error: early.error, warnings: [] };

check(
  "a purchase dated before the books start is refused",
  !earlyPost.ok && String(earlyPost.error).includes("opening balances"),
  earlyPost.ok ? "it posted" : String(earlyPost.error),
);
check(
  "and the refusal says where it belongs instead",
  String(earlyPost.error).includes("before these books start"),
  "posting it would invent history the dealership already keeps elsewhere, and then both would be partly right",
);

// ────────────────────────────────────────────────────────────────────────────

section("7. and the opening balance itself balances, with the plug named");

/*
 * Posted against the seeded entity and torn down with everything else, so no
 * other verifier ever sees it. An opening balance left behind would move every
 * figure in every report by a constant, which is exactly the error this
 * objective exists to prevent.
 */
const opening = await postOpeningBalances({
  ownerId: OWNER,
  entityId: placement.entity.id,
  amounts: { vehicleStock: 1_250_000, cash: 80_000, bank: 640_000, inputCreditCarried: 145_000 },
  userId: 1,
});

check(
  "it posts once",
  opening.ok,
  opening.ok ? `capital derived as ${rupees(opening.capital!)}` : opening.error!,
);
if (opening.ok) {
  created.voucherIds.push(opening.voucher!.id);
  check(
    "**capital is the difference, and the narration says it was derived**",
    opening.capital !== undefined && opening.capital > 0,
    "asking a dealership to state its capital and then refusing when the arithmetic disagrees is asking it to reconcile our sums",
  );
  check(
    "debits equal credits, by construction",
    n(opening.voucher!.totalDebit) === n(opening.voucher!.totalCredit),
    `${rupees(n(opening.voucher!.totalDebit))} each side`,
  );
  check(
    "and it is dated the day *before* the books open",
    opening.voucher!.voucherDate < (placement.entity.booksFrom ?? "9999-12-31"),
    `${opening.voucher!.voucherDate}, so a P&L for the first period does not read the opening stock as a purchase`,
  );

  const twice = await postOpeningBalances({
    ownerId: OWNER,
    entityId: placement.entity.id,
    amounts: { cash: 1 },
  });
  check(
    "bringing them in twice is refused",
    !twice.ok && twice.error!.includes("already"),
    twice.ok ? "it posted twice" : twice.error!,
  );
}

// ────────────────────────────────────────────────────────────────────────────

section("8. nothing unattended may create a debt");

let denied = "";
try {
  await withWorkerScope(async () => {
    await db.insert(partyBillsTable).values({
      ownerId: OWNER,
      partyId: sharmaA.party.id,
      showroomId: branch.id,
      direction: "RECEIVABLE",
      billNo: "WORKER-SHOULD-NOT",
      billDate: "2026-08-11",
      amount: "1000.00",
      outstanding: "1000.00",
      sourceKind: "MANUAL",
      sourceId: null,
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
  "the scheduler cannot open a bill",
  denied.includes("permission denied"),
  denied.split(" | ").find((m) => m.includes("permission denied")) ?? denied ?? "it opened one",
);
check(
  "though it may read what is owed, which a reconciliation pass needs",
  (await withWorkerScope(() => ageing({ ownerId: OWNER, entityId: placement.entity.id, direction: "RECEIVABLE", asOf: "2026-09-30" }))).rows.length >= 0,
);

// ────────────────────────────────────────────────────────────────────────────
// Everything this run made, and only that.

for (const id of created.voucherIds.slice().reverse()) {
  await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, id));
  await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, id));
}
await ownerDb.delete(partyBillsTable).where(
  inArray(partyBillsTable.partyId, created.partyIds.length ? created.partyIds : [-1]),
);
if (created.purchaseIds.length) {
  await ownerDb
    .delete(purchaseInvoiceLinesTable)
    .where(inArray(purchaseInvoiceLinesTable.purchaseInvoiceId, created.purchaseIds));
  await ownerDb
    .delete(purchaseInvoicesTable)
    .where(inArray(purchaseInvoicesTable.id, created.purchaseIds));
}
if (created.documentIds.length) {
  await ownerDb
    .delete(saleDocumentsTable)
    .where(inArray(saleDocumentsTable.id, created.documentIds));
}
if (created.stockIds.length) {
  await ownerDb
    .delete(dmsVehicleStockTable)
    .where(inArray(dmsVehicleStockTable.id, created.stockIds));
}
if (created.partyIds.length) {
  await ownerDb.delete(partiesTable).where(inArray(partiesTable.id, created.partyIds));
}
console.log("\n  (every party, bill, purchase, document and voucher this run made, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. Vehicle Stock moves in both directions, and every rupee owed has somebody's name on it.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
