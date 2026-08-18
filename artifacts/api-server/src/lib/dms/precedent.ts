/**
 * What this dealership actually did last time (OBJ-26, R-66 to R-71).
 *
 * Everything the product knows about a record it works out from scratch each
 * time. Hundreds of decisions are logged with a person's name against them,
 * hundreds of state transitions with dates, and until this file **nothing had
 * ever read either one** to ask the question that separates an agent from a
 * rules engine with a chat window:
 *
 * > *What did we do last time this happened here?*
 *
 * ## Case-based reasoning, not a memory store
 *
 * The literature's episodic/semantic/procedural split describes systems that
 * *write* memories. The substrate here is two append-only logs the product
 * already keeps, and precedent is a **query over them** rather than a thing to
 * be curated. Nothing is stored, so nothing can be poisoned — and the
 * commonest poisoning payload in that literature is a plausible-looking
 * *preference*, which is exactly the kind of row this design has nowhere to
 * put (R-67).
 *
 * ## The four properties, and each one is a failure mode closed
 *
 * **People only** (R-66). Only rows with a `userId` count. A mark the system
 * made is excluded on purpose: an agent that re-reads its own output as
 * evidence turns one early mistake into a settled belief, and the loop is
 * invisible from inside. `decision_log.userId` has distinguished the two since
 * R-60, a fortnight before there was a use for it.
 *
 * **A count and a date, or nothing** (R-68). *"Five of the last six, most
 * recently on 28 July"* is a fact somebody can weigh. *"You usually do this"*
 * is a claim with no way to tell a settled habit from something that stopped in
 * March. Stale-but-true is the failure mode and a date is the whole of the fix.
 *
 * **A moving window** (R-71). A habit the dealership drops leaves the product
 * by itself, rather than by somebody remembering to retire it.
 *
 * **Named features, not an embedding** (R-70). Module, state, action, and the
 * choice made. A dealership has hundreds of open records and twelve action
 * types; a vector index would be slower to explain than to build, and *why did
 * it show me that one* has to have a one-sentence answer.
 *
 * ## And it authorises nothing
 *
 * R-69 does not bend. Precedent reaches a person beside a button, or reaches an
 * owner as a proposal about a stored number. It never reorders the queue, never
 * changes a classifier's answer, and never widens what `authoriseSend()`
 * permits. What it may do — and this is OBJ-26's one addition — is be the
 * **evidence a person consents on**. The consent authorises; the precedent
 * still does not.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { db, decisionLogTable, recordEventsTable } from "@workspace/db";
import type { ActionId } from "./actions";

/**
 * The unit that graduates.
 *
 * `MODULE:STATE:ACTION` — per pattern, not per agent and not per module
 * (R-79). A dealership that always hands orphaned enquiries to the same person
 * has said nothing thereby about registration files.
 *
 * The state is the classifier's answer, which is what makes the pattern about a
 * *situation* rather than about a table. *An enquiry past its SLA that nobody
 * is on* and *an enquiry somebody simply reassigned* are different habits, and
 * collapsing them would cite one as evidence for the other.
 */
export function patternKey(module: string, state: string, action: string): string {
  return `${module}:${state}:${action}`;
}

export function readPatternKey(key: string): { module: string; state: string; action: string } {
  const [module = "", state = "", ...rest] = key.split(":");
  return { module, state, action: rest.join(":") };
}

/**
 * Which field in a decision carries **the choice**.
 *
 * Two kinds of pattern, and the distinction is real rather than tidy. Some
 * actions answer *who* — reassigning an enquiry picks a person, and the habit
 * worth citing is which person. Others answer *whether* — marking a customer
 * told has no alternative to compare against, and the habit is that the
 * dealership does it at all.
 *
 * An action absent from this map is a *whether*, and its choice is `DONE`.
 */
const CHOICE_FIELD: Partial<Record<ActionId, string>> = {
  ENQUIRY_REASSIGN: "reassignedToEmpCode",
  JOB_CARD_REASSIGN: "reassignedToEmpCode",
  REGISTRATION_ASSIGN_AGENT: "assignedAgentEmpCode",
  PART_REQUEST_TRANSFER: "transferRequestedFromShowroomId",
  VEHICLE_MARK_OFFERED: "offeredToEnqId",
  VEHICLE_PROPOSE_TRANSFER: "transferToShowroomId",
};

