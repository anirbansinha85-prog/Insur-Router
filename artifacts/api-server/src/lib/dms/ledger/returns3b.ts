/**
 * GSTR-3B, TCS and e-invoicing (OBJ-44, R-118).
 *
 * GSTR-1 says what was sold, invoice by invoice. **GSTR-3B is the summary that
 * comes with the money**: output tax, input credit claimed, and the net paid.
 * The two are filed for the same month and the department compares them, so a
 * product that produced one and not the other has done the easy half.
 *
 * ## Everything here is drawn per registration
 *
 * A return is filed under one GSTIN (R-120). Two branches on one registration
 * file together; two registrations of one company file separately even though
 * they share a balance sheet. That is not a nuance — merging them produces a
 * file that is wrong for both and lodgeable as neither.
 *
 * ## And every figure is read from the ledger
 *
 * Not recomputed from the documents. The eighth reconciliation compares the
 * return, the sales register and the books, and if the return read the
 * documents while the books read the vouchers, two of those three would be the
 * same source wearing different hats. Reading the ledger is what makes the
 * comparison mean something.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  vouchersTable,
  voucherLinesTable,
  saleDocumentsTable,
  purchaseInvoicesTable,
  gstRegistrationsTable,
  legalEntitiesTable,
  showroomsTable,
} from "@workspace/db";

import { branchesOfRegistration, eInvoicing } from "../org";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const paise = (x: number): number => Math.round(x * 100);

/** First and last day of a `YYYY-MM` period. */
export function monthRange(period: string): { from: string; to: string } {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`period must be YYYY-MM, got ${period}`);
  }
  return {
    from: `${period}-01`,
    to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
  };
}

export interface Gstr3b {
  registrationId: number;
  gstin: string;
  legalName: string;
  period: string;
  /** 3.1(a) — outward taxable supplies, other than zero-rated. */
  outward: { taxable: number; cgst: number; sgst: number; igst: number; cess: number };
  /** 4(A) — input tax credit available. */
  inputCredit: { cgst: number; sgst: number; igst: number };
  /** 5.1 — what is actually payable after set-off. */
  payable: { cgst: number; sgst: number; igst: number; total: number };
  /** Credit left over, carried to next month. Never negative tax payable. */
  carriedForward: { cgst: number; sgst: number; igst: number };
  problems: string[];
}

/**
 * The monthly summary that comes with the money.
 *
 * ## Set-off is not one subtraction
 *
 * Input IGST is set off against output IGST first, then against CGST, then
 * SGST. Input CGST may only be set off against CGST and IGST — **never against
 * SGST** — and input SGST likewise never against CGST. Those two prohibitions
 * are the whole of the rule and getting them wrong is the ordinary way a
 * dealership either short-pays one head or carries a credit it could have used.
 *
 * A simplified `output − input` would be right often enough to look correct and
 * wrong exactly when the heads are unbalanced, which is most months for a
 * dealer buying inter-state and selling intra-state — which is every two-wheeler
 * dealership in the country.
 */
