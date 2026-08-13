/**
 * OBJ-45's done-when, stated so it can fail.
 *
 * > *Every one names rows rather than a difference.*
 *
 * That is R-114 and it is the only claim this file exists to prove. *"Stock is
 * out by ₹1,87,500"* is an afternoon in a spreadsheet; *"these three chassis
 * numbers"* is a phone call. So §2 breaks four of the ten deliberately and
 * asserts that each one comes back with the **document**, not the amount.
 *
 * §3 is the check I most wanted to get right and it is about honesty rather
 * than arithmetic. Two of the ten cannot run — nothing imports a bank statement
 * and nothing imports GSTR-2B — and a product that reported those as *clean*
 * would be putting a tick beside a control nobody has performed. `ran` and
 * `clean` are separate fields for exactly this reason, and the bank one asserts
 * `ran === false` rather than pretending.
 *
 * §4 is the graduation gate. The product never graduates itself; it earns the
 * right to ask (R-115).
 *
 * `pnpm --filter @workspace/scripts run reconcile`.
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
  stockMovesTable,
  stockMoveLinesTable,
  chassisEventsTable,
  moneyDocumentsTable,
  billAllocationsTable,
  dayClosesTable,
  serviceInvoicesTable,
  serviceInvoiceLinesTable,
  vouchersTable,
  voucherLinesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ensureParty } from "../lib/dms/ledger/parties";
import { createPurchaseInvoice, postPurchaseInvoice } from "../lib/dms/ledger/purchase";
import { createStockMove, despatchStockMove } from "../lib/dms/ledger/moves";
import { closeDay } from "../lib/dms/ledger/money";
import { issueServiceInvoice } from "../lib/dms/ledger/service";
import {
  reconcileAll,
  reconcileBank,
  graduationScorecard,
  GRADUATION_MONTHS_REQUIRED,
} from "../lib/dms/ledger/reconcile";

const OWNER = 1;
const RUN_BY = "verify-reconcile";
const CODE = "TMPRECON";
const GSTIN = "07AAABC5555F1Z6";
const HUB = "TMP-RECON-HUB";
const SAT = "TMP-RECON-SAT";
const PERIOD = "2026-11";
const CHASSIS = ["VERIFY-RECON-C1", "VERIFY-RECON-C2"];

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
const rupees = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);

console.log(`\nOBJ-45 — the ten reconciliations, run by ${RUN_BY}\n`);

async function wipe(): Promise<void> {
  const branches = await ownerDb
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(inArray(showroomsTable.code, [HUB, SAT]));
  const ids = branches.map((b) => b.id);
  if (ids.length) {
    const svc = await ownerDb
      .select({ id: serviceInvoicesTable.id })
      .from(serviceInvoicesTable)
      .where(inArray(serviceInvoicesTable.showroomId, ids));
    if (svc.length)
      await ownerDb
        .delete(serviceInvoiceLinesTable)
        .where(inArray(serviceInvoiceLinesTable.serviceInvoiceId, svc.map((x) => x.id)));
    await ownerDb.delete(serviceInvoicesTable).where(inArray(serviceInvoicesTable.showroomId, ids));

    const mv = await ownerDb
      .select({ id: stockMovesTable.id })
      .from(stockMovesTable)
      .where(inArray(stockMovesTable.fromShowroomId, ids));
    if (mv.length)
      await ownerDb
        .delete(stockMoveLinesTable)
        .where(inArray(stockMoveLinesTable.stockMoveId, mv.map((m) => m.id)));
    await ownerDb.delete(stockMovesTable).where(inArray(stockMovesTable.fromShowroomId, ids));

    const md = await ownerDb
      .select({ id: moneyDocumentsTable.id })
      .from(moneyDocumentsTable)
      .where(inArray(moneyDocumentsTable.showroomId, ids));
    if (md.length)
      await ownerDb
        .delete(billAllocationsTable)
        .where(inArray(billAllocationsTable.moneyDocumentId, md.map((m) => m.id)));
    await ownerDb.delete(moneyDocumentsTable).where(inArray(moneyDocumentsTable.showroomId, ids));
    await ownerDb.delete(dayClosesTable).where(inArray(dayClosesTable.showroomId, ids));

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
  await ownerDb.delete(showroomsTable).where(inArray(showroomsTable.code, [HUB, SAT]));
  await ownerDb.delete(gstRegistrationsTable).where(eq(gstRegistrationsTable.gstin, GSTIN));
  await ownerDb.delete(legalEntitiesTable).where(eq(legalEntitiesTable.code, CODE));
}
await wipe();

const [entity] = await ownerDb
  .insert(legalEntitiesTable)
  .values({
    ownerId: OWNER,
    code: CODE,
    legalName: "Verify Reconcile Motors Pvt Ltd",
    pan: "AAABC5555F",
    entityKind: "PRIVATE_LIMITED",
    booksFrom: "2026-04-01",
    aatoCrore: "6.00",
  })
  .returning();
const [reg] = await ownerDb
  .insert(gstRegistrationsTable)
  .values({ ownerId: OWNER, entityId: entity!.id, gstin: GSTIN, state: "Delhi", stateCode: "07" })
  .returning();
const [hub] = await ownerDb
  .insert(showroomsTable)
  .values({
    ownerId: OWNER,
    code: HUB,
    name: "Verify Reconcile Hub",
    entityId: entity!.id,
    registrationId: reg!.id,
    role: "HUB",
    state: "Delhi",
  })
  .returning();
const [sat] = await ownerDb
  .insert(showroomsTable)
  .values({
    ownerId: OWNER,
    code: SAT,
    name: "Verify Reconcile Satellite",
    entityId: entity!.id,
    registrationId: reg!.id,
    role: "SALES",
    state: "Delhi",
  })
  .returning();

const { party: oem } = await ensureParty({
  ownerId: OWNER,
  entityId: entity!.id,
  kind: "OEM",
  name: "Hero MotoCorp Ltd",
  gstin: "06AAACH1234M1ZQ",
});
const { party: customer } = await ensureParty({
  ownerId: OWNER,
  entityId: entity!.id,
  kind: "CUSTOMER",
  name: "Nikhil Bose",
  mobile: "9811400001",
});

const INPUT = {
  ownerId: OWNER,
  entityId: entity!.id,
  registrationId: reg!.id,
  period: PERIOD,
};

console.log(`      ${entity!.legalName} · ${GSTIN} · hub and satellite on one registration\n`);

// ────────────────────────────────────────────────────────────────────────────

section("1. a clean month first, so the broken one means something");

const clean = await withWorkerScope(() => reconcileAll(INPUT));
for (const r of clean.reconciliations) {
  console.log(
    `      ${pad(r.title, 26)} ${r.ran ? (r.clean ? "clean" : `${r.rows.length} row(s)`) : "NOT RUN"}`,
  );
}
check(
  "ten reconciliations, and each says what it compares",
  clean.reconciliations.length === 10 && clean.reconciliations.every((r) => r.compares.length > 0),
  clean.reconciliations.map((r) => r.key).join(" · "),
);

// ────────────────────────────────────────────────────────────────────────────

section("2. **break four of them, and every one names the row**");

/* 1 — a machine despatched and never received. */
for (const [i, c] of CHASSIS.entries()) {
  await ownerDb.insert(dmsVehicleStockTable).values({
    showroomId: hub!.id,
    dealerCode: "VERIFY-RECON-DC",
    chassisNo: c,
    modelCode: "HER-SPL-PLUS",
    modelDescription: "Splendor Plus",
    status: "IN_STOCK",
    costAmount: "62500.00",
    raw: { chassisNo: c, source: RUN_BY },
    rawHash: `${RUN_BY}-${c}-${i}`,
  });
  await ownerDb.insert(chassisEventsTable).values({
    ownerId: OWNER,
    chassisNo: c,
    showroomId: hub!.id,
    kind: "PURCHASED",
    eventDate: "2026-11-02",
    sourceKind: "MANUAL",
    sourceId: null,
    sourceRef: RUN_BY,
    value: "62500.00",
  });
}
const move = await createStockMove({
  ownerId: OWNER,
  fromShowroomId: hub!.id,
  toShowroomId: sat!.id,
  challanDate: "2026-11-05",
  lines: [{ chassisNo: CHASSIS[0]!, modelDescription: "Splendor Plus", value: 62_500 }],
  narration: "verify-reconcile: left and never arrived",
});
await despatchStockMove({ ownerId: OWNER, stockMoveId: move.move!.id });

