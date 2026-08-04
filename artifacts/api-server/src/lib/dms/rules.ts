/**
 * Rules that run themselves.
 *
 * Everything before this needed somebody signed in. The mirror emits events
 * with nobody watching (OBJ-13) and the queue orders what is waiting (OBJ-15),
 * but the product still only ever *reported* — a certificate sitting in a
 * drawer since March produced a row on a screen and nothing else. This is where
 * it produces a draft.
 *
 * ```
 * on   a record being in a state        the log is the state — see below
 * if   a condition over the same row the screen reads
 * then a draft through the gate that already refuses correctly
 * ```
 *
 * ## The whole rule set is below, and that is the point
 *
 * One ordered list, in code, capped at `MAX_RULES`. No rule builder, no
 * per-dealership flows, nothing composable. The research behind section 3b is
 * largely a catalogue of what happens when this becomes configuration —
 * eighty active flows on one object, eight-second saves, an automation layer
 * nobody can predict — and it is caused by good administrators working without
 * a governance layer above them. **DDMS's customer has no administrator at
 * all**, so the governance layer is this file being short enough to read.
 *
 * ## Triggering on the state, not on the transition
 *
 * The register said *on <event>*, and the implementation reads the current
 * state out of `record_events` instead. They are the same trigger — the newest
 * row per record *is* its state, which is the property OBJ-13 was built on —
 * but reading the state is the more honest of the two:
 *
 * - A missed pass loses nothing. Firing on the transition means a scheduler
 *   restart between the event and the rule silently drops the work for ever.
 * - A cadence falls out of it. *While the record is still in this state, and
 *   the last message about it was more than N days ago* is one query, and it is
 *   also the whole of R-57: the chase stops because the record moved, not
 *   because somebody remembered to stop it.
 *
 * ## What a rule may do, and what it may not
 *
 * It drafts, and it presses send. What happens then is `authoriseSend()`'s
 * decision and not this file's: an internal notification to somebody who still
 * works here is permitted by rule (R-50), and **every customer-facing message
 * without exception waits for a person**. So the rules below produce two very
 * different things from the same code path — a held internal note, and a draft
 * sitting in the Outbox with a person's name still to go on it. That asymmetry
 * is R-48 and it is not this file's to soften.
 *
 * **No rule writes a decision field**, and that is a finding rather than an
 * omission. R-56 permits it and `applyAction` would accept a null user id, but
 * every decision field in this product encodes a claim about something a person
 * did — *the customer was told*, *the RTO was chased*, *a reorder was raised*.
 * A rule writing one would be the product asserting work that never happened,
 * which is the same defect as a simulated policy number that looks issued. When
 * a field appears that records something the *system* did, a rule may write it.
 *
 * ## No model anywhere
 *
 * The trigger is a string comparison, the conditions are arithmetic on the
 * dealer's own dates, and the action is a template id. A model may still phrase
 * the resulting draft — `composer.ts` offers it that job and `checkRewrite()`
 * takes it back if it invents a figure — but nothing in the decision path here
 * asks one anything. That is R-49, and automation is exactly where it matters
 * most: this runs with nobody watching.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, outboundMessagesTable, ownersTable, showroomsTable } from "@workspace/db";
import { logger } from "../logger";
import { currentStates } from "./events";
import { cancelMessage, createDraft, sendMessage, type TemplateId } from "./outbound";
import { loadPolicy, type ResolvedPolicy } from "./policy";
import { buildRegistrationWorklist, type RegistrationWorklistRow } from "./registration-worklist";
import { buildServiceWorklist, type ServiceWorklistRow } from "./service-worklist";
import { buildLeadWorklist, type LeadWorklistRow } from "./lead-worklist";
import { buildReceivablesWorklist, type ReceivablesWorklistRow } from "./receivables-worklist";

/**
 * The ceiling, and it is a real one — `assertRuleSetFits` throws at import.
 *
 * Twelve is not a number derived from anything. It is small enough that the
 * whole set fits on one screen, which is the only property that matters: the
 * moment nobody can hold the automation in their head, the automation starts
 * doing things nobody intended. Raising it is a decision somebody should have
 * to make deliberately, in this file, with this comment in front of them.
 */
const MAX_RULES = 12;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type RuleModule = "REGISTRATION" | "JOB_CARD" | "ENQUIRY" | "RECEIVABLE";

