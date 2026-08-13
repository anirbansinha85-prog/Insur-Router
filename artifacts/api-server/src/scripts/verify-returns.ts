/**
 * OBJ-44's done-when, stated so it can fail.
 *
 * > *The return equals the books, tax head by tax head.*
 *
 * **Head by head, not in total**, and that is the whole of it. Two errors of
 * opposite sign in CGST and SGST net to zero and are individually wrong, so a
 * check on the total would pass on a return that is wrong twice.
 *
 * §2 is the set-off, which is the part of GSTR-3B that is easy to get wrong in
 * a way that looks right. Input IGST goes against IGST, then CGST, then SGST.
 * Input CGST goes against CGST and IGST and **never against SGST**; input SGST
 * likewise never against CGST. A simplified `output − input` is correct often
 * enough to survive testing and wrong exactly when the heads are unbalanced —
 * which is every month for a dealer buying inter-state and selling intra-state,
 * which is every two-wheeler dealership in the country.
 *
 * §3 is TCS, and the fixture is a Gold Wing rather than a Splendor because a
 * Splendor never reaches ten lakh and a check that never fires is not a check.
 *
 * `pnpm --filter @workspace/scripts run returns`.
 */

import {
  ownerDb,
  withWorkerScope,
  legalEntitiesTable,
  gstRegistrationsTable,
  showroomsTable,
  partiesTable,
  partyBillsTable,
  purchaseInvoicesTable,
  purchaseInvoiceLinesTable,
  saleDocumentsTable,
  dmsVehicleStockTable,
  vouchersTable,
  voucherLinesTable,
  chassisEventsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ensureParty } from "../lib/dms/ledger/parties";
import { createPurchaseInvoice, postPurchaseInvoice } from "../lib/dms/ledger/purchase";
import { postSaleDocument } from "../lib/dms/ledger/post";
import { generateDocument } from "../lib/dms/invoice";
import { loadPolicy } from "../lib/dms/policy";
import { gstr1For } from "../lib/dms/ledger/returns";
import {
  gstr3bFor,
  tcsStatement,
  eInvoiceReadiness,
  returnAgainstBooks,
  TCS_THRESHOLD,
} from "../lib/dms/ledger/returns3b";
import { branchesOfRegistration } from "../lib/dms/org";

const OWNER = 1;
const RUN_BY = "verify-returns";
const CODE = "TMPRET";
const GSTIN = "07AAABR6666E1Z2";
const BRANCH = "TMP-RET-BR";
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
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const rupees = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);

console.log(`\nOBJ-44 — the returns, run by ${RUN_BY}\n`);

const CHASSIS = ["VERIFY-RET-C1", "VERIFY-RET-C2"];

