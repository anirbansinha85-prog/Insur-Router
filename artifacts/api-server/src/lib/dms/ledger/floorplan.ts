/**
 * Floor plan — the financier is the creditor, and standing still costs money
 * (OBJ-51, R-143, R-144).
 *
 * ## Two defects, and they are different in kind
 *
 * **The liability is against the wrong party.** `postPurchaseInvoice` credits
 * `2100 Sundry Creditors` against the supplier, always. On a floor-plan
 * purchase that is not what happened: the financier paid the manufacturer, and
 * the dealership owes the financier. Hero's ledger shows fifty-seven lakh owed
 * to a company that has already been paid, and the financier — the party who
 * can actually call the money in — is invisible.
 *
 * **The cost is calculated and never posted.** `inventory-worklist.ts` works out
 * interest per unit per day, to the rupee, and puts it on a screen. On this
 * fixture that is **78 unsold financed machines, ₹57.9 lakh at cost, and
 * ₹68,980 of interest** — the second largest cost in the building after
 * salaries, on no profit and loss anywhere.
 *
 * ## Two events, not one
 *
 * The purchase posting is **unchanged**. Buying from Hero and being funded by a
 * financier are two things that happen to one consignment, and collapsing them
 * would lose the input credit's link to Hero's invoice — which is the document
 * the GST return is filed against.
 *
 * ```
 *   the purchase          Dr Vehicle Stock, Dr Input IGST
 *                             Cr Sundry Creditors            → Hero MotoCorp
 *   the drawdown          Dr Sundry Creditors                → Hero MotoCorp
 *                             Cr Floor Plan                  → the financier
 *   every month           Dr Floor Plan Interest
 *                             Cr Floor Plan                  → the financier
 * ```
 *
 * ## Nothing here computes interest
 *
 * `floorPlanInterest` lives in `inventory-worklist.ts`, beside the stock it
 * describes, and this imports it. A dealership told ₹68,980 on the Inventory
 * screen and a different figure in its own books would stop believing both, and
 * a second implementation is how that happens within a month.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  dmsVehicleStockTable,
  showroomsTable,
  purchaseInvoicesTable,
  partiesTable,
  interestAccrualsTable,
  type VoucherRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { floorPlanInterest } from "../inventory-worklist";
import { branchesOfEntity } from "../org";
import { postJournal } from "./journal";

const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);

/** Owed to a financier for stock they funded. Not a bank overdraft. */
export const FLOOR_PLAN = "2110";
/** What the funding costs. Separate from `Interest Paid` deliberately — below. */
export const FLOOR_PLAN_INTEREST = "5430";

export interface FloorPlanUnit {
  chassisNo: string;
  showroomId: number;
  branchCode: string;
  modelDescription: string | null;
  costAmount: number;
  interestRatePct: number;
  receivedDate: string | null;
  days: number;
  perDay: number;
  accrued: number;
}

export interface FloorPlanPosition {
  asOf: string;
  units: FloorPlanUnit[];
  unitCount: number;
  costOnFloor: number;
  interestPerDay: number;
  interestToDate: number;
  /** Financed machines with no rate on them, which cost something and cannot be counted. */
  unratedCount: number;
  warnings: string[];
}

function wholeDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/**
 * What the floor is costing, unit by unit.
 *
 * **Unsold only.** A machine invoiced in June stopped costing interest in June,
 * and a report that kept charging it would inflate a figure a dealership is
 * meant to act on — and the action is to shift ageing stock, so overstating it
 * would send somebody to discount a bike that has already gone.
 */
