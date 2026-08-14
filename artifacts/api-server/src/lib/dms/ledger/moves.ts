/**
 * Moving a machine without selling it (OBJ-39, R-117).
 *
 * The hub allocates to a satellite every morning and the satellite sends back
 * what did not shift. None of it is a sale, all of it needs a document, and
 * whether any of it attracts tax is decided by the **structure** rather than by
 * a person ticking a box — same registration is one legal person moving its own
 * stock, a different registration is a taxable supply even inside one company.
 *
 * ## Three outcomes, and only one of them touches the ledger
 *
 * ```
 *   same registration     challan + stock transfer note, no GST, no voucher
 *   different, same state challan + tax invoice, CGST + SGST, a voucher
 *   different, other state challan + tax invoice, IGST,        a voucher
 * ```
 *
 * The first is the ordinary case and the one that would be easiest to get
 * wrong in the expensive direction. Charging GST on an internal transfer
 * inflates output tax, inflates the return, and hands the government money the
 * dealership does not owe — quietly, monthly, for as long as nobody checks.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  stockMovesTable,
  stockMoveLinesTable,
  chassisEventsTable,
  vouchersTable,
  voucherLinesTable,
  dmsVehicleStockTable,
  dmsPartStockTable,
  showroomsTable,
  type StockMoveRow,
  type ChassisEventRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { accountsByCode, ensureChart } from "./accounts";
import { financialYearOf, nextVoucherNo, type Line } from "./post";
import { placementOf, transferIsSupply } from "../org";
import { taxWithin } from "../invoice/pricing";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const money = (v: number): string => v.toFixed(2);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * The e-way bill threshold, and it is a fact about the world rather than a
 * setting (R-121's shape applied to a different rule).
 *
 * Fifty thousand rupees of consignment value, and a motorcycle is over it on
 * its own. The threshold applies to the consignment, so two bikes on one
 * challan are counted together.
 */
export const EWAY_THRESHOLD = 50_000;

/**
 * A machine. One frame, one identity, one life on the register.
 */
export interface VehicleMoveLine {
  kind?: "VEHICLE";
  chassisNo: string;
  engineNo?: string | null;
  modelDescription: string;
  hsn?: string | null;
  /** At **cost**. No profit arises from moving a bike between your own branches. */
  value: number;
  gstRatePct?: number | null;
}

/**
 * A quantity of a part (OBJ-46). No identity, and therefore no register.
 *
 * A brake shoe is not traced from the factory to a customer; it is counted on a
 * shelf. So a part line records what the shelf has to change by, and the check
 * that matters is **conservation** — what left one branch arrived at the other
 * and the company still owns the same number of them.
 */
export interface PartMoveLine {
  kind: "PART";
  partNo: string;
  qty: number;
  modelDescription: string;
  hsn?: string | null;
  /** The **line total** at cost, not a unit rate. */
  value: number;
  gstRatePct?: number | null;
}

export type MoveLineInput = VehicleMoveLine | PartMoveLine;

const isPart = (l: MoveLineInput): l is PartMoveLine => l.kind === "PART";

/** Our own challan series, per owner per financial year. Gapless. */
async function nextChallanNo(ownerId: number, onDate: string): Promise<string> {
  const fy = financialYearOf(onDate);
  const [last] = await db
    .select({ no: stockMovesTable.challanNo })
    .from(stockMovesTable)
    .where(
      and(
        eq(stockMovesTable.ownerId, ownerId),
        sql`${stockMovesTable.challanNo} like ${`DC/${fy}/%`}`,
      ),
    )
    .orderBy(sql`length(${stockMovesTable.challanNo}) desc`, sql`${stockMovesTable.challanNo} desc`)
    .limit(1);

  const next = last ? Number(last.no.split("/").pop()) + 1 : 1;
  return `DC/${fy}/${String(next).padStart(4, "0")}`;
}

/**
 * Raise a delivery challan. The structure decides the tax; nobody is asked.
 *
 * Draft until it is despatched, so a challan typed at the wrong branch can be
 * abandoned rather than reversed.
 */
