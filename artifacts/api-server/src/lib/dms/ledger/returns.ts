import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import {
  db,
  ledgerAccountsTable,
  saleDocumentsTable,
  serviceInvoicesTable,
  showroomsTable,
  gstRegistrationsTable,
  vouchersTable,
  voucherLinesTable,
} from "@workspace/db";

/**
 * Every account a supply can be credited to, and the list is the fix.
 *
 * The return used to look for `4100` alone, so a workshop's whole turnover was
 * invisible to it. Named here as a constant rather than inlined because the day
 * somebody adds a fifth income account the return has to learn about it, and a
 * list with a comment on it is the only version of that anybody notices.
 */
const INCOME_ACCOUNTS: readonly string[] = ["4100", "4200", "4300", "4400"];

/**
 * The file the CA files, and the file Tally reads (OBJ-32, OBJ-33, R-99).
 *
 * > **A ledger that produces nothing lodgeable has added a system rather than
 * > replaced one.**
 *
 * Both exports read the same vouchers. They are in one file because they are
 * one claim about the same numbers — if GSTR-1 and the Tally feed ever
 * disagreed, one of them would be wrong and nobody would know which, so
 * neither is allowed its own idea of what a sale was.
 *
 * ## Nothing here recomputes tax
 *
 * The rate and the split were decided when the invoice was priced (OBJ-25), and
 * were printed on a document a customer holds. Recomputing them at return time
 * would produce a second answer, and the return is not the place to discover
 * that the product has two. Every figure below is read off the voucher lines
 * that were posted from that document.
 *
 * ## A reversed sale is out of the return, exactly as it is out of the books
 *
 * This once said reversals were *netted, not hidden*, and the code under it did
 * neither: it noticed the reversal, pushed a warning, and then reported the
 * invoice at full value. The books and GSTR-3B both exclude a reversed voucher,
 * so GSTR-1 reporting it gave one month two different turnovers — and the
 * department compares 1 against 3B without being asked.
 *
 * So a reversed sale is left out, and the case that genuinely needs a credit
 * note — reversed in a **later** month than the one being filed — is named as a
 * problem with both dates in it. Producing the credit note itself is the next
 * piece of work and is not pretended at here.
 */

// ── GSTR-1 ───────────────────────────────────────────────────────────────────

export interface B2BRow {
  gstin: string;
  receiverName: string;
  invoiceNo: string;
  invoiceDate: string;
  invoiceValue: number;
  placeOfSupply: string;
  reverseCharge: "N";
  invoiceType: "Regular B2B";
  rate: number;
  taxableValue: number;
  cessAmount: number;
}

export interface B2CSRow {
  type: "OE";
  placeOfSupply: string;
  rate: number;
  taxableValue: number;
  cessAmount: number;
}

export interface HsnRow {
  hsn: string;
  description: string;
  /** NOS for goods; NA for a service, which does not come in numbers. */
  uqc: "NOS" | "NA";
  totalQuantity: number;
  totalValue: number;
  taxableValue: number;
  integratedTax: number;
  centralTax: number;
  stateTax: number;
  cess: number;
}

export interface Gstr1 {
  gstin: string | null;
  financialYear: string;
  period: string;
  /** Invoice-wise, as GSTR-1 requires for a registered buyer. */
  b2b: B2BRow[];
  /** Aggregated by place of supply and rate, as it requires for everybody else. */
  b2cs: B2CSRow[];
  hsn: HsnRow[];
  /** Anything that could not be reported and why. Never silent. */
  problems: string[];
  totals: { invoices: number; taxableValue: number; tax: number };
}

