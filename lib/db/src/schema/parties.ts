import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { legalEntitiesTable } from "./org";

/**
 * The other half of every entry (OBJ-38, R-109, R-110).
 *
 * ## The defect this closes
 *
 * OBJ-31 built a ledger that knows **one** of the four money events. Every sale
 * credited `1200` Vehicle Stock and nothing ever debited it, so the account ran
 * permanently negative. Every sale debited `1100` Sundry Debtors and nothing
 * credited it, so every customer who ever paid still owed. `2300` Road Tax
 * Payable accumulated and never discharged.
 *
 * A ledger holding only the sale balances **per voucher** and is unfilable in
 * aggregate, which is the worst possible failure: every individual entry passes
 * its own arithmetic check and the trial balance is nonsense. That is R-109,
 * and it is also why reconciliation could not be bolted on afterwards —
 * reconciliation compares two sides and only one existed.
 *
 * This file is the purchase side. OBJ-40 is the money side.
 *
 * ## A party is a ledger, not a column (R-110)
 *
 * `voucher_lines.party_name` was a string. A string cannot produce a customer
 * statement, cannot age a debt, and cannot tell you that the Sharma who bought
 * in April is the Sharma who is still owing in September. A statement, a
 * bill-wise allocation and an ageing report are all impossible without a row.
 *
 * In Tally's terms `1100` and `2100` are **control accounts** — groups — and
 * each customer and supplier is a ledger beneath one. That is exactly what this
 * is: the control account stays on the voucher line so the trial balance is
 * unchanged, and `party_id` beside it is what makes the subsidiary ledger
 * possible.
 */
export const partiesTable = pgTable(
  "parties",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),

    /**
     * Which set of books this party sits in.
     *
     * A party belongs to an **entity**, not to a group and not to a branch. Two
     * companies under one owner each have their own Sundry Debtors and their
     * own balance sheet, and a customer who has bought from both is two ledgers
     * with two balances - which is correct, because two legal persons are owed
     * separately and would sue separately.
     */
    entityId: integer("entity_id")
      .notNull()
      .references(() => legalEntitiesTable.id, { onDelete: "cascade" }),

    /**
     * What this party is **to us**, which decides which control account its
     * balance rolls into.
     *
     *   CUSTOMER   buys vehicles or service. Debit balance, Sundry Debtors.
     *   SUPPLIER   the trade generally. Credit balance, Sundry Creditors.
     *   OEM        the manufacturer, and both at once: we owe them for stock and
     *              they owe us for warranty and scheme claims. Two balances that
     *              must not be netted, because netting hides an unclaimed scheme.
     *   FINANCIER  a bank or NBFC that disburses against a booking.
     *   INSURER    the insurance company the premium is remitted to.
     *   GOVERNMENT the RTO. Road tax collected is theirs, never ours (R-103).
     */
    kind: text("kind", {
      enum: ["CUSTOMER", "SUPPLIER", "OEM", "FINANCIER", "INSURER", "GOVERNMENT"],
    }).notNull(),

    name: text("name").notNull(),
    /**
     * The name this party has in the dealership's own books.
     *
     * The same reason `ledger_accounts.tally_name` exists: an export that
     * invented its own names would build a second, parallel customer list
     * inside the dealership's Tally, and reconciling the two would become
     * somebody's monthly job forever.
     */
    tallyName: text("tally_name"),

    gstin: text("gstin"),
    pan: text("pan"),
    mobile: text("mobile"),
    email: text("email"),
    addressLine: text("address_line"),
    state: text("state"),

    /**
     * The balance carried in from whatever the dealership kept before us.
     *
     * Positive with a side, never a signed number, for the same reason voucher
     * lines have two columns: a sign is one negation away from an opening
     * balance that says the opposite of what it means. `DEBIT` on a customer is
     * money owed to the dealership; `CREDIT` on a supplier is money it owes.
     */
    openingAmount: numeric("opening_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    openingSide: text("opening_side", { enum: ["DEBIT", "CREDIT"] }),

    isActive: text("is_active", { enum: ["Y", "N"] }).notNull().default("Y"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("parties_owner_kind_idx").on(t.ownerId, t.kind),
    index("parties_entity_idx").on(t.entityId),
    index("parties_mobile_idx").on(t.ownerId, t.mobile),
    /*
     * A GSTIN identifies a business exactly, so two parties in one set of books
     * carrying the same one are the same business entered twice - which is how
     * a supplier ends up with its balance split across two ledgers and neither
     * matching the statement. Partial, because most retail customers have none.
     */
    uniqueIndex("parties_entity_gstin_unique")
      .on(t.entityId, t.gstin)
      .where(sql`gstin is not null`),
  ],
).enableRLS();

