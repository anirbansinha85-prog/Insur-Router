/**
 * The reports a chartered accountant opens, written to disk (Phase 3).
 *
 * `sample-reports/from-the-dealer/` holds files that come **in** — a dealership's
 * own system's exports, which DDMS reads. This writes the other direction:
 * what DDMS **produces**. Two directions in one unlabelled folder is how, in six
 * months, nobody can say which file proves what.
 *
 * ## Nothing here is computed twice
 *
 * Every figure comes from the module that owns it — `trialBalance`, `dayBook`,
 * `salesRegister`, `gstr1For`, `gstr3bFor`, `ageing`, `reconcileAll`. This file
 * formats and writes. A report generator with its own arithmetic would be a
 * second opinion about a number that already has one, and the eighth
 * reconciliation exists precisely because two sources of one figure eventually
 * disagree.
 *
 * ## Every file says the level it was drawn at
 *
 * R-120, on the first line of each one. A trial balance is per entity, a return
 * is per registration, a day close is per branch — and a figure whose scope is
 * ambiguous is a figure somebody will eventually add to another one. The header
 * row is not decoration; it is what stops that.
 *
 * `pnpm run db:export-books`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ownerDb,
  withWorkerScope,
  legalEntitiesTable,
  gstRegistrationsTable,
  showroomsTable,
  purchaseInvoicesTable,
  serviceInvoicesTable,
  stockMovesTable,
  stockMoveLinesTable,
  dayClosesTable,
  partiesTable,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";

import { branchesOfEntity, branchesOfRegistration } from "../lib/dms/org";
import {
  dayBook,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  salesRegister,
  numberingGaps,
} from "../lib/dms/ledger/books";
import { ageing } from "../lib/dms/ledger/parties";
import { gstr1For } from "../lib/dms/ledger/returns";
import { gstr3bFor, monthRange } from "../lib/dms/ledger/returns3b";
import { reconcileAll } from "../lib/dms/ledger/reconcile";

const OWNER = 1;
const OUT = join(process.cwd(), "..", "sample-reports", "from-ddms");

/** The financial year these books cover, and the month drawn in detail. */
const FROM = "2026-04-01";
const TO = "2027-03-31";
const PERIOD = "2026-11";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);

