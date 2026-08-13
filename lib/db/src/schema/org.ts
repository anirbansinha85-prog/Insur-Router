import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";

/**
 * The shape of a dealership, as data rather than as a code path (OBJ-37, R-119).
 *
 * ```
 *   owner              the group - a commercial fact, not a legal one
 *    +- entity         one PAN - one set of books - one balance sheet
 *        +- registration    one GSTIN per state - one GSTR-1 - one GSTR-3B
 *            +- branch      a cost & profit centre, with a role
 * ```
 *
 * Four foreign keys, and every shape a two-wheeler dealership takes falls out
 * of them with no second engine:
 *
 * | Dealership                          | Entities | Registrations | Branches |
 * |-------------------------------------|----------|---------------|----------|
 * | Hub-and-spoke dealer, one city      | 1        | 1             | 5        |
 * | One company, two states             | 1        | 2             | n        |
 * | A group holding two companies       | 2        | 2             | n        |
 * | The sub-dealer doing five a month   | 1        | 1             | 1        |
 *
 * The last row matters most: **the dealership OBJ-30 exists for is this same
 * structure with every count at one.** Nothing special-cases it, and that is
 * the point of building the hierarchy before the books rather than after.
 *
 * Two ledgers for two shapes was the tempting answer and it is the one failure
 * this product refuses everywhere else - `applyAction` is one door, the overall
 * view knows nothing the module screens do not, GSTR-1 and the Tally feed share
 * a file so they cannot disagree. Two would drift within a month, and
 * reconciliation would be the first casualty: we would stop comparing the books
 * against reality and start comparing two of our own systems with no way to say
 * which was right.
 */

/**
 * The legal person. One PAN, one set of books, one balance sheet.
 *
 * This is what a chartered accountant audits and what files an income-tax
 * return. An owner may hold two of them - a group with a Pvt Ltd and an LLP -
 * and they get two clean sets of books and **no** consolidated balance sheet.
 * That is honest: a consolidated statement is a specific legal exercise rather
 * than a report, and offering one that has not eliminated inter-company
 * balances would be offering a number nobody can sign.
 */
export const legalEntitiesTable = pgTable(
  "legal_entities",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /** Short stable handle, unique within the owner. Prints on nothing. */
    code: text("code").notNull(),
    /** The registered name, exactly as it appears on the GST certificate. */
    legalName: text("legal_name").notNull(),
    /** What it trades as, where that differs. Printed on the invoice. */
    tradeName: text("trade_name"),

    /**
     * The PAN, and the reason this table is the unit of account.
     *
     * Two GSTINs sharing a PAN are one legal person and one balance sheet; two
     * PANs are two, however common the ownership. Nullable only because a
     * dealership may be onboarded before somebody types it, and a product that
     * blocks the first invoice on a field nobody has to hand gets uninstalled.
     */
    pan: text("pan"),

    entityKind: text("entity_kind", {
      enum: ["PROPRIETOR", "PARTNERSHIP", "LLP", "PRIVATE_LIMITED", "PUBLIC_LIMITED"],
    })
      .notNull()
      .default("PROPRIETOR"),

    /**
     * The first day these books cover.
     *
     * Everything before it is an opening balance rather than a transaction, and
     * a voucher dated earlier is refused. A dealership that starts with us in
     * October does not want us inventing six months of history it kept
     * elsewhere.
     */
    booksFrom: date("books_from", { mode: "string" }),

    /**
     * Aggregate annual turnover in crore, which is a **statutory band** and not
     * a vanity figure (R-118).
     *
     * Above 5 crore a B2B invoice must carry an IRN and a QR code from the
     * Invoice Registration Portal or it is not a valid tax invoice. Above 10
     * crore there is also a thirty-day reporting window. A multi-branch dealer
     * crosses 5 crore comfortably once service and parts are counted, so this
     * is the field that turns e-invoicing on, and it belongs to the entity
     * because turnover is aggregated across every registration under one PAN.
     */
    aatoCrore: numeric("aato_crore", { precision: 10, scale: 2 }),

    isActive: text("is_active", { enum: ["Y", "N"] }).notNull().default("Y"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("legal_entities_owner_code_unique").on(t.ownerId, t.code),
    index("legal_entities_owner_idx").on(t.ownerId),
  ],
).enableRLS();

/**
 * One GST registration. One GSTIN, one state, one GSTR-1, one GSTR-3B.
 *
 * The return is filed here and nowhere else, which is why every settings-shaped
 * question that changes a *return* lives on this row rather than in a key-value
 * store. Each is a typed column on the thing it is actually about, so the
 * setting list is closed by construction: adding one takes a migration, which
 * is R-52's line drawn with a schema instead of a registry.
 */
export const gstRegistrationsTable = pgTable(
  "gst_registrations",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    entityId: integer("entity_id")
      .notNull()
      .references(() => legalEntitiesTable.id, { onDelete: "cascade" }),

    /**
     * Fifteen characters, and globally unique because it is the government's
     * identifier rather than ours. Two dealerships cannot share one, and the
     * constraint is what lets a return row resolve back to an entity without
     * the caller saying who they are.
     */
    gstin: text("gstin").notNull().unique(),
    /** The state this registration is in. Place of supply compares against it. */
    state: text("state").notNull(),
    /** The two-digit code, which is the first two characters of the GSTIN. */
    stateCode: text("state_code"),

    /**
     * Regular or composition, and it changes GST entirely.
     *
     * A composition dealer charges no tax on the invoice, claims no input
     * credit, files quarterly and pays a flat percentage of turnover. Almost no
     * two-wheeler dealership is one - the input credit on stock is far too
     * valuable to give up - but a small sub-dealer might be, and an invoice
     * that showed a tax split for one would be an invalid document.
     */
    scheme: text("scheme", { enum: ["REGULAR", "COMPOSITION"] })
      .notNull()
      .default("REGULAR"),

    /**
     * Whether the invoice series is one central run or a prefix per branch.
     *
     * The series must be unique per GSTIN per financial year, and both shapes
     * satisfy that: one run of HOO/26-27/0001 across every branch, or
     * HOO/26-27/0001 and MAR/26-27/0001 running independently. Both are
     * permitted so long as they cannot collide, and which a dealership wants is
     * a matter of how it reconciles its own paperwork.
     */
    seriesScope: text("series_scope", { enum: ["REGISTRATION", "BRANCH"] })
      .notNull()
      .default("REGISTRATION"),

    /**
     * Whether the service outlets bill through DDMS (R-123).
     *
     * An authorised service centre issues tax invoices for labour and parts
     * under this same registration. If those come through this product the
     * Finance module covers service revenue - labour under a SAC, parts under
     * an HSN - and the trial balance is materially different. If they stay in
     * the dealer's own system, our books cover vehicle sales and say so.
     */
    serviceInvoicing: text("service_invoicing", { enum: ["Y", "N"] })
      .notNull()
      .default("Y"),

    isActive: text("is_active", { enum: ["Y", "N"] }).notNull().default("Y"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("gst_registrations_owner_idx").on(t.ownerId),
    index("gst_registrations_entity_idx").on(t.entityId),
  ],
).enableRLS();

export const insertLegalEntitySchema = createInsertSchema(legalEntitiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLegalEntity = z.infer<typeof insertLegalEntitySchema>;
export type LegalEntityRow = typeof legalEntitiesTable.$inferSelect;

export const insertGstRegistrationSchema = createInsertSchema(gstRegistrationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertGstRegistration = z.infer<typeof insertGstRegistrationSchema>;
export type GstRegistrationRow = typeof gstRegistrationsTable.$inferSelect;
