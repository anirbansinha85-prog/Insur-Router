/**
 * The dealership's own numbers, and the closed set of numbers they may be.
 *
 * Two things decide how a short-staffed dealership spends its day, and until
 * OBJ-18 both were ours: the severity table that orders the queue, and the
 * thresholds each classifier uses to decide something has gone wrong. Neither
 * is a product question. *Is a stuck registration worse than a broken payment
 * promise* depends on whether this dealership's RTO agent is snowed under or
 * its cash position is tight, and we do not know either.
 *
 * ## This file is the boundary, and the boundary is the point
 *
 * Every key that may exist is below, with a default, a range and a sentence
 * saying what it means. A key not here is rejected on write and ignored on
 * read. So a dealership may change **what the numbers are** and can never
 * change **what the product does with them** — which is the difference between
 * configuration and a rule builder, and the whole of R-52.
 *
 * The failure being designed against is eighty active flows on one object and
 * an automation layer nobody can predict. Eighty numbers cannot do that. A
 * customer with no administrator can safely be handed numbers; the same
 * customer cannot safely be handed logic, and the research behind section 3b
 * is largely a catalogue of what happens when they are.
 *
 * ## Defaults live in code, never in the table
 *
 * A row exists only where somebody set something. That makes *reset* a delete,
 * and it means the product improving its own default actually reaches the
 * dealerships that never had an opinion — where a table seeded with defaults
 * would freeze every dealership on whatever we thought in August.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, dealerPolicyTable, decisionLogTable, showroomsTable } from "@workspace/db";

export type PolicyGroup = "SEVERITY" | "THRESHOLD" | "SWITCH";

export interface PolicyKey {
  key: string;
  group: PolicyGroup;
  /** Which screen this shows up on, for grouping. */
  section: string;
  label: string;
  /** One sentence. What changing it actually does. */
  help: string;
  default: number;
  min: number;
  max: number;
  /**
   * What the number is, so the screen can render it and a reader can weigh it.
   *
   * `count` and `percent` arrived with OBJ-26. The registry began as thresholds
   * measured in days and the vocabulary followed; a ladder counts acceptances
   * and measures an override rate, and calling either of those "days" on a
   * screen a dealership reads would be worse than adding two words here.
   */
  unit: "rank" | "days" | "switch" | "count" | "percent";
}

/**
 * The one thing on this screen that is not a number.
 *
 * A switch sits oddly in a registry built for thresholds, and it earns the
 * exception for the same reason the registry exists: this is the dealership's
 * decision, not ours, and there is nowhere else that is theirs. Storing it as
 * 0 or 1 keeps `dealer_policy` a table of numbers, so reset is still a delete
 * and the sparse rule still holds.
 *
 * **Default 0, and the default is the argument.** An agent that starts writing
 * to a dealership's records the day it deploys is one the dealership never
 * chose. Off, the agent proposes on the queue row and a person clicks; on, it
 * assigns unattended and a person can undo.
 */
const SWITCH_KEYS: PolicyKey[] = [
  {
    key: "AGENT.ASSIGN_ORPHANS",
    group: "SWITCH",
    section: "The agent",
    label: "Let the agent hand out orphaned work",
    help:
      "Work assigned to an employee who has left, or to no one at all, is given to the person " +
      "with the lightest load who is still here. Off, it only suggests and you click. " +
      "Either way you can undo it, and the log says the agent did it.",
    default: 0,
    min: 0,
    max: 1,
    unit: "switch",
  },
  {
    /*
     * Only one system may hold a sequential tax-invoice series (R-90), and
     * which one is a fact about this dealership rather than a product decision.
     *
     * Off by default, and the default is the safe direction: DDMS issues a
     * *sale confirmation* carrying the DMS's invoice number for linkage, and
     * says on its face that it is not a tax invoice. Switching it on is a
     * dealership saying "our GST series is yours now", which is a real
     * commitment and must be a deliberate act rather than something that
     * happened because a default was convenient.
     */
    key: "SWITCH.DDMS_HOLDS_TAX_SERIES",
    group: "SWITCH",
    section: "Invoicing",
    label: "DDMS issues the tax invoice",
    help:
      "Off, your own system numbers the tax invoice and ours is a sale confirmation that " +
      "carries your number and says it is not a tax invoice. On, ours issues the number " +
      "from its own series. Only one system may hold the series — two produces gaps or " +
      "duplicates, and both are audit findings.",
    default: 0,
    min: 0,
    max: 1,
    unit: "switch",
  },
];

