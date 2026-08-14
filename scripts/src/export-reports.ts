/**
 * The reports a dealership would actually export, generated from the mirror.
 *
 * OBJ-24 gave the product three ways in — `API`, `REPORT` and `DOCUMENT` — and
 * only the first of them has ever had anything to point at. There was no file
 * to drop, so the report path could be verified and could not be *used*.
 *
 * > **Nothing here is invented.** Every value is read out of the mirror this
 * > dealership already has. Inventing a second book would give the product two
 * > versions of one dealership, which is the failure it exists to fix.
 *
 * ## Three rules that decide what may appear in a file
 *
 * **Mirror fields only, never decision fields.** A dealer's own system knows
 * the chassis number, the promised date and the invoice number. It has never
 * heard of `reassignedToEmpCode`, `customerInformedAt` or `rtoChasedAt` —
 * those are what *DDMS* concluded, and a file claiming to come from the dealer
 * while carrying them would be the product reading back its own output as
 * evidence. Every export below is filtered to the columns the dealer's system
 * could actually hold.
 *
 * **Their vocabulary, not ours.** `Deal No`, not `dealId`. `Chassis No`, not
 * `chassisNo`. The whole point of OBJ-24's mapping is that a dealership's
 * headings are theirs and a model is asked once what they mean; headings that
 * happened to match our column names would prove nothing.
 *
 * **Their formats.** `dd/mm/yyyy`, `₹ 1,24,500.00`, `Y`/`N`. A title row above
 * the headings and a total row underneath, because that is what comes out of an
 * Indian DMS and both are things the parser has to survive — the total row is
 * the one that arrived as a deal priced at 78.
 *
 * ## Deterministic
 *
 * No clock read, no random, and every query sorted. Running it twice writes
 * byte-identical files, so a diff means the dealership changed rather than that
 * the exporter did.
 *
 *   pnpm run db:export-reports
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import {
  ownerDb,
  showroomsTable,
  showroomDmsAccountsTable,
  dmsDealsTable,
  dmsEnquiriesTable,
  dmsEmployeesTable,
  dmsJobCardsTable,
  dmsRegistrationsTable,
  dmsPartStockTable,
  dmsReceivablesTable,
  dmsVehicleStockTable,
} from "@workspace/db";

/*
 * `from-the-dealer`, and the folder name is the whole distinction.
 *
 * These files come *in*: they are what a dealership's own system exports and
 * what DDMS reads. What DDMS produces goes to `from-ddms` and is written by
 * `export-books`. Two directions in one unlabelled folder is how, in six
 * months, nobody can say which file proves what.
 *
 * Keyed by **dealer code and not by branch**, because that is how the export
 * actually arrives: Hero knows the dealership, not which shopfront a machine is
 * standing in. Saraswati's five branches share `HMC-DL-0417`, so they share one
 * stock register — and a per-branch view of it is a DDMS report rather than a
 * dealer one.
 */
const OUT = join(process.cwd(), "..", "sample-reports", "from-the-dealer");

// ── Their formats ───────────────────────────────────────────────────────────

