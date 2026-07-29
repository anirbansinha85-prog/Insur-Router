/**
 * Seed the `providers` table with a starter set of Indian two-wheeler insurers.
 *
 *   pnpm run seed
 *
 * Idempotent: `code` is unique and conflicting rows are skipped, so re-running
 * never duplicates or overwrites. Safe against a database you have since edited.
 *
 * ── About this data ────────────────────────────────────────────────────────
 * The original Replit database was seeded directly, not by a script, so the
 * exact rows did not survive the export and are unrecoverable. The company
 * names below are real insurers; the API endpoints and portal URLs are
 * PLACEHOLDERS and are never actually contacted — both executors
 * (api-executor.ts / browser-executor.ts) fall through to their generic stubs
 * for every provider code. Replace a row's endpoint when you wire up its real
 * integration.
 *
 * The mix is deliberate, so all three routing paths are exercised:
 *   - apiEndpoint set + mode API or AUTO  → resolves to API
 *   - apiEndpoint null                    → resolves to BROWSER
 *   - defaultExecutionMode BROWSER        → forces BROWSER even with an endpoint
 */

import { db, providersTable } from "@workspace/db";

const PROVIDERS: (typeof providersTable.$inferInsert)[] = [
  {
    name: "HDFC ERGO General Insurance",
    code: "HDFC",
    defaultExecutionMode: "API",
    apiEndpoint: "https://api.example-hdfcergo.invalid/v1",
    portalUrl: "https://portal.example-hdfcergo.invalid",
    logoColor: "#E4002B",
    isActive: true,
  },
  {
    name: "Bajaj Allianz General Insurance",
    code: "BAJAJ",
    defaultExecutionMode: "API",
    apiEndpoint: "https://api.example-bajajallianz.invalid/v1",
    portalUrl: "https://portal.example-bajajallianz.invalid",
    logoColor: "#0072CE",
    isActive: true,
  },
  {
    name: "ICICI Lombard General Insurance",
    code: "ICICI",
    defaultExecutionMode: "AUTO",
    apiEndpoint: "https://api.example-icicilombard.invalid/v1",
    portalUrl: "https://portal.example-icicilombard.invalid",
    logoColor: "#F37021",
    isActive: true,
  },
  {
    // AUTO + no endpoint → falls back to BROWSER
    name: "TATA AIG General Insurance",
    code: "TATAAIG",
    defaultExecutionMode: "AUTO",
    apiEndpoint: null,
    portalUrl: "https://portal.example-tataaig.invalid",
    logoColor: "#486AAE",
    isActive: true,
  },
  {
    // Has an endpoint, but BROWSER is pinned → AUTO still resolves to BROWSER
    name: "Reliance General Insurance",
    code: "RELIANCE",
    defaultExecutionMode: "BROWSER",
    apiEndpoint: "https://api.example-reliancegeneral.invalid/v1",
    portalUrl: "https://portal.example-reliancegeneral.invalid",
    logoColor: "#003E7E",
    isActive: true,
  },
  {
    name: "Go Digit General Insurance",
    code: "DIGIT",
    defaultExecutionMode: "AUTO",
    apiEndpoint: "https://api.example-godigit.invalid/v1",
    portalUrl: "https://portal.example-godigit.invalid",
    logoColor: "#00B5AD",
    isActive: true,
  },
];

async function main(): Promise<void> {
  const before = await db.select({ code: providersTable.code }).from(providersTable);
  const existing = new Set(before.map((r) => r.code));

  const inserted = await db
    .insert(providersTable)
    .values(PROVIDERS)
    .onConflictDoNothing({ target: providersTable.code })
    .returning({ code: providersTable.code, name: providersTable.name });

  for (const p of PROVIDERS) {
    const wasInserted = inserted.some((r) => r.code === p.code);
    const mark = wasInserted ? "added  " : existing.has(p.code) ? "skipped" : "?      ";
    console.log(`  ${mark}  ${p.code.padEnd(9)} ${p.name}`);
  }

  console.log(
    `\n${inserted.length} added, ${PROVIDERS.length - inserted.length} already present.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
