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
 * A mirror of the dealer's workshop, and the second instance of the pattern.
 *
 * Structurally this is `dms_deals` again: raw payload, a hash to tell moved
 * from unmoved, the columns a worklist sorts on, and our own clock. That it
 * repeats is the point — once the mirror pattern exists, a new module is a
 * table and a projection rather than a fresh integration.
 *
 * What differs is the question being answered. A deal asks *is it insured*, and
 * two systems either hold the same policy number or they do not. A job card
 * asks *is the promise being kept, and has anyone told the customer* — which no
 * status field anywhere records, because a workshop's own system tracks the
 * vehicle, not the conversation.
 *
 * Hence the one decision field below. It is not decoration: it changes the
 * derived state, which is the test for whether a field has earned its place.
 */
export const dmsJobCardsTable = pgTable(
  "dms_job_cards",
  {
    id: serial("id").primaryKey(),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    dealerCode: text("dealer_code").notNull(),
    jcNo: text("jc_no").notNull(),

    // ── Mirror fields: theirs, never written back ───────────────────────────
    status: text("status").notNull(),
    jcType: text("jc_type").notNull(),
    jcDate: date("jc_date", { mode: "string" }),
    /** What the customer was told. The number the workshop is judged on. */
    promisedDate: date("promised_date", { mode: "string" }),
    actualCloseDate: date("actual_close_date", { mode: "string" }),
    customerName: text("customer_name"),
    customerMobile: text("customer_mobile"),
    modelDescription: text("model_description"),
    regNo: text("reg_no"),
    chassisNo: text("chassis_no"),
    advisorEmpCode: text("advisor_emp_code"),
    estimateAmount: real("estimate_amount"),
    finalAmount: real("final_amount"),
    /**
     * True when at least one part line is still unissued. Lifted out of the
     * lines because "which cards are held up by a part" is the query, and
     * unpacking JSON per row is what makes a worklist slow exactly when the
     * workshop is busy.
     */
    hasUnissuedPart: text("has_unissued_part"),
    /** Whether a post-service follow-up call was ever recorded. */
    psfDone: text("psf_done"),

    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    rawHash: text("raw_hash").notNull(),

    // ── Decision field: ours ────────────────────────────────────────────────
    /**
     * When we recorded that the customer was actually told where their vehicle
     * is.
     *
     * The DMS has no such column, because telling someone is not a workshop
     * event — and that gap is the entire reason a vehicle sits finished for
     * four days. Load-bearing rather than speculative: a READY card with this
     * set is waiting on the customer, and one without it is waiting on us.
     */
    customerInformedAt: timestamp("customer_informed_at", { withTimezone: true }),

    // ── Sync metadata ───────────────────────────────────────────────────────
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    statusSince: timestamp("status_since", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    disappearedAt: timestamp("disappeared_at", { withTimezone: true }),
  },
  (t) => [
    unique("dms_job_cards_dealer_jc_unique").on(t.dealerCode, t.jcNo),
    index("dms_job_cards_showroom_status_idx").on(t.showroomId, t.status),
  ],
).enableRLS();

export const insertDmsJobCardSchema = createInsertSchema(dmsJobCardsTable).omit({
  id: true,
});
export type InsertDmsJobCard = z.infer<typeof insertDmsJobCardSchema>;
export type DmsJobCardRow = typeof dmsJobCardsTable.$inferSelect;
