/**
 * OBJ-39's done-when, stated so it can fail.
 *
 * > *The structure decides the tax: same registration is no supply, different
 * > registration is a taxable one, and nothing asks a person.*
 *
 * The sharp edge here is that the ordinary case — hub to satellite, same GSTIN
 * — must post **nothing at all**. It is not a small tax, it is not a zero-rated
 * supply, it is not an entry with two zeroes in it. One legal person moving its
 * own stock between its own branches has bought nothing and sold nothing, and a
 * voucher would invent revenue and a debtor out of an internal errand.
 *
 * Getting it wrong the other way costs real money quietly: GST charged on
 * internal transfers inflates output tax, inflates the return, and hands the
 * government money the dealership does not owe, monthly, until somebody checks.
 *
 * §4 is the reason `IN_TRANSIT` is a state rather than a timestamp. A bike that
 * left the hub and arrived nowhere is the first reconciliation's whole subject
 * and can only be found if *left* and *arrived* are two separate facts.
 *
 * `pnpm --filter @workspace/scripts run moves`.
 */

import {
  db,
  ownerDb,
  withWorkerScope,
  stockMovesTable,
  stockMoveLinesTable,
  chassisEventsTable,
  vouchersTable,
  voucherLinesTable,
  dmsVehicleStockTable,
  showroomsTable,
  showroomDmsAccountsTable,
  legalEntitiesTable,
  gstRegistrationsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { placementOf } from "../lib/dms/org";
import {
  createStockMove,
  despatchStockMove,
  receiveStockMove,
  inTransit,
  chassisRegister,
  stockPositionCheck,
  EWAY_THRESHOLD,
} from "../lib/dms/ledger/moves";

const OWNER = 1;
const RUN_BY = "verify-moves";
const C1 = "VERIFY-MOVES-CHASSIS-1";
const C2 = "VERIFY-MOVES-CHASSIS-2";
const C3 = "VERIFY-MOVES-CHASSIS-3";
const ALL_CHASSIS = [C1, C2, C3];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}
const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const rupees = (x: number): string => `₹${x.toLocaleString("en-IN")}`;

console.log(`\nOBJ-39 — stock that moves without being sold, run by ${RUN_BY}\n`);

// ── clean this file's own leftovers, keyed on its own constants ────────────
{
  const stale = await ownerDb
    .select({ id: stockMovesTable.id, voucherId: stockMovesTable.voucherId })
    .from(stockMovesTable)
    .where(sql`${stockMovesTable.narration} like 'verify-moves%'`);
  for (const m of stale) {
    if (m.voucherId) {
      await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, m.voucherId));
      await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, m.voucherId));
    }
    await ownerDb.delete(stockMoveLinesTable).where(eq(stockMoveLinesTable.stockMoveId, m.id));
    await ownerDb.delete(stockMovesTable).where(eq(stockMovesTable.id, m.id));
  }
  await ownerDb.delete(chassisEventsTable).where(inArray(chassisEventsTable.chassisNo, ALL_CHASSIS));
  await ownerDb
    .delete(dmsVehicleStockTable)
    .where(inArray(dmsVehicleStockTable.chassisNo, ALL_CHASSIS));
  await ownerDb.delete(showroomsTable).where(eq(showroomsTable.code, "TMP-MOVES-KA"));
  await ownerDb
    .delete(gstRegistrationsTable)
    .where(eq(gstRegistrationsTable.gstin, "29AAACS1234A1Z1"));
}

const [hub] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SARASWATI")))
  .limit(1);
const [sat] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "DEL-SAR-JANAK")))
  .limit(1);
const [otherCompany] = await ownerDb
  .select()
  .from(showroomsTable)
  .where(and(eq(showroomsTable.ownerId, OWNER), eq(showroomsTable.code, "PUN-DECCAN")))
  .limit(1);
if (!hub || !sat || !otherCompany) throw new Error("Fixture missing. Run db:migrate-org.");