/**
 * How much the product has to have watched before it starts helping (OBJ-26).
 *
 * The whole of R-79's third property. Autonomy earned by evidence needs a
 * number saying *how much evidence*, and that number is not a product opinion:
 * a cautious owner sets the consent threshold at 25, a confident one at 5, and
 * both are right about their own dealership. Putting it in the registry means
 * it is theirs, it is visible on the *Your numbers* screen beside every other
 * number that decides their day, and it can never become a rule builder —
 * five numbers cannot turn into eighty flows nobody can predict (R-52).
 *
 * The override ceiling is the one borrowed number here. wrrk.ai's cruder
 * version of the same instinct reached 20% independently: above it the agent is
 * not ready and more autonomy is the wrong answer.
 */
const AUTONOMY_KEYS_REGISTRY: PolicyKey[] = [
  {
    key: "AUTONOMY.WINDOW_DAYS",
    group: "THRESHOLD",
    section: "What the product has learned",
    label: "How far back it looks",
    help:
      "A habit is counted over this many days. Anything older stops counting, so a way of "
      + "working you drop leaves the product by itself rather than by somebody remembering "
      + "to switch it off.",
    default: 60,
    min: 7,
    max: 365,
    unit: "days",
  },
  {
    key: "AUTONOMY.RECALL_AFTER",
    group: "THRESHOLD",
    section: "What the product has learned",
    label: "Decisions before it says anything",
    help:
      "How many times somebody here has to have handled a situation before the product "
      + "starts telling you what you did last time. Below this it watches and says nothing.",
    default: 3,
    min: 2,
    max: 50,
    unit: "count",
  },
  {
    key: "AUTONOMY.PREFILL_AFTER",
    group: "THRESHOLD",
    section: "What the product has learned",
    label: "Accepted before it fills the answer in",
    help:
      "How many of its suggestions you have to accept before the answer arrives already "
      + "selected. You still press the button and you can still change it.",
    default: 5,
    min: 2,
    max: 100,
    unit: "count",
  },
  {
    key: "AUTONOMY.CONSENT_AFTER",
    group: "THRESHOLD",
    section: "What the product has learned",
    label: "Accepted before it asks to do it on its own",
    help:
      "At this many, the product asks whether it should just do this one from now on. It "
      + "asks — it never promotes itself, and you can take the answer back at any time.",
    default: 10,
    min: 3,
    max: 200,
    unit: "count",
  },
  {
    key: "AUTONOMY.OVERRIDE_CEILING_PCT",
    group: "THRESHOLD",
    section: "What the product has learned",
    label: "Corrections that mean it is not ready",
    help:
      "If you change more than this share of its answers, it stops filling them in and goes "
      + "back to just telling you what you did last time. Items nobody got to do not count "
      + "against it — a busy week is not a rejection.",
    default: 20,
    min: 1,
    max: 90,
    unit: "percent",
  },
];

/**
 * What comes first.
 *
 * 3 today, 2 this week, 1 behind the other two — the same three bands the queue
 * has always sorted on, now per owner. Only states that can produce queue work
 * are here: a state with nothing to do about it has no priority to set.
 *
 * The defaults are the table OBJ-15 shipped with, kept verbatim so that a
 * dealership which never opens this screen sees exactly what it saw before.
 */
