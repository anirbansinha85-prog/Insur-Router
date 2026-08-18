/**
 * One table. Every question about who may do what is asked here.
 *
 * DDMS grew two permission systems that did not know about each other, and a
 * third scattered inline:
 *
 * - `access.ts` gated **reading**, by module, by role.
 * - `agent.ts` gated **writing**, by naming two of the twelve registry actions
 *   and listing the other ten with a reason each.
 * - and `role === "OWNER" || role === "MANAGER"` appeared in two route handlers
 *   and one screen, meaning three different things depending where you read it.
 *
 * Every objective ahead adds actions, principals, or both. Adding them to two
 * tables guarantees the two drift, and the first drift is a hole. This file is
 * that unification (OBJ-21).
 *
 * ## Verb-scoped, not tiered
 *
 * `namespace.verb` — `enquiry.reassign`, `policy.set`, `receivable.view`. The
 * shape is borrowed from wrrk.ai, whose authorisation layer carries 120 scoped
 * permissions across 31 namespaces rather than a handful of tiers **[Observed,
 * scrapi corpus §5.2]**. Tiers force every new capability to pick an existing
 * bucket; verbs let it be exactly as narrow as it is.
 *
 * Half of it DDMS had already arrived at independently: the queue's three bands
 * — *mine · nobody's · my outlet's* — are the `view` / `view_all` ownership
 * distinction that runs through wrrk's table.
 *
 * ## The agent is a principal, not a special case
 *
 * That is the point of the objective. `AGENT_ACTIONS` was a constant and
 * `CLOSED_TO_THE_AGENT` was a second constant beside it; now the agent holds
 * two grants like anybody else, and the ten refusals are **withheld reasons in
 * this table**. The reasons had to survive the move — they are the valuable
 * artefact, not the list — so a withheld permission can carry a sentence for
 * any principal, which is also what `refusalFor` did for people. Two mechanisms
 * became one.
 *
 * ## The asymmetry that has always held here
 *
 * This narrows and never widens. Every predicate it produces is ANDed onto the
 * owner scope, never ORed with it, so the worst a bug here can do is hide a row
 * from somebody entitled to it. A role bug revealing another dealership's
 * customers is not reachable from this file, and row-level security is
 * underneath either way.
 *
 * ## What this objective deliberately does not do
 *
 * **It does not change who may do what.** Grants below are exactly today's
 * behaviour, written down in one place for the first time. Separating *reading
 * a module* from *acting on it* is a product decision that has been deferred;
 * the seam now exists for it to land in when it is made.
 */

// ── Principals ──────────────────────────────────────────────────────────────

export type DealershipRole =
  | "OWNER"
  | "MANAGER"
  | "SALES_EXEC"
  | "SERVICE_ADVISOR"
  | "RTO_AGENT"
  | "ACCOUNTS"
  | "TECHNICIAN"
  /**
   * Not a dealership role at all — whoever runs the platform.
   *
   * Added in OBJ-8 for one narrow job: insurers and OCR engines are the same
   * rows for every dealership, so no owner's session may write them. It reads
   * no dealership module — see the empty grant below, and
   * `app.is_platform_admin()` in rls.sql.
   */
  | "PLATFORM_ADMIN";

/**
 * Everything that can hold a permission.
 *
 * `AGENT` sits alongside the roles rather than beside the table, which is the
 * whole of OBJ-21. When a second agent arrives (OBJ-29) it is another entry
 * here and a set of grants, and nothing else changes.
 */
export type Principal =
  | DealershipRole
  | "AGENT"
  /**
   * The second agent (OBJ-29), and the whole point is how little it cost.
   *
   * R-95 claimed **a second agent is a principal and a set of grants and
   * nothing else changes.** This line and `STOCK_AGENT_GRANTS` are the entire
   * diff to the permission model; every refusal below came with it rather than
   * being re-earned.
   */
  | "STOCK_AGENT";

// ── The vocabulary ──────────────────────────────────────────────────────────

/** The modules a screen, a route or a row policy can be gated on. */
export type AccessModule =
  | "DEAL"
  | "JOB_CARD"
  | "ENQUIRY"
  | "REGISTRATION"
  | "PART"
  | "RECEIVABLE"
  | "VEHICLE"
  | "OUTBOX";

