import { and, desc, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";

import { channelCredentialsTable, db, type ChannelCredentialRow } from "@workspace/db";

import { logger } from "../../logger";
import { credentialsAvailable, hint, open, seal } from "./secret";

export { credentialsAvailable } from "./secret";

export type Channel = "EMAIL" | "WHATSAPP" | "SMS";

/**
 * The dealership's own accounts, and what may be done with them (OBJ-27).
 *
 * ## One function decrypts, and it is not exported
 *
 * `usable()` is the only path from a stored cipher to a live token, and it is
 * module-private. Everything a route or a screen can reach returns
 * `ChannelStatus`, which carries whether a channel is connected, what address
 * it sends from, and four characters of the secret — the three things a person
 * configuring this needs, and nothing a person attacking it wants.
 *
 * The same discipline as the session layer: the shape of the type is what makes
 * the leak impossible, rather than every caller remembering not to serialise a
 * field.
 */

/** Everything a screen may know about a channel. */
export interface ChannelStatus {
  channel: Channel;
  configured: boolean;
  active: boolean;
  /** The number or address customers see. Not a secret. */
  displayAddress: string | null;
  secretHint: string | null;
  /** Whether inbound is possible: a signing secret is stored. */
  canReceive: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  /** Why this channel cannot be used yet, in a sentence, or null. */
  blocker: string | null;
}

const CHANNELS: Channel[] = ["WHATSAPP", "EMAIL"];

/**
 * A credential decrypted and ready to use, or the reason it is not.
 *
 * Private. A caller outside this module cannot obtain a token, which is the
 * point — the transports live in this directory and nothing else needs one.
 */
interface Usable {
  row: ChannelCredentialRow;
  secret: string;
  config: Record<string, unknown>;
}

async function usable(ownerId: number, channel: Channel): Promise<Usable | null> {
  if (!credentialsAvailable()) return null;

  const [row] = await db
    .select()
    .from(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.ownerId, ownerId),
        eq(channelCredentialsTable.channel, channel),
      ),
    );

  if (!row || row.isActive !== "Y") return null;

  try {
    return { row, secret: open(row.secretCipher), config: row.config ?? {} };
  } catch (err) {
    // A cipher that will not open is a key that changed, not a token that is
    // wrong. Said plainly, because the two have completely different fixes and
    // "authentication failed" would send somebody to re-paste a good token.
    logger.error(
      { ownerId, channel, err: (err as Error).message },
      "Stored credential could not be decrypted — CREDENTIAL_KEY has changed since it was saved",
    );
    return null;
  }
}

export async function statusFor(ownerId: number): Promise<ChannelStatus[]> {
  const rows = await db
    .select()
    .from(channelCredentialsTable)
    .where(eq(channelCredentialsTable.ownerId, ownerId));

  const byChannel = new Map(rows.map((r) => [r.channel as Channel, r]));

  return CHANNELS.map((channel) => {
    const row = byChannel.get(channel);
    /*
     * The blocker is one sentence and it names whose problem it is.
     *
     * *No transport is configured* was the old message for every case, and it
     * reads as a gap in the product. Three of these four are the dealership's
     * to fix and one is the operator's, and somebody staring at an undelivered
     * message is entitled to know which.
     */
    const blocker = !credentialsAvailable()
      ? "This installation has no CREDENTIAL_KEY set, so it cannot hold a messaging credential at all. That is for whoever runs the server."
      : !row
        ? `No ${channel === "WHATSAPP" ? "WhatsApp Business" : "mail"} account is connected. Connect the dealership's own and nothing changes about who may send what.`
        : row.isActive !== "Y"
          ? "Connected but switched off. Nothing goes out until somebody turns it on, which is deliberate — a credential that exists is not one that has been tested."
          : null;

    return {
      channel,
      configured: Boolean(row),
      active: row?.isActive === "Y",
      displayAddress: row?.displayAddress ?? null,
      secretHint: row?.secretHint ?? null,
      canReceive: Boolean(row?.signingSecretCipher),
      lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      blocker,
    };
  });
}

export interface ConnectInput {
  ownerId: number;
  userId: number;
  channel: Channel;
  displayAddress: string;
  secret: string;
  signingSecret?: string | null;
  config?: Record<string, unknown>;
}

/**
 * Save a dealership's credential.
 *
 * Upsert on (owner, channel), because a dealership has one WhatsApp number and
 * re-pasting a rotated token is the ordinary case rather than a second account.
 * It arrives **switched off** every time, including on a re-paste: a token that
 * changed is a token nobody has tested, and the send that proves it works is
 * cheaper than the send that goes to four hundred customers from a number the
 * dealership had not finished setting up.
 */