export async function gstr3bFor(input: {
  ownerId: number;
  registrationId: number;
  period: string;
}): Promise<Gstr3b> {
  const problems: string[] = [];
  const { from, to } = monthRange(input.period);

  const [reg] = await db
    .select({
      id: gstRegistrationsTable.id,
      gstin: gstRegistrationsTable.gstin,
      scheme: gstRegistrationsTable.scheme,
      entityId: gstRegistrationsTable.entityId,
    })
    .from(gstRegistrationsTable)
    .where(
      and(
        eq(gstRegistrationsTable.ownerId, input.ownerId),
        eq(gstRegistrationsTable.id, input.registrationId),
      ),
    );
  if (!reg) throw new Error(`No GST registration ${input.registrationId}`);

  const [entity] = await db
    .select({ legalName: legalEntitiesTable.legalName })
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.id, reg.entityId));

  if (reg.scheme === "COMPOSITION") {
    problems.push(
      `${reg.gstin} is on the composition scheme, which files CMP-08 quarterly rather than GSTR-3B ` +
        "monthly and claims no input credit. This summary is not the return that registration files.",
    );
  }

  const branchIds = await branchesOfRegistration(input.registrationId);
  const empty = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };

  if (branchIds.length === 0) {
    return {
      registrationId: reg.id,
      gstin: reg.gstin,
      legalName: entity?.legalName ?? "",
      period: input.period,
      outward: empty,
      inputCredit: { cgst: 0, sgst: 0, igst: 0 },
      payable: { cgst: 0, sgst: 0, igst: 0, total: 0 },
      carriedForward: { cgst: 0, sgst: 0, igst: 0 },
      problems: [...problems, "No branches file under this registration."],
    };
  }

  const lines = await db
    .select({
      accountCode: voucherLinesTable.accountCode,
      debit: voucherLinesTable.debit,
      credit: voucherLinesTable.credit,
    })
    .from(voucherLinesTable)
    .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        eq(vouchersTable.status, "POSTED"),
        inArray(vouchersTable.showroomId, branchIds),
        sql`${vouchersTable.voucherDate}::text >= ${from}`,
        sql`${vouchersTable.voucherDate}::text <= ${to}`,
      ),
    );

  let outTaxable = 0;
  let outCgst = 0;
  let outSgst = 0;
  let outIgst = 0;
  let outCess = 0;
  let inCgst = 0;
  let inSgst = 0;
  let inIgst = 0;

  for (const l of lines) {
    const credit = paise(n(l.credit));
    const debit = paise(n(l.debit));
    switch (l.accountCode) {
      // Revenue heads. Net of debits so a reversal reduces the month rather
      // than appearing as a separate negative supply the portal will not take.
      case "4100":
      case "4200":
      case "4300":
      case "4400":
        outTaxable += credit - debit;
        break;
      case "2200":
        outCgst += credit - debit;
        break;
      case "2210":
        outSgst += credit - debit;
        break;
      case "2220":
        outIgst += credit - debit;
        break;
      case "2230":
        outCess += credit - debit;
        break;
      // Input heads are assets, so a debit increases the credit available.
      case "1600":
        inCgst += debit - credit;
        break;
      case "1610":
        inSgst += debit - credit;
        break;
      case "1620":
        inIgst += debit - credit;
        break;
    }
  }

  /*
   * The set-off, in the order the law requires.
   *
   * IGST credit first, against IGST then CGST then SGST. Then CGST credit
   * against CGST and any IGST left. Then SGST likewise. **CGST credit may never
   * touch SGST and SGST credit may never touch CGST** — that prohibition is the
   * whole rule, and a simplified subtraction gets it wrong precisely when the
   * heads are unbalanced, which is every month for a dealer buying inter-state
   * and selling intra-state.
   */
  let dueIgst = outIgst;
  let dueCgst = outCgst;
  let dueSgst = outSgst;
  let credIgst = inIgst;
  let credCgst = inCgst;
  let credSgst = inSgst;

  const use = (credit: number, due: number): [number, number] => {
    const used = Math.min(credit, due);
    return [credit - used, due - used];
  };

  [credIgst, dueIgst] = use(credIgst, dueIgst);
  [credIgst, dueCgst] = use(credIgst, dueCgst);
  [credIgst, dueSgst] = use(credIgst, dueSgst);

  [credCgst, dueCgst] = use(credCgst, dueCgst);
  [credCgst, dueIgst] = use(credCgst, dueIgst);

  [credSgst, dueSgst] = use(credSgst, dueSgst);
  [credSgst, dueIgst] = use(credSgst, dueIgst);

  if (credCgst > 0 && dueSgst > 0) {
    problems.push(
      `₹${(credCgst / 100).toFixed(2)} of input CGST cannot be set off against the ₹${(dueSgst / 100).toFixed(2)} of SGST still due — ` +
        "CGST credit never touches SGST. It carries forward instead, and the SGST is paid in cash.",
    );
  }
  if (credSgst > 0 && dueCgst > 0) {
    problems.push(
      `₹${(credSgst / 100).toFixed(2)} of input SGST cannot be set off against the ₹${(dueCgst / 100).toFixed(2)} of CGST still due — ` +
        "SGST credit never touches CGST. It carries forward instead, and the CGST is paid in cash.",
    );
  }

  return {
    registrationId: reg.id,
    gstin: reg.gstin,
    legalName: entity?.legalName ?? "",
    period: input.period,
    outward: {
      taxable: outTaxable / 100,
      cgst: outCgst / 100,
      sgst: outSgst / 100,
      igst: outIgst / 100,
      cess: outCess / 100,
    },
    inputCredit: { cgst: inCgst / 100, sgst: inSgst / 100, igst: inIgst / 100 },
    payable: {
      cgst: dueCgst / 100,
      sgst: dueSgst / 100,
      igst: dueIgst / 100,
      total: (dueCgst + dueSgst + dueIgst) / 100,
    },
    carriedForward: { cgst: credCgst / 100, sgst: credSgst / 100, igst: credIgst / 100 },
    problems,
  };
}

