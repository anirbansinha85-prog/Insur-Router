/**
 * The runtime. Layer 3, and the single biggest thing DDMS could not do.
 *
 * Everything the product had before this was *pull*: sync writes the mirror,
 * screens derive on read, and a record that went wrong overnight waits for
 * somebody to open a page. `record_events` added *what changed*. This adds the
 * thing neither of them could express — **a process that is part-way through**,
 * and has been since March.
 *
 * ## Two halves, and the line between them is the point
 *
 * The top of this file is **pure**: `positionOf` takes a definition and a set
 * of facts and returns where a journey stands. No database, no clock, no
 * network. That is what lets a simulated month run in a verifier, and it is
 * what makes the second half almost trivial.
 *
 * The bottom is **durable**: read where a journey stood, work out where it
 * stands now, write the difference. Nothing about a live journey exists in
 * memory between two passes, so a restart mid-flight is not a case that had to
 * be handled — it is the ordinary case, run twice.
 *
 * ## The walk
 *
 * The position is **the first step that is not done**. Not *the step after the
 * last one we saw complete* — that would advance one step per pass and drift
 * behind a file that moved three steps in a week, and worse, it could never go
 * backwards. Because the walk is total, any fact-set maps to exactly one
 * position, and the loop falls out for free: when the RTO rejects a file, an
 * earlier step stops being done and the position simply *is* earlier.
 *
 * ## What it may write
 *
 * `journeys` and `journey_steps`, which are DDMS's own (R-76). **Nothing else.**
 * It does not write a decision field, it does not touch the mirror (R-5), and
 * where a journey eventually needs a record changed it will go through the same
 * call a person's button makes (R-81). There is no second way in and this file
 * is where that would first be tempting.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  journeysTable,
  journeyStepsTable,
  dmsRegistrationsTable,
  dmsDealsTable,
  type JourneyRow,
  type JourneyStepRow,
} from "@workspace/db";
import { logger } from "../../logger";
import type { ResolvedPolicy } from "../policy";
import type { JourneyDefinition, Position, Step } from "./types";
import { VEHICLE_DELIVERY, type DeliveryFacts, type DeliveryStep } from "./vehicle-delivery";

// ── The pure half ───────────────────────────────────────────────────────────

/**
 * Where a journey stands, from facts alone.
 *
 * The finish test is deliberately *the last step is done* rather than *every
 * step is done*. A vehicle whose plate date the DMS never recorded is still a
 * delivered vehicle; a journey that refused to finish over a missing date would
 * describe a sale that closed in March on somebody's queue for ever. A gap
 * behind the ending is a gap in the record, not work outstanding.
 */
export function positionOf<F>(def: JourneyDefinition<F>, f: F): Position<F> {
  const steps = def.steps;
  const last = steps[steps.length - 1];

  if (last && last.done(f)) {
    return {
      step: null,
      index: steps.length,
      completed: steps.length,
      total: steps.length,
      wait: null,
      returnedTo: null,
    };
  }

  const index = steps.findIndex((s) => !s.done(f));
  const step = steps[index] as Step<F>;

  return {
    step,
    index,
    completed: index,
    total: steps.length,
    wait: step.wait(f),
    returnedTo: step.returnsTo?.(f) ?? null,
  };
}

/**
 * Whether a wait belongs on somebody's queue.
 *
 * The discipline the classifiers already keep, stated once instead of seven
 * times. A `TIME` wait never produces a row — a file lodged on Tuesday is not
 * work on Wednesday, and a queue full of things nobody can act on is a queue
 * people stop reading. An `OUTSIDE` wait produces one only once it has gone on
 * longer than the dealership said was normal.
 */
export function needsSomebody(wait: Position<unknown>["wait"], today: string): boolean {
  if (!wait) return false;
  if (wait.kind === "TIME") return false;
  if (wait.kind === "OUTSIDE") {
    return !wait.notBefore || wait.notBefore <= today;
  }
  return true;
}

