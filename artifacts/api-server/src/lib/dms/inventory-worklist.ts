/**
 * The floor, aged — and matched against the people asking for what is on it.
 *
 * Seventh mirror, and the one that finally joins two modules that have been
 * sitting side by side since the CRM was built. A vehicle standing unsold is
 * not idle; it is on a floor-plan line, and the interest runs every day whether
 * anybody looks at the unit or not. That much is arithmetic the dealership
 * already accepts and has simply never seen attached to a specific chassis.
 *
 * The finding that needs no arithmetic is better:
 *
 * > **A bike has been on this floor for 118 days, and somebody asked for that
 * > exact model nine days ago.**
 *
 * The stock screen cannot see the CRM. The CRM cannot see the floor. Both
 * systems are working correctly and the customer goes to another dealer. That
 * match — `dms_vehicle_stock.modelCode` against `dms_enquiries.modelInterest`,
 * across every outlet the owner holds — is the whole of this module's claim to
 * existing, and it is a join, not a guess.
 *
 * ## Two decisions worth recording
 *
 * `offeredToEnqId` says the match was acted on, and it changes the state so the
 * screen stops proposing the same call every morning. `transferProposedAt` says
 * the unit should move to the outlet whose customer wants it — the spares
 * transfer again, in vehicles, where the sums are two orders of magnitude
 * larger.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import {
  db,
  dmsEnquiriesTable,
  dmsVehicleStockTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { policyForShowroom, type ResolvedPolicy } from "./policy";
import { vehicleSourceFor } from "./ingest";
import { toIsoDate } from "./hero-adapter";
import type { DmsVehicleStock } from "./types";

export interface InventorySyncResult {
  showroomId: number;
  dealerCode: string;
  seen: number;
  added: number;
  changed: number;
  unchanged: number;
  disappeared: number;
  durationMs: number;
}

/**
 * A DMS amount string, kept as a string.
 *
 * The sibling `dms_part_stock` stores money in `real`, and that is a defect
 * worth not repeating here: float4 carries about seven significant digits, so
 * a fleet invoice of ₹1,27,400.50 is already past what it can hold exactly.
 * These columns are `numeric` and the value arrives from the DMS as a decimal
 * string, so the honest thing is to not convert it at all.
 */
function toDecimal(a: string | null | undefined): string | null {
  if (a === null || a === undefined || a.trim() === "") return null;
  return Number.isFinite(Number(a)) ? a.trim() : null;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function project(v: DmsVehicleStock) {
  return {
    engineNo: v.engineNo,
    modelCode: v.modelCode,
    modelDescription: v.modelDesc,
    variantDescription: v.variantDesc,
    colourDescription: v.colourDesc,
    status: v.status,
    allocatedDealId: v.allocatedDealId,
    costAmount: toDecimal(v.costAmt),
    isFinanced: v.financedFlg,
    interestRatePct: toDecimal(v.interestRatePct),
    receivedDate: toIsoDate(v.receivedDt) || null,
    allocatedDate: toIsoDate(v.allocatedDt) || null,
    invoicedDate: toIsoDate(v.invoicedDt) || null,
  };
}

export async function syncShowroomInventory(showroomId: number): Promise<InventorySyncResult[]> {
  const accounts = await db
    .select({ dealerCode: showroomDmsAccountsTable.dealerCode })
    .from(showroomDmsAccountsTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, showroomDmsAccountsTable.showroomId))
    .where(
      and(
        eq(showroomDmsAccountsTable.showroomId, showroomId),
        eq(showroomDmsAccountsTable.isActive, true),
        eq(showroomsTable.isActive, true),
      ),
    );

  const results: InventorySyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncDealerInventory(showroomId, account.dealerCode));
  }
  return results;
}

