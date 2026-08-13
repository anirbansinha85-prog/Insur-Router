import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { partiesTable } from "./parties";

/**
 * What the workshop bills (OBJ-42, R-123).
 *
 * The service centre invoices through DDMS — settled by the dealership — so
 * Finance covers service revenue and not only vehicle sales. Nothing in the
 * first draft of this module actually built the document: the only generator
 * was built around one chassis and one ex-showroom figure, and a job card is a
 * different shape entirely.
 *
 * ## Labour and parts are different classifications even at the same rate
 *
 * Labour is a **service** and carries a SAC code; a part is **goods** and
 * carries an HSN. Both sit at 18% today, which is convenient and is not a
 * reason to conflate them: they were different before September 2025, GSTR-1
 * reports them under different codes in the same summary, and a product that
 * collapsed them because the numbers happened to match would have to be
 * unpicked the next time they diverge.
 *
 * ## And the parts side relieves stock, exactly as a vehicle sale does
 *
 * A brake shoe fitted is a brake shoe off the shelf. `1210` Spare Parts Stock
 * has the same one-directional defect a vehicle would have if nothing credited
 * it, and the fix is the same: cost of goods out, stock down, per part.
 *
 * ## This document is deliberately not a sale document
 *
 * A tax invoice for a vehicle carries a chassis, an ex-showroom price
 * inclusive of tax, and pass-through charges collected for the RTO. A job card
 * carries a registration number, several lines at two classifications, and a
 * customer who may have left a deposit that already attracted tax. Forcing them
 * into one table would mean half the columns null on every row and a generator
 * with two modes, which is how both of them end up subtly wrong.
 */
export const serviceInvoicesTable = pgTable(
  "service_invoices",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /** Which outlet did the work. Usually SERVICE or HUB. */
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => partiesTable.id, { onDelete: "restrict" }),

    /** Our own series, per registration per financial year (R-118). */
    invoiceNo: text("invoice_no").notNull(),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),

    /**
     * The job card this bills, where the workshop has one.
     *
     * A reference rather than a foreign key: the job card lives in the dealer's
     * own system and is mirrored, so it may be deleted upstream or not exist at
     * all for walk-in work. A hard reference would make the invoice depend on
     * somebody else's row surviving.
     */
    jobCardRef: text("job_card_ref"),
    /** What was worked on. A vehicle in for service has a plate, not a chassis. */
    registrationNo: text("registration_no"),
    chassisNo: text("chassis_no"),
    modelDescription: text("model_description"),
    odometerKm: integer("odometer_km"),

    placeOfSupply: text("place_of_supply"),
    customerGstin: text("customer_gstin"),

    labourAmount: numeric("labour_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    partsAmount: numeric("parts_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    taxableAmount: numeric("taxable_amount", { precision: 14, scale: 2 }).notNull(),
    cgstAmount: numeric("cgst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    sgstAmount: numeric("sgst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    igstAmount: numeric("igst_amount", { precision: 14, scale: 2 }).notNull().default("0"),

    /**
     * A deposit already taken against this job, and the tax already paid on it.
     *
     * An advance for a service attracts GST at receipt (R-118), so by the time
     * the invoice is raised part of the tax is already with the government.
     * Charging it again would charge the customer twice and overstate the
     * month's output tax; ignoring the advance entirely would leave him owing
     * money he has paid. Both figures are carried so the document can say what
     * happened.
     */
    advanceAdjusted: numeric("advance_adjusted", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    advanceTaxAdjusted: numeric("advance_tax_adjusted", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),

    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
    /** What is left to collect after the deposit comes off. */
    payableAmount: numeric("payable_amount", { precision: 14, scale: 2 }).notNull(),

    /** The dealership's identity at the time, kept so a reprint agrees. */
    sellerLegalName: text("seller_legal_name"),
    sellerGstin: text("seller_gstin"),

    status: text("status", { enum: ["ISSUED", "CANCELLED"] }).notNull().default("ISSUED"),
    voucherId: integer("voucher_id"),
    narration: text("narration"),

    issuedByUserId: integer("issued_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("service_invoices_owner_no_unique").on(t.ownerId, t.invoiceNo),
    index("service_invoices_branch_date_idx").on(t.showroomId, t.invoiceDate),
    index("service_invoices_customer_idx").on(t.customerId),
  ],
).enableRLS();

export type ServiceInvoiceRow = typeof serviceInvoicesTable.$inferSelect;

/**
 * One line on a job card, and `kind` is the whole reason this table exists.
 *
 * `LABOUR` carries a SAC and `PART` carries an HSN, and the two are reported
 * under different codes even when the rate is identical. The column is not a
 * label — it decides which income account the line credits, whether stock is
 * relieved, and which code goes on the return.
 */
export const serviceInvoiceLinesTable = pgTable(
  "service_invoice_lines",
  {
    id: serial("id").primaryKey(),
    serviceInvoiceId: integer("service_invoice_id")
      .notNull()
      .references(() => serviceInvoicesTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),

    kind: text("kind", { enum: ["LABOUR", "PART"] }).notNull(),
    description: text("description").notNull(),

    /** Exactly one of these is set, and which one is what `kind` means. */
    sac: text("sac"),
    hsn: text("hsn"),
    partNo: text("part_no"),

    quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),
    /** The rate per unit, **excluding** tax. A workshop quotes labour ex-tax. */
    unitRate: numeric("unit_rate", { precision: 14, scale: 2 }).notNull(),
    /** A discount on the line, off the taxable value rather than off the total. */
    discount: numeric("discount", { precision: 14, scale: 2 }).notNull().default("0"),
    taxableAmount: numeric("taxable_amount", { precision: 14, scale: 2 }).notNull(),

    gstRatePct: numeric("gst_rate_pct", { precision: 5, scale: 2 }).notNull().default("18"),
    cgstAmount: numeric("cgst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    sgstAmount: numeric("sgst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    igstAmount: numeric("igst_amount", { precision: 14, scale: 2 }).notNull().default("0"),

    /** What the part cost us. Relieved from `1210` on issue. Null on labour. */
    unitCost: numeric("unit_cost", { precision: 14, scale: 2 }),

    /**
     * Whether this line was covered rather than charged.
     *
     * A free service under warranty is real work with a real cost and **no
     * revenue**, and the dealership claims it back from the manufacturer. A
     * product that either charged the customer or pretended the work never
     * happened would lose the claim, which is the OEM reconciliation's whole
     * subject.
     */
    coverage: text("coverage", { enum: ["CUSTOMER", "WARRANTY", "FREE_SERVICE", "GOODWILL"] })
      .notNull()
      .default("CUSTOMER"),
  },
  (t) => [index("service_invoice_lines_invoice_idx").on(t.serviceInvoiceId, t.seq)],
).enableRLS();

export type ServiceInvoiceLineRow = typeof serviceInvoiceLinesTable.$inferSelect;
