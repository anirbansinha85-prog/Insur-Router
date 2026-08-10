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
 *
 * ## Which connection this file uses, and why it is its own
 *
 * `loginDb`, not `db`. Everything here runs *before* a scope exists — it is
 * working out whose scope to open — so it cannot be scoped by a session, and it
 * reads the two tables `ddms_app` is deliberately denied. Until OBJ-8 that meant
 * running on the table owner, which is how the credential that bypasses every
 * policy stayed in the server's environment.
 *
 * `ddms_login` is that job and only that job: `users`, `sessions`, and the staff
 * master the departure check joins. It cannot read a customer, a deal or an
 * application, and it may write exactly one column of `users` —
 * `last_login_at` — so a leak of it cannot rewrite a password hash or hand
 * somebody a different role. The grants are in `lib/db/sql/rls.sql`.
 */

import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  loginDb,
  sessionsTable,
  dmsEmployeesTable,
  showroomsTable,
  usersTable,
  withSessionScope,
} from "@workspace/db";
// Hashing lives in lib/db, beside the column it protects, so the seed
// scripts can create users without reaching into this artifact.
export { hashPassword, verifyPassword } from "@workspace/db";
import { logger } from "./logger";
import { canRead, refusalFor, seesEveryOutlet, type AccessModule } from "./dms/permissions";

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
  /**
   * The dealer's own employee code, when this login is a member of staff.
   *
   * The join that makes *my work* mean something: the same code is already on
   * the enquiries, registration files and job cards assigned to them. Null for
   * an owner, who has no row in the dealership's staff master.
   */
  empCode: string | null;
  /** The outlet they work at. Null means every outlet the owner holds. */
  showroomId: number | null;
}

/**
 * Has the dealership's own system said this person has left?
 *
 * The DMS already records `dateOfLeaving`, and the reassignment actions have
 * refused work to departed staff since OBJ-10. The same fact should close their
 * login, and this is where it does.
 *
 * **Strictly one direction.** This can only ever revoke. A login is created by
 * an owner and linked to an employee; nothing here creates or re-enables one,
 * so a name appearing in a staff master can never become an account. That is
 * the same asymmetry as Salesforce's sharing layers, which can only grant
 * outward from a private baseline — mirrored, because here the safe direction
 * is to take away.
 *
 * **And the honest limit: this is only as fresh as the last sync.** The mirror
 * is read-only and pulled on a timer, so somebody who left this morning keeps
 * access until the next pass. That window is the scheduler's interval and it is
 * the same one the reassignment refusal has always run on. It is a real
 * weakness of deprovisioning by mirror and is worth stating rather than
 * implying: an owner who needs somebody out *now* deactivates the user, which
 * is immediate and is checked on every request.
 */
export async function departedPerTheDms(
  empCode: string | null,
  showroomId: number | null,
): Promise<{ left: true; on: string | null } | null> {
  if (!empCode || showroomId === null) return null;

  const [emp] = await loginDb
    .select({
      isActive: dmsEmployeesTable.isActive,
      dateOfLeaving: dmsEmployeesTable.dateOfLeaving,
    })
    .from(dmsEmployeesTable)
    .where(
      and(
        eq(dmsEmployeesTable.showroomId, showroomId),
        eq(dmsEmployeesTable.empCode, empCode),
      ),
    );

  // No row is not a departure. A staff master that has not synced yet, or an
  // employee code the dealership has since retired, must not lock somebody out
  // — the mirror revokes on a positive statement that they left, never on an
  // absence of evidence.
  if (!emp) return null;
  return emp.isActive === "Y" ? null : { left: true, on: emp.dateOfLeaving };
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await loginDb.insert(sessionsTable).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  // Opportunistic cleanup. A sessions table nobody prunes grows forever, and a
  // cron for it would be more machinery than the problem deserves.
  await loginDb.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date()));

  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<SessionUser | null> {
  const [row] = await loginDb
    .select({
      sessionId: sessionsTable.id,
      userId: usersTable.id,
      ownerId: usersTable.ownerId,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      empCode: usersTable.empCode,
      showroomId: usersTable.showroomId,
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

  // And the same for a departure the dealership recorded in their own system.
  // Checked on every request rather than only at sign-in, for the same reason:
  // a live session outlasting somebody's last day is exactly the hole this is
  // meant to close.
  const departed = await departedPerTheDms(row.empCode, row.showroomId);
  if (departed) {
    logger.warn(
      { userId: row.userId, empCode: row.empCode, leftOn: departed.on },
      "Session refused — the dealer's own system reports this employee has left",
    );
    return null;
  }

  await loginDb
    .update(sessionsTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessionsTable.id, row.sessionId));

  return {
    userId: row.userId,
    ownerId: row.ownerId,
    email: row.email,
    name: row.name,
    role: row.role,
    empCode: row.empCode,
    showroomId: row.showroomId,
  };
}

/**
 * The outlets this session may look at.
 *
 * One when the login is a member of staff, all of the owner's when it is not.
 * Always a subset of the owner's, which is the property every policy below
 * depends on — this narrows and cannot widen.
 */
export async function visibleShowroomIds(user: SessionUser): Promise<number[]> {
  if (user.showroomId !== null && !seesEveryOutlet(user.role)) return [user.showroomId];
  const rows = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, user.ownerId));
  return rows.map((r) => r.id);
}