async function syncDealerInventory(
  showroomId: number,
  dealerCode: string,
): Promise<InventorySyncResult> {
  const startedAt = Date.now();
  /*
   * The one line that makes three paths possible.
   *
   * Everything below is written against a `Source<T>` and cannot tell the OEM's
   * API from a register somebody exported this morning. A dealership nobody has
   * configured resolves to `API` and behaves exactly as it did before.
   */
  const source = await vehicleSourceFor(showroomId, dealerCode);
  const listed = await source.list();
  /*
   * Loaded in one go, and that is not a lost optimisation.
   *
   * This source's `load` filters an array it has already fetched — a
   * parts ledger has no detail view worth a round trip — so listing and
   * loading cost the same call. The unchanged check below still spares
   * the writes, which is where the cost actually was.
   */
  const units = (await source.load(listed.map((l) => l.key))).map((s) => s.record);


  const existing = await db
    .select({ chassisNo: dmsVehicleStockTable.chassisNo, rawHash: dmsVehicleStockTable.rawHash })
    .from(dmsVehicleStockTable)
    .where(eq(dmsVehicleStockTable.showroomId, showroomId));

  const known = new Map(existing.map((r) => [r.chassisNo, r]));

  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const unit of units) {
    const unitHash = hashOf(unit);
    const prior = known.get(unit.chassisNo);
    const now = new Date();

    if (prior && prior.rawHash === unitHash) {
      await db
        .update(dmsVehicleStockTable)
        .set({ lastSyncedAt: now, disappearedAt: null })
        .where(eq(dmsVehicleStockTable.chassisNo, unit.chassisNo));
      unchanged++;
      continue;
    }

    const projected = project(unit);

    if (!prior) {
      await db.insert(dmsVehicleStockTable).values({
        showroomId,
        dealerCode,
        chassisNo: unit.chassisNo,
        ...projected,
        raw: unit as unknown as Record<string, unknown>,
        rawHash: unitHash,
        firstSeenAt: now,
        lastSyncedAt: now,
        lastChangedAt: null,
      });
      added++;
      continue;
    }

    await db
      .update(dmsVehicleStockTable)
      .set({
        showroomId,
        dealerCode,
        ...projected,
        raw: unit as unknown as Record<string, unknown>,
        rawHash: unitHash,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
      })
      .where(eq(dmsVehicleStockTable.chassisNo, unit.chassisNo));
    changed++;
  }

  /*
   * Disappearance, and only where the source is entitled to claim it.
   *
   * An API lists the outlet's whole book every time, so a row that stops
   * appearing has genuinely gone. A report covering one month says nothing
   * about the other eleven — marking everything outside the export as vanished
   * because somebody dropped July's file is the mistake a path-blind sync makes
   * unless it asks.
   */
  const seen = units.map((u) => u.chassisNo);
  const gone = source.listIsComplete
    ? await db
        .update(dmsVehicleStockTable)
        .set({ disappearedAt: new Date() })
        .where(
          and(
            eq(dmsVehicleStockTable.showroomId, showroomId),
            isNull(dmsVehicleStockTable.disappearedAt),
            ...(seen.length > 0 ? [notInArray(dmsVehicleStockTable.chassisNo, seen)] : []),
          ),
        )
        .returning({ chassisNo: dmsVehicleStockTable.chassisNo })
    : [];

  if (seen.length === 0) {
    logger.warn({ dealerCode }, "DMS returned zero vehicles — treating as a fault, not an empty floor");
  }

  const result: InventorySyncResult = {
    showroomId,
    dealerCode,
    seen: units.length,
    added,
    changed,
    unchanged,
    disappeared: gone.length,
    durationMs: Date.now() - startedAt,
  };
  logger.info(result, "DMS vehicle stock sync complete");
  return result;
}

// ── Derivation ──────────────────────────────────────────────────────────────

export type InventoryState =
  | "WANTED_NOW"
  | "STUCK_ALLOCATION"
  | "AGEING_SEVERE"
  | "AGEING"
  | "OFFERED"
  | "FRESH"
  | "SOLD";

/* The dealership's, since OBJ-18. A group financing its floor at a lakh a
 * month cares about day 45; one that owns its stock outright may not care until
 * day 120, and neither is a product opinion. `lib/dms/policy.ts` holds them. */
const AGEING_DAYS = "THRESHOLD.AGEING_DAYS";
const AGEING_SEVERE_DAYS = "THRESHOLD.AGEING_SEVERE_DAYS";
const STUCK_ALLOCATION_DAYS = "THRESHOLD.STUCK_ALLOCATION_DAYS";

