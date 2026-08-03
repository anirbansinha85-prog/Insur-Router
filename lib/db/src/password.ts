/**
 * Password hashing, kept beside the table that stores the result.
 *
 * Here rather than in the API server because the seed scripts create users too,
 * and the alternative was a script reaching into `artifacts/api-server/src` —
 * which the compiler rejected, correctly. Two implementations of a password
 * format is how one of them ends up weaker than the other.
 *
 * scrypt from node:crypto: no dependency, and the cost parameter is the entire
 * point of a password hash. Never a plain SHA.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

/** `scrypt$<saltHex>$<hashHex>` — the algorithm travels with the value, so
 *  changing it later is a migration rather than an archaeology exercise. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const derived = await scryptAsync(password, Buffer.from(saltHex, "hex"), KEYLEN);
  const expected = Buffer.from(hashHex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
