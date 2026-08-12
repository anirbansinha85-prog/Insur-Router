/**
 * OBJ-27's done-when, stated so it can fail.
 *
 * > *A dealership's credential is theirs, is unreadable at rest, and no route
 * > can return it. A reply that arrives is stored once however many times it is
 * > delivered, is attributed with its basis, and reaches the queue unread. An
 * > unsigned delivery is refused.*
 *
 * Four claims. The fourth is the one that matters most and is the easiest to
 * lose: the webhook is the only endpoint in this product outside the service
 * key, the session and the role, and the signature is the whole of what stands
 * in its place. A regression there does not break anything visible — it just
 * quietly opens a URL anybody may post a fabricated customer conversation into.
 *
 * ## What it refuses to fake
 *
 * Nothing here calls Meta. The claims are about *this* product's behaviour —
 * what it stores, what it refuses, and what a reply becomes — and a test that
 * needed a live WhatsApp Business account would be a test nobody could run.
 * The delivery path is exercised as far as the credential lookup, which is the
 * last thing under our control; past that point it is somebody else's HTTP.
 *
 * Most of it runs on the **worker credential**, because the webhook does:
 * there is nobody signed in when a customer's phone reaches the server.
 * Connecting an account does not, and section 8 says why.
 *
 * `pnpm run verify:channels`.
 */

import { and, eq, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";

import {
  channelCredentialsTable,
  db,
  inboundMessagesTable,
  outboundMessagesTable,
  ownerDb,
  withWorkerScope,
} from "@workspace/db";

import {
  connectChannel,
  credentialsAvailable,
  deliver,
  ownerForPhoneNumberId,
  setChannelActive,
  statusFor,
  verifyInbound,
} from "../lib/dms/channels";
import { markRead, recordReply, unreadReplies } from "../lib/dms/channels/inbound";
import { buildQueue } from "../lib/dms/queue";

const OWNER = 1;
const OUTLETS = [1, 2];
const MARKER = "verify:channels";
const PHONE_NUMBER_ID = "verify-channels-000";
const TOKEN = "EAAG-a-token-that-is-not-real-9Q4z";
const APP_SECRET = "verify-channels-app-secret";
const FROM = "919812340000";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

/**
 * Everything this run writes, findable again after a crash.
 *
 * The lesson from `verify:autonomy`, applied before it could bite: a run that
 * throws halfway leaves rows behind, and the next run counts them. The marker
 * is in the data — the phone number id on the credential and the provider
 * message id prefix on every reply — so reset finds its own leftovers whatever
 * happened last time.
 *
 * On the CLI credential, which is the only one that may delete either.
 */
async function reset(): Promise<void> {
  await ownerDb
    .delete(inboundMessagesTable)
    .where(
      and(
        eq(inboundMessagesTable.ownerId, OWNER),
        sql`${inboundMessagesTable.providerMessageId} like ${MARKER + "%"}`,
      ),
    );
  await ownerDb
    .delete(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.ownerId, OWNER),
        sql`${channelCredentialsTable.config} ->> 'phoneNumberId' = ${PHONE_NUMBER_ID}`,
      ),
    );
  await ownerDb
    .delete(outboundMessagesTable)
    .where(
      and(
        eq(outboundMessagesTable.ownerId, OWNER),
        sql`${outboundMessagesTable.providerMessageId} like ${MARKER + "%"}`,
      ),
    );
}

console.log("\nOBJ-27 — messages out, replies in");

if (!credentialsAvailable()) {
  console.log(
    "\n  CREDENTIAL_KEY is not set, so this installation cannot hold a dealership's\n" +
      "  credential at all. That is the designed refusal rather than a fallback to\n" +
      "  storing a token in the clear — but it means these claims cannot be tested.\n" +
      "  Set one and run again:\n" +
      `    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\n`,
  );
  process.exit(1);
}

await reset();

// ═════════════════════════════════════════════════════════════════════════
section("1. A credential is the dealership's, and it arrives switched off");