export interface MatchingEnquiry {
  enqId: string;
  showroomId: number;
  showroomCode: string | null;
  customerName: string | null;
  customerMobile: string | null;
  stage: string;
  grade: string | null;
  enquiredAt: string | null;
  /** True when the enquiry is at a different outlet from the vehicle. */
  otherOutlet: boolean;
  /** How long this customer has been waiting. Half of why they are first. */
  daysWaiting: number | null;
}

export interface InventoryWorklistRow {
  chassisNo: string;
  dealerCode: string;
  showroomId: number;
  showroomCode: string | null;
  modelCode: string;
  modelDescription: string | null;
  variantDescription: string | null;
  colourDescription: string | null;
  dms: {
    engineNo: string | null;
    status: string;
    allocatedDealId: string | null;
    costAmount: number | null;
    isFinanced: boolean;
    interestRatePct: number | null;
    receivedDate: string | null;
    allocatedDate: string | null;
    invoicedDate: string | null;
  };
  ddms: {
    offeredToEnqId: string | null;
    offeredAt: string | null;
    transferProposedAt: string | null;
    transferToShowroomId: number | null;
  };
  state: InventoryState;
  note: string | null;
  actionRequired: string | null;
  /**
   * Days on the floor. The number nothing in the dealer's system computes.
   *
   * Measured to the invoice date once the unit has sold, not to today: a bike
   * that left in June does not go on ageing, and a screen that said it did
   * would be reporting a cost the dealership stopped paying.
   */
  ageDays: number;
  /** Days since somebody put a customer's name on it and nothing happened. */
  allocatedDays: number | null;
  /** What the floor-plan line charges for this unit, per day. Null if unfinanced. */
  interestPerDay: number | null;
  /** What it has cost so far. Cost × rate × days, and nobody disputes the sum. */
  interestAccrued: number | null;
  /**
   * The best few open enquiries for this model, **ordered**, across every
   * outlet the owner holds. Capped for display — see `matchingEnquiryCount`
   * for how many there actually are.
   */
  matchingEnquiries: MatchingEnquiry[];
  /**
   * How many there are in total, which is **not** `matchingEnquiries.length`.
   *
   * It was, and the note said so: *"5 people are asking for this model"* on a
   * model with twenty-one live enquiries against it. The display cap had become
   * the reported figure, so a dealership read its own demand at a quarter of
   * the truth. Two fields now, because they answer two questions.
   */
  matchingEnquiryCount: number;
  lastSyncedAt: string;
  disappearedFromDms: boolean;
}

function wholeDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/** Enquiry stages that mean somebody is still deciding. */
const LIVE_STAGES = new Set(["NEW", "CONTACTED", "QUOTED", "TEST_RIDE", "NEGOTIATION", "BOOKED"]);

/**
 * Who to offer a unit to, and **why that person**.
 *
 * The first version answered `matches[0]` — whichever row Postgres happened to
 * return first. On one HF Deluxe that meant sending a salesman to a `COLD`
 * enquiry while three `HOT` ones waited, and the screen could give no reason
 * because there was none. *"Why is it offering to her?"* had no answer, which
 * is a worse failure than a wrong answer: an unexplained instruction is one
 * nobody can overrule on the evidence.
 *
 * Two keys, in this order, because a dealership can say both out loud:
 *
 *   1. **the grade the salesman gave them** — their own judgement of the
 *      customer, and not ours to second-guess
 *   2. **how long they have waited** — among equals, the one who asked first
 *
 * Deliberately *not* the stage. A `NEGOTIATION` is further along than a `NEW`
 * and it is a different question — *closest to closing* rather than *most
 * likely to buy* — and mixing them makes the sentence on the row two clauses
 * that argue with each other. The stage travels on the row so a person can see
 * it and disagree.
 */
const GRADE_RANK: Record<string, number> = { HOT: 0, WARM: 1, COLD: 2 };

