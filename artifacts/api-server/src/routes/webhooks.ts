import { Router, type IRouter, type Request, type Response } from "express";

import { withWorkerScope } from "@workspace/db";

import { ownerForPhoneNumberId, verifyInbound } from "../lib/dms/channels";
import { firstShowroom, recordReply } from "../lib/dms/channels/inbound";
import { logger } from "../lib/logger";

/**
 * Where a customer's reply comes in (OBJ-27).
 *
 * ## This router is outside every gate in the product, and that is not a hole
 *
 * Meta calls this URL. Meta does not hold DDMS's service key, has no session
 * cookie and belongs to no dealership, so none of the three layers that protect
 * every other route can apply. What replaces them is the **signature**: Meta
 * signs each delivery with the app secret that the dealership stored beside
 * their own credential, and a payload that does not verify is refused before
 * anything is written.
 *
 * The consequence worth stating: a WhatsApp credential with no signing secret
 * **cannot receive at all**. Accepting an unsigned delivery would make this URL
 * somewhere anybody could post a fabricated customer conversation into a
 * dealership's queue, and there is no version of that which is better than
 * refusing it.
 *
 * ## Whose it is has to be decided before anything can be verified
 *
 * One URL serves every dealership, so the payload must say whose it is before
 * there is a key to check it against. The only thing in it that can is the
 * business phone number id — the dealership's own, stored with their
 * credential. A payload naming a number nobody has connected resolves to
 * nothing and is dropped. That leaks nothing: the caller learns only that some
 * number is unknown, which they knew already if they invented it.
 *
 * ## It answers 200 to almost everything, on purpose
 *
 * Meta retries any delivery that did not get a 200, including one it timed out
 * on itself. A 500 for an unparseable payload therefore buys the same bad
 * payload every few minutes for a day. So a delivery that cannot be used is
 * logged and acknowledged; only a **failed signature** gets a 401, because that
 * one should not be quietly absorbed.
 *
 * Idempotency is the other half: `recordReply` is unique on the provider's own
 * message id, so a retry of something already stored writes nothing and one
 * customer message never becomes four rows on somebody's queue.
 *
 * ## It runs on the worker credential
 *
 * There is nobody signed in — this is a customer's phone talking to a server.
 * `withWorkerScope` is the same visible decision the scheduler makes, in one
 * place, rather than a missing scope nobody notices.
 */

const router: IRouter = Router();

/**
 * Meta's subscription handshake.
 *
 * Echoes `hub.challenge` when the verify token matches. The token is compared
 * against `WHATSAPP_VERIFY_TOKEN` in the environment rather than against a
 * dealership's stored secret, because this call happens *while* somebody is
 * first pointing Meta at the URL — before any credential exists to check.
 */
router.get("/webhooks/whatsapp", (req: Request, res: Response): void => {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!expected) {
    logger.warn("WhatsApp webhook verification attempted with no WHATSAPP_VERIFY_TOKEN set");
    res.status(503).send("This installation is not configured to receive WhatsApp webhooks.");
    return;
  }
  if (mode === "subscribe" && token === expected) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }
  res.status(403).send("Verification failed.");
});

interface MetaPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

router.post("/webhooks/whatsapp", async (req: Request, res: Response): Promise<void> => {
  /*
   * The bytes, not the parsed object.
   *
   * A signature is over what was actually sent. `JSON.stringify(req.body)`
   * re-serialises with different key order and spacing and will not match —
   * a mistake that produces a webhook rejecting every genuine delivery while
   * looking correct. `express.json`'s `verify` hook stashes the original on the
   * request for exactly this.
   */
  const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
  const payload = req.body as MetaPayload;

  const phoneNumberId =
    payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null;

  if (!phoneNumberId) {
    logger.info("WhatsApp webhook with no phone number id — acknowledged and ignored");
    res.status(200).send("ok");
    return;
  }

  const ownerId = await withWorkerScope(async () => ownerForPhoneNumberId(phoneNumberId));
  if (ownerId === null) {
    logger.warn({ phoneNumberId }, "WhatsApp webhook for a number no dealership has connected");
    res.status(200).send("ok");
    return;
  }

  const verified = await withWorkerScope(async () =>
    verifyInbound(ownerId, "WHATSAPP", raw, req.header("x-hub-signature-256")),
  );
  if (!verified.ok) {
    // The one case that is not absorbed. A bad signature is either an attempt
    // or a misconfiguration, and both need to be visible rather than retried
    // into silence.
    logger.error({ ownerId, reason: verified.reason }, "WhatsApp webhook signature refused");
    res.status(401).send("unverified");
    return;
  }

  const value = payload.entry?.[0]?.changes?.[0]?.value;
  const contact = value?.contacts?.[0];
  let stored = 0;

  for (const m of value?.messages ?? []) {
    /*
     * Text only, for now, and it is a stated limit rather than a gap.
     *
     * An image or a voice note from a customer is a real thing that happens and
     * storing a row saying *[image]* would be a queue entry nobody can act on
     * from the screen. Media needs somewhere to put the bytes, and there is no
     * object storage in this product yet — the same reason a held report's file
     * body lives in memory. Acknowledged and skipped is honest; a placeholder
     * row is not.
     */
    if (m.type !== "text" || !m.text?.body || !m.id || !m.from) continue;

    const result = await withWorkerScope(async () => {
      const recorded = await recordReply({
        ownerId,
        channel: "WHATSAPP",
        providerMessageId: m.id!,
        fromAddress: m.from!,
        fromName: contact?.profile?.name ?? null,
        body: m.text!.body!,
        receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
        raw: m as unknown as Record<string, unknown>,
      });
      // An unattributable reply still lands at an outlet, so somebody sees it.
      if (recorded?.isNew && recorded.row.showroomId === null) await firstShowroom(ownerId);
      return recorded;
    });
    if (result?.isNew) stored++;
  }

  if (stored > 0) logger.info({ ownerId, stored }, "Customer replies recorded");
  res.status(200).send("ok");
});

export default router;
