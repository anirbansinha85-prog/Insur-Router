/**
 * Move the dealership's identity off the branch and onto the entity (OBJ-37).
 *
 * `showrooms.legal_name` and `showrooms.gstin` sat on the outlet because the
 * first fixture was two separate companies. That is one of four shapes a
 * two-wheeler dealership takes and it is not the common one. The common one is
 * **one owner, one company, several branches, run hub-and-spoke from a main
 * location** — and under that shape a branch has no GSTIN of its own, invoices
 * under its entity's, and moving a chassis to a satellite is not a supply.
 *
 * So identity moves up:
 *
 * ```
 *   owner  ->  legal_entities  ->  gst_registrations  ->  showrooms (branches)
 * ```
 *
 * ## This derives, it does not invent
 *
 * One entity per distinct `(owner, legal_name, gstin)` already on a branch, and
 * one registration per distinct GSTIN. Nothing is guessed: a dealership that
 * had two companies still has two, and the trial balance that comes out of
 * OBJ-41 will be the one its CA expects. The two old columns are left in place
 * and read by nothing, so this run can be checked against what they said.
 *
 * ## And then it makes the ordinary shape real
 *
 * The existing fixture is three companies at one branch each, which exercises
 * the *group* shape and never the hub-and-spoke one. So this also adds two
 * branches under the Delhi entity — a satellite showroom and a service outlet,
 * both on the **same GSTIN** — because that is where inter-branch transfer,
 * branch P&L and the day close actually get tested. Without them the claim
 * "one code path serves a five-branch hub-and-spoke" has nothing behind it.
 *
 * Idempotent. `pnpm --filter @workspace/scripts run migrate-org`.
 */

