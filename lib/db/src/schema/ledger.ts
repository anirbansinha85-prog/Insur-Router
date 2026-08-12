import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * The dealership's chart of accounts (OBJ-31, R-98).
 *
 * ## Shaped like Tally's, because that is where the numbers are going
 *
 * R-98 says the ledger is a feeder before it is a book of record: it produces
 * vouchers for whatever the dealership already keeps, and becomes the record
 * only once its numbers have reconciled against that system for an agreed
 * period. A chart of accounts invented from first principles would be elegant
 * and would not map onto the one their CA has been using for eleven years, so
 * `tallyName` is a column and the seeded names are the ones Tally ships with —
 * *Sundry Debtors*, *Output CGST*, *Sales Accounts*.
 *
 * ## Per owner, and editable, with the product's set as the default
 *
 * The same shape as the policy registry and for the same reason: which accounts
 * exist is the dealership's business, what the posting rules *do* with them is
 * not. `isSystem` marks the accounts the posting rules name by code — those can
 * be renamed and remapped and cannot be deleted, because a posting rule that
 * cannot find its account has no honest behaviour available to it.
 */
export const ledgerAccountsTable = pgTable(
  "ledger_accounts",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),

    /** Stable, and what the posting rules refer to. Never shown to a customer. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** What this maps to in the dealership's own books. Theirs to change. */
    tallyName: text("tally_name"),

    group: text("group", {
      enum: ["ASSET", "LIABILITY", "INCOME", "EXPENSE", "EQUITY"],
    }).notNull(),

    /**
     * Named by a posting rule, so it may be renamed and not removed.
     *
     * A rule that cannot find its account has no honest behaviour: posting to a
     * substitute silently misstates the books, and skipping the line produces a
     * voucher that does not balance. Refusing the deletion is the only answer
     * that leaves the numbers true.
     */
    isSystem: text("is_system", { enum: ["Y", "N"] }).notNull().default("N"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_accounts_owner_code_unique").on(t.ownerId, t.code),
    index("ledger_accounts_owner_group_idx").on(t.ownerId, t.group),
  ],
).enableRLS();

export type LedgerAccountRow = typeof ledgerAccountsTable.$inferSelect;

/**
 * One double-entry voucher (OBJ-31, R-100, R-101).
 *
 * ## It names the document it came from, and one document posts once
 *
 * R-101, and the unique index is the whole of it: a partial unique on
 * `(sourceKind, sourceId)` where the voucher is still posted. Re-posting a
 * corrected invoice **reverses and re-issues** — a new voucher with mirrored
 * lines pointing back through `reversalOfId`, and then a fresh one — and never
 * edits a posted voucher. An edited voucher is how a set of books stops being
 * evidence of anything.
 *
 * ## Nothing here is derived on read
 *
 * Unlike almost every other number in this product. Reconciliation, severity,
 * the queue and the overall view are all computed at read time because a stale
 * flag is worse than none. **A voucher is the opposite**: it is a statement
 * about a moment, it has to still say the same thing next March, and a ledger
 * that recomputed itself from today's mirror would restate last year's accounts
 * every time a customer's address was corrected.
 *
 * ## `warnings` is not decoration
 *
 * A sale whose vehicle cannot be found in stock is posted **with the revenue
 * and without the cost relief**, and the warning says so. R-102's failure is a
 * ledger that credits revenue and never credits stock, thereby reporting the
 * ex-showroom price as margin; the honest version of that is not to refuse the
 * posting but to make the gap loud. Same for a charge whose label nothing
 * recognises — it goes to suspense, never to income.
 */