// ── Facts ───────────────────────────────────────────────────────────────────

/**
 * One read for every subject in the outlet, joining the two mirrors that hold
 * halves of the same sale.
 *
 * The invoice lives on the **deal** and everything after it lives on the
 * **registration file**, and no screen in the product puts them together. That
 * split is not incidental to this journey — it is the reason the journey is
 * worth having.
 */
export async function loadDeliveryFacts(
  showroomIds: number[],
  policy: ResolvedPolicy,
  now: Date = new Date(),
): Promise<Map<string, DeliveryFacts>> {
  const out = new Map<string, DeliveryFacts>();
  if (showroomIds.length === 0) return out;

  const files = await db
    .select()
    .from(dmsRegistrationsTable)
    .where(inArray(dmsRegistrationsTable.showroomId, showroomIds));

  const dealerCodes = [...new Set(files.map((f) => f.dealerCode))];
  const deals = dealerCodes.length
    ? await db
        .select({
          dealerCode: dmsDealsTable.dealerCode,
          dealId: dmsDealsTable.dealId,
          invoiceNo: dmsDealsTable.invoiceNo,
          invoiceDate: dmsDealsTable.invoiceDate,
        })
        .from(dmsDealsTable)
        .where(inArray(dmsDealsTable.dealerCode, dealerCodes))
    : [];

  const invoiceOf = new Map(
    deals.map((d) => [`${d.dealerCode}:${d.dealId}`, d] as const),
  );

  const today = now.toISOString().slice(0, 10);
  const rtoQuietDays = policy.days("THRESHOLD.RTO_QUIET_DAYS");

  for (const r of files) {
    const deal = invoiceOf.get(`${r.dealerCode}:${r.dealId}`);
    out.set(r.regnFileNo, {
      regnFileNo: r.regnFileNo,
      showroomId: r.showroomId,
      dealerCode: r.dealerCode,
      status: r.status,
      dealId: r.dealId,
      customerName: r.customerName,
      customerMobile: r.customerMobile,
      modelDescription: r.modelDescription,
      chassisNo: r.chassisNo,
      agentEmpCode: r.agentEmpCode,
      assignedAgentEmpCode: r.assignedAgentEmpCode,
      invoiceNo: deal?.invoiceNo ?? null,
      invoiceDate: deal?.invoiceDate ?? null,
      dealKnown: Boolean(deal),
      policyNo: r.policyNo,
      hasPendingDoc: r.hasPendingDoc === "Y",
      pendingDocDesc: r.pendingDocDesc,
      objectionDesc: r.objectionDesc,
      roadTaxAmount: r.roadTaxAmount,
      roadTaxCollectedDate: r.roadTaxCollectedDate,
      roadTaxPaidDate: r.roadTaxPaidDate,
      submittedDate: r.submittedDate,
      regNo: r.regNo,
      regDate: r.regDate,
      hsrpFittedDate: r.hsrpFittedDate,
      rcReceivedDate: r.rcReceivedDate,
      rcDeliveredDate: r.rcDeliveredDate,
      tempRegExpiryDate: r.tempRegExpiryDate,
      customerNotifiedAt: r.customerNotifiedAt ? r.customerNotifiedAt.toISOString() : null,
      rtoChasedAt: r.rtoChasedAt ? r.rtoChasedAt.toISOString() : null,
      disappeared: Boolean(r.disappearedAt),
      today,
      rtoQuietDays,
    });
  }

  return out;
}

// ── The durable half ────────────────────────────────────────────────────────

export interface AdvanceSummary {
  /** Journeys opened on this pass. */
  started: number;
  /** Journeys that moved forwards, and by how many steps in total. */
  advanced: number;
  /** Journeys the outside world sent backwards. The number worth watching. */
  looped: number;
  finished: number;
  abandoned: number;
  /** Live journeys after the pass, wherever they stand. */
  live: number;
  durationMs: number;
}

