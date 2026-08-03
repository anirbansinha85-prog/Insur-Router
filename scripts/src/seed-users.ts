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

  console.log("\nTwo owners now exist. Neither should be able to see the other's showrooms.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
