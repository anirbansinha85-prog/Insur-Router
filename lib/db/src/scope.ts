/**
 * Request-scoped database access, so row-level security has something to scope
 * *by*.
 *
 * The policies in `sql/rls.sql` all resolve the tenant through
 * `app.current_owner_id()`, which reads a session token off the connection.
 * Something has to put it there, on the right connection, for the duration of
 * one request and no longer. That is this file.
 *
 * ## Why the `db` export is a proxy
 *
 * The alternative was threading a per-request handle through every caller —
 * routes, then the worklist builders, then the sync functions, then the panel
 * projection, about a hundred call sites, several of which have no access to a
 * `req` and no business gaining one. A helper that computes overdue job cards
 * should not take an Express request as an argument to do it.
 *
 * So `db` resolves at call time: inside a scope it is the scoped connection,
 * outside one it is the pooled owner connection everything already used. No
 * caller changes, and no caller can accidentally reach past its scope, because
 * there is no unscoped handle in reach to reach with.
 *
 * The implicitness is the cost, and it is contained here. `AsyncLocalStorage`
 * carries the store across every await in the request — that is precisely what
 * it exists for — but it does **not** cross a `setTimeout` scheduled before the
 * scope opened. The periodic sync is one of those, and it runs unscoped on the
 * owner connection deliberately: it syncs every showroom of every owner, so it
 * belongs to no tenant.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

export type Db = NodePgDatabase<typeof schema>;

interface Scope {
  db: Db;
}

const als = new AsyncLocalStorage<Scope>();

// ── The two pools ───────────────────────────────────────────────────────────

if (!process.env["DATABASE_URL"]) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

/**
 * The table owner. Bypasses RLS.
 *
 * Still used by everything outside a scope: InsurRouter's routes, VeloDocs's
 * ingest, the scheduler, the seed scripts, and the sign-in path — which has to
 * read `users` before it knows who is asking, and is the one query that cannot
 * be scoped by the answer it is trying to find.
 */
export const pool: pg.Pool = new Pool({ connectionString: process.env["DATABASE_URL"] });

const ownerDb: Db = drizzle(pool, { schema });

let appPoolInstance: pg.Pool | null = null;

/** True when a restricted role has been configured. */
export function isAppRoleConfigured(): boolean {
  return Boolean(process.env["DATABASE_URL_APP"]);
}

/**
 * Fail at startup rather than at the first request.
 *
 * Same reasoning as `requireServiceKeyConfigured` in the api-server: a server
 * that silently falls back to the unrestricted connection is a server whose
 * isolation quietly stopped working, and nothing on screen would say so.
 */
export function requireAppRoleConfigured(): void {
  if (!isAppRoleConfigured()) {
    throw new Error(
      "DATABASE_URL_APP is not set. The DDMS request path connects as the " +
        "restricted `ddms_app` role so row-level security applies to it. Run " +
        "`pnpm run db:rls` after setting it — see lib/db/sql/rls.sql.",
    );
  }
}

function appPool(): pg.Pool {
  if (!appPoolInstance) {
    requireAppRoleConfigured();
    appPoolInstance = new Pool({ connectionString: process.env["DATABASE_URL_APP"] });
  }
  return appPoolInstance;
}

// ── The handle everything imports ───────────────────────────────────────────

/**
 * `Reflect.get` with the active handle as receiver, and bind — a plain
 * `target[prop]` would hand back an unbound method and the first `this` inside
 * drizzle would be the proxy rather than the connection it belongs to.
 *
 * The proxy target is the owner handle rather than an empty object so that
 * anything drizzle does with prototypes or internal slots still sees a real
 * database object.
 */
export const db: Db = new Proxy(ownerDb, {
  get(target, prop) {
    const active = als.getStore()?.db ?? target;
    const value = Reflect.get(active as object, prop, active);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(active) : value;
  },
}) as Db;

/**
 * Run `fn` with every `db` call inside it going to a connection that has
 * declared whose session it is acting for.
 *
 * The **hash** of the session token is what gets set, not the token. The token
 * is a bearer credential; a GUC ends up in `pg_stat_activity` and in any query
 * log somebody switches on, and neither is a place to leave one. The hash is
 * what the `sessions` table stores anyway, so the policy compares like with
 * like.
 *
 * Session-scoped `set_config` rather than a transaction: syncing a showroom
 * makes several HTTP calls to the dealer's DMS, and wrapping that in an open
 * transaction would hold a connection for the length of somebody else's
 * network. The reset in `finally` closes the loop, and the set at the top of
 * every scope means a client that somehow escaped its reset is corrected before
 * it is used rather than trusted.
 */
export async function withSessionScope<T>(
  sessionTokenHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await appPool().connect();
  let dirty = false;

  try {
    await client.query("select set_config('app.session_token', $1, false)", [sessionTokenHash]);
    return await als.run({ db: drizzle(client, { schema }) }, fn);
  } catch (err) {
    dirty = true;
    throw err;
  } finally {
    try {
      await client.query("select set_config('app.session_token', '', false)");
    } catch {
      // Could not clear it, so do not put it back in the pool carrying a
      // token. Destroying the connection costs one handshake; returning a
      // primed one costs correctness.
      dirty = true;
    }
    client.release(dirty);
  }
}

/** True when the caller is inside a session scope. For assertions and logging. */
export function inSessionScope(): boolean {
  return als.getStore() !== undefined;
}

/**
 * The unrestricted handle, named so that reaching for it is a visible decision.
 *
 * Only two callers should want it: something that is genuinely cross-tenant by
 * definition (the scheduler), and the sign-in path.
 */
export { ownerDb };