/** The newest arrival per journey — which *is* where the journey stands. */
async function lastArrivals(journeyIds: number[]): Promise<Map<number, JourneyStepRow>> {
  const out = new Map<number, JourneyStepRow>();
  if (journeyIds.length === 0) return out;

  const rows = await db
    .select()
    .from(journeyStepsTable)
    .where(inArray(journeyStepsTable.journeyId, journeyIds))
    .orderBy(desc(journeyStepsTable.id));

  // Descending id, so the first one seen for a journey is its newest.
  for (const row of rows) if (!out.has(row.journeyId)) out.set(row.journeyId, row);
  return out;
}

/**
 * Open a journey for every subject that does not have one.
 *
 * Idempotent by the unique index rather than by a check-then-insert, because
 * the scheduler and a person's request can run this at the same moment and a
 * second journey for one registration file would mean two positions, two queue
 * rows and two traces.
 */
async function discover(
  ownerId: number,
  facts: Map<string, DeliveryFacts>,
  existing: Set<string>,
): Promise<JourneyRow[]> {
  const opened: JourneyRow[] = [];

  for (const [key, f] of facts) {
    if (existing.has(key)) continue;
    // A file that has already vanished never gets a journey. Opening one to
    // abandon it in the same pass is noise in the trace.
    if (f.disappeared) continue;

    const [row] = await db
      .insert(journeysTable)
      .values({
        ownerId,
        showroomId: f.showroomId,
        definitionId: VEHICLE_DELIVERY.id,
        definitionVersion: VEHICLE_DELIVERY.version,
        subjectModule: VEHICLE_DELIVERY.subjectModule,
        subjectKey: key,
      })
      .onConflictDoNothing()
      .returning();

    if (row) opened.push(row);
  }

  return opened;
}

/**
 * One pass. Read where each journey stood, work out where it stands, write the
 * difference.
 *
 * Runs on `ddms_worker` from the scheduler, which is the ordinary case — a
 * journey advances because the RTO answered, not because somebody opened a
 * screen.
 */