/*
 * Connecting runs **outside** the worker scope, and the first draft of this
 * file did not.
 *
 * It threw `permission denied for table channel_credentials`, which is the
 * design working: `ddms_worker` holds select and update and no insert, because
 * an unattended process that could write a messaging credential could point a
 * dealership's outbound at a number nobody chose. The verifier was wrong, not
 * the grant — connecting an account is a person's act, so it happens here on
 * the CLI credential the way a route would do it on the request credential.
 *
 * The accident became section 8, which now asserts the refusal on purpose.
 * Same shape as `verify:autonomy` and `ingest_mappings` before it, and the
 * third time this pattern has caught something it is worth naming: **a
 * verifier that reaches for a wider credential to make a check pass is
 * usually reporting a real boundary.**
 */
const connected = await connectChannel({
  ownerId: OWNER,
  userId: 1,
  channel: "WHATSAPP",
  displayAddress: FROM,
  secret: TOKEN,
  signingSecret: APP_SECRET,
  config: { phoneNumberId: PHONE_NUMBER_ID },
});

const wa = () => connected.find((c) => c.channel === "WHATSAPP")!;

check("it saved", wa().configured, `sends from ${wa().displayAddress}`);
check(
  "and it is off, because a token nobody has tested is not a token that works",
  !wa().active,
  wa().blocker ?? "",
);
check(
  "the blocker names whose problem it is",
  (wa().blocker ?? "").includes("switched off"),
  wa().blocker ?? "(none)",
);

// ═════════════════════════════════════════════════════════════════════════
section("2. Nothing readable can return the secret");

/*
 * Two claims, and the second is the structural one.
 *
 * The first is that `statusFor` does not carry a token. The second is that no
 * *shape* returned by this module does — the decrypting function is
 * module-private, so a future handler cannot leak one by being careless. That
 * is checked by serialising the whole response and looking for the plaintext.
 */
const serialised = JSON.stringify(await statusFor(OWNER));
check(
  "the token is nowhere in what a screen receives",
  !serialised.includes(TOKEN),
  `${serialised.length} characters checked`,
);
check(
  "nor is the app secret",
  !serialised.includes(APP_SECRET),
  "signing secrets never leave the server either",
);
check(
  "and four masked characters come back instead",
  wa().secretHint === `••••${TOKEN.slice(-4)}`,
  wa().secretHint ?? "(none)",
);

const [stored] = await withWorkerScope(async () =>
  db
    .select({ cipher: channelCredentialsTable.secretCipher })
    .from(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.ownerId, OWNER),
        eq(channelCredentialsTable.channel, "WHATSAPP"),
      ),
    ),
);
// Read on the worker credential deliberately: the scheduler has to be able to
// see a credential to send on it, and that grant is what section 8 bounds.
check(
  "the row itself holds no plaintext — a backup or a pg_dump gets ciphertext",
  Boolean(stored) && !stored!.cipher.includes(TOKEN) && stored!.cipher.split(":").length === 3,
  `${stored?.cipher.slice(0, 24)}…`,
);

// ═════════════════════════════════════════════════════════════════════════
section("3. A switched-off channel carries nothing");

const held = await withWorkerScope(async () =>
  deliver({ ownerId: OWNER, channel: "WHATSAPP", to: FROM, subject: null, body: "test" }),
);
check(
  "delivery on an inactive credential resolves to nothing, so the message is held",
  held === null,
  "the gate said yes and no customer received anything — which is what HELD_NO_TRANSPORT means",
);

const other = await withWorkerScope(async () =>
  deliver({ ownerId: 2, channel: "WHATSAPP", to: FROM, subject: null, body: "test" }),
);
check(
  "and another dealership's message does not go out on this dealership's number",
  other === null,
  "credentials are resolved per owner, which is R-106 in one lookup",
);

// ═════════════════════════════════════════════════════════════════════════
section("4. An unsigned or wrongly signed delivery is refused");

const payload = JSON.stringify({ hello: "world" });
const goodSig = `sha256=${createHmac("sha256", APP_SECRET).update(payload, "utf8").digest("hex")}`;

const unsigned = await withWorkerScope(async () =>
  verifyInbound(OWNER, "WHATSAPP", payload, undefined),
);
check("no signature at all is refused", !unsigned.ok, "reason" in unsigned ? unsigned.reason : "");

