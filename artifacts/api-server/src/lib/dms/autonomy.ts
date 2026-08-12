/**
 * Autonomy earned by evidence, and lost the same way (OBJ-26, R-79, R-80).
 *
 * Everyone builds autonomy as a dial somebody sets. A dial is a guess made on
 * the first afternoon, by whoever happened to be configuring the product, about
 * work they have not yet watched it do. This is a count:
 *
 * | | what the product does | who decides |
 * |---|---|---|
 * | **0 · watching** | notices a pattern, says nothing | nobody |
 * | **1 · recall** | *"the last 7 times, you gave it to Jaswinder"* | a person, every time |
 * | **2 · pre-filled** | the answer is already selected; press go | a person, faster |
 * | **3 · automatic** | *"10 out of 10 — shall I just do it?"* → consent, once | a person, once, revocably |
 *
 * ## Why the ladder is safer than the dial, and it is not obvious
 *
 * At rungs 0 to 2 the model does **recall, never judgement**. It answers *what
 * happened before* — a question with an answer — and never *what should
 * happen*. So R-49 survives intact the whole way up, and the graduation **is**
 * the safety mechanism rather than something bolted beside it.
 *
 * Nor does this bend R-69. Precedent still authorises nothing: it is the
 * **evidence a person consents on**, and the consent is what authorises. One
 * step added, no rule weakened.
 *
 * ## Derived to rung 2, stored at rung 3
 *
 * Rungs 0 to 2 are computed from a moving window every time they are asked
 * for. Nothing stores them, so a habit the dealership drops takes its rung with
 * it (R-71) and demotion needs no scheduled job to notice. Rung 3 needs a
 * **row with somebody's name on it**, because letting an unattended process act
 * is a decision rather than an observation.
 *
 * > **Consent raises the ceiling. Evidence sets what has been earned. Both have
 * > to hold.**
 *
 * A consent standing while acceptance falls does not keep a pattern automatic —
 * the earned rung drops and the pattern drops with it, with the consent row
 * untouched and still true. Demotion never deletes anybody's decision, and
 * recovery does not need somebody to remember to re-grant it. That is the
 * difference between a ladder and a ratchet.
 *
 * ## The floor, and no amount of precedent reaches it
 *
 * R-80. Ten thousand accepted proposals do not promote an action the agent may
 * not take, and the ceiling is not a second list to keep in step — it is
 * `may("AGENT", …)`, the same table that answers for a service advisor, with
 * `whyNot()` supplying the sentence. Eight of the twelve registry actions
 * assert that a *person* did something (rang the customer, chased the RTO), and
 * a pattern of people doing them is evidence about people.
 *
 * So those patterns climb to **pre-filled and stop**. Pre-filling is the
 * product offering a default that a person presses; automatic is the product
 * asserting the phone call happened. The line is exactly there, and it is
 * written in one place.
 */

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  agentProposalsTable,
  autonomyConsentsTable,
  type AutonomyConsentRow,
} from "@workspace/db";
import { may, whyNot, type Principal, PERMISSION_FOR_ACTION, type RegistryActionId } from "./permissions";
import type { ResolvedPolicy } from "./policy";
import { precedentFor, precedentSentence, readPatternKey, type Precedent } from "./precedent";

export const RUNGS = ["WATCHING", "RECALL", "PREFILLED", "AUTOMATIC"] as const;
export type Rung = (typeof RUNGS)[number];

export const RUNG_LABEL: Record<Rung, string> = {
  WATCHING: "Watching",
  RECALL: "Says what you did last time",
  PREFILLED: "Fills the answer in",
  AUTOMATIC: "Does it unattended",
};

export const RUNG_MEANING: Record<Rung, string> = {
  WATCHING: "Not enough has happened here yet for this to be worth saying anything about.",
  RECALL: "The row carries what this outlet did last time, with a count and a date. Somebody still chooses.",
  PREFILLED: "The answer arrives already selected. Somebody still presses the button, and can change it.",
  AUTOMATIC: "Done without anybody signed in, under a standing consent that can be taken back.",
};

export function rungIndex(r: Rung): number {
  return RUNGS.indexOf(r);
}

/** The dealership's numbers, and every one of them is theirs to move (R-79). */
export const AUTONOMY_KEYS = {
  window: "AUTONOMY.WINDOW_DAYS",
  recallAfter: "AUTONOMY.RECALL_AFTER",
  prefillAfter: "AUTONOMY.PREFILL_AFTER",
  consentAfter: "AUTONOMY.CONSENT_AFTER",
  overrideCeiling: "AUTONOMY.OVERRIDE_CEILING_PCT",
} as const;

export interface PatternStanding {
  patternKey: string;
  module: string;
  state: string;
  action: string;