export async function floorPlanPosition(input: {
  ownerId: number;
  entityId?: number | null;
  showroomId?: number | null;
  asOf: string;
}): Promise<FloorPlanPosition> {
  const warnings: string[] = [];

  const branchIds = input.showroomId
    ? [input.showroomId]
    : input.entityId
      ? await branchesOfEntity(input.entityId)
      : (
          await db
            .select({ id: showroomsTable.id })
            .from(showroomsTable)
            .where(eq(showroomsTable.ownerId, input.ownerId))
        ).map((r) => r.id);

  if (branchIds.length === 0) {
    return {
      asOf: input.asOf,
      units: [],
      unitCount: 0,
      costOnFloor: 0,
      interestPerDay: 0,
      interestToDate: 0,
      unratedCount: 0,
      warnings: ["No branches, so nothing is on any floor."],
    };
  }

  const rows = await db
    .select({
      chassisNo: dmsVehicleStockTable.chassisNo,
      showroomId: dmsVehicleStockTable.showroomId,
      branchCode: showroomsTable.code,
      modelDescription: dmsVehicleStockTable.modelDescription,
      costAmount: dmsVehicleStockTable.costAmount,
      interestRatePct: dmsVehicleStockTable.interestRatePct,
      isFinanced: dmsVehicleStockTable.isFinanced,
      receivedDate: dmsVehicleStockTable.receivedDate,
      invoicedDate: dmsVehicleStockTable.invoicedDate,
    })
    .from(dmsVehicleStockTable)
    .innerJoin(showroomsTable, eq(dmsVehicleStockTable.showroomId, showroomsTable.id))
    .where(
      and(
        inArray(dmsVehicleStockTable.showroomId, branchIds),
        eq(dmsVehicleStockTable.isFinanced, "Y"),
        sql`${dmsVehicleStockTable.invoicedDate} is null`,
      ),
    )
    .orderBy(asc(dmsVehicleStockTable.receivedDate));

  const units: FloorPlanUnit[] = [];
  let unrated = 0;

  for (const r of rows) {
    const days = r.receivedDate ? wholeDays(r.receivedDate, input.asOf) : 0;
    const { perDay, accrued } = floorPlanInterest({
      costAmount: r.costAmount,
      interestRatePct: r.interestRatePct,
      isFinanced: r.isFinanced,
      days,
    });
    if (perDay === null) {
      /*
       * Financed with no rate against it. It costs something and we cannot say
       * what, so it is counted separately rather than folded in at zero - a
       * unit silently contributing nothing to a cost figure is how a dealership
       * comes to believe its floor is cheaper than it is.
       */
      unrated++;
      continue;
    }
    units.push({
      chassisNo: r.chassisNo,
      showroomId: r.showroomId,
      branchCode: r.branchCode,
      modelDescription: r.modelDescription,
      costAmount: round2(n(r.costAmount)),
      interestRatePct: n(r.interestRatePct),
      receivedDate: r.receivedDate,
      days,
      perDay: round2(perDay),
      accrued: round2(accrued!),
    });
  }

  if (unrated > 0) {
    warnings.push(
      `${unrated} financed machine(s) carry no interest rate in the dealer's system, so what they ` +
        "cost cannot be worked out and they are not in these figures. They are not free.",
    );
  }

  return {
    asOf: input.asOf,
    units,
    unitCount: units.length,
    costOnFloor: round2(units.reduce((a, u) => a + u.costAmount, 0)),
    interestPerDay: round2(units.reduce((a, u) => a + u.perDay, 0)),
    interestToDate: round2(units.reduce((a, u) => a + u.accrued, 0)),
    unratedCount: unrated,
    warnings,
  };
}

/**
 * The financier paid the manufacturer, so the debt moves.
 *
 * A liability swap and no money changes hands here — the dealership's bank
 * balance does not move, which is exactly why this is easy to forget and why
 * the creditor stays wrong for months when it is.
 *
 * Posted through `postJournal` rather than around it, so every refusal that
 * function already makes — a locked period, a retired account, an unbalanced
 * entry — applies here without being written twice.
 */