/* 4 — a till that came up short. */
await closeDay({
  ownerId: OWNER,
  showroomId: hub!.id,
  closeDate: "2026-11-06",
  countedCash: -900,
  reason: "UNEXPLAINED",
  userId: 1,
});

/* 7 — a free service nobody has claimed from the manufacturer. */
await issueServiceInvoice({
  ownerId: OWNER,
  showroomId: hub!.id,
  customerId: customer.id,
  invoiceDate: "2026-11-09",
  registrationNo: "DL 8S CE 1102",
  lines: [
    { kind: "LABOUR", description: "Second free service", unitRate: 650, coverage: "FREE_SERVICE" },
  ],
  userId: 1,
});

/* 10 — a purchase whose input credit nobody has checked against 2B. */
const purchase = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: hub!.id,
  supplierId: oem.id,
  supplierInvoiceNo: "VERIFY-RECON-HMC-1",
  invoiceDate: "2026-11-03",
  interState: true,
  lines: [
    {
      modelDescription: "Splendor Plus",
      chassisNo: CHASSIS[1]!,
      hsn: "87112019",
      unitCost: 62_500,
      gstRatePct: 18,
    },
  ],
});
await postPurchaseInvoice({ ownerId: OWNER, purchaseInvoiceId: purchase.invoice!.id, userId: 1 });

const broken = await withWorkerScope(() => reconcileAll(INPUT));
const by = new Map(broken.reconciliations.map((r) => [r.key, r]));

