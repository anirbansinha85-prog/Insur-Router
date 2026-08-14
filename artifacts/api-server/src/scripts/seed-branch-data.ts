/**
 * Three months of business across the whole network (Phase 2).
 *
 * The hub has traded since July. The four branches around it have never sold
 * anything, serviced anything or taken a rupee — they resolve, they post, and
 * they are blank pages. This puts September, October and November 2026 through
 * all five, so the processes have something to be tested against and the
 * reports have something to say.
 *
 * ## Everything goes through the product's own doors
 *
 * `createPurchaseInvoice`, `createStockMove`, `generateDocument`,
 * `postSaleDocument`, `recordMoney`, `issueServiceInvoice`, `closeDay`. **No
 * direct inserts into anything the product owns.** Rows pushed straight into
 * tables are rows the product has never actually processed: they look right on
 * a screen and prove nothing, and the first real invoice would find whatever
 * they hid.
 *
 * The two exceptions are `dms_employees` and `dms_vehicle_stock`, which are
 * **mirror** tables — the dealer's own system's data, which DDMS reads and never
 * writes. Seeding those is standing in for the sync, which is the only honest
 * way to do it.
 *
 * ## Three months, and why not one
 *
 * Ageing buckets need age. One month puts every open bill in the same bucket and
 * proves nothing about the report; three gives genuinely old debt, month-on-month
 * comparison, and a graduation scorecard that could in principle be satisfied.
 *
 * ## Deterministic, deliberately
 *
 * Fixed arrays rather than random generation. A fixture that differs between
 * runs is a fixture nobody can reason about — "the trial balance was out by 400"
 * has to mean the same thing tomorrow.
 *
 * Idempotent: everything it makes is tagged, and it clears its own tag first.
 *
 * It lives beside the verifiers rather than in `scripts/` for the same reason
 * they do: `@workspace/scripts` sets `rootDir` to its own `src`, so it cannot
 * import the product's modules. It is *run* from there.
 *
 * `pnpm run db:seed-branch-data`.
 */

import {
  ownerDb,
  showroomsTable,
  legalEntitiesTable,
  gstRegistrationsTable,
  dmsEmployeesTable,
  dmsVehicleStockTable,
  showroomDmsAccountsTable,
  saleDocumentsTable,
  purchaseInvoicesTable,
  purchaseInvoiceLinesTable,
  stockMovesTable,
  stockMoveLinesTable,
  chassisEventsTable,
  serviceInvoicesTable,
  serviceInvoiceLinesTable,
  moneyDocumentsTable,
  billAllocationsTable,
  dayClosesTable,
  partyBillsTable,
  partiesTable,
  vouchersTable,
  voucherLinesTable,
} from "@workspace/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { ensureParty } from "../lib/dms/ledger/parties";
import {
  createPurchaseInvoice,
  postPurchaseInvoice,
} from "../lib/dms/ledger/purchase";
import {
  createStockMove,
  despatchStockMove,
  receiveStockMove,
} from "../lib/dms/ledger/moves";
import { postSaleDocument } from "../lib/dms/ledger/post";
import { recordMoney, closeDay } from "../lib/dms/ledger/money";
import { issueServiceInvoice } from "../lib/dms/ledger/service";
import { generateDocument } from "../lib/dms/invoice";
import { loadPolicy } from "../lib/dms/policy";

const OWNER = 1;
const RUN_BY = "seed-branch-data";
/** Everything this script makes carries this, so it can clear its own work. */
const TAG = "NET";

const HUB = "DEL-SARASWATI";
const JANAK = "DEL-SAR-JANAK";
const DWARKA = "DEL-SAR-DWK";
const OKHLA = "DEL-SAR-OKHLA";
const PREMIUM = "DEL-SAR-BW";

/** The OEM's own code for each machine. The mirror carries both. */
const MODEL_CODE: Record<string, string> = {
  "Splendor Plus": "HER-SPL-PLUS",
  "HF Deluxe": "HER-HFD-100",
  "Destini 125": "HER-DST-125",
  "Xtreme 125R": "HER-XTR-125R",
  "Xpulse 200 4V": "HER-XPL-200",
  "Vida V2 Plus": "VID-V2-PLUS",
  "Mavrick 440": "HER-MAV-440",
  "Karizma XMR 210": "HER-KRZ-210",
};

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const rupees = (x: number): string => `₹${Math.round(x).toLocaleString("en-IN")}`;