const num = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * The return, assembled from what was posted.
 *
 * ## Why B2B and B2C are different shapes rather than a flag
 *
 * They are different filings. A registered buyer's invoice is reported **line
 * by line**, because their input credit depends on it and the portal matches
 * the two; an unregistered buyer's sales are reported **aggregated** by place
 * of supply and rate, because nobody is claiming anything against them. Getting
 * this wrong does not produce a wrong total — it produces a return the portal
 * accepts and a buyer who cannot claim their credit, which the dealership hears
 * about from the buyer three months later.
 *
 * The discriminator is the presence of a GSTIN on the sale, which is the same
 * thing the invoice itself used to decide whether to print the input-credit
 * sentence (R-104's other half).
 */
export async function gstr1For(input: {
  ownerId: number;
  showroomIds: number[];
  /** `2026-07`. Returns are monthly. */
  period: string;
}): Promise<Gstr1> {
  const problems: string[] = [];
  const [year, month] = input.period.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`period must be YYYY-MM, got ${input.period}`);
  }
  const from = `${input.period}-01`;
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  /*
   * The GSTIN comes from the **registration**, not from the branch (OBJ-37).
   *
   * `showrooms.gstin` was where identity lived when the first fixture was two
   * separate companies. Under the ordinary shape - one company, several
   * branches - a branch has no GSTIN of its own and invoices under its
   * entity's, so reading the deprecated column would produce a return filed
   * under nothing for every satellite.
   */
  const outlets = await db
    .select({
      id: showroomsTable.id,
      gstin: gstRegistrationsTable.gstin,
      state: gstRegistrationsTable.state,
    })
    .from(showroomsTable)
    .leftJoin(
      gstRegistrationsTable,
      eq(showroomsTable.registrationId, gstRegistrationsTable.id),
    )
    .where(inArray(showroomsTable.id, input.showroomIds));

  /*
   * One GSTIN per return, because one GSTIN is what a return is filed under.
   *
   * A group spanning two legal entities has two returns, and quietly merging
   * them would produce a single file that is wrong for both. Named as a problem
   * rather than thrown, so somebody sees which outlets are involved.
   */
  const gstins = [...new Set(outlets.map((o) => o.gstin).filter(Boolean))];
  if (gstins.length > 1) {
    problems.push(
      `These outlets file under ${gstins.length} different GST numbers (${gstins.join(", ")}). ` +
        "A return is filed per GSTIN, so this covers all of them together and is not lodgeable as it stands — run it one outlet at a time.",
    );
  }

  const rows = await db
    .select({
      voucher: vouchersTable,
      line: voucherLinesTable,
    })
    .from(vouchersTable)
    .innerJoin(voucherLinesTable, eq(voucherLinesTable.voucherId, vouchersTable.id))
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        inArray(vouchersTable.showroomId, input.showroomIds),
        eq(vouchersTable.kind, "SALES"),
        /*
         * **Posted only**, which is the single most consequential line in this
         * file.
         *
         * Without it a reversed sale was reported at its full value while the
         * books and GSTR-3B both excluded it, so the same month had two
         * different turnovers depending on which report somebody opened — and
         * the department compares 1 against 3B automatically. The old code
         * noticed the reversal, pushed a problem about it, and then reported the
         * invoice anyway.
         */
        eq(vouchersTable.status, "POSTED"),
        gte(vouchersTable.voucherDate, from),
        lte(vouchersTable.voucherDate, to),
      ),
    )
    .orderBy(asc(vouchersTable.voucherDate), asc(vouchersTable.id), asc(voucherLinesTable.seq));

  /*
   * The reversed ones, named rather than dropped silently.
   *
   * A sale reversed inside its own month never stood at month end, so leaving it
   * out is right and there is nothing to say. A sale reversed in a **later**
   * month was a real supply in this one and its correction belongs in the
   * reversal month as a credit note, which this export does not yet produce. The
   * two cases need different sentences and only the second is a problem, so they
   * are separated here instead of sharing one warning that was wrong for both.
   */
  const reversedHere = await db
    .select({
      voucherNo: vouchersTable.voucherNo,
      voucherDate: vouchersTable.voucherDate,
      reversedByVoucherId: vouchersTable.reversedByVoucherId,
    })
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        inArray(vouchersTable.showroomId, input.showroomIds),
        eq(vouchersTable.kind, "SALES"),
        eq(vouchersTable.status, "REVERSED"),
        gte(vouchersTable.voucherDate, from),
        lte(vouchersTable.voucherDate, to),
      ),
    );

  if (reversedHere.length > 0) {
    const reversalIds = reversedHere
      .map((r) => r.reversedByVoucherId)
      .filter((x): x is number => x !== null);
    const reversalDates = reversalIds.length
      ? new Map(
          (
            await db
              .select({ id: vouchersTable.id, voucherDate: vouchersTable.voucherDate })
              .from(vouchersTable)
              .where(inArray(vouchersTable.id, reversalIds))
          ).map((r) => [r.id, r.voucherDate]),
        )
      : new Map<number, string>();

    for (const r of reversedHere) {
      const undoneOn = r.reversedByVoucherId ? reversalDates.get(r.reversedByVoucherId) : undefined;
      if (undoneOn && undoneOn > to) {
        problems.push(
          `${r.voucherNo} of ${r.voucherDate} was reversed on ${undoneOn}, after this period. It is left out of this return to keep it equal to the books, ` +
            "but it was a real supply in this month and the correction belongs in the reversal's month as a credit note, which this export does not yet produce. " +
            "If this month has already been filed, that credit note is what has to be filed next.",
        );
      }
    }
  }

  // Group the lines back into the vouchers they came from.
  const byVoucher = new Map<number, { v: typeof rows[number]["voucher"]; lines: typeof rows[number]["line"][] }>();
  for (const r of rows) {
    const e = byVoucher.get(r.voucher.id) ?? { v: r.voucher, lines: [] };
    e.lines.push(r.line);
    byVoucher.set(r.voucher.id, e);
  }

  /*
   * **The number the customer holds, and the state the goods went to.**
   *
   * Both were wrong and both were wrong in a way that produces a return the
   * portal accepts. `invoiceNo` was the voucher's internal serial — "41" — while
   * the customer held "SI/2026-27/0041", so a registered buyer's input credit
   * could never match and the dealership heard about it from the buyer three
   * months later. `placeOfSupply` was the *selling outlet's* own state, so every
   * interstate sale was reported as if it had happened at home; an invoice
   * charged IGST and filed as an intra-state supply is the shape of a notice.
   *
   * Both live on the document, not on the voucher, so the documents are fetched
   * in two batched reads and matched by the source the voucher already names
   * (R-101). A voucher with no document behind it — a cross-registration branch
   * transfer posts one — says so rather than quietly reporting its serial.
   */
  const saleIds = [...byVoucher.values()]
    .filter((e) => e.v.sourceKind === "SALE_DOCUMENT" && e.v.sourceId !== null)
    .map((e) => e.v.sourceId!);
  const serviceIds = [...byVoucher.values()]
    .filter((e) => e.v.sourceKind === "SERVICE_INVOICE" && e.v.sourceId !== null)
    .map((e) => e.v.sourceId!);

  const saleDocs = saleIds.length
    ? await db
        .select({
          id: saleDocumentsTable.id,
          taxInvoiceNo: saleDocumentsTable.taxInvoiceNo,
          reference: saleDocumentsTable.reference,
          placeOfSupply: saleDocumentsTable.placeOfSupply,
        })
        .from(saleDocumentsTable)
        .where(inArray(saleDocumentsTable.id, saleIds))
    : [];
  const serviceDocs = serviceIds.length
    ? await db
        .select({
          id: serviceInvoicesTable.id,
          invoiceNo: serviceInvoicesTable.invoiceNo,
          placeOfSupply: serviceInvoicesTable.placeOfSupply,
        })
        .from(serviceInvoicesTable)
        .where(inArray(serviceInvoicesTable.id, serviceIds))
    : [];

  const saleById = new Map(saleDocs.map((d) => [d.id, d]));
  const serviceById = new Map(serviceDocs.map((d) => [d.id, d]));

  const b2b: B2BRow[] = [];
  const b2csMap = new Map<string, B2CSRow>();
  const hsnMap = new Map<string, HsnRow>();

  let invoices = 0;
  let taxableTotal = 0;
  let taxTotal = 0;
  let hsnQuantityIncomplete = false;

  for (const { v, lines } of byVoucher.values()) {
    /*
     * Every income account, not only vehicle sales.
     *
     * `4100` alone meant `if (!sale) continue` silently discarded **every service
     * invoice ever raised** — labour on `4300` and parts on `4200` — so a
     * dealership filed a return missing the whole of its workshop turnover while
     * its own books showed it. Understating turnover on a filed return is the
     * single worst thing this file could do, and it did it by default.
     */
    const revenue = lines.filter((l) => INCOME_ACCOUNTS.includes(l.accountCode));
    if (revenue.length === 0) continue;

    const doc =
      v.sourceKind === "SALE_DOCUMENT" && v.sourceId !== null
        ? saleById.get(v.sourceId)
        : undefined;
    const svc =
      v.sourceKind === "SERVICE_INVOICE" && v.sourceId !== null
        ? serviceById.get(v.sourceId)
        : undefined;

    const invoiceNo = doc
      ? (doc.taxInvoiceNo ?? doc.reference)
      : svc
        ? svc.invoiceNo
        : v.voucherNo;
    if (!doc && !svc) {
      problems.push(
        `${v.voucherNo} is a sale with no invoice document behind it, so the return carries its voucher number. ` +
          "A registered buyer cannot match their input credit against that. A cross-registration branch transfer looks like this.",
      );
    }

    const outlet = outlets.find((o) => o.id === v.showroomId);
    const supplierState = outlet?.state ?? "";
    const placeOfSupply = (doc?.placeOfSupply ?? svc?.placeOfSupply ?? supplierState) || "";
    if (!placeOfSupply) {
      problems.push(
        `${invoiceNo} has no place of supply: the document does not record one and the outlet it was sold from has no state either. The portal will refuse the row.`,
      );
    }

    /*
     * The one check that catches a wrong return before the department does.
     *
     * The tax head and the place of supply have to agree: IGST is charged when
     * the goods cross a state line and CGST with SGST when they do not. A return
     * whose two halves disagree is accepted by the portal and then queried, and
     * the invoice is already in the customer's hands by then.
     */
    const anyIgst = lines.some((l) => l.accountCode === "2220" && num(l.credit) > 0);
    const anyLocal = lines.some(
      (l) => (l.accountCode === "2200" || l.accountCode === "2210") && num(l.credit) > 0,
    );
    const sameState =
      Boolean(placeOfSupply) &&
      Boolean(supplierState) &&
      placeOfSupply.trim().toLowerCase() === supplierState.trim().toLowerCase();
    if (anyIgst && sameState) {
      problems.push(
        `${invoiceNo} charged IGST but its place of supply (${placeOfSupply}) is the same state the outlet files from. One of the two is wrong and the portal will accept both.`,
      );
    }
    if (anyLocal && Boolean(placeOfSupply) && Boolean(supplierState) && !sameState) {
      problems.push(
        `${invoiceNo} charged CGST and SGST but its place of supply (${placeOfSupply}) is outside ${supplierState}. An interstate supply carries IGST.`,
      );
    }

    /*
     * **The invoice's own value, not the voucher's total debit.**
     *
     * A sale voucher debits the customer for the invoice *and* debits cost of
     * goods sold for what the bike cost, so `totalDebit` was the invoice plus its
     * own cost — very nearly double. That figure went onto the B2B row and into
     * the HSN summary's total value, on every return the product has ever
     * produced. The debits on the debtors control account are the invoice, which
     * is what the customer was asked to pay; the credits on it are an advance
     * being set off, which does not reduce what was invoiced.
     */
    const invoiceValue = round2(
      lines.filter((l) => l.accountCode === "1100").reduce((a, l) => a + num(l.debit), 0),
    );

    const debtor = lines.find((l) => l.accountCode === "1100" && num(l.debit) > 0);
    const buyerGstin = debtor?.partyGstin ?? null;

    /*
     * One row per rate, which is the grain GSTR-1 is filed in.
     *
     * A service invoice holds labour at 18% and a part at 28%, and reporting the
     * two as one row at one rate misstates both. The rate is read off the line
     * rather than derived — the same rule as everywhere else in this file — and
     * the tax lines are matched to it by the rate they carry: a CGST or SGST line
     * carries half the rate it is the tax on, an IGST line carries the whole.
     */
    const groups = new Map<number, { taxable: number; hsn: string | null; narration: string | null }>();
    for (const l of revenue) {
      const rate = num(l.taxRatePct);
      const g = groups.get(rate) ?? { taxable: 0, hsn: l.hsn, narration: l.narration };
      g.taxable = round2(g.taxable + num(l.credit));
      if (!g.hsn && l.hsn) g.hsn = l.hsn;
      groups.set(rate, g);
    }

    const taxAt = (code: string, wanted: number): number =>
      round2(
        lines
          .filter((l) => l.accountCode === code && num(l.taxRatePct) === wanted)
          .reduce((a, l) => a + num(l.credit), 0),
      );
    const totalOn = (code: string): number =>
      round2(lines.filter((l) => l.accountCode === code).reduce((a, l) => a + num(l.credit), 0));

    /*
     * Cess sits on the widest rate group rather than being matched.
     *
     * `2230` is tagged with the **cess** rate, not the GST rate, so it cannot be
     * matched the way the three GST heads are. Cess is charged on vehicles and a
     * vehicle invoice has one rate group, so attaching it to the largest is exact
     * in every case the product can currently produce — and said out loud here
     * because it is the one attribution below that is by convention rather than
     * by reading.
     */
    const cessTotal = totalOn("2230");
    const widest = [...groups.entries()].sort((a, b) => b[1].taxable - a[1].taxable)[0]?.[0];

    let attributedTax = 0;
    for (const [rate, g] of groups) {
      const cgst = taxAt("2200", rate / 2);
      const sgst = taxAt("2210", rate / 2);
      const igst = taxAt("2220", rate);
      const cess = rate === widest ? cessTotal : 0;
      attributedTax = round2(attributedTax + cgst + sgst + igst + cess);

      taxableTotal = round2(taxableTotal + g.taxable);
      taxTotal = round2(taxTotal + cgst + sgst + igst + cess);

      if (buyerGstin) {
        b2b.push({
          gstin: buyerGstin,
          receiverName: debtor?.partyName ?? "",
          invoiceNo,
          invoiceDate: v.voucherDate,
          invoiceValue,
          placeOfSupply,
          reverseCharge: "N",
          invoiceType: "Regular B2B",
          rate,
          taxableValue: g.taxable,
          cessAmount: cess,
        });
      } else {
        const key = `${placeOfSupply}|${rate}`;
        const agg = b2csMap.get(key) ?? {
          type: "OE" as const,
          placeOfSupply,
          rate,
          taxableValue: 0,
          cessAmount: 0,
        };
        agg.taxableValue = round2(agg.taxableValue + g.taxable);
        agg.cessAmount = round2(agg.cessAmount + cess);
        b2csMap.set(key, agg);
      }

      /*
       * The HSN summary, and the one figure in it that is not on the voucher.
       *
       * Quantity. A voucher records money and this return wants units. One sale
       * document is one vehicle, so a vehicle row's count is the number of
       * invoices at that HSN; a spare part's quantity and a labour line's are
       * not on the voucher at all, so those rows carry none and the return says
       * so rather than inventing a figure. Labour is a service, so its unit of
       * measure is NA rather than NOS — filing a service as though it came in
       * numbers is a rejected sheet.
       */
      const hsn = g.hsn ?? "";
      if (!hsn) {
        problems.push(`${invoiceNo} has a line with no HSN or SAC code on it. The HSN summary will be short by one row.`);
        continue;
      }
      const isVehicle = revenue.some((l) => l.accountCode === "4100" && num(l.taxRatePct) === rate);
      const isService = revenue.some((l) => l.accountCode === "4300" && num(l.taxRatePct) === rate);
      if (!isVehicle) hsnQuantityIncomplete = true;

      const h = hsnMap.get(hsn) ?? {
        hsn,
        description: g.narration ?? "Two-wheeler",
        uqc: isService ? ("NA" as const) : ("NOS" as const),
        totalQuantity: 0,
        totalValue: 0,
        taxableValue: 0,
        integratedTax: 0,
        centralTax: 0,
        stateTax: 0,
        cess: 0,
      };
      if (isVehicle) h.totalQuantity += 1;
      h.totalValue = round2(h.totalValue + g.taxable + cgst + sgst + igst + cess);
      h.taxableValue = round2(h.taxableValue + g.taxable);
      h.integratedTax = round2(h.integratedTax + igst);
      h.centralTax = round2(h.centralTax + cgst);
      h.stateTax = round2(h.stateTax + sgst);
      h.cess = round2(h.cess + cess);
      hsnMap.set(hsn, h);
    }

    /*
     * Tax on the voucher that no rate group claimed.
     *
     * This is the check that would have caught the service invoices: their tax
     * lines carried no rate, so nothing here could attribute them. Rather than
     * lose the money quietly, the difference is named against the invoice it is
     * on — a return short by a rupee of CGST is a return that does not tie to the
     * books, and reconciliation 8 is about to say so anyway.
     */
    const taxOnVoucher = round2(
      totalOn("2200") + totalOn("2210") + totalOn("2220") + cessTotal,
    );
    if (Math.abs(taxOnVoucher - attributedTax) > 0.005) {
      problems.push(
        `${invoiceNo} carries ₹${taxOnVoucher.toFixed(2)} of output tax and only ₹${attributedTax.toFixed(2)} of it could be attributed to a rate. ` +
          "The difference is on a tax line whose rate was not recorded, so it is missing from this return.",
      );
    }

    invoices += 1;
  }

  if (hsnQuantityIncomplete) {
    problems.push(
      "The HSN summary carries no quantity for spare parts or labour, because a voucher line records money and not units. " +
        "The values and the tax are complete; the quantity column is not, and the portal wants it for goods.",
    );
  }

  return {
    gstin: gstins[0] ?? null,
    financialYear: month >= 4 ? `${year}-${String((year + 1) % 100).padStart(2, "0")}` : `${year - 1}-${String(year % 100).padStart(2, "0")}`,
    period: input.period,
    b2b,
    b2cs: [...b2csMap.values()],
    hsn: [...hsnMap.values()],
    problems: [...new Set(problems)],
    totals: { invoices, taxableValue: taxableTotal, tax: taxTotal },
  };
}

