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
 * scope opened. The periodic sync is one of those, and it runs unscoped and
 * deliberately: it syncs every showroom of every owner, so it belongs to no
 * tenant. It has its own credential rather than the owner's — `workerDb` below.
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

// ── The pools ───────────────────────────────────────────────────────────────
//
// Four connection strings, and the split is the whole of OBJ-8. There used to
// be one credential — the table owner, which bypasses RLS and can read every
// password hash — doing every job in the process, because two of those jobs
// happen with nobody signed in and there was nowhere else for them to run.
//
//   DATABASE_URL          the table owner. drizzle-kit, the seeds, db:rls.
//                         **Not given to the API server at all** — see
//                         `refuseOwnerCredential` below.
//   DATABASE_URL_APP      `ddms_app`. Every request, scoped by its session.
//   DATABASE_URL_LOGIN    `ddms_login`. Sign-in, and nothing but sign-in.
//   DATABASE_URL_WORKER   `ddms_worker`. The scheduler, every tenant.
//
// Each pool is built on first use rather than at import, so a process that
// never signs anybody in never opens the login pool and a process with no
// owner credential can still import this module.

const pools = new Map<string, pg.Pool>();

function poolFor(envName: string, explain: () => string): pg.Pool {
  let existing = pools.get(envName);
  if (!existing) {
    const url = process.env[envName];
    if (!url) throw new Error(explain());
    existing = new Pool({ connectionString: url });
    pools.set(envName, existing);
  }
  return existing;
}

/**
 * The table owner. Bypasses RLS.
 *
 * Every caller left is a command somebody typed: drizzle-kit, the seed scripts,
 * `db:rls`, `db:probe`. Nothing that serves a request may reach for it, and in
 * the API server it is not merely unused — the credential is absent from the
 * environment, so this throws rather than quietly working.
 */
export function pool(): pg.Pool {
  return poolFor(
    "DATABASE_URL",
    () =>
      "DATABASE_URL is not set. It is the table owner's connection, used by " +
      "drizzle-kit, the seed scripts and db:rls. The API server is deliberately " +
      "not given it — if you are seeing this from the server, something on a " +
      "request path reached for the unrestricted connection.",
  );
}

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

/**
 * Refuse to run with the unrestricted credential in reach.
 *
 * The point of the split is not that the request path *chooses* the restricted
 * role. It is that the unrestricted one is not there to choose. A server that
 * still holds `DATABASE_URL` is one import away from bypassing every policy in
 * `rls.sql`, and the mistake would be silent — the query would simply work.
 *
 * So the API server calls this at startup and will not boot with it set. Run
 * the server from an environment file that does not carry it; the CLI tools
 * keep theirs.
 */
export function refuseOwnerCredential(): void {
  if (process.env["DATABASE_URL"]) {
    throw new Error(
      "DATABASE_URL is set. That is the table owner's connection and it " +
        "bypasses row-level security, so a server holding it can reach every " +
        "dealership's rows by accident. The API server runs on DATABASE_URL_APP, " +
        "DATABASE_URL_LOGIN and DATABASE_URL_WORKER instead — see .env.api.example. " +
        "Start it with `--env-file=.env.api`, not `--env-file=.env`.",
    );
  }
}

function appPool(): pg.Pool {
  requireAppRoleConfigured();
  return poolFor("DATABASE_URL_APP", () => "unreachable");
}

// ── The handles everything imports ──────────────────────────────────────────

/**
 * A drizzle handle that opens its pool the first time somebody queries it.
 *
 * Laziness is what lets one module describe four credentials without requiring
 * a process to hold all four. The API server has three of them; `db:push` has
 * one; neither should fail at import over a connection string it was never
 * going to use.
 *
 * `Reflect.get` with the resolved handle as receiver, and bind — a plain
 * `target[prop]` would hand back an unbound method and the first `this` inside
 * drizzle would be the proxy rather than the connection it belongs to.
 */
function lazyDb(resolve: () => Db): Db {
  let instance: Db | null = null;
  return new Proxy({} as Db, {
    get(_target, prop) {
      instance ??= resolve();
      const value = Reflect.get(instance as object, prop, instance);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(instance)
        : value;
    },
  });
}

const ownerDb: Db = lazyDb(() => drizzle(pool(), { schema }));

/**
 * Sign-in, and nothing else.
 *
 * `lib/session.ts` runs before any scope exists — it is working out *whose*
 * scope to open — so it cannot be scoped by a session, and it reads the two
 * tables `ddms_app` is deliberately denied. This is the credential for that,
 * and its grants in `rls.sql` are the shortest list in the file: users,
 * sessions, and the staff master the departure check joins.
 */
export const loginDb: Db = lazyDb(() =>
  drizzle(
    poolFor(
      "DATABASE_URL_LOGIN",
      () =>
        "DATABASE_URL_LOGIN is not set. Sign-in connects as the restricted " +
        "`ddms_login` role, which may read `users` and `sessions` and nothing " +
        "else. Run `pnpm run db:rls` after setting it.",
    ),
    { schema },
  ),
);

/**
 * The scheduler, which is cross-tenant by definition.
 *
 * Syncing every dealership on a timer cannot be scoped by a session, and this
 * is the honest way to say so: a named credential whose reach is the table list
 * in `rls.sql` rather than everything in the database. It holds the mirror and
 * the graph. It cannot read a user, a session, an application or a decision
 * somebody made.
 */
export const workerDb: Db = lazyDb(() =>
  drizzle(
    poolFor(
      "DATABASE_URL_WORKER",
      () =>
        "DATABASE_URL_WORKER is not set. The sync scheduler connects as the " +
        "restricted `ddms_worker` role, which holds the mirror tables for every " +
        "tenant and no people. Run `pnpm run db:rls` after setting it.",
    ),
    { schema },
  ),
);

/**
 * The handle every caller inside a request uses.
 *
 * Inside a scope it is that request's connection. Outside one it falls back to
 * the owner handle — which, in the API server, has no credential behind it and
 * throws. That is the intended shape: unscoped database access from a request
 * path used to work silently and now cannot happen at all.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const active = als.getStore()?.db ?? ownerDb;
    const value = Reflect.get(active as object, prop, active);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(active) : value;
  },
});

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

/**
 * Run `fn` with every `db` call inside it going to the scheduler's connection.
 *
 * The sync functions are the same ones a request calls when an owner presses
 * Sync, and they reach for `db` — which is right, because they should not know
 * or care who started them. What differs is the credential underneath, and this
 * is where that is decided rather than in each of the seven of them.
 *
 * No token and no `set_config`, unlike `withSessionScope`: `ddms_worker` is not
 * scoped by a session and its policies say `true`. What bounds it is the grant
 * list in `rls.sql`, which is why that list is short and written out by name.
 */
export async function withWorkerScope<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ db: workerDb }, fn);
}

/** True when the caller is inside a session scope. For assertions and logging. */
export function inSessionScope(): boolean {
  return als.getStore() !== undefined;
}

/**
 * The unrestricted handle, named so that reaching for it is a visible decision.
 *
 * Since OBJ-8 there are no callers of it inside the server. The two that used
 * to be here — the scheduler and sign-in — have credentials of their own above,
 * because "cross-tenant by definition" was a reason to name a role, not a
 * reason to hand out the one that bypasses everything. What is left is the
 * command-line tools, which run as a person who already has the password.
 */
export { ownerDb };