const forged = await withWorkerScope(async () =>
  verifyInbound(OWNER, "WHATSAPP", payload, `sha256=${"0".repeat(64)}`),
);
check("a forged signature is refused", !forged.ok, "reason" in forged ? forged.reason : "");

const tampered = await withWorkerScope(async () =>
  verifyInbound(OWNER, "WHATSAPP", `${payload} `, goodSig),
);
check(
  "a body altered by one character is refused",
  !tampered.ok,
  "the signature is over the bytes, not over the parsed object",
);

const genuine = await withWorkerScope(async () => verifyInbound(OWNER, "WHATSAPP", payload, goodSig));
check("and a genuine one is accepted", genuine.ok, "");

check(
  "the payload's own number is what says whose dealership it is",
  (await withWorkerScope(async () => ownerForPhoneNumberId(PHONE_NUMBER_ID))) === OWNER,
  "one URL serves every dealership, so this has to resolve before there is a key to check against",
);
check(
  "a number nobody has connected resolves to nothing",
  (await withWorkerScope(async () => ownerForPhoneNumberId("not-a-real-number"))) === null,
  "refused at the door rather than written and sorted out later",
);

// ═════════════════════════════════════════════════════════════════════════
section("5. A reply is stored once, however many times Meta sends it");

const incoming = {
  ownerId: OWNER,
  channel: "WHATSAPP" as const,
  providerMessageId: `${MARKER}-1`,
  fromAddress: FROM,
  fromName: "A customer",
  body: "Is the bike ready? I called yesterday and nobody picked up.",
  receivedAt: new Date(),
  raw: {},
};

const first = await withWorkerScope(async () => recordReply(incoming));
const retry = await withWorkerScope(async () => recordReply(incoming));

