import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * The dealership's credential, at rest (OBJ-27, R-106).
 *
 * ## Why encryption when there is already row-level security
 *
 * They answer different questions and neither substitutes for the other. RLS
 * decides which rows a connection may read; it has nothing to say about a
 * database backup on somebody's laptop, a `pg_dump` in a support ticket, or the
 * table owner's credential — which the CLI tools legitimately hold. A WhatsApp
 * access token in the clear in any of those is a token that can message a
 * dealership's entire customer list from their own number.
 *
 * The key is in `CREDENTIAL_KEY`, in the environment, not in the database. Two
 * compromises are then needed rather than one, and the second is the one this
 * product's own tooling cannot accidentally hand over.
 *
 * ## AES-256-GCM, and the tag is the point
 *
 * GCM authenticates as well as encrypts, so a ciphertext somebody has altered
 * fails to decrypt rather than decrypting to something else. CBC would have
 * left a modified token producing a garbled string that gets sent to Meta as a
 * bearer credential, which fails in a way nobody can read.
 *
 * ## It refuses to start rather than falling back
 *
 * No `CREDENTIAL_KEY`, no encryption, and the honest behaviour is that the
 * feature is unavailable — not that the token is written in the clear with a
 * warning nobody reads. The same shape as `refuseOwnerCredential()`: a
 * dangerous fallback that silently works is worse than an error.
 */

const ENV = "CREDENTIAL_KEY";

/**
 * 32 bytes, derived once.
 *
 * Accepts a 64-character hex key directly, and hashes anything else to length
 * so a person who pasted a passphrase gets a usable key rather than a stack
 * trace. Deliberately **not** a KDF with a salt: there is one key for the
 * deployment, it is not a password, and a salt would have to be stored
 * somewhere — which is the problem this is avoiding.
 */
function keyOrThrow(): Buffer {
  const raw = process.env[ENV];
  if (!raw || raw.length < 32) {
    throw new Error(
      `${ENV} is missing or shorter than 32 characters. ` +
        "A dealership's messaging credential cannot be stored without it, and " +
        "storing one in the clear is not the fallback. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : createHash("sha256").update(raw).digest();
}

/** True when this deployment can hold a credential at all. */
export function credentialsAvailable(): boolean {
  try {
    keyOrThrow();
    return true;
  } catch {
    return false;
  }
}

/** `iv:tag:ciphertext`, all base64. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOrThrow(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(
    ":",
  );
}

export function open(sealed: string): string {
  const [iv, tag, body] = sealed.split(":");
  if (!iv || !tag || !body) throw new Error("Stored credential is not in the expected form.");
  const decipher = createDecipheriv("aes-256-gcm", keyOrThrow(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * The last four characters, for a person deciding which token they pasted.
 *
 * Four rather than eight: enough to tell two tokens apart, short enough to be
 * useless to anybody who only has this.
 */
export function hint(plaintext: string): string {
  return plaintext.length <= 4 ? "••••" : `••••${plaintext.slice(-4)}`;
}