export async function createStockMove(input: {
  ownerId: number;
  fromShowroomId: number;
  toShowroomId: number;
  challanDate: string;
  lines: MoveLineInput[];
  narration?: string | null;
  userId?: number | null;
}): Promise<{ ok: boolean; move?: StockMoveRow; error?: string; warnings: string[] }> {
  const warnings: string[] = [];

  if (input.lines.length === 0) {
    return { ok: false, error: "A challan with nothing on it records nothing.", warnings };
  }
  if (input.fromShowroomId === input.toShowroomId) {
    return {
      ok: false,
      error: "Stock cannot be transferred to the branch it is already at.",
      warnings,
    };
  }

  /*
   * Each line is one shape or the other, checked here as well as by the
   * database (OBJ-46). The constraint is the guarantee; this is the sentence.
   */
  for (const l of input.lines) {
    if (isPart(l)) {
      if (!l.partNo?.trim()) {
        return { ok: false, error: "A part line needs a part number.", warnings };
      }
      if (!Number.isInteger(l.qty) || l.qty < 1) {
        return {
          ok: false,
          error: `${l.partNo} is on the challan for ${l.qty}. A part travels in whole units and at least one of them.`,
          warnings,
        };
      }
    } else if (!l.chassisNo?.trim()) {
      return { ok: false, error: "A machine line needs a chassis number.", warnings };
    }
  }

  const from = await placementOf(input.fromShowroomId);
  const to = await placementOf(input.toShowroomId);

  /*
   * A transfer between two **legal entities** is a sale between two companies,
   * not a transfer. It needs a purchase invoice on one side and a sale document
   * on the other, with a debtor and a creditor - which this document cannot
   * produce and must not pretend to.
   */
  if (from.entity.id !== to.entity.id) {
    return {
      ok: false,
      error:
        `${from.branchName} and ${to.branchName} belong to different companies ` +
        `(${from.entity.legalName} and ${to.entity.legalName}). Moving stock between two legal ` +
        "persons is a sale from one to the other, with an invoice, a debtor and a creditor — " +
        "not a delivery challan.",
      warnings,
    };
  }

  /*
   * Already on an open challan?
   *
   * Checked here rather than by a unique index because the rule needs the
   * parent's status and Postgres will not take a subquery in an index
   * predicate. That makes this a checked refusal rather than a guaranteed one,
   * and the honest consequence is that two people raising the same challan in
   * the same second could both win - which is a race worth losing to, given the
   * alternative was a denormalised status quietly going stale.
   */
  const vehicleLines = input.lines.filter((l): l is VehicleMoveLine => !isPart(l));
  const partLines = input.lines.filter(isPart);

  const chassisNos = vehicleLines.map((l) => l.chassisNo.trim());
  const alreadyOpen = chassisNos.length === 0 ? [] : await db
    .select({
      chassisNo: stockMoveLinesTable.chassisNo,
      challanNo: stockMovesTable.challanNo,
    })
    .from(stockMoveLinesTable)
    .innerJoin(stockMovesTable, eq(stockMoveLinesTable.stockMoveId, stockMovesTable.id))
    .where(
      and(
        eq(stockMovesTable.ownerId, input.ownerId),
        inArray(stockMovesTable.status, ["DRAFT", "IN_TRANSIT"]),
        inArray(stockMoveLinesTable.chassisNo, chassisNos),
      ),
    );

  if (alreadyOpen.length > 0) {
    return {
      ok: false,
      error:
        `${alreadyOpen.map((r) => `${r.chassisNo} is on ${r.challanNo}`).join("; ")}. ` +
        "A machine despatched twice without arriving is either a keying error or a bike that has " +
        "genuinely gone missing, and both deserve a refusal rather than a second document.",
      warnings,
    };
  }

  /*
   * Is the part actually on the sending branch's shelf?
   *
   * **A warning and not a refusal**, deliberately, and the reasoning is the
   * same as the vehicle path's: the shelf figure is a *mirror* of the dealer's
   * own system and is only as fresh as the last sync. Refusing a real van that
   * is loading because a nightly pull has not run yet would make the document
   * useless on exactly the mornings it matters. The counter clerk can see the
   * shelf and we cannot.
   *
   * What is *not* done is quietly clamping the shelf at zero on despatch. A
   * negative on-hand is the books saying the branch shipped more than it had,
   * which is a finding; clamping destroys the only evidence of it.
   */
  if (partLines.length > 0) {
    const shelf = await db
      .select({ partNo: dmsPartStockTable.partNo, qtyOnHand: dmsPartStockTable.qtyOnHand })
      .from(dmsPartStockTable)
      .where(
        and(
          eq(dmsPartStockTable.showroomId, input.fromShowroomId),
          inArray(
            dmsPartStockTable.partNo,
            partLines.map((l) => l.partNo.trim()),
          ),
        ),
      );
    const onHand = new Map(shelf.map((r) => [r.partNo, r.qtyOnHand]));
    for (const l of partLines) {
      const have = onHand.get(l.partNo.trim());
      if (have === undefined) {
        warnings.push(
          `${from.branchName} has no shelf record for ${l.partNo}, so the challan records ${l.qty} leaving a shelf ` +
            "the dealer's system does not know exists. Either it has never been stocked here or the mirror is stale.",
        );
      } else if (have < l.qty) {
        warnings.push(
          `${from.branchName} shows ${have} of ${l.partNo} on the shelf and ${l.qty} are on this challan. ` +
            "The shelf will go negative on despatch rather than being clamped, because a shelf below zero is the " +
            "finding and a clamp would hide it.",
        );
      }
    }
  }

  const supply = transferIsSupply(from, to);
  const value = round2(input.lines.reduce((a, l) => a + l.value, 0));

  const challanNo = await nextChallanNo(input.ownerId, input.challanDate);

  /*
   * The e-way bill is about **movement** and a challan does not exempt one.
   * Defaulted to REQUIRED above the threshold so an unfilled bill is loud, and
   * the note carries the sentence a CA should confirm rather than a claim the
   * product cannot stand behind.
   */
  const ewayNeeded = value > EWAY_THRESHOLD;
  if (ewayNeeded) {
    warnings.push(
      `This consignment is worth ₹${value.toLocaleString("en-IN")}, over the ₹50,000 e-way bill threshold. ` +
        "A delivery challan does not exempt the movement. Part B — the vehicle detail — is generally not " +
        "required under fifty kilometres within a state; confirm that against your state's current " +
        "notification rather than taking it from us.",
    );
  }

  try {
    const [move] = await db
      .insert(stockMovesTable)
      .values({
        ownerId: input.ownerId,
        fromShowroomId: input.fromShowroomId,
        toShowroomId: input.toShowroomId,
        challanNo,
        challanDate: input.challanDate,
        isSupply: supply.isSupply ? "Y" : "N",
        supplyReason: supply.why,
        consignmentValue: money(value),
        ewayStatus: ewayNeeded ? "REQUIRED" : "NOT_REQUIRED",
        ewayNote: ewayNeeded
          ? null
          : `Consignment value ₹${value.toLocaleString("en-IN")} is under the ₹50,000 threshold.`,
        narration: input.narration ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning();

    await db.insert(stockMoveLinesTable).values(
      input.lines.map((l, i) => ({
        stockMoveId: move!.id,
        seq: i + 1,
        kind: isPart(l) ? ("PART" as const) : ("VEHICLE" as const),
        chassisNo: isPart(l) ? null : l.chassisNo.trim(),
        engineNo: isPart(l) ? null : l.engineNo?.trim() || null,
        partNo: isPart(l) ? l.partNo.trim() : null,
        qty: isPart(l) ? l.qty : 1,
        modelDescription: l.modelDescription,
        hsn: l.hsn ?? null,
        value: money(l.value),
        gstRatePct: l.gstRatePct == null ? null : String(l.gstRatePct),
      })),
    );

    return { ok: true, move: move!, warnings };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === "23505" && cause.constraint?.includes("chassis")) {
      return {
        ok: false,
        error: "The same machine appears twice on this challan.",
        warnings,
      };
    }
    if (cause?.code === "23505" && cause.constraint?.includes("part")) {
      return {
        ok: false,
        error:
          "The same part appears twice on this challan. Put the quantity on one line — two lines add up " +
          "and then only one of them gets corrected.",
        warnings,
      };
    }
    if (cause?.code === "23514" && cause.constraint?.includes("kind_shape")) {
      return {
        ok: false,
        error:
          "A line carried both a chassis number and a part number, or neither. One thing travels per line.",
        warnings,
      };
    }
    throw err;
  }
}

/**
 * Send it. The stock leaves the despatching branch and is in transit.
 *
 * `IN_TRANSIT` is a real state and not a formality: a bike that left the hub and
 * has not arrived anywhere is the first reconciliation's entire subject, and it
 * can only be found if *left* and *arrived* are two separate facts.
 */
export async function despatchStockMove(input: {
  ownerId: number;
  stockMoveId: number;
  userId?: number | null;
}): Promise<{ ok: boolean; move?: StockMoveRow; error?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const [move] = await db
    .select()
    .from(stockMovesTable)
    .where(
      and(eq(stockMovesTable.ownerId, input.ownerId), eq(stockMovesTable.id, input.stockMoveId)),
    );
  if (!move) return { ok: false, error: `No challan ${input.stockMoveId}`, warnings };
  if (move.status !== "DRAFT") {
    return { ok: false, error: `${move.challanNo} is already ${move.status}.`, warnings };
  }

  if (move.ewayStatus === "REQUIRED" && !move.ewayBillNo) {
    warnings.push(
      `${move.challanNo} is going out without an e-way bill number recorded. The consignment is over ` +
        "the threshold, so one is required for the movement — a vehicle stopped without it is the " +
        "dealership explaining itself at the roadside.",
    );
  }

  const lines = await db
    .select()
    .from(stockMoveLinesTable)
    .where(eq(stockMoveLinesTable.stockMoveId, move.id))
    .orderBy(asc(stockMoveLinesTable.seq));

  const [updated] = await db
    .update(stockMovesTable)
    .set({ status: "IN_TRANSIT", despatchedAt: new Date() })
    .where(eq(stockMovesTable.id, move.id))
    .returning();

  for (const l of lines) {
    if (l.kind === "PART") {
      /*
       * The shelf falls **here**, on despatch, and not on arrival — which is
       * the opposite of the vehicle path and is deliberate (OBJ-46).
       *
       * A machine's mirror row moves branch on receipt because it is one row
       * that has to be somewhere, and while it is in transit the chassis
       * register says *nowhere*, which is what the stock reconciliation reads.
       * A part has no register. If the count only fell on arrival, the sending
       * branch's shelf would overstate for as long as the van was on the road,
       * and a counter clerk would promise a part that had already left the
       * building.
       *
       * So the source falls now, the destination rises on receipt, and the
       * difference between them **is** the goods in transit — which is exactly
       * what the inter-branch reconciliation reports.
       */
      await db
        .update(dmsPartStockTable)
        .set({ qtyOnHand: sql`${dmsPartStockTable.qtyOnHand} - ${l.qty}` })
        .where(
          and(
            eq(dmsPartStockTable.showroomId, move.fromShowroomId),
            eq(dmsPartStockTable.partNo, l.partNo!),
          ),
        );
      continue;
    }

    await db
      .insert(chassisEventsTable)
      .values({
        ownerId: input.ownerId,
        chassisNo: l.chassisNo!,
        showroomId: move.fromShowroomId,
        kind: "DESPATCHED",
        eventDate: move.challanDate,
        sourceKind: "STOCK_MOVE",
        sourceId: move.id,
        sourceRef: move.challanNo,
        value: l.value,
        narration: `To branch ${move.toShowroomId} on ${move.challanNo}`,
      })
      .onConflictDoNothing();
  }

  logger.info(
    {
      ownerId: input.ownerId,
      challanNo: move.challanNo,
      units: lines.filter((l) => l.kind !== "PART").length,
      partLines: lines.filter((l) => l.kind === "PART").length,
    },
    "Stock despatched",
  );
  return { ok: true, move: updated!, warnings };
}

/**
 * Receive it, and this is where the branch on the stock mirror actually moves.
 *
 * Deliberately **not** on despatch. A machine in transit has left one branch and
 * arrived at none, and pretending it is already at the destination is how a
 * missing bike looks present on the receiving branch's stock report for a week.
 *
 * If the movement was a supply, this is also where the voucher posts.
 */
export async function receiveStockMove(input: {
  ownerId: number;
  stockMoveId: number;
  userId?: number | null;
  receivedDate?: string | null;
}): Promise<{
  ok: boolean;
  move?: StockMoveRow;
  voucherId?: number;
  error?: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const [move] = await db
    .select()
    .from(stockMovesTable)
    .where(
      and(eq(stockMovesTable.ownerId, input.ownerId), eq(stockMovesTable.id, input.stockMoveId)),
    );
  if (!move) return { ok: false, error: `No challan ${input.stockMoveId}`, warnings };
  if (move.status !== "IN_TRANSIT") {
    return {
      ok: false,
      error: `${move.challanNo} is ${move.status}. Only something in transit can be received.`,
      warnings,
    };
  }

  const lines = await db
    .select()
    .from(stockMoveLinesTable)
    .where(eq(stockMoveLinesTable.stockMoveId, move.id))
    .orderBy(asc(stockMoveLinesTable.seq));

  const receivedDate = input.receivedDate ?? move.challanDate;
  let voucherId: number | undefined;

  /*
   * Only a supply posts, and that is the whole of R-117.
   *
   * Same registration is one legal person moving its own stock: the chassis
   * changes branch and no balance changes, because nothing has been bought or
   * sold. Posting a voucher here would create revenue and a debtor out of an
   * internal errand.
   */
  if (move.isSupply === "Y") {
    const from = await placementOf(move.fromShowroomId);
    const to = await placementOf(move.toShowroomId);
    const interState = from.registration.state !== to.registration.state;

    await ensureChart(input.ownerId);
    const accounts = await accountsByCode(input.ownerId);
    const need = (code: string) => {
      const a = accounts.get(code);
      if (!a) throw new Error(`The ledger account ${code} is missing for this dealership.`);
      return a;
    };

    const value = n(move.consignmentValue);
    const rate = n(lines[0]?.gstRatePct) || 18;
    /*
     * The value on an internal transfer is stated **exclusive** of tax, unlike
     * an ex-showroom price: it is a cost being moved, not a price a customer
     * agreed to. So tax is computed on top here rather than back-calculated,
     * and `taxWithin` is deliberately not used.
     */
    const tax = round2((value * rate) / 100);
    const cgst = interState ? 0 : round2(tax / 2);
    const sgst = interState ? 0 : round2(tax - cgst);
    const igst = interState ? tax : 0;

    const vlines: Line[] = [
      {
        accountCode: "1100",
        debit: round2(value + tax),
        credit: 0,
        narration: `Branch transfer out on ${move.challanNo}`,
      },
      { accountCode: "4100", debit: 0, credit: value, narration: "Branch transfer", taxRatePct: rate },
    ];
    if (cgst > 0) vlines.push({ accountCode: "2200", debit: 0, credit: cgst });
    if (sgst > 0) vlines.push({ accountCode: "2210", debit: 0, credit: sgst });
    if (igst > 0) vlines.push({ accountCode: "2220", debit: 0, credit: igst });

    const fy = financialYearOf(receivedDate);
    const voucherNo = await nextVoucherNo(input.ownerId, "SALES", fy);
    const totalDebit = round2(vlines.reduce((a, l) => a + l.debit, 0));
    const totalCredit = round2(vlines.reduce((a, l) => a + l.credit, 0));

    const [voucher] = await db
      .insert(vouchersTable)
      .values({
        ownerId: input.ownerId,
        showroomId: move.fromShowroomId,
        kind: "SALES",
        voucherNo,
        voucherDate: receivedDate,
        financialYear: fy,
        narration: `Branch transfer ${move.challanNo} — ${from.registration.gstin} to ${to.registration.gstin}`,
        sourceKind: "MANUAL",
        sourceId: null,
        totalDebit: money(totalDebit),
        totalCredit: money(totalCredit),
        warnings: [
          "This transfer crossed two GST registrations, which GST treats as two persons, so it is a taxable supply and has been posted as one.",
        ],
        postedByUserId: input.userId ?? null,
      })
      .returning();

    await db.insert(voucherLinesTable).values(
      vlines.map((l, i) => {
        const a = need(l.accountCode);
        return {
          voucherId: voucher!.id,
          seq: i + 1,
          accountId: a.id,
          accountCode: a.code,
          accountName: a.name,
          debit: money(l.debit),
          credit: money(l.credit),
          narration: l.narration ?? null,
          taxRatePct: l.taxRatePct == null ? null : String(l.taxRatePct),
        };
      }),
    );
    voucherId = voucher!.id;
    warnings.push(
      `${move.challanNo} moved stock between two GST registrations, so it is a taxable supply and voucher ${voucherNo} has been posted for it.`,
    );
  }

  const [updated] = await db
    .update(stockMovesTable)
    .set({
      status: "RECEIVED",
      receivedAt: new Date(),
      receivedByUserId: input.userId ?? null,
      voucherId: voucherId ?? null,
    })
    .where(eq(stockMovesTable.id, move.id))
    .returning();

  let moved = 0;
  let createdShelves = 0;
  for (const l of lines) {
    if (l.kind === "PART") {
      const bumped = await db
        .update(dmsPartStockTable)
        .set({
          qtyOnHand: sql`${dmsPartStockTable.qtyOnHand} + ${l.qty}`,
          lastReceivedDate: receivedDate,
        })
        .where(
          and(
            eq(dmsPartStockTable.showroomId, move.toShowroomId),
            eq(dmsPartStockTable.partNo, l.partNo!),
          ),
        )
        .returning({ id: dmsPartStockTable.id });

      if (bumped.length === 0) {
        /*
         * The receiving branch has never held this part, so there is no shelf
         * row to raise. One is written, and it is worth being precise about
         * what that is: a **mirror** row that no dealer system produced.
         *
         * The alternative was to refuse, and refusing would mean the box
         * physically arrived and the product recorded it nowhere - the exact
         * failure OBJ-46 exists to close. So it is written, carrying the
         * *sending* branch's dealer code because that is whose parts ledger it
         * came off, and the warning says plainly that the dealership's own
         * system does not know. At a branch that syncs, the next pull will mark
         * it disappeared, and that is the honest signal rather than a defect:
         * the transfer happened and nobody keyed it into the DMS.
         */
        const [source] = await db
          .select({ dealerCode: dmsPartStockTable.dealerCode, partDesc: dmsPartStockTable.partDesc })
          .from(dmsPartStockTable)
          .where(
            and(
              eq(dmsPartStockTable.showroomId, move.fromShowroomId),
              eq(dmsPartStockTable.partNo, l.partNo!),
            ),
          );

        await db.insert(dmsPartStockTable).values({
          showroomId: move.toShowroomId,
          dealerCode: source?.dealerCode ?? "",
          partNo: l.partNo!,
          partDesc: source?.partDesc ?? l.modelDescription,
          qtyOnHand: l.qty,
          lastReceivedDate: receivedDate,
          raw: { createdBy: "DDMS_STOCK_MOVE", challanNo: move.challanNo, qty: l.qty },
          rawHash: `challan:${move.challanNo}:${l.partNo}`,
        });
        createdShelves++;
        warnings.push(
          `${l.partNo} had never been held at the receiving branch, so a shelf line has been opened for it ` +
            `with ${l.qty} on hand. The dealership's own system does not know this part is there — ` +
            "key the transfer into it, or the next sync will report the line as gone.",
        );
      }
      continue;
    }

    const res = await db
      .update(dmsVehicleStockTable)
      .set({ showroomId: move.toShowroomId })
      .where(
        and(
          eq(dmsVehicleStockTable.showroomId, move.fromShowroomId),
          eq(dmsVehicleStockTable.chassisNo, l.chassisNo!),
        ),
      )
      .returning({ id: dmsVehicleStockTable.id });
    moved += res.length;

    await db
      .insert(chassisEventsTable)
      .values({
        ownerId: input.ownerId,
        chassisNo: l.chassisNo!,
        showroomId: move.toShowroomId,
        kind: "RECEIVED",
        eventDate: receivedDate,
        sourceKind: "STOCK_MOVE",
        sourceId: move.id,
        sourceRef: move.challanNo,
        value: l.value,
        narration: `From branch ${move.fromShowroomId} on ${move.challanNo}`,
      })
      .onConflictDoNothing();
  }

  const vehicleCount = lines.filter((l) => l.kind !== "PART").length;
  if (moved < vehicleCount) {
    warnings.push(
      `${vehicleCount - moved} of ${vehicleCount} machine(s) on ${move.challanNo} were not found in the despatching branch's stock, so the register records the arrival and the mirror does not show the move. The stock reconciliation will name them.`,
    );
  }

  logger.info(
    {
      ownerId: input.ownerId,
      challanNo: move.challanNo,
      units: moved,
      createdShelves,
      voucherId,
    },
    "Stock received",
  );
  return { ok: true, move: updated!, voucherId, warnings };
}

/**
 * The first reconciliation: what left and never arrived.
 *
 * A difference here is a bike standing in a yard nobody has recorded, or one
 * that has walked. It names the challan and the chassis rather than a count
 * (R-114), because a count is an afternoon in a spreadsheet and a list is a
 * phone call.
 */
export async function inTransit(input: {
  ownerId: number;
  asOf: string;
  staleAfterDays?: number;
}): Promise<{
  rows: Array<{
    challanNo: string;
    challanDate: string;
    fromShowroomId: number;
    toShowroomId: number;
    chassisNos: string[];
    /** Part lines on the same challan, which travel in the same van (OBJ-46). */
    parts: Array<{ partNo: string; qty: number }>;
    value: number;
    days: number;
    stale: boolean;
  }>;
  total: number;
  staleCount: number;
}> {
  const stale = input.staleAfterDays ?? 3;
  const moves = await db
    .select()
    .from(stockMovesTable)
    .where(
      and(
        eq(stockMovesTable.ownerId, input.ownerId),
        eq(stockMovesTable.status, "IN_TRANSIT"),
        sql`${stockMovesTable.challanDate}::text <= ${input.asOf}`,
      ),
    )
    .orderBy(asc(stockMovesTable.challanDate));

  if (moves.length === 0) return { rows: [], total: 0, staleCount: 0 };

  const lines = await db
    .select()
    .from(stockMoveLinesTable)
    .where(
      inArray(
        stockMoveLinesTable.stockMoveId,
        moves.map((m) => m.id),
      ),
    );

  const byMove = new Map<number, string[]>();
  const partsByMove = new Map<number, Array<{ partNo: string; qty: number }>>();
  for (const l of lines) {
    if (l.kind === "PART") {
      const list = partsByMove.get(l.stockMoveId) ?? [];
      list.push({ partNo: l.partNo!, qty: l.qty });
      partsByMove.set(l.stockMoveId, list);
      continue;
    }
    const list = byMove.get(l.stockMoveId) ?? [];
    list.push(l.chassisNo!);
    byMove.set(l.stockMoveId, list);
  }

  const asOfMs = Date.parse(input.asOf);
  const rows = moves.map((m) => {
    const days = Math.floor((asOfMs - Date.parse(m.challanDate)) / 86_400_000);
    return {
      challanNo: m.challanNo,
      challanDate: m.challanDate,
      fromShowroomId: m.fromShowroomId,
      toShowroomId: m.toShowroomId,
      chassisNos: byMove.get(m.id) ?? [],
      parts: partsByMove.get(m.id) ?? [],
      value: n(m.consignmentValue),
      days,
      stale: days > stale,
    };
  });

  return {
    rows,
    total: round2(rows.reduce((a, r) => a + r.value, 0)),
    staleCount: rows.filter((r) => r.stale).length,
  };
}

/** One machine's whole life, in order. The register an auditor asks for. */
export async function chassisRegister(input: {
  ownerId: number;
  chassisNo: string;
}): Promise<ChassisEventRow[]> {
  return db
    .select()
    .from(chassisEventsTable)
    .where(
      and(
        eq(chassisEventsTable.ownerId, input.ownerId),
        eq(chassisEventsTable.chassisNo, input.chassisNo.trim()),
      ),
    )
    .orderBy(asc(chassisEventsTable.eventDate), asc(chassisEventsTable.id));
}

/** Record an event on the register. Used by the purchase and the sale paths. */
export async function recordChassisEvent(input: {
  ownerId: number;
  chassisNo: string;
  showroomId: number | null;
  kind: ChassisEventRow["kind"];
  eventDate: string;
  sourceKind: ChassisEventRow["sourceKind"];
  sourceId: number | null;
  sourceRef?: string | null;
  value?: number | null;
  narration?: string | null;
}): Promise<void> {
  await db
    .insert(chassisEventsTable)
    .values({
      ownerId: input.ownerId,
      chassisNo: input.chassisNo.trim(),
      showroomId: input.showroomId,
      kind: input.kind,
      eventDate: input.eventDate,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceRef: input.sourceRef ?? null,
      value: input.value == null ? null : money(input.value),
      narration: input.narration ?? null,
    })
    .onConflictDoNothing();
}

/**
 * The second reconciliation: the register against the mirror.
 *
 * Where the chassis register says a machine is, against where the dealer's own
 * system says it is. Two sources, and the odd one out names itself — which is
 * the only useful form of this report, because "seven units differ" is a
 * number and "these seven chassis" is a morning's work.
 */
export async function stockPositionCheck(input: {
  ownerId: number;
  asOf: string;
}): Promise<{
  matched: number;
  mismatched: Array<{ chassisNo: string; registerAt: number | null; mirrorAt: number | null }>;
  onlyInRegister: string[];
  onlyInMirror: string[];
}> {
  const branches = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, input.ownerId));
  const branchIds = branches.map((b) => b.id);
  if (branchIds.length === 0)
    return { matched: 0, mismatched: [], onlyInRegister: [], onlyInMirror: [] };

  /*
   * The register's position is the **latest** event that says where a machine
   * is: received or purchased puts it at a branch, sold and written off take it
   * off the floor entirely. Despatched deliberately does not count as arrival,
   * so a machine in transit shows as belonging nowhere and is caught here as a
   * mismatch rather than silently sitting at its origin.
   */
  const events = await db
    .select({
      chassisNo: chassisEventsTable.chassisNo,
      showroomId: chassisEventsTable.showroomId,
      kind: chassisEventsTable.kind,
      eventDate: chassisEventsTable.eventDate,
      id: chassisEventsTable.id,
    })
    .from(chassisEventsTable)
    .where(
      and(
        eq(chassisEventsTable.ownerId, input.ownerId),
        sql`${chassisEventsTable.eventDate}::text <= ${input.asOf}`,
      ),
    )
    .orderBy(asc(chassisEventsTable.eventDate), asc(chassisEventsTable.id));

  const registerAt = new Map<string, number | null>();
  for (const e of events) {
    if (e.kind === "SOLD" || e.kind === "WRITTEN_OFF") registerAt.set(e.chassisNo, null);
    else if (e.kind === "DESPATCHED") registerAt.set(e.chassisNo, null);
    else registerAt.set(e.chassisNo, e.showroomId);
  }

  const mirror = await db
    .select({ chassisNo: dmsVehicleStockTable.chassisNo, showroomId: dmsVehicleStockTable.showroomId })
    .from(dmsVehicleStockTable)
    .where(inArray(dmsVehicleStockTable.showroomId, branchIds));

  const mirrorAt = new Map(mirror.map((m) => [m.chassisNo, m.showroomId]));

  let matched = 0;
  const mismatched: Array<{ chassisNo: string; registerAt: number | null; mirrorAt: number | null }> =
    [];
  const onlyInRegister: string[] = [];

  for (const [chassis, at] of registerAt) {
    if (!mirrorAt.has(chassis)) {
      if (at !== null) onlyInRegister.push(chassis);
      continue;
    }
    const there = mirrorAt.get(chassis)!;
    if (at === there) matched++;
    else mismatched.push({ chassisNo: chassis, registerAt: at, mirrorAt: there });
  }

  const onlyInMirror = [...mirrorAt.keys()].filter((c) => !registerAt.has(c));

  return { matched, mismatched, onlyInRegister, onlyInMirror };
}

