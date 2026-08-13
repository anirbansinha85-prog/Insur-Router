import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { partiesTable, partyBillsTable } from "./parties";

/**
 * Money moving, and where it was meant to go (OBJ-40, R-111).
 *
 * The third of the four events. The sale created the debt, the purchase created
 * what is owed, and until this file nothing ever settled either — so `1100`
 * Sundry Debtors was debited by every sale and credited by nothing, and every
 * customer who had ever paid still appeared to owe.
 *
 * ## Allocation is the whole difficulty, and it is somebody's judgement
 *
 * **Money is allocated to a bill, or it is on account and says so.** Spreading
 * an unallocated receipt across the oldest invoices is the obvious shortcut and
 * it is a guess about which debt the customer meant to settle. A customer
 * disputing one invoice and paying another is an ordinary Tuesday; a product
 * that quietly applied his money to the invoice he is disputing has taken a
 * side in his argument and then reported the result as a fact.
 *
 * So an unallocated receipt is a **real state** with a name — on account — and
 * it stays that way until a person says where it goes.
 */
export const moneyDocumentsTable = pgTable(
  "money_documents",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /** Which branch's till or bank this went through. The day close reads it. */
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    direction: text("direction", { enum: ["RECEIPT", "PAYMENT"] }).notNull(),

    /** Our own number, per owner per financial year. Gapless, and audited. */
    documentNo: text("document_no").notNull(),
    documentDate: date("document_date", { mode: "string" }).notNull(),

    partyId: integer("party_id")
      .notNull()
      .references(() => partiesTable.id, { onDelete: "restrict" }),

    /**
     * How the money moved, and it decides which account it lands in.
     *
     * `CASH` hits `1400` and is what the day close counts. Everything else hits
     * `1500` and is what the bank reconciliation compares. Keeping them apart
     * is the only way either of those two controls works: a UPI receipt counted
     * as cash makes the till short by exactly that amount every evening.
     */
    mode: text("mode", {
      enum: ["CASH", "BANK", "UPI", "CARD", "CHEQUE", "FINANCIER", "ADJUSTMENT"],
    }).notNull(),

    /** The cheque number, the UPI reference, the NEFT UTR. What a bank statement shows. */
    instrumentRef: text("instrument_ref"),
    instrumentDate: date("instrument_date", { mode: "string" }),
    bankName: text("bank_name"),

    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    /**
     * What is still sitting on account.
     *
     * Reaches zero when every rupee has been put against a bill. Stored rather
     * than derived because it is the running state of a decision somebody is
     * still making, and a figure recomputed on read would move under them.
     */
    unallocated: numeric("unallocated", { precision: 14, scale: 2 }).notNull(),

    /**
     * Whether an advance receipt attracts GST, which depends on what it is for
     * (R-118).
     *
     * A booking advance against a **motorcycle** attracts none: the liability
     * arises at the invoice. An advance against a **service job** does attract
     * it, at the time of receipt. A dealership takes both routinely and the two
     * are a different entry, so the document has to know which — and a product
     * that guessed would either short-pay tax or charge a customer twice.
     */
    advanceFor: text("advance_for", { enum: ["GOODS", "SERVICE", "NONE"] })
      .notNull()
      .default("NONE"),

    status: text("status", { enum: ["POSTED", "REVERSED"] }).notNull().default("POSTED"),
    voucherId: integer("voucher_id"),

    narration: text("narration"),
    receivedByUserId: integer("received_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("money_documents_owner_no_unique").on(t.ownerId, t.direction, t.documentNo),
    index("money_documents_party_idx").on(t.partyId, t.documentDate),
    index("money_documents_day_idx").on(t.showroomId, t.documentDate, t.mode),
    /* What is on account, which is the list a person works through. */
    index("money_documents_unallocated_idx")
      .on(t.ownerId, t.direction)
      .where(sql`unallocated::numeric > 0`),
  ],
).enableRLS();

export type MoneyDocumentRow = typeof moneyDocumentsTable.$inferSelect;

