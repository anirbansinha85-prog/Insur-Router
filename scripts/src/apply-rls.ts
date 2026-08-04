/**
 * Create the restricted database role and apply the row-level security policies.
 *
 *   pnpm run db:rls
 *
 * Two connection strings are involved and they are not interchangeable:
 *
 *   DATABASE_URL       the table owner. Used here, and by drizzle-kit. Bypasses
 *                      RLS, which is exactly why the running server should stop
 *                      using it for anything a signed-in user asked for.
 *   DATABASE_URL_APP   the `ddms_app` role. What the DDMS request path connects
 *                      as. This script creates it and sets its password from
 *                      whatever is in that URL, so the URL is the single place
 *                      the credential is written down.
 *
 * Run it after every `db:push`. New tables arrive with RLS enabled and no
 * policies, so `ddms_app` cannot read them until they are named in `rls.sql` —
 * a DDMS screen going blank is a much better failure than a DDMS screen showing
 * every dealership's rows.
 *
 * Idempotent, and it finishes by proving the thing it claims: it reconnects as
 * `ddms_app` with no session and checks that the tables read empty.
 *
 * > If it ever does report `password authentication failed for user
 * > "ddms_app"`, it has just reset the password because the one in
 * > DATABASE_URL_APP did not work. Supabase's pooler caches credentials, so
 * > wait a few seconds and run it again — the role is fine, the pooler is still
 * > holding the previous one.
 */

import { readFileSync } from "node:fs";
import pg from "pg";
import { pool } from "@workspace/db";

const SQL_PATH = new URL("../../lib/db/sql/rls.sql", import.meta.url);

/** Tables the check below expects to be unreadable without a session. */
const SCOPED_TABLES = [
  "applications",
  "dms_deals",
  "dms_job_cards",
  "dms_enquiries",
  "dms_registrations",
  "dms_part_stock",
  "entities",
  "entity_links",
  "decision_log",
  "outbound_messages",
  "showrooms",
  "owners",
];

function appConnection(): { url: string; role: string; password: string } {
  const url = process.env["DATABASE_URL_APP"];
  if (!url) {
    throw new Error(
      "DATABASE_URL_APP is not set. It is the connection string for the " +
        "restricted `ddms_app` role — copy DATABASE_URL, change the user to " +
        "`ddms_app` (on Supabase's pooler: `ddms_app.<project-ref>`) and pick a " +
        "new password. This script creates the role with that password.",
    );
  }

  const parsed = new URL(url);
  // Supabase's pooler encodes the project into the username as
  // `role.projectref`. The role itself is the part before the first dot, and
  // getting this wrong creates a role nothing can log in as.
  const role = decodeURIComponent(parsed.username).split(".")[0];
  const password = decodeURIComponent(parsed.password);

  if (!role || !password) {
    throw new Error("DATABASE_URL_APP must include both a username and a password.");
  }
  if (role === "postgres") {
    throw new Error(
      "DATABASE_URL_APP points at `postgres`, the table owner. That role " +
        "bypasses RLS, so pointing the app at it would apply the policies and " +
        "then ignore them.",
    );
  }

  return { url, role, password };
}

/**
 * Role name and password cannot be bound as parameters — they are identifiers
 * and literals in DDL, not values. Rather than escaping them here, `format`
 * with `%I`/`%L` does it server-side, which is the one implementation that is
 * definitionally correct.
 *
 * The re-run path deliberately omits `nosuperuser`, which the create path
 * carries. Supabase's `supautils` hook rejects any `alter role` that names the
 * superuser attribute — *"only roles with the SUPERUSER attribute may alter
 * roles with the SUPERUSER attribute"* — even to switch it off, and even when
 * it was already off. Nothing is lost by omitting it: `check()` below reads the
 * role's actual attributes back and refuses to continue if it can bypass RLS,
 * which is the property that matters and the only one worth trusting a query
 * about rather than a DDL statement.
 */