const ALL_MODULES: AccessModule[] = [
  "DEAL",
  "JOB_CARD",
  "ENQUIRY",
  "REGISTRATION",
  "PART",
  "RECEIVABLE",
  "VEHICLE",
  "OUTBOX",
];

/** `namespace.verb`. Kept as a plain string union so it is greppable. */
export type Permission =
  // Reading a module. One per module, and the sidebar is built from these.
  | "deal.view"
  | "job_card.view"
  | "enquiry.view"
  | "registration.view"
  | "part.view"
  | "receivable.view"
  | "vehicle.view"
  | "outbox.view"
  // The twelve registry actions, one verb each. `actions.ts` is the closed set;
  // this is who may call each member of it.
  | "enquiry.log_contact"
  | "enquiry.reassign"
  | "job_card.mark_informed"
  | "job_card.reassign"
  | "registration.assign_agent"
  | "registration.mark_notified"
  | "registration.log_chase"
  | "part.request_transfer"
  | "part.raise_reorder"
  | "receivable.log_chase"
  | "receivable.mark_disputed"
  | "vehicle.mark_offered"
  | "vehicle.propose_transfer"
  // The outbox, whose verbs are not reads and were previously covered by the
  // single `OUTBOX` module grant.
  | "outbox.approve"
  | "outbox.edit"
  | "outbox.cancel"
  | "outbox.send"
  /**
   * Setting the dealership's own numbers.
   *
   * **Separated from `outlet.view_all` on purpose, though the same two roles
   * hold both today.** The old code asked `seesEveryOutlet(role)` before
   * allowing a policy write, which conflates *can you see across branches* with
   * *may you decide what the whole dealership does first*. They have the same
   * answer now and there is no reason they must later.
   */
  | "policy.set"
  /** Who may be offered in a reassignment picker — reads the staff master. */
  | "staff.view"
  /**
   * The document DDMS issues, and what it may be priced from (OBJ-25).
   *
   * **`invoice.generate` is the first grant in this table that puts a number on
   * a piece of paper a customer keeps.** Everything before it either marked a
   * field, wrote a note, or drafted a message somebody still had to approve.
   * This one, on a dealership whose tax series DDMS holds, spends a number from
   * a sequential GST series — which cannot be un-spent, only cancelled.
   *
   * That is why it is narrower than `deal.view`: an accounts clerk reads deals
   * all day and issuing against one is a different act. And it is why the agent
   * does not hold it at all — see `WITHHELD`.
   */
  | "invoice.view"
  | "invoice.generate"
  /** Adding a price list, and therefore deciding what a model costs. */
  | "pricelist.set"
  /**
   * The records DDMS owns outright (OBJ-22).
   *
   * `activity.write` is the first grant in this table that lets its holder
   * state something as fact rather than mark a field. The agent holds it, and
   * what it may say is narrowed again inside `records.ts` — the table decides
   * *whether* it may write, the closed set of kinds decides *what about*.
   *
   * `activity.retract` is separate from `write` deliberately. Withdrawing
   * somebody else's note is a different act from adding your own, and the day a
   * dealership wants only a manager to do it, the line already exists.
   */
  | "activity.view"
  | "activity.write"
  | "activity.retract"
  | "task.view"
  | "task.create"
  | "task.complete"
  /**
   * Sees every outlet the owner holds, rather than the one they work at.
   *
   * One permission rather than a `view_all` per module, because the question is
   * asked once per session and answered the same way for all eight.
   */
  | "outlet.view_all";

/** Every action in the registry, and the permission that admits it. */
export const PERMISSION_FOR_ACTION = {
  ENQUIRY_LOG_CONTACT: "enquiry.log_contact",
  ENQUIRY_REASSIGN: "enquiry.reassign",
  JOB_CARD_MARK_INFORMED: "job_card.mark_informed",
  JOB_CARD_REASSIGN: "job_card.reassign",
  REGISTRATION_ASSIGN_AGENT: "registration.assign_agent",
  REGISTRATION_MARK_NOTIFIED: "registration.mark_notified",
  REGISTRATION_LOG_CHASE: "registration.log_chase",
  PART_REQUEST_TRANSFER: "part.request_transfer",
  PART_RAISE_REORDER: "part.raise_reorder",
  RECEIVABLE_LOG_CHASE: "receivable.log_chase",
  RECEIVABLE_MARK_DISPUTED: "receivable.mark_disputed",
  VEHICLE_MARK_OFFERED: "vehicle.mark_offered",
  VEHICLE_PROPOSE_TRANSFER: "vehicle.propose_transfer",
} as const satisfies Record<string, Permission>;

