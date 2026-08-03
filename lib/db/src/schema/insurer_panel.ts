import {
  pgTable,
  text,
  serial,
  integer,
  real,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { providersTable } from "./providers";
import { showroomDmsAccountsTable } from "./showrooms";

/**
 * One insurer on one outlet's panel.
 *
 * This is the join that was missing, and its absence was the reason two
 * separate insurer models existed. Each answers a different question:
 *
 *   `providers`            *how do we talk to this insurer* — API endpoint,
 *                          portal URL, execution mode. Global; the same for
 *                          everyone, because it describes the insurer.
 *   this table             *what is this dealer's arrangement with them* —
 *                          quota, payout, turnaround, whether it is switched
 *                          on. Per tenant, because it is a commercial deal.
 *
 * Neither is derivable from the other, so neither replaces the other. What was
 * wrong was that the second one lived only in the mock's memory, which meant
 * the real server could route to an insurer the dealer has no arrangement with,
 * or place a policy against a quota that was already full.
 *
 * **Hung off the DMS account, not the showroom.** The commercial arrangement is
 * made by the legal entity through a particular OEM channel, which is exactly
 * where `insuranceChannel` already sits. A showroom selling two brands can hold
 * genuinely different panels, and keying on the account keeps that possible.
 * It also means `route` is not stored here — it *is* the account's
 * `insuranceChannel`, and storing it twice would let the two disagree.
 */
export const insurerPanelEntriesTable = pgTable(
  "insurer_panel_entries",
  {
    id: serial("id").primaryKey(),
    dmsAccountId: integer("dms_account_id")
      .notNull()
      .references(() => showroomDmsAccountsTable.id, { onDelete: "cascade" }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providersTable.id, { onDelete: "cascade" }),

    /**
     * Integration surface for *this dealer's* access to the insurer. Not the
     * same as `providers.defaultExecutionMode`: a broker platform can front an
     * insurer through a web portal even where that insurer publishes an API,
     * because what the dealer can reach is the broker's screen, not the
     * insurer's endpoint.
     */
    integration: text("integration", { enum: ["API", "PORTAL"] }).notNull(),

    /** Filed own-damage rate as a fraction of IDV, before zone loading. */
    odBaseRate: real("od_base_rate").notNull(),

    /**
     * Volume committed to this insurer for the period, and what has gone
     * against it. Today this lives in a spreadsheet or a manager's head, and
     * the person at the counter picks an insurer with no sight of it — which is
     * the actual product, not the data entry.
     */
    quotaPolicies: integer("quota_policies").notNull().default(0),
    quotaConsumed: integer("quota_consumed").notNull().default(0),
    /**
     * Which period the two numbers above describe, e.g. "2026-Q3". Free text
     * and not enforced: nothing rolls the counter over yet, and a column that
     * says which period the numbers belong to is more honest than counters with
     * no period at all.
     */
    quotaPeriod: text("quota_period"),

    /** Commission the dealer earns, as a fraction of OD premium. */
    payoutRate: real("payout_rate").notNull().default(0),
    /** Turnaround the dealer can promise the customer. */
    slaMinutes: integer("sla_minutes").notNull().default(0),
    isEnabled: boolean("is_enabled").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("insurer_panel_account_provider_unique").on(
      t.dmsAccountId,
      t.providerId,
    ),
  ],
).enableRLS();

export const insertInsurerPanelEntrySchema = createInsertSchema(
  insurerPanelEntriesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInsurerPanelEntry = z.infer<
  typeof insertInsurerPanelEntrySchema
>;
export type InsurerPanelEntry = typeof insurerPanelEntriesTable.$inferSelect;