/**
 * The row a rule's condition sees — deliberately the screen's own row, whole
 * and unmodified.
 *
 * A union rather than an index signature, so a condition that reaches for a
 * field the row does not have fails to compile instead of quietly reading
 * `undefined` and never firing. A rule that silently never runs is the worst
 * kind of bug this file could have: nothing is on screen to notice.
 */
type WorklistRow =
  | RegistrationWorklistRow
  | ServiceWorklistRow
  | LeadWorklistRow
  | ReceivablesWorklistRow;

export interface Rule {
  /** Stable, and it lands in `outbound_messages.authorisedRule` and the log. */
  id: string;
  /** One line. If it needs two, the rule is doing too much. */
  title: string;
  module: RuleModule;
  /** The state whose presence triggers it. Leaving this state is the goal. */
  on: string;
  /** An extra condition over the same row the screen reads. Optional. */
  when?: (row: WorklistRow) => boolean;
  /** What it drafts. */
  template: TemplateId;
  /**
   * Days before it may raise the same thing again while the record has not
   * moved. This is the cadence *and* the de-duplication: one number, so the
   * two cannot disagree.
   */
  cadenceDays: number;
  /** Why it stops, in words, for the screen. The mechanism is leaving `on`. */
  goal: string;
}

/**
 * The rule set.
 *
 * Ordered, and the order is the priority: the first rule whose trigger matches
 * a record is the one that runs, and no record produces two drafts in a pass.
 * A file that is both blocked on insurance and sitting past its temporary
 * registration should generate one message, not two, and which one is a
 * decision that belongs here rather than in whichever rule happened to be
 * evaluated first.
 */
export const RULES: Rule[] = [
  {
    id: "RC_IN_DRAWER_TELL_CUSTOMER",
    title: "The certificate is here and the customer does not know",
    module: "REGISTRATION",
    on: "RC_IN_DRAWER",
    template: "REGISTRATION_RC_READY",
    // Weekly. An RC sits in a drawer because everybody assumes somebody else
    // rang; a daily nudge would be the product becoming the nuisance.
    cadenceDays: 7,
    goal: "The customer collects it and the file leaves RC_IN_DRAWER.",
  },
  {
    id: "REGISTRATION_ORPHANED_ASSIGN",
    title: "A registration file with no agent on it",
    module: "REGISTRATION",
    on: "AWAITING_DOCS",
    // Narrowed on a field only a registration row has, which is what makes the
    // union above worth having: the compiler checks the rule matches its module.
    when: (r) => "regnFileNo" in r && !r.ddms.assignedAgentEmpCode && !r.agentEmpCode,
    template: "REGISTRATION_AGENT_ASSIGNED",
    cadenceDays: 3,
    goal: "Somebody is assigned to the file.",
  },
  {
    id: "SERVICE_READY_TELL_CUSTOMER",
    title: "The vehicle is finished and the customer does not know",
    module: "JOB_CARD",
    on: "READY_UNCOLLECTED",
    template: "SERVICE_VEHICLE_READY",
    // Every other day. A workshop bay held by a finished vehicle costs the
    // dealership money daily, and the customer wants the call.
    cadenceDays: 2,
    goal: "The vehicle is collected and the job card closes.",
  },
  {
    id: "LEAD_ORPHANED_HANDOVER",
    title: "An enquiry whose salesman has left",
    module: "ENQUIRY",
    on: "NO_OWNER",
    template: "LEAD_HANDOVER",
    cadenceDays: 2,
    goal: "Somebody still here is carrying the enquiry.",
  },
  {
    id: "RECEIVABLE_PROMISE_BROKEN_STATEMENT",
    title: "A payment date came and went",
    module: "RECEIVABLE",
    on: "PROMISE_BROKEN",
    template: "RECEIVABLE_STATEMENT",
    // Fortnightly. A statement is a formal thing and sending one weekly reads
    // as harassment to a party the dealership has to keep working with.
    cadenceDays: 14,
    goal: "The invoice is paid, or somebody marks it disputed.",
  },
];

/**
 * Fail at import rather than in production.
 *
 * Same reasoning as the service key and the restricted role: a cap nobody
 * enforces is a comment. Duplicate ids are checked here too, because the id is
 * what an audit uses to ask *which rule sent this*, and two rules answering to
 * one name makes that question unanswerable.
 */
function assertRuleSetFits(): void {
  if (RULES.length > MAX_RULES) {
    throw new Error(
      `${RULES.length} rules, and the ceiling is ${MAX_RULES}. The cap exists because ` +
        `an automation layer nobody can hold in their head is the failure mode this ` +
        `product is designed against. Raise it deliberately in lib/dms/rules.ts, or ` +
        `retire a rule.`,
    );
  }
  const ids = new Set<string>();
  for (const r of RULES) {
    if (ids.has(r.id)) throw new Error(`Two rules share the id ${r.id}.`);
    ids.add(r.id);
  }
}
assertRuleSetFits();