export async function advanceJourneys(input: {
  ownerId: number;
  showroomIds: number[];
  policy: ResolvedPolicy;
  now?: Date;
  /**
   * The facts to walk against, when the caller already has them.
   *
   * A seam rather than a back door, and the distinction matters. This function
   * is a pure function of *facts plus stored position* — the load below is
   * simply the ordinary way of obtaining the first of those, from the last
   * sync. A caller supplying them directly is supplying exactly what the next
   * sync would have, which is what `verify:journey` does to walk one file
   * through two successive states of the world without waiting a week for the
   * RTO.
   *
   * It cannot be used to write anything the ordinary path could not: the facts
   * only decide *where a journey stands*, and where it stands is the only thing
   * this function writes.
   */
  facts?: Map<string, DeliveryFacts>;
}): Promise<AdvanceSummary> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const facts = input.facts ?? (await loadDeliveryFacts(input.showroomIds, input.policy, now));

  const known = await db
    .select()
    .from(journeysTable)
    .where(
      and(
        eq(journeysTable.ownerId, input.ownerId),
        eq(journeysTable.definitionId, VEHICLE_DELIVERY.id),
        inArray(journeysTable.showroomId, input.showroomIds),
      ),
    );

  const opened = await discover(
    input.ownerId,
    facts,
    new Set(known.map((j) => j.subjectKey)),
  );

  const all = [...known, ...opened];
  const live = all.filter((j) => j.status === "LIVE");
  const arrivals = await lastArrivals(live.map((j) => j.id));

  const summary: AdvanceSummary = {
    started: opened.length,
    advanced: 0,
    looped: 0,
    finished: 0,
    abandoned: 0,
    live: 0,
    durationMs: 0,
  };

  for (const journey of live) {
    const f = facts.get(journey.subjectKey);

    /*
     * **Silence is not a departure**, and the first version of this treated it
     * as one.
     *
     * A subject missing from the fact-set means the walk has nothing to say
     * about it on this pass — a partial load, a narrower query, a caller
     * supplying facts for one file. It does *not* mean the file is gone: a file
     * the DMS stopped returning is still in the mirror with `disappearedAt`
     * set, and that is the only thing that abandons a journey. It is the same
     * rule the login check keeps about an absent employee row, for the same
     * reason — inferring an ending from an absence quietly ends things that are
     * still going.
     */
    if (!f) continue;

    if (f.disappeared) {
      await db
        .update(journeysTable)
        .set({
          status: "ABANDONED",
          abandonedReason:
            VEHICLE_DELIVERY.abandoned?.(f) ??
            "The registration file is no longer in the dealer's system.",
          lastCheckedAt: now,
        })
        .where(eq(journeysTable.id, journey.id));
      summary.abandoned++;
      continue;
    }

    const position = positionOf(VEHICLE_DELIVERY, f);
    const before = arrivals.get(journey.id);

    // Finished: the last step is done. Recorded once, and the journey stops
    // being read on every pass thereafter.
    if (position.step === null) {
      if (before?.direction !== "FINISH") {
        await db.insert(journeyStepsTable).values({
          journeyId: journey.id,
          ownerId: journey.ownerId,
          stepId: VEHICLE_DELIVERY.steps[VEHICLE_DELIVERY.steps.length - 1]!.id,
          stepIndex: VEHICLE_DELIVERY.steps.length - 1,
          direction: "FINISH",
          fromStepId: before?.stepId ?? null,
          occurredAt: now,
        });
      }
      await db
        .update(journeysTable)
        .set({ status: "DONE", completedAt: now, lastCheckedAt: now })
        .where(eq(journeysTable.id, journey.id));
      summary.finished++;
      continue;
    }

    if (!before) {
      await db.insert(journeyStepsTable).values({
        journeyId: journey.id,
        ownerId: journey.ownerId,
        stepId: position.step.id,
        stepIndex: position.index,
        direction: "START",
        occurredAt: now,
      });
      summary.live++;
      await db
        .update(journeysTable)
        .set({ lastCheckedAt: now })
        .where(eq(journeysTable.id, journey.id));
      continue;
    }

    if (position.index !== before.stepIndex) {
      const backwards = position.index < before.stepIndex;

      /*
       * A backwards move with no reason is a bug, not a condition to absorb.
       * The definition is expected to explain it — `DOCUMENTS.returnsTo` is the
       * RTO objection — and if it cannot, the row still gets written (losing
       * the move would be worse) but it says so, and it is logged where
       * somebody will see it.
       */
      const reason = backwards
        ? (position.returnedTo?.reason ??
          `Something already done is no longer true: ${position.step.title.toLowerCase()}.`)
        : null;

      if (backwards && !position.returnedTo) {
        logger.warn(
          {
            journeyId: journey.id,
            subject: journey.subjectKey,
            from: before.stepId,
            to: position.step.id,
          },
          "A journey went backwards and the definition did not say why",
        );
      }

      await db.insert(journeyStepsTable).values({
        journeyId: journey.id,
        ownerId: journey.ownerId,
        stepId: position.step.id,
        stepIndex: position.index,
        direction: backwards ? "BACKWARD" : "FORWARD",
        reason,
        fromStepId: before.stepId,
        occurredAt: now,
      });

      if (backwards) summary.looped++;
      else summary.advanced++;
    }

    summary.live++;
    await db
      .update(journeysTable)
      .set({ lastCheckedAt: now })
      .where(eq(journeysTable.id, journey.id));
  }

  summary.durationMs = Date.now() - startedAt;
  logger.info(summary, "Journeys advanced");
  return summary;
}

// ── Reading one ─────────────────────────────────────────────────────────────

