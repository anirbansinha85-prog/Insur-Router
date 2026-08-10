import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { usersTable } from "./users";

/**
 * What a model costs, and **when that was true** (OBJ-25, R-87).
 *
 * The dealer's own system is a current-state system: it holds today's price and
 * forgets yesterday's. That is fine for a system whose job is to price today's
 * sale, and it is useless the moment a dealer legitimately sells at an older
 * rate — which happens, is lawful, and is entirely his decision.
 *
 * > *"He might want to sell at an old rate. It is legally not incorrect. Who am
 * > I to stop him — I have to give him the product which gives him the invoice."*
 *
 * So DDMS keeps the history the DMS discards. An invoice picks a list, defaults
 * to the current one, and **prints which one it used**: *priced per list
 * effective 12 July*. A document that quietly used a superseded price and did
 * not say so would be the product hiding the dealer's own commercial decision
 * from the customer it was made for.
 *
 * ## Whose list it is
 *
 * `OEM` lists come down from the manufacturer. `DEALER` lists are the dealer's
 * own — a scheme he is running, a clearance rate on ageing stock. Both are
 * priced from here and the document says which, because *the manufacturer put
 * the price up* and *we chose to hold ours* are different conversations to have
 * with a customer.
 */
export const priceListsTable = pgTable(
  "price_lists",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /**
     * Null means the whole group.
     *
     * A dealer group routinely runs one list across every outlet and
     * occasionally one outlet's own clearance. Both must be expressible, and
     * the narrower one wins.
     */
    showroomId: integer("showroom_id").references(() => showroomsTable.id, {
      onDelete: "cascade",
    }),

    /** What the dealership calls it. Theirs, not ours. */
    name: text("name").notNull(),
    source: text("source", { enum: ["OEM", "DEALER"] }).notNull().default("OEM"),

    /**
     * When it came into force, and when it stopped.
     *
     * `effectiveTo` null means still current. Two lists may overlap — an OEM
     * list and a dealer's clearance running against it — and which applies is
     * the invoice's choice rather than a database constraint, because that
     * choice is a commercial decision and pretending otherwise would make the
     * product have an opinion it is not entitled to.
     */
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),

    /** How it got here — typed in, or ingested (OBJ-24). */
    ingestPath: text("ingest_path", { enum: ["MANUAL", "API", "REPORT", "DOCUMENT"] })
      .notNull()
      .default("MANUAL"),

    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("price_lists_owner_idx").on(t.ownerId, t.effectiveFrom),
    index("price_lists_showroom_idx").on(t.showroomId, t.effectiveFrom),
  ],
).enableRLS();

/**
 * One model on one list.
 *
 * The tax fields live here rather than in a settings screen because that is
 * where the dealer's own system holds them and because they are **per model**:
 * the HSN code and the rate against it are facts about the goods, and a
 * motorcycle above 350cc attracts a cess the one below it does not. Putting a
 * single rate in a policy registry would have been tidier and wrong for half
 * the range.
 */