export type RegistryActionId = keyof typeof PERMISSION_FOR_ACTION;

/** Which module a permission belongs to, where it belongs to one. */
const MODULE_OF: Partial<Record<Permission, AccessModule>> = {
  "deal.view": "DEAL",
  "job_card.view": "JOB_CARD",
  "enquiry.view": "ENQUIRY",
  "registration.view": "REGISTRATION",
  "part.view": "PART",
  "receivable.view": "RECEIVABLE",
  "vehicle.view": "VEHICLE",
  "outbox.view": "OUTBOX",
};

const VIEW_OF: Record<AccessModule, Permission> = {
  DEAL: "deal.view",
  JOB_CARD: "job_card.view",
  ENQUIRY: "enquiry.view",
  REGISTRATION: "registration.view",
  PART: "part.view",
  RECEIVABLE: "receivable.view",
  VEHICLE: "vehicle.view",
  OUTBOX: "outbox.view",
};

/**
 * The verbs that come with reading a module, for a person.
 *
 * **This encodes today's behaviour rather than an opinion.** Until now the
 * actions route checked nothing at all and the database refused what it should
 * refuse, so in practice anybody who could read a module could act on it.
 * Writing that down is the honest first step; narrowing it is a separate
 * decision with a dealership on the other end of it.
 */
const VERBS_WITH_MODULE: Record<AccessModule, Permission[]> = {
  DEAL: [],
  JOB_CARD: ["job_card.mark_informed", "job_card.reassign", "staff.view"],
  ENQUIRY: ["enquiry.log_contact", "enquiry.reassign", "staff.view"],
  REGISTRATION: [
    "registration.assign_agent",
    "registration.mark_notified",
    "registration.log_chase",
    "staff.view",
  ],
  PART: ["part.request_transfer", "part.raise_reorder"],
  RECEIVABLE: ["receivable.log_chase", "receivable.mark_disputed"],
  VEHICLE: ["vehicle.mark_offered", "vehicle.propose_transfer"],
  OUTBOX: ["outbox.approve", "outbox.edit", "outbox.cancel", "outbox.send"],
};

// ── The grants ──────────────────────────────────────────────────────────────

/**
 * Role to modules.
 *
 * Drawn from what each job actually touches in a small dealership rather than
 * from a tidy hierarchy — a service advisor needs the parts counter because
 * their job cards wait on it, and accounts needs deals because an invoice hangs
 * off one. Guessing tidily here produces a product that is quietly useless to
 * four of the seven people who use it.
 *
 * `TECHNICIAN` is the narrowest and may in practice never be issued a login;
 * that is the dealership's call at runtime, not a decision this file makes.
 */
const MODULES_BY_ROLE: Record<DealershipRole, AccessModule[]> = {
  OWNER: ALL_MODULES,
  MANAGER: ALL_MODULES,
  SALES_EXEC: ["DEAL", "ENQUIRY", "VEHICLE", "OUTBOX"],
  SERVICE_ADVISOR: ["JOB_CARD", "PART", "OUTBOX"],
  RTO_AGENT: ["REGISTRATION", "OUTBOX"],
  ACCOUNTS: ["RECEIVABLE", "DEAL", "OUTBOX"],
  TECHNICIAN: ["JOB_CARD"],
  // Deliberately empty, and it is the point rather than an omission: the
  // account that may edit reference data can read nobody's customers.
  PLATFORM_ADMIN: [],
};

/**
 * What every role that reads anything also holds.
 *
 * Activities and tasks are not gated per module in this table — the *row*
 * policy does that, using the same `app.can_read(module)` as the record the
 * activity points at. So a service advisor may write an activity, and the only
 * ones they can write are about job cards and parts, because the database will
 * refuse the rest. Two layers, each doing the job it is good at.
 *
 * `PLATFORM_ADMIN` is excluded along with everything else: it reads no
 * dealership module, so there is nothing for it to write a note about.
 */
/**
 * Issuing and reading the document (OBJ-25).
 *
 * Not given to everybody who reads deals. A technician has no reason to see
 * what a customer paid, and a service advisor reading a chassis number on a job
 * card is not the same as reading the discount composition on the sale.
 */