export async function recordDrawdown(input: {
  ownerId: number;
  purchaseInvoiceId: number;
  financierPartyId: number;
  amount: number;
  drawdownDate: string;
  userId?: number | null;
}): Promise<{ ok: boolean; voucher?: VoucherRow; error?: string; warnings: string[] }> {
  const warnings: string[] = [];

  const [invoice] = await db
    .select()
    .from(purchaseInvoicesTable)
    .where(
      and(
        eq(purchaseInvoicesTable.ownerId, input.ownerId),
        eq(purchaseInvoicesTable.id, input.purchaseInvoiceId),
      ),
    );
  if (!invoice) {
    return { ok: false, error: `No purchase invoice ${input.purchaseInvoiceId}.`, warnings };
  }
  if (invoice.status !== "POSTED") {
    return {
      ok: false,
      error: `${invoice.supplierInvoiceNo} is ${invoice.status}. A financier cannot settle a bill that is not in the books.`,
      warnings,
    };
  }

  const [financier] = await db
    .select({ id: partiesTable.id, name: partiesTable.name, kind: partiesTable.kind })
    .from(partiesTable)
    .where(and(eq(partiesTable.ownerId, input.ownerId), eq(partiesTable.id, input.financierPartyId)));
  if (!financier) {
    return { ok: false, error: `No party ${input.financierPartyId}.`, warnings };
  }
  if (financier.kind !== "FINANCIER") {
    /*
     * Refused rather than warned. A drawdown against a customer or the OEM is
     * not a slightly-wrong entry, it is a fifty-lakh liability filed under
     * somebody who does not hold it - and `parties.kind` already knows.
     */
    return {
      ok: false,
      error: `${financier.name} is a ${financier.kind.toLowerCase()}, not a financier. Floor-plan funding is owed to whoever advanced it.`,
      warnings,
    };
  }

  const amount = round2(input.amount);
  const total = round2(n(invoice.totalAmount));
  if (amount <= 0) return { ok: false, error: "A drawdown has to be for something.", warnings };
  if (amount > total + 0.005) {
    return {
      ok: false,
      error: `₹${amount.toFixed(2)} is more than the ₹${total.toFixed(2)} on ${invoice.supplierInvoiceNo}. A financier does not advance more than the bill.`,
      warnings,
    };
  }
  if (amount < total - 0.005) {
    warnings.push(
      `₹${(total - amount).toFixed(2)} of ${invoice.supplierInvoiceNo} is not covered by this drawdown and stays owed to the supplier. That is ordinary — a margin the dealership funds itself — and it is worth being sure it is deliberate.`,
    );
  }

  return postJournal({
    ownerId: input.ownerId,
    showroomId: invoice.showroomId,
    voucherDate: input.drawdownDate,
    narration: `Floor-plan drawdown against ${invoice.supplierInvoiceNo} — ${financier.name} settled the supplier`,
    lines: [
      {
        accountCode: "2100",
        debit: amount,
        partyId: invoice.supplierId,
        narration: "Settled by the financier",
      },
      {
        accountCode: FLOOR_PLAN,
        credit: amount,
        partyId: financier.id,
        narration: `Advanced against ${invoice.supplierInvoiceNo}`,
      },
    ],
    userId: input.userId ?? null,
  }).then((r) => ({ ...r, warnings: [...warnings, ...r.warnings] }));
}

/**
 * Book what the floor cost this period.
 *
 * ## Why there is a table behind this
 *
 * Almost nothing in this module stores a derived figure — the reconciliations,
 * the central end of day and the trial balance are all computed on read,
 * because a stored sum comes to disagree with the things it was a sum of.
 *
 * An accrual is the opposite case and the distinction is worth being clear
 * about: **posting it changes the books.** So the question is no longer *what is
 * the number* but *has this period already been charged* — and that is a fact
 * about what was done, not a figure that can be recomputed. `interest_accruals`
 * answers it, one row per branch per period, and the unique index is what makes
 * charging November twice impossible rather than merely unlikely.
 */
