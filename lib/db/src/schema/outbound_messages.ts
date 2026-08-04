import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";
import { usersTable } from "./users";

/**
 * Everything DDMS wants to send, and whether it was allowed to.
 *
 * This is the first surface where the product stops reading a dealership's data
 * and starts speaking on its behalf. Every screen before this one wrote a
 * decision field: a mark that changes what an owner sees, inside their own
 * console, undoable by whoever made it. A message to a customer is none of
 * those things — it is read by somebody outside the building, it cannot be
 * un-received, and it carries the dealership's name.
 *
 * So the row records not just the message but **the basis on which it went**:
 *
 * - `authorisedBasis: "RULE"` — a rule in `lib/dms/outbound.ts` permitted it.
 *   Today exactly one rule does, and it covers internal email only (R-50).
 * - `authorisedBasis: "PERSON"` — somebody signed in approved it, and
 *   `approvedByUserId` says who.
 * - null — it has not been authorised, and `sentAt` must therefore be null.
 *   That pairing is the whole of R-48, and `sendMessage()` is the only code
 *   permitted to break either of them.
 *
 * ## Why `facts` is stored beside the body
 *
 * The body is prose and may have been phrased by a model. `facts` is the set of
 * values the draft was allowed to contain — the registration number, the amount,
 * the date — pulled from the mirror by a rule. The composer checks the finished
 * body against it and rejects any number the facts do not support (R-49: the
 * model phrases, the rule authorises). Keeping the pair means a message somebody
 * later disputes can be checked against what was actually known when it was
 * written, rather than against what the mirror says today.
 *
 * ## The partial unique index is load-bearing
 *
 * One *open* message per (record, audience, channel). Two approved drafts for
 * one job card means the customer gets told their vehicle is ready twice, which
 * on a screen whose entire purpose is "nobody told them" is a particularly bad
 * failure. Partial rather than total, because the history has to accumulate:
 * once a message is sent, cancelled or failed it stops blocking the next one.
 */
export const outboundMessagesTable = pgTable(
  "outbound_messages",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    showroomId: integer("showroom_id")
      .notNull()
      .references(() => showroomsTable.id, { onDelete: "cascade" }),

    /** Which worklist row this is about. Same vocabulary as `decision_log`. */
    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART"],
    }).notNull(),
    recordKey: text("record_key").notNull(),

    /**
     * The axis R-50 turns on, and the reason it is a column rather than a
     * derived property of the channel. Emailing a member of staff their own
     * workload is low risk; messaging a dealership's customer is the first
     * thing this product does that leaves the building. A rule may permit the
     * first. Nothing permits the second except a person.
     */
    audience: text("audience", { enum: ["INTERNAL", "CUSTOMER"] }).notNull(),
    channel: text("channel", { enum: ["EMAIL", "WHATSAPP", "SMS"] }).notNull(),

    toName: text("to_name"),
    /** An email address or a ten-digit mobile, depending on the channel. */
    toAddress: text("to_address"),
    /** Set when the recipient is a member of staff, so the gate can re-check they still are. */
    toEmpCode: text("to_emp_code"),

    /** Null on WhatsApp and SMS, which have no subject line. */
    subject: text("subject"),
    body: text("body").notNull(),

    /** Which template in `lib/dms/composer.ts` produced it. */
    template: text("template").notNull(),
    /**
     * Who wrote the words. `RULE` is a template; `AGENT` means a model rephrased
     * it *and* the rephrasing passed the fact check. A model whose output failed
     * that check never reaches this table — the rule draft is used instead and
     * this stays `RULE`.
     */
    draftedBy: text("drafted_by", { enum: ["RULE", "AGENT"] })
      .notNull()
      .default("RULE"),
    /** The values the body is permitted to assert. See the note above. */
    facts: jsonb("facts").$type<Record<string, unknown>>(),

    status: text("status", {
      enum: ["DRAFT", "APPROVED", "SENT", "HELD_NO_TRANSPORT", "FAILED", "CANCELLED"],
    })
      .notNull()
      .default("DRAFT"),

    /** How it came to be allowed. Null means it is not. */
    authorisedBasis: text("authorised_basis", { enum: ["RULE", "PERSON"] }),
    /** The rule id, when the basis is a rule. Named so an audit can ask "which one". */
    authorisedRule: text("authorised_rule"),
    approvedByUserId: integer("approved_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    /**
     * When it actually went. **Only `sendMessage()` writes this**, and only
     * after `authoriseSend()` returned a basis. A row with `sentAt` and no
     * `authorisedBasis` is the state this whole objective exists to make
     * unreachable.
     */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Why it did not go — a refusal, a missing transport, or a provider error. */
    failureReason: text("failure_reason"),

    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbound_messages_owner_status_idx").on(t.ownerId, t.status, t.createdAt),
    index("outbound_messages_record_idx").on(t.module, t.recordKey),
    uniqueIndex("outbound_messages_open_unique")
      .on(t.module, t.recordKey, t.audience, t.channel)
      .where(sql`status in ('DRAFT', 'APPROVED')`),
  ],
).enableRLS();

export const insertOutboundMessageSchema = createInsertSchema(outboundMessagesTable).omit({
  id: true,
});
export type InsertOutboundMessage = z.infer<typeof insertOutboundMessageSchema>;
export type OutboundMessageRow = typeof outboundMessagesTable.$inferSelect;
