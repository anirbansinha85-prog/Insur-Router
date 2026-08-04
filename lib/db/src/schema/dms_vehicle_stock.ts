import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
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
 * The floor — every vehicle the dealership is holding, and how long it has held it.
 *
 * Seventh mirror, and the one where the cost of doing nothing is arithmetic.
 * Almost all dealership stock is bought on a floor-plan line, so a unit that
 * does not sell is not merely idle: it accrues interest every day, at a rate
 * the dealership already knows and never sees attached to a specific bike.
 *
 * `receivedDate` is the field the whole screen turns on and nothing in the
 * dealer's system subtracts it from today. `costAmount` and `interestRatePct`
 * are the other two, and between them the three answer a question no report
 * asks: *what is this particular vehicle costing us this month.*
 *
 * The finding that needs no arithmetic at all is the one across modules: a unit
 * ageing on this floor and an open enquiry — at either outlet — asking for that
 * exact model. The stock screen cannot see the CRM and the CRM cannot see the
 * floor, so a bike somebody wants stands next to a person who wants it and
 * neither system is capable of noticing.
 */
export const dmsVehicleStockTable = pgTable(
  "dms_vehicle_stock",
  {
    id: serial("id").primaryKey(),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    dealerCode: text("dealer_code").notNull(),
    chassisNo: text("chassis_no").notNull(),

    // ── Mirror ──────────────────────────────────────────────────────────────
    engineNo: text("engine_no"),
    modelCode: text("model_code").notNull(),
    modelDescription: text("model_description"),
    variantDescription: text("variant_description"),
    colourDescription: text("colour_description"),
    status: text("status").notNull(),
    /** Set once somebody puts a customer's name on the unit. */
    allocatedDealId: text("allocated_deal_id"),
    costAmount: numeric("cost_amount", { precision: 12, scale: 2 }),
    /** `Y` when the unit sits on the floor-plan line and the interest runs. */
    isFinanced: text("is_financed"),
    /** Annual percentage, null when the unit is not financed. */
    interestRatePct: numeric("interest_rate_pct", { precision: 6, scale: 2 }),
    receivedDate: date("received_date", { mode: "string" }),
    allocatedDate: date("allocated_date", { mode: "string" }),
    invoicedDate: date("invoiced_date", { mode: "string" }),

    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    rawHash: text("raw_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    disappearedAt: timestamp("disappeared_at", { withTimezone: true }),

    // ── Decision ────────────────────────────────────────────────────────────
    /**
     * The enquiry this unit was offered against, and when.
     *
     * The cross-module finding, acted on. It changes the derived state because
     * a bike somebody has already been offered is not the same problem as one
     * nobody has mentioned — and without this, the screen would go on
     * suggesting the same call every morning.
     */
    offeredToEnqId: text("offered_to_enq_id"),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    /**
     * Proposed for transfer to the outlet whose customer wants it.
     *
     * Same shape as the spares transfer and the same premise: the group already
     * owns the thing somebody is waiting for, and only an owner-level view can
     * say so.
     */
    transferProposedAt: timestamp("transfer_proposed_at", { withTimezone: true }),
    transferToShowroomId: integer("transfer_to_showroom_id"),
  },
  (t) => [
    unique("dms_vehicle_stock_chassis_unique").on(t.chassisNo),
    index("dms_vehicle_stock_showroom_idx").on(t.showroomId, t.status),
    index("dms_vehicle_stock_model_idx").on(t.modelCode),
  ],
).enableRLS();

export const insertDmsVehicleStockSchema = createInsertSchema(dmsVehicleStockTable).omit({
  id: true,
});
export type InsertDmsVehicleStock = z.infer<typeof insertDmsVehicleStockSchema>;
export type DmsVehicleStockRow = typeof dmsVehicleStockTable.$inferSelect;
