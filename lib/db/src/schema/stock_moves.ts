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
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * Stock that moves without being sold (OBJ-39, R-117).
 *
 * A hub-and-spoke dealership moves machines between its own branches every
 * week: the stockyard allocates to a satellite in the morning, a satellite
 * sends one back that a customer changed his mind about, a service outlet
 * borrows a demo. **None of it is a sale**, and until this table there was
 * nowhere to record any of it — so a bike that left the hub and never arrived
 * anywhere was invisible.
 *
 * ## The tax question, decided by structure
 *
 * Same GST registration is **not a supply**: one legal person moving its own
 * stock, so a delivery challan under Rule 55 with a stock transfer note, no tax
 * invoice, no GST, and **no accounting entry at all** — the chassis simply
 * changes branch. A different registration *is* a taxable supply, even between
 * two branches of one company, because GST treats distinct registrations as
 * distinct persons.
 *
 * `transferIsSupply` in `lib/dms/org.ts` decides it from the two placements and
 * nothing asks a person, because the answer is expensive in both directions: tax
 * on an internal move inflates output tax and the return, and no tax on a
 * cross-registration move is tax short-paid.
 *
 * ## An e-way bill is a separate obligation
 *
 * It is about **movement**, not about supply, so a delivery challan does not
 * exempt one. A consignment worth more than fifty thousand rupees needs a bill
 * whether or not tax is charged, and a motorcycle is over that on its own. Part
 * B — the vehicle registration of the truck — is generally not required under
 * fifty kilometres within a state. That last sentence is the one paragraph here
 * a dealership's CA should confirm against current state notifications rather
 * than take from us, and the product says so on the screen rather than in a
 * comment.
 */
