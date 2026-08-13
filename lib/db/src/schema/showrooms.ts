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
 * ## A showroom is a branch, and a branch is a cost centre (OBJ-37, R-119)
 *
 * `entityId` and `registrationId` say which legal person this outlet belongs to
 * and which GST registration it invoices under. They replace `legalName` and
 * `gstin`, which sat here because the first fixture was two separate companies
 * and which were wrong for the ordinary case: **one owner, one company, several
 * branches, run hub-and-spoke from a main location.** Under that shape a branch
 * has no GSTIN of its own - it invoices under its entity's - and moving a
 * chassis from the hub to a satellite is not a supply at all.
 *
 * The two old columns survive as **nullable, deprecated** and are read by
 * nothing. They stay through one migration so the reseed can be checked against
 * what they said, and go in the objective after this one.
 *
 * `role` is a real field rather than a label because it changes behaviour: a
 * BigWing outlet selling a Gold Wing crosses the ten-lakh TCS threshold on
 * every sale and a 1S satellite never will, and a service outlet issues
 * documents a sales outlet does not.
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
    /**
     * The legal person this branch belongs to, and the registration it invoices
     * under. Nullable through the migration only; after it, every branch has
     * both and the resolver refuses a branch that does not.
     */
    entityId: integer("entity_id"),
    registrationId: integer("registration_id"),

    /**
     * What this outlet is, and it decides what it can do.
     *
     *   HUB      4S: sales, service, spares, stockyard. Holds the finance team.
     *   SALES    1S/2S satellite. Footfall and bookings; stock allocated to it.
     *   SERVICE  authorised service centre. Labour and parts, no vehicle sales.
     *   PREMIUM  the big-bike outlet, where TCS above ten lakh actually bites.
     *
     * Defaulting to SALES is the honest default: an outlet nobody has classified
     * sells bikes, which is what a showroom is, and the roles that change
     * behaviour are the ones somebody has to choose deliberately.
     */
    role: text("role", { enum: ["HUB", "SALES", "SERVICE", "PREMIUM"] })
      .notNull()
      .default("SALES"),

    /** @deprecated Moved to `legal_entities`. Read by nothing (OBJ-37). */
    legalName: text("legal_name"),
    /** @deprecated Moved to `gst_registrations`. Read by nothing (OBJ-37). */
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