const hubP = await withWorkerScope(() => placementOf(hub.id));
const satP = await withWorkerScope(() => placementOf(sat.id));
console.log(
  `      ${hubP.branchName} (${hubP.role}) → ${satP.branchName} (${satP.role})\n` +
    `      both under ${hubP.entity.legalName}, both on ${hubP.registration.gstin}\n`,
);

const [dealer] = await ownerDb
  .select({ code: showroomDmsAccountsTable.dealerCode })
  .from(showroomDmsAccountsTable)
  .where(eq(showroomDmsAccountsTable.showroomId, hub.id))
  .limit(1);

const COST = 62_500;
for (const c of [C1, C2, C3]) {
  await ownerDb.insert(dmsVehicleStockTable).values({
    showroomId: hub.id,
    dealerCode: dealer?.code ?? "HMC-DL-0417",
    chassisNo: c,
    modelCode: "HER-SPL-PLUS",
    modelDescription: "Splendor Plus",
    status: "IN_STOCK",
    costAmount: String(COST),
    raw: { chassisNo: c, source: RUN_BY },
    rawHash: `${RUN_BY}-${c}`,
  });
  // On the owner credential, not the worker's: the scheduler has select and no
  // more on the register, which §7 proves and which this fixture must respect
  // rather than route around.
  await ownerDb.insert(chassisEventsTable).values({
    ownerId: OWNER,
    chassisNo: c,
    showroomId: hub.id,
    kind: "PURCHASED",
    eventDate: "2026-08-01",
    sourceKind: "MANUAL",
    sourceId: null,
    sourceRef: RUN_BY,
    value: String(COST),
    narration: "fixture",
  });
}

// ────────────────────────────────────────────────────────────────────────────

section("1. hub to satellite: a challan, and **no accounting entry at all**");

const voucherCountBefore = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(vouchersTable)
    .where(eq(vouchersTable.ownerId, OWNER))
)[0]!.c;

const move = await createStockMove({
  ownerId: OWNER,
  fromShowroomId: hub.id,
  toShowroomId: sat.id,
  challanDate: "2026-08-05",
  lines: [
    { chassisNo: C1, modelDescription: "Splendor Plus", hsn: "87112019", value: COST, gstRatePct: 18 },
  ],
  narration: "verify-moves: hub to satellite",
});
check("the challan raises", move.ok, move.ok ? move.move!.challanNo : move.error!);
if (!move.ok) throw new Error(move.error);

check(
  "**it is not a supply**, and the document says why",
  move.move!.isSupply === "N",
  move.move!.supplyReason ?? "",
);
check(
  "the challan number is a real series, not an id",
  /^DC\/\d{4}-\d{2}\/\d{4}$/.test(move.move!.challanNo),
  `${move.move!.challanNo} — a dealership stopped at a checkpoint with an unnumbered challan is a dealership explaining itself`,
);
check(
  "an e-way bill is required anyway, because that is about movement not supply",
  move.move!.ewayStatus === "REQUIRED" && n(move.move!.consignmentValue) > EWAY_THRESHOLD,
  `${rupees(n(move.move!.consignmentValue))} against a ${rupees(EWAY_THRESHOLD)} threshold`,
);
check(
  "and the warning says which part a CA should confirm rather than claiming it",
  move.warnings.some((w) => w.includes("confirm that against your state")),
  move.warnings.find((w) => w.includes("fifty kilometres")) ?? "",
);

const again = await createStockMove({
  ownerId: OWNER,
  fromShowroomId: hub.id,
  toShowroomId: sat.id,
  challanDate: "2026-08-05",
  lines: [{ chassisNo: C1, modelDescription: "Splendor Plus", value: COST }],
  narration: "verify-moves: duplicate",
});
check(
  "the same machine cannot go out on a second open challan",
  !again.ok && again.error!.includes("gone missing"),
  again.ok ? "it raised twice" : again.error!,
);