export interface JourneyTraceStep {
  stepId: string;
  title: string;
  actor: string;
  state: "DONE" | "HERE" | "AHEAD";
}

export interface JourneyTrace {
  id: number;
  definitionId: string;
  definitionVersion: number;
  title: string;
  subjectModule: string;
  subjectKey: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  /** Every step of the map, with where the journey has got to marked on it. */
  steps: JourneyTraceStep[];
  /** Where it is standing, and what that is waiting on. Derived, never stored. */
  standingOn: string | null;
  wait: {
    kind: string;
    who: string;
    why: string;
    todo: string;
    notBefore: string | null;
  } | null;
  /** How many times the outside world sent it backwards. */
  loops: number;
  /** Every arrival, newest last. The backwards ones carry their reason. */
  arrivals: Array<{
    stepId: string;
    direction: string;
    reason: string | null;
    fromStepId: string | null;
    occurredAt: string;
  }>;
}

/** One record's journey, for the panel on its screen. */
export async function traceFor(
  module: string,
  recordKey: string,
  policy: ResolvedPolicy,
  now: Date = new Date(),
): Promise<JourneyTrace | null> {
  const [journey] = await db
    .select()
    .from(journeysTable)
    .where(
      and(
        eq(journeysTable.subjectModule, module as "REGISTRATION"),
        eq(journeysTable.subjectKey, recordKey),
      ),
    )
    .limit(1);

  if (!journey) return null;

  const facts = await loadDeliveryFacts([journey.showroomId], policy, now);
  const f = facts.get(journey.subjectKey);

  const arrivals = await db
    .select()
    .from(journeyStepsTable)
    .where(eq(journeyStepsTable.journeyId, journey.id))
    .orderBy(journeyStepsTable.id);

  const position = f
    ? positionOf(VEHICLE_DELIVERY, f)
    : { step: null, index: VEHICLE_DELIVERY.steps.length, completed: 0, total: VEHICLE_DELIVERY.steps.length, wait: null, returnedTo: null };

  return {
    id: journey.id,
    definitionId: journey.definitionId,
    definitionVersion: journey.definitionVersion,
    title: VEHICLE_DELIVERY.title,
    subjectModule: journey.subjectModule,
    subjectKey: journey.subjectKey,
    status: journey.status,
    startedAt: journey.startedAt.toISOString(),
    completedAt: journey.completedAt ? journey.completedAt.toISOString() : null,
    steps: VEHICLE_DELIVERY.steps.map((s, i) => ({
      stepId: s.id,
      title: s.title,
      actor: s.actor,
      state: i < position.index ? "DONE" : i === position.index ? "HERE" : "AHEAD",
    })),
    standingOn: position.step?.id ?? null,
    wait: position.wait
      ? {
          kind: position.wait.kind,
          who: position.wait.who,
          why: position.wait.why,
          todo: position.wait.todo,
          notBefore: position.wait.notBefore ?? null,
        }
      : null,
    loops: arrivals.filter((a) => a.direction === "BACKWARD").length,
    arrivals: arrivals.map((a) => ({
      stepId: a.stepId,
      direction: a.direction,
      reason: a.reason,
      fromStepId: a.fromStepId,
      occurredAt: a.occurredAt.toISOString(),
    })),
  };
}

// ── What the queue asks for ─────────────────────────────────────────────────

/**
 * A stalled step, shaped for the queue.
 *
 * This is the mechanic the whole model was built for. Seven classifiers each
 * hand-write a *what to do* sentence for the states they know about; a stalled
 * step already knows where it stopped, what it was trying to do and who it is
 * waiting on, so the sentence is a property of the map rather than a string in
 * a switch.
 */
