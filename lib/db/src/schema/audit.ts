import {
  pgTable,
  text,
  serial,
  integer,
  date,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ownersTable } from "./owners";
import { legalEntitiesTable } from "./org";

/**
 * A filed period is closed, and the refusal is at the database (OBJ-43, R-112).
 *
 * ## Why this is a table and a trigger rather than an `if`
 *
 * A GST return filed on the twentieth is a statement to the government about a
 * month. A voucher backdated into that month afterwards makes the filed return
 * wrong retrospectively, and nobody finds out until a notice arrives. An
 * application-level check would stop the screens and not the scripts, not a
 * migration, not the next thing somebody writes in a hurry at eleven at night.
 *
 * So the lock is a **trigger on `vouchers`**, applied in `rls.sql` beside the
 * policies, and it refuses the insert. That is the same posture R-45 takes on
 * tenancy: isolation enforced by the database rather than only by application
 * code being careful.
 *
 * ## Reopening is a named act with a reason
 *
 * Not a delete of the lock row and not a flag flipped quietly. The lock stays,
 * marked reopened, with who and why on it — because a period that was closed
 * and then opened again is exactly what an auditor wants to see, and a product
 * that made that invisible would be hiding the most interesting thing in the
 * file.
 */
export const periodLocksTable = pgTable(
  "period_locks",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /**
     * Locked per **entity**, because a set of books is what gets filed and
     * audited. Locking per branch would let one branch's April stay open while
     * the company's April is with the department.
     */
    entityId: integer("entity_id")
      .notNull()
      .references(() => legalEntitiesTable.id, { onDelete: "cascade" }),

    /** The first and last day covered. Inclusive both ends. */
    fromDate: date("from_date", { mode: "string" }).notNull(),
    toDate: date("to_date", { mode: "string" }).notNull(),

    reason: text("reason", {
      enum: ["GST_FILED", "PERIOD_CLOSED", "AUDITED", "OTHER"],
    })
      .notNull()
      .default("PERIOD_CLOSED"),
    note: text("note"),

    status: text("status", { enum: ["LOCKED", "REOPENED"] }).notNull().default("LOCKED"),

    lockedByUserId: integer("locked_by_user_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),

    /** All three set together, or none of them. A reopening without a reason is not one. */
    reopenedByUserId: integer("reopened_by_user_id"),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenReason: text("reopen_reason"),
  },
  (t) => [
    /*
     * One **live** lock per period, and the partial predicate is the whole of
     * it (the same shape `vouchers_source_unique` uses).
     *
     * Without `where status = 'LOCKED'` a month that was reopened for a
     * correction could never be closed again - which is exactly backwards, since
     * closing it again is the point of the correction. The history has to
     * accumulate: locked, reopened, locked again, each with its reason, because
     * that sequence is what an auditor reads.
     */
    uniqueIndex("period_locks_entity_period_unique")
      .on(t.entityId, t.fromDate, t.toDate)
      .where(sql`status = 'LOCKED'`),
    index("period_locks_active_idx").on(t.ownerId, t.status, t.toDate),
  ],
).enableRLS();

export type PeriodLockRow = typeof periodLocksTable.$inferSelect;

/**
 * The audit trail register, and it is a screen rather than an argument (R-113).
 *
 * The Companies (Accounts) Rules require books kept in software with an audit
 * trail that **cannot be disabled**. DDMS is already stronger than the rule —
 * there is no edit path anywhere in the ledger, only reversal — and *stronger*
 * is not *demonstrable*. An auditor asking "can this be switched off?" wants a
 * page, not a developer's assurance.
 *
 * So this table records the acts that would be an audit trail's subject:
 * postings, reversals, locks, reopenings, and the refusals. It is **append-only
 * by grant** — no update, no delete, for any role — which is the strongest
 * statement the database can make about it and the one an auditor can be shown.
 *
 * It deliberately does not duplicate the vouchers. A voucher is already
 * immutable and already carries who posted it; copying it here would create a
 * second version of the truth whose only job is to be compared with the first.
 * This records the acts *around* the vouchers that would otherwise leave no
 * trace.
 */
export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    entityId: integer("entity_id"),

    kind: text("kind", {
      enum: [
        "VOUCHER_POSTED",
        "VOUCHER_REVERSED",
        "PERIOD_LOCKED",
        "PERIOD_REOPENED",
        "POSTING_REFUSED",
        "DOCUMENT_CANCELLED",
        "OPENING_BALANCES",
      ],
    }).notNull(),

    /** What it was about, so the register links back rather than describing. */
    subjectKind: text("subject_kind"),
    subjectId: integer("subject_id"),
    subjectRef: text("subject_ref"),

    /** One sentence, in the words a person would use. */
    summary: text("summary").notNull(),

    /** The date the *act* happened, which may differ from the voucher's date. */
    actedAt: timestamp("acted_at", { withTimezone: true }).notNull().defaultNow(),
    actedByUserId: integer("acted_by_user_id"),
    actedByName: text("acted_by_name"),
  },
  (t) => [
    index("audit_events_owner_time_idx").on(t.ownerId, t.actedAt),
    index("audit_events_subject_idx").on(t.subjectKind, t.subjectId),
    index("audit_events_kind_idx").on(t.ownerId, t.kind, t.actedAt),
  ],
).enableRLS();

export type AuditEventRow = typeof auditEventsTable.$inferSelect;