check("the first delivery is stored", first?.isNew === true, `id ${first?.row.id}`);
check(
  "the retry is not a second row",
  retry?.isNew === false && retry?.row.id === first?.row.id,
  "Meta retries anything it did not get a 200 for, including its own timeouts",
);
check(
  "the body is exactly what arrived",
  first?.row.body === incoming.body,
  "nothing classified it, nothing summarised it — R-49 does not bend for a sentence a customer wrote",
);
check(
  "and how it was attributed travels with it",
  first?.row.matchBasis !== undefined && first?.row.matchConfidence !== undefined,
  `${first?.row.matchBasis}${first?.row.matchConfidence ? ` at ${first.row.matchConfidence}` : ""}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("5b. A reply is threaded to what it answers, not to a guess");

/*
 * The case the first version of this file never reached.
 *
 * With no prior outbound to that number the reply came back `NONE`, every
 * check passed, and the whole threading path — the reason `providerMessageId`
 * exists on the outbox at all — was untested. A verifier that only exercises
 * the empty case is a verifier that will keep passing after threading breaks.
 *
 * R-47 in a new place: an explicit reference beats a probable one. The last
 * thing DDMS actually sent this number is a reference, because we wrote it and
 * know what it was about.
 */
await ownerDb.insert(outboundMessagesTable).values({
  ownerId: OWNER,
  showroomId: OUTLETS[0]!,
  module: "JOB_CARD",
  recordKey: "JC-VERIFY-CHANNELS",
  audience: "CUSTOMER",
  channel: "WHATSAPP",
  toAddress: FROM,
  body: "Your vehicle is ready for collection.",
  template: MARKER,
  draftedBy: "RULE",
  status: "SENT",
  sentAt: new Date(),
  authorisedBasis: "PERSON",
  providerMessageId: `${MARKER}-out-1`,
});

const threadedReply = await withWorkerScope(async () =>
  recordReply({
    ownerId: OWNER,
    channel: "WHATSAPP",
    providerMessageId: `${MARKER}-2`,
    fromAddress: `+${FROM}`,
    fromName: "A customer",
    body: "Coming tomorrow morning, thanks.",
    receivedAt: new Date(),
    raw: {},
  }),
);

check(
  "it found the message it answers",
  threadedReply?.row.matchBasis === "OUTBOUND_THREAD",
  `${threadedReply?.row.matchBasis} → ${threadedReply?.row.module} ${threadedReply?.row.recordKey}`,
);
check(
  "and lands on that record rather than on whatever went to the number last",
  threadedReply?.row.module === "JOB_CARD" && threadedReply?.row.recordKey === "JC-VERIFY-CHANNELS",
  `${threadedReply?.row.module}/${threadedReply?.row.recordKey}`,
);
check(
  "a number written +91… is stored the way the mirror stores one",
  threadedReply?.row.fromAddress === FROM.slice(2),
  `arrived as +${FROM}, stored as ${threadedReply?.row.fromAddress}`,
);
check(
  "a thread is worth more than a phone book match, and the row says so",
  Number(threadedReply?.row.matchConfidence ?? 0) > 0.9,
  `${threadedReply?.row.matchConfidence}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("6. An unread reply is on the queue, in the band that means nobody's");

const queue = await withWorkerScope(async () =>
  buildQueue({
    ownerId: OWNER,
    ownerShowroomIds: OUTLETS,
    visibleShowroomIds: OUTLETS,
    empCode: null,
    role: "OWNER",
  }),
);

const replyRows = queue.items.filter((i) => i.source === "REPLY");
check("both unread replies produced queue rows", replyRows.length === 2, `${replyRows.length} unread`);
check(
  "in the Nobody's band, because an unread message arrived at a number and not at a person",
  replyRows.every((r) => r.band === "UNASSIGNED"),
  replyRows.map((r) => r.band).join(", "),
);
check(
  "and the row quotes the message rather than interpreting it",
  replyRows.some((r) => incoming.body.startsWith(r.subtitle?.slice(0, 40) ?? " ")),
  replyRows[0]?.subtitle ?? "(none)",
);
check(
  "the threaded one is filed against its own record, the unmatched one is not",
  replyRows.some((r) => r.recordKey === "JC-VERIFY-CHANNELS") &&
    replyRows.some((r) => r.recordKey.startsWith("REPLY-")),
  replyRows.map((r) => r.recordKey).join(", "),
);

// ═════════════════════════════════════════════════════════════════════════
section("7. Reading it takes it off the queue, with a name against it");

await withWorkerScope(async () => markRead(OWNER, first!.row.id, 1));

const stillUnread = await withWorkerScope(async () => unreadReplies(OWNER, OUTLETS));
check(
  "it is no longer unread",
  !stillUnread.some((r) => r.id === first!.row.id),
  `${stillUnread.length} left`,
);

const after = await withWorkerScope(async () =>
  buildQueue({
    ownerId: OWNER,
    ownerShowroomIds: OUTLETS,
    visibleShowroomIds: OUTLETS,
    empCode: null,
    role: "OWNER",
  }),
);
check(
  "and it has left the queue, taking nothing else with it",
  after.items.filter((i) => i.source === "REPLY").length === replyRows.length - 1,
  `${after.items.filter((i) => i.source === "REPLY").length} reply row(s) left, from ${replyRows.length}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("8. The scheduler may send and may not connect an account");

/*
 * The check that caught itself in OBJ-26, written deliberately this time.
 *
 * An unattended process that could write a messaging credential could point a
 * dealership's outbound at a number nobody chose. `ddms_worker` holds select
 * and update and no insert, so the refusal comes from the grant rather than
 * from the code being careful.
 */
let refused = "";
try {
  await withWorkerScope(async () => {
    await db.insert(channelCredentialsTable).values({
      ownerId: OWNER,
      channel: "SMS",
      displayAddress: "should-never-exist",
      secretCipher: "x:y:z",
      secretHint: "••••",
    });
  });
} catch (err) {
  // Drizzle wraps the driver error; the sentence worth reading is on the cause.
  refused = ((err as { cause?: Error }).cause?.message ?? (err as Error).message) || "";
}
check(
  "an unattended process cannot connect an account",
  refused.toLowerCase().includes("permission denied"),
  refused || "IT INSERTED ONE — the grant is wrong",
);

await setChannelActive(OWNER, "WHATSAPP", false);
await reset();
console.log("  (credential, replies and the outbound rows this run made, all reset)");

console.log(
  failures === 0
    ? "\nAll checks passed. The credential is theirs, unreadable and unreturnable; a reply is stored once and reaches somebody.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