export async function connectChannel(input: ConnectInput): Promise<ChannelStatus[]> {
  const cipher = seal(input.secret);
  const signing = input.signingSecret ? seal(input.signingSecret) : null;

  await db
    .insert(channelCredentialsTable)
    .values({
      ownerId: input.ownerId,
      channel: input.channel,
      displayAddress: input.displayAddress,
      config: input.config ?? {},
      secretCipher: cipher,
      secretHint: hint(input.secret),
      signingSecretCipher: signing,
      isActive: "N",
      createdByUserId: input.userId,
    })
    .onConflictDoUpdate({
      target: [channelCredentialsTable.ownerId, channelCredentialsTable.channel],
      set: {
        displayAddress: input.displayAddress,
        config: input.config ?? {},
        secretCipher: cipher,
        secretHint: hint(input.secret),
        // Only overwritten when a new one was supplied. Re-pasting a rotated
        // access token must not silently disable inbound.
        ...(signing ? { signingSecretCipher: signing } : {}),
        isActive: "N",
        lastError: null,
        updatedAt: new Date(),
      },
    });

  return statusFor(input.ownerId);
}

export async function setChannelActive(
  ownerId: number,
  channel: Channel,
  active: boolean,
): Promise<ChannelStatus[]> {
  await db
    .update(channelCredentialsTable)
    .set({ isActive: active ? "Y" : "N", updatedAt: new Date() })
    .where(
      and(
        eq(channelCredentialsTable.ownerId, ownerId),
        eq(channelCredentialsTable.channel, channel),
      ),
    );
  return statusFor(ownerId);
}

export async function disconnectChannel(ownerId: number, channel: Channel): Promise<ChannelStatus[]> {
  await db
    .delete(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.ownerId, ownerId),
        eq(channelCredentialsTable.channel, channel),
      ),
    );
  return statusFor(ownerId);
}

// ── Delivery ────────────────────────────────────────────────────────────────

export interface Delivery {
  ok: boolean;
  /** The provider's id for the message, so a reply can be threaded to it. */
  providerMessageId?: string;
  error?: string;
}

/** Digits only. Indian mobiles are stored ten-digit and Meta wants E.164. */
function e164(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits;
}

/**
 * WhatsApp, through Meta's Cloud API.
 *
 * ## Free-form text, and the limit is stated rather than worked around
 *
 * This sends a `text` message, which Meta permits only inside the twenty-four
 * hours after the customer last wrote. Outside that window a business must send
 * an approved **template**, and the approval is per template per account and
 * takes days.
 *
 * DDMS does not paper over that. A send outside the window fails with Meta's
 * own error, and the outbox row carries it. The alternative — silently
 * substituting a generic approved template for the message a manager wrote and
 * approved — would deliver something other than what the person put their name
 * to, which is the one thing the whole gate exists to prevent. Template sending
 * is a real piece of work and belongs with the account setup, not hidden here.
 */
async function sendWhatsApp(u: Usable, to: string, body: string): Promise<Delivery> {
  const phoneNumberId = String(u.config.phoneNumberId ?? "");
  if (!phoneNumberId) {
    return { ok: false, error: "This WhatsApp credential has no phone number id saved against it." };
  }
  const version = String(u.config.apiVersion ?? "v21.0");

  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${u.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: e164(to),
      type: "text",
      text: { preview_url: false, body },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number; error_subcode?: number };
  };

  if (!res.ok) {
    /*
     * Meta's own words, not ours.
     *
     * *Delivery failed* tells a dealership nothing they can act on.
     * *(131047) Message failed to send because more than 24 hours have passed
     * since the customer last replied* tells them exactly what happened and
     * that the fix is a template rather than a retry.
     */
    const e = payload.error;
    return {
      ok: false,
      error: e?.message
        ? `WhatsApp refused it${e.code ? ` (${e.code})` : ""}: ${e.message}`
        : `WhatsApp refused it with HTTP ${res.status}.`,
    };
  }

  return { ok: true, providerMessageId: payload.messages?.[0]?.id };
}

/**
 * Email, over the dealership's own SMTP.
 *
 * `nodemailer` is loaded lazily, exactly as Playwright is elsewhere in this
 * server: a dealership using WhatsApp only should not pay for a mail library at
 * startup, and an installation that has never configured SMTP should not fail
 * to boot because one is missing.
 */
