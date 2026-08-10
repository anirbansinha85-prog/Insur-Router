/**
 * Sign in, sign out, and who am I.
 *
 * These three sit behind the service key like everything else — the key says
 * the request came from one of our own front ends — but they are the only
 * routes that do not additionally require a session, for the obvious reason.
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, loginDb, showroomsTable, usersTable } from "@workspace/db";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireUser,
  sessionScope,
  sessionTokenFrom,
  setSessionCookie,
  verifyPassword,
  departedPerTheDms,
} from "../lib/session";
import { logger } from "../lib/logger";
import { modulesFor, permissionsFor } from "../lib/dms/permissions";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const [user] = await loginDb
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

  // And the dealership's own view of whether this person still works here.
  // Checked at sign-in as well as on every request: `resolveSession` would
  // catch it a moment later anyway, but issuing a cookie that stops working on
  // the next click is a worse answer than not issuing one.
  //
  // Same message as a wrong password, deliberately. "That employee has left" to
  // somebody guessing addresses is a staff directory.
  const departed = await departedPerTheDms(user.empCode, user.showroomId);
  if (departed) {
    logger.warn(
      { email, empCode: user.empCode, leftOn: departed.on },
      "Sign-in refused — the dealer's own system reports this employee has left",
    );
    res.status(401).json({ error: "Those details are not right." });
    return;
  }

  const { token, expiresAt } = await createSession(user.id);
  await loginDb.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
  setSessionCookie(res, token, expiresAt);

  logger.info(
    { userId: user.id, ownerId: user.ownerId, role: user.role },
    "Signed in",
  );
  res.json({
    userId: user.id,
    ownerId: user.ownerId,
    email: user.email,
    name: user.name,
    role: user.role,
    empCode: user.empCode,
    showroomId: user.showroomId,
    // What this role may see, so the console can show a sidebar that matches
    // what the database will actually answer. Sent rather than re-derived in
    // the frontend: two copies of the table would drift, and the one the user
    // sees would be the wrong one.
    modules: modulesFor(user.role),
    // And what they may *do*, which the sidebar cannot express.
    //
    // Sent for the same reason `modules` is: the console was deciding whether
    // to show the policy controls with `role === "OWNER" || role === "MANAGER"`
    // written into a screen, which is a second permission table that can
    // disagree with the first. Now there is one table, it lives on the server,
    // and the client is told the answer rather than working it out.
    //
    // Still cosmetic — the route refuses and the row policies refuse. Hiding a
    // control is a courtesy, not a control.
    permissions: permissionsFor(user.role),
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
 *
 * Scoped, unlike the two routes above, because it answers with the outlets this
 * person may act for and those come out of `showrooms` — a table `ddms_login`
 * has no business reading. The narrower credential stays narrow and this one
 * route opens a session scope to read what the session is already entitled to.
 */
router.use("/auth/me", requireUser, sessionScope);

router.get("/auth/me", async (req, res): Promise<void> => {
  const user = req.sessionUser!;

  // The owner's whole set, or the one outlet a member of staff works at. The
  // policy has already narrowed this to the owner; the filter below is the
  // second predicate, and like every other one in this product it can only
  // take away.
  const rows = await db
    .select({
      id: showroomsTable.id,
      code: showroomsTable.code,
      name: showroomsTable.name,
    })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, user.ownerId))
    .orderBy(showroomsTable.id);

  const showrooms = user.showroomId === null ? rows : rows.filter((s) => s.id === user.showroomId);

  res.json({
    ...user,
    modules: modulesFor(user.role),
    permissions: permissionsFor(user.role),
    showrooms,
  });
});

export default router;
