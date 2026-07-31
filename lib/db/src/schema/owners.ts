import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * The owner — the customer, and the top of the hierarchy.
 *
 * Everything before this table assumed a dealership was the unit of sale. It
 * is not: a small-business owner often runs several showrooms, and what he is
 * buying is visibility and control *across* them. Nothing in the schema could
 * express "these two outlets are the same person's" until now — `dealerCode`
 * was the top of the tree, and a dealer code is the OEM's identifier, not ours.
 *
 * This is also the tenant boundary. Every scoped query resolves to an owner,
 * and an owner never sees another owner's rows. That matters more than it
 * looks: `/api` currently has no authentication at all, which is harmless as a
 * single local process and unsafe the moment a second owner exists in the same
 * database. This table is what a future auth layer resolves a caller *to*.
 */
export const ownersTable = pgTable("owners", {
  id: serial("id").primaryKey(),
  /** Short stable handle, used in URLs and logs rather than the numeric id. */
  code: text("code").notNull().unique(),
  /** What the group is called day to day. */
  name: text("name").notNull(),
  /**
   * The registered entity, when the group has one. Deliberately nullable: many
   * owner groups are not a single legal person — the showrooms are separate
   * companies with a common proprietor, which is exactly the seeded case.
   */
  legalName: text("legal_name"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}).enableRLS();

export const insertOwnerSchema = createInsertSchema(ownersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOwner = z.infer<typeof insertOwnerSchema>;
export type Owner = typeof ownersTable.$inferSelect;
