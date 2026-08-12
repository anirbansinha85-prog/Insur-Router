import { may, whyNot, PERMISSION_FOR_ACTION, type RegistryActionId } from "./permissions";
import { applyAction } from "./actions";
import { patternKey } from "./precedent";
import { markActed, recordProposals, type ProposalToRecord } from "./proposals";
import { step } from "./trace";
import { logger } from "../logger";
import type { QueueItem } from "./queue";
import type { PatternStanding } from "./autonomy";
import type { ResolvedPolicy } from "./policy";

/**
 * The second agent (OBJ-29), and the whole point of it is how little it cost.
 *
 * ## The claim R-95 made, cashed
 *
 * > *A second agent is a principal and a set of grants, and `agent.ts` does not
 * > change.*
 *
 * `agent.ts` did not change. Not a line. This agent is a new principal in
 * `permissions.ts`, a list of eight grants beside it, and this file — which
 * calls the same `applyAction` a person's button calls, inherits the same
 * refusals, is placed on the same ladder, and appears in the same trace.
 *
 * Nothing was re-earned. The fourteen refusals it gets are the sentences that
 * were already written for the first agent, because the objection was never
 * about *which* agent — it was about what the act asserts, and *a model cannot
 * make a phone call* does not become less true when the model is a different
 * one.
 *
 * ## Why a second agent rather than a wider first one
 *
 * `part.request_transfer` and `vehicle.propose_transfer` were withheld from
 * `AGENT` with the reason *"not the band this agent is pointed at"* — an honest
 * proposal whose consequence is physical, held back until the assignments had
 * run for a while. Granting them to `AGENT` would have been the smaller diff
 * and the worse design: the ladder would then judge handing out enquiries and
 * committing a part to a van on **one** count, so a dealership that trusts the
 * first and distrusts the second would have no way to say so.
 *
 * Two principals, two sets of patterns, two independent standings. A showroom
 * can let one run unattended and keep the other at *pre-filled* for ever.
 *
 * ## What it actually does
 *
 * One thing. When a customer is waiting on a part that is out of stock here and
 * sitting on a shelf at another branch, it proposes requesting the transfer.
 *
 * That is the finding the spares module exists for — a DMS keeps the parts
 * ledger against a dealer code, so an owner with three outlets has three
 * ledgers and no way to ask the question — and it is **DDMS's own routing
 * decision** rather than a claim about anybody. Nothing here asserts that a
 * person did something, which is why the grant was available to give.
 *
 * ## It proposes what the queue already worked out
 *
 * The source branch is `item.actions`' own label, computed by the spares
 * classifier. This agent does not re-derive which outlet has the part: a second
 * opinion about that would be a second answer to a question the product already
 * answers, and the two would drift.
 */

export interface StockSuggestion {
  action: "PART_REQUEST_TRANSFER" | "VEHICLE_PROPOSE_TRANSFER";
  /** Which outlet is being asked, in the words already on the row. */
  fromLabel: string;
  reason: string;
  patternKey: string;
}

export const STOCK_AGENT: "STOCK_AGENT" = "STOCK_AGENT";

/**
 * Asked of the permission table, not of a list.
 *
 * The same shape as `isAgentAction`, one principal along. Two identical
 * functions differing in a string is the price of not having a second table,
 * and it is the right price — the alternative is a list that can disagree with
 * the grants.
 */
export function isStockAgentAction(action: string): boolean {
  const permission = PERMISSION_FOR_ACTION[action as RegistryActionId];
  return Boolean(permission) && may(STOCK_AGENT, permission);
}

/** What this agent may call, assembled from the table rather than declared. */
export const STOCK_AGENT_ACTIONS = (
  Object.keys(PERMISSION_FOR_ACTION) as RegistryActionId[]
).filter((id) => may(STOCK_AGENT, PERMISSION_FOR_ACTION[id]));

/**
 * The refusals, readable and inherited.
 *
 * Exported for the same reason the first agent's are: it is the artefact
 * anybody reviewing this agent's scope should read first. Every sentence in it
 * came from the table, and most came from the first agent unchanged.
 */
export const CLOSED_TO_THE_STOCK_AGENT: Record<string, string> = Object.fromEntries(
  (Object.keys(PERMISSION_FOR_ACTION) as RegistryActionId[])
    .filter((id) => !may(STOCK_AGENT, PERMISSION_FOR_ACTION[id]))
    .map((id) => [id, whyNot(STOCK_AGENT, PERMISSION_FOR_ACTION[id])]),
);

/**
 * What this agent would do to a queue item, and why.
 *
 * Only the parts counter today. The vehicle floor's `VEHICLE_PROPOSE_TRANSFER`
 * is granted and unused: the queue does not yet carry which outlet wants a
 * standing unit in a form this can read off, and inventing that here would be
 * the second-opinion problem again. The grant is honest — it says what this
 * agent *may* do — and the gap is a queue field rather than a permission.
 */