function bestFirst(a: MatchingEnquiry, b: MatchingEnquiry): number {
  const ga = GRADE_RANK[a.grade ?? ""] ?? 3;
  const gb = GRADE_RANK[b.grade ?? ""] ?? 3;
  if (ga !== gb) return ga - gb;
  // Longest wait first. A null date sorts last: an enquiry with no date is not
  // evidence of patience.
  const wa = a.daysWaiting ?? -1;
  const wb = b.daysWaiting ?? -1;
  if (wa !== wb) return wb - wa;
  return a.enqId.localeCompare(b.enqId);
}

/** Why this customer and not one of the other twenty. One clause. */
function whyThisOne(m: MatchingEnquiry, total: number): string {
  const grade =
    m.grade === "HOT" ? "the hottest" : m.grade === "WARM" ? "the warmest" : "the longest-waiting";
  const of = total > 1 ? ` of the ${total} asking` : "";
  const waited = m.daysWaiting === null ? "" : `, waiting ${m.daysWaiting} day${m.daysWaiting === 1 ? "" : "s"}`;
  return `${grade}${of}${waited}`;
}

export interface InventoryWorklistOptions {
  /** The dealership's numbers. Resolved from the outlet when absent — see
   *  `policyForShowroom`, and note that it is never silently defaulted. */
  policy?: ResolvedPolicy;
  showroomId: number;
  /** Every outlet this owner holds — the enquiry match reads all of them. */
  ownerShowroomIds: number[];
  includeDisappeared?: boolean;
}

export async function buildInventoryWorklist(
  opts: InventoryWorklistOptions,
): Promise<InventoryWorklistRow[]> {
  const policy = opts.policy ?? (await policyForShowroom(opts.showroomId));
  const scope = opts.ownerShowroomIds.length > 0 ? opts.ownerShowroomIds : [opts.showroomId];

  const [units, enquiries] = await Promise.all([
    db
      .select({ v: dmsVehicleStockTable, showroomCode: showroomsTable.code })
      .from(dmsVehicleStockTable)
      .innerJoin(showroomsTable, eq(showroomsTable.id, dmsVehicleStockTable.showroomId))
      .where(
        and(
          eq(dmsVehicleStockTable.showroomId, opts.showroomId),
          opts.includeDisappeared ? undefined : isNull(dmsVehicleStockTable.disappearedAt),
        ),
      ),
    // Across the group, and that is the point. A customer who walked into the
    // Pune showroom asking for a model standing on the Delhi floor is exactly
    // the case neither branch can see.
    db
      .select({ e: dmsEnquiriesTable, showroomCode: showroomsTable.code })
      .from(dmsEnquiriesTable)
      .innerJoin(showroomsTable, eq(showroomsTable.id, dmsEnquiriesTable.showroomId))
      .where(
        and(inArray(dmsEnquiriesTable.showroomId, scope), isNull(dmsEnquiriesTable.disappearedAt)),
      ),
  ]);

  const byModel = new Map<string, MatchingEnquiry[]>();
  for (const { e, showroomCode } of enquiries) {
    if (!e.modelInterest || !LIVE_STAGES.has(e.stage)) continue;
    const list = byModel.get(e.modelInterest) ?? [];
    list.push({
      enqId: e.enqId,
      showroomId: e.showroomId,
      showroomCode,
      customerName: e.customerName,
      customerMobile: e.customerMobile,
      stage: e.stage,
      grade: e.grade,
      enquiredAt: e.enquiredAt?.toISOString() ?? null,
      otherOutlet: e.showroomId !== opts.showroomId,
      daysWaiting: e.enquiredAt ? wholeDaysBetween(e.enquiredAt, new Date()) : null,
    });
    byModel.set(e.modelInterest, list);
  }

  const now = new Date();
  const num = (v: string | null) => (v === null ? null : Number(v));

  return units.map(({ v, showroomCode }) => {
    const received = v.receivedDate ? new Date(`${v.receivedDate}T00:00:00`) : null;
    // A sold unit stopped costing money the day it was invoiced. Measuring to
    // *today* meant an invoiced bike went on ageing for ever and its interest
    // figure kept climbing — a number about a vehicle that is no longer in the
    // building. The clock stops where the liability did.
    const until = v.invoicedDate ? new Date(`${v.invoicedDate}T00:00:00`) : now;
    const ageDays = received ? wholeDaysBetween(received, until) : 0;
    const allocated = v.allocatedDate ? new Date(`${v.allocatedDate}T00:00:00`) : null;
    const allocatedDays = allocated ? wholeDaysBetween(allocated, now) : null;

    const cost = num(v.costAmount);
    const rate = num(v.interestRatePct);
    const financed = v.isFinanced === "Y";
    const interestPerDay = financed && cost && rate ? (cost * (rate / 100)) / 365 : null;
    const interestAccrued = interestPerDay === null ? null : interestPerDay * ageDays;

    // Only offer the match on units that are actually available. A vehicle
    // already invoiced to somebody is not an answer to anybody's enquiry, and
    // showing it as one would send a salesperson to sell a bike that has gone.
    const allMatches = v.status === "INVOICED" ? [] : (byModel.get(v.modelCode) ?? []);
    // Ordered before it is cut, or the cap decides who is best.
    const matches = [...allMatches].sort(bestFirst).slice(0, 5);

    const { state, note, action } = classify(
      v.status,
      ageDays,
      allocatedDays,
      matches,
      allMatches.length,
      v.offeredToEnqId,
      interestAccrued,
      showroomCode,
      policy,
    );

    return {
      chassisNo: v.chassisNo,
      dealerCode: v.dealerCode,
      showroomId: v.showroomId,
      showroomCode,
      modelCode: v.modelCode,
      modelDescription: v.modelDescription,
      variantDescription: v.variantDescription,
      colourDescription: v.colourDescription,
      dms: {
        engineNo: v.engineNo,
        status: v.status,
        allocatedDealId: v.allocatedDealId,
        costAmount: cost,
        isFinanced: financed,
        interestRatePct: rate,
        receivedDate: v.receivedDate,
        allocatedDate: v.allocatedDate,
        invoicedDate: v.invoicedDate,
      },
      ddms: {
        offeredToEnqId: v.offeredToEnqId,
        offeredAt: v.offeredAt?.toISOString() ?? null,
        transferProposedAt: v.transferProposedAt?.toISOString() ?? null,
        transferToShowroomId: v.transferToShowroomId,
      },
      state,
      note,
      actionRequired: action,
      ageDays,
      allocatedDays,
      interestPerDay,
      interestAccrued,
      matchingEnquiries: matches,
      matchingEnquiryCount: allMatches.length,
      lastSyncedAt: v.lastSyncedAt.toISOString(),
      disappearedFromDms: v.disappearedAt !== null,
    };
  });
}