/**
 * Shelves the books have driven below zero (OBJ-46).
 *
 * There is **no second source for a part's quantity**, and saying so is the
 * honest part of this function. A chassis can be reconciled because two systems
 * each hold an opinion about where one frame is; a brake shoe has a count, in
 * one place, and the dealer's system will not tell us what it thinks that count
 * became after a transfer nobody keyed into it.
 *
 * So this is not two sources compared. It is **what our own documents imply
 * about a shelf**, and the one implication that cannot be right: a branch
 * cannot hold less than nothing. A negative is a challan that despatched more
 * than the branch had — a miscount, a part issued to a job card and never
 * recorded, or a keying error — and it is worth a row rather than a clamp,
 * because clamping at zero is how the evidence disappears.
 */
export async function negativeShelves(input: {
  ownerId: number;
}): Promise<Array<{ showroomId: number; branchCode: string; partNo: string; qtyOnHand: number }>> {
  const rows = await db
    .select({
      showroomId: dmsPartStockTable.showroomId,
      branchCode: showroomsTable.code,
      partNo: dmsPartStockTable.partNo,
      qtyOnHand: dmsPartStockTable.qtyOnHand,
    })
    .from(dmsPartStockTable)
    .innerJoin(showroomsTable, eq(dmsPartStockTable.showroomId, showroomsTable.id))
    .where(and(eq(showroomsTable.ownerId, input.ownerId), sql`${dmsPartStockTable.qtyOnHand} < 0`))
    .orderBy(asc(showroomsTable.code), asc(dmsPartStockTable.partNo));

  return rows;
}

export { taxWithin };