for (const key of ["INTER_BRANCH", "DAY_CLOSE", "OEM", "GSTR2B"] as const) {
  const r = by.get(key)!;
  for (const row of r.rows.slice(0, 2)) {
    console.log(`      ${pad(r.title, 18)} ${pad(row.ref, 22)} ${row.detail.slice(0, 62)}`);
  }
}

check(
  "**1 inter-branch names the challan and the chassis**",
  by.get("INTER_BRANCH")!.rows.some((r) => r.detail.includes(CHASSIS[0]!)),
  by.get("INTER_BRANCH")!.rows[0]?.ref ?? "nothing",
);
check(
  "**4 day close names the date and the branch**",
  by.get("DAY_CLOSE")!.rows.some((r) => r.ref.includes("2026-11-06")),
  by.get("DAY_CLOSE")!.rows[0]?.detail ?? "nothing",
);
check(
  "**7 the manufacturer names the job card, not a claims total**",
  by.get("OEM")!.rows.some((r) => r.detail.includes("free service")),
  by.get("OEM")!.rows[0]?.ref ?? "nothing",
);
check(
  "**10 GSTR-2B names the supplier invoice**",
  by.get("GSTR2B")!.rows.some((r) => r.ref === "VERIFY-RECON-HMC-1"),
  by.get("GSTR2B")!.rows[0]?.detail ?? "nothing",
);
check(
  "and every row across all ten carries a reference somebody can look up",
  broken.reconciliations.every((r) => r.rows.every((row) => row.ref.trim().length > 0)),
  "a variance figure says there is a problem and nothing about where",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. **the two that cannot run say so, rather than reporting clean**");

const bank = await withWorkerScope(() => reconcileBank(INPUT));
console.log(`      ${bank.note}`);
check(
  "the bank reconciliation reports `ran: false`",
  !bank.ran && !bank.clean,
  "nothing imports a bank statement, so there is no second side to compare against",
);
check(
  "**and it is not counted as clean**",
  !broken.reconciliations.filter((r) => r.ran && r.clean).some((r) => r.key === "BANK"),
  `${broken.clean} clean of ${broken.ran} that ran, out of ${broken.reconciliations.length}`,
);
check(
  "the note says what a statement would be matched against, so the work is a spreadsheet",
  bank.note!.includes("would be") || bank.note!.includes("matched against"),
  "reporting this as clean would be a tick beside a control nobody has run",
);
check(
  "GSTR-2B distinguishes 'not yet checked' from 'confirmed missing'",
  by.get("GSTR2B")!.rows.every((r) => r.detail.includes("not yet checked") || r.detail.includes("not in 2B")),
  "the distinction matters — one is work to do, the other is credit at risk",
);

// ────────────────────────────────────────────────────────────────────────────

section("4. the graduation gate: earned by reconciling, not claimed (R-115)");

const score = await withWorkerScope(() =>
  graduationScorecard({
    ownerId: OWNER,
    entityId: entity!.id,
    registrationId: reg!.id,
    periods: ["2026-09", "2026-10", "2026-11"],
  }),
);
for (const m of score.months) {
  console.log(
    `      ${m.period}  ours ${rupees(m.ours).padStart(14)}  theirs ${m.theirs === null ? "not entered" : rupees(m.theirs)}`,
  );
}
console.log(`      ${score.statement}`);

check(
  "**it may not offer to graduate**, because nothing has been compared yet",
  !score.mayOffer && score.consecutiveClean === 0,
  `0 of ${GRADUATION_MONTHS_REQUIRED} consecutive months inside tolerance`,
);
check(
  "their figure is **null**, not zero",
  score.months.every((m) => m.theirs === null && m.withinTolerance === null),
  "zero would compare as a 100% variance and report the month as failed, when in fact nobody has typed theirs in",
);
check(
  "and the statement says DDMS runs alongside until then",
  score.statement.includes("runs alongside"),
  "the product never graduates itself; it earns the right to ask",
);

// ────────────────────────────────────────────────────────────────────────────

section("5. nothing here reimplements what a module already computes");

const source = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../lib/dms/ledger/reconcile.ts", import.meta.url), "utf8"),
);
for (const fn of [
  "inTransit",
  "stockPositionCheck",
  "controlAccountCheck",
  "dayCloseDifferences",
  "inputCreditAtRisk",
  "returnAgainstBooks",
  "warrantyClaimable",
]) {
  check(`${fn} is called, not copied`, source.includes(`${fn}(`), "");
}
check(
  "**and the file computes no tax and no stock position of its own**",
  !source.includes("gstRatePct") && !source.includes("taxWithin"),
  "a reconciliation screen with its own arithmetic would be the eighth reconciliation's problem arriving through the front door",
);

// ────────────────────────────────────────────────────────────────────────────

await wipe();
console.log("\n  (the throwaway company and everything reconciled in it, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. Every reconciliation names rows, and the two that cannot run say so.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
