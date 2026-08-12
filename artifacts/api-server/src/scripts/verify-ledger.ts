/**
 * OBJ-31 to OBJ-33's done-when, stated so it can fail.
 *
 * > *Every voucher balances. Money collected for somebody else is a liability
 * > and never income. Selling a vehicle relieves stock, or says loudly that it
 * > did not. One document posts once, and a correction reverses rather than
 * > edits. What comes out is lodgeable.*
 *
 * This is the first thing in this product where being wrong is a filing
 * offence rather than a bad morning, and the checks are written accordingly:
 * every arithmetic claim is compared against a figure computed here from the
 * document, never against another number the same code produced.
 *
 * ## What it drives rather than fakes
 *
 * It issues a real document through `generateDocument` — the same function the
 * invoice screen calls — and posts that. A ledger proved against a hand-built
 * fixture would be a ledger proved against a shape the product never produces,
 * and every interesting failure here is in the joins: whether the tax split
 * adds up, whether a charge label is recognised, whether stock is found.
 *
 * Runs on the **CLI credential**, unlike the others, and that is itself part of
 * the claim: `ddms_worker` holds select and nothing else on these tables. An
 * entry appearing in a dealership's accounts with nobody signed in is not a
 * thing this product does, and section 8 asserts it.
 *
 * `pnpm run verify:ledger`.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  db,
  ownerDb,
  saleDocumentsTable,
  voucherLinesTable,
  vouchersTable,
  withWorkerScope,
} from "@workspace/db";

import { accountForCharge, ensureChart, financialYearOf } from "../lib/dms/ledger";
import { gstr1For, gstr1Csv, postSaleDocument, reverseVoucher, tallyFeed, markExported } from "../lib/dms/ledger";
import { generateDocument } from "../lib/dms/invoice";
import { loadPolicy } from "../lib/dms/policy";

const OWNER = 1;
const SHOWROOM = 1;
const OUTLETS = [1, 2];
const RUN_BY = "verify:ledger";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

const n = (v: string | null | undefined): number => (v == null ? 0 : Number(v));

/**
 * Everything this run wrote, findable again after a crash.
 *
 * The lesson OBJ-25 learnt the expensive way: **a verifier that tidies by
 * owner deletes the dealership's own work.** By the time anybody uses this
 * product, `sale_documents` and `vouchers` hold *their* invoices and *their*
 * books. So every document this file issues is signed `verify:ledger` in
 * `issuedByName`, every voucher it creates hangs off one of those documents,
 * and reset takes back only those.
 */
async function reset(): Promise<void> {
  const mine = await ownerDb
    .select({ id: saleDocumentsTable.id })
    .from(saleDocumentsTable)
    .where(
      and(eq(saleDocumentsTable.ownerId, OWNER), eq(saleDocumentsTable.issuedByName, RUN_BY)),
    );
  const ids = mine.map((d) => d.id);

  if (ids.length > 0) {
    const vs = await ownerDb
      .select({ id: vouchersTable.id })
      .from(vouchersTable)
      .where(
        and(eq(vouchersTable.ownerId, OWNER), inArray(vouchersTable.sourceId, ids)),
      );
    const vids = vs.map((v) => v.id);
    // Reversals point back at these and are not themselves sourced from a
    // document, so they have to be found through the link rather than the id.
    const reversals = vids.length
      ? await ownerDb
          .select({ id: vouchersTable.id })
          .from(vouchersTable)
          .where(inArray(vouchersTable.reversalOfId, vids))
      : [];
    const all = [...vids, ...reversals.map((r) => r.id)];
    if (all.length > 0) {
      await ownerDb.delete(voucherLinesTable).where(inArray(voucherLinesTable.voucherId, all));
      await ownerDb.delete(vouchersTable).where(inArray(vouchersTable.id, all));
    }
    await ownerDb.delete(saleDocumentsTable).where(inArray(saleDocumentsTable.id, ids));
  }
}

console.log("\nOBJ-31 to 33 — the books, the return and the feeder");
await reset();
await ensureChart(OWNER);

// ═════════════════════════════════════════════════════════════════════════
section("1. Classifying a charge, and what it refuses to guess");

/*
 * R-103 in a table. Every label here is one a dealership actually prints on an
 * invoice, and the last one is the point: an unrecognised charge must not
 * become income, because overstating turnover is the failure this requirement
 * exists to prevent.
 */