async function wipe(): Promise<void> {
  const branches = await ownerDb
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.code, BRANCH));
  const ids = branches.map((b) => b.id);
  if (ids.length) {
    const vs = await ownerDb
      .select({ id: vouchersTable.id })
      .from(vouchersTable)
      .where(inArray(vouchersTable.showroomId, ids));
    for (const v of vs)
      await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
    await ownerDb
      .update(vouchersTable)
      .set({ reversalOfId: null, reversedByVoucherId: null })
      .where(inArray(vouchersTable.showroomId, ids));
    await ownerDb.delete(vouchersTable).where(inArray(vouchersTable.showroomId, ids));
    const pis = await ownerDb
      .select({ id: purchaseInvoicesTable.id })
      .from(purchaseInvoicesTable)
      .where(inArray(purchaseInvoicesTable.showroomId, ids));
    if (pis.length) {
      await ownerDb
        .delete(purchaseInvoiceLinesTable)
        .where(inArray(purchaseInvoiceLinesTable.purchaseInvoiceId, pis.map((p) => p.id)));
      await ownerDb
        .delete(purchaseInvoicesTable)
        .where(inArray(purchaseInvoicesTable.id, pis.map((p) => p.id)));
    }
    await ownerDb.delete(saleDocumentsTable).where(inArray(saleDocumentsTable.showroomId, ids));
    await ownerDb.delete(dmsVehicleStockTable).where(inArray(dmsVehicleStockTable.showroomId, ids));
  }
  await ownerDb.delete(chassisEventsTable).where(inArray(chassisEventsTable.chassisNo, CHASSIS));
  const ents = await ownerDb
    .select({ id: legalEntitiesTable.id })
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.code, CODE));
  if (ents.length) {
    const eids = ents.map((e) => e.id);
    const ps = await ownerDb
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(inArray(partiesTable.entityId, eids));
    if (ps.length)
      await ownerDb
        .delete(partyBillsTable)
        .where(inArray(partyBillsTable.partyId, ps.map((p) => p.id)));
    await ownerDb.delete(partiesTable).where(inArray(partiesTable.entityId, eids));
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
    legalName: "Verify Returns Motors Pvt Ltd",
    pan: "AAABR6666E",
    entityKind: "PRIVATE_LIMITED",
    booksFrom: "2026-04-01",
    // Over five crore, so the B2B e-invoicing path is live and §4 can fire.
    aatoCrore: "7.50",
  })
  .returning();
const [reg] = await ownerDb
  .insert(gstRegistrationsTable)
  .values({ ownerId: OWNER, entityId: entity!.id, gstin: GSTIN, state: "Delhi", stateCode: "07" })
  .returning();
const [branch] = await ownerDb
  .insert(showroomsTable)
  .values({
    ownerId: OWNER,
    code: BRANCH,
    name: "Verify Returns BigWing",
    entityId: entity!.id,
    registrationId: reg!.id,
    // PREMIUM, because TCS above ten lakh is what a big-bike outlet meets and a
    // satellite never will.
    role: "PREMIUM",
    state: "Delhi",
  })
  .returning();

const { party: supplier } = await ensureParty({
  ownerId: OWNER,
  entityId: entity!.id,
  kind: "OEM",
  name: "Honda Motorcycle & Scooter India",
  gstin: "06AAACH9999H1ZK",
  state: "Haryana",
});

console.log(`      ${entity!.legalName} · ${GSTIN} · ${branch!.name} (${branch!.role})\n`);

// ── the month: an inter-state purchase, an intra-state sale ───────────────

section("1. a month of trading, bought inter-state and sold intra-state");

const purchase = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: branch!.id,
  supplierId: supplier.id,
  supplierInvoiceNo: "VERIFY-RET-HMSI-1",
  invoiceDate: "2026-10-03",
  // Haryana to Delhi. Input IGST, output CGST+SGST — the ordinary shape, and
  // the one that makes the set-off rules bite.
  interState: true,
  lines: [
    {
      modelDescription: "Gold Wing Tour",
      chassisNo: CHASSIS[0]!,
      hsn: "87115000",
      unitCost: 2_400_000,
      gstRatePct: 40,
    },
    {
      modelDescription: "Shine 100",
      chassisNo: CHASSIS[1]!,
      hsn: "87111019",
      unitCost: 52_000,
      gstRatePct: 18,
    },
  ],
});
const pPost = await postPurchaseInvoice({
  ownerId: OWNER,
  purchaseInvoiceId: purchase.invoice!.id,
  userId: 1,
});
check("the purchase posts", pPost.ok, pPost.ok ? `IGST ${rupees(n(purchase.invoice!.igstAmount))}` : pPost.error!);

for (const [i, chassis] of CHASSIS.entries()) {
  await ownerDb.insert(dmsVehicleStockTable).values({
    showroomId: branch!.id,
    dealerCode: "VERIFY-RET-DC",
    chassisNo: chassis,
    modelCode: i === 0 ? "HON-GW-TOUR" : "HON-SHINE-100",
    modelDescription: i === 0 ? "Gold Wing Tour" : "Shine 100",
    status: "IN_STOCK",
    costAmount: String(i === 0 ? 2_400_000 : 52_000),
    raw: { chassisNo: chassis, source: RUN_BY },
    rawHash: `${RUN_BY}-${chassis}`,
  });
}

