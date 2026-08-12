import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  db,
  entitiesTable,
  entityLinksTable,
  inboundMessagesTable,
  outboundMessagesTable,
  showroomsTable,
  type InboundMessageRow,
} from "@workspace/db";

import { logger } from "../../logger";

/**
 * Replies coming back, and what a dealership is supposed to do with one
 * (OBJ-27).
 *
 * ## This is the half that is not plumbing
 *
 * Sending a message is delivery: useful, and a solved problem everywhere. A
 * reply is **a fact that exists in no other system the dealership owns.** The
 * DMS records what the dealership did to a record. It has no column for *the
 * customer wrote back on Tuesday and said the bike is still pulling left*, no
 * report that would produce one, and no way to notice that nobody read it.
 *
 * Every other table in this product mirrors, derives from, or annotates
 * something the dealer's own system already holds. `inbound_messages` does not,
 * which makes it the first thing DDMS knows that its customer could not have
 * found out another way.
 *
 * ## Nothing here reads the message
 *
 * The body is stored verbatim and no rule fires on its contents. A model
 * reading *"don't bother, I've sold it"* and marking a lead lost is exactly the
 * judgement R-49 reserves for a person, and the failure is quiet: the lead
 * disappears from a screen and nobody ever learns why.
 *
 * What a reply *does* is become a queue row saying somebody answered and nobody
 * has read it. That is a fact about the dealership rather than a claim about
 * the message, and it is the same finding as an enquiry with no owner —
 * work that has stopped happening with nothing anywhere reporting it.
 *
 * ## Matching is probable and travels with its basis
 *
 * A WhatsApp reply arrives carrying a phone number and nothing else. Threading
 * it to the most recent message DDMS sent that number is right nearly always
 * and wrong when a family shares a handset or somebody answers last month's
 * conversation (R-47). So the basis and the confidence are columns, an
 * unmatched reply is **kept and queued** rather than dropped, and no
 * irreversible thing is driven by the match alone — the strongest consequence
 * of a wrong one is a row appearing on the wrong record's history, which a
 * person can see and correct.
 */

export interface IncomingMessage {
  ownerId: number;
  channel: "WHATSAPP" | "EMAIL" | "SMS";
  providerMessageId: string;
  fromAddress: string;
  fromName: string | null;
  body: string;
  receivedAt: Date;
  raw: Record<string, unknown>;
}