const INVOICE_VERBS: Permission[] = ["invoice.view", "invoice.generate"];

const RECORD_VERBS: Permission[] = [
  "activity.view",
  "activity.write",
  "activity.retract",
  "task.view",
  "task.create",
  "task.complete",
];

/** Permissions a role holds that are not implied by a module. */
const EXTRA_BY_ROLE: Partial<Record<DealershipRole, Permission[]>> = {
  OWNER: ["policy.set", "outlet.view_all", "pricelist.set", ...INVOICE_VERBS, ...RECORD_VERBS],
  MANAGER: ["policy.set", "outlet.view_all", "pricelist.set", ...INVOICE_VERBS, ...RECORD_VERBS],
  /**
   * Sales quote and accounts invoice, and both read what has been issued.
   *
   * A salesman needs to hand a customer a figure on paper and must not be able
   * to spend a tax invoice number to do it — which is precisely the distinction
   * `intent` draws in the generator, and it is enforced in the route rather
   * than here because it is about *what kind of document*, not *whether*.
   */
  SALES_EXEC: [...INVOICE_VERBS, ...RECORD_VERBS],
  SERVICE_ADVISOR: RECORD_VERBS,
  RTO_AGENT: RECORD_VERBS,
  ACCOUNTS: [...INVOICE_VERBS, ...RECORD_VERBS],
  TECHNICIAN: RECORD_VERBS,
};

/**
 * What the agent may call, and it is the whole of it.
 *
 * Two of twelve, and that ratio is OBJ-17's finding rather than timidity: eight
 * of the other ten assert *a person did something* — rang the customer, chased
 * the RTO, showed the bike — against a record DDMS does not own. A model cannot
 * make a phone call, so writing those fields would assert work that never
 * happened. The two that survive record a routing decision DDMS itself is
 * making, and DDMS is entitled to make it.
 *
 * `staff.view` comes with them because choosing an assignee means reading who
 * still works here — `listStaff` is how the agent knows Imtiaz left.
 */
const AGENT_GRANTS: Permission[] = [
  "enquiry.reassign",
  "registration.assign_agent",
  "staff.view",
  /**
   * OBJ-22, and the whole reason that objective sits where it does.
   *
   * This is the first grant that lets the agent **say** something rather than
   * mark a field. It is safe for exactly one reason: an activity the agent
   * wrote asserts that the agent wrote it, and that is true. The eight registry
   * actions still closed to it are closed because they assert a *person* rang
   * somebody, and no amount of this changes that.
   *
   * `records.ts` narrows it further — an agent may write `OBSERVED` and
   * `SYSTEM` and nothing else, so it cannot log a call it did not make.
   */
  "activity.view",
  "activity.write",
  /**
   * A task is the only thing an agent may put on a person's list.
   *
   * It asks; it does not assert. And it may not close one — `task.complete` is
   * absent, because whether the work was actually done is a fact only the
   * person who did it holds.
   */
  "task.view",
  "task.create",
];

/**
 * The second agent, and the whole point of it is how little it cost (OBJ-29).
 *
 * R-95's claim was that **a second agent is a principal and a set of grants and
 * nothing else changes.** This is that claim being cashed, and the list below is
 * the entire diff to the permission model.
 *
 * It holds the two permissions withheld from `AGENT` with the reason *"not the
 * band this agent is pointed at"* — moving the company's own stock between the
 * company's own outlets. Both are **DDMS's own routing decision** and not a
 * claim about a person: a transfer request is this product saying *the part
 * your customer is waiting for is on a shelf in Rohini*, which is the finding
 * the spares module exists for and which no branch system can produce.
 *
 * A second agent rather than a wider first one, deliberately. Widening `AGENT`
 * would have meant the thing that hands out enquiries could also commit a part
 * to a van, and the ladder would then judge both on one dealership's
 * willingness to accept either — so a showroom that loves the reassignments and
 * distrusts the transfers could not say so.
 *
 * `staff.view` is absent. This agent routes stock, not people, and does not
 * need to know who still works here.
 */
const STOCK_AGENT_GRANTS: Permission[] = [
  "part.view",
  "part.request_transfer",
  "vehicle.view",
  "vehicle.propose_transfer",
  "activity.view",
  "activity.write",
  "task.view",
  "task.create",
];