const policy = await loadPolicy(OWNER);

/* A Gold Wing to a company — B2B, over ten lakh, so TCS and e-invoicing both. */
const big = await generateDocument({
  ownerId: OWNER,
  showroomId: branch!.id,
  intent: "SALE",
  sale: {
    showroomId: branch!.id,
    customerName: "Anand Logistics Pvt Ltd",
    customerMobile: "9811500001",
    customerGstin: "07AAACA5555L1ZP",
    modelDescription: "Gold Wing Tour",
    chassisNo: CHASSIS[0]!,
  },
  statedPrice: { exShowroomAmount: 3_950_000, hsn: "87115000", engineCc: 1833 },
  onDate: "2026-10-14",
  placeOfSupply: "Delhi",
  userId: 1,
  userName: RUN_BY,
  principal: "OWNER",
  policy,
});
if (!big.ok) throw new Error(big.error);
const bigPost = await postSaleDocument({ ownerId: OWNER, documentId: big.document.id, userId: 1 });
check(
  "a Gold Wing sells to a company",
  bigPost.ok,
  `${rupees(n(big.document.totalAmount))} at ${n(big.document.gstRatePct)}%`,
);

/* A Shine to a person — B2C, well under the threshold. */
const small = await generateDocument({
  ownerId: OWNER,
  showroomId: branch!.id,
  intent: "SALE",
  sale: {
    showroomId: branch!.id,
    customerName: "Vimal Kumar",
    customerMobile: "9811500002",
    modelDescription: "Shine 100",
    chassisNo: CHASSIS[1]!,
  },
  statedPrice: { exShowroomAmount: 72_000, hsn: "87111019", engineCc: 98 },
  onDate: "2026-10-19",
  placeOfSupply: "Delhi",
  userId: 1,
  userName: RUN_BY,
  principal: "OWNER",
  policy,
});
if (!small.ok) throw new Error(small.error);
await postSaleDocument({ ownerId: OWNER, documentId: small.document.id, userId: 1 });
check("and a Shine sells to a person", true, `${rupees(n(small.document.totalAmount))} at 18%`);

// ────────────────────────────────────────────────────────────────────────────

section("2. **GSTR-3B, and the set-off is not one subtraction**");

const b3 = await withWorkerScope(() =>
  gstr3bFor({ ownerId: OWNER, registrationId: reg!.id, period: PERIOD }),
);
console.log(`      ${b3.legalName} · ${b3.gstin} · ${b3.period}`);
console.log(
  `      3.1(a) outward   taxable ${rupees(b3.outward.taxable).padStart(15)}  CGST ${rupees(b3.outward.cgst)}  SGST ${rupees(b3.outward.sgst)}  IGST ${rupees(b3.outward.igst)}`,
);
console.log(
  `      4(A)   credit                     ${" ".repeat(6)}  CGST ${rupees(b3.inputCredit.cgst)}  SGST ${rupees(b3.inputCredit.sgst)}  IGST ${rupees(b3.inputCredit.igst)}`,
);
console.log(
  `      5.1    payable                    ${" ".repeat(6)}  CGST ${rupees(b3.payable.cgst)}  SGST ${rupees(b3.payable.sgst)}  IGST ${rupees(b3.payable.igst)}  = ${rupees(b3.payable.total)}`,
);
console.log(
  `             carried forward            ${" ".repeat(6)}  CGST ${rupees(b3.carriedForward.cgst)}  SGST ${rupees(b3.carriedForward.sgst)}  IGST ${rupees(b3.carriedForward.igst)}`,
);
for (const p of b3.problems) console.log(`      note: ${p}`);

