/**
 * What each role in a dealership may see.
 *
 * One table, in one file, because it is the sort of thing that becomes
 * unreviewable the moment it is spread across route handlers. Everything that
 * asks *may this person see receivables* asks here — the routes, the sidebar,
 * and the SQL function that backs the row policies is generated from the same
 * shape.
 *
 * ## The asymmetry that matters
 *
 * This narrows and never widens. Every predicate it produces is ANDed onto the
 * owner scope that OBJ-3 and OBJ-7 established, never ORed with it, so the
 * worst a bug here can do is hide a row from somebody entitled to it. The
 * reverse — a role bug revealing another dealership's customers — is not
 * reachable from this file, and that asymmetry is deliberate.
 *
 * Salesforce's sharing model runs the same way in the opposite direction:
 * org-wide defaults set a private baseline and every later layer can only
 * grant. Here the baseline is the owner's whole group and every later layer can
 * only take away. Same property, mirrored, and for the same reason — you want
 * the direction of a mistake to be safe.
 */

export type DealershipRole =
  | "OWNER"
  | "MANAGER"
  | "SALES_EXEC"
  | "SERVICE_ADVISOR"
  | "RTO_AGENT"
  | "ACCOUNTS"
  | "TECHNICIAN";

/** The modules a screen or a policy can be gated on. */
export type AccessModule =
  | "DEAL"
  | "JOB_CARD"
  | "ENQUIRY"
  | "REGISTRATION"
  | "PART"
  | "RECEIVABLE"
  | "VEHICLE"
  | "OUTBOX";

const ALL: AccessModule[] = [
  "DEAL",
  "JOB_CARD",
  "ENQUIRY",
  "REGISTRATION",
  "PART",
  "RECEIVABLE",
  "VEHICLE",
  "OUTBOX",
];

/**
 * Role to modules.
 *
 * Drawn from what each job actually touches in a small dealership rather than
 * from a tidy hierarchy — a service advisor needs the parts counter because
 * their job cards wait on it, and accounts needs deals because an invoice
 * hangs off one. Guessing tidily here produces a product that is quietly
 * useless to four of the seven people who use it.
 *
 * `TECHNICIAN` is the narrowest and may in practice never be issued a login;
 * that is the dealership's call at runtime, not a decision this file should
 * make for them.
 */
const BY_ROLE: Record<DealershipRole, AccessModule[]> = {
  OWNER: ALL,
  MANAGER: ALL,
  SALES_EXEC: ["DEAL", "ENQUIRY", "VEHICLE", "OUTBOX"],
  SERVICE_ADVISOR: ["JOB_CARD", "PART", "OUTBOX"],
  RTO_AGENT: ["REGISTRATION", "OUTBOX"],
  ACCOUNTS: ["RECEIVABLE", "DEAL", "OUTBOX"],
  TECHNICIAN: ["JOB_CARD"],
};

export function modulesFor(role: string): AccessModule[] {
  return BY_ROLE[role as DealershipRole] ?? [];
}

export function canRead(role: string, module: AccessModule): boolean {
  return modulesFor(role).includes(module);
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
  return role === "OWNER" || role === "MANAGER";
}

/**
 * A refusal a person can act on.
 *
 * Named modules rather than "insufficient permissions", because the commonest
 * cause of one of these is somebody being given the wrong role on their first
 * day, and a message that says which role they have is a message their manager
 * can fix.
 */
export function refusalFor(role: string, module: AccessModule): string {
  const has = modulesFor(role);
  if (has.length === 0) {
    return `Your account has no role that can read anything. Ask the owner to set one.`;
  }
  const job = ROLE_NOUN[role as DealershipRole] ?? role.replace(/_/g, " ").toLowerCase();
  const mine = has
    .filter((m) => m !== "OUTBOX")
    .map((m) => MODULE_NOUN[m] ?? m.replace(/_/g, " ").toLowerCase());

  return (
    `${job} does not see ${MODULE_NOUN[module] ?? module.toLowerCase()}. ` +
    `Yours covers ${listOf(mine)}.`
  );
}

/**
 * The words a dealership uses, rather than the identifiers a schema does.
 *
 * A refusal is read by somebody who has just been stopped from doing their job,
 * usually because they were given the wrong role on their first day. "A
 * accounts does not see job card records" is the sort of sentence that makes a
 * person distrust the software instead of ringing their manager.
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