function classify(
  status: string,
  ageDays: number,
  allocatedDays: number | null,
  /** The shortlist, best first. */
  matches: MatchingEnquiry[],
  /** How many there are altogether, which the shortlist's length is not. */
  matchCount: number,
  offeredToEnqId: string | null,
  interestAccrued: number | null,
  showroomCode: string | null,
  policy: ResolvedPolicy,
): { state: InventoryState; note: string | null; action: string | null } {
  if (status === "INVOICED") {
    return { state: "SOLD", note: null, action: null };
  }

  const cost =
    interestAccrued && interestAccrued > 0
      ? ` ${inr(interestAccrued)} of interest so far.`
      : "";

  // An allocation nobody invoiced is its own failure and outranks ageing: the
  // unit is held out of stock *and* out of sales, and an ageing report filtered
  // on IN_STOCK cannot see it at all.
  if (
    status === "ALLOCATED" &&
    allocatedDays !== null &&
    allocatedDays > policy.days(STUCK_ALLOCATION_DAYS)
  ) {
    return {
      state: "STUCK_ALLOCATION",
      note: `Allocated ${allocatedDays} days ago and never invoiced. It is neither sellable nor sold.${cost}`,
      action: "Close the deal or release the unit back to stock",
    };
  }

  /*
   * Somebody has been shown this unit, and that is a fact about the unit.
   *
   * This used to be checked *inside* the ageing branch, so being offered was
   * only ever reported as a side effect of the unit also being old enough to
   * count as ageing. Raising the ageing threshold made it visible: two units
   * somebody had been offered fell straight through to `AGEING_SEVERE`, whose
   * note reads *"nobody has asked for it"* — a plainly false claim about a unit
   * a salesman had shown to a named customer.
   *
   * Same rule as the registration classifier learned in OBJ-4: **derived state
   * describes a cause, not a consequence.** Being offered is a cause. Ageing is
   * a separate axis, and the ageing figure travels on the row either way.
   */
  if (offeredToEnqId) {
    return {
      state: "OFFERED",
      note: `On the floor ${ageDays} days. Offered against ${offeredToEnqId}.${cost}`,
      action: null,
    };
  }

  if (matches.length > 0 && ageDays >= policy.days(AGEING_DAYS)) {
    const first = matches[0]!;
    const where = first.otherOutlet
      ? ` — at ${first.showroomCode ?? "another outlet"}, not ${showroomCode ?? "this one"}`
      : "";
    return {
      state: "WANTED_NOW",
      note:
        `On the floor ${ageDays} days, with ${matchCount === 1 ? "one open enquiry" : `${matchCount} open enquiries`} ` +
        `for this model${where}.${cost}`,
      // Who, and why them. An instruction with a reason attached is one
      // somebody can overrule on the evidence; one without is an order.
      action: `Offer it to ${first.customerName ?? first.enqId} — ${whyThisOne(first, matchCount)}`,
    };
  }

  if (ageDays >= policy.days(AGEING_SEVERE_DAYS)) {
    return {
      state: "AGEING_SEVERE",
      note: `On the floor ${ageDays} days with no open enquiries for this model.${cost}`,
      action: "Discount it, move it to another outlet, or accept the carrying cost",
    };
  }

  if (ageDays >= policy.days(AGEING_DAYS)) {
    return {
      state: "AGEING",
      note: `On the floor ${ageDays} days.${cost}`,
      action: null,
    };
  }

  return { state: "FRESH", note: null, action: null };
}

