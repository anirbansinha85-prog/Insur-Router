/**
 * OBJ-42's done-when, stated so it can fail.
 *
 * > *A job card bills labour and parts as one document, and the trial balance
 * > still balances.*
 *
 * The second clause is why this objective comes after OBJ-41 rather than
 * before. Adding a second document type to books that were not yet known to
 * balance means two suspects for one difference; adding it to books that were
 * leaves exactly one.
 *
 * §2 is the distinction the whole objective turns on. Labour and parts sit at
 * 18% together today, which makes it very easy to collapse them — and they were
 * different before September 2025, GSTR-1 reports them under different codes,
 * and they credit different accounts because one relieves stock and the other
 * cannot. A product that merged them because the numbers happened to match
 * would have to be unpicked the next time they diverge.
 *
 * §4 is the one with money in it: an advance for a service already carried GST
 * when it was taken, so charging it again on the invoice charges the customer
 * twice and overstates the month's output tax.
 *
 * `pnpm --filter @workspace/scripts run service`.
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
  serviceInvoicesTable,
  serviceInvoiceLinesTable,
  vouchersTable,
  voucherLinesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ensureParty } from "../lib/dms/ledger/parties";
import { postOpeningBalances } from "../lib/dms/ledger/opening";
import { recordMoney } from "../lib/dms/ledger/money";
import {
  issueServiceInvoice,
  serviceInvoiceLines,
  warrantyClaimable,
  DEFAULT_LABOUR_SAC,
} from "../lib/dms/ledger/service";
import { trialBalance, profitAndLoss } from "../lib/dms/ledger/books";

const OWNER = 1;
const RUN_BY = "verify-service";
const CODE = "TMPSERVICE";
const GSTIN = "07AAABS8888C1Z4";
const BRANCH = "TMP-SERVICE-BR";
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

console.log(`\nOBJ-42 — billing a job card, run by ${RUN_BY}\n`);

async function wipe(): Promise<void> {
  const branchRows = await ownerDb
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(inArray(showroomsTable.code, [BRANCH, `${BRANCH}-OFF`]));
  const branchIds = branchRows.map((b) => b.id);
  if (branchIds.length) {
    const svc = await ownerDb
      .select({ id: serviceInvoicesTable.id })
      .from(serviceInvoicesTable)
      .where(inArray(serviceInvoicesTable.showroomId, branchIds));
    if (svc.length)
      await ownerDb
        .delete(serviceInvoiceLinesTable)
        .where(inArray(serviceInvoiceLinesTable.serviceInvoiceId, svc.map((x) => x.id)));
    await ownerDb
      .delete(serviceInvoicesTable)
      .where(inArray(serviceInvoicesTable.showroomId, branchIds));
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
    const vs = await ownerDb
      .select({ id: vouchersTable.id })
      .from(vouchersTable)
      .where(inArray(vouchersTable.showroomId, branchIds));
    for (const v of vs) {
      await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
      await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, v.id));
    }
  }
  const ents = await ownerDb
    .select({ id: legalEntitiesTable.id })
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.code, CODE));
  if (ents.length) {
    const ids = ents.map((e) => e.id);
    const ps = await ownerDb
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(inArray(partiesTable.entityId, ids));
    if (ps.length)
      await ownerDb
        .delete(partyBillsTable)
        .where(inArray(partyBillsTable.partyId, ps.map((p) => p.id)));
    await ownerDb.delete(partiesTable).where(inArray(partiesTable.entityId, ids));
  }
  await ownerDb.delete(showroomsTable).where(inArray(showroomsTable.code, [BRANCH, `${BRANCH}-OFF`]));
  await ownerDb.delete(gstRegistrationsTable).where(eq(gstRegistrationsTable.gstin, GSTIN));
  await ownerDb.delete(legalEntitiesTable).where(eq(legalEntitiesTable.code, CODE));
}
await wipe();

const [entity] = await ownerDb
  .insert(legalEntitiesTable)
  .values({
    ownerId: OWNER,
    code: CODE,
    legalName: "Verify Service Motors Pvt Ltd",
    pan: "AAABS8888C",
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
    serviceInvoicing: "Y",
  })
  .returning();
const [branch] = await ownerDb
  .insert(showroomsTable)
  .values({
    ownerId: OWNER,
    code: BRANCH,
    name: "Verify Service Outlet",
    entityId: entity!.id,
    registrationId: reg!.id,
    role: "SERVICE",
    state: "Delhi",
  })
  .returning();

await postOpeningBalances({
  ownerId: OWNER,
  entityId: entity!.id,
  amounts: { sparePartsStock: 200_000, cash: 25_000, bank: 100_000 },
  userId: 1,
});

const { party: customer } = await ensureParty({
  ownerId: OWNER,
  entityId: entity!.id,
  kind: "CUSTOMER",
  name: "Sunita Rane",
  mobile: "9811600001",
});

console.log(`      ${branch!.name} (${branch!.role}) · ${GSTIN}\n`);

// ────────────────────────────────────────────────────────────────────────────

section("1. **labour and parts on one document**");

const inv = await issueServiceInvoice({
  ownerId: OWNER,
  showroomId: branch!.id,
  customerId: customer.id,
  invoiceDate: "2026-09-10",
  jobCardRef: "JC-VERIFY-SERVICE-1",
  registrationNo: "DL 3S BQ 4417",
  modelDescription: "Splendor Plus",
  odometerKm: 14_820,
  lines: [
    { kind: "LABOUR", description: "Paid service — 15,000 km", unitRate: 900 },
    {
      kind: "PART",
      description: "Brake shoe set",
      partNo: "HER-BRK-SHOE-01",
      hsn: "87141090",
      quantity: 1,
      unitRate: 640,
      unitCost: 410,
    },
    {
      kind: "PART",
      description: "Engine oil 10W30, 1L",
      partNo: "HER-OIL-10W30",
      hsn: "27101981",
      quantity: 1,
      unitRate: 480,
      unitCost: 305,
    },
    {
      kind: "LABOUR",
      description: "Free service labour — third free service",
      unitRate: 700,
      coverage: "FREE_SERVICE",
    },
  ],
  userId: 1,
});
check("it issues", inv.ok, inv.ok ? inv.invoice!.invoiceNo : inv.error!);
if (!inv.ok) throw new Error(inv.error);
for (const w of inv.warnings) console.log(`      note: ${w}`);

const lines = await withWorkerScope(() => serviceInvoiceLines(inv.invoice!.id));
for (const l of lines) {
  console.log(
    `      ${pad(l.kind, 7)} ${pad(l.description, 34)} ${pad(l.sac ?? l.hsn ?? "", 9)} ${rupees(n(l.taxableAmount)).padStart(11)} ${pad(l.coverage, 13)}`,
  );
}

check(
  "the document is one bill with both classifications on it",
  lines.length === 4 && lines.some((l) => l.kind === "LABOUR") && lines.some((l) => l.kind === "PART"),
  `${lines.filter((l) => l.kind === "LABOUR").length} labour, ${lines.filter((l) => l.kind === "PART").length} parts`,
);

// ────────────────────────────────────────────────────────────────────────────

section("2. **labour carries a SAC, a part carries an HSN** (R-123)");

check(
  "every labour line has a SAC and no HSN",
  lines.filter((l) => l.kind === "LABOUR").every((l) => l.sac !== null && l.hsn === null),
  `SAC ${DEFAULT_LABOUR_SAC} — a service, not goods`,
);
check(
  "every part line has an HSN and no SAC",
  lines.filter((l) => l.kind === "PART").every((l) => l.hsn !== null && l.sac === null),
  lines.filter((l) => l.kind === "PART").map((l) => l.hsn).join(", "),
);
check(
  "both are at 18% today, and that is a coincidence rather than a reason to merge them",
  lines.every((l) => n(l.gstRatePct) === 18),
  "they were different before September 2025 and GSTR-1 reports them under different codes",
);

const vLines = await ownerDb
  .select({ code: voucherLinesTable.accountCode, debit: voucherLinesTable.debit, credit: voucherLinesTable.credit, hsn: voucherLinesTable.hsn })
  .from(voucherLinesTable)
  .where(eq(voucherLinesTable.voucherId, inv.voucherId!));
const labourCredit = round2(vLines.filter((l) => l.code === "4300").reduce((a, l) => a + n(l.credit), 0));
const partsCredit = round2(vLines.filter((l) => l.code === "4200").reduce((a, l) => a + n(l.credit), 0));
check(
  "and they credit different income accounts",
  labourCredit === 900 && partsCredit === 1_120,
  `4300 Labour ${rupees(labourCredit)} · 4200 Parts ${rupees(partsCredit)}`,
);
check(
  "the SAC reaches the ledger line, so the return can report it",
  vLines.some((l) => l.code === "4300" && l.hsn === DEFAULT_LABOUR_SAC),
  "GSTR-1's HSN summary carries both under their own codes",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. parts come off the shelf; labour does not");

const stockCredit = round2(vLines.filter((l) => l.code === "1210").reduce((a, l) => a + n(l.credit), 0));
check(
  "**Spare Parts Stock goes down by what the parts cost**",
  stockCredit === 715,
  `${rupees(stockCredit)} — 410 + 305, per part rather than a proportion of revenue`,
);
const partsCostDebit = round2(
  vLines.filter((l) => l.code === "5110").reduce((a, l) => a + n(l.debit), 0),
);
check(
  "**and the cost lands on the parts head, not the vehicle one**",
  partsCostDebit === 715 && !vLines.some((l) => l.code === "5100"),
  "a workshop's parts margin and a showroom's vehicle margin are two businesses, and one head averages them into a figure a dealer would invest on",
);
check(
  "and nothing came off stock for the labour",
  stockCredit === 715,
  "a fitted brake shoe leaves the shelf; an hour of somebody's time was never on it",
);

const free = lines.find((l) => l.coverage === "FREE_SERVICE");
check(
  "**a free service is billed at nothing and still recorded**",
  free !== undefined && round2(n(free.taxableAmount)) === 0,
  "charging the customer would be wrong; pretending the work never happened loses the manufacturer's claim",
);

const claims = await withWorkerScope(() =>
  warrantyClaimable({ ownerId: OWNER, from: FROM, to: TO }),
);
check(
  "and it appears on what the manufacturer owes, named rather than totalled (R-114)",
  claims.rows.some((r) => r.invoiceNo === inv.invoice!.invoiceNo),
  claims.rows.map((r) => `${r.invoiceNo} ${r.description} ${rupees(r.value)}`).join(" · "),
);

// ────────────────────────────────────────────────────────────────────────────

section("4. a deposit already carried GST, so the invoice does not charge it twice");

const deposit = await recordMoney({
  ownerId: OWNER,
  showroomId: branch!.id,
  direction: "RECEIPT",
  partyId: customer.id,
  documentDate: "2026-09-14",
  mode: "CASH",
  amount: 2_360,
  advanceFor: "SERVICE",
  narration: "deposit on a restoration job",
  userId: 1,
});
check("the deposit is taken, with tax", deposit.ok, deposit.warnings.find((w) => w.includes("GST")) ?? "");

const outputBefore = round2(
  n(
  (
    await ownerDb
      .select({
        t: sql<string>`coalesce(sum(${voucherLinesTable.credit}::numeric - ${voucherLinesTable.debit}::numeric), 0)`,
      })
      .from(voucherLinesTable)
      .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
      .where(
        and(
          eq(vouchersTable.showroomId, branch!.id),
          inArray(voucherLinesTable.accountCode, ["2200", "2210"]),
        ),
      )
  )[0]!.t),
);

const resto = await issueServiceInvoice({
  ownerId: OWNER,
  showroomId: branch!.id,
  customerId: customer.id,
  invoiceDate: "2026-09-20",
  jobCardRef: "JC-VERIFY-SERVICE-2",
  registrationNo: "DL 3S BQ 4417",
  lines: [{ kind: "LABOUR", description: "Restoration labour", unitRate: 8_000 }],
  advanceMoneyDocumentId: deposit.document!.id,
  userId: 1,
});
check("the job bills", resto.ok, resto.ok ? resto.invoice!.invoiceNo : resto.error!);
if (!resto.ok) throw new Error(resto.error);
for (const w of resto.warnings) console.log(`      note: ${w}`);

check(
  "**the deposit comes off what is payable**",
  round2(n(resto.invoice!.payableAmount)) ===
    round2(n(resto.invoice!.totalAmount) - n(resto.invoice!.advanceAdjusted)),
  `total ${rupees(n(resto.invoice!.totalAmount))} − advance ${rupees(n(resto.invoice!.advanceAdjusted))} = ${rupees(n(resto.invoice!.payableAmount))}`,
);
check(
  "and the GST already paid on it is reversed rather than charged again",
  round2(n(resto.invoice!.advanceTaxAdjusted)) > 0,
  `${rupees(n(resto.invoice!.advanceTaxAdjusted))} was already with the government when the deposit was taken`,
);

const outputAfter = round2(
  n(
  (
    await ownerDb
      .select({
        t: sql<string>`coalesce(sum(${voucherLinesTable.credit}::numeric - ${voucherLinesTable.debit}::numeric), 0)`,
      })
      .from(voucherLinesTable)
      .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
      .where(
        and(
          eq(vouchersTable.showroomId, branch!.id),
          inArray(voucherLinesTable.accountCode, ["2200", "2210"]),
        ),
      )
  )[0]!.t),
);
const invoiceTax = round2(n(resto.invoice!.cgstAmount) + n(resto.invoice!.sgstAmount));
check(
  "so the month's output tax rises by the invoice's tax *less* what was already paid",
  round2(outputAfter - outputBefore) ===
    round2(invoiceTax - n(resto.invoice!.advanceTaxAdjusted)),
  `${rupees(round2(outputAfter - outputBefore))} — charging the full ${rupees(invoiceTax)} again would bill the customer twice and overstate the return`,
);

// ────────────────────────────────────────────────────────────────────────────

section("5. **and the trial balance still balances**");

const tb = await withWorkerScope(() =>
  trialBalance({ ownerId: OWNER, entityId: entity!.id, from: FROM, to: TO }),
);
for (const r of tb.rows) {
  console.log(
    `      ${pad(r.accountCode, 6)} ${pad(r.accountName, 32)} ${(r.closingDebit ? rupees(r.closingDebit) : "").padStart(14)} ${(r.closingCredit ? rupees(r.closingCredit) : "").padStart(14)}`,
  );
}
check(
  "with a second document type in the books",
  tb.balances,
  tb.balances ? "to the paisa" : `out by ${rupees(tb.difference)}`,
);

const pl = await withWorkerScope(() =>
  profitAndLoss({ ownerId: OWNER, entityId: entity!.id, from: FROM, to: TO }),
);
check(
  "and service revenue reads under its own heads",
  pl.income.some((i) => i.accountCode === "4300") && pl.income.some((i) => i.accountCode === "4200"),
  pl.income.map((i) => `${i.accountName} ${rupees(i.amount)}`).join(" · "),
);

// ────────────────────────────────────────────────────────────────────────────

section("6. a dealership that bills service elsewhere gets no document from us");

const [offReg] = await ownerDb
  .update(gstRegistrationsTable)
  .set({ serviceInvoicing: "N" })
  .where(eq(gstRegistrationsTable.id, reg!.id))
  .returning();

const refused = await issueServiceInvoice({
  ownerId: OWNER,
  showroomId: branch!.id,
  customerId: customer.id,
  invoiceDate: "2026-09-21",
  lines: [{ kind: "LABOUR", description: "Should not issue", unitRate: 100 }],
  userId: 1,
});
check(
  "**it is refused**, because two systems cannot number one series",
  !refused.ok && refused.error!.includes("audit findings"),
  refused.ok ? "it issued" : refused.error!,
);
await ownerDb
  .update(gstRegistrationsTable)
  .set({ serviceInvoicing: "Y" })
  .where(eq(gstRegistrationsTable.id, offReg!.id));

// ────────────────────────────────────────────────────────────────────────────

await wipe();
console.log("\n  (the throwaway service company and everything billed in it, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. Labour under a SAC, parts under an HSN, and the trial balance still balances.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