  /** What people here did, from the decision log. Never the agent's own work. */
  precedent: Precedent | null;
  /** The sentence to put on a row, or null. R-68 — a count and a date, or nothing. */
  sentence: string | null;

  /** How the agent has fared on this pattern, from `agent_proposals`. */
  offered: number;
  accepted: number;
  overridden: number;
  acted: number;
  /** Of the ones somebody actually answered. Ignored items count neither way. */
  overrideRatePct: number | null;

  /** Where the evidence alone puts it. */
  earned: Rung;
  /** Where it actually stands, after consent and after the floor. */
  rung: Rung;
  /** The highest this pattern can ever reach, and why, when it is not the top. */
  ceiling: Rung;
  ceilingReason: string | null;

  consent: AutonomyConsentRow | null;
  /**
   * True when the evidence is there, the floor allows it, and nobody has been
   * asked yet. **This is the product asking rather than promoting** — which is
   * the whole of the done-when, and the difference between a ladder somebody
   * climbs and one that climbs itself.
   */
  consentDue: boolean;
  /** Why it stands where it does, in one sentence a person can argue with. */
  because: string;
}

/**
 * How high this pattern may ever go, and the sentence saying why not higher.
 *
 * Not a second list. `may("AGENT", …)` is the same question the routes ask, so
 * the floor cannot drift out of step with the permission table, and the reason
 * is `whyNot()`'s — already written, already reviewed, and mostly sentences
 * that do not lose force with time.
 */
export function ceilingFor(
  action: string,
  /**
   * Which agent is asking (OBJ-29).
   *
   * The ceiling is a property of *this principal and this action*, not of the
   * action alone. `PART_REQUEST_TRANSFER` is automatic for the stock agent and
   * capped at pre-filled for the first one, and both answers come out of the
   * same permission table — so the ladder cannot drift from the grants, and a
   * second agent needed no second ladder.
   *
   * Defaulted, because every existing caller means the assignment agent and
   * changing four call sites to say so would have been noise.
   */
  principal: Principal = "AGENT",
): { ceiling: Rung; reason: string | null } {
  const permission = PERMISSION_FOR_ACTION[action as RegistryActionId];
  /*
   * Not a registry action at all.
   *
   * The decision log records more than the twelve controls — `MESSAGE_EDITED`
   * is in there, and a dealership that edits a lot of drafts genuinely has a
   * habit. But there is no button to pre-fill and nothing for an unattended
   * pass to press, so the ceiling is **recall**: the product may say what
   * happened, and there is nothing further for it to do.
   *
   * `PREFILLED` was the first answer here and it was a claim the product could
   * not honour — a rung it would report having reached while nothing on any
   * screen ever changed.
   */
  if (!permission) {
    return {
      ceiling: "RECALL",
      reason: "There is no control for this, so there is nothing to fill in and nothing to do on its own.",
    };
  }
  if (may(principal, permission)) return { ceiling: "AUTOMATIC", reason: null };
  return { ceiling: "PREFILLED", reason: whyNot(principal, permission) };
}

function lower(a: Rung, b: Rung): Rung {
  return rungIndex(a) <= rungIndex(b) ? a : b;
}

/**
 * Where the evidence alone puts a pattern.
 *
 * Read in order, because the first two conditions are demotions and they have
 * to win. The **override rate is checked before any promotion**: a pattern
 * people keep correcting is not a pattern that has earned anything, however
 * many times it was right before that, and putting the promotion tests first
 * would let a long good history outvote what is happening now.
 *
 * Demotion floors at `RECALL` rather than at `WATCHING`, and deliberately.
 * People overriding the agent's *choice* have not stopped having a habit — they
 * have stopped agreeing with the agent about it — so the honest response is to
 * go back to reciting the evidence and let them choose, not to fall silent. A
 * product that sulks is a product that hides what it knows.
 */
export function earnedRung(input: {
  precedentTotal: number;
  accepted: number;
  answered: number;
  overrideRatePct: number | null;
  recallAfter: number;
  prefillAfter: number;
  overrideCeiling: number;
}): { rung: Rung; because: string } {
  const { precedentTotal, accepted, overrideRatePct } = input;

  if (precedentTotal < input.recallAfter) {
    return {
      rung: "WATCHING",
      because: `${precedentTotal} of the ${input.recallAfter} decisions this outlet needs before there is a habit worth citing.`,
    };
  }

  if (overrideRatePct !== null && overrideRatePct > input.overrideCeiling) {
    return {
      rung: "RECALL",
      because: `${overrideRatePct}% of the answers here were changed by somebody, above the ${input.overrideCeiling}% this dealership allows — so it says what happened and chooses nothing.`,
    };
  }

  if (accepted >= input.prefillAfter) {
    return {
      rung: "PREFILLED",
      because: `${accepted} suggestions accepted here${
        overrideRatePct === null ? "" : `, ${overrideRatePct}% changed`
      }.`,
    };
  }

  return {
    rung: "RECALL",
    because: `${accepted} of the ${input.prefillAfter} accepted suggestions needed before the answer is filled in for you.`,
  };
}