export interface InventoryWorklistSummary {
  total: number;
  byState: Record<InventoryState, number>;
  needsAction: number;
  /** Cost of every unit not yet invoiced. What the floor-plan line is funding. */
  capitalTiedUp: number;
  /** Interest already paid on units still standing. The number that stings. */
  interestAccrued: number;
  /** What another week of doing nothing costs. */
  interestPerDay: number;
  /**
  * Aged units somebody is actively asking for — the `WANTED_NOW` count, and
  * the number to lead with.
  *
  * Deliberately not "units with a matching enquiry", which was the first
  * version and was five where this is two. A fresh unit matching an enquiry is
  * a showroom working normally; the finding is a bike that has been standing
  * *and* somebody has been asking for it, and inflating the headline with the
  * former buries the latter.
  */
  wanted: number;
  oldestDays: number;
  lastSyncedAt: string | null;
}

export function summariseInventory(rows: InventoryWorklistRow[]): InventoryWorklistSummary {
  const byState = {
    WANTED_NOW: 0,
    STUCK_ALLOCATION: 0,
    AGEING_SEVERE: 0,
    AGEING: 0,
    OFFERED: 0,
    FRESH: 0,
    SOLD: 0,
  } as Record<InventoryState, number>;

  let capitalTiedUp = 0;
  let interestAccrued = 0;
  let interestPerDay = 0;
  let needsAction = 0;
  let wanted = 0;
  let oldestDays = 0;
  let lastSyncedAt: string | null = null;

  for (const row of rows) {
    byState[row.state]++;
    if (row.actionRequired) needsAction++;
    if (row.state !== "SOLD") {
      capitalTiedUp += row.dms.costAmount ?? 0;
      interestAccrued += row.interestAccrued ?? 0;
      interestPerDay += row.interestPerDay ?? 0;
      oldestDays = Math.max(oldestDays, row.ageDays);
      if (row.state === "WANTED_NOW") wanted++;
    }
    if (!lastSyncedAt || row.lastSyncedAt > lastSyncedAt) lastSyncedAt = row.lastSyncedAt;
  }

  return {
    total: rows.length,
    byState,
    needsAction,
    capitalTiedUp,
    interestAccrued,
    interestPerDay,
    wanted,
    oldestDays,
    lastSyncedAt,
  };
}
