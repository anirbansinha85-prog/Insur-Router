/**
 * Seed the owner tier — one owner group, two showrooms, two DMS accounts, and
 * the insurer panel hanging off each account.
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

import { eq, inArray } from "drizzle-orm";
import {
  db,
  insurerPanelEntriesTable,
  ownersTable,
  providersTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";

/**
 * The insurer panel per dealer code.
 *
 * These are the same figures the mock dealer portal has always shown, moved
 * into the real database so the API server and the portal describe one
 * arrangement instead of two. `route` is not here — it is the DMS account's
 * `insuranceChannel` above, and duplicating it would let the two disagree.
 *
 * The mock's copy is in artifacts/dms-mock/src/insurers.ts, which explains why
 * the two are not shared from one file. **Change both together.**
 *
 * Insurer names are real companies, which is normal: a dealer's panel really
 * does list these. The **OD rates, quotas and payouts are invented** — real
 * ones are confidential and vary by model and zone. They exist so quotes differ
 * plausibly, which is the point: third-party premium is identical everywhere by
 * law, so own damage is the only thing that moves.
 */
const PANEL: Record<
  string,
  Array<{
    code: string;
    integration: "API" | "PORTAL";
    odBaseRate: number;
    quotaPolicies: number;
    quotaConsumed: number;
    payoutRate: number;
    slaMinutes: number;
  }>
> = {
  // Five insurers through one broker platform — one integration, five reachable.
  "HMC-DL-0417": [
    { code: "BAJAJ", integration: "API", odBaseRate: 0.0192, quotaPolicies: 60, quotaConsumed: 41, payoutRate: 0.19, slaMinutes: 4 },
    { code: "HDFC", integration: "API", odBaseRate: 0.0205, quotaPolicies: 50, quotaConsumed: 47, payoutRate: 0.2, slaMinutes: 5 },
    // The broker platform fronts this one through a web screen only, so browser
    // automation is the sole route. This is the common case, not the exception.
    { code: "ICICI", integration: "PORTAL", odBaseRate: 0.0221, quotaPolicies: 40, quotaConsumed: 12, payoutRate: 0.175, slaMinutes: 9 },
    { code: "DIGIT", integration: "API", odBaseRate: 0.0178, quotaPolicies: 35, quotaConsumed: 8, payoutRate: 0.155, slaMinutes: 3 },
    // Fully consumed. Routing must exclude it, and the console should say why.
    { code: "TATAAIG", integration: "PORTAL", odBaseRate: 0.0247, quotaPolicies: 25, quotaConsumed: 25, payoutRate: 0.21, slaMinutes: 11 },
  ],
  // One insurer, held directly. No panel to compare against — which is exactly
  // why this dealer's screen looks different, and why routing is per tenant.
  "HMC-MH-1182": [
    { code: "BAJAJ", integration: "PORTAL", odBaseRate: 0.0198, quotaPolicies: 80, quotaConsumed: 33, payoutRate: 0.225, slaMinutes: 7 },
  ],
};

/** Which period the quota counters describe. Nothing rolls this over yet. */
const QUOTA_PERIOD = "2026-Q3";

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

/**
 * Attach the insurer panel to one DMS account.
 *
 * Runs after `db:seed`, because a panel entry points at a `providers` row. A
 * missing provider is reported rather than skipped silently — an insurer
 * quietly absent from a panel is a routing decision made by accident.
 */
async function seedPanel(dealerCode: string): Promise<void> {
  const wanted = PANEL[dealerCode];
  if (!wanted?.length) return;

  const [account] = await db
    .select({ id: showroomDmsAccountsTable.id })
    .from(showroomDmsAccountsTable)
    .where(eq(showroomDmsAccountsTable.dealerCode, dealerCode));

  if (!account) throw new Error(`DMS account ${dealerCode} missing after insert`);

  const codes = wanted.map((w) => w.code);
  const providers = await db
    .select({ id: providersTable.id, code: providersTable.code })
    .from(providersTable)
    .where(inArray(providersTable.code, codes));

  const byCode = new Map(providers.map((p) => [p.code, p.id]));
  const missing = codes.filter((c) => !byCode.has(c));
  if (missing.length > 0) {
    console.warn(
      `           ! no providers row for ${missing.join(", ")} — run \`pnpm run db:seed\` first. ` +
        `Those insurers will be absent from this panel.`,
    );
  }

  for (const entry of wanted) {
    const providerId = byCode.get(entry.code);
    if (providerId === undefined) continue;

    await db
      .insert(insurerPanelEntriesTable)
      .values({
        dmsAccountId: account.id,
        providerId,
        integration: entry.integration,
        odBaseRate: entry.odBaseRate,
        quotaPolicies: entry.quotaPolicies,
        quotaConsumed: entry.quotaConsumed,
        quotaPeriod: QUOTA_PERIOD,
        payoutRate: entry.payoutRate,
        slaMinutes: entry.slaMinutes,
      })
      .onConflictDoNothing({
        target: [
          insurerPanelEntriesTable.dmsAccountId,
          insurerPanelEntriesTable.providerId,
        ],
      });
  }

  const placed = wanted.filter((w) => byCode.has(w.code));
  console.log(
    `           panel: ${placed.map((p) => `${p.code} ${p.quotaConsumed}/${p.quotaPolicies}`).join(", ")}`,
  );
}

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

    await seedPanel(dms.dealerCode);
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