/**
 * Every pattern this outlet has a standing on.
 *
 * One pass: the decision log for what people do, `agent_proposals` for how the
 * agent has fared, and the consent table for what has been granted. Deliberately
 * whole-outlet rather than per-record, because the ladder is a property of the
 * pattern and computing it per queue row would be three hundred answers to
 * thirty questions.
 */
export async function standingFor(input: {
  ownerId: number;
  showroomIds: number[];
  policy: ResolvedPolicy;
  /** Employee code → name, for the sentence. From `listStaff`, already loaded. */
  label?: (value: string) => string | null;
  /**
   * Which agent this standing is about (OBJ-29).
   *
   * The ceiling is a property of the principal, so two agents get two
   * standings over the same decision log — and a dealership that has been
   * accepting the first agent's assignments for a month has earned the second
   * one nothing. That separation is the reason there are two principals rather
   * than one wider set of grants.
   */
  principal?: Principal;
}): Promise<Map<string, PatternStanding>> {
  const out = new Map<string, PatternStanding>();
  if (input.showroomIds.length === 0) return out;

  const windowDays = input.policy.number(AUTONOMY_KEYS.window);
  const recallAfter = input.policy.number(AUTONOMY_KEYS.recallAfter);
  const prefillAfter = input.policy.number(AUTONOMY_KEYS.prefillAfter);
  const consentAfter = input.policy.number(AUTONOMY_KEYS.consentAfter);
  const overrideCeiling = input.policy.number(AUTONOMY_KEYS.overrideCeiling);

  const precedent = await precedentFor({
    ownerId: input.ownerId,
    showroomIds: input.showroomIds,
    windowDays,
  });

  /*
   * The agent's own record, counted in the same window.
   *
   * Same window as the precedent on purpose. Two windows would let a pattern
   * be promoted on last month's acceptances while its habit was assembled from
   * this month's decisions, and nobody reading the row could tell.
   */
  const tally = await db
    .select({
      patternKey: agentProposalsTable.patternKey,
      outcome: agentProposalsTable.outcome,
      n: sql<number>`count(*)::int`,
    })
    .from(agentProposalsTable)
    .where(
      and(
        eq(agentProposalsTable.ownerId, input.ownerId),
        inArray(agentProposalsTable.showroomId, input.showroomIds),
        gte(agentProposalsTable.createdAt, new Date(Date.now() - windowDays * 86_400_000)),
      ),
    )
    .groupBy(agentProposalsTable.patternKey, agentProposalsTable.outcome);

  const consents = await db
    .select()
    .from(autonomyConsentsTable)
    .where(and(eq(autonomyConsentsTable.ownerId, input.ownerId), isNull(autonomyConsentsTable.revokedAt)))
    .orderBy(desc(autonomyConsentsTable.grantedAt));

  const consentBy = new Map<string, AutonomyConsentRow>();
  for (const c of consents) if (!consentBy.has(c.patternKey)) consentBy.set(c.patternKey, c);

  const counts = new Map<string, Record<string, number>>();
  for (const t of tally) {
    const row = counts.get(t.patternKey) ?? {};
    row[t.outcome] = t.n;
    counts.set(t.patternKey, row);
  }

  // Every pattern either side has something to say about. A pattern with
  // proposals and no precedent is real — the agent has been offering on a
  // habit that has since gone quiet — and hiding it would hide a demotion.
  const keys = new Set<string>([...precedent.keys(), ...counts.keys()]);

  for (const key of keys) {
    const parts = readPatternKey(key);
    const p = precedent.get(key) ?? null;
    const c = counts.get(key) ?? {};

    const offered = c["OFFERED"] ?? 0;
    const accepted = c["ACCEPTED"] ?? 0;
    const overridden = c["OVERRIDDEN"] ?? 0;
    const acted = c["ACTED"] ?? 0;

    /*
     * Answered, not offered.
     *
     * A proposal nobody reached is `EXPIRED` and counts neither way. Dividing
     * by everything offered would demote the agent for the dealership being
     * busy, which is the one thing this product exists to be sympathetic
     * about.
     */
    const answered = accepted + overridden;
    const overrideRatePct = answered === 0 ? null : Math.round((overridden / answered) * 100);

    const earned = earnedRung({
      precedentTotal: p?.total ?? 0,
      accepted: accepted + acted,
      answered,
      overrideRatePct,
      recallAfter,
      prefillAfter,
      overrideCeiling,
    });

    const { ceiling, reason } = ceilingFor(parts.action, input.principal ?? "AGENT");
    const consent = consentBy.get(key) ?? null;

    // Consent raises; evidence and the floor both cap. All three, in that order.
    const withConsent: Rung =
      consent && earned.rung === "PREFILLED" && accepted + acted >= consentAfter
        ? "AUTOMATIC"
        : earned.rung;
    const rung = lower(withConsent, ceiling);

    const consentDue =
      !consent &&
      earned.rung === "PREFILLED" &&
      accepted + acted >= consentAfter &&
      ceiling === "AUTOMATIC";

    let because = earned.because;
    if (rung !== withConsent && reason) {
      because = `${earned.because} It can go no further than pre-filled: ${reason}`;
    } else if (consentDue) {
      because = `${accepted + acted} accepted and none of them changed enough to worry about. Nobody has been asked whether it should just do this.`;
    } else if (rung === "AUTOMATIC" && consent) {
      because = `${consent.grantedByName ?? "Somebody"} allowed this to run unattended on ${new Date(
        consent.grantedAt,
      ).toLocaleDateString("en-IN", { day: "numeric", month: "long" })}, on ${consent.grantedOnCount} accepted.`;
    }

    out.set(key, {
      patternKey: key,
      module: p?.module ?? parts.module,
      state: p?.state ?? parts.state,
      action: parts.action,
      precedent: p,
      sentence: p && input.label ? precedentSentence(p, input.label) : null,
      offered,
      accepted,
      overridden,
      acted,
      overrideRatePct,
      earned: earned.rung,
      rung,
      ceiling,
      ceilingReason: reason,
      consent,
      consentDue,
      because,
    });
  }

  return out;
}