// ── the staff, per branch, because RTO and insurance are branch work ────────
//
// They carry the hub's dealer code because Hero knows the *dealership's* staff;
// which branch somebody sits at is the dealership's own arrangement, and that is
// why `dms_employees` holds both a dealer code and a showroom.
const STAFF: Array<{ branch: string; empCode: string; name: string; role: string; mobile: string }> = [
  { branch: JANAK, empCode: "NET-JNK-01", name: "Rohit Bhatia", role: "SALES_EXEC", mobile: "9810450001" },
  { branch: JANAK, empCode: "NET-JNK-02", name: "Farida Qureshi", role: "RTO_AGENT", mobile: "9810450002" },
  { branch: DWARKA, empCode: "NET-DWK-01", name: "Simran Kaur", role: "SALES_EXEC", mobile: "9810450003" },
  { branch: DWARKA, empCode: "NET-DWK-02", name: "Naveen Yadav", role: "RTO_AGENT", mobile: "9810450004" },
  { branch: PREMIUM, empCode: "NET-BW-01", name: "Arjun Mehra", role: "SALES_EXEC", mobile: "9810450005" },
  { branch: PREMIUM, empCode: "NET-BW-02", name: "Ritika Sood", role: "RTO_AGENT", mobile: "9810450006" },
  { branch: OKHLA, empCode: "NET-OKH-01", name: "Salim Ansari", role: "SERVICE_ADVISOR", mobile: "9810450007" },
  { branch: OKHLA, empCode: "NET-OKH-02", name: "Devender Singh", role: "TECHNICIAN", mobile: "9810450008" },
];

/** What arrives from Hero, month by month, into the hub's yard. */
const CONSIGNMENTS = [
  {
    invoiceNo: `${TAG}/HMC/2026/0901`,
    date: "2026-09-02",
    models: [
      { model: "Splendor Plus", cost: 62_500, gst: 18, count: 8 },
      { model: "HF Deluxe", cost: 49_200, gst: 18, count: 6 },
      { model: "Destini 125", cost: 66_400, gst: 18, count: 4 },
    ],
  },
  {
    invoiceNo: `${TAG}/HMC/2026/1002`,
    date: "2026-10-05",
    models: [
      { model: "Splendor Plus", cost: 62_500, gst: 18, count: 6 },
      { model: "Xtreme 125R", cost: 83_100, gst: 18, count: 4 },
      { model: "Vida V2 Plus", cost: 108_900, gst: 5, count: 3 },
      // 440cc. The only rows in this fixture that carry 40%.
      { model: "Mavrick 440", cost: 152_000, gst: 40, count: 3 },
    ],
  },
  {
    invoiceNo: `${TAG}/HMC/2026/1103`,
    date: "2026-11-03",
    models: [
      { model: "Splendor Plus", cost: 62_500, gst: 18, count: 5 },
      { model: "Xpulse 200 4V", cost: 124_600, gst: 18, count: 3 },
      { model: "Karizma XMR 210", cost: 146_800, gst: 18, count: 2 },
    ],
  },
];

/** Who buys what, where. Deterministic, and shaped like a real month. */
interface SaleSpec {
  branch: string;
  date: string;
  name: string;
  mobile: string;
  address: string;
  pincode: string;
  model: string;
  /** How the money came in. `PART` leaves a balance, for the ageing report. */
  settle: "FULL" | "PART" | "NONE";
  gstin?: string;
}