/** `2026-07-14` → `14/07/2026`. Empty for a null, never `Invalid Date`. */
const dmy = (v: unknown): string => {
  if (v instanceof Date) return dmy(v.toISOString());
  if (typeof v !== "string" || v.length < 10) return "";
  const [y, m, d] = v.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

const money = (v: unknown): string => {
  const n = v === null || v === undefined ? NaN : Number(v);
  if (!Number.isFinite(n)) return "";
  return `₹ ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Plain number, for a column a spreadsheet is going to add up. */
const num = (v: unknown): string =>
  v === null || v === undefined || v === "" ? "" : String(v);

/**
 * A flag as a dealer system writes one.
 *
 * `Y`/`N` rather than `true`/`false`, and **empty rather than `N` for a null**:
 * *we know this is not the case* and *nobody recorded it* are different facts,
 * and collapsing them here would hand the parser a certainty the dealer never
 * had.
 */
const flag = (v: unknown): string => (v === null || v === undefined ? "" : v === "Y" || v === true ? "Y" : "N");

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** CSV quoting. Commas in a customer's address are the ordinary case, not an edge. */
const q = (s: string): string =>
  /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

interface Column<T> {
  heading: string;
  of: (row: T) => string;
}

/**
 * One report, written the way the dealership's system writes one.
 *
 * The title row and the total row are not decoration. Every export out of an
 * Indian DMS has both, the parser has to skip the first to find the headings
 * and reject the second as a record, and a fixture without them would be a
 * fixture that never tests either.
 */
function report<T>(input: {
  title: string;
  subtitle: string;
  rows: T[];
  columns: Array<Column<T>>;
  /** Which column the total line lands in, and what it says. */
  totalIn: string;
  totalNoun: string;
}): string {
  const heads = input.columns.map((c) => c.heading);
  const totalAt = Math.max(0, heads.indexOf(input.totalIn));

  const total = heads.map((_, i) =>
    i === 0 ? "Total" : i === totalAt ? `${input.rows.length} ${input.totalNoun}` : "",
  );

  return [
    q(`${input.title} — ${input.subtitle}`),
    "",
    heads.map(q).join(","),
    ...input.rows.map((r) => input.columns.map((c) => q(c.of(r))).join(",")),
    total.map(q).join(","),
  ].join("\r\n");
}

function write(dir: string, name: string, body: string, rows: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf-8");
  console.log(`  ${name.padEnd(34)} ${String(rows).padStart(4)} rows`);
}

// ── The run ─────────────────────────────────────────────────────────────────

const outlets = await ownerDb
  .select({
    id: showroomsTable.id,
    code: showroomsTable.code,
    name: showroomsTable.name,
    dealerCode: showroomDmsAccountsTable.dealerCode,
  })
  .from(showroomsTable)
  .innerJoin(
    showroomDmsAccountsTable,
    eq(showroomDmsAccountsTable.showroomId, showroomsTable.id),
  )
  .orderBy(asc(showroomsTable.id));

if (outlets.length === 0) {
  throw new Error("No outlets with a DMS account. Run db:seed-owners, then sync.");
}

console.log(`\nWriting to ${OUT}\n`);

for (const outlet of outlets) {
  const dc = outlet.dealerCode;
  const dir = join(OUT, dc);
  console.log(`${outlet.name}  (${dc})`);

  // ── 1. Inventory: what is standing on the floor ──────────────────────────
  const vehicles = await ownerDb
    .select()
    .from(dmsVehicleStockTable)
    .where(eq(dmsVehicleStockTable.dealerCode, dc))
    .orderBy(asc(dmsVehicleStockTable.chassisNo));

  write(
    dir,
    "01-vehicle-stock.csv",
    report({
      title: "Vehicle Stock Register",
      subtitle: "as on date",
      rows: vehicles,
      totalIn: "Model",
      totalNoun: "units",
      columns: [
        { heading: "Chassis No", of: (r) => text(r.chassisNo) },
        { heading: "Engine No", of: (r) => text(r.engineNo) },
        { heading: "Model Code", of: (r) => text(r.modelCode) },
        { heading: "Model", of: (r) => text(r.modelDescription) },
        { heading: "Variant", of: (r) => text(r.variantDescription) },
        { heading: "Colour", of: (r) => text(r.colourDescription) },
        { heading: "Stock Status", of: (r) => text(r.status) },
        { heading: "Allocated Deal", of: (r) => text(r.allocatedDealId) },
        { heading: "Cost Value", of: (r) => money(r.costAmount) },
        // Whether the unit sits on a floor-plan line, and at what rate. The two
        // together with the received date are the whole ageing question, and no
        // screen in the dealer's own system puts the three on one row.
        { heading: "Financed", of: (r) => flag(r.isFinanced) },
        { heading: "Interest %", of: (r) => num(r.interestRatePct) },
        { heading: "Received Date", of: (r) => dmy(r.receivedDate) },
        { heading: "Allocated Date", of: (r) => dmy(r.allocatedDate) },
        { heading: "Invoiced Date", of: (r) => dmy(r.invoicedDate) },
      ],
    }),
    vehicles.length,
  );

  // ── 2. The people who work here ─────────────────────────────────────────
  const staff = await ownerDb
    .select()
    .from(dmsEmployeesTable)
    .where(eq(dmsEmployeesTable.dealerCode, dc))
    .orderBy(asc(dmsEmployeesTable.empCode));

  write(
    dir,
    "02-staff-master.csv",
    report({
      title: "Employee Master",
      subtitle: "all staff, active and left",
      rows: staff,
      totalIn: "Employee Name",
      totalNoun: "employees",
      columns: [
        { heading: "Emp Code", of: (r) => text(r.empCode) },
        { heading: "Employee Name", of: (r) => text(r.empName) },
        { heading: "Designation", of: (r) => text(r.role) },
        { heading: "Date Of Joining", of: (r) => dmy(r.dateOfJoining) },
        // The field the whole orphaned-work premise rests on, and the reason
        // the export carries people who have left rather than only current
        // staff: an absent row is not a departure (R-62).
        { heading: "Date Of Leaving", of: (r) => dmy(r.dateOfLeaving) },
        { heading: "Active", of: (r) => flag(r.isActive) },
        { heading: "Mobile No", of: (r) => text(r.mobileNo) },
        { heading: "Email Id", of: (r) => text(r.emailId) },
      ],
    }),
    staff.length,
  );

  // ── 3. Customers, as leads ──────────────────────────────────────────────
  const enquiries = await ownerDb
    .select()
    .from(dmsEnquiriesTable)
    .where(eq(dmsEnquiriesTable.dealerCode, dc))
    .orderBy(asc(dmsEnquiriesTable.enqId));

  write(
    dir,
    "03-enquiry-register.csv",
    report({
      title: "Enquiry Register",
      subtitle: "all open and closed leads",
      rows: enquiries,
      totalIn: "Customer Name",
      totalNoun: "enquiries",
      columns: [
        { heading: "Enquiry No", of: (r) => text(r.enqId) },
        { heading: "Enquiry Date", of: (r) => dmy(r.enquiredAt) },
        { heading: "Source", of: (r) => text(r.source) },
        { heading: "Grade", of: (r) => text(r.grade) },
        { heading: "Stage", of: (r) => text(r.stage) },
        { heading: "Customer Name", of: (r) => text(r.customerName) },
        { heading: "Mobile No", of: (r) => text(r.customerMobile) },
        { heading: "Model Interested", of: (r) => text(r.modelInterest) },
        { heading: "Sales Exec", of: (r) => text(r.assignedEmpCode) },
        /*
         * The manufacturer's own clock, and it is theirs rather than ours.
         *
         * A call logged in DDMS does not stop it — the OEM measures this field
         * in this system — which is why it is on the export and why the
         * derived state keeps reading it rather than anything DDMS records.
         */
        { heading: "First Contact", of: (r) => dmy(r.firstContactAt) },
        { heading: "Last Contact", of: (r) => dmy(r.lastContactDate) },
        { heading: "Next Follow Up", of: (r) => dmy(r.nextFollowUpDate) },
        { heading: "Lost Reason", of: (r) => text(r.lostReason) },
        { heading: "Converted Deal", of: (r) => text(r.convertedDealId) },
      ],
    }),
    enquiries.length,
  );

  // ── 4. Sales ────────────────────────────────────────────────────────────
  const deals = await ownerDb
    .select()
    .from(dmsDealsTable)
    .where(eq(dmsDealsTable.dealerCode, dc))
    .orderBy(asc(dmsDealsTable.dealId));

  write(
    dir,
    "04-deal-register.csv",
    report({
      title: "Deal Register",
      subtitle: "bookings, invoices and deliveries",
      rows: deals,
      totalIn: "Ex Showroom",
      totalNoun: "deals",
      columns: [
        { heading: "Deal No", of: (r) => text(r.dealId) },
        { heading: "Deal Status", of: (r) => text(r.status) },
        { heading: "Booking Date", of: (r) => dmy(r.bookingDate) },
        { heading: "Promised Date", of: (r) => dmy(r.plannedDeliveryDate) },
        { heading: "Delivery Date", of: (r) => dmy(r.actualDeliveryDate) },
        { heading: "Customer Name", of: (r) => text(r.customerName) },
        { heading: "Mobile No", of: (r) => text(r.customerMobile) },
        { heading: "Model", of: (r) => text(r.modelDescription) },
        { heading: "Chassis No", of: (r) => text(r.chassisNo) },
        { heading: "Engine No", of: (r) => text(r.engineNo) },
        { heading: "Ex Showroom", of: (r) => money(r.exShowroomAmount) },
        /*
         * What the *dealer's* system believes about insurance and registration.
         *
         * Deliberately here and deliberately named as theirs: the difference
         * between these three and DDMS's own policy record is the whole
         * reconciliation, and a file that merged them would destroy the signal
         * the owner is looking for.
         */
        { heading: "Policy No", of: (r) => text(r.dmsPolicyNo) },
        { heading: "Insurance Co", of: (r) => text(r.dmsInsurerCode) },
        { heading: "Registration No", of: (r) => text(r.dmsRegNo) },
        { heading: "Invoice No", of: (r) => text(r.invoiceNo) },
        { heading: "Invoice Date", of: (r) => dmy(r.invoiceDate) },
      ],
    }),
    deals.length,
  );

  // ── 5. Registration files at the RTO ────────────────────────────────────
  const regs = await ownerDb
    .select()
    .from(dmsRegistrationsTable)
    .where(eq(dmsRegistrationsTable.dealerCode, dc))
    .orderBy(asc(dmsRegistrationsTable.regnFileNo));

  write(
    dir,
    "05-registration-register.csv",
    report({
      title: "RTO Registration Register",
      subtitle: "files lodged and pending",
      rows: regs,
      totalIn: "Customer Name",
      totalNoun: "files",
      columns: [
        { heading: "File No", of: (r) => text(r.regnFileNo) },
        { heading: "Status", of: (r) => text(r.status) },
        { heading: "Deal No", of: (r) => text(r.dealId) },
        { heading: "Chassis No", of: (r) => text(r.chassisNo) },
        { heading: "Customer Name", of: (r) => text(r.customerName) },
        { heading: "Mobile No", of: (r) => text(r.customerMobile) },
        { heading: "Model", of: (r) => text(r.modelDescription) },
        { heading: "Opened Date", of: (r) => dmy(r.openedDate) },
        { heading: "RTO Code", of: (r) => text(r.rtoCode) },
        { heading: "RTO Office", of: (r) => text(r.rtoOffice) },
        { heading: "Agent Emp Code", of: (r) => text(r.agentEmpCode) },
        { heading: "Temp Reg No", of: (r) => text(r.tempRegNo) },
        { heading: "Temp Reg Expiry", of: (r) => dmy(r.tempRegExpiryDate) },
        { heading: "Policy No", of: (r) => text(r.policyNo) },
        { heading: "Road Tax Amount", of: (r) => money(r.roadTaxAmount) },
        { heading: "Tax Collected On", of: (r) => dmy(r.roadTaxCollectedDate) },
        // The dealership's own controllable duty. Money taken from the customer
        // and not yet paid over is a different and worse fact than a slow RTO.
        { heading: "Tax Paid On", of: (r) => dmy(r.roadTaxPaidDate) },
        { heading: "Submitted On", of: (r) => dmy(r.submittedDate) },
        { heading: "Reg No", of: (r) => text(r.regNo) },
        { heading: "Reg Date", of: (r) => dmy(r.regDate) },
        { heading: "HSRP Fitted On", of: (r) => dmy(r.hsrpFittedDate) },
        { heading: "RC Received On", of: (r) => dmy(r.rcReceivedDate) },
        { heading: "RC Delivered On", of: (r) => dmy(r.rcDeliveredDate) },
        { heading: "Objection", of: (r) => text(r.objectionDesc) },
        { heading: "Pending Doc", of: (r) => flag(r.hasPendingDoc) },
        { heading: "Pending Doc Detail", of: (r) => text(r.pendingDocDesc) },
      ],
    }),
    regs.length,
  );

  // ── 6. The workshop ─────────────────────────────────────────────────────
  const jobCards = await ownerDb
    .select()
    .from(dmsJobCardsTable)
    .where(eq(dmsJobCardsTable.dealerCode, dc))
    .orderBy(asc(dmsJobCardsTable.jcNo));

  write(
    dir,
    "06-job-card-register.csv",
    report({
      title: "Job Card Register",
      subtitle: "workshop, open and closed",
      rows: jobCards,
      totalIn: "Customer Name",
      totalNoun: "job cards",
      columns: [
        { heading: "JC No", of: (r) => text(r.jcNo) },
        { heading: "JC Status", of: (r) => text(r.status) },
        { heading: "JC Type", of: (r) => text(r.jcType) },
        { heading: "JC Date", of: (r) => dmy(r.jcDate) },
        // The promise made to the customer, which is the only thing that makes
        // "late" mean anything on this module.
        { heading: "Promised Date", of: (r) => dmy(r.promisedDate) },
        { heading: "Closed Date", of: (r) => dmy(r.actualCloseDate) },
        { heading: "Customer Name", of: (r) => text(r.customerName) },
        { heading: "Mobile No", of: (r) => text(r.customerMobile) },
        { heading: "Model", of: (r) => text(r.modelDescription) },
        { heading: "Reg No", of: (r) => text(r.regNo) },
        { heading: "Chassis No", of: (r) => text(r.chassisNo) },
        { heading: "Advisor", of: (r) => text(r.advisorEmpCode) },
        { heading: "Estimate", of: (r) => money(r.estimateAmount) },
        { heading: "Final Amount", of: (r) => money(r.finalAmount) },
        { heading: "Part Awaited", of: (r) => flag(r.hasUnissuedPart) },
        { heading: "PSF Done", of: (r) => flag(r.psfDone) },
      ],
    }),
    jobCards.length,
  );

  // ── 7. Spares on the shelf ──────────────────────────────────────────────
  const parts = await ownerDb
    .select()
    .from(dmsPartStockTable)
    .where(eq(dmsPartStockTable.dealerCode, dc))
    .orderBy(asc(dmsPartStockTable.partNo));

  write(
    dir,
    "07-part-stock.csv",
    report({
      title: "Spare Parts Stock",
      subtitle: "as on date",
      rows: parts,
      totalIn: "Part Description",
      totalNoun: "part numbers",
      columns: [
        { heading: "Part No", of: (r) => text(r.partNo) },
        { heading: "Part Description", of: (r) => text(r.partDesc) },
        { heading: "Bin Location", of: (r) => text(r.binLocation) },
        { heading: "Qty On Hand", of: (r) => num(r.qtyOnHand) },
        { heading: "Qty Reserved", of: (r) => num(r.qtyReserved) },
        { heading: "Reorder Level", of: (r) => num(r.reorderLevel) },
        { heading: "MRP", of: (r) => money(r.mrpAmount) },
        { heading: "Cost", of: (r) => money(r.costAmount) },
        { heading: "Last Received", of: (r) => dmy(r.lastReceivedDate) },
        { heading: "Last Issued", of: (r) => dmy(r.lastIssuedDate) },
        { heading: "On Order Qty", of: (r) => num(r.onOrderQty) },
        { heading: "On Order ETA", of: (r) => dmy(r.onOrderEtaDate) },
      ],
    }),
    parts.length,
  );

  // ── 8. What the outlet is owed ──────────────────────────────────────────
  const receivables = await ownerDb
    .select()
    .from(dmsReceivablesTable)
    .where(eq(dmsReceivablesTable.dealerCode, dc))
    .orderBy(asc(dmsReceivablesTable.receivableId));

  write(
    dir,
    "08-receivables.csv",
    report({
      title: "Outstanding Receivables",
      subtitle: "party-wise, as on date",
      rows: receivables,
      totalIn: "Party Name",
      totalNoun: "open items",
      columns: [
        { heading: "Doc No", of: (r) => text(r.receivableId) },
        { heading: "Party Type", of: (r) => text(r.partyType) },
        /*
         * The field the module exists for.
         *
         * A party code is stable across outlets, so the projection can ask what
         * one insurer owes the *group*. Matching on names would work until
         * somebody typed "ICICI Lombard Gen. Ins." and the exposure quietly
         * halved.
         */
        { heading: "Party Code", of: (r) => text(r.partyCode) },
        { heading: "Party Name", of: (r) => text(r.partyName) },
        { heading: "Party Email", of: (r) => text(r.partyEmail) },
        { heading: "Invoice No", of: (r) => text(r.invoiceNo) },
        { heading: "Invoice Date", of: (r) => dmy(r.invoiceDate) },
        { heading: "Invoice Amount", of: (r) => money(r.invoiceAmount) },
        { heading: "Received Amount", of: (r) => money(r.receivedAmount) },
        { heading: "Due Date", of: (r) => dmy(r.dueDate) },
        { heading: "Against", of: (r) => text(r.againstType) },
        { heading: "Against Ref", of: (r) => text(r.againstKey) },
        { heading: "Narration", of: (r) => text(r.narration) },
        { heading: "Status", of: (r) => text(r.status) },
        { heading: "Last Receipt", of: (r) => dmy(r.lastReceiptDate) },
        // A promise somebody made, which is what turns "overdue" into
        // "they said Tuesday and it is Friday".
        { heading: "Promised Date", of: (r) => dmy(r.promisedDate) },
      ],
    }),
    receivables.length,
  );

  console.log("");
}

console.log(`Done. ${outlets.length} outlet(s), 8 reports each.\n`);
process.exit(0);