export type PartyRow = typeof partiesTable.$inferSelect;

/**
 * One bill, and what is still outstanding on it (R-111).
 *
 * **Money is allocated to a bill, or it is on account and says so.** This table
 * is what makes that possible: without a bill there is only a party balance, and
 * a party balance can only be settled oldest-first, which is a guess about which
 * debt the customer meant to pay. That guess is theirs to make, not ours - a
 * customer disputing one invoice and paying another is an ordinary Tuesday, and
 * a product that quietly applied his payment to the invoice he is disputing has
 * taken a side in his argument.
 *
 * A bill is created by the thing that raises the debt (a sale, a purchase) and
 * is reduced by the thing that settles it (a receipt, a payment, a credit note).
 * `outstanding` is **stored rather than derived**, unlike almost everything else
 * in this product, because it is the running state of a negotiation and has to
 * still say the same thing next March.
 */
export const partyBillsTable = pgTable(
  "party_bills",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    partyId: integer("party_id")
      .notNull()
      .references(() => partiesTable.id, { onDelete: "cascade" }),
    /** Which branch raised it. A bill belongs to a branch; a balance does not. */
    showroomId: integer("showroom_id").references(() => showroomsTable.id, {
      onDelete: "set null",
    }),

    /**
     * RECEIVABLE is money owed to the dealership, PAYABLE is money it owes.
     * Kept apart rather than signed, and never netted: an OEM that owes us
     * warranty and is owed for stock has both, and a single figure would hide
     * the unclaimed half.
     */
    direction: text("direction", { enum: ["RECEIVABLE", "PAYABLE"] }).notNull(),

    /** The document number as the party knows it. What goes on a statement. */
    billNo: text("bill_no").notNull(),
    billDate: date("bill_date", { mode: "string" }).notNull(),
    /** When it falls due. Null means on delivery, which is the retail case. */
    dueDate: date("due_date", { mode: "string" }),

    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    /** What is left. Reaches zero and the bill is settled, never deleted. */
    outstanding: numeric("outstanding", { precision: 14, scale: 2 }).notNull(),

    sourceKind: text("source_kind", {
      enum: ["SALE_DOCUMENT", "PURCHASE_INVOICE", "OPENING", "MANUAL"],
    }).notNull(),
    sourceId: integer("source_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("party_bills_party_idx").on(t.partyId, t.direction),
    index("party_bills_open_idx").on(t.ownerId, t.direction, t.billDate),
    /*
     * One bill per source document. A purchase posted twice on a retry would
     * otherwise create the debt twice, and the creditors ledger would show the
     * dealership owing Honda for a consignment it received once.
     */
    uniqueIndex("party_bills_source_unique")
      .on(t.sourceKind, t.sourceId)
      .where(sql`source_id is not null`),
  ],
).enableRLS();

export type PartyBillRow = typeof partyBillsTable.$inferSelect;

/**
 * The manufacturer's invoice, which is where a motorcycle enters the books.
 *
 * Until this table the stock mirror knew a bike had arrived and the ledger did
 * not, so `1200` Vehicle Stock only ever went down. This is the entry that puts
 * it up:
 *
 * ```
 *   Dr  Vehicle Stock         the taxable value
 *   Dr  Input CGST/SGST/IGST  reclaimable, and the reason a dealer is never
 *   Cr  the OEM                       on the composition scheme
 * ```
 *
 * **Input tax is an asset, not a cost.** It is money the government owes back,
 * set off against output tax on the return, and a dealership that posted it to
 * an expense head would overstate its cost of sales by eighteen per cent of
 * every bike it ever bought.
 */
