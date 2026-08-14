/**
 * Saraswati becomes a network rather than a shop (Phase 1).
 *
 * Today every deal, every machine and every job card sits at one address in
 * Naraina, with two empty branches beside it. That is not how a dealership of
 * this size operates, and it is not the shape the Finance module was designed
 * against — one main branch holding the stockyard, the parts warehouse and the
 * accounts team; small showrooms around the city selling; standalone workshops
 * servicing; one premium outlet for the big bikes.
 *
 * ## What this does and, more importantly, does not
 *
 * It **adds two branches** to the entity and registration that already exist.
 * That is all. Nothing is renamed, nothing is re-keyed to another state,
 * nothing is deleted, and the hub keeps its DMS account and all its data.
 *
 * The state stays **Delhi**. Which state a dealership is in changes nothing
 * about how hub-and-spoke works — it changes a two-digit code on a GSTIN and
 * the place of supply — and moving it would mean rewriting the 78 sale
 * documents that carry Delhi stamped on their face. Those documents record what
 * was actually charged and are deliberately never re-derived.
 *
 * ## Why these two
 *
 * **Dwarka** is a second satellite, and the second one is the one that matters:
 * with a single destination, "allocate stock to the satellites" is just a
 * transfer. With two it becomes a decision, which is the thing worth watching.
 *
 * **Aerocity** is the premium outlet. It is the only branch where a sale
 * crosses ten lakh rupees, so it is the only place TCS under 206C(1F) and the
 * B2B e-invoicing gate ever fire. A fixture without one leaves two statutory
 * paths built and never exercised by real data.
 *
 * Idempotent. `pnpm run db:seed-network`.
 */

import { ownerDb, showroomsTable, legalEntitiesTable, gstRegistrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

/** The company these hang off. Both already exist; neither is created here. */
const PARENT_CODE = "DEL-SARASWATI";

const NEW_BRANCHES = [
  {
    code: "DEL-SAR-DWK",
    name: "Saraswati Dwarka",
    role: "SALES" as const,
    addressLine: "Plot 8, Sector 12 Market, Dwarka",
    city: "New Delhi",
    state: "Delhi",
    pincode: "110078",
    why: "a second satellite, so allocating stock becomes a decision rather than a transfer",
  },
  {
    code: "DEL-SAR-BW",
    name: "Saraswati Premium, Aerocity",
    role: "PREMIUM" as const,
    addressLine: "Ground Floor, Worldmark 2, Aerocity",
    city: "New Delhi",
    state: "Delhi",
    pincode: "110037",
    why: "the only branch where a sale crosses ten lakh, so TCS and e-invoicing fire",
  },
];

async function main(): Promise<void> {
  const [parent] = await ownerDb
    .select()
    .from(showroomsTable)
    .where(eq(showroomsTable.code, PARENT_CODE))
    .limit(1);

  if (!parent) {
    console.log(`\n  ${PARENT_CODE} is missing. Run db:seed-owners and db:migrate-org first.\n`);
    return;
  }
  if (!parent.entityId || !parent.registrationId) {
    console.log(
      `\n  ${PARENT_CODE} has no legal entity or registration against it. Run db:migrate-org first —\n` +
        "  a branch with nowhere to sit cannot issue anything, and the resolver refuses rather than guessing.\n",
    );
    return;
  }

  const [entity] = await ownerDb
    .select()
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.id, parent.entityId));
  const [registration] = await ownerDb
    .select()
    .from(gstRegistrationsTable)
    .where(eq(gstRegistrationsTable.id, parent.registrationId));

  console.log(
    `\n  ${entity!.legalName}\n` +
      `  ${registration!.gstin} · ${registration!.state} · one registration, and these join it\n`,
  );

  for (const b of NEW_BRANCHES) {
    const [already] = await ownerDb
      .select({ id: showroomsTable.id })
      .from(showroomsTable)
      .where(and(eq(showroomsTable.ownerId, parent.ownerId), eq(showroomsTable.code, b.code)))
      .limit(1);

    if (already) {
      /*
       * Re-linked rather than skipped. A branch that exists but points at the
       * wrong entity is worse than one that does not exist: it resolves, so
       * nothing refuses, and its sales quietly land in another company's books.
       */
      await ownerDb
        .update(showroomsTable)
        .set({
          entityId: parent.entityId,
          registrationId: parent.registrationId,
          role: b.role,
        })
        .where(eq(showroomsTable.id, already.id));
      console.log(`    ${b.code.padEnd(15)} ${b.role.padEnd(8)} already there, re-linked`);
      continue;
    }

    await ownerDb.insert(showroomsTable).values({
      ownerId: parent.ownerId,
      code: b.code,
      name: b.name,
      // The same entity and the same registration as the hub. That is what makes
      // a transfer between them not a supply (R-117): one legal person, one
      // GSTIN, moving its own stock between its own branches.
      entityId: parent.entityId,
      registrationId: parent.registrationId,
      role: b.role,
      addressLine: b.addressLine,
      city: b.city,
      state: b.state,
      pincode: b.pincode,
    });
    console.log(`    ${b.code.padEnd(15)} ${b.role.padEnd(8)} ${b.name}`);
    console.log(`    ${"".padEnd(15)} ${"".padEnd(8)} ${b.why}`);
  }

  // ── what the network now looks like ──────────────────────────────────────
  const all = await ownerDb
    .select({
      code: showroomsTable.code,
      name: showroomsTable.name,
      role: showroomsTable.role,
      city: showroomsTable.city,
    })
    .from(showroomsTable)
    .where(eq(showroomsTable.entityId, parent.entityId))
    .orderBy(showroomsTable.code);

  console.log(`\n  ${entity!.legalName} — ${all.length} branches on ${registration!.gstin}\n`);
  for (const s of all) {
    console.log(`    ${s.role.padEnd(8)} ${s.code.padEnd(15)} ${s.name}`);
  }

  console.log(
    "\n  One company, one GSTIN, several branches. A machine moving between any two of\n" +
      "  these is a delivery challan and not a supply — no tax invoice, no GST, and not\n" +
      "  one voucher. Each branch is still a cost and profit centre in its own right.\n",
  );
}

await main();
process.exit(0);