export const vouchersTable = pgTable(
  "vouchers",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    kind: text("kind", {
      enum: ["SALES", "PURCHASE", "RECEIPT", "PAYMENT", "JOURNAL", "CREDIT_NOTE"],
    }).notNull(),

    /** Per owner, per financial year, per kind. Sequential and gapless. */
    voucherNo: text("voucher_no").notNull(),
    voucherDate: date("voucher_date", { mode: "string" }).notNull(),
    /** April to March, as `2026-27`. Every Indian statutory question needs it. */
    financialYear: text("financial_year").notNull(),

    narration: text("narration"),

    /** What this posts. `SALE_DOCUMENT` is the only source today. */
    sourceKind: text("source_kind", { enum: ["SALE_DOCUMENT", "MANUAL"] }).notNull(),
    sourceId: integer("source_id"),

    status: text("status", { enum: ["POSTED", "REVERSED"] }).notNull().default("POSTED"),
    /** Set on a reversing voucher, pointing at what it undoes. */
    reversalOfId: integer("reversal_of_id"),
    reversedByVoucherId: integer("reversed_by_voucher_id"),
    reversalReason: text("reversal_reason"),

    /**
     * Both sides, stored.
     *
     * Redundant with the lines and deliberately so: a voucher that does not
     * balance must be impossible to save, and comparing two stored totals is
     * a check the database itself can carry. Recomputing from the lines to find
     * out is the version that discovers the problem in March.
     */
    totalDebit: numeric("total_debit", { precision: 14, scale: 2 }).notNull(),
    totalCredit: numeric("total_credit", { precision: 14, scale: 2 }).notNull(),

    /** What the posting could not do, and why. Never silent. */
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),

    /** Whether this has been handed to the dealership's own system (R-98). */
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    exportBatch: text("export_batch"),

    postedByUserId: integer("posted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("vouchers_owner_no_unique").on(t.ownerId, t.kind, t.financialYear, t.voucherNo),
    /*
     * R-101 in one index: one *posted* voucher per source document.
     *
     * Partial, because the history has to accumulate — a reversed voucher stays
     * and must stop blocking the corrected one. Without this the same invoice
     * posts twice on a retry and the month's sales are overstated by the price
     * of a motorcycle, which is exactly the class of error nobody notices until
     * a return is filed.
     */
    uniqueIndex("vouchers_source_unique")
      .on(t.sourceKind, t.sourceId)
      .where(sql`status = 'POSTED' and source_id is not null`),
    index("vouchers_owner_date_idx").on(t.ownerId, t.voucherDate),
    index("vouchers_export_idx").on(t.ownerId, t.exportedAt),
  ],
).enableRLS();

export type VoucherRow = typeof vouchersTable.$inferSelect;

/**
 * One side of one entry (OBJ-31, R-100).
 *
 * Debit and credit as separate columns rather than a signed amount. A signed
 * amount is one negation away from a voucher that balances to zero while
 * saying the opposite of what happened, and every accountant who reads this
 * expects two columns. Exactly one of the pair is non-zero on any line.
 */
export const voucherLinesTable = pgTable(
  "voucher_lines",
  {
    id: serial("id").primaryKey(),
    voucherId: integer("voucher_id")
      .notNull()
      .references(() => vouchersTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),

    accountId: integer("account_id")
      .notNull()
      .references(() => ledgerAccountsTable.id),
    /** Denormalised so an export does not have to join, and so history survives a rename. */
    accountCode: text("account_code").notNull(),
    accountName: text("account_name").notNull(),

    debit: numeric("debit", { precision: 14, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 14, scale: 2 }).notNull().default("0"),

    narration: text("narration"),
    /** The customer or party this line is against, for a debtors ledger. */
    partyName: text("party_name"),
    partyGstin: text("party_gstin"),

    /** Kept on the line because GSTR-1 is reported rate-wise, not account-wise. */
    hsn: text("hsn"),
    taxRatePct: numeric("tax_rate_pct", { precision: 5, scale: 2 }),
  },
  (t) => [index("voucher_lines_voucher_idx").on(t.voucherId, t.seq)],
).enableRLS();

export type VoucherLineRow = typeof voucherLinesTable.$inferSelect;