/** The portal takes CSV. One section per sheet, exactly as it expects them. */
export function gstr1Csv(r: Gstr1): { b2b: string; b2cs: string; hsn: string } {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sheet = (headers: string[], rows: unknown[][]) =>
    [headers.join(","), ...rows.map((row) => row.map(esc).join(","))].join("\n");

  return {
    b2b: sheet(
      [
        "GSTIN/UIN of Recipient",
        "Receiver Name",
        "Invoice Number",
        "Invoice date",
        "Invoice Value",
        "Place Of Supply",
        "Reverse Charge",
        "Invoice Type",
        "Rate",
        "Taxable Value",
        "Cess Amount",
      ],
      r.b2b.map((x) => [
        x.gstin,
        x.receiverName,
        x.invoiceNo,
        x.invoiceDate,
        x.invoiceValue.toFixed(2),
        x.placeOfSupply,
        x.reverseCharge,
        x.invoiceType,
        x.rate.toFixed(2),
        x.taxableValue.toFixed(2),
        x.cessAmount.toFixed(2),
      ]),
    ),
    b2cs: sheet(
      ["Type", "Place Of Supply", "Rate", "Taxable Value", "Cess Amount"],
      r.b2cs.map((x) => [
        x.type,
        x.placeOfSupply,
        x.rate.toFixed(2),
        x.taxableValue.toFixed(2),
        x.cessAmount.toFixed(2),
      ]),
    ),
    hsn: sheet(
      [
        "HSN",
        "Description",
        "UQC",
        "Total Quantity",
        "Total Value",
        "Taxable Value",
        "Integrated Tax Amount",
        "Central Tax Amount",
        "State/UT Tax Amount",
        "Cess Amount",
      ],
      r.hsn.map((x) => [
        x.hsn,
        x.description,
        x.uqc,
        x.totalQuantity,
        x.totalValue.toFixed(2),
        x.taxableValue.toFixed(2),
        x.integratedTax.toFixed(2),
        x.centralTax.toFixed(2),
        x.stateTax.toFixed(2),
        x.cess.toFixed(2),
      ]),
    ),
  };
}