async function sendEmail(
  u: Usable,
  to: string,
  subject: string | null,
  body: string,
): Promise<Delivery> {
  let nodemailer: typeof import("nodemailer");
  try {
    nodemailer = await import("nodemailer");
  } catch {
    return {
      ok: false,
      error:
        "This installation has no mail library available, so email cannot be sent from it. " +
        "WhatsApp is unaffected.",
    };
  }

  const transporter = nodemailer.createTransport({
    host: String(u.config.host ?? ""),
    port: Number(u.config.port ?? 587),
    secure: Boolean(u.config.secure ?? false),
    auth: { user: String(u.config.user ?? u.row.displayAddress), pass: u.secret },
  });

  const info = await transporter.sendMail({
    from: u.row.displayAddress,
    to,
    subject: subject ?? "(no subject)",
    text: body,
  });

  return { ok: true, providerMessageId: info.messageId };
}

/**
 * The one entry point the outbound gate calls.
 *
 * It receives a message that `authoriseSend()` has already permitted. Nothing
 * in here decides whether something may go — the split is deliberate and is the
 * whole of R-48: **authorisation is a decision and delivery is plumbing**, and
 * plumbing that can authorise is plumbing that will eventually authorise
 * something nobody approved.
 */
export async function deliver(input: {
  ownerId: number;
  channel: Channel;
  to: string;
  subject: string | null;
  body: string;
}): Promise<Delivery | null> {
  const u = await usable(input.ownerId, input.channel);
  if (!u) return null;

  try {
    const result =
      input.channel === "WHATSAPP"
        ? await sendWhatsApp(u, input.to, input.body)
        : input.channel === "EMAIL"
          ? await sendEmail(u, input.to, input.subject, input.body)
          : { ok: false, error: `No transport is implemented for ${input.channel}.` };

    await db
      .update(channelCredentialsTable)
      .set({
        lastUsedAt: new Date(),
        lastError: result.ok ? null : (result.error ?? null),
      })
      .where(eq(channelCredentialsTable.id, u.row.id));

    return result;
  } catch (err) {
    const error = (err as Error).message;
    await db
      .update(channelCredentialsTable)
      .set({ lastUsedAt: new Date(), lastError: error })
      .where(eq(channelCredentialsTable.id, u.row.id));
    return { ok: false, error };
  }
}

/**
 * Whether an inbound payload really came from Meta.
 *
 * ## The endpoint is public, so this is the only thing standing in front of it
 *
 * Meta calls the webhook; Meta does not hold this product's service key. So the
 * route is exempt from that gate and the signature is what replaces it —
 * without it, the URL is somewhere anybody may post a fabricated customer
 * conversation into a dealership's queue.
 *
 * `timingSafeEqual`, because a comparison that returns early on the first wrong
 * byte tells an attacker how much of a forged signature was right. And a
 * credential with **no** signing secret cannot receive at all: refusing the
 * delivery is the honest failure, where accepting it unverified would be the
 * product deciding that an unauthenticated message is good enough.
 */
export async function verifyInbound(
  ownerId: number,
  channel: Channel,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await db
    .select()
    .from(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.ownerId, ownerId),
        eq(channelCredentialsTable.channel, channel),
      ),
    );

  if (!row?.signingSecretCipher) {
    return { ok: false, reason: "No signing secret is stored for this channel, so nothing may be received on it." };
  }
  if (!signatureHeader) return { ok: false, reason: "Unsigned delivery." };

  let secret: string;
  try {
    secret = open(row.signingSecretCipher);
  } catch {
    return { ok: false, reason: "The stored signing secret could not be read." };
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "Signature did not match." };
  }
  return { ok: true };
}

/**
 * The owner whose WhatsApp number a payload is addressed to.
 *
 * The webhook is one URL for every dealership, so the payload has to say whose
 * it is before anything can be verified against a key — and the only thing in
 * it that can is the business phone number id, which is the dealership's own
 * and is stored beside their credential.
 *
 * A payload naming a number nobody has connected resolves to nothing and is
 * refused. That is not a leak: the caller learns only that some number is
 * unknown, which they already knew if they made it up.
 */
export async function ownerForPhoneNumberId(id: string): Promise<number | null> {
  const rows = await db
    .select({ ownerId: channelCredentialsTable.ownerId, config: channelCredentialsTable.config })
    .from(channelCredentialsTable)
    .where(eq(channelCredentialsTable.channel, "WHATSAPP"))
    .orderBy(desc(channelCredentialsTable.updatedAt));

  return rows.find((r) => String(r.config?.phoneNumberId ?? "") === id)?.ownerId ?? null;
}
