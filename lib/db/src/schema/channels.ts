import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * The dealership's own account on somebody else's network (OBJ-27, R-106).
 *
 * ## Why this is a table and not an environment variable
 *
 * An environment variable is one account for every dealership using the
 * product. That is the wrong shape three times over: the WhatsApp number a
 * customer sees has to be **the dealership's**, because a service reminder from
 * an unknown number is a message nobody answers; the sending reputation and the
 * template approvals belong to whoever owns the number; and the bill is theirs.
 *
 * R-106 states it as a rule — *every outside credential is the dealership's
 * own* — and a rule that is only true in the documentation is not true. So the
 * credential is per owner, and DDMS holds none of its own.
 *
 * ## The secret is encrypted, and nothing reads it back out over HTTP
 *
 * `secretCipher` is AES-256-GCM under a key from `CREDENTIAL_KEY`, which lives
 * in the environment and not in this database. Two separate compromises are
 * needed rather than one. The plaintext is decrypted in exactly one function on
 * the sending path and is never a field on any response — the settings screen
 * gets `configured: true` and a masked hint, because *is it connected* is the
 * only question a screen has and *what is the token* is not.
 *
 * The row policy still scopes it to the owner, because encryption answers a
 * different question from isolation and neither substitutes for the other.
 *
 * ## Not a general-purpose secret store
 *
 * One row per (owner, channel). No arbitrary keys, no per-showroom overrides
 * until a dealership needs one, and no other subsystem may put anything here.
 * The same argument as the closed policy registry: a table anybody may write
 * anything into becomes a configuration layer nobody can predict, and DDMS's
 * customer has no administrator to untangle one.
 */
export const channelCredentialsTable = pgTable(
  "channel_credentials",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),

    channel: text("channel", { enum: ["EMAIL", "WHATSAPP", "SMS"] }).notNull(),

    /**
     * What the recipient sees, and what a person configuring this recognises.
     *
     * The WhatsApp Business phone number, or the from-address on the mail
     * account. Stored in the clear on purpose: it is not a secret, it appears
     * on every message sent, and a settings screen that cannot show which
     * number is connected is a settings screen nobody can check.
     */
    displayAddress: text("display_address").notNull(),

    /**
     * Everything the transport needs that is not the secret.
     *
     * WhatsApp: `{ phoneNumberId, wabaId?, apiVersion? }`. Email:
     * `{ host, port, secure, user }`. Kept as one column rather than a dozen
     * nullable ones because the shape differs per channel and nothing queries
     * inside it.
     */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),

    /** AES-256-GCM, base64, `iv:tag:ciphertext`. Never leaves the server. */
    secretCipher: text("secret_cipher").notNull(),
    /**
     * The last four characters of the plaintext, for a settings screen.
     *
     * Enough for somebody to tell which of two tokens they pasted, and not
     * enough to be a credential. Written at the same moment as the cipher, so
     * the two cannot describe different secrets.
     */
    secretHint: text("secret_hint").notNull(),

    /**
     * Meta signs every inbound webhook with this. Encrypted like the token.
     *
     * Null on channels with no inbound half. A WhatsApp credential with no app
     * secret can send and **may not receive** — an unsigned webhook is an open
     * endpoint anybody may post a customer conversation into, and the honest
     * failure is to refuse the delivery rather than to trust it.
     */
    signingSecretCipher: text("signing_secret_cipher"),

    /**
     * Off by default, and switched on deliberately after a test send.
     *
     * A credential that exists is not a credential that works, and the moment
     * it starts working is the moment this product begins messaging a
     * dealership's customers. That transition is a person's decision.
     */
    isActive: text("is_active", { enum: ["Y", "N"] })
      .notNull()
      .default("N"),

    /** The last time anything actually went out on it, for the settings screen. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Why the last attempt failed, cleared on the next success. */
    lastError: text("last_error"),

    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("channel_credentials_owner_channel_unique").on(t.ownerId, t.channel)],
).enableRLS();

