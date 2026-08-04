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
 * A mirror of the parts counter — fifth instance of the pattern, and the first
 * one whose whole value comes from **being owner-level rather than
 * showroom-level**.
 *
 * The other four modules each read something a single branch could in principle
 * have noticed and did not. This one reads something a single branch *cannot*
 * notice, however carefully it looks. A DMS keeps the stock ledger against a
 * dealer code, because a dealer code is what it thinks a business is. An owner
 * with three outlets gets three ledgers and no way to ask the only question
 * that matters at the counter:
 *
 * > **Does anybody in this company already have the part I am about to order —
 * > or the part a customer has been waiting three days for?**
 *
 * That question is why DDMS is bought by an owner and not by a dealer principal
 * at one branch, and this table is the first place the product answers it.
 *
 * Keyed on `(showroomId, partNo)` rather than `(dealerCode, partNo)`, unlike
 * every mirror before it. Stock is physically at an outlet, not at a dealer
 * code, and one showroom may carry two brands' codes at one address with one
 * set of shelves.
 */
export const dmsPartStockTable = pgTable(
  "dms_part_stock",
  {
    id: serial("id").primaryKey(),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    dealerCode: text("dealer_code").notNull(),
    partNo: text("part_no").notNull(),

    // ── Mirror fields: theirs, never written back ───────────────────────────
    partDesc: text("part_desc"),
    binLocation: text("bin_location"),
    qtyOnHand: integer("qty_on_hand").notNull().default(0),
    /**
     * Committed to an open job card. The number the counter screen does *not*
     * show, which is how one brake shoe gets promised to two customers.
     */
    qtyReserved: integer("qty_reserved").notNull().default(0),
    reorderLevel: integer("reorder_level").notNull().default(0),
    mrpAmount: real("mrp_amount"),
    /** What the dealership paid. What stock that never moves is costing. */
    costAmount: real("cost_amount"),
    lastReceivedDate: date("last_received_date", { mode: "string" }),
    /** Null means it has never moved since the day it arrived. */
    lastIssuedDate: date("last_issued_date", { mode: "string" }),
    onOrderQty: integer("on_order_qty").notNull().default(0),
    onOrderEtaDate: date("on_order_eta_date", { mode: "string" }),

    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    rawHash: text("raw_hash").notNull(),

    // ── Decision fields: ours ───────────────────────────────────────────────
    /**
     * When we asked another branch to send this part over.
     *
     * There is no such event in any DMS, because an inter-branch transfer is not
     * a transaction either branch's system has a concept of — each one only
     * knows its own shelf. Load-bearing: a part available elsewhere with this
     * set is on its way, one without it is a customer still waiting while the
     * company already owns the answer.
     */
    transferRequestedAt: timestamp("transfer_requested_at", { withTimezone: true }),
    /** Where we asked. Kept so the row can say it without a second lookup. */
    transferFromShowroomId: integer("transfer_from_showroom_id").references(
      () => showroomsTable.id,
      { onDelete: "set null" },
    ),
    /**
     * When somebody raised a purchase order for a line that had fallen below
     * its reorder level. Distinct from the DMS's own `onOrderQty`: that says an
     * order exists in their system, this says we noticed and acted. A line can
     * legitimately have the second without the first for the days in between.
     */
    reorderRaisedAt: timestamp("reorder_raised_at", { withTimezone: true }),

    // ── Sync metadata ───────────────────────────────────────────────────────
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    disappearedAt: timestamp("disappeared_at", { withTimezone: true }),
  },
  (t) => [
    unique("dms_part_stock_showroom_part_unique").on(t.showroomId, t.partNo),
    /** The cross-branch lookup, and the reason this module exists. */
    index("dms_part_stock_part_idx").on(t.partNo),
    index("dms_part_stock_showroom_idx").on(t.showroomId),
  ],
).enableRLS();

export const insertDmsPartStockSchema = createInsertSchema(dmsPartStockTable).omit({
  id: true,
});
export type InsertDmsPartStock = z.infer<typeof insertDmsPartStockSchema>;
export type DmsPartStockRow = typeof dmsPartStockTable.$inferSelect;