/**
 * TCS under 206C(1F), and BigWing is why it matters (R-118).
 *
 * One per cent on the sale of a motor vehicle where the **invoice value**
 * exceeds ten lakh rupees, collected at the time of **receipt** rather than at
 * invoicing. A Splendor never reaches it; a Transalp does and a Gold Wing is
 * four times over. A premium outlet needs this and a 1S satellite never will,
 * which is one more reason the branch role is a real field.
 *
 * (206C(1H), the fifty-lakh turnover provision, ceased on 1 April 2025 and is
 * deliberately not implemented — a product still collecting under it would be
 * over-collecting from its customers.)
 */
export const TCS_THRESHOLD = 1_000_000;
export const TCS_RATE_PCT = 1;

export async function tcsStatement(input: {
  ownerId: number;
  registrationId: number;
  period: string;
}): Promise<{
  rows: Array<{
    reference: string;
    documentDate: string;
    customerName: string | null;
    customerPan: string | null;
    invoiceValue: number;
    tcs: number;
    collected: boolean;
  }>;
  total: number;
  uncollected: number;
  note: string;
}> {
  const { from, to } = monthRange(input.period);
  const branchIds = await branchesOfRegistration(input.registrationId);
  if (branchIds.length === 0)
    return { rows: [], total: 0, uncollected: 0, note: "No branches file under this registration." };

  const docs = await db
    .select({
      reference: saleDocumentsTable.reference,
      taxInvoiceNo: saleDocumentsTable.taxInvoiceNo,
      documentDate: saleDocumentsTable.documentDate,
      customerName: saleDocumentsTable.customerName,
      totalAmount: saleDocumentsTable.totalAmount,
    })
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, input.ownerId),
        inArray(saleDocumentsTable.showroomId, branchIds),
        eq(saleDocumentsTable.status, "ISSUED"),
        sql`${saleDocumentsTable.kind} in ('TAX_INVOICE','SALE_CONFIRMATION')`,
        sql`${saleDocumentsTable.totalAmount}::numeric > ${TCS_THRESHOLD}`,
        sql`${saleDocumentsTable.documentDate}::text >= ${from}`,
        sql`${saleDocumentsTable.documentDate}::text <= ${to}`,
      ),
    )
    .orderBy(asc(saleDocumentsTable.documentDate));

  const rows = docs.map((d) => ({
    reference: d.taxInvoiceNo ?? d.reference,
    documentDate: d.documentDate,
    customerName: d.customerName,
    /*
     * A PAN is required to report TCS and DDMS does not hold one, because
     * nothing before this objective needed it. Reported as null rather than
     * omitted, so the gap is visible on the statement instead of the statement
     * quietly being unfileable.
     */
    customerPan: null as string | null,
    invoiceValue: n(d.totalAmount),
    tcs: round2((n(d.totalAmount) * TCS_RATE_PCT) / 100),
    collected: false,
  }));

  return {
    rows,
    total: round2(rows.reduce((a, r) => a + r.tcs, 0)),
    uncollected: round2(rows.filter((r) => !r.collected).reduce((a, r) => a + r.tcs, 0)),
    note:
      rows.length === 0
        ? `No sale this month exceeded ₹${(TCS_THRESHOLD / 100_000).toFixed(0)} lakh, so no TCS arises.`
        : "TCS is collected at the time of **receipt**, not at invoicing, so a bike invoiced this " +
          "month and paid next belongs in next month's collection. Each of these needs the buyer's " +
          "PAN before the statement can be filed.",
  };
}

/**
 * Which invoices this month must carry an IRN, and whether they do (R-118).
 *
 * Above five crore aggregate turnover a **B2B** invoice must be registered on
 * the Invoice Registration Portal and carry an IRN and a QR code, or it is not
 * a valid tax invoice. The relief is that most of a dealership's sales are B2C
 * and need none — Mr Verma buying a Splendor needs no IRN — and the product
 * already knows which is which, because `customerGstin` is the same field that
 * decides B2B from B2CS in GSTR-1.
 *
 * So this is a **gate on a path**, not a change to every invoice, and it
 * reports the documents rather than a count (R-114).
 */
