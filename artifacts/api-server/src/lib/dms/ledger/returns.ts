import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import {
  db,
  ledgerAccountsTable,
  showroomsTable,
  gstRegistrationsTable,
  vouchersTable,
  voucherLinesTable,
} from "@workspace/db";

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
 * ## Reversals are netted, not hidden
 *
 * A reversed sale still happened and its reversal still happened. Both appear,
 * and a month containing one shows the invoice and the credit against it,
 * because a return that silently omits a corrected invoice is a return that
 * cannot be reconciled against the books it came from.
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
  uqc: "NOS";
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
        gte(vouchersTable.voucherDate, from),
        lte(vouchersTable.voucherDate, to),
      ),
    )
    .orderBy(asc(vouchersTable.voucherDate), asc(vouchersTable.id), asc(voucherLinesTable.seq));

  // Group the lines back into the vouchers they came from.
  const byVoucher = new Map<number, { v: typeof rows[number]["voucher"]; lines: typeof rows[number]["line"][] }>();
  for (const r of rows) {
    const e = byVoucher.get(r.voucher.id) ?? { v: r.voucher, lines: [] };
    e.lines.push(r.line);
    byVoucher.set(r.voucher.id, e);
  }

  const b2b: B2BRow[] = [];
  const b2csMap = new Map<string, B2CSRow>();
  const hsnMap = new Map<string, HsnRow>();

  let invoices = 0;
  let taxableTotal = 0;
  let taxTotal = 0;

  for (const { v, lines } of byVoucher.values()) {
    if (v.status === "REVERSED") {
      problems.push(
        `${v.voucherNo} was reversed. Both it and its reversal are in the books; a corrected invoice must be reported as a credit note, which this export does not yet produce.`,
      );
    }

    const sale = lines.find((l) => l.accountCode === "4100");
    if (!sale) continue;

    const debtor = lines.find((l) => l.accountCode === "1100");
    const taxable = num(sale.credit);
    const rate = num(sale.taxRatePct);
    const cgst = lines.filter((l) => l.accountCode === "2200").reduce((a, l) => a + num(l.credit), 0);
    const sgst = lines.filter((l) => l.accountCode === "2210").reduce((a, l) => a + num(l.credit), 0);
    const igst = lines.filter((l) => l.accountCode === "2220").reduce((a, l) => a + num(l.credit), 0);
    const cess = lines.filter((l) => l.accountCode === "2230").reduce((a, l) => a + num(l.credit), 0);

    const outlet = outlets.find((o) => o.id === v.showroomId);
    const placeOfSupply = outlet?.state ?? "";
    if (!placeOfSupply) {
      problems.push(
        `${v.voucherNo} has no place of supply, because the outlet it was sold from has no state recorded. The portal will refuse the row.`,
      );
    }

    invoices += 1;
    taxableTotal += taxable;
    taxTotal += cgst + sgst + igst + cess;

    if (debtor?.partyGstin) {
      b2b.push({
        gstin: debtor.partyGstin,
        receiverName: debtor.partyName ?? "",
        invoiceNo: v.voucherNo,
        invoiceDate: v.voucherDate,
        invoiceValue: num(v.totalDebit),
        placeOfSupply,
        reverseCharge: "N",
        invoiceType: "Regular B2B",
        rate,
        taxableValue: taxable,
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
      agg.taxableValue += taxable;
      agg.cessAmount += cess;
      b2csMap.set(key, agg);
    }

    /*
     * The HSN summary, and the one figure in it that is not on the voucher.
     *
     * Quantity. A voucher records money and this return wants units, and one
     * sale document is one vehicle — so the count is the number of invoices at
     * that HSN rather than anything read off a line. Said here because it is
     * the only place in this file where a number is inferred rather than read,
     * and the inference stops being true the day a document covers two bikes.
     */
    const hsn = sale.hsn ?? "";
    if (!hsn) {
      problems.push(`${v.voucherNo} has no HSN code on it. The HSN summary will be short by one row.`);
    } else {
      const h = hsnMap.get(hsn) ?? {
        hsn,
        description: sale.narration ?? "Two-wheeler",
        uqc: "NOS" as const,
        totalQuantity: 0,
        totalValue: 0,
        taxableValue: 0,
        integratedTax: 0,
        centralTax: 0,
        stateTax: 0,
        cess: 0,
      };
      h.totalQuantity += 1;
      h.totalValue += num(v.totalDebit);
      h.taxableValue += taxable;
      h.integratedTax += igst;
      h.centralTax += cgst;
      h.stateTax += sgst;
      h.cess += cess;
      hsnMap.set(hsn, h);
    }
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