export interface RuleRunResult {
  ownerId: number;
  showroomId: number;
  /** Records whose state matched a rule. */
  matched: number;
  /** Drafts created this pass. */
  drafted: number;
  /** Already raised inside the rule's cadence, so left alone. */
  withinCadence: number;
  /** Drafted and then refused by the gate — every customer message, by design. */
  awaitingPerson: number;
  /** Authorised by rule, and there is nothing to carry it. */
  held: number;
  /** Open drafts withdrawn because the record they were about moved on. */
  withdrawn: number;
  durationMs: number;
}

/** The row builders, by module. The same ones the screens and the queue use. */
async function rowsFor(
  module: RuleModule,
  showroomId: number,
  ownerShowroomIds: number[],
  policy: ResolvedPolicy,
): Promise<Map<string, WorklistRow>> {
  const keyed = new Map<string, WorklistRow>();
  switch (module) {
    case "REGISTRATION":
      for (const r of await buildRegistrationWorklist({ showroomId, policy }))
        keyed.set(r.regnFileNo, r);
      return keyed;
    case "JOB_CARD":
      for (const r of await buildServiceWorklist({ showroomId })) keyed.set(r.jcNo, r);
      return keyed;
    case "ENQUIRY":
      for (const r of await buildLeadWorklist({ showroomId })) keyed.set(r.enqId, r);
      return keyed;
    case "RECEIVABLE":
      for (const r of await buildReceivablesWorklist({ showroomId, ownerShowroomIds, policy }))
        keyed.set(r.receivableId, r);
      return keyed;
  }
}

/**
 * One pass of the rule set over one outlet.
 *
 * Reads the state out of the event log, then the rows out of the same builders
 * the screens use — the third reading of one projection, after the screen and
 * the detector, and the reason all three agree.
 */
