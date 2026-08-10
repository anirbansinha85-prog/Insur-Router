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
export type Principal = DealershipRole | "AGENT";

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
  JOB_CARD: ["job_card.mark_informed"],
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

/** Permissions a role holds that are not implied by a module. */
const EXTRA_BY_ROLE: Partial<Record<DealershipRole, Permission[]>> = {
  OWNER: ["policy.set", "outlet.view_all"],
  MANAGER: ["policy.set", "outlet.view_all"],
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
const WITHHELD: Partial<Record<Principal, Partial<Record<Permission, string>>>> = {
  AGENT: {
    "enquiry.log_contact":
      "Asserts somebody rang the customer. The agent cannot ring anybody, and the mark removes the row from the calls-to-make count.",
    "job_card.mark_informed":
      "Asserts the customer was told their vehicle is ready. Same objection, and the customer is the one who finds out it was false.",
    "registration.mark_notified":
      "Asserts the customer was told their certificate has arrived. A file marked notified stops being chased.",
    "registration.log_chase":
      "Asserts somebody rang the RTO. A chase that never happened makes a stalled file look handled for another week.",
    "receivable.log_chase":
      "Asserts somebody asked a party for money. The dealership's cash position is not a place to record work that did not occur.",
    "vehicle.mark_offered":
      "Asserts a salesman showed the unit to a named customer. It is also the field whose absence means nobody has asked for this bike.",
    "receivable.mark_disputed":
      "A judgement about whether a customer's account is in breach. R-49 reserves exactly that from a model, whatever it is confident of.",
    "part.raise_reorder":
      "Asserts a purchase order was raised in the dealer's own system, which DDMS never writes to (R-5, R-40).",
    "part.request_transfer":
      "Commits stock to move between outlets. A proposal rather than a claim, but the consequence is physical and it is not the band this agent is pointed at.",
    "vehicle.propose_transfer":
      "Same. Honest as a proposal, and held back until the two assignments have run for a while in a real dealership.",
    "policy.set":
      "The dealership's own numbers are the dealership's. An agent that could widen its own thresholds is an agent with no ceiling.",
  },
};

// ── Resolution ──────────────────────────────────────────────────────────────

function grantsFor(principal: Principal): Set<Permission> {
  if (principal === "AGENT") return new Set(AGENT_GRANTS);

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

  const role = principal as DealershipRole;
  const has = MODULES_BY_ROLE[role] ?? [];
  if (has.length === 0) {
    return "Your account has no role that can read anything. Ask the owner to set one.";
  }

  const job = ROLE_NOUN[role] ?? role.replace(/_/g, " ").toLowerCase();
  const module = MODULE_OF[permission] ?? moduleOfVerb(permission);

  if (!module) {
    // A permission belonging to no module — `policy.set` is the only one today.
    return (
      `Only an owner or a showroom manager sets these. They decide what the ` +
      `whole dealership does first, and your role covers one part of it.`
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