const despatched = await despatchStockMove({ ownerId: OWNER, stockMoveId: move.move!.id });
check("it despatches", despatched.ok, despatched.ok ? despatched.move!.status : despatched.error!);
check(
  "and warns that it is going without an e-way number recorded",
  despatched.warnings.some((w) => w.includes("roadside")),
  despatched.warnings[0] ?? "",
);

const [stillAtHub] = await ownerDb
  .select({ showroomId: dmsVehicleStockTable.showroomId })
  .from(dmsVehicleStockTable)
  .where(eq(dmsVehicleStockTable.chassisNo, C1));
check(
  "**despatch does not move the stock** — in transit is neither here nor there",
  stillAtHub!.showroomId === hub.id,
  "pretending it has arrived is how a missing bike looks present on the receiving branch's report for a week",
);

const received = await receiveStockMove({ ownerId: OWNER, stockMoveId: move.move!.id, userId: 1 });
check("it receives", received.ok, received.ok ? received.move!.status : received.error!);

const [nowAt] = await ownerDb
  .select({ showroomId: dmsVehicleStockTable.showroomId })
  .from(dmsVehicleStockTable)
  .where(eq(dmsVehicleStockTable.chassisNo, C1));
check("and *then* the machine is at the satellite", nowAt!.showroomId === sat.id);

const voucherCountAfter = (
  await ownerDb
    .select({ c: sql<string>`count(*)` })
    .from(vouchersTable)
    .where(eq(vouchersTable.ownerId, OWNER))
)[0]!.c;
check(
  "**and not one voucher was posted**",
  voucherCountBefore === voucherCountAfter && received.voucherId === undefined,
  `${voucherCountBefore} vouchers before, ${voucherCountAfter} after — nothing was bought and nothing was sold`,
);

// ────────────────────────────────────────────────────────────────────────────

section("2. across two registrations of one company: a taxable supply");

/*
 * Built here and torn down, because giving the seeded Delhi entity a Karnataka
 * registration permanently would change what every other verifier reads.
 */
const [karnataka] = await ownerDb
  .insert(gstRegistrationsTable)
  .values({
    ownerId: OWNER,
    entityId: hubP.entity.id,
    gstin: "29AAACS1234A1Z1",
    state: "Karnataka",
    stateCode: "29",
  })
  .returning();

const [blr] = await ownerDb
  .insert(showroomsTable)
  .values({
    ownerId: OWNER,
    code: "TMP-MOVES-KA",
    name: "Verify Bengaluru Branch",
    entityId: hubP.entity.id,
    registrationId: karnataka!.id,
    role: "SALES",
    state: "Karnataka",
  })
  .returning();

const crossMove = await createStockMove({
  ownerId: OWNER,
  fromShowroomId: hub.id,
  toShowroomId: blr!.id,
  challanDate: "2026-08-06",
  lines: [
    { chassisNo: C2, modelDescription: "Splendor Plus", hsn: "87112019", value: COST, gstRatePct: 18 },
  ],
  narration: "verify-moves: Delhi to Bengaluru, same company",
});
check("it raises", crossMove.ok, crossMove.ok ? crossMove.move!.challanNo : crossMove.error!);
check(
  "**one company, two registrations, and it *is* a supply**",
  crossMove.ok && crossMove.move!.isSupply === "Y",
  crossMove.ok ? crossMove.move!.supplyReason! : "",
);
check(
  "and nobody was asked — it came from the two placements",
  crossMove.ok && crossMove.move!.supplyReason!.includes("distinct registrations"),
  "GST treats distinct registrations as distinct persons, whoever owns them",
);

await despatchStockMove({ ownerId: OWNER, stockMoveId: crossMove.move!.id });
const crossReceived = await receiveStockMove({
  ownerId: OWNER,
  stockMoveId: crossMove.move!.id,
  userId: 1,
});
check(
  "receiving it posts a voucher, unlike the internal move",
  crossReceived.ok && crossReceived.voucherId !== undefined,
  crossReceived.warnings.find((w) => w.includes("taxable supply")) ?? "",
);