const SALES: SaleSpec[] = [
  // ── Janakpuri: a busy satellite ────────────────────────────────────────
  { branch: JANAK, date: "2026-09-06", name: "Manish Grover", mobile: "9811230001", address: "C-4, Janakpuri West", pincode: "110058", model: "Splendor Plus", settle: "FULL" },
  { branch: JANAK, date: "2026-09-11", name: "Sunita Bhardwaj", mobile: "9811230002", address: "B-17, Vikaspuri", pincode: "110018", model: "HF Deluxe", settle: "FULL" },
  { branch: JANAK, date: "2026-09-19", name: "Kapil Dogra", mobile: "9811230003", address: "A-9, Uttam Nagar", pincode: "110059", model: "Destini 125", settle: "PART" },
  { branch: JANAK, date: "2026-10-08", name: "Nisha Tandon", mobile: "9811230004", address: "D-2, Tilak Nagar", pincode: "110018", model: "Splendor Plus", settle: "FULL" },
  { branch: JANAK, date: "2026-10-17", name: "Ashok Raina", mobile: "9811230005", address: "E-11, Subhash Nagar", pincode: "110027", model: "Xtreme 125R", settle: "FULL" },
  { branch: JANAK, date: "2026-10-29", name: "Preeti Sabharwal", mobile: "9811230006", address: "F-3, Rajouri Garden", pincode: "110027", model: "Vida V2 Plus", settle: "PART" },
  { branch: JANAK, date: "2026-11-07", name: "Gulshan Arora", mobile: "9811230007", address: "G-8, Hari Nagar", pincode: "110064", model: "Splendor Plus", settle: "FULL" },
  { branch: JANAK, date: "2026-11-21", name: "Ravinder Chadha", mobile: "9811230008", address: "H-5, Janakpuri East", pincode: "110058", model: "HF Deluxe", settle: "NONE" },

  // ── Dwarka: newer, quieter ─────────────────────────────────────────────
  { branch: DWARKA, date: "2026-09-14", name: "Sanjay Pillai", mobile: "9811240001", address: "Sector 6, Dwarka", pincode: "110075", model: "Splendor Plus", settle: "FULL" },
  { branch: DWARKA, date: "2026-09-27", name: "Anjali Bisht", mobile: "9811240002", address: "Sector 12, Dwarka", pincode: "110078", model: "Destini 125", settle: "FULL" },
  { branch: DWARKA, date: "2026-10-12", name: "Mohit Sehgal", mobile: "9811240003", address: "Sector 19, Dwarka", pincode: "110075", model: "HF Deluxe", settle: "PART" },
  { branch: DWARKA, date: "2026-10-24", name: "Fatima Sheikh", mobile: "9811240004", address: "Sector 3, Dwarka", pincode: "110078", model: "Xtreme 125R", settle: "FULL" },
  { branch: DWARKA, date: "2026-11-11", name: "Deepak Rawat", mobile: "9811240005", address: "Sector 22, Dwarka", pincode: "110077", model: "Splendor Plus", settle: "FULL" },
  { branch: DWARKA, date: "2026-11-26", name: "Kritika Malhotra", mobile: "9811240006", address: "Sector 10, Dwarka", pincode: "110075", model: "Vida V2 Plus", settle: "NONE" },

  // ── Aerocity: the premium outlet, and the only 40% rows in the fixture ──
  { branch: PREMIUM, date: "2026-10-18", name: "Vikrant Chowdhury", mobile: "9811250001", address: "Golf Links, New Delhi", pincode: "110003", model: "Mavrick 440", settle: "FULL" },
  { branch: PREMIUM, date: "2026-10-31", name: "Shalini Kapoor", mobile: "9811250002", address: "Vasant Vihar, New Delhi", pincode: "110057", model: "Mavrick 440", settle: "PART" },
  { branch: PREMIUM, date: "2026-11-15", name: "Ridge Logistics Pvt Ltd", mobile: "9811250003", address: "Aerocity, New Delhi", pincode: "110037", model: "Karizma XMR 210", settle: "FULL", gstin: "07AABCR7788K1Z3" },
  { branch: PREMIUM, date: "2026-11-28", name: "Imran Beg", mobile: "9811250004", address: "Jor Bagh, New Delhi", pincode: "110003", model: "Xpulse 200 4V", settle: "FULL" },

  // ── the hub keeps trading too ──────────────────────────────────────────
  { branch: HUB, date: "2026-09-09", name: "Rakesh Nautiyal", mobile: "9811260001", address: "Naraina Vihar", pincode: "110028", model: "Splendor Plus", settle: "FULL" },
  { branch: HUB, date: "2026-09-23", name: "Meenakshi Iyer", mobile: "9811260002", address: "Kirti Nagar", pincode: "110015", model: "Destini 125", settle: "FULL" },
  { branch: HUB, date: "2026-10-14", name: "Zubair Ahmed", mobile: "9811260003", address: "Mayapuri", pincode: "110064", model: "Splendor Plus", settle: "PART" },
  { branch: HUB, date: "2026-11-05", name: "Harleen Gill", mobile: "9811260004", address: "Punjabi Bagh", pincode: "110026", model: "Xpulse 200 4V", settle: "FULL" },
  { branch: HUB, date: "2026-11-19", name: "Tarun Bakshi", mobile: "9811260005", address: "Moti Nagar", pincode: "110015", model: "Karizma XMR 210", settle: "FULL" },
];

/** The workshop. Labour under a SAC, parts under an HSN, some under warranty. */
const SERVICE_JOBS = [
  { date: "2026-09-08", name: "Manish Grover", mobile: "9811230001", reg: "DL 8S AK 4412", km: 1_020, kind: "FREE" as const },
  { date: "2026-09-16", name: "Ramesh Duggal", mobile: "9811270001", reg: "DL 3S BB 9087", km: 14_600, kind: "PAID" as const },
  { date: "2026-09-29", name: "Sunita Bhardwaj", mobile: "9811230002", reg: "DL 8S AK 5510", km: 980, kind: "FREE" as const },
  { date: "2026-10-07", name: "Jasbir Walia", mobile: "9811270002", reg: "DL 4S CE 1122", km: 22_400, kind: "PAID" as const },
  { date: "2026-10-15", name: "Nafisa Rahman", mobile: "9811270003", reg: "DL 9S AA 7781", km: 8_150, kind: "WARRANTY" as const },
  { date: "2026-10-23", name: "Sanjay Pillai", mobile: "9811240001", reg: "DL 2S DF 3344", km: 1_100, kind: "FREE" as const },
  { date: "2026-11-04", name: "Om Prakash", mobile: "9811270004", reg: "DL 5S GH 2201", km: 31_900, kind: "PAID" as const },
  { date: "2026-11-12", name: "Anjali Bisht", mobile: "9811240002", reg: "DL 2S DF 8890", km: 4_050, kind: "PAID" as const },
  { date: "2026-11-24", name: "Yogesh Panwar", mobile: "9811270005", reg: "DL 6S JK 5567", km: 12_700, kind: "WARRANTY" as const },
];