/** The value a decision chose, in the vocabulary the proposal is stored in. */
export function choiceOf(action: string, value: Record<string, unknown> | null): string {
  const field = CHOICE_FIELD[action as ActionId];
  if (!field) return "DONE";
  const v = value?.[field];
  return v === null || v === undefined ? "NONE" : String(v);
}

export interface Choice {
  value: string;
  count: number;
  /** ISO date, and it is not optional (R-68). */
  lastAt: string;
}

export interface Precedent {
  patternKey: string;
  module: string;
  state: string;
  action: string;
  /** Days looked back over. On the answer, because it qualifies every count. */
  windowDays: number;
  /** Decisions a **person** made in the window. Never the system's. */
  total: number;
  choices: Choice[];
  /** The commonest, when there is a commonest. Null on a tie or on nothing. */
  dominant: Choice | null;
  /**
   * The sentence, already written, or **null**.
   *
   * Null rather than a hedge. *"This dealership has no settled habit here"* is
   * a sentence that occupies a row and tells nobody anything, and a queue that
   * says something about every item teaches people to stop reading it.
   */
  sentence: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

function ago(days: number): Date {
  return new Date(Date.now() - days * DAY);
}

/** *28 July*, not *2026-07-28T11:04:22.918Z*. A date somebody reads. */
function readableDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long" });
}

/**
 * Every pattern this outlet has a habit about, in one pass.
 *
 * One query set rather than one per queue item. The queue asks about thirty
 * distinct patterns across three hundred rows, and a per-row lookup would be
 * three hundred round trips to answer thirty questions.
 *
 * ## Recovering the state a decision was made in
 *
 * `decision_log` records what was decided and not what the record's derived
 * state was at the time, which is right — it is a log of decisions, not of
 * situations. But *this dealership always hands over an enquiry that has gone
 * past its SLA with nobody on it* and *this dealership reassigns enquiries* are
 * different claims, and only the first is worth citing on the row it appears
 * next to.
 *
 * So the state comes from `record_events`, which is the other half of what R-67
 * names: the newest event for that record **at or before the moment of the
 * decision**. That is the state the person was looking at when they decided.
 * Taking the record's *current* state instead would be the sharper mistake — it
 * would re-file every past decision under whatever happened to the record
 * afterwards, so a habit would silently change shape as records moved on.
 *
 * A decision with no event before it is skipped rather than bucketed under an
 * invented state. It means the record was decided on before the detector ever
 * classified it, and there is no honest answer to what somebody was looking at.
 */
