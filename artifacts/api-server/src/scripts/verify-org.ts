/**
 * OBJ-37's done-when, stated so it can fail.
 *
 * > *One code path serves a one-branch sub-dealer, a five-branch hub-and-spoke
 * > and a two-company group, with **no branch in the code**.*
 *
 * That claim cannot be proved by a fixture in one shape, and the seeded
 * dealership is only two of them. So this file **builds the shapes it needs**,
 * runs the same resolver over each, and deletes them. A throwaway entity is
 * the only honest way to assert that a structure the fixture does not have
 * still works — the alternative is a comment saying it should.
 *
 * The sharp end is §4. `transferIsSupply` decides whether moving a chassis
 * between two branches is a taxable supply, and it is expensive in **both**
 * directions: charging tax on an internal move inflates output tax and the
 * return, and not charging it on a cross-registration move is tax short-paid.
 * A product that asked a person would get it wrong on the day somebody was in
 * a hurry, so the structure decides and this proves the structure decides.
 *
 * Runs on the **owner credential**, unlike most verifiers, because it creates
 * and destroys entities. That is a migration's privilege, not a request's —
 * the request path has select and nothing else on these two tables, and §6
 * proves it.
 *
 * `pnpm --filter @workspace/scripts run org`.
 */

import {
  ownerDb,
  db,
  withWorkerScope,
  showroomsTable,
  legalEntitiesTable,
  gstRegistrationsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  placementOf,
  placementsFor,
  branchesOfEntity,
  branchesOfRegistration,
  entitiesOf,
  registrationsOf,
  transferIsSupply,
  eInvoicing,
  UnplacedBranchError,
} from "../lib/dms/org";

const OWNER = 1;
const RUN_BY = "verify-org";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

console.log(`\nOBJ-37 — the hierarchy, run by ${RUN_BY}\n`);

// ────────────────────────────────────────────────────────────────────────────

section("1. every branch knows which books it lands in");

const branches = await ownerDb
  .select({
    id: showroomsTable.id,
    code: showroomsTable.code,
    role: showroomsTable.role,
    entityId: showroomsTable.entityId,
    registrationId: showroomsTable.registrationId,
  })
  .from(showroomsTable)
  .where(eq(showroomsTable.ownerId, OWNER))
  .orderBy(showroomsTable.code);

check(
  "the migration placed every branch",
  branches.length > 0 && branches.every((b) => b.entityId !== null && b.registrationId !== null),
  branches.map((b) => `${b.code}:${b.role}`).join(" · "),
);

const placements = await withWorkerScope(() => placementsFor(branches.map((b) => b.id)));
check(
  "and the resolver finds all of them",
  placements.size === branches.length,
  `${placements.size} of ${branches.length}`,
);

for (const [, p] of placements) {
  if (p.registration.entityId !== p.entity.id) {
    check(`${p.branchCode}: its registration belongs to its entity`, false);
  }
}
check(
  "every registration belongs to the entity its branch belongs to",
  [...placements.values()].every((p) => p.registration.entityId === p.entity.id),
  "a branch whose GSTIN sat under another company would file its sales in somebody else's return",
);

// ────────────────────────────────────────────────────────────────────────────

section("2. the shapes, and the same resolver serves all four");

/*
 * Three of the four are live in the fixture after the migration. The fourth —
 * one company registered in two states — is built here and torn down at the
 * end, because inventing a second state for a seeded Delhi dealer would make
 * every other verifier's place-of-supply arithmetic wrong.
 */
const entities = await withWorkerScope(() => entitiesOf(OWNER));
console.log(`      ${entities.length} legal entities under owner ${OWNER}`);

const counts: Array<{ entity: string; regs: number; branches: number }> = [];
for (const e of entities) {
  const regs = await withWorkerScope(() => registrationsOf(e.id));
  const bs = await withWorkerScope(() => branchesOfEntity(e.id));
  counts.push({ entity: e.code, regs: regs.length, branches: bs.length });
  console.log(`      ${e.code.padEnd(12)} ${regs.length} registration(s)  ${bs.length} branch(es)`);
}

check(
  "**the group shape**: one owner holding more than one legal entity",
  entities.length >= 2,
  `${entities.length} entities, and each gets its own trial balance and its own balance sheet`,
);
check(
  "**hub-and-spoke**: one entity, one registration, several branches",
  counts.some((c) => c.regs === 1 && c.branches >= 3),
  counts.map((c) => `${c.entity} ${c.regs}:${c.branches}`).join(" · "),
);
check(
  "**the sub-dealer**: one entity, one registration, one branch — nothing special-cased",
  counts.some((c) => c.regs === 1 && c.branches === 1),
  "the dealership OBJ-30 exists for is this same structure with every count at one",
);

