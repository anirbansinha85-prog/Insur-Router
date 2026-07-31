/**
 * Seed the owner tier — one owner group, two showrooms, two DMS accounts.
 *
 *   pnpm run db:seed-owners
 *
 * Idempotent: every table is keyed and conflicting rows are skipped, so
 * re-running never duplicates. Safe against a database you have since edited.
 *
 * ── Why this shape ─────────────────────────────────────────────────────────
 * The two showrooms mirror the deals already seeded in `artifacts/dms-mock`, so
 * a DMS pull resolves to a real row rather than a dangling code. They are
 * deliberately *not* uniform, because a real owner group is not:
 *
 *   Saraswati   New Delhi     Pvt Ltd   reaches insurers through a BROKER
 *   Deccan      Pune          LLP       holds its own DIRECT_AGENT code
 *
 * Different states, different legal entities, different GST registrations,
 * different insurance channels — one owner. Any rollup that assumes uniformity
 * breaks on this pair, which is the point of seeding it this way.
 *
 * Both are Hero, which is also deliberate: a multi-outlet single-brand group is
 * the intended first customer, because it is one DMS integration serving
 * several showrooms. A mixed-brand group would need one adapter per brand on
 * day one.
 *
 * Names, GSTINs and codes are fictional.
 */

import { eq } from "drizzle-orm";
import {
  db,
  ownersTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";

const OWNER = {
  code: "SARDECC",
  name: "Saraswati–Deccan Group",
  // Null on purpose: the group is a common proprietor, not a registered
  // holding company. The legal entities are the showrooms themselves.
  legalName: null,
  contactName: "Proprietor",
  contactEmail: "owner@example.invalid",
  contactPhone: "9800000000",
} satisfies typeof ownersTable.$inferInsert;

const SHOWROOMS = [
  {
    code: "DEL-SARASWATI",
    name: "Saraswati Automobiles",
    legalName: "Saraswati Automobiles Pvt Ltd",
    gstin: "07AAACS1234A1Z5",
    addressLine: "Plot 14, Community Centre, Naraina",
    city: "New Delhi",
    state: "Delhi",
    pincode: "110028",
    dms: {
      oemCode: "HERO",
      dealerCode: "HMC-DL-0417",
      insuranceChannel: "BROKER" as const,
      intermediaryName: "Sundaram Motor Insurance Brokers Pvt Ltd",
      intermediaryCode: "IRDAI/DB/0417",
    },
  },
  {
    code: "PUN-DECCAN",
    name: "Deccan Two Wheelers",
    legalName: "Deccan Two Wheelers LLP",
    gstin: "27AACFD5678B1Z9",
    addressLine: "Survey 42, Nagar Road, Kharadi",
    city: "Pune",
    state: "Maharashtra",
    pincode: "411014",
    dms: {
      oemCode: "HERO",
      dealerCode: "HMC-MH-1182",
      insuranceChannel: "DIRECT_AGENT" as const,
      intermediaryName: "Deccan Two Wheelers LLP",
      intermediaryCode: "AGY-MH-1182",
    },
  },
];

async function main(): Promise<void> {
  // ── Owner ────────────────────────────────────────────────────────────────
  await db
    .insert(ownersTable)
    .values(OWNER)
    .onConflictDoNothing({ target: ownersTable.code });

  const [owner] = await db
    .select()
    .from(ownersTable)
    .where(eq(ownersTable.code, OWNER.code));

  if (!owner) throw new Error(`owner ${OWNER.code} missing after insert`);
  console.log(`  owner    ${owner.code.padEnd(16)} ${owner.name}  (id ${owner.id})`);

  // ── Showrooms and their DMS accounts ─────────────────────────────────────
  for (const s of SHOWROOMS) {
    const { dms, ...showroom } = s;

    await db
      .insert(showroomsTable)
      .values({ ...showroom, ownerId: owner.id })
      .onConflictDoNothing();

    const [row] = await db
      .select()
      .from(showroomsTable)
      .where(eq(showroomsTable.code, showroom.code));

    if (!row) throw new Error(`showroom ${showroom.code} missing after insert`);

    await db
      .insert(showroomDmsAccountsTable)
      .values({ ...dms, showroomId: row.id })
      .onConflictDoNothing({ target: showroomDmsAccountsTable.dealerCode });

    console.log(
      `  showroom ${row.code.padEnd(16)} ${row.name} — ${row.city}, ${row.state}` +
        `\n           ${dms.oemCode}/${dms.dealerCode}  ${dms.insuranceChannel}`,
    );
  }

  const showrooms = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, owner.id));

  console.log(`\n1 owner, ${showrooms.length} showrooms.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
