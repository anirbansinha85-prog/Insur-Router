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
 * What the dealership is owed, mirrored per outlet.
 *
 * Sixth instance of the same pattern, and the one where the owner-level premise
 * shows up most sharply after spares. A DMS keys the ledger to a dealer code,
 * because a dealer code is what it thinks a business is. Own two outlets and
 * one insurer owes you money in two places, and **neither branch's ageing
 * report can add them up** — so nobody ever has the conversation that number
 * would justify.
 *
 * `partyCode` is what makes that possible: it is stable across outlets, so the
 * projection can group by it without matching on names. Matching insurers by
 * name would work until somebody typed "ICICI Lombard Gen. Ins." and the group
 * exposure quietly halved.
 *
 * Mirror fields are pulled and never written back (R-5). The decision fields
 * below are ours, and each one changes the derived state — a decision field
 * that does not is decoration.
 */
export const dmsReceivablesTable = pgTable(
  "dms_receivables",
  {
    id: serial("id").primaryKey(),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    dealerCode: text("dealer_code").notNull(),
    receivableId: text("receivable_id").notNull(),

    // ── Mirror ──────────────────────────────────────────────────────────────
    partyType: text("party_type").notNull(),
    /** Stable across outlets. The join that makes group exposure visible. */
    partyCode: text("party_code").notNull(),
    partyName: text("party_name").notNull(),
    /** Where a statement of account would go. Null is why some cannot be sent. */
    partyEmail: text("party_email"),
    invoiceNo: text("invoice_no").notNull(),
    invoiceDate: date("invoice_date", { mode: "string" }),
    invoiceAmount: numeric("invoice_amount", { precision: 12, scale: 2 }),
    receivedAmount: numeric("received_amount", { precision: 12, scale: 2 }),
    dueDate: date("due_date", { mode: "string" }),
    /** What it is for — a job card or a deal. The link to the work. */
    againstType: text("against_type"),
    againstKey: text("against_key"),
    narration: text("narration"),
    status: text("status").notNull(),
    lastReceiptDate: date("last_receipt_date", { mode: "string" }),
    /**
     * What the party told the dealership they would pay by, in the dealer's
     * own system. Ours is a different question and there is no field for it
     * here on purpose: a promise we recorded and a promise they recorded are
     * not interchangeable, and only one of them is in their CRM.
     */
    promisedDate: date("promised_date", { mode: "string" }),

    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    rawHash: text("raw_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    disappearedAt: timestamp("disappeared_at", { withTimezone: true }),

    // ── Decision ────────────────────────────────────────────────────────────
    /**
     * When somebody last chased it. A **recency** test rather than a presence
     * one, exactly like `rtoChasedAt`: a chase three months ago is not a reason
     * to leave a bill alone, and a screen that treated it as one would bury
     * the oldest debt on the ledger the moment anybody touched it once.
     */
    chasedAt: timestamp("chased_at", { withTimezone: true }),
    /**
     * Marked disputed by us. This outranks ageing in the derivation, because a
     * disputed bill is not slow — it is blocked, and sending somebody to chase
     * it is sending them to have an argument they cannot win.
     */
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    disputeNote: text("dispute_note"),
  },
  (t) => [
    unique("dms_receivables_dealer_rec_unique").on(t.dealerCode, t.receivableId),
    index("dms_receivables_party_idx").on(t.partyCode),
    index("dms_receivables_due_idx").on(t.showroomId, t.dueDate),
  ],
).enableRLS();

export const insertDmsReceivableSchema = createInsertSchema(dmsReceivablesTable).omit({ id: true });
export type InsertDmsReceivable = z.infer<typeof insertDmsReceivableSchema>;
export type DmsReceivableRow = typeof dmsReceivablesTable.$inferSelect;