export type ChannelCredentialRow = typeof channelCredentialsTable.$inferSelect;

/**
 * What a customer said back (OBJ-27).
 *
 * ## The half that is not plumbing
 *
 * Sending is delivery. **A reply is a fact that exists nowhere else.** The
 * DMS records what the dealership did to a record; it has no column for *the
 * customer answered on Tuesday and said the bike is still pulling to the left*,
 * and there is no report anybody can run that would produce it. Every other
 * table in this product mirrors, derives from or annotates something the
 * dealer's own system already holds. This one does not.
 *
 * ## It is append-only and it is not interpreted
 *
 * The body is stored exactly as it arrived. Nothing classifies it, nothing
 * summarises it into a decision field, and no rule fires on its contents —
 * a model reading *"don't bother, I've sold it"* and marking a lead lost is
 * precisely the judgement R-49 reserves for a person. What a reply does is put
 * a row on the queue saying somebody has answered and nobody has read it, which
 * is a fact about the dealership rather than a claim about the message.
 *
 * ## Matching is probable and says so
 *
 * A reply arrives with a phone number and nothing else. It is attributed to the
 * record of the most recent message DDMS sent to that number, which is right
 * almost always and wrong when a family shares a handset or a customer replies
 * to last month's thread (R-47). `matchConfidence` and `matchBasis` travel with
 * the row, and an unmatched reply is kept and queued rather than dropped —
 * a customer who wrote to the dealership is a fact whether or not we can say
 * which record they meant.
 */
export const inboundMessagesTable = pgTable(
  "inbound_messages",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    /**
     * Null when the reply could not be attributed to an outlet.
     *
     * Kept nullable, unlike `outbound_messages`, because the alternative is
     * discarding a customer's message for want of a foreign key. An outlet-less
     * row is visible to the group and to nobody narrower, which is the honest
     * answer to *whose is this*.
     */
    showroomId: integer("showroom_id").references(() => showroomsTable.id, {
      onDelete: "cascade",
    }),

    channel: text("channel", { enum: ["EMAIL", "WHATSAPP", "SMS"] }).notNull(),

    /** The sender, normalised: digits only for a phone, lowercased for email. */
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),

    /** Exactly what arrived. Never edited, never summarised. */
    body: text("body").notNull(),

    /**
     * The provider's own id for this message, and the whole of the idempotency.
     *
     * Meta retries a webhook it did not get a 200 for, and it retries on a
     * timeout it caused. Without a unique key on this, one customer reply
     * becomes four queue rows and the dealership stops trusting the screen.
     */
    providerMessageId: text("provider_message_id").notNull(),

    /** The message this appears to answer, where one can be found. */
    inReplyToId: integer("in_reply_to_id"),
    module: text("module", {
      enum: ["DEAL", "JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"],
    }),
    recordKey: text("record_key"),
    /** The resolved person, where the number is known. Probable, per R-47. */
    entityId: integer("entity_id"),

    matchBasis: text("match_basis", {
      enum: ["OUTBOUND_THREAD", "MOBILE", "NONE"],
    })
      .notNull()
      .default("NONE"),
    matchConfidence: text("match_confidence"),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Who read it, and it is a decision field like any other.
     *
     * Null means nobody in the dealership has opened a message a customer sent
     * them, which is the same class of finding as an enquiry nobody answered —
     * and it is the reason this table produces a queue row at all.
     */
    readAt: timestamp("read_at", { withTimezone: true }),
    readByUserId: integer("read_by_user_id"),

    /** The provider's payload, kept whole. Nothing derives from it. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [
    unique("inbound_messages_provider_id_unique").on(t.channel, t.providerMessageId),
    index("inbound_messages_owner_unread_idx").on(t.ownerId, t.readAt),
    index("inbound_messages_record_idx").on(t.module, t.recordKey),
  ],
).enableRLS();

export type InboundMessageRow = typeof inboundMessagesTable.$inferSelect;
