/**
 * Ask the database what a given login may actually read.
 *
 *   pnpm run db:probe                       every user
 *   pnpm run db:probe sunil.rawat@…         one of them
 *
 * The route layer answers 403 with an explanation, which is the *legible* half
 * of OBJ-14. This is the true half: connect as `ddms_app`, set a session token
 * the way `sessionScope` does, and count rows. A menu item can be hidden; a
 * count of zero cannot be argued with.
 *
 * It mints its own short-lived session rather than borrowing one from a
 * browser, so it is re-runnable and needs nothing else running — the same
 * property that makes `db:rls` worth having: a check that runs beats a claim in
 * a document. The sessions it creates expire in a minute and are deleted on the
 * way out.
 */

import { createHash, randomBytes } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import pg from "pg";
import { ownerDb, sessionsTable, usersTable } from "@workspace/db";

const TABLES = [
  "dms_deals",
  "dms_enquiries",
  "dms_job_cards",
  "dms_part_stock",
  "dms_registrations",
  "dms_receivables",
  "dms_vehicle_stock",
];

const url = process.env["DATABASE_URL_APP"];
if (!url) {
  throw new Error(
    "DATABASE_URL_APP is not set. It is the connection string for the " +
      "restricted `ddms_app` role — the whole point of this script is to ask " +
      "the database as that role rather than as the table owner.",
  );
}

const only = process.argv[2];
const users = await ownerDb
  .select({
    id: usersTable.id,
    email: usersTable.email,
    role: usersTable.role,
    empCode: usersTable.empCode,
  })
  .from(usersTable)
  .where(only ? eq(usersTable.email, only) : undefined)
  .orderBy(asc(usersTable.id));

if (users.length === 0) {
  console.log(only ? `No user ${only}` : "No users. Run db:seed-users first.");
  process.exit(1);
}

const minted: number[] = [];
const client = new pg.Client({ connectionString: url });
await client.connect();

console.log("\nWhat each login can read, asked of the database as `ddms_app`:\n");
console.log(
  `  ${"login".padEnd(38)} ${"role".padEnd(16)} outlets  ` +
    TABLES.map((t) => t.replace("dms_", "").slice(0, 8).padStart(8)).join(" "),
);

try {
  for (const user of users) {
    const token = randomBytes(32).toString("hex");
    const [row] = await ownerDb
      .insert(sessionsTable)
      .values({
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: sessionsTable.id });
    minted.push(row!.id);

    await client.query("select set_config('app.session_token', $1, false)", [
      createHash("sha256").update(token).digest("hex"),
    ]);

    const who = await client.query<{ role: string | null; outlets: string | null }>(
      "select app.current_role() as role, " +
        "(select string_agg(id::text, ',' order by id) from app.visible_showroom_ids() as id) as outlets",
    );

    const counts: string[] = [];
    for (const table of TABLES) {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from public.${table}`,
      );
      counts.push(String(rows[0]!.n).padStart(8));
    }

    console.log(
      `  ${user.email.padEnd(38)} ${(who.rows[0]?.role ?? "-").padEnd(16)} ` +
        `${(who.rows[0]?.outlets ?? "-").padEnd(7)} ${counts.join(" ")}`,
    );
  }
} finally {
  // Leaving live sessions behind would make a diagnostic tool a way in.
  if (minted.length > 0) {
    await ownerDb.delete(sessionsTable).where(inArray(sessionsTable.id, minted));
  }
  await client.end();
}

console.log(
  "\nA zero is the database refusing, not an empty dealership. The role gate in\n" +
    "the routes explains it; these numbers are what makes it true.\n",
);
process.exit(0);