const SEVERITY_KEYS: Array<[string, string, string, string, number]> = [
  // module, state, label, help, default
  ["DEAL", "CONFLICT", "Insurance conflict", "Our record and the OEM's disagree about the policy.", 3],
  ["DEAL", "BEHIND", "Policy not reflected upstream", "Issued here; the manufacturer's system does not hold it.", 2],
  ["DEAL", "NOT_STARTED", "No insurance on record", "A delivered vehicle with no policy in either system.", 2],
  ["DEAL", "AHEAD", "Awaiting upstream update", "Recorded here; the manufacturer's system has not caught up.", 1],

  // The sale journey (OBJ-25). READY_TO_INVOICE is the first entry in this
  // table that is not a fault — nothing is wrong, there is simply money
  // standing still. Two rather than three by default: an owner who wants
  // invoicing chased daily can raise it, and starting it at the top of every
  // queue would bury the things that are actually broken.
  ["DEAL", "READY_TO_INVOICE", "Ready to invoice", "Every requirement is met and no invoice has been raised.", 2],
  ["DEAL", "UNPRICED", "No price on record", "No price list covers this model, so it cannot be invoiced.", 2],
  ["DEAL", "UNALLOCATED", "Awaiting allocation", "Booked, with no chassis assigned.", 1],
  ["DEAL", "UNDELIVERED", "Invoiced, not delivered", "Sold and still on the floor.", 1],

  ["JOB_CARD", "OVERDUE", "Past the promised date", "The customer was given a date and it has passed.", 3],
  ["JOB_CARD", "READY_UNCOLLECTED", "Ready, not collected", "Work complete and the vehicle is occupying a bay.", 3],
  ["JOB_CARD", "AWAITING_APPROVAL", "Awaiting customer approval", "Work is halted pending approval of the estimate.", 2],
  ["JOB_CARD", "AWAITING_PART", "Waiting on a part", "The vehicle cannot move until a part arrives.", 2],
  ["JOB_CARD", "FOLLOW_UP_DUE", "Post-service call due", "The follow-up call is not yet recorded.", 1],

  ["ENQUIRY", "SLA_BREACHED", "Response window missed", "Reportable to the manufacturer.", 3],
  ["ENQUIRY", "NO_OWNER", "Unassigned", "Assigned to an employee who has left the dealership.", 3],
  ["ENQUIRY", "UNCONTACTED", "Not yet contacted", "No contact with this customer has been recorded.", 2],
  ["ENQUIRY", "CLOCK_RUNNING", "Response window open", "Still inside the window, and it is running.", 2],
  ["ENQUIRY", "FOLLOW_UP_OVERDUE", "Follow-up overdue", "The date the salesman set has passed.", 2],

  ["REGISTRATION", "OBJECTION", "RTO objection", "The RTO has rejected the file.", 3],
  ["REGISTRATION", "BLOCKED_NO_INSURANCE", "Blocked on insurance", "Nothing on the file can move without a policy.", 3],
  ["REGISTRATION", "TAX_HELD", "Road tax collected, unpaid", "The dealership holds the customer's money.", 2],
  ["REGISTRATION", "AWAITING_DOCS", "Waiting on documents", "A document is missing before it can be lodged.", 2],
  ["REGISTRATION", "RC_IN_DRAWER", "Certificate uncollected", "Received at the dealership and the customer has not been informed.", 2],
  ["REGISTRATION", "RTO_SILENT", "No response from the RTO", "Lodged, with nothing returned.", 1],
  ["REGISTRATION", "HSRP_PENDING", "Plate not fitted", "Registered, and the plate is still to go on.", 1],

  ["PART", "STOCKOUT_BLOCKING", "Stockout blocking a job card", "A vehicle is held pending a part not in stock.", 3],
  ["PART", "AVAILABLE_ELSEWHERE", "Available at another outlet", "Another outlet holds this part in stock.", 2],
  ["PART", "ORDER_OVERDUE", "Order overdue", "It was ordered and has not arrived.", 2],
  ["PART", "BELOW_REORDER", "Below reorder level", "Stock is low and nothing is on order.", 1],
  ["PART", "FULLY_RESERVED", "Fully reserved", "In stock, with every unit already committed.", 1],
  ["PART", "DEAD_STOCK", "Non-moving stock", "Capital held in parts with no recent issue.", 1],

  ["RECEIVABLE", "PROMISE_BROKEN", "Payment date passed", "They gave a date and it went by.", 3],
  ["RECEIVABLE", "UNCHASED", "Overdue, not yet pursued", "Past due with no recorded follow-up.", 2],
  ["RECEIVABLE", "DISPUTED", "Disputed", "They are contesting it.", 2],
  ["RECEIVABLE", "BEING_CHASED", "Follow-up in progress", "A recent follow-up is on record.", 1],
  ["RECEIVABLE", "DUE_SOON", "Falling due", "Not late yet.", 1],

  ["VEHICLE", "WANTED_NOW", "Matched to an open enquiry", "Standing stock against live demand for the same model.", 3],
  ["VEHICLE", "STUCK_ALLOCATION", "Allocated, not invoiced", "Reserved against a deal that has not closed.", 2],
  ["VEHICLE", "AGEING_SEVERE", "Aged — carrying cost material", "On the floor long enough that the interest is significant.", 2],
  ["VEHICLE", "AGEING", "Ageing", "On the floor longer than it should be.", 1],
  ["VEHICLE", "OFFERED", "Offered to a customer", "This unit has been shown to a named customer.", 1],
];

