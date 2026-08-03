/**
 * Sessions, and the tenant scope that comes from them.
 *
 * The service key says a request came from one of our own processes. It cannot
 * say *whose* data is being asked for — so until this file existed, any caller
 * with the key could read any owner's customers by changing a number in a URL.
 *
 * Everything here exists to make scope something the caller **is** rather than
 * something they **claim**. `assertShowroomAccess` is the load-bearing part: a
 * showroom id still arrives in the request, but it is now checked against the
 * session's owner before a single row is read.
 */

import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  sessionsTable,
  showroomsTable,
  usersTable,
  withSessionScope,
} from "@workspace/db";
// Hashing lives in lib/db, beside the column it protects, so the seed
// scripts can create users without reaching into this artifact.
export { hashPassword, verifyPassword } from "@workspace/db";
import { logger } from "./logger";

const SESSION_COOKIE = "ddms_session";
/** A working day, then sign in again. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ── Sessions ────────────────────────────────────────────────────────────────

/** Only ever the hash goes to the database — see the schema comment. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  userId: number;
  ownerId: number;
  email: string;
  name: string;
  role: string;
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessionsTable).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  // Opportunistic cleanup. A sessions table nobody prunes grows forever, and a
  // cron for it would be more machinery than the problem deserves.
  await db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date()));

  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      sessionId: sessionsTable.id,
      userId: usersTable.id,
      ownerId: usersTable.ownerId,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      isActive: usersTable.isActive,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
    .where(
      and(eq(sessionsTable.tokenHash, hashToken(token)), gt(sessionsTable.expiresAt, new Date())),
    );

  // A deactivated user's existing sessions stop working immediately. Checking
  // only at login would leave someone who was removed this morning still
  // reading customer records this afternoon.
  if (!row || !row.isActive) return null;

  await db
    .update(sessionsTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessionsTable.id, row.sessionId));

  return {
    userId: row.userId,
    ownerId: row.ownerId,
    email: row.email,
    name: row.name,
    role: row.role,
  };
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
}

// ── Express plumbing ────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionUser?: SessionUser;
      /**
       * The hash, never the token. It is what the database compares against
       * and what `withSessionScope` puts on the connection — see the note
       * there about GUCs turning up in `pg_stat_activity`.
       */
      sessionTokenHash?: string;
    }
  }
}

/** Read the cookie without pulling in a parser for one value. */
export function sessionTokenFrom(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const secure = process.env["NODE_ENV"] === "production";
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    ...(secure ? ["Secure"] : []),
  ].join("; "));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

/**
 * Attach the session if there is one. Never rejects — routes decide whether
 * they need a user, so a public route does not have to opt out of anything.
 */
export async function attachSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = sessionTokenFrom(req);
  if (token) {
    const user = await resolveSession(token);
    if (user) {
      req.sessionUser = user;
      req.sessionTokenHash = hashToken(token);
    }
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.sessionUser) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  next();
}

/**
 * Put the rest of this request on the restricted connection.
 *
 * From here down, `db` is a connection belonging to the `ddms_app` role, which
 * cannot bypass row-level security and has been told — via the session token
 * hash, which it has no way to read for itself — whose data it is allowed to
 * see. A handler below this that forgets its `where owner_id = ...` now returns
 * nothing instead of returning everything.
 *
 * The scope has to outlive `next()`, because the handlers it calls finish
 * asynchronously long after it returns. `res` closing is the only reliable
 * signal that the request is genuinely over, whether it ended in a response, an
 * error, or the client hanging up.
 */
export function sessionScope(req: Request, res: Response, next: NextFunction): void {
  const tokenHash = req.sessionTokenHash;
  if (!tokenHash) {
    // Only reachable if this is mounted without `requireUser` above it.
    res.status(401).json({ error: "Not signed in." });
    return;
  }

  const finished = new Promise<void>((resolve) => {
    res.on("close", () => resolve());
  });

  void withSessionScope(tokenHash, async () => {
    next();
    await finished;
  }).catch((err: unknown) => {
    // The scope itself failed — could not take a connection, or could not set
    // the session on it. Express has already been handed the request, so the
    // most this can do is say so loudly.
    logger.error({ err }, "Session-scoped connection failed");
    if (!res.headersSent) {
      res.status(503).json({ error: "Database is unavailable." });
    }
  });
}

/**
 * The check that makes tenancy real.
 *
 * A showroom id still arrives in the request — it has to, the console shows one
 * at a time — but it is now verified against the session's owner. Answering 404
 * rather than 403 is deliberate: 403 confirms the showroom exists, which tells
 * an attacker enumerating ids exactly what they wanted to learn.
 */
export async function assertShowroomAccess(
  req: Request,
  res: Response,
  showroomId: number,
): Promise<boolean> {
  const user = req.sessionUser;
  if (!user) {
    res.status(401).json({ error: "Not signed in." });
    return false;
  }

  const [row] = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(and(eq(showroomsTable.id, showroomId), eq(showroomsTable.ownerId, user.ownerId)));

  if (!row) {
    logger.warn(
      { userId: user.userId, ownerId: user.ownerId, showroomId },
      "Showroom access denied — not owned by this session's owner",
    );
    res.status(404).json({ error: `No showroom ${showroomId}` });
    return false;
  }

  return true;
}
