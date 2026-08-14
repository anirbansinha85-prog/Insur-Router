/**
 * The morning allocation (OBJ-47).
 *
 * A hub-and-spoke dealership does this before the shutters go up: the stockyard
 * looks at what each satellite has sold, what each has standing on its floor,
 * and sends out the day's machines. Until now the product could record it one
 * challan at a time — which is the document, and not the decision. Six challans
 * typed one after another is six chances to send the wrong bike to the wrong
 * branch, and no artefact anywhere saying what the morning's plan actually was.
 *
 * > **One morning's allocation is one decision. It is still as many documents
 * > as the law requires.**
 *
 * That sentence is the whole design and both halves matter. A delivery challan
 * carries one consignor and one consignee, so three destinations is three
 * challans and there is no version of this that makes it one piece of paper.
 * What becomes one is the *choosing*: `planAllocation` produces a plan across
 * every destination at once, a person looks at it whole, and `commitAllocation`
 * turns the approved plan into the documents.
 *
 * ## Nothing here decides anything a person cannot re-derive
 *
 * No model, and nowhere one could go (R-49, R-100's shape one module along).
 * Demand is a count of open bookings; supply is a query over the yard; the
 * match is oldest-first. Every line carries `because`, which is the sentence
 * that made it — because an instruction with no reason behind it is worse than
 * a wrong one, and nobody can overrule it on the evidence.
 *
 * ## The plan writes nothing
 *
 * `planAllocation` is a read. It can be run at seven in the morning, looked at,
 * ignored, and run again after a booking comes in, and the yard is exactly as
 * it was. That is what makes it safe to put in front of somebody: the only
 * function here that changes anything **refuses without a named approver**.
 */

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  showroomsTable,
  dmsVehicleStockTable,
  saleDocumentsTable,
  stockMovesTable,
  stockMoveLinesTable,
  type StockMoveRow,
} from "@workspace/db";

import { branchesOfEntity, placementOf, type BranchRole } from "../org";
import { loadPolicy } from "../policy";
import { createStockMove, despatchStockMove } from "./moves";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * Which branches sell machines, decided by **role** rather than by name.
 *
 * A service outlet has no showroom floor and no salesman, so allocating stock
 * to it puts a motorcycle in a workshop where the only thing that can happen to
 * it is that somebody moves it out of the way. This is exactly what OBJ-37's
 * `role` column was for: the planner never knows a branch by name, so the same
 * code runs for a dealership with one satellite and for one with nine.
 */
const SELLS: BranchRole[] = ["SALES", "PREMIUM"];

/** What one branch wants of one model, and how the figure was arrived at. */
export interface AllocationDemand {
  showroomId: number;
  branchCode: string;
  branchName: string;
  role: BranchRole;
  modelDescription: string;
  /** Customers who have booked and have no machine against their name yet. */
  committed: number;
  /** What is standing there now, unsold. */
  onFloor: number;
  /** The dealership's own number, from the policy registry. */
  floor: number;
  /** `committed` plus whatever the floor is short by. Never negative. */
  want: number;
}

/** One machine, going one place, for one stated reason. */
export interface AllocationLine {
  showroomId: number;
  branchCode: string;
  branchName: string;
  chassisNo: string;
  modelDescription: string;
  value: number;
  /** How long it has been standing in the yard. Oldest goes first. */
  daysInYard: number | null;
  because: string;
}

export interface AllocationPlan {
  ownerId: number;
  entityId: number;
  hubShowroomId: number;
  hubName: string;
  planDate: string;
  demand: AllocationDemand[];
  lines: AllocationLine[];
  /** What was asked for and is not in the yard. Named, never quietly dropped. */
  shortfalls: Array<{
    branchCode: string;
    modelDescription: string;
    wanted: number;
    allocated: number;
    note: string;
  }>;
  /** The numbers this plan was built on, printed so a disagreement is actionable. */
  usedNumbers: { displayFloor: number; maxPerBranch: number };
  warnings: string[];
}