/**
 * A person allowing a pattern to run unattended.
 *
 * Owner or manager only, which is the same test that gates the dealership's own
 * numbers, and for the same reason: this is a decision about how the business
 * runs rather than about one record.
 *
 * **The floor is checked here as well as in the standing**, and that is not
 * belt-and-braces. `standingFor` decides what a screen may *offer*; this decides
 * what may be *written*. A consent row for an action the agent may never take
 * would sit in the table looking like permission, and the next person to read
 * the table would have to know the ceiling to know it meant nothing.
 */
export async function grantConsent(input: {
  ownerId: number;
  patternKey: string;
  userId: number;
  userName: string | null;
  onCount: number;
  principal: string;
}): Promise<{ ok: true; consent: AutonomyConsentRow } | { ok: false; status: 403 | 409; error: string }> {
  if (!may(input.principal, "policy.set")) {
    return { ok: false, status: 403, error: whyNot(input.principal, "policy.set") };
  }

  const { action } = readPatternKey(input.patternKey);
  const { ceiling, reason } = ceilingFor(action);
  if (ceiling !== "AUTOMATIC") {
    return {
      ok: false,
      status: 409,
      error: `This one can never run unattended, however often it is right. ${reason ?? ""}`.trim(),
    };
  }

  const [live] = await db
    .select()
    .from(autonomyConsentsTable)
    .where(
      and(
        eq(autonomyConsentsTable.ownerId, input.ownerId),
        eq(autonomyConsentsTable.patternKey, input.patternKey),
        isNull(autonomyConsentsTable.revokedAt),
      ),
    )
    .limit(1);
  if (live) return { ok: true, consent: live };

  const [row] = await db
    .insert(autonomyConsentsTable)
    .values({
      ownerId: input.ownerId,
      patternKey: input.patternKey,
      grantedByUserId: input.userId,
      grantedByName: input.userName,
      grantedOnCount: input.onCount,
    })
    .returning();

  return { ok: true, consent: row! };
}

/** Taken back, never deleted — the same argument as a cancelled message. */
export async function revokeConsent(input: {
  ownerId: number;
  patternKey: string;
  userId: number;
  reason: string;
  principal: string;
}): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
  if (!may(input.principal, "policy.set")) {
    return { ok: false, status: 403, error: whyNot(input.principal, "policy.set") };
  }

  const rows = await db
    .update(autonomyConsentsTable)
    .set({
      revokedAt: new Date(),
      revokedByUserId: input.userId,
      revokedReason: input.reason.trim() || null,
    })
    .where(
      and(
        eq(autonomyConsentsTable.ownerId, input.ownerId),
        eq(autonomyConsentsTable.patternKey, input.patternKey),
        isNull(autonomyConsentsTable.revokedAt),
      ),
    )
    .returning({ id: autonomyConsentsTable.id });

  if (rows.length === 0) {
    return { ok: false, status: 404, error: "Nothing was standing for this one." };
  }
  return { ok: true };
}