if (crossReceived.voucherId) {
  const lines = await ownerDb
    .select({ code: voucherLinesTable.accountCode, debit: voucherLinesTable.debit, credit: voucherLinesTable.credit })
    .from(voucherLinesTable)
    .where(eq(voucherLinesTable.voucherId, crossReceived.voucherId));
  const igst = lines.find((l) => l.code === "2220");
  const cgst = lines.find((l) => l.code === "2200");
  check(
    "Delhi to Karnataka is inter-state, so IGST and not the halves",
    Boolean(igst) && !cgst,
    igst ? `IGST ${rupees(n(igst.credit))} on ${rupees(COST)}` : "no IGST line",
  );
  check(
    "and the tax is computed **on top** of the cost, not out of it",
    n(igst?.credit) === Math.round(COST * 0.18 * 100) / 100,
    "a transfer value is a cost being moved, not a price a customer agreed to — the ex-showroom back-calculation does not apply here",
  );
}

// ────────────────────────────────────────────────────────────────────────────

section("3. between two companies it is not a transfer at all");

const crossCompany = await createStockMove({
  ownerId: OWNER,
  fromShowroomId: hub.id,
  toShowroomId: otherCompany.id,
  challanDate: "2026-08-07",
  lines: [{ chassisNo: C3, modelDescription: "Splendor Plus", value: COST }],
  narration: "verify-moves: across companies",
});
check(
  "**it is refused**, because that is a sale from one company to another",
  !crossCompany.ok && crossCompany.error!.includes("not a delivery challan"),
  crossCompany.ok ? "it raised a challan" : crossCompany.error!,
);
check(
  "and the refusal names what it would actually need",
  !crossCompany.ok && crossCompany.error!.includes("a debtor and a creditor"),
  "a challan cannot produce a debtor and a creditor, and must not pretend to",
);

// ────────────────────────────────────────────────────────────────────────────

section("4. what left and never arrived (the first reconciliation)");

const orphan = await createStockMove({
  ownerId: OWNER,
  fromShowroomId: hub.id,
  toShowroomId: sat.id,
  challanDate: "2026-08-02",
  lines: [{ chassisNo: C3, modelDescription: "Splendor Plus", value: COST }],
  narration: "verify-moves: left and never arrived",
});
await despatchStockMove({ ownerId: OWNER, stockMoveId: orphan.move!.id });

const transit = await withWorkerScope(() => inTransit({ ownerId: OWNER, asOf: "2026-08-11" }));
const found = transit.rows.find((r) => r.challanNo === orphan.move!.challanNo);
check(
  "**it names the challan and the chassis**, not a count (R-114)",
  Boolean(found) && found!.chassisNos.includes(C3),
  found ? `${found.challanNo} · ${found.chassisNos.join(", ")} · ${found.days} days` : "not found",
);
check(
  "and flags the ones that have been out too long",
  Boolean(found?.stale) && transit.staleCount >= 1,
  `${transit.staleCount} stale of ${transit.rows.length} in transit, ${rupees(transit.total)} on the road`,
);
check(
  "the received one is gone from the list, because it arrived",
  !transit.rows.some((r) => r.challanNo === move.move!.challanNo),
);

// ────────────────────────────────────────────────────────────────────────────

section("5. the chassis register reads as one machine's history");

const register = await withWorkerScope(() => chassisRegister({ ownerId: OWNER, chassisNo: C1 }));
for (const e of register) {
  console.log(`      ${e.eventDate}  ${e.kind.padEnd(11)} ${e.sourceRef ?? ""}  ${e.narration ?? ""}`);
}
check(
  "purchased, despatched, received — in order, on one page",
  register.length === 3 &&
    register[0]!.kind === "PURCHASED" &&
    register[1]!.kind === "DESPATCHED" &&
    register[2]!.kind === "RECEIVED",
  register.map((e) => e.kind).join(" → "),
);
check(
  "and every event links back to the document it came off",
  register.every((e) => e.sourceRef !== null),
  "a register that could not be traced back is a list somebody typed",
);

