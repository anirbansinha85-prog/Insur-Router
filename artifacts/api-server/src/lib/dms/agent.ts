/**
 * The agent, operating the registry — and the ten actions it may not touch.
 *
 * Everything before this file had the agent describing work. `explain.ts`
 * answers *why is this stuck*, `composer.ts` phrases a message, and neither
 * changes a record. This is the first place the model's side of the product
 * reaches an action, and the design is Agentforce's useful idea: an agent is a
 * declared role with a **closed set of actions**, and every refusal the closed
 * set already makes it inherits for free — 409 for a departed employee, 404
 * across tenants, row-level security underneath all of it.
 *
 * ## The set is two of twelve, and that is a finding rather than timidity
 *
 * OBJ-16 established that no *rule* may write a decision field, because every
 * decision field in this product encodes a claim about something a **person**
 * did: the customer was told, the RTO was chased, the bike was shown. A rule
 * writing one asserts work that never happened. That objection does not weaken
 * when the writer is a model — it gets stronger, because a model is the thing
 * most likely to produce a plausible sentence about a phone call nobody made.
 *
 * So the question for each of the twelve was not *can the agent do this* but
 * *what would be true of the dealership if it did*. Two survive: they record a
 * routing decision DDMS itself is making, and DDMS is entitled to make it.
 *
 * That is also the capacity thesis at its narrowest and most defensible. The
 * queue's **Nobody's** band is work assigned to somebody who left, or to nobody
 * at all — it is late by no measure the DMS holds, it is on no one's list, and
 * a short-staffed dealership is short of exactly the person who would notice.
 * The agent is pointed at that band and nowhere else.
 *
 * ## Off until a dealership turns it on
 *
 * `AGENT.ASSIGN_ORPHANS` in the policy registry, default 0. Until an owner sets
 * it, the agent **proposes** — the suggestion rides on the queue row with a
 * person's click to accept, and that click is logged as theirs. Set to 1, the
 * scheduler assigns unattended and `decision_log.userId` is null, which R-60
 * insists reads as *the system did this* rather than *we lost track of who*.
 *
 * Nothing switches on under a dealership's feet, and acting unattended from the
 * first deploy would have been the version where the dealership never chose it.
 *
 * ## The rule chooses; the model may only phrase
 *
 * The assignee is picked deterministically — the lightest-loaded person in the
 * role the queue asks for, from staff who still work here. That is right every
 * time, and a model that is right most of the time would be a downgrade dressed
 * as an upgrade (R-49). What the model may do is write the sentence that goes
 * on the row and into the log, checked by the same `citationsHold()` the
 * explanation panel uses, so it cannot invent a workload figure. With no key
 * the deterministic sentence stands and the agent works unchanged — the same
 * property that decides whether this is a feature or a demo.
 */

import { logger } from "../logger";
import { applyAction, listStaff, type ActionId } from "./actions";
import { citationsHold } from "./explain";
import type { ResolvedPolicy } from "./policy";
import type { QueueItem } from "./queue";
import type { Evidence } from "./tools";

/**
 * Everything the agent may call, and it is the whole of it.
 *
 * A closed set stated as data rather than as a condition somewhere in a
 * function, so that adding to it is a diff somebody reviews rather than a
 * branch somebody widens.
 */
