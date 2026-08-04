import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * Who and what the five mirrors are all talking about.
 *
 * Every module so far is an island. Mrs Kavita Sharma is a job card waiting on
 * a brake shoe. Is she also an enquiry nobody rang? Does she own the vehicle
 * whose registration certificate has been in the drawer for three weeks?
 * Nothing in this system could answer that, because the dealer's system cannot
 * either — a DMS keys everything by module and by dealer code, so the same
 * person is a customer id in sales, a different customer id in the workshop,
 * and a name typed by hand in the CRM.
 *
 * These two tables are the join nobody has. `entities` is the person, the
 * vehicle or the member of staff; `entity_links` is every mirror row that
 * touches them.
 *
 * ## Owner-scoped, not showroom-scoped
 *
 * Deliberately keyed to the **owner**. A customer who buys at Saraswati and
 * services at Deccan is one person, and saying so is the entire point — an
 * outlet-scoped identity would rebuild the islands one level up.
 *
 * ## Stored rather than derived, and why that is not a contradiction
 *
 * Reconciliation is derived on read and never stored, because a stale "in sync"
 * flag is worse than none. This is stored, and the difference matters: a
 * reconciliation is a *conclusion* that goes out of date, an entity link is an
 * *index* rebuilt from the same rows it indexes.
 *
 * The two tables are rebuilt differently, and the asymmetry is deliberate.
 * **Links are replaced wholesale** — they have no identity worth keeping and no
 * external reference, so throwing them away guarantees a link cannot outlive
 * the mirror row that implied it. **Entities are upserted**, because an entity
 * id is *addressable*: it appears in a URL, somebody may have a dossier open,
 * and `firstSeenAt` is a claim about how long this dealership has known about
 * the customer. An earlier version deleted both, which reassigned every id on
 * each scheduled sync and reset `firstSeenAt` to now every fifteen minutes.
 */
export const entitiesTable = pgTable(
  "entities",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["CUSTOMER", "VEHICLE", "EMPLOYEE"] }).notNull(),
    /**
     * The normalised identifier this entity was resolved on. Normalisation is
     * in `entity-graph.ts` and is the whole of the matching logic — there is no
     * fuzzy name matching, deliberately.
     *
     *   CUSTOMER  last 10 digits of the mobile number
     *   VEHICLE   chassis number, uppercased, punctuation stripped
     *   EMPLOYEE  dealerCode:empCode — an empCode is only unique within a dealer
     */
    naturalKey: text("natural_key").notNull(),
    /** Most recently seen human-readable label. Display only, never matched on. */
    displayName: text("display_name"),
    /**
     * How much to trust that these rows are the same person.
     *
     * 1.0 for a vehicle or an employee: a chassis number identifies exactly one
     * machine and an employee code exactly one person. Lower for a customer,
     * because a mobile number is a **probable** identity and not a certain one
     * — families share a handset, a number gets reassigned, a showroom types
     * its own switchboard number into a walk-in record. Anything irreversible
     * must not be driven by this alone.
     */
    confidence: real("confidence").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("entities_owner_kind_key_unique").on(t.ownerId, t.kind, t.naturalKey),
    index("entities_owner_kind_idx").on(t.ownerId, t.kind),
    index("entities_display_idx").on(t.displayName),
  ],
).enableRLS();

/**
 * One mirror row, attached to one entity, in one role.
 *
 * The role matters and is not decoration: an employee is attached to a job card
 * as its `ADVISOR` and to an enquiry as its `ASSIGNEE`, and "what is this person
 * carrying" is a different question from "what is this person's own vehicle".
 */
export const entityLinksTable = pgTable(
  "entity_links",
  {
    id: serial("id").primaryKey(),
    entityId: integer("entity_id")
      .notNull()
      .references(() => entitiesTable.id, { onDelete: "cascade" }),
    /** Denormalised so a policy can scope without joining back to `entities`. */
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION"],
    }).notNull(),
    /** The mirror row's own key — dealId, jcNo, enqId, regnFileNo. */
    recordKey: text("record_key").notNull(),
    role: text("role", {
      enum: ["SUBJECT", "VEHICLE", "ADVISOR", "ASSIGNEE", "AGENT"],
    }).notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("entity_links_unique").on(t.entityId, t.module, t.recordKey, t.role),
    index("entity_links_entity_idx").on(t.entityId),
    index("entity_links_record_idx").on(t.module, t.recordKey),
  ],
).enableRLS();

export const insertEntitySchema = createInsertSchema(entitiesTable).omit({ id: true });
export type InsertEntity = z.infer<typeof insertEntitySchema>;
export type EntityRow = typeof entitiesTable.$inferSelect;
export type EntityLinkRow = typeof entityLinksTable.$inferSelect;