/**
 * Why a principal does not hold a permission, in the dealership's words.
 *
 * Keyed by principal, then permission. The ten agent entries came verbatim from
 * `CLOSED_TO_THE_AGENT` and are the reason this table has a reasons half at
 * all: anybody proposing to move one of these into a grant has to argue with
 * the sentence beside it, and most of them do not lose force with time — a
 * model will never be able to make a phone call.
 *
 * A principal with no entry here still gets a refusal; it is just assembled
 * from what they *can* do rather than written by hand. See `whyNot`.
 */
/**
 * Why a permission that belongs to no module is refused.
 *
 * One sentence each, because the generic assembly below works off *which
 * modules you read* and these are not about modules at all. A refusal that
 * names the wrong reason is worse than a terse one: it sends somebody to ask
 * for the wrong thing.
 */
const MODULELESS_REFUSAL: Partial<Record<Permission, string>> = {
  "policy.set":
    "Only an owner or a showroom manager sets these. They decide what the whole dealership does first, and your role covers one part of it.",
  "outlet.view_all":
    "Only an owner or a showroom manager looks across branches. Yours is the outlet you work at.",
  "invoice.view":
    "What a customer paid, and how the discount was composed, is not part of your job here. Owners, managers, sales and accounts see it.",
  "invoice.generate":
    "Issuing a priced document is an owner's, a manager's or accounts' — and on some dealerships it spends a number from a tax series that cannot be un-spent.",
  "pricelist.set":
    "Deciding what a model costs belongs to whoever runs the business. Ask the owner or your showroom manager to add it.",
  "staff.view":
    "Reading the staff master is for whoever hands work out.",
};

/**
 * The refusals that belong to **any** agent, not to a particular one (OBJ-29).
 *
 * Lifted out of `WITHHELD.AGENT` when the second agent arrived, and lifted
 * rather than copied because the copy is the failure. Two agents refused the
 * same act for the same reason must get the *same words*: the moment somebody
 * writes a second set, the two drift, and a year later the product gives two
 * different explanations for one rule.
 *
 * `verify:agents` §3 compares the sentences the two agents get and fails on any
 * difference it has not been told to expect — which is what caught this being a
 * near-identical rewrite the first time it was written.
 *
 * Every line here is about **what the act asserts**, which is why it does not
 * depend on which agent is asking. *A model cannot make a phone call* does not
 * become less true for a different model.
 */
const ANY_AGENT_REFUSAL: Partial<Record<Permission, string>> = {
  "enquiry.log_contact": "Asserts somebody rang the customer. The agent cannot ring anybody, and the mark removes the row from the calls-to-make count.",
  "job_card.mark_informed": "Asserts the customer was told their vehicle is ready. Same objection, and the customer is the one who finds out it was false.",
  "registration.mark_notified": "Asserts the customer was told their certificate has arrived. A file marked notified stops being chased.",
  "registration.log_chase": "Asserts somebody rang the RTO. A chase that never happened makes a stalled file look handled for another week.",
  "receivable.log_chase": "Asserts somebody asked a party for money. The dealership's cash position is not a place to record work that did not occur.",
  "receivable.mark_disputed": "A judgement about whether a customer's account is in breach. R-49 reserves exactly that from a model, whatever it is confident of.",
  "vehicle.mark_offered": "Asserts a salesman showed the unit to a named customer. It is also the field whose absence means nobody has asked for this bike.",
  "part.raise_reorder": "Asserts a purchase order was raised in the dealer's own system, which DDMS never writes to (R-5, R-40).",
  "policy.set": "The dealership's own numbers are the dealership's. An agent that could widen its own thresholds is an agent with no ceiling.",
  "activity.retract": "Withdrawing a note is a judgement about whether something was true, and the note is usually somebody else's. The agent may add to a timeline and may not edit one.",
  "task.complete": "Closing a task asserts the work was done, which is the one thing only the person who did it knows. The agent may raise a task and may not tick it off.",
  "invoice.generate": "Puts a priced document in a customer's hands, and on some dealerships spends a number from a sequential tax series that cannot be un-spent. What it costs and what discount was given are commercial decisions belonging to whoever runs the business. The agent may notice a deal is ready and say so; the figure and the button are a person's.",
  "pricelist.set": "Deciding what a model costs is the same decision as the discount, made once for every sale instead of one. An agent that could write a price list would be setting the prices it then invoices at.",
};