/**
 * Work out the morning's allocation. Reads only.
 *
 * ## Demand, and what it deliberately does not count
 *
 * A satellite's demand is **open bookings** — a quotation or proforma issued at
 * that branch with no chassis against it — plus whatever its display floor is
 * short by. An enquiry is not demand: somebody who walked in and asked the
 * price has not asked for a machine to be moved across Delhi, and counting
 * interest as commitment is how a yard empties into showrooms and a dealership
 * finances stock it has not sold.
 *
 * ## Supply, and the three things that disqualify a machine
 *
 * Standing in the hub's yard, **not** allocated to a deal, **not** already on
 * an open challan. The third is the one that would otherwise bite: a plan run
 * twice in a morning would propose the same six machines the first run has
 * already sent, and the refusal in `createStockMove` would only surface it
 * after somebody had approved it.
 *
 * ## Oldest first
 *
 * Ageing stock is stock the dealership is paying interest on, so the machine
 * that has stood longest is the one worth moving to where somebody might sit on
 * it. It is also **deterministic**, which matters more than it sounds: two runs
 * of the same plan propose the same machines, so a person comparing a plan to
 * the one they looked at ten minutes ago is comparing like with like.
 */
export async function planAllocation(input: {
  ownerId: number;
  entityId: number;
  hubShowroomId: number;
  planDate: string;
  /** Restrict to these destinations. Absent means every selling branch. */
  toShowroomIds?: number[];
}): Promise<AllocationPlan> {
  const warnings: string[] = [];
  const hub = await placementOf(input.hubShowroomId);
  if (hub.entity.id !== input.entityId) {
    throw new Error(
      `${hub.branchName} belongs to ${hub.entity.legalName}, which is not the company this plan is for. ` +
        "Stock does not move between two companies on a challan.",
    );
  }
  if (hub.role !== "HUB") {
    warnings.push(
      `${hub.branchName} is a ${hub.role} branch and this plan allocates out of it as though it were the ` +
        "stockyard. That may well be right — a dealership with no hub allocates from wherever the stock is — " +
        "but it is worth knowing the plan is not reading the branch you may think it is.",
    );
  }

  const policy = await loadPolicy(input.ownerId);
  const displayFloor = policy.number("ALLOCATION.DISPLAY_FLOOR");
  const maxPerBranch = policy.number("ALLOCATION.MAX_PER_BRANCH");

  const branchIds = await branchesOfEntity(input.entityId);
  const branches = await db
    .select({
      id: showroomsTable.id,
      code: showroomsTable.code,
      name: showroomsTable.name,
      role: showroomsTable.role,
    })
    .from(showroomsTable)
    .where(inArray(showroomsTable.id, branchIds))
    .orderBy(asc(showroomsTable.code));

  const destinations = branches.filter(
    (b) =>
      b.id !== input.hubShowroomId &&
      SELLS.includes(b.role as BranchRole) &&
      (!input.toShowroomIds || input.toShowroomIds.includes(b.id)),
  );

  const skipped = branches.filter(
    (b) => b.id !== input.hubShowroomId && !SELLS.includes(b.role as BranchRole),
  );
  for (const s of skipped) {
    warnings.push(
      `${s.name} is a ${s.role} branch, so nothing is allocated to it. A workshop has no floor to display a machine on.`,
    );
  }

  if (destinations.length === 0) {
    return {
      ownerId: input.ownerId,
      entityId: input.entityId,
      hubShowroomId: input.hubShowroomId,
      hubName: hub.branchName,
      planDate: input.planDate,
      demand: [],
      lines: [],
      shortfalls: [],
      usedNumbers: { displayFloor, maxPerBranch },
      warnings: [
        ...warnings,
        "This company has no selling branch other than the hub, so there is nothing to allocate to.",
      ],
    };
  }

  const destIds = destinations.map((d) => d.id);
  const byId = new Map(destinations.map((d) => [d.id, d]));

  // ── demand: open bookings ───────────────────────────────────────────────
  const bookings = await db
    .select({
      showroomId: saleDocumentsTable.showroomId,
      modelDescription: saleDocumentsTable.modelDescription,
      count: sql<number>`count(*)::int`,
    })
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, input.ownerId),
        inArray(saleDocumentsTable.showroomId, destIds),
        inArray(saleDocumentsTable.kind, ["QUOTATION", "PROFORMA"]),
        eq(saleDocumentsTable.status, "ISSUED"),
        /*
         * No chassis on the document means nobody has picked the machine yet,
         * which is precisely what makes it demand. A quotation that already
         * names a frame is a machine somebody has committed and is a different
         * problem — it is either at the branch or it is late.
         */
        or(isNull(saleDocumentsTable.chassisNo), eq(saleDocumentsTable.chassisNo, "")),
      ),
    )
    .groupBy(saleDocumentsTable.showroomId, saleDocumentsTable.modelDescription);

  // ── supply: what is standing at each branch, and in the hub's yard ───────
  const floorRows = await db
    .select({
      showroomId: dmsVehicleStockTable.showroomId,
      chassisNo: dmsVehicleStockTable.chassisNo,
      modelDescription: dmsVehicleStockTable.modelDescription,
      costAmount: dmsVehicleStockTable.costAmount,
      receivedDate: dmsVehicleStockTable.receivedDate,
      allocatedDealId: dmsVehicleStockTable.allocatedDealId,
      invoicedDate: dmsVehicleStockTable.invoicedDate,
    })
    .from(dmsVehicleStockTable)
    .where(inArray(dmsVehicleStockTable.showroomId, [input.hubShowroomId, ...destIds]));

  const unsold = floorRows.filter((r) => !r.invoicedDate);

  /*
   * Every chassis already on a challan that has not arrived. A plan that
   * proposed one of these would be proposing to send a machine that is on a van
   * — and the refusal would only arrive after somebody had approved the plan,
   * which is the worst place to put it.
   */
  const openLines = await db
    .select({ chassisNo: stockMoveLinesTable.chassisNo })
    .from(stockMoveLinesTable)
    .innerJoin(stockMovesTable, eq(stockMoveLinesTable.stockMoveId, stockMovesTable.id))
    .where(
      and(
        eq(stockMovesTable.ownerId, input.ownerId),
        inArray(stockMovesTable.status, ["DRAFT", "IN_TRANSIT"]),
        eq(stockMoveLinesTable.kind, "VEHICLE"),
      ),
    );
  const onAChallan = new Set(openLines.map((l) => l.chassisNo).filter((c): c is string => !!c));

  const planMs = Date.parse(input.planDate);
  const yard = unsold
    .filter(
      (r) =>
        r.showroomId === input.hubShowroomId && !r.allocatedDealId && !onAChallan.has(r.chassisNo),
    )
    .map((r) => ({
      ...r,
      model: r.modelDescription ?? "(unnamed model)",
      daysInYard: r.receivedDate
        ? Math.floor((planMs - Date.parse(r.receivedDate)) / 86_400_000)
        : null,
    }))
    /* Oldest first, then by chassis so two runs agree. */
    .sort(
      (a, b) =>
        (b.daysInYard ?? -1) - (a.daysInYard ?? -1) || a.chassisNo.localeCompare(b.chassisNo),
    );

  const onFloorAt = new Map<string, number>();
  for (const r of unsold) {
    if (r.showroomId === input.hubShowroomId) continue;
    const key = `${r.showroomId}|${r.modelDescription ?? "(unnamed model)"}`;
    onFloorAt.set(key, (onFloorAt.get(key) ?? 0) + 1);
  }

  // ── put the two together ────────────────────────────────────────────────
  const wanted = new Map<string, AllocationDemand>();

  for (const b of bookings) {
    const branch = byId.get(b.showroomId)!;
    const model = b.modelDescription ?? "(unnamed model)";
    const key = `${b.showroomId}|${model}`;
    const onFloor = onFloorAt.get(key) ?? 0;
    wanted.set(key, {
      showroomId: b.showroomId,
      branchCode: branch.code,
      branchName: branch.name,
      role: branch.role as BranchRole,
      modelDescription: model,
      committed: b.count,
      onFloor,
      floor: displayFloor,
      want: b.count + Math.max(0, displayFloor - onFloor),
    });
  }

  /*
   * A model a branch sells and has none of is demand even with no booking
   * behind it, because an empty floor sells nothing. Which models a branch
   * "sells" is read from what it has actually sold — not from a list somebody
   * maintains, which would be a second thing to keep true.
   */
  const sold = await db
    .select({
      showroomId: saleDocumentsTable.showroomId,
      modelDescription: saleDocumentsTable.modelDescription,
    })
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, input.ownerId),
        inArray(saleDocumentsTable.showroomId, destIds),
        inArray(saleDocumentsTable.kind, ["TAX_INVOICE", "SALE_CONFIRMATION"]),
        eq(saleDocumentsTable.status, "ISSUED"),
      ),
    );

  for (const s of sold) {
    const model = s.modelDescription ?? "(unnamed model)";
    const key = `${s.showroomId}|${model}`;
    if (wanted.has(key)) continue;
    const branch = byId.get(s.showroomId);
    if (!branch) continue;
    const onFloor = onFloorAt.get(key) ?? 0;
    if (onFloor >= displayFloor) continue;
    wanted.set(key, {
      showroomId: s.showroomId,
      branchCode: branch.code,
      branchName: branch.name,
      role: branch.role as BranchRole,
      modelDescription: model,
      committed: 0,
      onFloor,
      floor: displayFloor,
      want: displayFloor - onFloor,
    });
  }

  const demand: AllocationDemand[] = [...wanted.values()].sort(
    (a, b) =>
      a.branchCode.localeCompare(b.branchCode) ||
      b.committed - a.committed ||
      a.modelDescription.localeCompare(b.modelDescription),
  );

  /*
   * The match. Committed demand across every branch is served before any
   * display floor anywhere — a customer who has booked outranks an empty spot
   * on a plinth, whichever branch each is at. Serving branch by branch instead
   * would let the first branch in alphabetical order take the last machine for
   * its window while a customer at the last one waits.
   */
  const taken = new Set<string>();
  const perBranch = new Map<number, number>();
  const lines: AllocationLine[] = [];
  const shortfalls: AllocationPlan["shortfalls"] = [];
  const allocatedFor = new Map<string, number>();
  let trimmed = 0;

  const passes: Array<{ label: "COMMITTED" | "FLOOR"; of: (d: AllocationDemand) => number }> = [
    { label: "COMMITTED", of: (d) => d.committed },
    { label: "FLOOR", of: (d) => d.want - d.committed },
  ];

  for (const pass of passes) {
    for (const d of demand) {
      let need = pass.of(d);
      if (need <= 0) continue;
      const key = `${d.showroomId}|${d.modelDescription}`;
      let ranOut = false;

      while (need > 0) {
        if ((perBranch.get(d.showroomId) ?? 0) >= maxPerBranch) {
          trimmed += need;
          break;
        }
        const pick = yard.find((y) => y.model === d.modelDescription && !taken.has(y.chassisNo));
        if (!pick) {
          ranOut = true;
          break;
        }

        taken.add(pick.chassisNo);
        perBranch.set(d.showroomId, (perBranch.get(d.showroomId) ?? 0) + 1);
        allocatedFor.set(key, (allocatedFor.get(key) ?? 0) + 1);
        lines.push({
          showroomId: d.showroomId,
          branchCode: d.branchCode,
          branchName: d.branchName,
          chassisNo: pick.chassisNo,
          modelDescription: d.modelDescription,
          value: round2(n(pick.costAmount)),
          daysInYard: pick.daysInYard,
          because:
            pass.label === "COMMITTED"
              ? `${d.committed} customer(s) at ${d.branchName} have booked a ${d.modelDescription} and no machine is against their name`
              : `${d.branchName} has ${d.onFloor} of ${d.modelDescription} on the floor and keeps ${d.floor}`,
        });
        need--;
      }

      if (ranOut) {
        shortfalls.push({
          branchCode: d.branchCode,
          modelDescription: d.modelDescription,
          wanted: d.want,
          allocated: allocatedFor.get(key) ?? 0,
          note:
            pass.label === "COMMITTED"
              ? "A customer is waiting and there is no unallocated machine of this model in the yard. That is an order to place on the manufacturer, not an allocation to make."
              : "The floor stays short of this model because the yard has none spare.",
        });
      }
    }
  }

  if (trimmed > 0) {
    warnings.push(
      `${trimmed} machine(s) were asked for and not proposed because a branch had already reached its ceiling of ` +
        `${maxPerBranch} for one morning. They are not lost — the next run will offer them again.`,
    );
  }

  return {
    ownerId: input.ownerId,
    entityId: input.entityId,
    hubShowroomId: input.hubShowroomId,
    hubName: hub.branchName,
    planDate: input.planDate,
    demand,
    lines,
    shortfalls,
    usedNumbers: { displayFloor, maxPerBranch },
    warnings,
  };
}