const CASES: Array<[string, string]> = [
  ["Road Tax", "2300"],
  ["RTO Life Tax", "2300"],
  ["Registration Charges", "2310"],
  ["HSRP Number Plate", "2310"],
  ["Insurance Premium (1+5)", "2320"],
  ["Extended Warranty", "2330"],
  ["Handling Charges", "4400"],
  ["Mithai for the delivery", "2900"],
];
const wrong = CASES.filter(([label, code]) => accountForCharge(label).code !== code);
check(
  "every charge a dealership prints lands where it belongs",
  wrong.length === 0,
  wrong.map(([l, c]) => `${l} → ${accountForCharge(l).code}, expected ${c}`).join(" · ") ||
    `${CASES.length} labels`,
);
check(
  "and something nobody anticipated goes to suspense, not to income",
  accountForCharge("Mithai for the delivery").code === "2900" &&
    accountForCharge("Mithai for the delivery").why === null,
  "the default has to fall away from revenue — overstating turnover is the failure R-103 is written against",
);

check(
  "the financial year runs April to March",
  financialYearOf("2026-04-01") === "2026-27" &&
    financialYearOf("2027-03-31") === "2026-27" &&
    financialYearOf("2026-03-31") === "2025-26",
  "every statutory question in India needs it and the boundary is not January",
);

// ═════════════════════════════════════════════════════════════════════════
section("2. A real sale, posted");

/*
 * A document issued through the same function the invoice screen calls, with
 * the pass-through charges a two-wheeler sale actually carries. A ledger
 * proved against a hand-built row would be proved against a shape the product
 * never produces.
 */
const policy = await loadPolicy(OWNER);
const issued = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  intent: "SALE",
  sale: {
    showroomId: SHOWROOM,
    customerName: "Ledger Test Customer",
    customerMobile: "9812340001",
    modelDescription: "Splendor Plus",
    chassisNo: "VERIFY-LEDGER-CHASSIS-1",
    engineNo: "VERIFY-LEDGER-ENGINE-1",
  },
  statedPrice: {
    exShowroomAmount: 84_000,
    hsn: "87112019",
    gstRatePct: 28,
    cessRatePct: 3,
  },
  otherCharges: [
    { label: "Road Tax", amount: 8_400 },
    { label: "Registration Charges", amount: 1_200 },
    { label: "Insurance Premium (1+5)", amount: 7_650 },
    { label: "Mithai for the delivery", amount: 500 },
  ],
  userId: 1,
  userName: RUN_BY,
  principal: "OWNER",
  policy,
});

check("the document issued", issued.ok === true, issued.ok ? issued.document.reference : issued.error);
if (!issued.ok) {
  console.log(`\n  Cannot continue without a document. ${issued.error}\n`);
  process.exit(1);
}

const doc = issued.document;
const posted = await postSaleDocument({ ownerId: OWNER, documentId: doc.id, userId: 1 });
check("and it posted", posted.ok, posted.ok ? posted.voucher!.voucherNo : (posted.error ?? ""));
if (!posted.ok) {
  console.log(`\n  Cannot continue. ${posted.error}\n`);
  await reset();
  process.exit(1);
}

const voucherId = posted.voucher!.id;
const lines = await ownerDb
  .select()
  .from(voucherLinesTable)
  .where(eq(voucherLinesTable.voucherId, voucherId))
  .orderBy(voucherLinesTable.seq);

const at = (code: string) => lines.filter((l) => l.accountCode === code);
const creditAt = (code: string) => at(code).reduce((a, l) => a + n(l.credit), 0);
const debitAt = (code: string) => at(code).reduce((a, l) => a + n(l.debit), 0);

// ═════════════════════════════════════════════════════════════════════════
section("3. It balances, and against the document rather than against itself");

const totalDebit = lines.reduce((a, l) => a + n(l.debit), 0);
const totalCredit = lines.reduce((a, l) => a + n(l.credit), 0);