export async function accrueFloorPlanInterest(input: {
  ownerId: number;
  showroomId: number;
  /** `YYYY-MM`. Interest is a monthly charge in every dealership's books. */
  period: string;
  userId?: number | null;
}): Promise<{
  ok: boolean;
  voucher?: VoucherRow;
  amount?: number;
  error?: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  if (!/^\d{4}-\d{2}$/.test(input.period)) {
    return { ok: false, error: `${input.period} is not a month, as YYYY-MM.`, warnings };
  }

  const [y, m] = input.period.split("-").map(Number);
  const from = `${input.period}-01`;
  const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const to = `${input.period}-${String(lastDay).padStart(2, "0")}`;

  const [already] = await db
    .select({ id: interestAccrualsTable.id, amount: interestAccrualsTable.amount })
    .from(interestAccrualsTable)
    .where(
      and(
        eq(interestAccrualsTable.showroomId, input.showroomId),
        eq(interestAccrualsTable.period, input.period),
      ),
    );
  if (already) {
    return {
      ok: false,
      error:
        `${input.period} has already been charged at this branch — ₹${n(already.amount).toFixed(2)}. ` +
        "Charging it twice would double a cost nobody would spot on a monthly report. Reverse that " +
        "voucher if it was wrong.",
      warnings,
    };
  }

  /*
   * The period's charge is the difference between what had accrued by the end
   * of the month and what had accrued by the end of the month before - not the
   * whole accrued figure, which would re-charge every earlier month on every
   * run.
   */
  const atEnd = await floorPlanPosition({
    ownerId: input.ownerId,
    showroomId: input.showroomId,
    asOf: to,
  });
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const atStart = await floorPlanPosition({
    ownerId: input.ownerId,
    showroomId: input.showroomId,
    asOf: dayBefore,
  });

  const amount = round2(atEnd.interestToDate - atStart.interestToDate);
  warnings.push(...atEnd.warnings);

  if (amount <= 0) {
    return {
      ok: false,
      error: `Nothing accrued at this branch in ${input.period} — no financed machine stood on the floor.`,
      warnings,
    };
  }

  /*
   * No financier on the credit side, and it is a real limit rather than an
   * oversight: `dms_vehicle_stock` records *that* a unit is financed and never
   * *by whom*. So the charge lands on the floor-plan account with nobody's name
   * against it, and the dealership reallocates when it has more than one line.
   */
  warnings.push(
    "The dealer's system records that a machine is financed and not by whom, so this charge carries " +
      "no financier's name. With one floor-plan line that is the whole answer; with two it is a " +
      "reallocation somebody has to make.",
  );

  const posted = await postJournal({
    ownerId: input.ownerId,
    showroomId: input.showroomId,
    voucherDate: to,
    narration: `Floor-plan interest for ${input.period} — ${atEnd.unitCount} machine(s) on the floor`,
    lines: [
      { accountCode: FLOOR_PLAN_INTEREST, debit: amount, narration: `${input.period} accrual` },
      { accountCode: FLOOR_PLAN, credit: amount, narration: `${input.period} accrual` },
    ],
    userId: input.userId ?? null,
  });

  if (!posted.ok || !posted.voucher) {
    return { ok: false, error: posted.error, warnings: [...warnings, ...posted.warnings] };
  }

  await db.insert(interestAccrualsTable).values({
    ownerId: input.ownerId,
    showroomId: input.showroomId,
    period: input.period,
    amount: amount.toFixed(2),
    unitCount: atEnd.unitCount,
    voucherId: posted.voucher.id,
    accruedByUserId: input.userId ?? null,
  });

  logger.info(
    { ownerId: input.ownerId, showroomId: input.showroomId, period: input.period, amount },
    "Floor-plan interest accrued",
  );
  return {
    ok: true,
    voucher: posted.voucher,
    amount,
    warnings: [...warnings, ...posted.warnings],
  };
}