const WITHHELD: Partial<Record<Principal, Partial<Record<Permission, string>>>> = {
  /**
   * The second agent's refusals (OBJ-29).
   *
   * Thirteen of the fifteen are `ANY_AGENT_REFUSAL`, spread in unchanged. The
   * two written here are the interesting ones: `enquiry.reassign` and
   * `registration.assign_agent` are refused **not** because they assert
   * anything false, but because they belong to the other agent. Two agents that
   * can do each other's work are one agent with a confusing name — and the
   * ladder would then judge both on one dealership's willingness to accept
   * either, so a showroom that trusts one and distrusts the other could not say
   * so.
   */
  STOCK_AGENT: {
    ...ANY_AGENT_REFUSAL,
    "enquiry.reassign":
      "Handing work to a person is the other agent's job. Two agents that can do each other's work are one agent with a confusing name, and the ladder would then judge both on one dealership's willingness to accept either.",
    "registration.assign_agent": "Same. This agent moves stock; it does not route people.",
    "job_card.reassign": "Same. This agent moves stock; it does not route people.",
  },
  AGENT: {
    ...ANY_AGENT_REFUSAL,
    /*
     * Withheld from both agents, and deliberately **not** for the reason the
     * other eight are (OBJ-49).
     *
     * Handing a job card over asserts nothing false - it is a routing decision
     * DDMS is entitled to make, exactly like reassigning a lead, and the
     * grant would have been the smaller diff. It is held back because a lead
     * and a card in the workshop are not the same object: a card in progress
     * carries context in a person's head, and a customer who rings about a bike
     * that has been quietly moved to somebody who has never seen it gets a
     * worse answer than one who waits. A person doing it knows that; an
     * unattended pass does not.
     *
     * Revisable, and the ladder is how: watch a dealership do it by hand, and
     * grant it when the habit is a count rather than a guess.
     */
    "job_card.reassign":
      "Hands a job card in progress to somebody else. Honest as a routing decision, and held back because a card in the workshop carries context in a person's head that a reassignment cannot move with it.",
    "part.request_transfer":
      "Commits stock to move between outlets. A proposal rather than a claim, but the consequence is physical and it is not the band this agent is pointed at.",
    "vehicle.propose_transfer":
      "Same. Honest as a proposal, and held back until the two assignments have run for a while in a real dealership.",
  },
};

// ── Resolution ──────────────────────────────────────────────────────────────

function grantsFor(principal: Principal): Set<Permission> {
  if (principal === "AGENT") return new Set(AGENT_GRANTS);
  if (principal === "STOCK_AGENT") return new Set(STOCK_AGENT_GRANTS);

  const role = principal as DealershipRole;
  const modules = MODULES_BY_ROLE[role] ?? [];
  const out = new Set<Permission>();
  for (const m of modules) {
    out.add(VIEW_OF[m]);
    for (const v of VERBS_WITH_MODULE[m]) out.add(v);
  }
  for (const p of EXTRA_BY_ROLE[role] ?? []) out.add(p);
  return out;
}

/**
 * Resolved once per principal rather than on every call.
 *
 * The table is static — R-52's argument, unchanged: automation and access live
 * in code and are reviewed like any other change, because DDMS's customer has
 * no administrator to untangle a permission model somebody edited at runtime.
 */
const RESOLVED = new Map<Principal, Set<Permission>>();

function resolve(principal: Principal): Set<Permission> {
  let s = RESOLVED.get(principal);
  if (!s) {
    s = grantsFor(principal);
    RESOLVED.set(principal, s);
  }
  return s;
}

/** The one question. Everything else in this file is phrasing or convenience. */
export function may(principal: string, permission: Permission): boolean {
  return resolve(principal as Principal).has(permission);
}

export function permissionsFor(principal: string): Permission[] {
  return [...resolve(principal as Principal)].sort();
}

// ── Phrasing a refusal ──────────────────────────────────────────────────────

/**
 * Why not, in a sentence somebody can act on.
 *
 * Two sources, in order. A hand-written reason wins, because it says something
 * the table cannot infer — *a model cannot make a phone call* is a fact about
 * the world, not about the grant. Otherwise the sentence is assembled from what
 * this principal *can* do, which is the more useful thing for a person: the
 * commonest cause of one of these is somebody being given the wrong role on
 * their first day, and a message naming their role is one their manager can fix.
 */