// ── The feeder ───────────────────────────────────────────────────────────────

/**
 * Vouchers into Tally, and it is R-98's first rung (OBJ-33).
 *
 * > **Be additive before asking to be trusted.**
 *
 * This does not replace anybody's books. It produces vouchers in the shape
 * Tally imports, the dealership brings them in beside what they already keep,
 * and for an agreed period the two are reconciled. Only after that is there a
 * conversation about which one is the record.
 *
 * Tally's import format is XML, and the tags below are Tally's own — a
 * `VOUCHER` inside a `TALLYMESSAGE` inside an `IMPORTDATA` envelope, with
 * `ALLLEDGERENTRIES.LIST` carrying one entry per line and `ISDEEMEDPOSITIVE`
 * marking the debits.
 *
 * ## `LEDGERNAME` is the dealership's own name for the account
 *
 * Resolved by joining `ledger_accounts` at feed time and preferring
 * `tallyName`, which is what makes the import land in *their* chart rather than
 * in twenty-six new ledgers named after ours.
 *
 * **Joined rather than denormalised onto the line**, unlike `accountName`. The
 * two answer different questions: `accountName` is what the account was called
 * when the entry was posted and must not change afterwards, while `tallyName`
 * is a mapping into somebody else's system that they may correct at any time.
 * Freezing it at post time would mean a dealership remapping their chart still
 * getting the old name on every historical voucher they re-send.
 *
 * > **This docstring claimed the `tallyName` behaviour before the code did
 * > it.** The column existed, the sentence was written, and the emitter used
 * > `accountName` — so the feature was documented, dead, and would have been
 * > discovered by a dealership importing a file that created a parallel chart
 * > inside their own books. A comment describing intent rather than behaviour
 * > is worse than no comment: it stops anybody looking.
 */
