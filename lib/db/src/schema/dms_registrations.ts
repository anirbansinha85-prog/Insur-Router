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
 * A mirror of the dealer's registration desk — fourth instance of the pattern.
 *
 * Structurally this is `dms_deals` and `dms_job_cards` again, which is by now
 * the point rather than a coincidence: raw payload, a hash to tell moved from
 * unmoved, the columns a worklist sorts on, our own clock, and decision fields
 * the source system has no equivalent of.
 *
 * The question it answers is different from all three that came before it. A
 * deal asks *is it insured*. A job card asks *is the promise being kept*. An
 * enquiry asks *has anybody rung them yet*. A registration file asks something
 * a dealership has genuinely never been able to see in one place:
 *
 * > **Whose paperwork is stuck, on what, and for how long — and how many
 * > registration certificates are sitting in our drawer that their owners do
 * > not have?**
 *
 * The DMS considers a vehicle finished at `REGISTERED`, because that is when
 * the RTO allots a number and the sale can be reported. Two columns further
 * down, `rcReceivedDt` and `rcDeliveredDt`, record whether the customer ever
 * received the certificate — and no screen in the dealership puts those two
 * beside each other. A card in a drawer is not a state anybody's report has.
 */
export const dmsRegistrationsTable = pgTable(
  "dms_registrations",
  {
    id: serial("id").primaryKey(),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),
    dealerCode: text("dealer_code").notNull(),
    regnFileNo: text("regn_file_no").notNull(),

    // ── Mirror fields: theirs, never written back ───────────────────────────
    status: text("status").notNull(),
    /** The sale this file belongs to. Joins the registration desk to the deal. */
    dealId: text("deal_id").notNull(),
    chassisNo: text("chassis_no"),
    customerName: text("customer_name"),
    customerMobile: text("customer_mobile"),
    modelDescription: text("model_description"),
    openedDate: date("opened_date", { mode: "string" }),
    rtoCode: text("rto_code"),
    rtoOffice: text("rto_office"),
    /** Whose file it is. Null means nobody has picked it up. */
    agentEmpCode: text("agent_emp_code"),
    /**
     * Temporary registration. One month's validity, and the reason the customer
     * could ride away on the day. A lapsed one is a vehicle on the road with no
     * valid registration — the dealership's problem before it is the owner's.
     */
    tempRegNo: text("temp_reg_no"),
    tempRegExpiryDate: date("temp_reg_expiry_date", { mode: "string" }),
    /**
     * The policy the RTO will not register the vehicle without.
     *
     * Null here is the most actionable value in the table, and the only
     * blockage on this screen the dealership can clear from its own desk —
     * which is exactly what InsurRouter is for.
     */
    policyNo: text("policy_no"),
    /**
     * Road tax, and the two dates that are not the same event. Collected at
     * invoice from the customer; remitted to the state afterwards. The gap
     * between them is somebody else's money in the dealer's account, and the
     * file cannot move until it closes.
     */
    roadTaxAmount: real("road_tax_amount"),
    roadTaxCollectedDate: date("road_tax_collected_date", { mode: "string" }),
    roadTaxPaidDate: date("road_tax_paid_date", { mode: "string" }),
    submittedDate: date("submitted_date", { mode: "string" }),
    regNo: text("reg_no"),
    regDate: date("reg_date", { mode: "string" }),
    /** High-security plate. Legally required, and fitted long after the number. */
    hsrpFittedDate: date("hsrp_fitted_date", { mode: "string" }),
    /** The certificate arrived at the dealership. */
    rcReceivedDate: date("rc_received_date", { mode: "string" }),
    /** The customer has it. The only ending that counts. */
    rcDeliveredDate: date("rc_delivered_date", { mode: "string" }),
    objectionDesc: text("objection_desc"),
    /**
     * True when at least one checklist document is still outstanding. Lifted out
     * of the document lines for the same reason `hasUnissuedPart` was lifted out
     * of the part lines — "which files are waiting on a customer" is the query,
     * and unpacking JSON per row is what makes a list slow.
     */
    hasPendingDoc: text("has_pending_doc"),
    /** What is outstanding, so the row can say it without a second call. */
    pendingDocDesc: text("pending_doc_desc"),

    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    rawHash: text("raw_hash").notNull(),

    // ── Decision fields: ours ───────────────────────────────────────────────
    /**
     * When we recorded that the customer was told their certificate is here.
     *
     * The same shape as `customerInformedAt` on a job card, and for the same
     * reason: the DMS has no column for it because telling somebody is not an
     * RTO event. Load-bearing — a file with this set is waiting on the customer
     * to come in, one without it is waiting on us to pick up a phone, and only
     * the second is work.
     */
    customerNotifiedAt: timestamp("customer_notified_at", { withTimezone: true }),
    /**
     * When somebody last chased the RTO or the agent on a submitted file.
     *
     * Deliberately a *recency* test rather than a presence one, unlike every
     * other decision field so far. A file lodged three weeks ago that was chased
     * yesterday is being handled; the same file chased once a fortnight ago is
     * not. Storing only "was it ever chased" would call both of them done.
     */
    rtoChasedAt: timestamp("rto_chased_at", { withTimezone: true }),

    // ── Sync metadata ───────────────────────────────────────────────────────
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    statusSince: timestamp("status_since", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    disappearedAt: timestamp("disappeared_at", { withTimezone: true }),
  },
  (t) => [
    unique("dms_registrations_dealer_file_unique").on(t.dealerCode, t.regnFileNo),
    index("dms_registrations_showroom_status_idx").on(t.showroomId, t.status),
    /** The drawer query, and the reason this module exists. */
    index("dms_registrations_rc_idx").on(t.showroomId, t.rcReceivedDate, t.rcDeliveredDate),
  ],
).enableRLS();

export const insertDmsRegistrationSchema = createInsertSchema(dmsRegistrationsTable).omit({
  id: true,
});
export type InsertDmsRegistration = z.infer<typeof insertDmsRegistrationSchema>;
export type DmsRegistrationRow = typeof dmsRegistrationsTable.$inferSelect;