/** Their formats, matching `export-reports` so both sides read the same way. */
const dmy = (v: unknown): string => {
  if (v instanceof Date) return dmy(v.toISOString());
  if (typeof v !== "string" || v.length < 10) return "";
  const [y, m, d] = v.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const money = (v: unknown): string => {
  const x = v === null || v === undefined ? NaN : Number(v);
  if (!Number.isFinite(x)) return "";
  return `₹ ${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const q = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * One report. The scope line is the point (R-120).
 *
 * Unlike the dealer's files there is **no total row**, and its absence is
 * deliberate: a total row exists in a DMS export because it is printed and
 * signed, and it is the thing our own parser has to reject as a record. Writing
 * one here would put a row in our output whose only job is to be thrown away by
 * whoever reads it next.
 */
function report(input: {
  title: string;
  scope: string;
  headings: string[];
  rows: string[][];
}): string {
  return [
    q(`${input.title} — ${input.scope}`),
    "",
    input.headings.map(q).join(","),
    ...input.rows.map((r) => r.map(q).join(",")),
  ].join("\r\n");
}

function write(dir: string, name: string, body: string, rows: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf-8");
  console.log(`  ${name.padEnd(32)} ${String(rows).padStart(4)} rows`);
}

// ────────────────────────────────────────────────────────────────────────────

const entities = await ownerDb
  .select()
  .from(legalEntitiesTable)
  .where(and(eq(legalEntitiesTable.ownerId, OWNER), eq(legalEntitiesTable.isActive, "Y")))
  .orderBy(asc(legalEntitiesTable.code));

if (entities.length === 0) throw new Error("No legal entities. Run db:migrate-org first.");

console.log(`\nWriting to ${OUT}\n`);

for (const entity of entities) {
  const branchIds = await withWorkerScope(() => branchesOfEntity(entity.id));
  if (branchIds.length === 0) continue;

  const regs = await ownerDb
    .select()
    .from(gstRegistrationsTable)
    .where(eq(gstRegistrationsTable.entityId, entity.id))
    .orderBy(asc(gstRegistrationsTable.gstin));

  const branches = await ownerDb
    .select({ id: showroomsTable.id, code: showroomsTable.code, name: showroomsTable.name, role: showroomsTable.role })
    .from(showroomsTable)
    .where(inArray(showroomsTable.id, branchIds))
    .orderBy(asc(showroomsTable.code));
  const branchName = new Map(branches.map((b) => [b.id, b.code]));

  const dir = join(OUT, entity.code);
  const entityScope = `${entity.legalName} · the whole company · ${dmy(FROM)} to ${dmy(TO)}`;
  console.log(`${entity.legalName}  (${entity.code})`);

  // ── 1. the day book ─────────────────────────────────────────────────────
  const dbk = await withWorkerScope(() =>
    dayBook({ ownerId: OWNER, entityId: entity.id, from: FROM, to: TO }),
  );
  write(
    dir,
    "01-day-book.csv",
    report({
      title: "Day Book",
      scope: entityScope,
      headings: ["Date", "Voucher", "No", "Branch", "Account", "Narration", "Party", "Debit", "Credit", "Status"],
      rows: dbk.rows.flatMap((v) =>
        v.lines.map((l) => [
          dmy(v.voucherDate),
          v.kind,
          v.voucherNo,
          text(branchName.get(v.showroomId)),
          `${l.accountCode} ${l.accountName}`,
          text(l.narration),
          text(l.partyName),
          l.debit ? money(l.debit) : "",
          l.credit ? money(l.credit) : "",
          v.status,
        ]),
      ),
    }),
    dbk.rows.reduce((a, v) => a + v.lines.length, 0),
  );

  // ── 2. the trial balance ────────────────────────────────────────────────
  const tb = await withWorkerScope(() =>
    trialBalance({ ownerId: OWNER, entityId: entity.id, from: FROM, to: TO }),
  );
  write(
    dir,
    "02-trial-balance.csv",
    report({
      title: `Trial Balance${tb.balances ? "" : " — DOES NOT BALANCE"}`,
      scope: entityScope,
      headings: ["Code", "Account", "Group", "Opening Dr", "Opening Cr", "Debit", "Credit", "Closing Dr", "Closing Cr"],
      rows: [
        ...tb.rows.map((r) => [
          r.accountCode,
          r.accountName,
          r.group,
          r.openingDebit ? money(r.openingDebit) : "",
          r.openingCredit ? money(r.openingCredit) : "",
          r.debit ? money(r.debit) : "",
          r.credit ? money(r.credit) : "",
          r.closingDebit ? money(r.closingDebit) : "",
          r.closingCredit ? money(r.closingCredit) : "",
        ]),
        ["", "TOTAL", "", "", "", "", "", money(tb.totalDebit), money(tb.totalCredit)],
      ],
    }),
    tb.rows.length,
  );

  // ── 3. profit and loss, and again per branch ────────────────────────────
  const pl = await withWorkerScope(() =>
    profitAndLoss({ ownerId: OWNER, entityId: entity.id, from: FROM, to: TO }),
  );
  const branchPl: string[][] = [];
  for (const b of branches) {
    const p = await withWorkerScope(() =>
      profitAndLoss({ ownerId: OWNER, showroomId: b.id, from: FROM, to: TO }),
    );
    branchPl.push([b.code, b.role, money(p.totalIncome), money(p.totalExpenses), money(p.profit)]);
  }
  write(
    dir,
    "03-profit-and-loss.csv",
    report({
      title: "Profit & Loss",
      scope: `${entityScope} — consolidated, then per branch because a branch is a profit centre`,
      headings: ["Head", "Account", "Amount", "", ""],
      rows: [
        ...pl.income.map((i) => ["Income", i.accountName, money(i.amount), "", ""]),
        ...pl.expenses.map((e) => ["Expense", e.accountName, money(e.amount), "", ""]),
        ["", "PROFIT", money(pl.profit), "", ""],
        ["", "", "", "", ""],
        ["Branch", "Role", "Income", "Expenses", "Profit"],
        ...branchPl,
      ],
    }),
    pl.income.length + pl.expenses.length + branchPl.length,
  );

  // ── 4. the balance sheet ────────────────────────────────────────────────
  const bs = await withWorkerScope(() =>
    balanceSheet({ ownerId: OWNER, entityId: entity.id, from: FROM, to: TO }),
  );
  write(
    dir,
    "04-balance-sheet.csv",
    report({
      title: `Balance Sheet${bs.balances ? "" : " — DOES NOT BALANCE"}`,
      // A branch has no balance sheet: it holds stock and a till belonging to a
      // company that owns them, and a statement whose assets belong to somebody
      // else is not a statement.
      scope: `${entity.legalName} · the company only, never a branch · as at ${dmy(TO)}`,
      headings: ["Side", "Account", "Amount"],
      rows: [
        ...bs.assets.map((a) => ["Asset", a.accountName, money(a.amount)]),
        ...bs.liabilities.map((l) => ["Liability", l.accountName, money(l.amount)]),
        ...bs.equity.map((e) => ["Equity", e.accountName, money(e.amount)]),
        ["Equity", "Profit for the period", money(bs.profitForPeriod)],
        ["", "TOTAL ASSETS", money(bs.totalAssets)],
        ["", "TOTAL LIABILITIES & EQUITY", money(bs.totalLiabilitiesAndEquity)],
      ],
    }),
    bs.assets.length + bs.liabilities.length + bs.equity.length,
  );

  // ── 5. the sales register ───────────────────────────────────────────────
  const sreg = await withWorkerScope(() =>
    salesRegister({ ownerId: OWNER, entityId: entity.id, from: FROM, to: TO }),
  );
  write(
    dir,
    "05-sales-register.csv",
    report({
      title: "Sales Register",
      scope: `${entityScope} — invoice-wise with the tax split, which GSTR-1 is checked against`,
      headings: ["Date", "Voucher", "Party", "GSTIN", "Taxable", "CGST", "SGST", "IGST", "Cess", "Total"],
      rows: [
        ...sreg.rows.map((r) => [
          dmy(r.voucherDate), r.voucherNo, text(r.partyName), text(r.partyGstin),
          money(r.taxable), money(r.cgst), money(r.sgst), money(r.igst), money(r.cess), money(r.total),
        ]),
        ["", "TOTAL", "", "", money(sreg.totals.taxable), money(sreg.totals.cgst),
         money(sreg.totals.sgst), money(sreg.totals.igst), money(sreg.totals.cess), money(sreg.totals.total)],
      ],
    }),
    sreg.rows.length,
  );

  // ── 6. the purchase register ────────────────────────────────────────────
  const purchases = await ownerDb
    .select({
      supplierInvoiceNo: purchaseInvoicesTable.supplierInvoiceNo,
      invoiceDate: purchaseInvoicesTable.invoiceDate,
      supplierName: partiesTable.name,
      supplierGstin: partiesTable.gstin,
      showroomId: purchaseInvoicesTable.showroomId,
      interState: purchaseInvoicesTable.interState,
      taxable: purchaseInvoicesTable.taxableAmount,
      cgst: purchaseInvoicesTable.cgstAmount,
      sgst: purchaseInvoicesTable.sgstAmount,
      igst: purchaseInvoicesTable.igstAmount,
      total: purchaseInvoicesTable.totalAmount,
      gstr2b: purchaseInvoicesTable.gstr2bStatus,
      status: purchaseInvoicesTable.status,
    })
    .from(purchaseInvoicesTable)
    .innerJoin(partiesTable, eq(purchaseInvoicesTable.supplierId, partiesTable.id))
    .where(inArray(purchaseInvoicesTable.showroomId, branchIds))
    .orderBy(asc(purchaseInvoicesTable.invoiceDate));
  write(
    dir,
    "06-purchase-register.csv",
    report({
      title: "Purchase Register",
      scope: `${entityScope} — and the 2B column is input credit at risk until it says MATCHED`,
      headings: ["Date", "Supplier Invoice", "Supplier", "GSTIN", "Received At", "Inter-state", "Taxable", "CGST", "SGST", "IGST", "Total", "In GSTR-2B", "Status"],
      rows: purchases.map((p) => [
        dmy(p.invoiceDate), p.supplierInvoiceNo, text(p.supplierName), text(p.supplierGstin),
        text(branchName.get(p.showroomId)), p.interState, money(p.taxable), money(p.cgst),
        money(p.sgst), money(p.igst), money(p.total), p.gstr2b, p.status,
      ]),
    }),
    purchases.length,
  );

  // ── 7. debtors ageing ───────────────────────────────────────────────────
  const age = await withWorkerScope(() =>
    ageing({ ownerId: OWNER, entityId: entity.id, direction: "RECEIVABLE", asOf: TO }),
  );
  write(
    dir,
    "07-debtors-ageing.csv",
    report({
      title: "Debtors Ageing",
      scope: `${entity.legalName} · the whole company · as at ${dmy(TO)} — bucketed on days **past due**, not days since the bill`,
      headings: ["Party", "Total", ...age.rows[0]?.buckets.map((b) => b.label) ?? [], "Oldest Bill", "Days"],
      rows: age.rows.map((r) => [
        r.partyName, money(r.total), ...r.buckets.map((b) => (b.amount ? money(b.amount) : "")),
        text(r.oldest?.billNo), text(r.oldest?.days),
      ]),
    }),
    age.rows.length,
  );

  // ── 8. stock transfers, which are not sales ─────────────────────────────
  const moves = await ownerDb
    .select({
      challanNo: stockMovesTable.challanNo,
      challanDate: stockMovesTable.challanDate,
      from: stockMovesTable.fromShowroomId,
      to: stockMovesTable.toShowroomId,
      isSupply: stockMovesTable.isSupply,
      reason: stockMovesTable.supplyReason,
      value: stockMovesTable.consignmentValue,
      eway: stockMovesTable.ewayStatus,
      status: stockMovesTable.status,
      id: stockMovesTable.id,
    })
    .from(stockMovesTable)
    .where(inArray(stockMovesTable.fromShowroomId, branchIds))
    .orderBy(asc(stockMovesTable.challanDate));
  const moveLines = moves.length
    ? await ownerDb
        .select()
        .from(stockMoveLinesTable)
        .where(inArray(stockMoveLinesTable.stockMoveId, moves.map((m) => m.id)))
    : [];
  const linesByMove = new Map<number, typeof moveLines>();
  for (const l of moveLines) {
    const list = linesByMove.get(l.stockMoveId) ?? [];
    list.push(l);
    linesByMove.set(l.stockMoveId, list);
  }
  write(
    dir,
    "08-stock-transfer-register.csv",
    report({
      title: "Stock Transfer Register",
      scope: `${entityScope} — **not sales.** Same GSTIN is one legal person moving its own stock: a challan, no tax invoice, no GST, and no accounting entry`,
      headings: ["Date", "Challan", "From", "To", "Chassis", "Model", "Value", "Is a supply?", "E-way", "Status"],
      rows: moves.flatMap((m) =>
        (linesByMove.get(m.id) ?? []).map((l) => [
          dmy(m.challanDate), m.challanNo, text(branchName.get(m.from)), text(branchName.get(m.to)),
          l.chassisNo, l.modelDescription, money(l.value), m.isSupply === "Y" ? "YES — taxable" : "No",
          m.eway, m.status,
        ]),
      ),
    }),
    moveLines.length,
  );

  // ── 9. the workshop ─────────────────────────────────────────────────────
  const svc = await ownerDb
    .select()
    .from(serviceInvoicesTable)
    .where(inArray(serviceInvoicesTable.showroomId, branchIds))
    .orderBy(asc(serviceInvoicesTable.invoiceDate));
  write(
    dir,
    "09-service-register.csv",
    report({
      title: "Service Register",
      scope: `${entityScope} — labour under a SAC and parts under an HSN, which are different classifications even at the same rate`,
      headings: ["Date", "Invoice", "Branch", "Vehicle", "Job Card", "Odometer", "Labour", "Parts", "Taxable", "CGST", "SGST", "Advance Adjusted", "Total", "Payable"],
      rows: svc.map((s) => [
        dmy(s.invoiceDate), s.invoiceNo, text(branchName.get(s.showroomId)), text(s.registrationNo),
        text(s.jobCardRef), text(s.odometerKm), money(s.labourAmount), money(s.partsAmount),
        money(s.taxableAmount), money(s.cgstAmount), money(s.sgstAmount),
        money(s.advanceAdjusted), money(s.totalAmount), money(s.payableAmount),
      ]),
    }),
    svc.length,
  );

  // ── 10. the evenings ────────────────────────────────────────────────────
  const closes = await ownerDb
    .select()
    .from(dayClosesTable)
    .where(inArray(dayClosesTable.showroomId, branchIds))
    .orderBy(asc(dayClosesTable.closeDate));
  write(
    dir,
    "10-day-closes.csv",
    report({
      title: "Day Close Register",
      scope: `${entity.legalName} · **per branch**, because a till belongs to a branch · ${dmy(FROM)} to ${dmy(TO)}`,
      headings: ["Date", "Branch", "Booked Cash", "Counted Cash", "Difference", "Reason", "Note", "Bank Receipts", "Bank Payments"],
      rows: closes.map((c) => [
        dmy(c.closeDate), text(branchName.get(c.showroomId)), money(c.bookedCash), money(c.countedCash),
        money(c.difference), c.reason, text(c.reasonNote), money(c.bankReceipts), money(c.bankPayments),
      ]),
    }),
    closes.length,
  );

  // ── 11. the numbering, which an auditor checks first ────────────────────
  const gaps = await withWorkerScope(() =>
    numberingGaps({ ownerId: OWNER, financialYear: "2026-27" }),
  );
  write(
    dir,
    "11-voucher-numbering.csv",
    report({
      title: "Voucher Numbering — gaps and duplicates",
      scope: `${entity.legalName} · financial year 2026-27 — a hole is an audit finding, and so is a duplicate`,
      headings: ["Voucher Type", "Issued", "Missing", "Duplicates"],
      rows: gaps.map((g) => [g.kind, String(g.issued), g.missing.join(" ") || "none", g.duplicates.join(" ") || "none"]),
    }),
    gaps.length,
  );

  // ── 12-14. the returns, per registration ────────────────────────────────
  for (const reg of regs) {
    const regBranches = await withWorkerScope(() => branchesOfRegistration(reg.id));
    if (regBranches.length === 0) continue;
    const { from, to } = monthRange(PERIOD);
    const regDir = join(dir, `returns-${reg.gstin}-${PERIOD}`);
    const regScope = `${entity.legalName} · ${reg.gstin} · ${reg.state} · ${dmy(from)} to ${dmy(to)}`;

    const g1 = await withWorkerScope(() =>
      gstr1For({ ownerId: OWNER, showroomIds: regBranches, period: PERIOD }),
    );
    write(
      regDir,
      "gstr1-b2b.csv",
      report({
        title: "GSTR-1 — B2B, invoice-wise",
        scope: regScope,
        headings: ["GSTIN of Recipient", "Invoice Number", "Invoice Date", "Invoice Value", "Place Of Supply", "Rate", "Taxable Value"],
        rows: g1.b2b.map((r) => [
          r.gstin, r.invoiceNo, dmy(r.invoiceDate), money(r.invoiceValue),
          r.placeOfSupply, String(r.rate), money(r.taxableValue),
        ]),
      }),
      g1.b2b.length,
    );
    write(
      regDir,
      "gstr1-b2cs.csv",
      report({
        title: "GSTR-1 — B2C small, aggregated",
        scope: `${regScope} — an unregistered buyer reported invoice-wise is a filing that is wrong`,
        headings: ["Type", "Place Of Supply", "Rate", "Taxable Value", "Cess"],
        rows: g1.b2cs.map((r) => [r.type, r.placeOfSupply, String(r.rate), money(r.taxableValue), money(r.cessAmount)]),
      }),
      g1.b2cs.length,
    );

    const b3 = await withWorkerScope(() =>
      gstr3bFor({ ownerId: OWNER, registrationId: reg.id, period: PERIOD }),
    );
    write(
      regDir,
      "gstr3b.csv",
      report({
        title: "GSTR-3B — the summary that comes with the money",
        scope: `${regScope} — set-off in the order the law requires: IGST credit against IGST, then CGST, then SGST; CGST credit never touches SGST`,
        headings: ["Line", "Description", "Taxable", "CGST", "SGST", "IGST", "Cess"],
        rows: [
          ["3.1(a)", "Outward taxable supplies", money(b3.outward.taxable), money(b3.outward.cgst), money(b3.outward.sgst), money(b3.outward.igst), money(b3.outward.cess)],
          ["4(A)", "Input tax credit available", "", money(b3.inputCredit.cgst), money(b3.inputCredit.sgst), money(b3.inputCredit.igst), ""],
          ["5.1", "Tax payable in cash", "", money(b3.payable.cgst), money(b3.payable.sgst), money(b3.payable.igst), ""],
          ["", "Credit carried forward", "", money(b3.carriedForward.cgst), money(b3.carriedForward.sgst), money(b3.carriedForward.igst), ""],
          ...b3.problems.map((p) => ["NOTE", p, "", "", "", "", ""]),
        ],
      }),
      4 + b3.problems.length,
    );
  }

  // ── 15. the reconciliations ─────────────────────────────────────────────
  const rec = await withWorkerScope(() =>
    reconcileAll({ ownerId: OWNER, entityId: entity.id, period: PERIOD, registrationId: regs[0]?.id ?? null }),
  );
  write(
    dir,
    "12-reconciliations.csv",
    report({
      title: "Reconciliations",
      scope:
        `${entity.legalName} · ${PERIOD} — ${rec.clean} clean of ${rec.ran} that ran, out of ${rec.reconciliations.length}. ` +
        "**A reconciliation that could not run is not clean**, and reporting it as clean would be a tick beside a control nobody performed",
      headings: ["#", "Control", "Compares", "Ran?", "Clean?", "Reference", "Detail", "Amount"],
      rows: rec.reconciliations.flatMap((r, i) =>
        r.rows.length === 0
          ? [[String(i + 1), r.title, r.compares, r.ran ? "yes" : "NO", r.clean ? "yes" : "no", "", text(r.note), ""]]
          : r.rows.map((row) => [
              String(i + 1), r.title, r.compares, r.ran ? "yes" : "NO", r.clean ? "yes" : "no",
              row.ref, row.detail, row.amount === null ? "" : money(row.amount),
            ]),
      ),
    }),
    rec.reconciliations.reduce((a, r) => a + Math.max(1, r.rows.length), 0),
  );

  console.log("");
}

console.log(
  `Done. ${entities.length} compan(ies).\n\n` +
    "  from-the-dealer/  files that come IN  — the dealership's own exports, which DDMS reads\n" +
    "  from-ddms/        files that go OUT   — what a chartered accountant opens\n\n" +
    "Every figure came from the module that owns it. Nothing here computes a number twice.\n",
);
process.exit(0);