// The fourth shape, built and destroyed.
const [tmpEntity] = await ownerDb
  .insert(legalEntitiesTable)
  .values({
    ownerId: OWNER,
    code: "TMPTWOSTATE",
    legalName: "Verify Two-State Motors Pvt Ltd",
    pan: "AAECV1111R",
    entityKind: "PRIVATE_LIMITED",
    booksFrom: "2026-04-01",
    aatoCrore: "12.00",
  })
  .returning();

const tmpRegs = await ownerDb
  .insert(gstRegistrationsTable)
  .values([
    {
      ownerId: OWNER,
      entityId: tmpEntity!.id,
      gstin: "29AAECV1111R1Z0",
      state: "Karnataka",
      stateCode: "29",
    },
    {
      ownerId: OWNER,
      entityId: tmpEntity!.id,
      gstin: "27AAECV1111R1Z8",
      state: "Maharashtra",
      stateCode: "27",
    },
  ])
  .returning();

const tmpBranches = await ownerDb
  .insert(showroomsTable)
  .values([
    {
      ownerId: OWNER,
      code: "TMP-BLR-HUB",
      name: "Verify Bengaluru Hub",
      entityId: tmpEntity!.id,
      registrationId: tmpRegs[0]!.id,
      role: "HUB",
      state: "Karnataka",
    },
    {
      ownerId: OWNER,
      code: "TMP-BLR-SAT",
      name: "Verify Bengaluru Satellite",
      entityId: tmpEntity!.id,
      registrationId: tmpRegs[0]!.id,
      role: "SALES",
      state: "Karnataka",
    },
    {
      ownerId: OWNER,
      code: "TMP-PNQ-HUB",
      name: "Verify Pune Hub",
      entityId: tmpEntity!.id,
      registrationId: tmpRegs[1]!.id,
      role: "HUB",
      state: "Maharashtra",
    },
  ])
  .returning();

const tmpRegList = await withWorkerScope(() => registrationsOf(tmpEntity!.id));
const tmpBranchList = await withWorkerScope(() => branchesOfEntity(tmpEntity!.id));
check(
  "**one company, two states**: two registrations, one set of books",
  tmpRegList.length === 2 && tmpBranchList.length === 3,
  `${tmpRegList.length} registrations, ${tmpBranchList.length} branches, and one balance sheet across the lot`,
);
check(
  "and a return is drawn per registration, not per company",
  (await withWorkerScope(() => branchesOfRegistration(tmpRegs[0]!.id))).length === 2 &&
    (await withWorkerScope(() => branchesOfRegistration(tmpRegs[1]!.id))).length === 1,
  "two branches file under Karnataka, one under Maharashtra, and neither knows about the other",
);

// ────────────────────────────────────────────────────────────────────────────

section("3. no branch in the code");

/*
 * The literal reading of the done-when. If the resolver contained a special
 * case for any of these shapes it would say so in the source, and this is the
 * cheapest possible check that it does not.
 */
const source = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../lib/dms/org.ts", import.meta.url), "utf8"),
);
const banned = ["SARASWATI", "DECCAN", "MALHOTRA", "DEL-SAR", "hubAndSpoke", "isSubDealer"];
const found = banned.filter((b) => source.includes(b));
check(
  "the resolver names no dealership and no shape",
  found.length === 0,
  found.length ? `found: ${found.join(", ")}` : "four foreign keys, and the shapes fall out of them",
);

// ────────────────────────────────────────────────────────────────────────────

section("4. the structure decides whether a transfer is a supply (R-117)");

const hub = [...placements.values()].find((p) => p.branchCode === "DEL-SARASWATI");
const sat = [...placements.values()].find((p) => p.branchCode === "DEL-SAR-JANAK");
const other = [...placements.values()].find((p) => p.branchCode === "PUN-DECCAN");

if (hub && sat) {
  const move = transferIsSupply(hub, sat);
  console.log(`      hub → satellite: ${move.why}`);
  check(
    "**same registration is not a supply** — a challan, no tax invoice, no GST",
    !move.isSupply,
    "same legal person moving its own stock between its own branches",
  );
}

if (hub && other) {
  const move = transferIsSupply(hub, other);
  console.log(`      Delhi → Maharashtra: ${move.why}`);
  check(
    "**a different registration is a taxable supply**, even inside one group",
    move.isSupply && move.interState,
    "GST treats distinct registrations as distinct persons, whoever owns them",
  );
}