export const purchaseInvoicesTable = pgTable(
  "purchase_invoices",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /** Which branch received the consignment. Usually the hub. */
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => partiesTable.id, { onDelete: "restrict" }),

    /** **Their** number, not ours. We do not issue this document. */
    supplierInvoiceNo: text("supplier_invoice_no").notNull(),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }),

    /**
     * Which supply this was, and it decides which input head the tax lands in.
     *
     * Honda shipping from Haryana to a Delhi dealer is inter-state and carries
     * IGST; a local supplier in the same state carries CGST and SGST. Setting
     * off the wrong one against output tax is a mismatch the portal finds
     * before the dealership does.
     */
    interState: text("inter_state", { enum: ["Y", "N"] }).notNull().default("N"),

    taxableAmount: numeric("taxable_amount", { precision: 14, scale: 2 }).notNull(),
    cgstAmount: numeric("cgst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    sgstAmount: numeric("sgst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    igstAmount: numeric("igst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    cessAmount: numeric("cess_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    /** Freight, handling — anything on their invoice that is not the goods. */
    otherCharges: jsonb("other_charges").$type<Array<{ label: string; amount: number }>>(),
    otherChargesTotal: numeric("other_charges_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),

    /**
     * Whether this appeared in GSTR-2B, and when we looked.
     *
     * The tenth reconciliation. Input credit is only claimable if the supplier
     * actually filed, so a purchase in our books and not in 2B is **credit at
     * risk** and worth chasing before the deadline rather than after it.
     */
    gstr2bStatus: text("gstr2b_status", { enum: ["UNCHECKED", "MATCHED", "MISSING"] })
      .notNull()
      .default("UNCHECKED"),
    gstr2bCheckedAt: timestamp("gstr2b_checked_at", { withTimezone: true }),

    status: text("status", { enum: ["DRAFT", "POSTED", "CANCELLED"] })
      .notNull()
      .default("DRAFT"),
    narration: text("narration"),

    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * One supplier invoice number per supplier. Honda does not issue the same
     * number twice, so a second one is a re-entry - and a re-entered purchase
     * doubles both the stock and the creditor.
     */
    uniqueIndex("purchase_invoices_supplier_no_unique").on(t.supplierId, t.supplierInvoiceNo),
    index("purchase_invoices_owner_date_idx").on(t.ownerId, t.invoiceDate),
    index("purchase_invoices_2b_idx").on(t.ownerId, t.gstr2bStatus),
  ],
).enableRLS();

export type PurchaseInvoiceRow = typeof purchaseInvoicesTable.$inferSelect;

/**
 * One chassis on one purchase invoice.
 *
 * A consignment is several machines on one document, and the **cost of each one
 * individually** is what the sale later relieves. An average would be simpler
 * and wrong: two bikes bought at different prices and sold in different months
 * would each report a margin that neither of them earned, and the stock
 * valuation on the balance sheet would drift from the units actually on the
 * floor.
 */
export const purchaseInvoiceLinesTable = pgTable(
  "purchase_invoice_lines",
  {
    id: serial("id").primaryKey(),
    purchaseInvoiceId: integer("purchase_invoice_id")
      .notNull()
      .references(() => purchaseInvoicesTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),

    modelDescription: text("model_description").notNull(),
    /** The identity of the machine, and what the sale matches against. */
    chassisNo: text("chassis_no"),
    engineNo: text("engine_no"),
    hsn: text("hsn"),

    quantity: integer("quantity").notNull().default(1),
    /** What this one machine cost, before tax. Relieved on its own sale. */
    unitCost: numeric("unit_cost", { precision: 14, scale: 2 }).notNull(),
    gstRatePct: numeric("gst_rate_pct", { precision: 5, scale: 2 }).notNull().default("18"),
    cessRatePct: numeric("cess_rate_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  },
  (t) => [
    index("purchase_invoice_lines_invoice_idx").on(t.purchaseInvoiceId, t.seq),
    /*
     * A chassis number is the identity of one physical machine, so the same one
     * cannot be purchased twice. Without this a re-keyed consignment would put
     * a second copy of a bike that exists once onto the floor and into the
     * stock valuation.
     */
    uniqueIndex("purchase_invoice_lines_chassis_unique")
      .on(t.chassisNo)
      .where(sql`chassis_no is not null`),
  ],
).enableRLS();

export type PurchaseInvoiceLineRow = typeof purchaseInvoiceLinesTable.$inferSelect;