/**
 * When something counts as having gone wrong.
 *
 * These were `const X = 90` in seven different files, which is a defensible
 * place for a number nobody disagrees with and the wrong place for one every
 * dealership does. A group with a floor plan facility measured in lakhs cares
 * about day 45; one that owns its stock outright may not care until day 120.
 */
const THRESHOLD_KEYS: PolicyKey[] = [
  {
    key: "THRESHOLD.TR_WARNING_DAYS",
    group: "THRESHOLD",
    section: "Registration & RC",
    label: "Temporary registration warning",
    help: "Days left on a temporary registration before the file counts as urgent.",
    default: 7,
    min: 1,
    max: 30,
    unit: "days",
  },
  {
    key: "THRESHOLD.RTO_QUIET_DAYS",
    group: "THRESHOLD",
    section: "Registration & RC",
    label: "RTO has gone quiet after",
    help: "Working days a lodged file may sit at the RTO before it is worth asking about.",
    default: 10,
    min: 3,
    max: 60,
    unit: "days",
  },
  {
    key: "THRESHOLD.REGISTRATION_CHASE_FRESH_DAYS",
    group: "THRESHOLD",
    section: "Registration & RC",
    label: "A chase stays fresh for",
    help: "How recently the RTO was chased before it counts as still being handled.",
    default: 7,
    min: 1,
    max: 30,
    unit: "days",
  },
  {
    key: "THRESHOLD.DEAD_STOCK_DAYS",
    group: "THRESHOLD",
    section: "Spares",
    label: "Dead stock after",
    help: "Days without an issue before a part counts as capital rather than inventory.",
    default: 120,
    min: 30,
    max: 720,
    unit: "days",
  },
  {
    key: "THRESHOLD.RECEIVABLE_CHASE_FRESH_DAYS",
    group: "THRESHOLD",
    section: "Receivables",
    label: "A chase stays fresh for",
    help: "How recently a party was chased before it counts as somebody still being on it.",
    default: 7,
    min: 1,
    max: 60,
    unit: "days",
  },
  {
    key: "THRESHOLD.DUE_SOON_DAYS",
    group: "THRESHOLD",
    section: "Receivables",
    label: "Falling due within",
    help: "How close to the due date is worth a heads-up rather than a chase.",
    default: 7,
    min: 1,
    max: 60,
    unit: "days",
  },
  {
    key: "THRESHOLD.AGEING_DAYS",
    group: "THRESHOLD",
    section: "Vehicle stock",
    label: "Ageing after",
    help: "Days on the floor before a unit is ageing rather than in stock.",
    default: 60,
    min: 15,
    max: 365,
    unit: "days",
  },
  {
    key: "THRESHOLD.AGEING_SEVERE_DAYS",
    group: "THRESHOLD",
    section: "Vehicle stock",
    label: "Badly aged after",
    help: "Days before it is the sort of ageing an owner needs told about.",
    default: 90,
    min: 20,
    max: 730,
    unit: "days",
  },
  {
    key: "THRESHOLD.STUCK_ALLOCATION_DAYS",
    group: "THRESHOLD",
    section: "Vehicle stock",
    label: "Allocation is stuck after",
    help: "Days an allocation may sit uninvoiced before the unit is stuck rather than sold.",
    default: 30,
    min: 5,
    max: 180,
    unit: "days",
  },
];

const SECTION_OF: Record<string, string> = {
  DEAL: "Deals & insurance",
  JOB_CARD: "Service",
  ENQUIRY: "Enquiries",
  REGISTRATION: "Registration & RC",
  PART: "Spares",
  RECEIVABLE: "Receivables",
  VEHICLE: "Vehicle stock",
};

/** Every key that may exist. Anything else is rejected. */
export const POLICY_KEYS: PolicyKey[] = [
  ...SEVERITY_KEYS.map(([module, state, label, help, def]) => ({
    key: `SEVERITY.${module}.${state}`,
    group: "SEVERITY" as const,
    section: SECTION_OF[module] ?? module,
    label,
    help,
    default: def,
    min: 1,
    max: 3,
    unit: "rank" as const,
  })),
  ...THRESHOLD_KEYS,
  ...SWITCH_KEYS,
  ...AUTONOMY_KEYS_REGISTRY,
];