import {
  ownerDb,
  showroomsTable,
  legalEntitiesTable,
  gstRegistrationsTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * A branch role is a real field rather than a label, because it changes what an
 * outlet can do. A PREMIUM outlet crosses the ten-lakh TCS threshold on an
 * ordinary sale; a SERVICE outlet issues labour invoices and sells no vehicles.
 */
const ROLE_BY_CODE: Record<string, "HUB" | "SALES" | "SERVICE" | "PREMIUM"> = {
  "DEL-SARASWATI": "HUB",
  "PUN-DECCAN": "HUB",
  "MUM-MALHOTRA": "HUB",
};

/**
 * The satellites, and they exist to make the hub-and-spoke shape testable.
 *
 * Both hang off whichever entity `DEL-SARASWATI` belongs to and therefore off
 * the same GSTIN, which is the entire point: a chassis moving from the hub to
 * `DEL-SAR-JANAK` is one legal person moving its own stock, so a delivery
 * challan and no tax. Neither has a DMS account, which is ordinary — a
 * satellite books and delivers against the hub's dealer code, and a service
 * outlet has no dealer code at all.
 */
const SATELLITES = [
  {
    parentCode: "DEL-SARASWATI",
    code: "DEL-SAR-JANAK",
    name: "Saraswati Janakpuri",
    role: "SALES" as const,
    addressLine: "B-3, District Centre, Janakpuri",
    city: "New Delhi",
    state: "Delhi",
    pincode: "110058",
  },
  {
    parentCode: "DEL-SARASWATI",
    code: "DEL-SAR-OKHLA",
    name: "Saraswati Service Okhla",
    role: "SERVICE" as const,
    addressLine: "Unit 7, Okhla Industrial Area Phase II",
    city: "New Delhi",
    state: "Delhi",
    pincode: "110020",
  },
];

/** The first two characters of a GSTIN are the state code, and always are. */
const stateCodeOf = (gstin: string): string | null =>
  /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null;

/**
 * PANs are characters 3 to 12 of the GSTIN, which is why two registrations
 * sharing a PAN are one legal person. Deriving it rather than asking is safe
 * here because the GSTIN is the authority on it.
 */
const panOf = (gstin: string): string | null =>
  gstin.length >= 12 ? gstin.slice(2, 12) : null;

async function main(): Promise<void> {
  const branches = await ownerDb.select().from(showroomsTable).orderBy(showroomsTable.id);
  if (branches.length === 0) {
    console.log("No showrooms. Run db:seed-owners first.");
    return;
  }

  console.log("\n  Entities and registrations, derived from what the branches already say\n");

  // ── one entity per distinct (owner, legal name), one registration per GSTIN ──
  const entityIdByKey = new Map<string, number>();
  const regIdByGstin = new Map<string, number>();

  for (const b of branches) {
    const legalName = b.legalName?.trim();
    const gstin = b.gstin?.trim();
    if (!legalName || !gstin) continue;

    const key = `${b.ownerId}::${legalName}`;
    if (!entityIdByKey.has(key)) {
      // A short handle derived from the branch code, so a reader can see which
      // outlet the entity came from without opening the migration.
      const code = (b.code.split("-")[1] ?? b.code).toUpperCase().slice(0, 12);
      const existing = await ownerDb
        .select({ id: legalEntitiesTable.id })
        .from(legalEntitiesTable)
        .where(
          and(eq(legalEntitiesTable.ownerId, b.ownerId), eq(legalEntitiesTable.code, code)),
        )
        .limit(1);

      let id = existing[0]?.id;
      if (!id) {
        const [row] = await ownerDb
          .insert(legalEntitiesTable)
          .values({
            ownerId: b.ownerId,
            code,
            legalName,
            tradeName: b.name,
            pan: panOf(gstin),
            entityKind: /pvt|private/i.test(legalName)
              ? "PRIVATE_LIMITED"
              : /llp/i.test(legalName)
                ? "LLP"
                : "PROPRIETOR",
            // The books start with the mirror, which is what OBJ-38 will hang
            // opening balances off. A voucher earlier than this is refused.
            booksFrom: "2026-04-01",
            // Enough to switch e-invoicing on for the B2B path (R-118), which is
            // where a multi-branch Honda dealer genuinely sits once service and
            // parts are counted. Below 5 crore this is a capability nothing uses.
            aatoCrore: "7.50",
          })
          .returning({ id: legalEntitiesTable.id });
        id = row!.id;
        console.log(`    entity   ${code.padEnd(12)} ${legalName}`);
      }
      entityIdByKey.set(key, id);
    }

    if (!regIdByGstin.has(gstin)) {
      const existing = await ownerDb
        .select({ id: gstRegistrationsTable.id })
        .from(gstRegistrationsTable)
        .where(eq(gstRegistrationsTable.gstin, gstin))
        .limit(1);

      let id = existing[0]?.id;
      if (!id) {
        const [row] = await ownerDb
          .insert(gstRegistrationsTable)
          .values({
            ownerId: b.ownerId,
            entityId: entityIdByKey.get(key)!,
            gstin,
            state: b.state ?? "",
            stateCode: stateCodeOf(gstin),
            scheme: "REGULAR",
            seriesScope: "REGISTRATION",
            // Answered by the dealership: the service centre bills through DDMS.
            serviceInvoicing: "Y",
          })
          .returning({ id: gstRegistrationsTable.id });
        id = row!.id;
        console.log(`    GSTIN    ${gstin}  ${b.state}`);
      }
      regIdByGstin.set(gstin, id);
    }

    await ownerDb
      .update(showroomsTable)
      .set({
        entityId: entityIdByKey.get(key)!,
        registrationId: regIdByGstin.get(gstin)!,
        role: ROLE_BY_CODE[b.code] ?? "SALES",
      })
      .where(eq(showroomsTable.id, b.id));
  }

  // ── the satellites, so hub-and-spoke is a thing that exists ──────────────
  console.log("\n  Satellites on the same registration, so a transfer has something to be\n");

  for (const sat of SATELLITES) {
    const [parent] = await ownerDb
      .select()
      .from(showroomsTable)
      .where(eq(showroomsTable.code, sat.parentCode))
      .limit(1);
    if (!parent) {
      console.log(`    ${sat.code.padEnd(16)} skipped — no ${sat.parentCode}`);
      continue;
    }

    const [already] = await ownerDb
      .select({ id: showroomsTable.id })
      .from(showroomsTable)
      .where(
        and(eq(showroomsTable.ownerId, parent.ownerId), eq(showroomsTable.code, sat.code)),
      )
      .limit(1);

    if (already) {
      await ownerDb
        .update(showroomsTable)
        .set({
          entityId: parent.entityId,
          registrationId: parent.registrationId,
          role: sat.role,
        })
        .where(eq(showroomsTable.id, already.id));
      console.log(`    ${sat.code.padEnd(16)} ${sat.role.padEnd(8)} already there, re-linked`);
      continue;
    }

    await ownerDb.insert(showroomsTable).values({
      ownerId: parent.ownerId,
      code: sat.code,
      name: sat.name,
      entityId: parent.entityId,
      registrationId: parent.registrationId,
      role: sat.role,
      addressLine: sat.addressLine,
      city: sat.city,
      state: sat.state,
      pincode: sat.pincode,
    });
    console.log(`    ${sat.code.padEnd(16)} ${sat.role.padEnd(8)} ${sat.name}`);
  }

  // ── what is left unplaced, said out loud ────────────────────────────────
  const unplaced = await ownerDb
    .select({ id: showroomsTable.id, code: showroomsTable.code })
    .from(showroomsTable)
    .where(isNull(showroomsTable.entityId));

  console.log("");
  if (unplaced.length === 0) {
    console.log("  Every branch belongs to a legal entity and invoices under a registration.");
  } else {
    console.log(
      `  ${unplaced.length} branch(es) still unplaced: ${unplaced.map((u) => u.code).join(", ")}.\n` +
        "  Nothing may be issued from an unplaced branch, and the resolver refuses rather\n" +
        "  than guessing — an invoice with no legal name and no GSTIN is not a tax invoice.",
    );
  }
  console.log("");
}

await main();
process.exit(0);