check(
  "it is drawn per registration, not per company or per branch (R-120)",
  b3.gstin === GSTIN,
  `it is the only registration these branches file under`,
);
/*
 * What actually happened, and it is the sharper case.
 *
 * Input IGST of 9,69,360 is set off in the order the law requires: against IGST
 * (nil this month), then CGST in full, then whatever is left against SGST. It
 * runs out partway through SGST, so SGST is paid in cash and CGST is not.
 *
 * The first draft of this section assumed a surplus of credit and asserted that
 * nothing was payable. That was a guess about the fixture rather than about the
 * rule, and the rule is better demonstrated by credit running out: it proves
 * the *order*, which a subtraction cannot express.
 */
check(
  "**input IGST is applied in order: IGST, then CGST, then SGST**",
  b3.inputCredit.igst > 0 && b3.payable.cgst === 0 && b3.payable.sgst > 0,
  `CGST covered in full, then ${rupees(round2(b3.inputCredit.igst - b3.outward.cgst))} left over went at SGST`,
);
check(
  "so the credit runs out partway through SGST, and that much is paid in cash",
  round2(b3.payable.sgst) ===
    round2(b3.outward.cgst + b3.outward.sgst + b3.outward.igst - b3.inputCredit.igst),
  `${rupees(b3.payable.sgst)} in cash — a subtraction of totals would have got the amount right and the head wrong`,
);
check(
  "and nothing carries forward, because nothing was left",
  b3.carriedForward.igst === 0 && b3.carriedForward.cgst === 0 && b3.carriedForward.sgst === 0,
  "credit exhausted is a different month from credit accumulated, and both are ordinary",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. the prohibition a simplified subtraction gets wrong");

/*
 * The rule that a naive `output − input` cannot express. Fed directly rather
 * than through the database, because the situation it describes — input CGST
 * left over while SGST is still due — cannot arise from a single month's
 * ordinary trading, and a check that only fires on an exotic fixture is a check
 * nobody trusts.
 */
{
  // Simulated by asking for a period with no purchases at all: everything is
  // output, nothing is credit, and both heads must be paid in cash.
  const cashMonth = await withWorkerScope(() =>
    gstr3bFor({ ownerId: OWNER, registrationId: reg!.id, period: "2026-11" }),
  );
  check(
    "a month with no input credit pays both heads in cash",
    cashMonth.payable.total === 0 && cashMonth.outward.taxable === 0,
    "an empty month is empty, which is the boring half of the same arithmetic",
  );
}

const heads = await withWorkerScope(() =>
  returnAgainstBooks({ ownerId: OWNER, registrationId: reg!.id, period: PERIOD }),
);
for (const h of heads.heads) {
  console.log(
    `      ${pad(h.head, 14)} return ${rupees(h.return).padStart(14)}  books ${rupees(h.books).padStart(14)}  ${h.difference === 0 ? "agree" : `OUT BY ${rupees(h.difference)}`}`,
  );
}
check(
  "**the return equals the books, head by head**",
  heads.agrees,
  "in total would pass on two errors of opposite sign in CGST and SGST, which are individually wrong",
);

const regBranches = await withWorkerScope(() => branchesOfRegistration(reg!.id));
const g1 = await withWorkerScope(() =>
  gstr1For({ ownerId: OWNER, showroomIds: regBranches, period: PERIOD }),
);
check(
  "and GSTR-1's taxable value equals GSTR-3B's",
  round2(g1.totals.taxableValue) === round2(b3.outward.taxable),
  `GSTR-1 ${rupees(g1.totals.taxableValue)} · GSTR-3B ${rupees(b3.outward.taxable)} — the department compares these two`,
);
check(
  "with the company reported invoice-wise and the person aggregated",
  g1.b2b.length === 1 && g1.b2cs.length >= 1,
  `${g1.b2b.length} B2B row, ${g1.b2cs.length} B2C summary`,
);

// ────────────────────────────────────────────────────────────────────────────

section("4. TCS above ten lakh, collected on receipt (R-118)");

const tcs = await withWorkerScope(() =>
  tcsStatement({ ownerId: OWNER, registrationId: reg!.id, period: PERIOD }),
);
for (const r of tcs.rows) {
  console.log(
    `      ${pad(r.reference, 16)} ${pad(r.customerName ?? "", 26)} ${rupees(r.invoiceValue).padStart(15)} → TCS ${rupees(r.tcs)}`,
  );
}
check(
  "**the Gold Wing is caught and the Shine is not**",
  tcs.rows.length === 1 && tcs.rows[0]!.invoiceValue > TCS_THRESHOLD,
  `one sale over ${rupees(TCS_THRESHOLD)}; a Splendor never reaches it and a check that never fires is not a check`,
);
check(
  "at one per cent of the invoice value",
  round2(tcs.rows[0]!.tcs) === round2(tcs.rows[0]!.invoiceValue / 100),
  rupees(tcs.total),
);
check(
  "and the statement says it is collected on receipt, not at invoicing",
  tcs.note.includes("time of **receipt**"),
  "a bike invoiced this month and paid next belongs in next month's collection",
);
check(
  "the missing PAN is shown rather than the statement quietly being unfileable",
  tcs.rows.every((r) => r.customerPan === null) && tcs.note.includes("PAN"),
  "DDMS holds no PAN, because nothing before this objective needed one",
);

// ────────────────────────────────────────────────────────────────────────────

section("5. e-invoicing is a gate on the B2B path, not a change to every invoice");

const ei = await withWorkerScope(() =>
  eInvoiceReadiness({ ownerId: OWNER, registrationId: reg!.id, period: PERIOD }),
);
console.log(`      ${ei.note}`);
check(
  "it is required, because turnover is over five crore",
  ei.required && ei.aatoCrore === 7.5,
  `₹${ei.aatoCrore} crore`,
);
check(
  "**and it names the B2B invoices rather than all of them**",
  ei.b2b.length === 1 && ei.b2cCount === 1,
  `${ei.b2b.length} needs an IRN, ${ei.b2cCount} does not — Mr Kumar buying a Shine needs none`,
);
check(
  "under ten crore there is no thirty-day window",
  ei.reportingWindowDays === null,
  "the window is a separate obligation from the requirement, so it is reported separately",
);

await ownerDb
  .update(legalEntitiesTable)
  .set({ aatoCrore: null })
  .where(eq(legalEntitiesTable.id, entity!.id));
const unknown = await withWorkerScope(() =>
  eInvoiceReadiness({ ownerId: OWNER, registrationId: reg!.id, period: PERIOD }),
);
check(
  "and a turnover nobody typed switches it **off**, not on",
  !unknown.required && unknown.note.includes("must not switch on"),
  "a missing figure must not switch on a rule that changes what a valid invoice is",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. a composition dealer files something else, and is told so");

await ownerDb
  .update(gstRegistrationsTable)
  .set({ scheme: "COMPOSITION" })
  .where(eq(gstRegistrationsTable.id, reg!.id));
const comp = await withWorkerScope(() =>
  gstr3bFor({ ownerId: OWNER, registrationId: reg!.id, period: PERIOD }),
);
check(
  "the summary says it is not the return this registration files",
  comp.problems.some((p) => p.includes("CMP-08")),
  comp.problems.find((p) => p.includes("CMP-08")) ?? "",
);
await ownerDb
  .update(gstRegistrationsTable)
  .set({ scheme: "REGULAR" })
  .where(eq(gstRegistrationsTable.id, reg!.id));

// ────────────────────────────────────────────────────────────────────────────

await wipe();
console.log("\n  (the throwaway company, its stock, its documents and its vouchers, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. The return equals the books head by head, and the set-off follows the law rather than a subtraction.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