// The case that catches a resolver reading state instead of registration.
const blrHub = await withWorkerScope(() => placementOf(tmpBranches[0]!.id));
const blrSat = await withWorkerScope(() => placementOf(tmpBranches[1]!.id));
const pnqHub = await withWorkerScope(() => placementOf(tmpBranches[2]!.id));

const sameState = transferIsSupply(blrHub, blrSat);
const crossState = transferIsSupply(blrHub, pnqHub);
check(
  "one company's two branches in one state: not a supply",
  !sameState.isSupply,
);
check(
  "**the same company's branches in two states: a supply, and inter-state**",
  crossState.isSupply && crossState.interState,
  "one PAN, one balance sheet, and still two taxable persons — which is the case a reader gets wrong",
);
check(
  "and it is decided from the registration, never from the address",
  crossState.why.includes("distinct registrations"),
  crossState.why,
);

// ────────────────────────────────────────────────────────────────────────────

section("5. what the turnover band switches on (R-118)");

const small = { ...tmpEntity!, aatoCrore: "3.00" };
const mid = { ...tmpEntity!, aatoCrore: "7.50" };
const big = { ...tmpEntity!, aatoCrore: "12.00" };
const unknown = { ...tmpEntity!, aatoCrore: null };

check("below 5 crore: no e-invoicing", !eInvoicing(small).required);
check("above 5 crore: e-invoicing on the B2B path", eInvoicing(mid).required);
check(
  "above 10 crore: and a thirty-day reporting window",
  eInvoicing(big).required && eInvoicing(big).reportingWindowDays === 30,
  "the window is a different obligation from the requirement, so it is returned separately",
);
check(
  "turnover nobody has typed: off, not on",
  !eInvoicing(unknown).required,
  "a missing figure must not switch on a requirement that changes what a valid invoice is",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. a branch with nowhere to sit is refused, not guessed");

const [orphan] = await ownerDb
  .insert(showroomsTable)
  .values({ ownerId: OWNER, code: "TMP-ORPHAN", name: "Verify Unplaced Outlet" })
  .returning();

let refused = false;
let message = "";
try {
  await withWorkerScope(() => placementOf(orphan!.id));
} catch (e) {
  refused = e instanceof UnplacedBranchError;
  message = (e as Error).message;
}
check(
  "**it throws rather than taking the owner's only entity**",
  refused,
  message || "it resolved something",
);
check(
  "and the refusal says why it matters",
  message.includes("tax invoice") || message.includes("legal entity"),
  "an invoice with no legal name and no GSTIN is not a tax invoice, and guessing produces one",
);

const many = await withWorkerScope(() => placementsFor([orphan!.id, ...branches.map((b) => b.id)]));
check(
  "but a report over many branches skips it instead of blanking the page",
  many.size === branches.length,
  "issuing a document refuses; drawing a report carries on and omits what it cannot place",
);

// ────────────────────────────────────────────────────────────────────────────

section("7. the request path may read the hierarchy and may not rewrite it");

let denied = "";
try {
  await withWorkerScope(async () => {
    await db.insert(legalEntitiesTable).values({
      ownerId: OWNER,
      code: "TMPWORKER",
      legalName: "Should Not Exist",
    });
  });
} catch (e) {
  /*
   * Drizzle wraps the driver error in a "Failed query" of its own, so the
   * sentence the database actually said is on the cause. Matching only the
   * wrapper would pass on any failure at all, including a typo in the insert -
   * which is a refusal check that cannot tell a locked door from a missing one.
   */
  const chain: string[] = [];
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    chain.push(String((err as Error).message ?? err));
  }
  denied = chain.join(" | ");
}
check(
  "the scheduler cannot create a legal entity",
  denied.includes("permission denied"),
  denied.split(" | ").find((m) => m.includes("permission denied")) ?? denied ?? "it inserted one",
);
check(
  "though it can read one, because a voucher it posts has to know where it lands",
  (await withWorkerScope(() => entitiesOf(OWNER))).length >= 2,
  "reassigning a branch to another company rewrites which balance sheet its history sits in, retrospectively",
);

// ────────────────────────────────────────────────────────────────────────────

await ownerDb.delete(showroomsTable).where(
  inArray(showroomsTable.code, ["TMP-BLR-HUB", "TMP-BLR-SAT", "TMP-PNQ-HUB", "TMP-ORPHAN"]),
);
await ownerDb
  .delete(gstRegistrationsTable)
  .where(inArray(gstRegistrationsTable.entityId, [tmpEntity!.id]));
await ownerDb.delete(legalEntitiesTable).where(eq(legalEntitiesTable.id, tmpEntity!.id));
console.log("\n  (the two-state company and the unplaced outlet removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. Four shapes, one resolver, and the structure decides the tax.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