export const AGENT_ACTIONS = ["ENQUIRY_REASSIGN", "REGISTRATION_ASSIGN_AGENT"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/**
 * The ten it may not call, each with the reason written next to it.
 *
 * Kept as a table rather than as an absence, because *why not* is the part
 * worth reviewing. Anybody proposing to move one of these into the set above
 * has to argue with the sentence beside it, and most of these sentences do not
 * lose their force with time — a model will never be able to make a phone call.
 */
export const CLOSED_TO_THE_AGENT: Record<Exclude<ActionId, AgentAction>, string> = {
  ENQUIRY_LOG_CONTACT:
    "Asserts somebody rang the customer. The agent cannot ring anybody, and the mark removes the row from the calls-to-make count.",
  JOB_CARD_MARK_INFORMED:
    "Asserts the customer was told their vehicle is ready. Same objection, and the customer is the one who finds out it was false.",
  REGISTRATION_MARK_NOTIFIED:
    "Asserts the customer was told their certificate has arrived. A file marked notified stops being chased.",
  REGISTRATION_LOG_CHASE:
    "Asserts somebody rang the RTO. A chase that never happened makes a stalled file look handled for another week.",
  RECEIVABLE_LOG_CHASE:
    "Asserts somebody asked a party for money. The dealership's cash position is not a place to record work that did not occur.",
  VEHICLE_MARK_OFFERED:
    "Asserts a salesman showed the unit to a named customer. It is also the field whose absence means nobody has asked for this bike.",
  RECEIVABLE_MARK_DISPUTED:
    "A judgement about whether a customer's account is in breach. R-49 reserves exactly that from a model, whatever it is confident of.",
  PART_RAISE_REORDER:
    "Asserts a purchase order was raised in the dealer's own system, which DDMS never writes to (R-5, R-40).",
  PART_REQUEST_TRANSFER:
    "Commits stock to move between outlets. A proposal rather than a claim, but the consequence is physical and it is not the band this agent is pointed at.",
  VEHICLE_PROPOSE_TRANSFER:
    "Same. Honest as a proposal, and held back until the two assignments have run for a while in a real dealership.",
};

/**
 * What the agent would do to one queue item, and why.
 *
 * The same object whether it is about to be applied or is only being shown, so
 * *what the agent proposed* and *what the agent did* cannot describe the work
 * differently.
 */
export interface AgentSuggestion {
  action: AgentAction;
  empCode: string;
  empName: string;
  /** What they are already carrying. On the row, because it is the reason. */
  carrying: number;
  /** How many people were in the running. One candidate is worth saying so. */
  consideredCount: number;
  /** One sentence, deterministic unless a model improved it and the check held. */
  reason: string;
  /** Present when a model wrote a sentence and it was refused. */
  narrationRejected?: string | null;
}

// ── Choosing ────────────────────────────────────────────────────────────────

/**
 * The lightest-loaded person in the role the queue asked for.
 *
 * `listStaff` already excludes anybody who has left and already counts what
 * each is carrying, so the choice is a sort rather than a judgement — which is
 * the point. Ties break on name so two passes over unchanged data choose the
 * same person, and an agent whose answer wobbles is an agent nobody trusts.
 *
 * Falls back to the whole outlet when nobody holds the role. A dealership with
 * no RTO agent on its staff master still has orphaned registration files, and
 * refusing to route them because the ideal recipient does not exist would leave
 * the work exactly where it was.
 */
async function chooseAssignee(
  showroomId: number,
  role: string | null,
): Promise<{ empCode: string; empName: string; carrying: number; consideredCount: number } | null> {
  let candidates = await listStaff(showroomId, role ?? undefined);
  if (candidates.length === 0 && role) candidates = await listStaff(showroomId);
  if (candidates.length === 0) return null;

  // `listStaff` sorts by load then name already; taking the head keeps the two
  // orderings from drifting apart.
  const pick = candidates[0]!;
  return {
    empCode: pick.empCode,
    empName: pick.empName,
    carrying: pick.carrying,
    consideredCount: candidates.length,
  };
}

/** The sentence a rule can write, and the one that stands when there is no model. */
function deterministicReason(
  item: QueueItem,
  pick: { empName: string; carrying: number; consideredCount: number },
): string {
  const orphan = item.assigneeGone
    ? `${item.assignedEmpName ?? item.assignedEmpCode} has left the dealership, so this is on nobody's list`
    : "Nobody is on this";
  // "carrying 3, the fewest of 2" was the first wording and it is the kind of
  // sentence that makes a reader distrust the number rather than the phrasing:
  // the 2 is how many people were in the running and the 3 is what the chosen
  // one holds, and putting them in one clause invites them to be read as the
  // same kind of thing.
  const field =
    pick.consideredCount === 1
      ? `${pick.empName} is the only person still here who can take it, and is carrying ${pick.carrying}`
      : `${pick.empName} is carrying ${pick.carrying} — the lightest load of the ${pick.consideredCount} still here`;
  return `${orphan}. ${field}.`;
}

// ── The model's half ────────────────────────────────────────────────────────

const PHRASE_SYSTEM = [
  "You write one sentence for a dealership manager, explaining why a piece of",
  "work has just been handed to a named member of staff.",
  "",
  "- The choice has already been made by a rule. You are not being asked whether",
  "  it is right, and you must not suggest a different person.",
  "- Use only the figures given. Do not introduce a number that is not there.",
  "- Two short sentences at most, plain Indian English, no preamble.",
].join("\n");

/**
 * Ask a model for a better sentence, and keep the rule's if it will not do.
 *
 * The same arrangement as the explanation panel and for the same reason: the
 * evidence is assembled first, the model narrates over exactly that, and
 * `citationsHold()` refuses anything carrying a figure the evidence does not.
 * A wrong workload number in a sentence saying *he is carrying the fewest* is
 * the failure that would make the whole feature untrustworthy, and it is
 * precisely the failure a check catches for free.
 */
async function phrase(
  item: QueueItem,
  pick: { empName: string; carrying: number; consideredCount: number },
  fallback: string,
): Promise<{ reason: string; rejected: string | null }> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key || process.env["AGENT_MODEL"] === "off") return { reason: fallback, rejected: null };

  const evidence: Evidence[] = [
    {
      tool: "chooseAssignee",
      looked: "who still works here and what each is already carrying",
      rows: [
        {
          empName: pick.empName,
          carrying: pick.carrying,
          consideredCount: pick.consideredCount,
          waitingDays: item.waitingDays,
          // The record's own key, and it is here because leaving it out made
          // the check refuse a sentence that was entirely true. `REG-0417-3307`
          // reads to `citationsHold` as the figure 04173307, which no tool had
          // returned, so a model naming the file it was talking about was
          // rejected for inventing a number. The check was right to refuse a
          // figure it could not find; the fix is to give it the figure, not to
          // weaken the check.
          recordKey: item.recordKey,
        },
      ],
    },
  ];

  const model = process.env["AGENT_MODEL"] || "gemini-flash-latest";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PHRASE_SYSTEM }] },
          generationConfig: { temperature: 0.2, maxOutputTokens: 2_000 },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    `Work: ${item.module.replace(/_/g, " ").toLowerCase()} ${item.recordKey} — ${item.title}`,
                    `What is needed: ${item.actionRequired}`,
                    `Waiting: ${item.waitingDays} days`,
                    `The rule's sentence: ${fallback}`,
                  ].join("\n"),
                },
              ],
            },
          ],
        }),
      },
    );

    if (!res.ok) return { reason: fallback, rejected: null };

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const finish = json.candidates?.[0]?.finishReason;
    if (!text || (finish && finish !== "STOP")) return { reason: fallback, rejected: null };

    const check = citationsHold(text, evidence, [fallback]);
    if (!check.ok) {
      logger.warn({ problem: check.problem }, "Agent sentence rejected");
      return { reason: fallback, rejected: check.problem };
    }
    return { reason: text, rejected: null };
  } catch {
    return { reason: fallback, rejected: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── Proposing ───────────────────────────────────────────────────────────────

/**
 * What the agent would do to each of these items.
 *
 * Called on the queue's read path, so it is deliberately cheap: one staff
 * lookup per outlet, reused across every item at that outlet, and **no model**.
 * A queue that takes two seconds to load because a model wrote a sentence
 * nobody asked for is a queue people stop opening, and the deterministic
 * sentence is the one that has to be right anyway.
 */
export async function suggestForItems(
  items: QueueItem[],
): Promise<Map<string, AgentSuggestion>> {
  const out = new Map<string, AgentSuggestion>();
  const byOutletRole = new Map<
    string,
    Awaited<ReturnType<typeof chooseAssignee>>
  >();

  for (const item of items) {
    // The band and the action are the queue's decision, not the agent's. An
    // item outside the Nobody's band has somebody on it, and handing their work
    // to another person is not a gap this is meant to fill.
    if (item.band !== "UNASSIGNED") continue;
    if (!item.assignAction || !isAgentAction(item.assignAction)) continue;

    const cacheKey = `${item.showroomId}:${item.assignRole ?? "*"}`;
    if (!byOutletRole.has(cacheKey)) {
      byOutletRole.set(cacheKey, await chooseAssignee(item.showroomId, item.assignRole));
    }
    const pick = byOutletRole.get(cacheKey);
    if (!pick) continue;

    out.set(`${item.module}:${item.showroomId}:${item.recordKey}`, {
      action: item.assignAction,
      empCode: pick.empCode,
      empName: pick.empName,
      carrying: pick.carrying,
      consideredCount: pick.consideredCount,
      reason: deterministicReason(item, pick),
    });
  }

  return out;
}

export function isAgentAction(action: string): action is AgentAction {
  return (AGENT_ACTIONS as readonly string[]).includes(action);
}

// ── Acting ──────────────────────────────────────────────────────────────────

export interface AgentRunResult {
  showroomId: number;
  /** False when this dealership has not switched the agent on. */
  enabled: boolean;
  considered: number;
  assigned: number;
  /** Refusals, kept rather than counted — each one is why a record is still stuck. */
  refused: Array<{ recordKey: string; reason: string }>;
}

/**
 * Assign what nobody is on, unattended, if this dealership has asked for it.
 *
 * Runs in the scheduler on `ddms_worker`, after detection and after the rules —
 * after, because the queue it reads is built from derived state and reading it
 * before the pass that computes that state would act on yesterday's picture.
 *
 * **Every write goes through `applyAction`**, the same function the button
 * calls, with `userId` null. Nothing here re-implements a check, which is the
 * whole point of pointing an agent at a registry: the departed-employee 409 and
 * the cross-tenant 404 are inherited rather than repeated, and a refusal the
 * agent gets is a refusal a person would have got.
 */
export async function runAgentForShowroom(
  ownerId: number,
  showroomId: number,
  items: QueueItem[],
  policy: ResolvedPolicy,
): Promise<AgentRunResult> {
  const result: AgentRunResult = {
    showroomId,
    enabled: policy.on("AGENT.ASSIGN_ORPHANS"),
    considered: 0,
    assigned: 0,
    refused: [],
  };
  if (!result.enabled) return result;

  const suggestions = await suggestForItems(items.filter((i) => i.showroomId === showroomId));

  for (const [key, s] of suggestions) {
    result.considered++;
    const recordKey = key.split(":").slice(2).join(":");
    const item = items.find(
      (i) => i.recordKey === recordKey && i.showroomId === showroomId,
    );
    if (!item) continue;

    const detail = await phrase(item, s, s.reason);

    const applied = await applyAction({
      ownerId,
      // R-60's convention, and the reason `userId` was made nullable a
      // fortnight before anything could write null to it: the system acting has
      // to be distinguishable from having lost track of who acted.
      userId: null,
      action: s.action,
      recordKey: item.recordKey,
      showroomId,
      empCode: s.empCode,
      note: detail.reason,
    });

    if (!applied.ok) {
      // Not swallowed and not thrown. A refusal is the interesting outcome —
      // it is the sentence that says why a record somebody is waiting on is
      // still sitting there — and one bad record must not stop the rest.
      result.refused.push({ recordKey: item.recordKey, reason: applied.error });
      logger.info(
        { action: s.action, recordKey: item.recordKey, reason: applied.error },
        "Agent was refused, exactly as a person would have been",
      );
      continue;
    }

    result.assigned++;
    logger.info(
      { action: s.action, recordKey: item.recordKey, empCode: s.empCode, carrying: s.carrying },
      "Agent assigned orphaned work",
    );
  }

  return result;
}
