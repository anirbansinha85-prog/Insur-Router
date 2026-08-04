import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { usersTable } from "./users";

/**
 * The dealership's own numbers.
 *
 * Two things decided how a short-staffed dealership spends its day, and until
 * OBJ-18 both of them were ours: the severity table that orders the queue, and
 * the thresholds each classifier uses to decide when something has gone wrong.
 * *Is a stuck registration worse than a broken payment promise* and *how many
 * days on the floor before a bike is ageing* are not product questions. They
 * were one afternoon's judgement written into a file, applied to every
 * dealership that ever uses this.
 *
 * ## Why this is a table of numbers and not a settings store
 *
 * **The key set is closed.** `lib/dms/policy.ts` holds every key that may
 * exist, with its default, its range and a sentence saying what it means, and
 * a key not in that registry is rejected. So this table cannot grow new
 * behaviour — only different numbers for behaviour that already exists.
 *
 * That is the R-52 line, and it is the whole difference between configuration
 * and a rule builder. Eighty numbers in a table cannot become an automation
 * layer nobody can predict; eighty *flows* can, and that is the failure mode
 * this product is designed against. A dealership with no administrator can
 * safely be handed numbers. It cannot safely be handed logic.
 *
 * ## Sparse on purpose
 *
 * A row exists only where somebody set something. No row means the product's
 * default, which makes *"reset to the defaults"* a delete rather than a write
 * of remembered defaults that would then drift from the code when the code
 * changed its mind. It also means a fresh dealership starts with an empty table
 * and working numbers.
 */
export const dealerPolicyTable = pgTable(
  "dealer_policy",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /**
     * From the closed registry in `lib/dms/policy.ts`. Two shapes:
     *
     *   `SEVERITY.REGISTRATION.RC_IN_DRAWER`  what comes first
     *   `THRESHOLD.DEAD_STOCK_DAYS`           when something has gone wrong
     */
    key: text("key").notNull(),
    /**
     * Integers only, and the registry carries the range.
     *
     * Every number a dealership sets here is a count of days or a rank, so
     * there is nothing to represent that an integer cannot. Money would need a
     * different column type and would also need a currency, and the moment one
     * of those appears it should be its own column rather than a value squeezed
     * through this one.
     */
    value: integer("value").notNull(),
    /** Who last set it. The change is in `decision_log` too, with the old value. */
    updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dealer_policy_owner_key").on(t.ownerId, t.key)],
).enableRLS();

export const insertDealerPolicySchema = createInsertSchema(dealerPolicyTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDealerPolicy = z.infer<typeof insertDealerPolicySchema>;
export type DealerPolicyRow = typeof dealerPolicyTable.$inferSelect;