export async function runRules(
  ownerId: number,
  showroomId: number,
  ownerShowroomIds: number[],
): Promise<RuleRunResult> {
  const startedAt = Date.now();
  const states = await currentStates(ownerId);
  const policy = await loadPolicy(ownerId);

  const result: RuleRunResult = {
    ownerId,
    showroomId,
    matched: 0,
    drafted: 0,
    withinCadence: 0,
    awaitingPerson: 0,
    held: 0,
    withdrawn: 0,
    durationMs: 0,
  };

  // Rows are fetched once per module rather than once per rule: two rules over
  // registrations should not mean two passes over the dealer's files.
  const needed = new Set(RULES.map((r) => r.module));
  const rows = new Map<RuleModule, Map<string, WorklistRow>>();
  for (const module of needed)
    rows.set(module, await rowsFor(module, showroomId, ownerShowroomIds, policy));

  // One draft per record per pass. The rule set is ordered, so the first match
  // wins and a file that is wrong in two ways produces one message.
  const handled = new Set<string>();

  for (const rule of RULES) {
    const keyed = rows.get(rule.module);
    if (!keyed) continue;

    for (const [recordKey, row] of keyed) {
      const state = states.get(`${rule.module}:${showroomId}:${recordKey}`);
      // No event row means the detector has not classified this record yet.
      // Not a reason to act: the whole design is that a rule fires on a state
      // the log says the record is in, and silence is not a state.
      if (!state || state.state !== rule.on) continue;
      if (rule.when && !rule.when(row)) continue;
      if (handled.has(`${rule.module}:${recordKey}`)) continue;

      result.matched++;
      handled.add(`${rule.module}:${recordKey}`);

      const draft = await createDraft({
        ownerId,
        // Null: a rule drafted this, not a person. R-60.
        userId: null,
        showroomId,
        ownerShowroomIds,
        template: rule.template,
        recordKey,
        reuseWindowMs: rule.cadenceDays * DAY_MS,
      });

      if (!draft.ok) {
        // The commonest refusal is the state check inside `createDraft` — the
        // row moved between the detector's pass and this one. Expected, and
        // worth a line rather than a warning.
        logger.debug(
          { rule: rule.id, recordKey, showroomId, error: draft.error },
          "Rule did not draft",
        );
        continue;
      }

      if (draft.reused) {
        result.withinCadence++;
        continue;
      }

      result.drafted++;

      // And then the gate, which is the only thing that decides whether this
      // may go anywhere. A customer message is refused here every time and
      // waits in the Outbox for a person — that refusal is the product working.
      const sent = await sendMessage(ownerId, null, draft.message.id);
      if (!sent.ok) result.awaitingPerson++;
      else if (sent.message.status === "HELD_NO_TRANSPORT") result.held++;
    }
  }

  result.withdrawn = await withdrawStaleDrafts(ownerId, showroomId, states);

  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Withdraw drafts about records that have since moved.
 *
 * R-57 says a chase stops when its goal state is reached, and stopping the
 * *cadence* turned out not to be the whole of it. A draft raised on Monday
 * about a certificate in a drawer is still sitting in the Outbox on Friday
 * after the customer collected it, waiting for somebody to approve telling them
 * to come and collect it. Nothing about that message is true any more, and the
 * person approving it has no way to know.
 *
 * So: any message still `DRAFT`, raised by a rule, about a record no longer in
 * the state that raised it, is cancelled — with a null user id, because the
 * system withdrew it (R-60).
 *
 * **Only `DRAFT`, and only rule-raised.** A person's draft is theirs to cancel;
 * an approved message has had somebody read it and is a decision, not a
 * proposal. Cancelled rather than deleted, because *we chose not to send this*
 * and *nobody ever drafted anything* are different facts and only one of them
 * can be defended later.
 */
async function withdrawStaleDrafts(
  ownerId: number,
  showroomId: number,
  states: Map<string, { state: string; since: Date }>,
): Promise<number> {
  const byTemplate = new Map(RULES.map((r) => [r.template, r]));

  const open = await db
    .select({
      id: outboundMessagesTable.id,
      module: outboundMessagesTable.module,
      recordKey: outboundMessagesTable.recordKey,
      template: outboundMessagesTable.template,
    })
    .from(outboundMessagesTable)
    .where(
      and(
        eq(outboundMessagesTable.ownerId, ownerId),
        eq(outboundMessagesTable.showroomId, showroomId),
        eq(outboundMessagesTable.status, "DRAFT"),
        isNull(outboundMessagesTable.createdByUserId),
      ),
    );

  let withdrawn = 0;
  for (const msg of open) {
    const rule = msg.template ? byTemplate.get(msg.template as TemplateId) : undefined;
    if (!rule) continue;
    const state = states.get(`${rule.module}:${showroomId}:${msg.recordKey}`);
    if (state && state.state === rule.on) continue;

    const res = await cancelMessage(
      ownerId,
      null,
      msg.id,
      `Withdrawn: ${msg.module.toLowerCase()} ${msg.recordKey} is no longer ` +
        `${rule.on.replace(/_/g, " ").toLowerCase()}, so ${rule.goal.toLowerCase()}`,
    );
    if (res.ok) {
      withdrawn++;
      logger.info(
        { rule: rule.id, messageId: msg.id, recordKey: msg.recordKey },
        "Rule withdrew a draft — the record moved",
      );
    }
  }
  return withdrawn;
}

/**
 * Every owner, every outlet. Called by the scheduler after detection.
 *
 * After, and not before: a rule fires on a state, and the pass that works out
 * the states has to have finished. Running these in the other order would mean
 * every rule acting on the picture from fifteen minutes ago.
 */
export async function runRulesForAll(): Promise<RuleRunResult[]> {
  const owners = await db.select({ id: ownersTable.id }).from(ownersTable);
  const out: RuleRunResult[] = [];

  for (const owner of owners) {
    const showrooms = await db
      .select({ id: showroomsTable.id })
      .from(showroomsTable)
      .where(and(eq(showroomsTable.ownerId, owner.id), eq(showroomsTable.isActive, true)));
    const ids = showrooms.map((s) => s.id);
    if (ids.length === 0) continue;

    for (const showroomId of ids) {
      try {
        out.push(await runRules(owner.id, showroomId, ids));
      } catch (err) {
        // One outlet's rules failing must not stop another's, for the same
        // reason one unreachable dealership does not stop the sync.
        logger.error(
          { err: err instanceof Error ? err.message : String(err), ownerId: owner.id, showroomId },
          "Rule pass failed for one showroom",
        );
      }
    }
  }
  return out;
}

/** The set, for the screen that shows what may fire. Read-only by construction. */
export function describeRules(): Array<Omit<Rule, "when"> & { conditional: boolean }> {
  return RULES.map(({ when, ...rest }) => ({ ...rest, conditional: Boolean(when) }));
}

export { MAX_RULES };
