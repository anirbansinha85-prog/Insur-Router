/**
 * A service key on every /api route.
 *
 * **What this is.** One shared secret that says "the caller is one of our own
 * processes". It closes the hole where anyone who found the host could read
 * every application, every customer's phone number and Aadhaar, and issue
 * policies. That hole is open right now, and this closes it.
 *
 * **What this is not.** It is not per-user authentication. It cannot say *which*
 * showroom is asking, so it cannot enforce the owner scoping the schema was
 * shaped for — `applications.showroomId` still has to be trusted from the
 * request rather than derived from a session. Tenant isolation needs real
 * sessions, and until they exist the honest description of this system is
 * "one owner, one key".
 *
 * **How browsers get the key.** They do not. Each Vite dev server injects the
 * header into its `/api` proxy, so the key lives in the Node process and never
 * reaches a bundle. Anything served to a browser in production needs the same
 * injection at the reverse proxy — or, better, the session auth above.
 */

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const KEY_VAR = "API_SERVICE_KEY";

/**
 * Paths that answer without a key, matched against the path *inside* the /api
 * mount. Only the health check: a platform that cannot probe liveness restarts
 * a healthy service, and the response carries nothing worth protecting.
 */
const PUBLIC_PATHS = new Set(["/healthz"]);

/**
 * Read at import time so a missing key fails at startup rather than on the
 * first request, matching how PORT is handled. A server that silently starts
 * without its auth configured is the failure mode worth designing out.
 */
export function requireServiceKeyConfigured(): string {
  const key = process.env[KEY_VAR];
  if (!key || key.trim().length === 0) {
    throw new Error(
      `${KEY_VAR} environment variable is required but was not provided. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  if (key.trim().length < 32) {
    throw new Error(
      `${KEY_VAR} is too short to be a credential — use at least 32 characters.`,
    );
  }
  return key.trim();
}

/** Compare without leaking length or position through timing. */
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Accepts either header. `Authorization: Bearer` is what the generated client
 * already emits via `setAuthTokenGetter`; `x-api-key` is what curl and most
 * schedulers reach for first, and rejecting it buys nothing.
 */
function presentedKey(req: Request): string | null {
  const header = req.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const apiKey = req.get("x-api-key");
  return apiKey?.trim() || null;
}

export function serviceKeyAuth(expected: string) {
  return function serviceKeyAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (PUBLIC_PATHS.has(req.path)) {
      next();
      return;
    }

    const presented = presentedKey(req);
    if (!presented) {
      res.status(401).json({
        error:
          "Missing API key. Send it as `Authorization: Bearer <key>` or `x-api-key: <key>`.",
      });
      return;
    }

    if (!matches(presented, expected)) {
      // Deliberately says no more than that. Which part was wrong is
      // information an attacker wants and a legitimate caller already knows.
      res.status(401).json({ error: "Invalid API key." });
      return;
    }

    next();
  };
}

/**
 * Origins allowed to call the API from a browser.
 *
 * `cors()` with no arguments reflects every origin, which means any page on the
 * internet could make a user's browser call this API. The default here is the
 * three local dev servers; deployments set CORS_ORIGINS explicitly.
 */
export function allowedOrigins(): string[] {
  const configured = process.env["CORS_ORIGINS"];
  if (configured && configured.trim()) {
    return configured
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }
  return [
    "http://localhost:24791", // InsurRouter
    "http://localhost:18815", // VeloDocs
    "http://localhost:9090", // dms-mock portal
  ];
}
