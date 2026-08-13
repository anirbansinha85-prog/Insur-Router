/**
 * Create the restricted database roles and apply the row-level security policies.
 *
 *   pnpm run db:rls
 *
 * Four connection strings are involved and none of them are interchangeable:
 *
 *   DATABASE_URL          the table owner. Used here, and by drizzle-kit.
 *                         Bypasses RLS, which is why the API server is no
 *                         longer given it at all — see `refuseOwnerCredential`
 *                         in lib/db/src/scope.ts.
 *   DATABASE_URL_APP      the `ddms_app` role. Every request path connects as
 *                         this, and reads what the session's policies allow.
 *   DATABASE_URL_LOGIN    the `ddms_login` role. Sign-in only: `users`,
 *                         `sessions` and the staff master the departure check
 *                         reads. Nothing else, because this is the credential
 *                         that can see a password hash.
 *   DATABASE_URL_WORKER   the `ddms_worker` role. The scheduler, which syncs
 *                         every dealership and therefore cannot be scoped by a
 *                         session. The mirror and the graph; no people.
 *
 * This script creates each role and sets its password from whatever is in its
 * URL, so the URL stays the single place a credential is written down.
 *
 * Run it after every `db:push`. New tables arrive with RLS enabled and no
 * policies, so `ddms_app` cannot read them until they are named in `rls.sql` —
 * a DDMS screen going blank is a much better failure than a DDMS screen showing
 * every dealership's rows.
 *
 * Idempotent, and it finishes by proving the thing it claims: it reconnects as
 * each of the three roles with no session and checks that what they can reach
 * is what this file says they can reach — empty, denied or all tenants,
 * whichever that role is supposed to be.
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
  "dms_receivables",
  "dms_vehicle_stock",
  "entities",
  "entity_links",
  "decision_log",
  "record_events",
  "outbound_messages",
  "dealer_policy",
  "showrooms",
  "stock_moves",
  "money_documents",
  "service_invoices",
  "period_locks",
  "audit_events",
  "day_closes",
  "chassis_events",
  "legal_entities",
  "gst_registrations",
  "owners",
];

/** The three restricted roles, in the order they are created. */
const ROLES = [
  { env: "DATABASE_URL_APP", role: "ddms_app", job: "the request path" },
  { env: "DATABASE_URL_LOGIN", role: "ddms_login", job: "sign-in" },
  { env: "DATABASE_URL_WORKER", role: "ddms_worker", job: "the scheduler" },
] as const;