export const stockMovesTable = pgTable(
  "stock_moves",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),

    fromShowroomId: integer("from_showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "restrict" }),
    toShowroomId: integer("to_showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "restrict" }),

    /**
     * Our own number, and it is a real document series.
     *
     * A delivery challan is a statutory document under Rule 55 and carries a
     * consecutive serial number. A dealership stopped at a checkpoint with an
     * unnumbered challan is a dealership explaining itself.
     */
    challanNo: text("challan_no").notNull(),
    challanDate: date("challan_date", { mode: "string" }).notNull(),

    /**
     * Whether this movement is a supply, **derived and then recorded**.
     *
     * Stored rather than computed on read for the same reason a voucher is: it
     * is a statement about a moment. A branch reassigned to another registration
     * next year must not silently restate what last year's challan was.
     */
    isSupply: text("is_supply", { enum: ["Y", "N"] }).notNull(),
    /** The sentence shown to whoever raised it, kept so a reprint agrees. */
    supplyReason: text("supply_reason"),

    /** The consignment's value, which is what the e-way bill threshold reads. */
    consignmentValue: numeric("consignment_value", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),

    /**
     * The e-way bill, which is about movement and not about supply.
     *
     * `REQUIRED` until somebody records a number, so an unfilled one is loud
     * rather than absent. `NOT_REQUIRED` is a deliberate act with a reason,
     * because the exemptions are real and a product that pretended otherwise
     * would have a dealership generating bills it does not need.
     */
    ewayStatus: text("eway_status", {
      enum: ["REQUIRED", "RAISED", "NOT_REQUIRED"],
    })
      .notNull()
      .default("REQUIRED"),
    ewayBillNo: text("eway_bill_no"),
    ewayValidUntil: date("eway_valid_until", { mode: "string" }),
    ewayNote: text("eway_note"),

    /**
     * Where the consignment has got to.
     *
     * `IN_TRANSIT` is the state that matters and the reason this is not a single
     * timestamp: a bike that left the hub and has not arrived is the first
     * reconciliation's whole subject, and it can only be found if "left" and
     * "arrived" are two separate facts.
     */
    status: text("status", {
      enum: ["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELLED"],
    })
      .notNull()
      .default("DRAFT"),

    despatchedAt: timestamp("despatched_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    /** Who confirmed it arrived. A receipt nobody signed is not a receipt. */
    receivedByUserId: integer("received_by_user_id"),

    /** Set when this movement was a supply and therefore posted. */
    voucherId: integer("voucher_id"),

    narration: text("narration"),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stock_moves_owner_challan_unique").on(t.ownerId, t.challanNo),
    index("stock_moves_from_idx").on(t.fromShowroomId, t.status),
    index("stock_moves_to_idx").on(t.toShowroomId, t.status),
    index("stock_moves_open_idx").on(t.ownerId, t.status, t.challanDate),
  ],
).enableRLS();

export type StockMoveRow = typeof stockMovesTable.$inferSelect;

/**
 * One thing on one challan — a machine, or a quantity of a part (OBJ-46).
 *
 * ## Why this table needed widening at all
 *
 * The first version of it assumed a challan carries a **chassis**, because the
 * movement OBJ-39 was written for is the hub allocating a bike to a satellite.
 * `chassisNo` was `notNull` and the whole design keyed off it: one identity,
 * one register, one life.
 *
 * A spare part is not that shape. A brake shoe has no identity — it has a
 * **part number and a quantity** — and the movement a hub-and-spoke dealership
 * actually makes most often is the daily van run taking six of them out to a
 * workshop that keeps only fast-moving lines on its own shelf. Until this
 * column existed, `PART_REQUEST_TRANSFER` could ask a branch to send a part and
 * there was **nowhere to record that it went**: the request was a decision
 * field with no document behind it, so the part left one shelf and arrived on
 * no record at all.
 *
 * ## The two shapes, and what each may not do
 *
 * ```
 *   VEHICLE   chassis_no, one unit, qty is always 1, gets a chassis event
 *   PART      part_no + qty, no chassis, no event — a part has no life to record
 * ```
 *
 * `chassisNo` is therefore nullable and `partNo` is nullable, and **exactly one
 * of them is set** per line. That could have been two tables; it is one, because
 * a challan is one document with one number and one consignment value, and the
 * e-way threshold reads the consignment rather than the kind of thing on it. A
 * van carrying two bikes and a box of parts is one movement.
 */
export const stockMoveLinesTable = pgTable(
  "stock_move_lines",
  {
    id: serial("id").primaryKey(),
    stockMoveId: integer("stock_move_id")
      .notNull()
      .references(() => stockMovesTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),

    /**
     * Which shape this line is, **stored rather than inferred** from which of
     * the two identifiers is filled.
     *
     * Inferring it would work today and would be the thing that breaks the
     * first time a part arrives with no part number keyed, or a chassis is
     * blank on a line somebody is still typing: the row would silently become
     * the other kind and be despatched down the wrong path. A default of
     * `VEHICLE` is what makes the existing rows correct without a backfill.
     */
    kind: text("kind", { enum: ["VEHICLE", "PART"] })
      .notNull()
      .default("VEHICLE"),

    /** Set on a `VEHICLE` line and null on a `PART` line. */
    chassisNo: text("chassis_no"),
    engineNo: text("engine_no"),
    /** Set on a `PART` line and null on a `VEHICLE` line. */
    partNo: text("part_no"),
    /**
     * How many. Always 1 on a machine — a chassis is one frame — and the whole
     * point of a part line.
     */
    qty: integer("qty").notNull().default(1),

    modelDescription: text("model_description").notNull(),
    hsn: text("hsn"),

    /**
     * What this line is worth on this movement, **for the whole quantity**.
     *
     * On an internal transfer that is its **cost**, not its selling price: no
     * profit arises from moving a bike between two of your own branches, and
     * valuing a challan at retail would inflate the consignment value, the
     * e-way threshold and — if the branches are on different registrations —
     * the tax charged on a supply to yourself.
     *
     * The line total rather than a unit rate, because the consignment value is
     * what every rule downstream actually reads, and a unit rate would be
     * multiplied out in three places that could each round differently.
     */
    value: numeric("value", { precision: 14, scale: 2 }).notNull().default("0"),
    gstRatePct: numeric("gst_rate_pct", { precision: 5, scale: 2 }),
  },
  (t) => [
    index("stock_move_lines_move_idx").on(t.stockMoveId, t.seq),
    /*
     * One machine may only be on one *open* challan at a time - a chassis
     * despatched twice without arriving is either a keying error or a bike that
     * has genuinely gone missing, and both deserve a refusal rather than a
     * second document.
     *
     * **That rule is enforced in `createStockMove`, not here, and the reason is
     * a real limit rather than a preference.** Expressing it as a constraint
     * needs the parent's status, and Postgres will not take a subquery in an
     * index predicate. Denormalising the status onto the line would buy the
     * index and pay for it in drift, which is the worse trade: a stale copy of
     * a status is how a closed challan starts blocking new ones.
     *
     * So this index is the one thing that *can* be stated absolutely - a chassis
     * appears once per challan - and the open-challan rule is a checked refusal
     * with a sentence attached.
     *
     * **Partial since OBJ-46.** A part line carries no chassis, and Postgres
     * treats nulls as distinct in a unique index, so leaving it total would
     * have worked - and would have been a constraint whose predicate did not
     * say what it meant. Stating `where chassis_no is not null` is the same
     * behaviour written down.
     */
    uniqueIndex("stock_move_lines_move_chassis_unique")
      .on(t.stockMoveId, t.chassisNo)
      .where(sql`chassis_no is not null`),
    /*
     * And the same rule for parts: one part number appears once on a challan,
     * with a quantity, rather than on six lines of one each. Six lines would
     * not be wrong - they would add up - but they make the shelf arithmetic on
     * despatch six updates instead of one, and a part somebody meant to correct
     * gets corrected on one of them.
     */
    uniqueIndex("stock_move_lines_move_part_unique")
      .on(t.stockMoveId, t.partNo)
      .where(sql`part_no is not null`),
    /*
     * Exactly one of the two identifiers, matching the kind. A line with both
     * or with neither is not a thing that can travel, and this is cheap enough
     * to state at the database rather than trusting six call sites.
     */
    check(
      "stock_move_lines_kind_shape",
      sql`(kind = 'VEHICLE' and chassis_no is not null and part_no is null and qty = 1)
          or (kind = 'PART' and part_no is not null and chassis_no is null and qty > 0)`,
    ),
  ],
).enableRLS();

export type StockMoveLineRow = typeof stockMoveLinesTable.$inferSelect;

/**
 * Every event in the life of one chassis, in order (OBJ-39).
 *
 * The register a dealership is actually asked for. An auditor tracing a bike
 * wants received, transferred, transferred back, sold — one page, one machine,
 * in date order — and an insurer or an RTO query wants the same thing.
 *
 * **This is written, not derived**, which is the opposite of almost everything
 * else in this product. A register assembled at read time from four tables
 * would answer differently next March once one of those tables had been
 * corrected, and the whole point of a register is that it says the same thing
 * every time it is opened. It is also what makes the second reconciliation
 * possible: the book position, the register and the DMS mirror are three
 * sources that must agree, and the odd one out names itself.
 */
export const chassisEventsTable = pgTable(
  "chassis_events",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    chassisNo: text("chassis_no").notNull(),

    /** Where the machine was, or went to, when this happened. */
    showroomId: integer("showroom_id").references(() => showroomsTable.id, {
      onDelete: "set null",
    }),

    kind: text("kind", {
      enum: [
        "PURCHASED",
        "DESPATCHED",
        "RECEIVED",
        "SOLD",
        "SALE_REVERSED",
        "WRITTEN_OFF",
      ],
    }).notNull(),

    eventDate: date("event_date", { mode: "string" }).notNull(),

    /** The document this event came off, so the register links back. */
    sourceKind: text("source_kind", {
      enum: ["PURCHASE_INVOICE", "STOCK_MOVE", "SALE_DOCUMENT", "MANUAL"],
    }).notNull(),
    sourceId: integer("source_id"),
    sourceRef: text("source_ref"),

    value: numeric("value", { precision: 14, scale: 2 }),
    narration: text("narration"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chassis_events_chassis_idx").on(t.ownerId, t.chassisNo, t.eventDate),
    index("chassis_events_showroom_idx").on(t.showroomId, t.eventDate),
    /*
     * One event per document per chassis. A purchase re-posted after a reversal
     * should not leave two PURCHASED rows on a register whose whole value is
     * that it reads as a history rather than as a pile.
     */
    uniqueIndex("chassis_events_source_unique")
      .on(t.chassisNo, t.sourceKind, t.sourceId, t.kind)
      .where(sql`source_id is not null`),
  ],
).enableRLS();

export type ChassisEventRow = typeof chassisEventsTable.$inferSelect;