export interface FeedResult {
  xml: string;
  vouchers: number;
  /** Ids, so the caller can mark them exported once the file is actually taken. */
  voucherIds: number[];
  problems: string[];
}

export async function tallyFeed(input: {
  ownerId: number;
  showroomIds: number[];
  from: string;
  to: string;
  /** Only what has not been handed over yet. The ordinary case. */
  unexportedOnly?: boolean;
}): Promise<FeedResult> {
  const problems: string[] = [];

  const vouchers = await db
    .select()
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        inArray(vouchersTable.showroomId, input.showroomIds),
        gte(vouchersTable.voucherDate, input.from),
        lte(vouchersTable.voucherDate, input.to),
      ),
    )
    .orderBy(asc(vouchersTable.voucherDate), asc(vouchersTable.id));

  const wanted = input.unexportedOnly === false ? vouchers : vouchers.filter((v) => !v.exportedAt);
  if (wanted.length === 0) {
    return { xml: envelope(""), vouchers: 0, voucherIds: [], problems: ["Nothing to send."] };
  }

  const lines = await db
    .select()
    .from(voucherLinesTable)
    .where(
      inArray(
        voucherLinesTable.voucherId,
        wanted.map((v) => v.id),
      ),
    )
    .orderBy(asc(voucherLinesTable.voucherId), asc(voucherLinesTable.seq));

  const byVoucher = new Map<number, typeof lines>();
  for (const l of lines) {
    const arr = byVoucher.get(l.voucherId) ?? [];
    arr.push(l);
    byVoucher.set(l.voucherId, arr);
  }

  /*
   * The dealership's own name for each account, read now rather than at
   * posting time. See the note above: a mapping into somebody else's system is
   * theirs to correct, and correcting it has to affect the next feed.
   */
  const chart = await db
    .select({
      code: ledgerAccountsTable.code,
      tallyName: ledgerAccountsTable.tallyName,
    })
    .from(ledgerAccountsTable)
    .where(eq(ledgerAccountsTable.ownerId, input.ownerId));
  const tallyNameOf = new Map(chart.map((a) => [a.code, a.tallyName]));

  const body = wanted
    .map((v) => {
      const vl = byVoucher.get(v.id) ?? [];
      if (vl.length === 0) {
        problems.push(`${v.voucherNo} has no lines and was left out.`);
        return "";
      }
      /*
       * Tally wants `YYYYMMDD` and a `VCHTYPE` it recognises.
       *
       * A reversal goes across as a Journal, which is what it is — Tally has no
       * concept of a reversed sales voucher, and sending it as a Sales voucher
       * with negative amounts is the version that quietly doubles the month.
       */
      const date = v.voucherDate.replace(/-/g, "");
      const type = v.kind === "SALES" ? "Sales" : v.kind === "CREDIT_NOTE" ? "Credit Note" : "Journal";

      const entries = vl
        .map((l) => {
          const debit = Number(l.debit) > 0;
          const amount = debit ? -Number(l.debit) : Number(l.credit);
          const ledgerName = tallyNameOf.get(l.accountCode) || l.accountName;
          return [
            "          <ALLLEDGERENTRIES.LIST>",
            `            <LEDGERNAME>${xml(ledgerName)}</LEDGERNAME>`,
            `            <ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
            `            <AMOUNT>${amount.toFixed(2)}</AMOUNT>`,
            "          </ALLLEDGERENTRIES.LIST>",
          ].join("\n");
        })
        .join("\n");

      /*
       * The party goes on the voucher, not on a line.
       *
       * Tally reads `PARTYLEDGERNAME` at the voucher level; nested inside an
       * `ALLLEDGERENTRIES.LIST` it is ignored, which the first version did — so
       * every sale would have imported with no customer against it.
       *
       * **This is still not what Tally really wants**, and it is written down
       * rather than glossed: in Tally each customer is their *own ledger* under
       * the Sundry Debtors group, which is what makes a party statement and
       * bill-wise tracking possible. DDMS posts every debtor to one account
       * with the name as an attribute. The feed is importable and the party is
       * visible; running a statement per customer inside Tally is not possible
       * from it yet, and that needs party ledgers here first.
       */
      const party = vl.find((l) => l.partyName)?.partyName ?? null;

      return [
        "      <TALLYMESSAGE xmlns:UDF=\"TallyUDF\">",
        `        <VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
        `          <DATE>${date}</DATE>`,
        `          <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>`,
        `          <VOUCHERNUMBER>${xml(v.voucherNo)}</VOUCHERNUMBER>`,
        party ? `          <PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME>` : "",
        `          <NARRATION>${xml(v.narration ?? "")}</NARRATION>`,
        entries,
        "        </VOUCHER>",
        "      </TALLYMESSAGE>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");

  return {
    xml: envelope(body),
    vouchers: wanted.length,
    voucherIds: wanted.map((v) => v.id),
    problems,
  };
}

function envelope(body: string): string {
  return [
    "<ENVELOPE>",
    "  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "  <BODY>",
    "    <IMPORTDATA>",
    "      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>",
    "      <REQUESTDATA>",
    body,
    "      </REQUESTDATA>",
    "    </IMPORTDATA>",
    "  </BODY>",
    "</ENVELOPE>",
  ].join("\n");
}

const xml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Mark what was actually handed over.
 *
 * Separate from building the file on purpose. A download that failed halfway
 * would otherwise leave vouchers marked exported that nobody received, and the
 * next feed would skip them — which is how a month goes missing from somebody's
 * books with nothing anywhere reporting it.
 */
export async function markExported(input: {
  ownerId: number;
  voucherIds: number[];
  batch: string;
}): Promise<number> {
  if (input.voucherIds.length === 0) return 0;
  const rows = await db
    .update(vouchersTable)
    .set({ exportedAt: new Date(), exportBatch: input.batch })
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        inArray(vouchersTable.id, input.voucherIds),
      ),
    )
    .returning({ id: vouchersTable.id });
  return rows.length;
}