export interface JourneyQueueRow {
  journeyId: number;
  subjectModule: string;
  subjectKey: string;
  showroomId: number;
  stepId: string;
  stepTitle: string;
  severityState: string | null;
  waitKind: string;
  why: string;
  todo: string;
  role: string | null;
  assignedEmpCode: string | null;
  title: string;
  subtitle: string | null;
  contactName: string | null;
  contactMobile: string | null;
  /** How long it has been standing on this step. */
  waitingDays: number;
  /** How many times it has been sent back. A file on its third loop reads as one. */
  loops: number;
  completed: number;
  total: number;
}

export async function journeyQueueRows(input: {
  ownerId: number;
  showroomIds: number[];
  policy: ResolvedPolicy;
  now?: Date;
}): Promise<JourneyQueueRow[]> {
  const now = input.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const live = await db
    .select()
    .from(journeysTable)
    .where(
      and(
        eq(journeysTable.ownerId, input.ownerId),
        eq(journeysTable.status, "LIVE"),
        eq(journeysTable.definitionId, VEHICLE_DELIVERY.id),
        inArray(journeysTable.showroomId, input.showroomIds),
      ),
    );

  if (live.length === 0) return [];

  const facts = await loadDeliveryFacts(input.showroomIds, input.policy, now);
  const arrivals = await lastArrivals(live.map((j) => j.id));

  const loopCounts = new Map<number, number>();
  const backs = await db
    .select({ journeyId: journeyStepsTable.journeyId })
    .from(journeyStepsTable)
    .where(
      and(
        inArray(
          journeyStepsTable.journeyId,
          live.map((j) => j.id),
        ),
        eq(journeyStepsTable.direction, "BACKWARD"),
      ),
    );
  for (const b of backs) loopCounts.set(b.journeyId, (loopCounts.get(b.journeyId) ?? 0) + 1);

  const rows: JourneyQueueRow[] = [];

  for (const journey of live) {
    const f = facts.get(journey.subjectKey);
    if (!f || f.disappeared) continue;

    const position = positionOf(VEHICLE_DELIVERY, f);
    if (!position.step || !position.wait) continue;
    if (!needsSomebody(position.wait, today)) continue;

    const since = arrivals.get(journey.id)?.occurredAt ?? journey.startedAt;
    const waitingDays = Math.max(
      0,
      Math.round((now.getTime() - since.getTime()) / 86_400_000),
    );

    const step = position.step as DeliveryStep;
    const label = VEHICLE_DELIVERY.label(f);
    const contact = VEHICLE_DELIVERY.contact(f);

    rows.push({
      journeyId: journey.id,
      subjectModule: journey.subjectModule,
      subjectKey: journey.subjectKey,
      showroomId: journey.showroomId,
      stepId: step.id,
      stepTitle: step.title,
      severityState: step.severityState?.(f) ?? null,
      waitKind: position.wait.kind,
      why: position.wait.why,
      todo: position.wait.todo,
      role: position.wait.role ?? null,
      assignedEmpCode: VEHICLE_DELIVERY.assignee(f).empCode,
      title: label.title,
      subtitle: label.subtitle,
      contactName: contact.name,
      contactMobile: contact.mobile,
      waitingDays,
      loops: loopCounts.get(journey.id) ?? 0,
      completed: position.completed,
      total: position.total,
    });
  }

  return rows;
}

/** Which subjects the runtime is answering for, so the queue can stand aside. */
export async function liveSubjects(
  ownerId: number,
  showroomIds: number[],
): Promise<Set<string>> {
  if (showroomIds.length === 0) return new Set();
  const rows = await db
    .select({ module: journeysTable.subjectModule, key: journeysTable.subjectKey })
    .from(journeysTable)
    .where(
      and(
        eq(journeysTable.ownerId, ownerId),
        eq(journeysTable.status, "LIVE"),
        inArray(journeysTable.showroomId, showroomIds),
      ),
    );
  return new Set(rows.map((r) => `${r.module}:${r.key}`));
}

export { VEHICLE_DELIVERY };
export type { DeliveryFacts };