const BY_KEY = new Map(POLICY_KEYS.map((k) => [k.key, k]));

/** The numbers in force for one owner: every key, defaulted where unset. */
export interface ResolvedPolicy {
  /** `SEVERITY.MODULE.STATE` → 1..3 */
  severity(module: string, state: string): number | undefined;
  /** A named threshold, always a number because every key has a default. */
  number(key: string): number;
  /**
   * The same lookup, kept because most callers are asking about days.
   *
   * The registry was thresholds measured in days when it was written and every
   * call site says `days`. OBJ-26 added counts and a percentage, and
   * `policy.days("AUTONOMY.CONSENT_AFTER")` would read as a claim about time
   * that the value is not. Renaming every existing caller would have churned a
   * hundred lines to no benefit; an alias costs one.
   */
  days(key: string): number;
  /**
   * A switch, as a boolean.
   *
   * Stored as 0 or 1 so `dealer_policy` stays a table of numbers, and read as
   * a boolean so no caller has to remember which way round it was.
   */
  on(key: string): boolean;
  /** Only what this owner actually set, for the screen. */
  overrides: Map<string, number>;
}

function resolve(overrides: Map<string, number>): ResolvedPolicy {
  return {
    severity(module, state) {
      const key = `SEVERITY.${module}.${state}`;
      const meta = BY_KEY.get(key);
      // Undefined rather than a default: a state absent from the registry
      // produces no queue item at all, and inventing a priority for it would
      // quietly put work on somebody's screen that nothing decided belongs
      // there.
      if (!meta) return undefined;
      return overrides.get(key) ?? meta.default;
    },
    number(key) {
      const meta = BY_KEY.get(key);
      if (!meta) {
        throw new Error(`Unknown policy key ${key}. The registry is in lib/dms/policy.ts.`);
      }
      return overrides.get(key) ?? meta.default;
    },
    days(key) {
      const meta = BY_KEY.get(key);
      if (!meta) {
        // A typo in a key is a bug, not a runtime condition to absorb. The
        // alternative is a classifier silently using zero days and marking
        // every record urgent.
        throw new Error(`Unknown policy key ${key}. The registry is in lib/dms/policy.ts.`);
      }
      return overrides.get(key) ?? meta.default;
    },
    on(key) {
      const meta = BY_KEY.get(key);
      // Same reasoning as `days`: an unknown key is a bug. Returning false
      // would be worse than throwing here, because a switch that silently
      // reads off is indistinguishable from a dealership that turned it off.
      if (!meta) {
        throw new Error(`Unknown policy key ${key}. The registry is in lib/dms/policy.ts.`);
      }
      return (overrides.get(key) ?? meta.default) === 1;
    },
    overrides,
  };
}

/** The product's numbers, for a caller with no owner to hand. */
export const DEFAULT_POLICY: ResolvedPolicy = resolve(new Map());

/**
 * The numbers in force at one outlet.
 *
 * The seven builders take a showroom and not an owner, so this closes the gap
 * rather than making every one of them ask its caller for something the caller
 * would then have to remember to pass. **Deliberately not defaulted**: a
 * builder that quietly used the product's numbers because nobody handed it a
 * policy would be a dealership's settings silently not applying on one screen,
 * which is the kind of bug nothing on screen would report.
 *
 * A caller doing a full pass — the queue, the detector, the rules — loads once
 * and passes it down, because seven builders each resolving the same owner is
 * seven queries for one answer.
 */
export async function policyForShowroom(showroomId: number): Promise<ResolvedPolicy> {
  const [row] = await db
    .select({ ownerId: showroomsTable.ownerId })
    .from(showroomsTable)
    .where(eq(showroomsTable.id, showroomId));
  // No showroom is not a reason to invent numbers; it is a reason for the
  // caller's own query to return nothing, which it will.
  return row ? loadPolicy(row.ownerId) : DEFAULT_POLICY;
}

export async function loadPolicy(ownerId: number): Promise<ResolvedPolicy> {
  const rows = await db
    .select({ key: dealerPolicyTable.key, value: dealerPolicyTable.value })
    .from(dealerPolicyTable)
    .where(eq(dealerPolicyTable.ownerId, ownerId));

  // Unknown keys are dropped rather than trusted. A key that was retired from
  // the registry must stop taking effect the moment it is retired, and a row
  // left behind by an older version of this file is exactly that case.
  const overrides = new Map<string, number>();
  for (const r of rows) if (BY_KEY.has(r.key)) overrides.set(r.key, r.value);
  return resolve(overrides);
}