const twice = await withWorkerScope(() =>
  despatchStockMove({ ownerId: OWNER, stockMoveId: move.move!.id }),
);
check(
  "re-despatching a received challan is refused rather than duplicated",
  !twice.ok,
  twice.ok ? "it despatched again" : twice.error!,
);

// ────────────────────────────────────────────────────────────────────────────

section("6. the register against the mirror (the second reconciliation)");

const pos = await withWorkerScope(() => stockPositionCheck({ ownerId: OWNER, asOf: "2026-08-11" }));
console.log(
  `      ${pos.matched} agree · ${pos.mismatched.length} disagree · ` +
    `${pos.onlyInRegister.length} only in the register · ${pos.onlyInMirror.length} only in the mirror`,
);
check(
  "the machine that arrived agrees in both",
  !pos.mismatched.some((m) => m.chassisNo === C1) && !pos.onlyInRegister.includes(C1),
  `${C1} is at ${sat.code} in both`,
);
check(
  "**and the one still in transit is named as a disagreement**",
  pos.mismatched.some((m) => m.chassisNo === C3 && m.registerAt === null),
  "the register says it belongs nowhere and the mirror still has it at the hub, which is exactly what in transit means",
);
check(
  "the odd one out names itself rather than reporting a difference",
  pos.mismatched.every((m) => typeof m.chassisNo === "string" && m.chassisNo.length > 0),
  "a count is an afternoon in a spreadsheet; a list of chassis numbers is a morning's work",
);

// ────────────────────────────────────────────────────────────────────────────

section("7. nothing unattended moves a dealership's stock");

let denied = "";
try {
  await withWorkerScope(async () => {
    await db.insert(stockMovesTable).values({
      ownerId: OWNER,
      fromShowroomId: hub.id,
      toShowroomId: sat.id,
      challanNo: "WORKER/SHOULD/NOT",
      challanDate: "2026-08-11",
      isSupply: "N",
    });
  });
} catch (e) {
  const chain: string[] = [];
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    chain.push(String((err as Error).message ?? err));
  }
  denied = chain.join(" | ");
}
check(
  "the scheduler cannot raise a challan",
  denied.includes("permission denied"),
  denied.split(" | ").find((m) => m.includes("permission denied")) ?? denied ?? "it raised one",
);

// ────────────────────────────────────────────────────────────────────────────

const mine = await ownerDb
  .select({ id: stockMovesTable.id, voucherId: stockMovesTable.voucherId })
  .from(stockMovesTable)
  .where(sql`${stockMovesTable.narration} like 'verify-moves%'`);
for (const m of mine) {
  if (m.voucherId) {
    await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, m.voucherId));
    await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, m.voucherId));
  }
  await ownerDb.delete(stockMoveLinesTable).where(eq(stockMoveLinesTable.stockMoveId, m.id));
  await ownerDb.delete(stockMovesTable).where(eq(stockMovesTable.id, m.id));
}
await ownerDb.delete(chassisEventsTable).where(inArray(chassisEventsTable.chassisNo, ALL_CHASSIS));
await ownerDb.delete(dmsVehicleStockTable).where(inArray(dmsVehicleStockTable.chassisNo, ALL_CHASSIS));
await ownerDb.delete(showroomsTable).where(eq(showroomsTable.code, "TMP-MOVES-KA"));
await ownerDb.delete(gstRegistrationsTable).where(eq(gstRegistrationsTable.gstin, "29AAACS1234A1Z1"));
console.log("\n  (every challan, register entry, mirror row and temporary branch this run made, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. The structure decides the tax, and an internal transfer posts nothing.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