async function createRole(role: string, password: string, url: string): Promise<void> {
  const { rows } = await pool.query<{ create_sql: string; alter_sql: string }>(
    `select
       format(
         'create role %I with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls password %L',
         $1::text, $2::text
       ) as create_sql,
       format(
         'alter role %I with login nocreatedb nocreaterole noinherit nobypassrls password %L',
         $1::text, $2::text
       ) as alter_sql`,
    [role, password],
  );

  const { rows: existing } = await pool.query(
    "select 1 from pg_roles where rolname = $1",
    [role],
  );

  if (existing.length === 0) {
    await pool.query(rows[0].create_sql);
    console.log(`  role     ${role.padEnd(16)} created`);
    return;
  }

  // The role exists. Try the credentials before touching them.
  //
  // Resetting the password unconditionally looks harmless and is not: Supabase's
  // pooler caches role credentials, so an `alter role … password` — even to the
  // *same* password — invalidates the cache and the next connection is refused
  // for a few seconds. That made every re-run of this script fail at its own
  // verification step, which is a poor property for a script whose entire job is
  // to verify. Only reset when the credentials do not actually work.
  if (await canConnect(url)) {
    console.log(`  role     ${role.padEnd(16)} already exists and the password works, left alone`);
    return;
  }

  await pool.query(rows[0].alter_sql);
  console.log(`  role     ${role.padEnd(16)} password did not work, reset`);
  console.log(`           the pooler caches credentials — give it a few seconds`);
}

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Connect as `ddms_app`, assert no session, and count.
 *
 * This is the whole objective in six queries. Reading the policy file proves
 * nothing — a policy with a typo in the owner comparison still reads like a
 * policy. Only a query that comes back empty proves it is closed.
 */
async function check(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  let ok = true;
  try {
    const who = await client.query(
      "select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypass",
    );
    console.log(
      `\n  connected as ${who.rows[0].current_user} ` +
        `(bypassrls: ${who.rows[0].bypass})`,
    );
    if (who.rows[0].bypass) {
      console.log("  ✗ this role bypasses RLS — policies will not apply to it");
      ok = false;
    }

    console.log("\n  With no session set:\n");
    for (const table of SCOPED_TABLES) {
      const { rows } = await client.query(`select count(*)::int as n from public.${table}`);
      const n = rows[0].n as number;
      console.log(`    ${table.padEnd(18)} ${n} rows ${n === 0 ? "✓" : "✗ EXPECTED 0"}`);
      if (n !== 0) ok = false;
    }

    // The one that matters most. If this role can read a token hash it can set
    // `app.session_token` to it and become that owner.
    for (const table of ["users", "sessions"]) {
      try {
        await client.query(`select count(*) from public.${table}`);
        console.log(`    ${table.padEnd(18)} READABLE ✗ — must be denied, not empty`);
        ok = false;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "42501") {
          console.log(`    ${table.padEnd(18)} permission denied ✓`);
        } else {
          throw err;
        }
      }
    }
  } finally {
    await client.end();
  }

  return ok;
}

async function main(): Promise<void> {
  const { url, role, password } = appConnection();

  console.log("Applying row-level security\n");
  await createRole(role, password, url);

  await pool.query(readFileSync(SQL_PATH, "utf8"));

  const { rows: policies } = await pool.query<{ tablename: string; policyname: string }>(
    "select tablename, policyname from pg_policies where schemaname = 'public' order by tablename",
  );
  console.log(`  policies ${String(policies.length).padEnd(16)} applied`);
  for (const p of policies) console.log(`             ${p.tablename.padEnd(24)} ${p.policyname}`);

  const ok = await check(url);

  if (!ok) {
    console.error("\nRLS is NOT closed. Do not point the server at this role yet.");
    process.exit(1);
  }
  console.log("\nClosed. `ddms_app` reads nothing until a request supplies a session token.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Applying RLS failed:", err);
    process.exit(1);
  });