export function whyNot(principal: string, permission: Permission): string {
  const written = WITHHELD[principal as Principal]?.[permission];
  if (written) return written;

  if (principal === "AGENT") {
    return `The agent does not hold ${permission}. Its whole set is ${AGENT_GRANTS.join(", ")}.`;
  }
  if (principal === "STOCK_AGENT") {
    return `The stock agent does not hold ${permission}. Its whole set is ${STOCK_AGENT_GRANTS.join(", ")}.`;
  }

  const role = principal as DealershipRole;
  const has = MODULES_BY_ROLE[role] ?? [];
  if (has.length === 0) {
    return "Your account has no role that can read anything. Ask the owner to set one.";
  }

  const job = ROLE_NOUN[role] ?? role.replace(/_/g, " ").toLowerCase();
  const module = MODULE_OF[permission] ?? moduleOfVerb(permission);

  if (!module) {
    /*
     * A permission belonging to no module, and there are now four.
     *
     * This used to return the `policy.set` sentence unconditionally, with a
     * comment saying that was the only one. OBJ-25 added three more, and a
     * service advisor asking to read an invoice was told they may not set the
     * dealership's thresholds — true of them, and not the question they asked.
     *
     * It is the same defect OBJ-21 fixed on `POST /dms/actions`, arriving from
     * the other direction: **defence in depth working is not the same as the
     * application being honest**, and only one of those two was true. A
     * catch-all sentence is a lie waiting for the next permission.
     */
    return (
      MODULELESS_REFUSAL[permission] ??
      `${job} does not hold ${permission}. Ask the owner if you need it.`
    );
  }

  const mine = has
    .filter((m) => m !== "OUTBOX")
    .map((m) => MODULE_NOUN[m] ?? m.replace(/_/g, " ").toLowerCase());

  return (
    `${job} does not see ${MODULE_NOUN[module] ?? module.toLowerCase()}. ` +
    `Yours covers ${listOf(mine)}.`
  );
}

function moduleOfVerb(permission: Permission): AccessModule | null {
  for (const m of ALL_MODULES) {
    if (VERBS_WITH_MODULE[m].includes(permission)) return m;
  }
  return null;
}

/**
 * The words a dealership uses, rather than the identifiers a schema does.
 *
 * A refusal is read by somebody who has just been stopped from doing their job.
 * "A accounts does not see job card records" is the sort of sentence that makes
 * a person distrust the software instead of ringing their manager.
 */
const ROLE_NOUN: Partial<Record<DealershipRole, string>> = {
  OWNER: "An owner",
  MANAGER: "A manager",
  SALES_EXEC: "A sales executive",
  SERVICE_ADVISOR: "A service advisor",
  RTO_AGENT: "An RTO agent",
  ACCOUNTS: "Somebody in accounts",
  TECHNICIAN: "A technician",
};

const MODULE_NOUN: Partial<Record<AccessModule, string>> = {
  DEAL: "sales deals",
  JOB_CARD: "job cards",
  ENQUIRY: "enquiries",
  REGISTRATION: "registration files",
  PART: "the parts counter",
  RECEIVABLE: "the ledger",
  VEHICLE: "vehicle stock",
  OUTBOX: "the outbox",
};

function listOf(items: string[]): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ── The shapes the rest of the codebase already asks for ────────────────────
//
// Thin wrappers over `may`, kept because the callers read better for them and
// because `modulesFor` is what the session response and the sidebar are built
// from. They are the same table underneath, which is the point.

export function modulesFor(role: string): AccessModule[] {
  const set = resolve(role as Principal);
  return ALL_MODULES.filter((m) => set.has(VIEW_OF[m]));
}

export function canRead(role: string, module: AccessModule): boolean {
  return may(role, VIEW_OF[module]);
}

/**
 * Whether this role sees the whole group or one outlet.
 *
 * Only the two DDMS roles look across outlets. That is not a permissions
 * nicety — it is the product's own claim: the cross-branch findings are what an
 * *owner* buys, and a service advisor at one branch has no use for another
 * branch's ledger.
 */
export function seesEveryOutlet(role: string): boolean {
  return may(role, "outlet.view_all");
}

export function refusalFor(role: string, module: AccessModule): string {
  return whyNot(role, VIEW_OF[module]);
}