/**
 * This much of that receipt against that bill.
 *
 * A separate row rather than a column on either side, because the relationship
 * is many-to-many and every real dealership needs it to be: one cheque settles
 * three invoices, one invoice is settled by a booking advance plus a financier
 * disbursement plus cash on delivery. Collapsing it would force the product to
 * either refuse the ordinary case or start guessing.
 *
 * **Allocations are never edited.** Getting one wrong is undone by reversing it
 * — a row with a negative amount pointing at the original — for the same reason
 * a voucher is never edited: what somebody decided in April has to still read
 * as what they decided in April.
 */
export const billAllocationsTable = pgTable(
  "bill_allocations",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    moneyDocumentId: integer("money_document_id")
      .notNull()
      .references(() => moneyDocumentsTable.id, { onDelete: "cascade" }),
    partyBillId: integer("party_bill_id")
      .notNull()
      .references(() => partyBillsTable.id, { onDelete: "restrict" }),

    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),

    /** Set on a reversing allocation, pointing at what it undoes. */
    reversalOfId: integer("reversal_of_id"),

    /**
     * Who decided this, and it matters (R-111).
     *
     * `PERSON` is somebody choosing which invoice this money settles.
     * `AUTOMATIC` is the product doing it where there is exactly one open bill
     * and the amount matches it exactly — the only case with no judgement in it,
     * because there is nothing to choose between.
     */
    decidedBy: text("decided_by", { enum: ["PERSON", "AUTOMATIC"] })
      .notNull()
      .default("PERSON"),
    decidedByUserId: integer("decided_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bill_allocations_doc_idx").on(t.moneyDocumentId),
    index("bill_allocations_bill_idx").on(t.partyBillId),
  ],
).enableRLS();

export type BillAllocationRow = typeof billAllocationsTable.$inferSelect;

/**
 * Cash counted against cash booked, every evening, per branch (OBJ-40).
 *
 * The one control that catches a problem the same day. Everything else in this
 * module finds a difference at the end of a month or the end of a year; a till
 * that is nine hundred rupees short is found while the person who was on it is
 * still in the building.
 *
 * ## The difference is named, never absorbed
 *
 * A day close that quietly wrote a journal for the difference would be a day
 * close that hid exactly what it exists to surface. So the shortfall or excess
 * is recorded with a reason typed by a person, and `UNEXPLAINED` is a real and
 * permitted answer — an honest unexplained difference is worth more than a
 * fabricated explanation, and a pattern of them is itself the finding.
 */
export const dayClosesTable = pgTable(
  "day_closes",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    closeDate: date("close_date", { mode: "string" }).notNull(),

    /** What the books say the till should hold, from the cash receipts and payments. */
    bookedCash: numeric("booked_cash", { precision: 14, scale: 2 }).notNull(),
    /** What somebody counted. The only figure here a computer cannot produce. */
    countedCash: numeric("counted_cash", { precision: 14, scale: 2 }).notNull(),
    /** Counted less booked. Positive is an excess, negative is a shortfall. */
    difference: numeric("difference", { precision: 14, scale: 2 }).notNull(),

    reason: text("reason", {
      enum: ["EXACT", "UNEXPLAINED", "MISCOUNT", "UNRECORDED_RECEIPT", "UNRECORDED_PAYMENT", "OTHER"],
    })
      .notNull()
      .default("EXACT"),
    reasonNote: text("reason_note"),

    /** Non-cash totals for the day, so the bank reconciliation has a starting point. */
    bankReceipts: numeric("bank_receipts", { precision: 14, scale: 2 }).notNull().default("0"),
    bankPayments: numeric("bank_payments", { precision: 14, scale: 2 }).notNull().default("0"),

    closedByUserId: integer("closed_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* One close per branch per day. A day closed twice is a day whose figures
     * nobody can quote, and the second close would silently supersede the first
     * without anybody being told the first one existed. */
    uniqueIndex("day_closes_branch_date_unique").on(t.showroomId, t.closeDate),
    index("day_closes_owner_date_idx").on(t.ownerId, t.closeDate),
    index("day_closes_difference_idx")
      .on(t.ownerId, t.closeDate)
      .where(sql`difference::numeric <> 0`),
  ],
).enableRLS();

export type DayCloseRow = typeof dayClosesTable.$inferSelect;