check(
  "debits equal credits",
  Math.abs(totalDebit - totalCredit) < 0.005,
  `₹${totalDebit.toFixed(2)} against ₹${totalCredit.toFixed(2)}`,
);
check(
  "the customer is debited exactly what the invoice says",
  Math.abs(debitAt("1100") - n(doc.totalAmount)) < 0.005,
  `debtors ₹${debitAt("1100").toFixed(2)} · invoice ₹${n(doc.totalAmount).toFixed(2)}`,
);
check(
  "revenue is the taxable value and nothing else",
  Math.abs(creditAt("4100") - n(doc.taxableAmount)) < 0.005,
  `sales ₹${creditAt("4100").toFixed(2)} · taxable ₹${n(doc.taxableAmount).toFixed(2)}`,
);
check(
  "the tax split is the one printed on the document",
  Math.abs(creditAt("2200") - n(doc.cgstAmount)) < 0.005 &&
    Math.abs(creditAt("2210") - n(doc.sgstAmount)) < 0.005 &&
    Math.abs(creditAt("2220") - n(doc.igstAmount)) < 0.005 &&
    Math.abs(creditAt("2230") - n(doc.cessAmount)) < 0.005,
  `CGST ${creditAt("2200")} SGST ${creditAt("2210")} IGST ${creditAt("2220")} cess ${creditAt("2230")}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("4. Somebody else's money is a liability (R-103)");

check(
  "road tax is payable, not turnover",
  creditAt("2300") === 8_400,
  `₹${creditAt("2300").toFixed(2)} to Road Tax Payable`,
);
check(
  "registration charges are payable",
  creditAt("2310") === 1_200,
  `₹${creditAt("2310").toFixed(2)}`,
);
check(
  "the insurance premium is payable",
  creditAt("2320") === 7_650,
  `₹${creditAt("2320").toFixed(2)}`,
);
check(
  "and the unrecognised charge went to suspense rather than income",
  creditAt("2900") === 500 && creditAt("4400") === 0,
  `suspense ₹${creditAt("2900").toFixed(2)} · other income ₹${creditAt("4400").toFixed(2)}`,
);

/*
 * The claim this whole requirement exists for, stated as one number.
 *
 * ₹17,750 of this invoice belongs to the RTO and an insurer. A ledger that
 * credited it to income would report turnover 21% higher than it is — which
 * drives the tax on that turnover, the GST registration thresholds and the
 * OEM's own slabs, so the error escapes the books entirely.
 */
const passThrough = creditAt("2300") + creditAt("2310") + creditAt("2320") + creditAt("2900");
check(
  "none of the pass-through money is anywhere in income",
  creditAt("4100") + creditAt("4200") + creditAt("4300") + creditAt("4400") ===
    n(doc.taxableAmount),
  `₹${passThrough.toFixed(2)} collected for others; income is ₹${n(doc.taxableAmount).toFixed(2)} and not a rupee more`,
);
check(
  "and it says so loudly rather than quietly",
  posted.warnings.some((w) => w.includes("suspense")),
  posted.warnings.find((w) => w.includes("suspense")) ?? "(no warning — it should say one)",
);

// ═════════════════════════════════════════════════════════════════════════
section("5. Selling a vehicle relieves stock, or says it did not (R-102)");

/*
 * This chassis is not in the mirror, deliberately.
 *
 * It is the sub-dealer case OBJ-30 was written for — no DMS, no stock row, no
 * cost. The right behaviour is to post the sale and refuse to invent a figure,
 * and to make the gap loud: a ledger that credits revenue and never credits
 * stock reports the ex-showroom price as margin.
 */
check(
  "an unknown chassis gets no invented cost",
  debitAt("5100") === 0 && creditAt("1200") === 0,
  "inventing one would put a fabricated figure inside a set of books",
);
check(
  "and the warning says what that means, not just that it happened",
  posted.warnings.some((w) => w.includes("reads as margin")),
  posted.warnings.find((w) => w.includes("margin")) ?? "(no warning)",
);

const [known] = await ownerDb
  .select({ chassis: sql<string>`chassis_no`, cost: sql<string>`cost_amount` })
  .from(sql`dms_vehicle_stock`)
  .where(sql`showroom_id = ${SHOWROOM} and cost_amount is not null and invoiced_date is null`)
  .limit(1);

if (known) {
  const second = await generateDocument({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    intent: "SALE",
    sale: {
      showroomId: SHOWROOM,
      customerName: "Ledger Test Customer Two",
      customerMobile: "9812340002",
      modelDescription: "Splendor Plus",
      chassisNo: known.chassis,
      engineNo: "VERIFY-LEDGER-ENGINE-2",
    },
    statedPrice: { exShowroomAmount: 84_000, hsn: "87112019", gstRatePct: 28, cessRatePct: 3 },
    otherCharges: [],
    userId: 1,
    userName: RUN_BY,
    principal: "OWNER",
    policy,
  });

  if (second.ok) {
    const p2 = await postSaleDocument({ ownerId: OWNER, documentId: second.document.id, userId: 1 });
    const l2 = p2.ok
      ? await ownerDb
          .select()
          .from(voucherLinesTable)
          .where(eq(voucherLinesTable.voucherId, p2.voucher!.id))
      : [];
    const cogs = l2.filter((l) => l.accountCode === "5100").reduce((a, l) => a + n(l.debit), 0);
    const stock = l2.filter((l) => l.accountCode === "1200").reduce((a, l) => a + n(l.credit), 0);

    check(
      "a vehicle that is in stock is relieved at what it cost",
      Math.abs(cogs - n(known.cost)) < 0.005 && Math.abs(stock - n(known.cost)) < 0.005,
      `COGS ₹${cogs.toFixed(2)} · stock ₹${stock.toFixed(2)} · the unit cost ₹${n(known.cost).toFixed(2)}`,
    );
    check(
      "and that voucher balances too, with two more lines on it",
      p2.ok &&
        Math.abs(
          l2.reduce((a, l) => a + n(l.debit), 0) - l2.reduce((a, l) => a + n(l.credit), 0),
        ) < 0.005,
      `${l2.length} lines`,
    );
  } else {
    check("a vehicle that is in stock is relieved at what it cost", false, second.error);
  }
} else {
  check(
    "a vehicle that is in stock is relieved at what it cost",
    false,
    "no uninvoiced unit with a cost was found at this outlet, so the claim could not be tested — that is a gap in the check, not a pass",
  );
}

// ═════════════════════════════════════════════════════════════════════════
section("6. One document posts once, and a correction reverses (R-101)");

const again = await postSaleDocument({ ownerId: OWNER, documentId: doc.id, userId: 1 });
check(
  "a second attempt is refused",
  !again.ok && (again.error ?? "").includes("already been posted"),
  again.error ?? "IT POSTED TWICE — the month's sales are now overstated by the price of a motorcycle",
);

const reversal = await reverseVoucher({
  ownerId: OWNER,
  voucherId,
  reason: "The customer's GST number was wrong on the invoice.",
  userId: 1,
});
check("a reversal posts", reversal.ok, reversal.ok ? reversal.voucher!.voucherNo : (reversal.error ?? ""));

const rLines = reversal.ok
  ? await ownerDb
      .select()
      .from(voucherLinesTable)
      .where(eq(voucherLinesTable.voucherId, reversal.voucher!.id))
      .orderBy(voucherLinesTable.seq)
  : [];

check(
  "carrying every line with debit and credit swapped",
  rLines.length === lines.length &&
    rLines.every((r, i) => n(r.debit) === n(lines[i]!.credit) && n(r.credit) === n(lines[i]!.debit)),
  `${rLines.length} lines mirrored`,
);

const [originalNow] = await ownerDb
  .select()
  .from(vouchersTable)
  .where(eq(vouchersTable.id, voucherId));
check(
  "the original stays, marked reversed rather than deleted",
  originalNow?.status === "REVERSED" && originalNow.reversedByVoucherId === reversal.voucher?.id,
  "a set of books whose entries can be changed after the fact is not evidence of anything",
);
check(
  "and the reason is on it",
  (originalNow?.reversalReason ?? "").includes("GST number"),
  originalNow?.reversalReason ?? "(none)",
);

const third = await postSaleDocument({ ownerId: OWNER, documentId: doc.id, userId: 1 });
check(
  "which frees the document to be posted again",
  third.ok,
  third.ok ? `re-posted as ${third.voucher!.voucherNo}` : (third.error ?? ""),
);

// ═════════════════════════════════════════════════════════════════════════
section("7. What comes out is lodgeable (R-99)");

const period = doc.documentDate.slice(0, 7);
const gstr1 = await gstr1For({ ownerId: OWNER, showroomIds: OUTLETS, period });

check(
  "the return found the sale",
  gstr1.totals.invoices >= 1,
  `${gstr1.totals.invoices} invoice(s), ₹${gstr1.totals.taxableValue.toFixed(2)} taxable`,
);
check(
  "a customer with no GST number is aggregated, not reported invoice-wise",
  gstr1.b2cs.length >= 1,
  `${gstr1.b2b.length} B2B rows, ${gstr1.b2cs.length} B2C summaries — reporting an unregistered buyer line by line is a return the portal accepts and a filing that is wrong`,
);
check(
  "the HSN summary carries a code and a quantity",
  gstr1.hsn.some((h) => h.hsn === "87112019" && h.totalQuantity >= 1),
  gstr1.hsn.map((h) => `${h.hsn}×${h.totalQuantity}`).join(", ") || "(empty)",
);

/*
 * The claim that makes it lodgeable rather than merely produced.
 *
 * The taxable value the return reports has to be the taxable value the ledger
 * holds. If these ever differ, one of them is wrong and nobody can tell which
 * — which is the exact reason nothing in the return recomputes tax.
 */
const ledgerTaxable = await ownerDb
  .select({ total: sql<string>`coalesce(sum(credit), 0)::text` })
  .from(voucherLinesTable)
  .innerJoin(vouchersTable, eq(vouchersTable.id, voucherLinesTable.voucherId))
  .where(
    and(
      eq(vouchersTable.ownerId, OWNER),
      eq(vouchersTable.kind, "SALES"),
      eq(voucherLinesTable.accountCode, "4100"),
      sql`${vouchersTable.voucherDate}::text like ${period + "%"}`,
    ),
  );
check(
  "and it reports exactly what the books say, because it recomputes no tax",
  Math.abs(gstr1.totals.taxableValue - n(ledgerTaxable[0]?.total)) < 0.005,
  `return ₹${gstr1.totals.taxableValue.toFixed(2)} · books ₹${n(ledgerTaxable[0]?.total).toFixed(2)}`,
);

const csv = gstr1Csv(gstr1);
check(
  "the CSV has the portal's own column headings",
  csv.b2b.startsWith("GSTIN/UIN of Recipient,Receiver Name,Invoice Number") &&
    csv.b2cs.startsWith("Type,Place Of Supply,Rate") &&
    csv.hsn.startsWith("HSN,Description,UQC"),
  "a file with our column names is a file somebody retypes",
);

const feed = await tallyFeed({
  ownerId: OWNER,
  showroomIds: OUTLETS,
  from: `${period}-01`,
  to: `${period}-31`,
});
check(
  "the Tally feed contains the vouchers",
  feed.vouchers >= 1 && feed.xml.includes("<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>"),
  `${feed.vouchers} voucher(s)`,
);
check(
  "a reversal goes across as a Journal, not a negative sale",
  feed.xml.includes("<VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>"),
  "Tally has no reversed sales voucher, and sending one as a negative Sales quietly doubles the month",
);
check(
  "and every entry says which side it is",
  (feed.xml.match(/<ISDEEMEDPOSITIVE>/g) ?? []).length >= feed.vouchers * 2,
  `${(feed.xml.match(/<ISDEEMEDPOSITIVE>/g) ?? []).length} entries`,
);

const marked = await markExported({ ownerId: OWNER, voucherIds: feed.voucherIds, batch: RUN_BY });
const after = await tallyFeed({
  ownerId: OWNER,
  showroomIds: OUTLETS,
  from: `${period}-01`,
  to: `${period}-31`,
});
check(
  "marking a feed handed over stops it being sent twice",
  marked === feed.voucherIds.length && after.vouchers === 0,
  `${marked} marked, ${after.vouchers} left — and it is a separate call, so a download that failed halfway does not lose a month`,
);

// ═════════════════════════════════════════════════════════════════════════
section("8. Nothing unattended writes to a dealership's accounts");

let refused = "";
try {
  await withWorkerScope(async () => {
    await db.insert(vouchersTable).values({
      ownerId: OWNER,
      showroomId: SHOWROOM,
      kind: "JOURNAL",
      voucherNo: "should-never-exist",
      voucherDate: "2026-08-12",
      financialYear: "2026-27",
      sourceKind: "MANUAL",
      totalDebit: "0",
      totalCredit: "0",
    });
  });
  refused = "IT POSTED — the grant is wrong";
} catch (err) {
  // Drizzle wraps the driver error; the sentence worth reading is on the cause.
  refused = ((err as { cause?: Error }).cause?.message ?? (err as Error).message) || "";
}
check(
  "the scheduler cannot post an entry",
  refused.toLowerCase().includes("permission denied"),
  refused || "an entry appearing in somebody's accounts with nobody signed in is not a thing this product does",
);

await reset();
console.log("  (every document and voucher this run made, and only those, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. It balances, somebody else's money stays theirs, and what comes out is lodgeable.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