export async function destroySession(token: string): Promise<void> {
  await loginDb.delete(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
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

  // And then the narrower question: a member of staff works at one outlet, and
  // asking for another one's screen gets the same 404 as asking for another
  // dealership's. Same answer on purpose — a different one would tell somebody
  // which of the two walls they had hit.
  if (user.showroomId !== null && !seesEveryOutlet(user.role) && user.showroomId !== showroomId) {
    logger.warn(
      { userId: user.userId, role: user.role, theirs: user.showroomId, asked: showroomId },
      "Showroom access denied — outside this employee's outlet",
    );
    res.status(404).json({ error: `No showroom ${showroomId}` });
    return false;
  }

  return true;
}

/**
 * The module gate as router middleware.
 *
 * `assertModuleAccess` answers per route; this is the same answer mounted once
 * on a prefix, for products where every screen is about one module. InsurRouter
 * is all `DEAL` — an application is the insurance side of a vehicle somebody
 * bought — so gating it route by route would be nine copies of one decision.
 *
 * Legibility only. The row policies are what refuse; this is what explains.
 */
export function requireModule(module: AccessModule) {
  return function gate(req: Request, res: Response, next: NextFunction): void {
    if (assertModuleAccess(req, res, module)) next();
  };
}

/**
 * Which outlet a newly created record belongs to.
 *
 * An application has to name one. Under the policies in `rls.sql` a row with no
 * showroom belongs to nobody and is invisible to everybody, including the person
 * who just created it — so "leave it null and sort it out later" is not a
 * neutral default, it is a record that silently disappears.
 *
 * Three answers, in order, and the order is the whole design:
 *
 *   1. What the caller asked for, if they asked — checked against the session
 *      the same way every other showroom id is, so a number in a request body
 *      cannot reach another dealership.
 *   2. The outlet this person works at. A member of staff has exactly one, and
 *      it is not a guess: it is on their login.
 *   3. The owner's only outlet, when they hold exactly one. Not a guess either —
 *      there is nothing else it could be.
 *
 * And when an owner holds several and said nothing, no answer: `null` back to
 * the caller, which asks rather than picking. Attributing a customer's policy to
 * whichever branch happened to sort first is the kind of quiet wrong answer that
 * shows up months later in somebody's ledger.
 */
export async function resolveOwningShowroom(
  req: Request,
  res: Response,
  asked: number | null | undefined,
): Promise<{ ok: true; showroomId: number | null } | { ok: false }> {
  const user = req.sessionUser;
  if (!user) {
    res.status(401).json({ error: "Not signed in." });
    return { ok: false };
  }

  if (asked != null) {
    if (!(await assertShowroomAccess(req, res, asked))) return { ok: false };
    return { ok: true, showroomId: asked };
  }

  if (user.showroomId !== null) return { ok: true, showroomId: user.showroomId };

  const rows = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, user.ownerId));

  if (rows.length === 1) return { ok: true, showroomId: rows[0]!.id };
  return { ok: true, showroomId: null };
}

/**
 * The module gate.
 *
 * Belt to the row policies' braces. RLS is what makes the refusal true — a
 * service advisor's connection reads zero rows from the ledger whatever the
 * code does — and this is what makes it *legible*, because a screen that came
 * back empty would be indistinguishable from a dealership with no debts.
 */
export function assertModuleAccess(
  req: Request,
  res: Response,
  module: AccessModule,
): boolean {
  const user = req.sessionUser;
  if (!user) {
    res.status(401).json({ error: "Not signed in." });
    return false;
  }
  if (canRead(user.role, module)) return true;

  logger.warn(
    { userId: user.userId, role: user.role, module },
    "Module access denied by role",
  );
  res.status(403).json({ error: refusalFor(user.role, module) });
  return false;
}