/**
 * Turn an approved plan into documents.
 *
 * **Refuses without a named approver, and that refusal is the objective.** Every
 * other guard in this file protects the dealership from a bad allocation; this
 * one is R-49 written as control flow. A plan is a proposal, and a proposal that
 * can commit itself is not a proposal — it is an automation somebody will
 * discover after the van has gone.
 *
 * One challan per destination, because a delivery challan carries one consignee
 * and there is no arrangement of this that makes three destinations one
 * document. Despatched immediately, because the plan **is** the morning: a
 * challan raised and left in draft is a machine the branch is expecting and the
 * yard still thinks it has.
 *
 * A destination that fails does not take the others down with it. The van to
 * Dwarka going out is not conditional on the van to Janakpuri, and rolling the
 * whole morning back because one branch's challan was refused would be the
 * product being tidier than the business.
 */
export async function commitAllocation(input: {
  plan: AllocationPlan;
  approvedByUserId: number | null;
  approvedByName: string;
}): Promise<{
  ok: boolean;
  moves: StockMoveRow[];
  failures: Array<{ branchCode: string; error: string }>;
  error?: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const { plan } = input;

  if (input.approvedByUserId == null) {
    return {
      ok: false,
      moves: [],
      failures: [],
      error:
        "This allocation has nobody's name against it. A plan is a proposal — the product works out what " +
        "should move and a person decides that it does. Nothing is despatched until somebody has approved it.",
      warnings,
    };
  }
  if (plan.lines.length === 0) {
    return {
      ok: false,
      moves: [],
      failures: [],
      error: "This plan allocates nothing, so there is nothing to despatch.",
      warnings,
    };
  }

  const byBranch = new Map<number, AllocationLine[]>();
  for (const l of plan.lines) {
    const list = byBranch.get(l.showroomId) ?? [];
    list.push(l);
    byBranch.set(l.showroomId, list);
  }

  const moves: StockMoveRow[] = [];
  const failures: Array<{ branchCode: string; error: string }> = [];

  const destinations = [...byBranch.entries()].sort((a, b) =>
    a[1][0]!.branchCode.localeCompare(b[1][0]!.branchCode),
  );

  for (const [showroomId, branchLines] of destinations) {
    const branchCode = branchLines[0]!.branchCode;
    const created = await createStockMove({
      ownerId: plan.ownerId,
      fromShowroomId: plan.hubShowroomId,
      toShowroomId: showroomId,
      challanDate: plan.planDate,
      lines: branchLines.map((l) => ({
        chassisNo: l.chassisNo,
        modelDescription: l.modelDescription,
        value: l.value,
      })),
      narration: `Morning allocation ${plan.planDate}, approved by ${input.approvedByName}`,
      userId: input.approvedByUserId,
    });

    warnings.push(...created.warnings);
    if (!created.ok || !created.move) {
      failures.push({ branchCode, error: created.error ?? "the challan was refused" });
      continue;
    }

    const sent = await despatchStockMove({
      ownerId: plan.ownerId,
      stockMoveId: created.move.id,
      userId: input.approvedByUserId,
    });
    warnings.push(...sent.warnings);
    moves.push(sent.move ?? created.move);
  }

  return { ok: failures.length === 0, moves, failures, warnings };
}