/** Evenings the till was counted. One of them is short, deliberately. */
const DAY_CLOSES: Array<{ branch: string; date: string; short: number; reason?: "UNEXPLAINED" | "MISCOUNT" }> = [
  { branch: HUB, date: "2026-09-30", short: 0 },
  { branch: JANAK, date: "2026-09-30", short: 0 },
  { branch: HUB, date: "2026-10-31", short: 0 },
  { branch: JANAK, date: "2026-10-31", short: -450, reason: "UNEXPLAINED" },
  { branch: DWARKA, date: "2026-10-31", short: 0 },
  { branch: HUB, date: "2026-11-30", short: 0 },
  { branch: JANAK, date: "2026-11-30", short: 0 },
  { branch: DWARKA, date: "2026-11-30", short: 200, reason: "MISCOUNT" },
];

async function branchByCode(): Promise<Map<string, { id: number; name: string; role: string }>> {
  const rows = await ownerDb
    .select({
      id: showroomsTable.id,
      code: showroomsTable.code,
      name: showroomsTable.name,
      role: showroomsTable.role,
    })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, OWNER));
  return new Map(rows.map((r) => [r.code, { id: r.id, name: r.name, role: r.role }]));
}

/** Clear only what this script made, keyed on the tag and nothing else. */
async function wipe(branchIds: number[]): Promise<void> {
  const chassisLike = `${TAG}-%`;

  const docs = await ownerDb
    .select({ id: saleDocumentsTable.id })
    .from(saleDocumentsTable)
    .where(like(saleDocumentsTable.chassisNo, chassisLike));
  const svc = await ownerDb
    .select({ id: serviceInvoicesTable.id })
    .from(serviceInvoicesTable)
    .where(like(serviceInvoicesTable.jobCardRef, chassisLike));
  const pis = await ownerDb
    .select({ id: purchaseInvoicesTable.id })
    .from(purchaseInvoicesTable)
    .where(like(purchaseInvoicesTable.supplierInvoiceNo, `${TAG}/%`));
  const moves = await ownerDb
    .select({ id: stockMovesTable.id })
    .from(stockMovesTable)
    .where(like(stockMovesTable.narration, `${TAG}:%`));

  const sourceIds = [...docs.map((d) => d.id), ...pis.map((p) => p.id)];
  const vs = await ownerDb
    .select({ id: vouchersTable.id })
    .from(vouchersTable)
    .where(
      sourceIds.length
        ? sql`(${vouchersTable.sourceId} in ${sourceIds} and ${vouchersTable.sourceKind} in ('SALE_DOCUMENT','PURCHASE_INVOICE'))
              or ${vouchersTable.narration} like ${`%${TAG}%`}`
        : sql`${vouchersTable.narration} like ${`%${TAG}%`}`,
    );

  // Money first: allocations point at bills, bills at parties.
  const money = await ownerDb
    .select({ id: moneyDocumentsTable.id, voucherId: moneyDocumentsTable.voucherId })
    .from(moneyDocumentsTable)
    .where(inArray(moneyDocumentsTable.showroomId, branchIds));
  const seededParties = await ownerDb
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(sql`${partiesTable.mobile} like '98112%' or ${partiesTable.mobile} like '98126%'`);

  if (money.length) {
    await ownerDb
      .delete(billAllocationsTable)
      .where(inArray(billAllocationsTable.moneyDocumentId, money.map((m) => m.id)));
  }
  const moneyVouchers = money.map((m) => m.voucherId).filter((x): x is number => x !== null);
  for (const id of [...vs.map((v) => v.id), ...moneyVouchers]) {
    await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, id));
  }
  if (money.length)
    await ownerDb
      .delete(moneyDocumentsTable)
      .where(inArray(moneyDocumentsTable.id, money.map((m) => m.id)));
  for (const id of [...vs.map((v) => v.id), ...moneyVouchers]) {
    await ownerDb.delete(vouchersTable).where(eq(vouchersTable.id, id));
  }

  if (seededParties.length)
    await ownerDb
      .delete(partyBillsTable)
      .where(inArray(partyBillsTable.partyId, seededParties.map((p) => p.id)));

  if (svc.length) {
    await ownerDb
      .delete(serviceInvoiceLinesTable)
      .where(inArray(serviceInvoiceLinesTable.serviceInvoiceId, svc.map((x) => x.id)));
    await ownerDb.delete(serviceInvoicesTable).where(inArray(serviceInvoicesTable.id, svc.map((x) => x.id)));
  }
  if (moves.length) {
    await ownerDb
      .delete(stockMoveLinesTable)
      .where(inArray(stockMoveLinesTable.stockMoveId, moves.map((m) => m.id)));
    await ownerDb.delete(stockMovesTable).where(inArray(stockMovesTable.id, moves.map((m) => m.id)));
  }
  if (pis.length) {
    await ownerDb
      .delete(purchaseInvoiceLinesTable)
      .where(inArray(purchaseInvoiceLinesTable.purchaseInvoiceId, pis.map((p) => p.id)));
    await ownerDb.delete(purchaseInvoicesTable).where(inArray(purchaseInvoicesTable.id, pis.map((p) => p.id)));
  }
  if (docs.length)
    await ownerDb.delete(saleDocumentsTable).where(inArray(saleDocumentsTable.id, docs.map((d) => d.id)));

  await ownerDb.delete(chassisEventsTable).where(like(chassisEventsTable.chassisNo, chassisLike));
  await ownerDb.delete(dmsVehicleStockTable).where(like(dmsVehicleStockTable.chassisNo, chassisLike));
  await ownerDb.delete(dmsEmployeesTable).where(like(dmsEmployeesTable.empCode, `${TAG}-%`));
  if (seededParties.length)
    await ownerDb.delete(partiesTable).where(inArray(partiesTable.id, seededParties.map((p) => p.id)));
  await ownerDb
    .delete(dayClosesTable)
    .where(
      and(
        inArray(dayClosesTable.showroomId, branchIds),
        sql`${dayClosesTable.closeDate}::text >= '2026-09-01'`,
      ),
    );
}