export type SetResult =
  | { ok: true; key: string; value: number; previous: number; isDefault: boolean }
  | { ok: false; error: string };

/**
 * Set one number, or clear it back to the product's default.
 *
 * `value === null` deletes the row rather than writing the current default,
 * so a dealership that resets follows the product's default *afterwards* too.
 * Writing the default down would freeze them on whatever it happened to be.
 */
export async function setPolicy(
  ownerId: number,
  showroomId: number,
  userId: number,
  key: string,
  value: number | null,
): Promise<SetResult> {
  const meta = BY_KEY.get(key);
  if (!meta) {
    return {
      ok: false,
      error:
        `There is no setting called ${key}. The numbers a dealership may set are a ` +
        `closed list — it is what keeps this a table of numbers rather than a place ` +
        `to build behaviour nobody can predict.`,
    };
  }
  if (value !== null && (!Number.isInteger(value) || value < meta.min || value > meta.max)) {
    return {
      ok: false,
      error: `${meta.label} must be a whole number between ${meta.min} and ${meta.max}.`,
    };
  }

  const [existing] = await db
    .select({ value: dealerPolicyTable.value })
    .from(dealerPolicyTable)
    .where(and(eq(dealerPolicyTable.ownerId, ownerId), eq(dealerPolicyTable.key, key)));

  const previous = existing?.value ?? meta.default;

  if (value === null) {
    await db
      .delete(dealerPolicyTable)
      .where(and(eq(dealerPolicyTable.ownerId, ownerId), eq(dealerPolicyTable.key, key)));
  } else {
    await db
      .insert(dealerPolicyTable)
      .values({ ownerId, key, value, updatedByUserId: userId })
      .onConflictDoUpdate({
        target: [dealerPolicyTable.ownerId, dealerPolicyTable.key],
        set: { value, updatedByUserId: userId },
      });
  }

  // In the decision log with everything else, and with the old value against
  // it. "Why did the queue start putting dead stock first" is a question
  // somebody will ask three months from now, and it deserves an answer that
  // names a person and a date.
  await db.insert(decisionLogTable).values({
    ownerId,
    showroomId,
    userId,
    // The module a policy change belongs to is the whole dealership, and DEAL
    // is the closest the existing enum has to that. Worth noting rather than
    // widening an enum every mirror table shares for one caller.
    module: "DEAL",
    recordKey: key,
    action: value === null ? "POLICY_RESET" : "POLICY_SET",
    previousValue: { value: previous },
    newValue: { value: value ?? meta.default, isDefault: value === null },
    note: `${meta.label}: ${previous} → ${value ?? meta.default}` +
      (value === null ? " (back to the product's default)" : ""),
  });

  return {
    ok: true,
    key,
    value: value ?? meta.default,
    previous,
    isDefault: value === null,
  };
}

/** Everything the screen needs: the registry, and what this owner has changed. */
export async function describePolicy(ownerId: number): Promise<
  Array<PolicyKey & { value: number; isDefault: boolean }>
> {
  const policy = await loadPolicy(ownerId);
  return POLICY_KEYS.map((k) => ({
    ...k,
    value: policy.overrides.get(k.key) ?? k.default,
    isDefault: !policy.overrides.has(k.key),
  }));
}

/** For the reset-everything control. Returns how many rows it cleared. */
export async function resetAllPolicy(
  ownerId: number,
  showroomId: number,
  userId: number,
): Promise<number> {
  const rows = await db
    .select({ key: dealerPolicyTable.key })
    .from(dealerPolicyTable)
    .where(eq(dealerPolicyTable.ownerId, ownerId));
  if (rows.length === 0) return 0;

  for (const r of rows) await setPolicy(ownerId, showroomId, userId, r.key, null);
  return rows.length;
}

export { BY_KEY as POLICY_BY_KEY };
export function isPolicyKey(key: string): boolean {
  return BY_KEY.has(key);
}
/** Keys currently set by anybody, for the probe and for tests. */
export async function overriddenKeys(ownerIds: number[]): Promise<string[]> {
  if (ownerIds.length === 0) return [];
  const rows = await db
    .select({ key: dealerPolicyTable.key })
    .from(dealerPolicyTable)
    .where(inArray(dealerPolicyTable.ownerId, ownerIds));
  return rows.map((r) => r.key);
}
