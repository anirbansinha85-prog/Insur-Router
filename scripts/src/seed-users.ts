/**
 * Seed sign-in accounts, and a second owner group to prove isolation against.
 *
 *   pnpm run db:seed-users
 *
 * The second group exists for one reason: "each owner sees only their own data"
 * is not a claim you can check with one tenant in the database. Every isolation
 * test needs somebody to be isolated *from*.
 *
 * Passwords here are deliberately obvious. They guard invented data on
 * localhost, and a memorable one is better than a strong one nobody can type
 * during a demonstration. Anything reachable from outside needs different
 * accounts, which is why nothing here is created unless it is missing.
 */

import { eq } from "drizzle-orm";
import { db, hashPassword, ownersTable, showroomsTable, usersTable } from "@workspace/db";

const SECOND_OWNER = {
  code: "MALHOTRA",
  name: "Malhotra Motors",
  legalName: "Malhotra Motors Pvt Ltd",
  contactName: "Proprietor",
  contactEmail: "owner@malhotramotors.example",
  contactPhone: "9820000000",
};

const SECOND_SHOWROOM = {
  code: "MUM-MALHOTRA",
  name: "Malhotra Motors Andheri",
  legalName: "Malhotra Motors Pvt Ltd",
  gstin: "27AAECM4411R1Z2",
  addressLine: "Unit 3, Andheri Kurla Road",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "400059",
};

const USERS = [
  { email: "anirban@saraswatiauto.example", name: "Anirban Sinha", ownerCode: "SARDECC", password: "saraswati" },
  { email: "owner@malhotramotors.example", name: "R Malhotra", ownerCode: "MALHOTRA", password: "malhotra" },
];

/**
 * The dealership's own staff, with their own logins.
 *
 * Each is linked to the employee code the DMS already carries, which is the
 * same code sitting on the enquiries, registration files and job cards assigned
 * to them. That join is what makes *my work* mean anything.
 *
 * Imtiaz Khan is here on purpose, and he left on 28-02-2026. His account is
 * created exactly like the others and is perfectly valid; the dealership's own
 * system is what closes it. That is the whole of R-62 in one row — and it is
 * the only way to demonstrate a revocation that comes from the mirror rather
 * than from us remembering.
 */
const STAFF = [
  { email: "jaswinder.sethi@saraswatiauto.example", name: "Jaswinder Sethi", password: "sethi", role: "RTO_AGENT", empCode: "RT-0417-02", showroomCode: "DEL-SARASWATI" },
  { email: "sunil.rawat@saraswatiauto.example", name: "Sunil Rawat", password: "rawat", role: "SERVICE_ADVISOR", empCode: "AD-0417-04", showroomCode: "DEL-SARASWATI" },
  { email: "meera.joshi@saraswatiauto.example", name: "Meera Joshi", password: "joshi", role: "ACCOUNTS", empCode: "AC-0417-06", showroomCode: "DEL-SARASWATI" },
  { email: "vikram.chandel@saraswatiauto.example", name: "Vikram Chandel", password: "chandel", role: "SALES_EXEC", empCode: "SA-0417-19", showroomCode: "DEL-SARASWATI" },
  { email: "imtiaz.khan@saraswatiauto.example", name: "Imtiaz Khan", password: "khan", role: "SALES_EXEC", empCode: "SA-0417-21", showroomCode: "DEL-SARASWATI" },
] as const;

async function ownerIdFor(code: string): Promise<number> {
  const [row] = await db.select({ id: ownersTable.id }).from(ownersTable).where(eq(ownersTable.code, code));
  if (!row) throw new Error(`owner ${code} missing — run db:seed-owners first`);
  return row.id;
}

async function main(): Promise<void> {
  await db.insert(ownersTable).values(SECOND_OWNER).onConflictDoNothing({ target: ownersTable.code });
  const secondOwnerId = await ownerIdFor(SECOND_OWNER.code);

  await db
    .insert(showroomsTable)
    .values({ ...SECOND_SHOWROOM, ownerId: secondOwnerId })
    .onConflictDoNothing();

  console.log(`  owner    ${SECOND_OWNER.code.padEnd(16)} ${SECOND_OWNER.name}  (id ${secondOwnerId})`);
  console.log(`  showroom ${SECOND_SHOWROOM.code.padEnd(16)} ${SECOND_SHOWROOM.name}`);
  console.log("");

  for (const u of USERS) {
    const ownerId = await ownerIdFor(u.ownerCode);
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, u.email));

    if (existing) {
      console.log(`  user     ${u.email.padEnd(36)} already exists, left alone`);
      continue;
    }

    await db.insert(usersTable).values({
      ownerId,
      email: u.email,
      name: u.name,
      passwordHash: await hashPassword(u.password),
      role: "OWNER",
    });
    console.log(`  user     ${u.email.padEnd(36)} password: ${u.password}`);
  }

  // The dealership's staff. Owner-scoped like everybody else, then narrowed by
  // outlet and by role — three predicates, each of which can only take away.
  const saraswatiOwnerId = await ownerIdFor("SARDECC");
  for (const s of STAFF) {
    const [showroom] = await db
      .select({ id: showroomsTable.id })
      .from(showroomsTable)
      .where(eq(showroomsTable.code, s.showroomCode));
    if (!showroom) {
      console.log(`  staff    ${s.email.padEnd(36)} no showroom ${s.showroomCode}, skipped`);
      continue;
    }

    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, s.email));
    if (existing) {
      console.log(`  staff    ${s.email.padEnd(36)} already exists, left alone`);
      continue;
    }

    await db.insert(usersTable).values({
      ownerId: saraswatiOwnerId,
      email: s.email,
      name: s.name,
      passwordHash: await hashPassword(s.password),
      role: s.role,
      empCode: s.empCode,
      showroomId: showroom.id,
    });
    console.log(
      `  staff    ${s.email.padEnd(36)} ${s.role.padEnd(16)} ${s.empCode}  password: ${s.password}`,
    );
  }

  console.log("\nTwo owners now exist. Neither should be able to see the other's showrooms.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