function restrictedConnection(envName: string, expected: string, job: string): {
  url: string;
  role: string;
  password: string;
} {
  const url = process.env[envName];
  if (!url) {
    throw new Error(
      `${envName} is not set. It is the connection string for the restricted ` +
        `\`${expected}\` role, which is what ${job} connects as — copy ` +
        `DATABASE_URL, change the user to \`${expected}\` (on Supabase's ` +
        `pooler: \`${expected}.<project-ref>\`) and pick a new password. This ` +
        `script creates the role with that password.`,
    );
  }

  const parsed = new URL(url);
  // Supabase's pooler encodes the project into the username as
  // `role.projectref`. The role itself is the part before the first dot, and
  // getting this wrong creates a role nothing can log in as.
  const role = decodeURIComponent(parsed.username).split(".")[0];
  const password = decodeURIComponent(parsed.password);

  if (!role || !password) {
    throw new Error(`${envName} must include both a username and a password.`);
  }
  if (role === "postgres") {
    throw new Error(
      `${envName} points at \`postgres\`, the table owner. That role bypasses ` +
        `RLS, so pointing ${job} at it would apply the policies and then ` +
        `ignore them.`,
    );
  }
  // Three roles doing three jobs is only true if they are three roles. Two
  // URLs naming the same one would silently collapse the split back into a
  // single credential holding the union of the grants.
  if (role !== expected) {
    throw new Error(
      `${envName} connects as \`${role}\`, but the policies in rls.sql name ` +
        `\`${expected}\`. A role with a different name gets no policies at all, ` +
        `so it would read nothing and the failure would look like a bug in the ` +
        `product.`,
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
  const { rows } = await pool().query<{ create_sql: string; alter_sql: string }>(
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

  const { rows: existing } = await pool().query(
    "select 1 from pg_roles where rolname = $1",
    [role],
  );

  if (existing.length === 0) {
    await pool().query(rows[0].create_sql);
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

  await pool().query(rows[0].alter_sql);
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
 * What each role must and must not be able to reach, asked of the database.
 *
 * Reading the policy file proves nothing — a policy with a typo in the owner
 * comparison still reads like a policy. Only a query proves it, and each of
 * these three roles has to be wrong in a different direction to be right:
 *
 *   `empty`  the table is readable but a query with no session returns nothing.
 *            That is the request path with nobody signed in.
 *   `denied` the grant is absent, so the query errors. Stronger than empty, and
 *            it is what stops `ddms_app` reading a token hash and inventing a
 *            session.
 *   `any`    rows are expected. Only the two roles that run with nobody signed
 *            in have this, and only for the tables their job is defined over —
 *            which is why the list is written out rather than implied.
 */
type Expectation = "empty" | "denied" | "any";

const EXPECTATIONS: Record<string, Record<string, Expectation>> = {
  ddms_app: {
    ...Object.fromEntries(SCOPED_TABLES.map((t) => [t, "empty" as const])),
    users: "denied",
    sessions: "denied",
  },
  ddms_login: {
    // Its whole job, and the reason nothing else on this row is readable.
    users: "any",
    sessions: "any",
    dms_employees: "any",
    applications: "denied",
    dms_deals: "denied",
    dms_receivables: "denied",
    decision_log: "denied",
    outbound_messages: "denied",
  },
  ddms_worker: {
    // Cross-tenant by definition: syncing on a timer is not scoped by a
    // session, and pretending otherwise would just mean lying in a comment.
    dms_deals: "any",
    dms_employees: "any",
    showrooms: "any",
    // Readable, and it was not meant to be. A deal's derived state is a
    // statement about the insurance record — AHEAD, BEHIND, IN_SYNC compare
    // the DMS's policy number with ours — so the detector cannot rebuild the
    // projection without it. Select only; the grants have no insert or update.
    applications: "any",
    // Since OBJ-16 the rules run here, and rules draft. What may actually
    // leave is still `authoriseSend()`'s decision and not this role's.
    outbound_messages: "any",
    decision_log: "any",
    users: "denied",
    sessions: "denied",
  },
};

async function check(url: string, role: string): Promise<boolean> {
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

    console.log("  with no session set:\n");
    for (const [table, want] of Object.entries(EXPECTATIONS[role] ?? {})) {
      let got: Expectation;
      let detail: string;
      try {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from public.${table}`,
        );
        got = rows[0].n === 0 ? "empty" : "any";
        detail = `${rows[0].n} rows`;
      } catch (err) {
        if ((err as { code?: string }).code !== "42501") throw err;
        got = "denied";
        detail = "permission denied";
      }

      // `any` is satisfied by rows; an empty table would mean nothing has been
      // synced yet rather than that the grant is missing, so it is not a
      // failure — but say so, because it makes the check weaker than it looks.
      const pass = got === want || (want === "any" && got === "empty");
      const note = want === "any" && got === "empty" ? "— nothing synced yet, unproven" : "";
      console.log(
        `    ${table.padEnd(20)} ${detail.padEnd(18)} ${pass ? "✓" : `✗ EXPECTED ${want}`} ${note}`,
      );
      if (!pass) ok = false;
    }
  } finally {
    await client.end();
  }

  return ok;
}

async function main(): Promise<void> {
  // Resolve all three before creating any. A missing variable should stop this
  // at the first line rather than half way through, leaving one role created
  // and the grants that mention the other two unapplied.
  const connections = ROLES.map((r) => ({
    ...r,
    ...restrictedConnection(r.env, r.role, r.job),
  }));

  console.log("Applying row-level security\n");
  for (const c of connections) await createRole(c.role, c.password, c.url);

  // Every role has to exist before the file runs: it grants to all three, and
  // a grant naming a role that is not there fails the whole statement.
  await pool().query(readFileSync(SQL_PATH, "utf8"));

  const { rows: policies } = await pool().query<{ tablename: string; policyname: string }>(
    "select tablename, policyname from pg_policies where schemaname = 'public' order by tablename",
  );
  console.log(`  policies ${String(policies.length).padEnd(16)} applied`);
  for (const p of policies) console.log(`             ${p.tablename.padEnd(24)} ${p.policyname}`);

  let ok = true;
  for (const c of connections) {
    if (!(await check(c.url, c.role))) ok = false;
  }

  if (!ok) {
    console.error("\nRLS is NOT closed. Do not point the server at these roles yet.");
    process.exit(1);
  }
  console.log(
    "\nClosed. `ddms_app` reads nothing until a request supplies a session token,\n" +
      "`ddms_login` sees people and nothing else, and `ddms_worker` sees the mirror\n" +
      "and no people. None of the three can bypass a policy.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Applying RLS failed:", err);
    process.exit(1);
  });