export function suggestStockMoves(items: QueueItem[]): Map<string, StockSuggestion> {
  const out = new Map<string, StockSuggestion>();

  for (const item of items) {
    if (item.module !== "PART") continue;

    /*
     * The row's own control, and its own label.
     *
     * `Request from ROH-01` was written by the spares classifier, which knows
     * which branch has the part. Reading it here rather than looking the part
     * up again is deliberate: two answers to *who has it* is exactly the drift
     * this product refuses everywhere else.
     */
    const control = item.actions.find((a) => a.action === "PART_REQUEST_TRANSFER" && !a.done);
    if (!control) continue;
    if (!isStockAgentAction("PART_REQUEST_TRANSFER")) continue;

    out.set(`${item.showroomId}:${item.recordKey}`, {
      action: "PART_REQUEST_TRANSFER",
      fromLabel: control.label,
      reason:
        `${item.title} is out of stock here and a customer is waiting` +
        `${item.waitingDays > 0 ? ` — ${item.waitingDays} day${item.waitingDays === 1 ? "" : "s"} now` : ""}. ` +
        `The company already owns one: ${control.label.replace(/^Request from /, "it is at ")}.`,
      patternKey: patternKey("PART", item.state, "PART_REQUEST_TRANSFER"),
    });
  }

  return out;
}

export interface StockAgentResult {
  showroomId: number;
  enabled: boolean;
  considered: number;
  proposed: number;
  acted: number;
  held: Array<{ patternKey: string; rung: string; because: string }>;
  refused: Array<{ recordKey: string; reason: string }>;
}

/**
 * One pass of the stock agent.
 *
 * Structurally the same as `runAgentForShowroom` and deliberately not shared
 * with it. The two agents differ in what they read, what they propose and what
 * their proposal *is* — one picks a person, the other picks a branch — and the
 * common part is four lines of loop. Factoring that out would produce an
 * abstraction that has to be widened every time a third agent has a slightly
 * different shape, which is how a two-agent runtime becomes a workflow engine
 * nobody can predict (R-52's failure, one level up).
 *
 * What *is* shared is everything that matters: `applyAction` is the same door,
 * the refusals are the same table, the ladder is the same function with a
 * different principal, and the proposals land in the same ledger.
 */
export async function runStockAgentForShowroom(
  ownerId: number,
  showroomId: number,
  items: QueueItem[],
  policy: ResolvedPolicy,
  standing: Map<string, PatternStanding>,
): Promise<StockAgentResult> {
  const result: StockAgentResult = {
    showroomId,
    enabled: policy.on("AGENT.ASSIGN_ORPHANS"),
    considered: 0,
    proposed: 0,
    acted: 0,
    held: [],
    refused: [],
  };

  const mine = items.filter((i) => i.showroomId === showroomId);
  const suggestions = suggestStockMoves(mine);
  if (suggestions.size === 0) return result;

  result.considered = suggestions.size;

  const toRecord: ProposalToRecord[] = [];
  for (const item of mine) {
    const s = suggestions.get(`${item.showroomId}:${item.recordKey}`);
    if (!s) continue;
    toRecord.push({
      ownerId,
      showroomId,
      patternKey: s.patternKey,
      module: "PART",
      recordKey: item.recordKey,
      action: s.action,
      proposedValue: { fromLabel: s.fromLabel },
      reason: s.reason,
      rung: 1,
    });
  }

  /*
   * Written down as offered whatever the switch says.
   *
   * The ladder's substrate. A dealership with the agent switched off still
   * accumulates evidence about whether it would have been right, which is what
   * makes turning it on later a decision based on something.
   */
  result.proposed = await recordProposals(toRecord);
  if (result.proposed > 0) {
    await step({
      kind: "PROPOSE",
      detail: `Stock agent offered ${result.proposed} transfer request(s) at ${showroomId}.`,
      payload: { patterns: [...new Set(toRecord.map((r) => r.patternKey))] },
    });
  }

  if (!result.enabled) return result;

  for (const item of mine) {
    const s = suggestions.get(`${item.showroomId}:${item.recordKey}`);
    if (!s) continue;

    /*
     * The rung decides, and it is this agent's rung.
     *
     * `standingFor` was computed for `STOCK_AGENT`, so a dealership that has
     * been accepting the first agent's assignments for a month has earned that
     * agent nothing here. Each pattern stands on its own evidence, which is the
     * reason there are two principals rather than one wider one.
     */
    const p = standing.get(s.patternKey);
    if (!p || p.rung !== "AUTOMATIC") {
      result.held.push({
        patternKey: s.patternKey,
        rung: p?.rung ?? "WATCHING",
        because: p?.because ?? "Nothing has happened here yet for it to have learned from.",
      });
      continue;
    }

    const applied = await applyAction({
      ownerId,
      // R-60's convention. The system acting has to be distinguishable from
      // having lost track of who acted.
      userId: null,
      action: s.action,
      recordKey: item.recordKey,
      showroomId,
      note: s.reason,
    });

    if (!applied.ok) {
      result.refused.push({ recordKey: item.recordKey, reason: applied.error });
      await step({
        kind: "REFUSED",
        module: "PART",
        recordKey: item.recordKey,
        action: s.action,
        detail: applied.error,
      });
      continue;
    }

    await step({
      kind: "ACT",
      module: "PART",
      recordKey: item.recordKey,
      action: s.action,
      detail: s.reason,
      decisionId: applied.decisionId,
    });

    // `ACTED`, not `ACCEPTED`. Nobody accepted anything, and keeping them apart
    // is what stops a pattern running unattended from re-earning the consent
    // that lets it run unattended.
    await markActed({
      ownerId,
      showroomId,
      module: "PART",
      recordKey: item.recordKey,
      action: s.action,
    });

    result.acted++;
    logger.info(
      { action: s.action, recordKey: item.recordKey, patternKey: s.patternKey },
      "Stock agent requested a transfer",
    );
  }

  return result;
}