export async function eInvoiceReadiness(input: {
  ownerId: number;
  registrationId: number;
  period: string;
}): Promise<{
  required: boolean;
  reportingWindowDays: number | null;
  aatoCrore: number | null;
  b2b: Array<{ reference: string; documentDate: string; customerGstin: string; total: number }>;
  b2cCount: number;
  note: string;
}> {
  const { from, to } = monthRange(input.period);

  const [reg] = await db
    .select({ entityId: gstRegistrationsTable.entityId })
    .from(gstRegistrationsTable)
    .where(eq(gstRegistrationsTable.id, input.registrationId));
  if (!reg) throw new Error(`No GST registration ${input.registrationId}`);

  const [entity] = await db
    .select()
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.id, reg.entityId));
  const gate = eInvoicing(entity!);

  const branchIds = await branchesOfRegistration(input.registrationId);
  const docs = branchIds.length
    ? await db
        .select({
          reference: saleDocumentsTable.reference,
          taxInvoiceNo: saleDocumentsTable.taxInvoiceNo,
          documentDate: saleDocumentsTable.documentDate,
          customerGstin: saleDocumentsTable.customerGstin,
          totalAmount: saleDocumentsTable.totalAmount,
        })
        .from(saleDocumentsTable)
        .where(
          and(
            eq(saleDocumentsTable.ownerId, input.ownerId),
            inArray(saleDocumentsTable.showroomId, branchIds),
            eq(saleDocumentsTable.status, "ISSUED"),
            sql`${saleDocumentsTable.kind} in ('TAX_INVOICE','SALE_CONFIRMATION')`,
            sql`${saleDocumentsTable.documentDate}::text >= ${from}`,
            sql`${saleDocumentsTable.documentDate}::text <= ${to}`,
          ),
        )
        .orderBy(asc(saleDocumentsTable.documentDate))
    : [];

  const b2b = docs
    .filter((d) => (d.customerGstin ?? "").trim().length > 0)
    .map((d) => ({
      reference: d.taxInvoiceNo ?? d.reference,
      documentDate: d.documentDate,
      customerGstin: d.customerGstin!.trim(),
      total: n(d.totalAmount),
    }));

  return {
    required: gate.required,
    reportingWindowDays: gate.reportingWindowDays,
    aatoCrore: entity!.aatoCrore === null ? null : Number(entity!.aatoCrore),
    b2b,
    b2cCount: docs.length - b2b.length,
    note: !gate.required
      ? entity!.aatoCrore === null
        ? "This company's turnover has not been recorded, so e-invoicing is treated as not required. A missing figure must not switch on a rule that changes what a valid invoice is."
        : `Turnover is ₹${Number(entity!.aatoCrore).toFixed(2)} crore, under the ₹5 crore threshold, so no invoice needs an IRN.`
      : `${b2b.length} B2B invoice(s) this month must carry an IRN and a QR code from the IRP or they are not valid tax invoices. ` +
        `The other ${docs.length - b2b.length} are B2C and need none.` +
        (gate.reportingWindowDays
          ? ` Above ₹10 crore there is also a ${gate.reportingWindowDays}-day reporting window from the invoice date.`
          : ""),
  };
}

/**
 * The eighth reconciliation, in the form it will be used: **the return against
 * the books**, tax head by tax head.
 *
 * A difference here means the return being filed is not what the ledger says,
 * and it is the last chance to find that before the department does. Every head
 * is compared separately rather than in total, because two errors of opposite
 * sign in CGST and SGST net to zero and are individually wrong.
 */
export async function returnAgainstBooks(input: {
  ownerId: number;
  registrationId: number;
  period: string;
}): Promise<{
  heads: Array<{ head: string; return: number; books: number; difference: number }>;
  agrees: boolean;
}> {
  const summary = await gstr3bFor(input);
  const { from, to } = monthRange(input.period);
  const branchIds = await branchesOfRegistration(input.registrationId);

  const rows = branchIds.length
    ? await db
        .select({
          accountCode: voucherLinesTable.accountCode,
          net: sql<string>`sum(${voucherLinesTable.credit}::numeric - ${voucherLinesTable.debit}::numeric)`,
        })
        .from(voucherLinesTable)
        .innerJoin(vouchersTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
        .where(
          and(
            eq(vouchersTable.ownerId, input.ownerId),
            eq(vouchersTable.status, "POSTED"),
            inArray(vouchersTable.showroomId, branchIds),
            inArray(voucherLinesTable.accountCode, ["2200", "2210", "2220", "2230"]),
            sql`${vouchersTable.voucherDate}::text >= ${from}`,
            sql`${vouchersTable.voucherDate}::text <= ${to}`,
          ),
        )
        .groupBy(voucherLinesTable.accountCode)
    : [];

  const books = new Map(rows.map((r) => [r.accountCode, n(r.net)]));

  const heads = [
    ["Output CGST", summary.outward.cgst, books.get("2200") ?? 0],
    ["Output SGST", summary.outward.sgst, books.get("2210") ?? 0],
    ["Output IGST", summary.outward.igst, books.get("2220") ?? 0],
    ["Output Cess", summary.outward.cess, books.get("2230") ?? 0],
  ].map(([head, ret, bk]) => ({
    head: head as string,
    return: ret as number,
    books: bk as number,
    difference: round2((ret as number) - (bk as number)),
  }));

  return { heads, agrees: heads.every((h) => paise(h.difference) === 0) };
}