export async function precedentFor(input: {
  ownerId: number;
  showroomIds: number[];
  windowDays: number;
  actions?: readonly string[];
}): Promise<Map<string, Precedent>> {
  const out = new Map<string, Precedent>();
  if (input.showroomIds.length === 0) return out;

  const decisions = await db
    .select({
      showroomId: decisionLogTable.showroomId,
      module: decisionLogTable.module,
      recordKey: decisionLogTable.recordKey,
      action: decisionLogTable.action,
      newValue: decisionLogTable.newValue,
      createdAt: decisionLogTable.createdAt,
    })
    .from(decisionLogTable)
    .where(
      and(
        eq(decisionLogTable.ownerId, input.ownerId),
        inArray(decisionLogTable.showroomId, input.showroomIds),
        // R-66, and it is one predicate. Everything the agent did is excluded,
        // which is what stops the ladder being a thing it can climb alone.
        isNotNull(decisionLogTable.userId),
        gte(decisionLogTable.createdAt, ago(input.windowDays)),
      ),
    )
    .orderBy(desc(decisionLogTable.createdAt));

  /*
   * A cleared decision is not a decision to cite.
   *
   * `applyAction` logs an undo as `<ACTION>_CLEARED`, and counting those as
   * instances of the action would make *he reassigned it and then took it back*
   * read as *he reassigned it*. Excluded rather than netted off: two people
   * doing and undoing the same thing is not a habit either way.
   */
  const useful = decisions.filter(
    (r) => !r.action.endsWith("_CLEARED") && (!input.actions || input.actions.includes(r.action)),
  );
  if (useful.length === 0) return out;

  /*
   * The events for exactly the records that were decided on, and no others.
   *
   * Bounded by the number of decisions in the window rather than by the size of
   * the event log, which is what keeps this from becoming a table scan on a
   * dealership that has been running for a year.
   */
  const keys = [...new Set(useful.map((r) => r.recordKey))];
  const events = await db
    .select({
      showroomId: recordEventsTable.showroomId,
      module: recordEventsTable.module,
      recordKey: recordEventsTable.recordKey,
      toState: recordEventsTable.toState,
      detectedAt: recordEventsTable.detectedAt,
    })
    .from(recordEventsTable)
    .where(
      and(
        eq(recordEventsTable.ownerId, input.ownerId),
        inArray(recordEventsTable.showroomId, input.showroomIds),
        inArray(recordEventsTable.recordKey, keys),
        // Nothing after the newest decision can have been visible to any of
        // them, so there is no reason to carry it into memory.
        lte(recordEventsTable.detectedAt, useful[0]!.createdAt),
      ),
    )
    .orderBy(asc(recordEventsTable.detectedAt));

  const timeline = new Map<string, Array<{ at: number; state: string }>>();
  for (const e of events) {
    const k = `${e.module}:${e.showroomId}:${e.recordKey}`;
    const list = timeline.get(k) ?? [];
    list.push({ at: e.detectedAt.getTime(), state: e.toState });
    timeline.set(k, list);
  }

  /** The state the record was in when somebody decided. Ascending, so scan back. */
  function stateAt(module: string, showroomId: number, recordKey: string, when: Date): string | null {
    const list = timeline.get(`${module}:${showroomId}:${recordKey}`);
    if (!list) return null;
    const t = when.getTime();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.at <= t) return list[i]!.state;
    }
    return null;
  }

  const buckets = new Map<
    string,
    { module: string; state: string; action: string; hits: Map<string, Choice> }
  >();

  for (const r of useful) {
    const state = stateAt(r.module, r.showroomId, r.recordKey, r.createdAt);
    if (!state) continue;

    const key = patternKey(r.module, state, r.action);
    const bucket =
      buckets.get(key) ??
      { module: r.module, state, action: r.action, hits: new Map<string, Choice>() };

    const value = choiceOf(r.action, r.newValue);
    const seen = bucket.hits.get(value);
    if (seen) {
      seen.count++;
    } else {
      // Rows arrive newest first, so the first sighting is the most recent.
      bucket.hits.set(value, { value, count: 1, lastAt: r.createdAt.toISOString() });
    }
    buckets.set(key, bucket);
  }

  for (const [key, bucket] of buckets) {
    const choices = [...bucket.hits.values()].sort((a, b) => b.count - a.count);
    const total = choices.reduce((n, c) => n + c.count, 0);
    const top = choices[0];
    const second = choices[1];
    // A tie has no dominant answer, and inventing one by insertion order would
    // be the arbitrary-customer defect again in a different costume.
    const dominant = top && (!second || second.count < top.count) ? top : null;

    out.set(key, {
      patternKey: key,
      module: bucket.module,
      state: bucket.state,
      action: bucket.action,
      windowDays: input.windowDays,
      total,
      choices,
      dominant,
      sentence: null,
    });
  }

  return out;
}

/**
 * The sentence, with a name on it where the choice is a person.
 *
 * `EMP-0417-08` is not what somebody read last week; *Jaswinder* is. The names
 * come from the caller because they come from `listStaff`, which the queue has
 * already loaded — and because an employee code with no name against it means
 * that person has left, which is worth showing rather than hiding.
 */
export function precedentSentence(
  p: Precedent,
  label: (value: string) => string | null,
): string | null {
  if (!p.dominant || p.total < 2) return null;

  const name = label(p.dominant.value);
  const when = readableDate(p.dominant.lastAt);

  // *5 of the last 6* rather than *5 times*, because the denominator is what
  // tells a settled habit from five occasions among fifty.
  const share =
    p.dominant.count === p.total
      ? `all ${p.total}`
      : `${p.dominant.count} of the last ${p.total}`;

  if (p.dominant.value === "DONE") {
    return `Somebody here has done this ${share} times, most recently on ${when}.`;
  }
  if (!name) {
    return `${share} went to somebody who is no longer on the staff list, most recently on ${when}.`;
  }
  return `${share} went to ${name}, most recently on ${when}.`;
}
