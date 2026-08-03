/**
 * Sign in, sign out, and who am I.
 *
 * These three sit behind the service key like everything else — the key says
 * the request came from one of our own front ends — but they are the only
 * routes that do not additionally require a session, for the obvious reason.
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  sessionTokenFrom,
  setSessionCookie,
  verifyPassword,
} from "../lib/session";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.trim().toLowerCase()));

  // One message for "no such user", "wrong password" and "deactivated". Which
  // of the three it was is exactly what someone probing for valid addresses
  // wants to learn, and a legitimate user already knows.
  const ok = user && user.isActive && (await verifyPassword(password, user.passwordHash));
  if (!ok) {
    logger.warn({ email }, "Failed sign-in");
    res.status(401).json({ error: "Those details are not right." });
    return;
  }

  const { token, expiresAt } = await createSession(user.id);
  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
  setSessionCookie(res, token, expiresAt);

  logger.info({ userId: user.id, ownerId: user.ownerId }, "Signed in");
  res.json({
    userId: user.id,
    ownerId: user.ownerId,
    email: user.email,
    name: user.name,
    role: user.role,
  });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = sessionTokenFrom(req);
  if (token) await destroySession(token);
  clearSessionCookie(res);
  res.status(204).end();
});

/**
 * The console calls this on load to decide whether to show the sign-in screen.
 * 401 is a normal answer here, not an error worth logging.
 */
router.get("/auth/me", (req, res): void => {
  if (!req.sessionUser) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  res.json(req.sessionUser);
});

export default router;
