import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";

/**
 * A showroom — one physical outlet belonging to an owner.
 *
 * **A showroom is not an OEM dealer code.** That was the tempting shortcut and
 * it breaks on the first real customer:
 *
 *   - one owner may hold two brands at a single address, which is two dealer
 *     codes and one showroom;
 *   - one brand may be sold from three outlets, which is one dealer code family
 *     and three showrooms;
 *   - a service centre has no dealer code at all and still needs to appear in
 *     the owner's view.
 *
 * So a showroom is our own entity, and the OEM's codes hang off it in
 * `showroom_dms_accounts`. The extra table costs one join and survives all
 * three cases.
 *
 * `legalName` and `gstin` sit here rather than on the owner because a group
 * routinely spans legal entities — the two seeded outlets are a Pvt Ltd and an
 * LLP with different GST registrations and different insurance arrangements.
 * Invoicing and compliance follow the entity, not the group.
 */
export const showroomsTable = pgTable(
  "showrooms",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /** Short stable handle, unique within the owner. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** The registered entity that actually raises the invoice. */
    legalName: text("legal_name"),
    gstin: text("gstin"),
    addressLine: text("address_line"),
    city: text("city"),
    state: text("state"),
    pincode: text("pincode"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("showrooms_owner_code_unique").on(t.ownerId, t.code)],
).enableRLS();

/**
 * The link to an OEM's dealer management system.
 *
 * One row per (showroom, OEM). A showroom selling two brands has two rows and
 * therefore two DMS integrations behind one screen — which is the whole reason
 * this is a separate table rather than a column.
 *
 * `dealerCode` is globally unique because it is the OEM's identifier and one
 * code cannot belong to two showrooms. That constraint is what lets a DMS pull
 * resolve a `dealerCode` straight back to a showroom, and through it to an
 * owner, without the caller having to say who they are.
 */
export const showroomDmsAccountsTable = pgTable(
  "showroom_dms_accounts",
  {
    id: serial("id").primaryKey(),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    /** Which OEM's system this is — selects the adapter. */
    oemCode: text("oem_code").notNull(),
    /** The OEM's own identifier for this outlet, e.g. HMC-DL-0417. */
    dealerCode: text("dealer_code").notNull(),
    /**
     * How this showroom reaches insurers for deals from this account. Held per
     * account, not per showroom: the arrangement is made by the legal entity
     * with the OEM's channel behind it, and the two seeded outlets genuinely
     * differ — one goes through a broker platform, one holds its own agency
     * code.
     */
    insuranceChannel: text("insurance_channel", {
      enum: ["BROKER", "DIRECT_AGENT"],
    }),
    intermediaryName: text("intermediary_name"),
    intermediaryCode: text("intermediary_code"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("showroom_dms_accounts_dealer_code_unique").on(t.dealerCode)],
).enableRLS();

export const insertShowroomSchema = createInsertSchema(showroomsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertShowroom = z.infer<typeof insertShowroomSchema>;
export type Showroom = typeof showroomsTable.$inferSelect;

export const insertShowroomDmsAccountSchema = createInsertSchema(
  showroomDmsAccountsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertShowroomDmsAccount = z.infer<
  typeof insertShowroomDmsAccountSchema
>;
export type ShowroomDmsAccount = typeof showroomDmsAccountsTable.$inferSelect;
