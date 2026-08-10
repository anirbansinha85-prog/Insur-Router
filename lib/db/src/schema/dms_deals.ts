import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
  date,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { showroomsTable } from "./showrooms";

/**
 * A local mirror of the dealer's DMS.
 *
 * The integration is **read-only**: we pull from the OEM's system and never
 * write back. That is a constraint, not a defect, and it decides the shape of
 * everything here.
 *
 * Why mirror rather than query live on every screen:
 *
 *   - The owner's view is inherently cross-deal — "what is stuck", "what is
 *     aging", "what is at risk". None of that can be answered one deal at a
 *     time.
 *   - Aging is not computable from a live query at all. "Booked twelve days
 *     ago and still uninsured" needs to know when we first saw it and when the
 *     status last moved, which means keeping our own copy over time.
 *   - A shared OEM ERP is slow and occasionally down. A console that goes blank
 *     when the DMS is busy is a console nobody trusts.
 *
 * The cost is staleness, which is handled honestly rather than hidden:
 * `lastSyncedAt` is shown in the UI and refresh is available on demand.
 *
 * **Reconciliation is deliberately not stored here.** Whether DDMS and the DMS
 * agree is derived at read time by comparing this mirror against our own
 * applications and policies. Storing it would create a second thing to keep in
 * sync, and a stale "in sync" flag is worse than no flag.
 */
export const dmsDealsTable = pgTable(
  "dms_deals",
  {
    id: serial("id").primaryKey(),
    /** Which showroom this deal belongs to. Resolved at sync time. */
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    /** The OEM's identifiers, exactly as they appear in their system. */
    dealerCode: text("dealer_code").notNull(),
    dealId: text("deal_id").notNull(),

    // ── Fields we sort, filter and group on ─────────────────────────────────
    // Everything else stays in `raw`. These are lifted out because a worklist
    // that has to unpack JSON for every row is a worklist that gets slow at
    // exactly the moment the dealership gets busy.
    status: text("status").notNull(),
    bookingDate: date("booking_date", { mode: "string" }),
    plannedDeliveryDate: date("planned_delivery_date", { mode: "string" }),
    actualDeliveryDate: date("actual_delivery_date", { mode: "string" }),
    customerName: text("customer_name"),
    customerMobile: text("customer_mobile"),
    modelDescription: text("model_description"),
    chassisNo: text("chassis_no"),
    engineNo: text("engine_no"),
    exShowroomAmount: real("ex_showroom_amount"),

    /**
     * What the **DMS** believes about insurance and registration. Held
     * separately from our own `policies` rows on purpose: the difference
     * between these two is the reconciliation, and collapsing them would
     * destroy the very signal the owner needs.
     */
    dmsPolicyNo: text("dms_policy_no"),
    dmsInsurerCode: text("dms_insurer_code"),
    dmsRegNo: text("dms_reg_no"),
    invoiceNo: text("invoice_no"),
    invoiceDate: date("invoice_date", { mode: "string" }),

    /** The payload exactly as received, so a mapping can be re-derived without a re-sync. */
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    /**
     * Hash of `raw`. Lets a sync tell "unchanged" from "changed" without
     * diffing every field, which is what makes "what moved today" cheap.
     */
    rawHash: text("raw_hash").notNull(),

    // ── Sync and aging metadata ─────────────────────────────────────────────
    /** When this deal first appeared in a sync. The clock for "how old is this". */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * When `status` last changed. This is what makes "stuck in
     * AWAITING_INSURANCE for twelve days" answerable — and that question is
     * the whole reason for a mirror, because nobody has time to check by hand.
     */
    statusSince: timestamp("status_since", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Last time a sync touched this row, whether or not anything changed. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Last time the payload actually differed. Null until something changes. */
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    /**
     * Set when a deal stops appearing in the DMS. Not deleted: a deal that
     * vanishes is itself worth knowing about, and hard-deleting would silently
     * drop history the owner may need.
     */
    disappearedAt: timestamp("disappeared_at", { withTimezone: true }),

    /**
     * How this row got here, and how much of it to believe (OBJ-24, R-85).
     *
     * A value read off a mapped spreadsheet column is not the same fact as one
     * an API returned, and a value a model lifted off a scanned invoice is a
     * third thing again. Nothing downstream may treat them alike — but nothing
     * downstream should have to *know* about them either, which is why this
     * sits beside the projected columns rather than inside them. The worklist
     * reads `invoiceNo`; it does not read `invoiceNo.value`.
     *
     * Same instinct as the `SIM-` prefix on a simulated policy number: the
     * record says what kind of fact it is holding.
     */
    ingestPath: text("ingest_path", { enum: ["API", "REPORT", "DOCUMENT"] })
      .notNull()
      .default("API"),
    /**
     * `field -> confidence`, 0 to 1, only where it is below certainty.
     *
     * Sparse on purpose, exactly as `dealer_policy` is: an API field is 1.0 and
     * writing that against every column on every row would be a megabyte of
     * JSON saying nothing. An absent entry means *no reason to doubt it*.
     */
    fieldConfidence: jsonb("field_confidence").$type<Record<string, number>>(),
    /** The drop this came from, when it came from one. Null on an API pull. */
    ingestBatchId: integer("ingest_batch_id"),
  },
  (t) => [
    unique("dms_deals_dealer_deal_unique").on(t.dealerCode, t.dealId),
    index("dms_deals_showroom_status_idx").on(t.showroomId, t.status),
    index("dms_deals_chassis_idx").on(t.chassisNo),
  ],
).enableRLS();

export const insertDmsDealSchema = createInsertSchema(dmsDealsTable).omit({
  id: true,
});
export type InsertDmsDeal = z.infer<typeof insertDmsDealSchema>;
export type DmsDealRow = typeof dmsDealsTable.$inferSelect;