async function main(): Promise<void> {
  const branches = await branchByCode();
  for (const code of [HUB, JANAK, DWARKA, OKHLA, PREMIUM]) {
    if (!branches.has(code)) {
      console.log(`\n  ${code} is missing. Run db:seed-network first.\n`);
      return;
    }
  }
  const id = (code: string) => branches.get(code)!.id;
  const branchIds = [HUB, JANAK, DWARKA, OKHLA, PREMIUM].map(id);

  console.log(`\n  Clearing anything a previous run of ${RUN_BY} left behind…`);
  await wipe(branchIds);

  const [entity] = await ownerDb
    .select()
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.code, "SARASWATI"));
  const [dealer] = await ownerDb
    .select({ code: showroomDmsAccountsTable.dealerCode })
    .from(showroomDmsAccountsTable)
    .where(eq(showroomDmsAccountsTable.showroomId, id(HUB)))
    .limit(1);
  const dealerCode = dealer?.code ?? "HMC-DL-0417";

  console.log(`\n  ${entity!.legalName} — September to November 2026, across five branches\n`);

  // ── 1. staff ────────────────────────────────────────────────────────────
  for (const s of STAFF) {
    await ownerDb
      .insert(dmsEmployeesTable)
      .values({
        showroomId: id(s.branch),
        dealerCode,
        empCode: s.empCode,
        empName: s.name,
        role: s.role,
        dateOfJoining: "2026-08-15",
        isActive: "Y",
        mobileNo: s.mobile,
      })
      .onConflictDoNothing();
  }
  console.log(`  staff        ${STAFF.length} across the four branches`);

  // ── 2. what Hero shipped into the yard ──────────────────────────────────
  const { party: hero } = await ensureParty({
    ownerId: OWNER,
    entityId: entity!.id,
    kind: "OEM",
    name: "Hero MotoCorp Ltd",
    gstin: "06AAACH1234M1ZQ",
    state: "Haryana",
  });

  let unit = 0;
  const stockByModel = new Map<string, string[]>();

  for (const c of CONSIGNMENTS) {
    const lines = c.models.flatMap((m) =>
      Array.from({ length: m.count }, () => {
        unit += 1;
        const chassis = `${TAG}-CH-${String(unit).padStart(4, "0")}`;
        const list = stockByModel.get(m.model) ?? [];
        list.push(chassis);
        stockByModel.set(m.model, list);
        return {
          modelDescription: m.model,
          chassisNo: chassis,
          engineNo: `${TAG}-EN-${String(unit).padStart(4, "0")}`,
          hsn: "87112019",
          unitCost: m.cost,
          gstRatePct: m.gst,
        };
      }),
    );

    const created = await createPurchaseInvoice({
      ownerId: OWNER,
      showroomId: id(HUB),
      supplierId: hero.id,
      supplierInvoiceNo: c.invoiceNo,
      invoiceDate: c.date,
      dueDate: null,
      // Gurugram to Delhi. Input IGST against output CGST+SGST, which is the
      // ordinary shape and the one that makes the set-off rules bite.
      interState: true,
      lines,
      otherCharges: [{ label: "Freight", amount: 250 * lines.length }],
      userId: 1,
    });
    if (!created.ok) {
      console.log(`  purchase     ${c.invoiceNo} refused — ${created.error}`);
      continue;
    }

    /*
     * The mirror rows, standing in for the sync. The dealer's own system knows
     * a machine arrived; DDMS reads that and never writes it, so seeding here
     * is the only honest way to put one on the floor.
     */
    for (const l of lines) {
      await ownerDb.insert(dmsVehicleStockTable).values({
        showroomId: id(HUB),
        dealerCode,
        chassisNo: l.chassisNo,
        engineNo: l.engineNo,
        modelCode: MODEL_CODE[l.modelDescription] ?? "HER-UNKNOWN",
        modelDescription: l.modelDescription,
        status: "IN_STOCK",
        costAmount: String(l.unitCost),
        receivedDate: c.date,
        raw: { chassisNo: l.chassisNo, source: RUN_BY },
        rawHash: `${RUN_BY}-${l.chassisNo}`,
      });
    }

    const posted = await postPurchaseInvoice({
      ownerId: OWNER,
      purchaseInvoiceId: created.invoice!.id,
      userId: 1,
    });
    console.log(
      `  purchase     ${c.invoiceNo}  ${String(lines.length).padStart(2)} machines  ${rupees(n(created.invoice!.totalAmount)).padStart(12)}  ${posted.ok ? "posted" : posted.error}`,
    );
  }

  // ── 3. allocation to the branches, on challans ──────────────────────────
  //
  // Same GSTIN throughout, so not one of these is a supply: a delivery challan,
  // a stock-register movement, and no accounting entry at all.
  const allocation: Array<{ to: string; date: string; picks: Array<[string, number]> }> = [
    { to: JANAK, date: "2026-09-04", picks: [["Splendor Plus", 3], ["HF Deluxe", 2], ["Destini 125", 2]] },
    { to: DWARKA, date: "2026-09-12", picks: [["Splendor Plus", 2], ["Destini 125", 2]] },
    { to: JANAK, date: "2026-10-07", picks: [["Splendor Plus", 2], ["Xtreme 125R", 1], ["Vida V2 Plus", 1]] },
    { to: DWARKA, date: "2026-10-10", picks: [["HF Deluxe", 1], ["Xtreme 125R", 1], ["Vida V2 Plus", 1]] },
    { to: PREMIUM, date: "2026-10-16", picks: [["Mavrick 440", 2]] },
    { to: JANAK, date: "2026-11-05", picks: [["Splendor Plus", 2]] },
    { to: DWARKA, date: "2026-11-09", picks: [["Splendor Plus", 1], ["Vida V2 Plus", 1]] },
    { to: PREMIUM, date: "2026-11-13", picks: [["Karizma XMR 210", 1], ["Xpulse 200 4V", 1]] },
  ];

  const taken = new Set<string>();
  const atBranch = new Map<string, string[]>();

  for (const a of allocation) {
    const lines: Array<{ chassisNo: string; modelDescription: string; value: number }> = [];
    for (const [model, count] of a.picks) {
      const pool = (stockByModel.get(model) ?? []).filter((c) => !taken.has(c));
      for (const chassis of pool.slice(0, count)) {
        taken.add(chassis);
        const list = atBranch.get(a.to) ?? [];
        list.push(chassis);
        atBranch.set(a.to, list);
        lines.push({ chassisNo: chassis, modelDescription: model, value: 62_500 });
      }
    }
    if (lines.length === 0) continue;

    const move = await createStockMove({
      ownerId: OWNER,
      fromShowroomId: id(HUB),
      toShowroomId: id(a.to),
      challanDate: a.date,
      lines,
      narration: `${TAG}: allocation to ${a.to}`,
      userId: 1,
    });
    if (!move.ok) {
      console.log(`  challan      ${a.to} ${a.date} refused — ${move.error}`);
      continue;
    }
    await despatchStockMove({ ownerId: OWNER, stockMoveId: move.move!.id, userId: 1 });
    const got = await receiveStockMove({ ownerId: OWNER, stockMoveId: move.move!.id, userId: 1 });
    console.log(
      `  challan      ${move.move!.challanNo}  ${HUB} → ${a.to.padEnd(14)} ${String(lines.length).padStart(2)} machines  ${got.voucherId ? "POSTED A VOUCHER (wrong!)" : "no voucher — not a supply"}`,
    );
  }

  // ── 4. the sales ────────────────────────────────────────────────────────
  const policy = await loadPolicy(OWNER);
  const issued: Array<{ spec: SaleSpec; documentId: number; total: number; partyId: number }> = [];

  for (const s of SALES) {
    const pool = (atBranch.get(s.branch) ?? []).filter((c) => !taken.has(`sold:${c}`));
    // The hub sells off its own yard; a branch sells what was allocated to it.
    const fromHub = (stockByModel.get(s.model) ?? []).filter(
      (c) => !taken.has(c) && !taken.has(`sold:${c}`),
    );
    const candidates = s.branch === HUB ? fromHub : pool;

    let chassis: string | undefined;
    for (const c of candidates) {
      const [row] = await ownerDb
        .select({ model: dmsVehicleStockTable.modelDescription })
        .from(dmsVehicleStockTable)
        .where(eq(dmsVehicleStockTable.chassisNo, c));
      if (row?.model === s.model) {
        chassis = c;
        break;
      }
    }
    if (!chassis) {
      console.log(`  sale         ${s.branch} ${s.date} skipped — no ${s.model} on the floor`);
      continue;
    }
    taken.add(`sold:${chassis}`);
    taken.add(chassis);

    const doc = await generateDocument({
      ownerId: OWNER,
      showroomId: id(s.branch),
      intent: "SALE",
      sale: {
        showroomId: id(s.branch),
        customerName: s.name,
        customerMobile: s.mobile,
        customerAddress: `${s.address} ${s.pincode}`,
        customerGstin: s.gstin ?? null,
        modelDescription: s.model,
        chassisNo: chassis,
      },
      otherCharges: [
        { label: "Registration and road tax", amount: 8_400 },
        { label: "Insurance (1+5)", amount: 6_240 },
      ],
      onDate: s.date,
      placeOfSupply: "Delhi",
      userId: 1,
      userName: RUN_BY,
      principal: "OWNER",
      policy,
    });
    if (!doc.ok) {
      console.log(`  sale         ${s.branch} ${s.date} refused — ${doc.error}`);
      continue;
    }
    const posted = await postSaleDocument({ ownerId: OWNER, documentId: doc.document.id, userId: 1 });
    if (!posted.ok) {
      console.log(`  sale         ${doc.document.reference} not posted — ${posted.error}`);
      continue;
    }

    const [party] = await ownerDb
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(and(eq(partiesTable.entityId, entity!.id), eq(partiesTable.mobile, s.mobile)));
    issued.push({
      spec: s,
      documentId: doc.document.id,
      total: n(doc.document.totalAmount),
      partyId: party!.id,
    });
  }
  console.log(`  sales        ${issued.length} invoices issued and posted`);

  // ── 5. the money ────────────────────────────────────────────────────────
  let collected = 0;
  let outstanding = 0;

  for (const sale of issued) {
    const [bill] = await ownerDb
      .select()
      .from(partyBillsTable)
      .where(
        and(
          eq(partyBillsTable.sourceKind, "SALE_DOCUMENT"),
          eq(partyBillsTable.sourceId, sale.documentId),
        ),
      );
    if (!bill) continue;

    if (sale.spec.settle === "NONE") {
      outstanding += n(bill.outstanding);
      continue;
    }

    /*
     * Three parts, the way a retail sale is actually paid: a booking advance in
     * cash, the financier's disbursement, and the balance on delivery. A PART
     * settlement stops after the financier, which is what leaves an ageing
     * bucket with something in it.
     */
    const total = n(bill.amount);
    const advance = 5_000;
    const finance = Math.round((total - advance) * 0.8);
    const balance = total - advance - finance;

    const parts: Array<{ mode: "CASH" | "FINANCIER"; amount: number }> = [
      { mode: "CASH", amount: advance },
      { mode: "FINANCIER", amount: finance },
    ];
    if (sale.spec.settle === "FULL") parts.push({ mode: "CASH", amount: balance });

    for (const p of parts) {
      const r = await recordMoney({
        ownerId: OWNER,
        showroomId: id(sale.spec.branch),
        direction: "RECEIPT",
        partyId: sale.partyId,
        documentDate: sale.spec.date,
        mode: p.mode,
        amount: p.amount,
        allocations: [{ partyBillId: bill.id, amount: p.amount }],
        instrumentRef: p.mode === "FINANCIER" ? `HDFC/${TAG}/${bill.billNo}` : null,
        userId: 1,
      });
      if (r.ok) collected += p.amount;
    }
    if (sale.spec.settle === "PART") outstanding += balance;
  }
  console.log(
    `  receipts     ${rupees(collected)} collected, ${rupees(outstanding)} still owed`,
  );

  // ── 6. the workshop ─────────────────────────────────────────────────────
  let jobs = 0;
  for (const j of SERVICE_JOBS) {
    const { party: customer } = await ensureParty({
      ownerId: OWNER,
      entityId: entity!.id,
      kind: "CUSTOMER",
      name: j.name,
      mobile: j.mobile,
    });

    const lines =
      j.kind === "FREE"
        ? [
            { kind: "LABOUR" as const, description: "Free service — periodic", unitRate: 700, coverage: "FREE_SERVICE" as const },
            { kind: "PART" as const, description: "Engine oil 10W30, 1L", partNo: "HER-OIL-10W30", hsn: "27101981", unitRate: 480, unitCost: 305, coverage: "FREE_SERVICE" as const },
          ]
        : j.kind === "WARRANTY"
          ? [
              { kind: "LABOUR" as const, description: "Warranty repair — clutch assembly", unitRate: 1_200, coverage: "WARRANTY" as const },
              { kind: "PART" as const, description: "Clutch plate set", partNo: "HER-CLT-SET", hsn: "87141090", unitRate: 1_850, unitCost: 1_180, coverage: "WARRANTY" as const },
            ]
          : [
              { kind: "LABOUR" as const, description: "Paid service — periodic", unitRate: 900 },
              { kind: "PART" as const, description: "Engine oil 10W30, 1L", partNo: "HER-OIL-10W30", hsn: "27101981", unitRate: 480, unitCost: 305 },
              { kind: "PART" as const, description: "Brake shoe set", partNo: "HER-BRK-SHOE-01", hsn: "87141090", unitRate: 640, unitCost: 410 },
            ];

    const inv = await issueServiceInvoice({
      ownerId: OWNER,
      showroomId: id(OKHLA),
      customerId: customer.id,
      invoiceDate: j.date,
      jobCardRef: `${TAG}-JC-${j.reg.replace(/\s/g, "")}`,
      registrationNo: j.reg,
      odometerKm: j.km,
      placeOfSupply: "Delhi",
      lines,
      userId: 1,
    });
    if (inv.ok) jobs += 1;
    else console.log(`  service      ${j.date} refused — ${inv.error}`);
  }
  console.log(`  service      ${jobs} job cards billed at ${OKHLA}`);

  // ── 7. the evenings ─────────────────────────────────────────────────────
  let closes = 0;
  for (const d of DAY_CLOSES) {
    const { bookedCashFor } = await import("../lib/dms/ledger/money");
    const booked = await bookedCashFor({
      ownerId: OWNER,
      showroomId: id(d.branch),
      closeDate: d.date,
    });
    const close = await closeDay({
      ownerId: OWNER,
      showroomId: id(d.branch),
      closeDate: d.date,
      countedCash: booked.expected + d.short,
      reason: d.short === 0 ? "EXACT" : d.reason,
      reasonNote: d.short === 0 ? null : "Counted twice; the difference stands.",
      userId: 1,
    });
    if (close.ok) closes += 1;
  }
  console.log(`  day closes   ${closes} evenings counted, one short and one over`);

  // ── what the network now holds ──────────────────────────────────────────
  console.log("\n  Where the business sits now\n");
  for (const code of [HUB, JANAK, DWARKA, OKHLA, PREMIUM]) {
    const b = branches.get(code)!;
    const [sales] = await ownerDb
      .select({ c: sql<string>`count(*)`, v: sql<string>`coalesce(sum(${saleDocumentsTable.totalAmount}::numeric),0)` })
      .from(saleDocumentsTable)
      .where(eq(saleDocumentsTable.showroomId, b.id));
    const [stock] = await ownerDb
      .select({ c: sql<string>`count(*)` })
      .from(dmsVehicleStockTable)
      .where(eq(dmsVehicleStockTable.showroomId, b.id));
    const [svc] = await ownerDb
      .select({ c: sql<string>`count(*)` })
      .from(serviceInvoicesTable)
      .where(eq(serviceInvoicesTable.showroomId, b.id));
    console.log(
      `    ${b.role.padEnd(8)} ${code.padEnd(15)} ${String(sales!.c).padStart(3)} invoices ${rupees(n(sales!.v)).padStart(14)} · ${String(stock!.c).padStart(3)} on the floor · ${String(svc!.c).padStart(2)} job cards`,
    );
  }

  console.log(
    "\n  Every row above went through the product's own doors — createPurchaseInvoice,\n" +
      "  createStockMove, generateDocument, postSaleDocument, recordMoney,\n" +
      "  issueServiceInvoice, closeDay. Nothing was inserted behind them.\n",
  );
}

await main();
process.exit(0);