/** Digits only, and the country code off an Indian mobile. */
function normaliseMobile(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

export interface RecordedReply {
  row: InboundMessageRow;
  /** False when this provider id had already arrived — Meta retries. */
  isNew: boolean;
}

/**
 * Store a reply, attribute it as well as it can honestly be attributed.
 *
 * Idempotent on `(channel, providerMessageId)`, which is not a nicety. Meta
 * retries any webhook it did not get a 200 for, including ones it timed out on
 * itself, so without the unique key one customer message becomes four queue
 * rows and the dealership stops believing the screen inside a week.
 */
export async function recordReply(input: IncomingMessage): Promise<RecordedReply | null> {
  const mobile = input.channel === "EMAIL" ? input.fromAddress.toLowerCase() : normaliseMobile(input.fromAddress);

  /*
   * The thread first, the phone book second.
   *
   * R-47's rule in a new place: an explicit reference beats a probable one. The
   * last thing DDMS actually sent this number is a reference — we know what it
   * was about, because we wrote it. Matching on the customer's mobile in the
   * mirror is the fallback, and it is the one that goes wrong on a shared
   * handset.
   */
  const [threaded] = await db
    .select({
      id: outboundMessagesTable.id,
      module: outboundMessagesTable.module,
      recordKey: outboundMessagesTable.recordKey,
      showroomId: outboundMessagesTable.showroomId,
    })
    .from(outboundMessagesTable)
    .where(
      and(
        eq(outboundMessagesTable.ownerId, input.ownerId),
        eq(outboundMessagesTable.channel, input.channel),
        eq(outboundMessagesTable.audience, "CUSTOMER"),
        // Stored ten-digit on our side; compare on digits so a number that
        // arrived as +91… still finds the message we sent it.
        sql`regexp_replace(${outboundMessagesTable.toAddress}, '\\D', '', 'g') like ${"%" + mobile}`,
        eq(outboundMessagesTable.status, "SENT"),
      ),
    )
    .orderBy(desc(outboundMessagesTable.sentAt))
    .limit(1);

  /*
   * The customer entity, matched on the number itself.
   *
   * `naturalKey` on a CUSTOMER *is* the last ten digits of their mobile — the
   * entity graph normalises it there precisely so this is an equality test and
   * not a search. Its own `confidence` records what that is worth (R-47), and
   * this branch is the fallback, reached only when no thread exists.
   */
  const [person] = threaded
    ? []
    : await db
        .select({ id: entitiesTable.id, showroomId: entityLinksTable.showroomId })
        .from(entitiesTable)
        .leftJoin(entityLinksTable, eq(entityLinksTable.entityId, entitiesTable.id))
        .where(
          and(
            eq(entitiesTable.ownerId, input.ownerId),
            eq(entitiesTable.kind, "CUSTOMER"),
            eq(entitiesTable.naturalKey, mobile),
          ),
        )
        .limit(1);

  const basis = threaded ? "OUTBOUND_THREAD" : person ? "MOBILE" : "NONE";

  const [row] = await db
    .insert(inboundMessagesTable)
    .values({
      ownerId: input.ownerId,
      showroomId: threaded?.showroomId ?? person?.showroomId ?? null,
      channel: input.channel,
      fromAddress: mobile,
      fromName: input.fromName,
      body: input.body,
      providerMessageId: input.providerMessageId,
      inReplyToId: threaded?.id ?? null,
      module: threaded?.module ?? null,
      recordKey: threaded?.recordKey ?? null,
      entityId: person?.id ?? null,
      matchBasis: basis,
      // Stated rather than implied. A thread is something we wrote and can
      // point at; a phone number is a guess that is usually right.
      matchConfidence: basis === "OUTBOUND_THREAD" ? "0.95" : basis === "MOBILE" ? "0.70" : null,
      receivedAt: input.receivedAt,
      raw: input.raw,
    })
    .onConflictDoNothing({
      target: [inboundMessagesTable.channel, inboundMessagesTable.providerMessageId],
    })
    .returning();

  if (!row) {
    const [existing] = await db
      .select()
      .from(inboundMessagesTable)
      .where(
        and(
          eq(inboundMessagesTable.channel, input.channel),
          eq(inboundMessagesTable.providerMessageId, input.providerMessageId),
        ),
      );
    return existing ? { row: existing, isNew: false } : null;
  }

  logger.info(
    { ownerId: input.ownerId, channel: input.channel, basis, module: row.module },
    "Customer reply received",
  );
  return { row, isNew: true };
}

/** Replies nobody has opened, for the queue. */
export async function unreadReplies(
  ownerId: number,
  showroomIds: number[],
): Promise<InboundMessageRow[]> {
  if (showroomIds.length === 0) return [];
  return db
    .select()
    .from(inboundMessagesTable)
    .where(
      and(
        eq(inboundMessagesTable.ownerId, ownerId),
        isNull(inboundMessagesTable.readAt),
        /*
         * An outlet-less reply is included, not excluded.
         *
         * It is the one whose record could not be worked out — a customer wrote
         * to the dealership and nothing here knows which branch they meant.
         * Filtering it out on a missing foreign key would hide precisely the
         * message most likely to be nobody's, which is the failure this queue
         * exists to correct.
         */
        sql`(${inboundMessagesTable.showroomId} is null or ${inArray(inboundMessagesTable.showroomId, showroomIds)})`,
      ),
    )
    .orderBy(desc(inboundMessagesTable.receivedAt))
    .limit(100);
}

export async function markRead(
  ownerId: number,
  id: number,
  userId: number,
): Promise<InboundMessageRow | null> {
  const [row] = await db
    .update(inboundMessagesTable)
    .set({ readAt: new Date(), readByUserId: userId })
    .where(and(eq(inboundMessagesTable.ownerId, ownerId), eq(inboundMessagesTable.id, id)))
    .returning();
  return row ?? null;
}

/** The thread on one record, oldest first, for the case card. */
export async function repliesFor(
  ownerId: number,
  module: string,
  recordKey: string,
): Promise<InboundMessageRow[]> {
  return db
    .select()
    .from(inboundMessagesTable)
    .where(
      and(
        eq(inboundMessagesTable.ownerId, ownerId),
        eq(inboundMessagesTable.module, module as never),
        eq(inboundMessagesTable.recordKey, recordKey),
      ),
    )
    .orderBy(inboundMessagesTable.receivedAt);
}

/**
 * The outlet a reply belongs to, for a webhook that knows only a number.
 *
 * Falls back to the owner's first outlet so an unattributable reply still
 * lands somewhere a person will see it, rather than being refused at the door.
 */
export async function firstShowroom(ownerId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, ownerId))
    .orderBy(showroomsTable.id)
    .limit(1);
  return row?.id ?? null;
}