export const priceListItemsTable = pgTable(
  "price_list_items",
  {
    id: serial("id").primaryKey(),
    priceListId: integer("price_list_id")
      .notNull()
      .references(() => priceListsTable.id, { onDelete: "cascade" }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),

    /** The OEM's code where there is one, and the description otherwise. */
    modelCode: text("model_code"),
    modelDescription: text("model_description").notNull(),

    /** Money as `numeric`, never `real`. A fleet invoice exceeds float4 already. */
    exShowroomAmount: numeric("ex_showroom_amount", { precision: 12, scale: 2 }).notNull(),

    /** Goods classification, and the rates that follow from it. */
    hsn: text("hsn"),
    gstRatePct: numeric("gst_rate_pct", { precision: 5, scale: 2 }).notNull().default("28"),
    /**
     * Compensation cess. Zero on most two-wheelers and three per cent above
     * 350cc, which is precisely why it is per item.
     */
    cessRatePct: numeric("cess_rate_pct", { precision: 5, scale: 2 }).notNull().default("0"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("price_list_items_unique").on(t.priceListId, t.modelDescription),
    index("price_list_items_model_idx").on(t.ownerId, t.modelDescription),
  ],
).enableRLS();

/**
 * The document DDMS issues, and the reason this objective exists.
 *
 * The customer does not necessarily get the DMS's invoice. The dealer may price
 * from an older list, discount against ageing stock, or keep the manufacturer's
 * scheme rather than pass it on — all three are lawful commercial decisions and
 * the product's job is to support them rather than to have an opinion.
 *
 * > **DDMS's document is the DMS's facts plus the commercial agreement, and
 * > neither system holds both.** The DMS does not know what was promised; DDMS
 * > does not know the chassis and the tax split. Only the join produces the
 * > document the customer should get.
 *
 * ## What kind of document this is, and why it is not decoration
 *
 * `kind` is load-bearing (R-89). A `TAX_INVOICE` carries a number from a
 * sequential GST series and can be claimed against. A `SALE_CONFIRMATION`
 * carries the same figures and **is not a tax invoice**, because on that
 * dealership the DMS holds the series — and only one system may (R-90). The
 * document must say which it is, in the title, on the page, in the same way a
 * simulated policy number carries `SIM-` and a held message says nothing was
 * delivered.
 *
 * A `QUOTATION` is the same generator pointed at a deal that has not closed.
 * It was deferred here from OBJ-22 for exactly that reason: it is the invoice's
 * data model with the tax series left off.
 */
export const saleDocumentsTable = pgTable(
  "sale_documents",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    kind: text("kind", {
      enum: ["QUOTATION", "PROFORMA", "TAX_INVOICE", "SALE_CONFIRMATION"],
    }).notNull(),

    /**
     * Our own reference, always present and always ours.
     *
     * Distinct from `taxInvoiceNo` on purpose: every document DDMS issues can
     * be referred to, and only some of them are tax invoices.
     */
    reference: text("reference").notNull(),
    /**
     * The number from the sequential GST series, when this dealership's series
     * is DDMS's to hold. Null on every other kind, and a `TAX_INVOICE` without
     * one is the state this table exists to make unreachable.
     */
    taxInvoiceNo: text("tax_invoice_no"),
    /**
     * The DMS's own invoice number, for linkage.
     *
     * Where the dealer's system holds the series, DDMS's document carries their
     * number so the two can be reconciled — and issues no number of its own,
     * because two systems drawing on one sequential series produces gaps or
     * duplicates and both are audit findings.
     */
    dmsInvoiceNo: text("dms_invoice_no"),

    documentDate: date("document_date", { mode: "string" }).notNull(),

    /** The deal this is about. Mirror-only, referenced and never written. */
    dealerCode: text("dealer_code").notNull(),
    dealId: text("deal_id").notNull(),

    customerName: text("customer_name"),
    customerMobile: text("customer_mobile"),
    customerAddress: text("customer_address"),

    modelDescription: text("model_description"),
    chassisNo: text("chassis_no"),
    engineNo: text("engine_no"),
    hsn: text("hsn"),

    /** Which list priced it, and what it said. Printed on the document (R-87). */
    priceListId: integer("price_list_id").references(() => priceListsTable.id, {
      onDelete: "set null",
    }),
    priceListName: text("price_list_name"),
    priceListEffectiveFrom: date("price_list_effective_from", { mode: "string" }),
    /** True when the list used was not the current one. The document says so. */
    pricedOffCurrentList: text("priced_off_current_list", { enum: ["Y", "N"] })
      .notNull()
      .default("N"),

    exShowroomAmount: numeric("ex_showroom_amount", { precision: 12, scale: 2 }).notNull(),

    /**
     * The discount, split by **who is paying for it** (R-88).
     *
     * The two halves answer different questions and collapsing them loses the
     * money. `dealerDiscount` is the dealer's own margin given away.
     * `oemSchemeAmount` is the manufacturer's, and **the claim is owed on the
     * full scheme amount whatever the customer was told** — a dealer who
     * retains it has made a commercial decision and is still owed it. An
     * unclaimed scheme is money already given away twice.
     */
    dealerDiscount: numeric("dealer_discount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    oemSchemeAmount: numeric("oem_scheme_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    /** How much of the OEM's scheme reached the customer. May be zero. */
    oemSchemePassedOn: numeric("oem_scheme_passed_on", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),

    taxableAmount: numeric("taxable_amount", { precision: 12, scale: 2 }).notNull(),
    gstRatePct: numeric("gst_rate_pct", { precision: 5, scale: 2 }).notNull(),
    cessRatePct: numeric("cess_rate_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    /**
     * The GST split.
     *
     * Intra-state is CGST plus SGST in halves; inter-state is IGST alone. Which
     * applies is place of supply, and the document records the answer rather
     * than the rule, because a document reprinted next year must show what was
     * charged and not what today's rule would charge.
     */
    cgstAmount: numeric("cgst_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    sgstAmount: numeric("sgst_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    igstAmount: numeric("igst_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    cessAmount: numeric("cess_amount", { precision: 12, scale: 2 }).notNull().default("0"),

    /** Insurance, registration, accessories — everything beside the vehicle. */
    otherCharges: jsonb("other_charges").$type<Array<{ label: string; amount: number }>>(),
    otherChargesTotal: numeric("other_charges_total", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),

    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),

    /** The dealership's legal identity at the time, which a group may change. */
    sellerLegalName: text("seller_legal_name"),
    sellerGstin: text("seller_gstin"),
    placeOfSupply: text("place_of_supply"),

    /**
     * `ISSUED` the moment it is generated, because a document with a number
     * from a sequential series exists whether or not anybody liked it.
     * `CANCELLED` keeps the number and says it was cancelled — the same
     * argument as a cancelled message staying a row.
     */
    status: text("status", { enum: ["DRAFT", "ISSUED", "CANCELLED"] })
      .notNull()
      .default("ISSUED"),
    cancelledReason: text("cancelled_reason"),

    /** Null means DDMS generated it unattended, which today never happens. */
    issuedByUserId: integer("issued_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    issuedByName: text("issued_by_name"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("sale_documents_reference_unique").on(t.ownerId, t.reference),
    /**
     * One tax invoice number, ever, per owner.
     *
     * The constraint that makes R-90 true rather than intended. A sequential
     * GST series with a duplicate in it is an audit finding, and application
     * code that generates the next number is one concurrent request away from
     * producing one.
     */
    uniqueIndex("sale_documents_tax_no_unique").on(t.ownerId, t.taxInvoiceNo),
    index("sale_documents_deal_idx").on(t.dealerCode, t.dealId),
    index("sale_documents_owner_idx").on(t.ownerId, t.documentDate),
  ],
).enableRLS();

export const documentKindSchema = z.enum([
  "QUOTATION",
  "PROFORMA",
  "TAX_INVOICE",
  "SALE_CONFIRMATION",
]);
export type DocumentKind = z.infer<typeof documentKindSchema>;

export type PriceListRow = typeof priceListsTable.$inferSelect;
export type PriceListItemRow = typeof priceListItemsTable.$inferSelect;
export type SaleDocumentRow = typeof saleDocumentsTable.$inferSelect;
