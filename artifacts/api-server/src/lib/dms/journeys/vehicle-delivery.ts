/**
 * **Invoice raised → certificate in the customer's hands.**
 *
 * The first journey, and chosen rather than settled for. It spans four screens
 * that today do not know they describe one sale, it contains a real loop — the
 * RTO sends a file back and it must arrive back carrying the objection — and it
 * runs for weeks, so pause and resume is exercised by the calendar rather than
 * asserted in a comment.
 *
 * ## What a dealership currently sees instead
 *
 * Ten rows on four screens. The deal is `DELIVERED` on one, the registration
 * file is `SUBMITTED` on another, the policy is a line in InsurRouter, and the
 * road tax is a number in the ledger. Nothing joins them, so nobody can answer
 * *where has Mr Pillai's bike got to* without opening four screens and holding
 * the answer in their head.
 *
 * ## Every fork here is a rule
 *
 * Is the policy on the file, is the tax remitted, did a number come back, is
 * there an objection — each is a column test. Not one of them needs a model,
 * and R-78 says none of them may ever have one. The only thing a model could
 * usefully do in this file is phrase a sentence, and the sentences are already
 * written.
 *
 * ## The ending is the last step, not the absence of gaps
 *
 * The runtime finishes a journey when `HANDED_OVER` is done, whatever happened
 * to the steps behind it. A vehicle whose plate date the DMS never recorded is
 * still a delivered vehicle, and a journey that refused to finish over a
 * missing date would sit on somebody's queue for ever describing a sale that
 * closed in March.
 */

import type { JourneyDefinition, Step, Wait } from "./types";

/**
 * Everything the walk needs, gathered once per subject.
 *
 * Deliberately a flat, dumb object with no database handle on it. That is what
 * makes every predicate below a pure function — the same facts always produce
 * the same position, which is what lets the verifier run a simulated month
 * without a database and lets a restart mid-flight be a non-event.
 */
export interface DeliveryFacts {
  regnFileNo: string;
  showroomId: number;
  dealerCode: string;
  /** The DMS's own label. Read, never trusted as the whole answer. */
  status: string;
  dealId: string;

  customerName: string | null;
  customerMobile: string | null;
  modelDescription: string | null;
  chassisNo: string | null;

  /** The DMS's agent on the file, and DDMS's own assignment beside it. */
  agentEmpCode: string | null;
  assignedAgentEmpCode: string | null;

  /** From the deal, which is on a different screen entirely. */
  invoiceNo: string | null;
  invoiceDate: string | null;
  /**
   * Whether the deal is in the mirror at all — which is **not** the same
   * question as whether it carries an invoice, and conflating the two put nine
   * false rows on the queue the first time this journey ran.
   */
  dealKnown: boolean;

  policyNo: string | null;

  hasPendingDoc: boolean;
  pendingDocDesc: string | null;
  objectionDesc: string | null;

  roadTaxAmount: number | null;
  roadTaxCollectedDate: string | null;
  roadTaxPaidDate: string | null;

  submittedDate: string | null;
  regNo: string | null;
  regDate: string | null;
  hsrpFittedDate: string | null;
  rcReceivedDate: string | null;
  rcDeliveredDate: string | null;

  tempRegExpiryDate: string | null;
  customerNotifiedAt: string | null;
  rtoChasedAt: string | null;

  /** The file is no longer in the DMS. Abandoned, which is not finished. */
  disappeared: boolean;

  /** The day the walk is being made. Passed in, never read from the clock here. */
  today: string;
  /** The dealership's own numbers, resolved by the caller (OBJ-18). */
  rtoQuietDays: number;
}

const day = 86_400_000;

function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / day);
}

function addDays(from: string, n: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + n * day).toISOString().slice(0, 10);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** There is an objection on the file and nobody has cleared it. */
function underObjection(f: DeliveryFacts): boolean {
  return f.status === "REJECTED" && Boolean(f.objectionDesc);
}

/**
 * A step, plus the two things the queue needs that the vocabulary does not
 * carry: which of the dealership's own severity numbers this step borrows, and
 * whether it is the kind of thing worth putting on a screen at all.
 *
 * Borrowing the registration classifier's severity keys rather than inventing a
 * `SEVERITY.JOURNEY.*` group is deliberate. A dealership that decided a stuck
 * RC outranks a quiet RTO decided that for the whole product, and a second
 * table would let the queue and the journey disagree about the same file.
 */
export interface DeliveryStep extends Step<DeliveryFacts> {
  /**
   * A `REGISTRATION` state whose severity this step shares, where one fits.
   *
   * A function of the facts rather than a constant, because one step can be two
   * different degrees of urgent. `DOCUMENTS` is *waiting on the customer* most
   * of the time and *the RTO rejected this* after a loop, and the dealership
   * rated those 2 and 3. The first version had it as a constant and quietly
   * demoted every objected file to the lower of the two.
   */
  severityState?: (f: DeliveryFacts) => string | null;
}

/**
 * The first step, and the one that taught the model the difference between *we
 * know this did not happen* and *we cannot see whether it did*.
 *
 * The first version was `Boolean(f.invoiceNo)`, which read correctly and was
 * wrong: nine registration files in the seeded dealership name a deal the deal
 * mirror does not hold, so the join returned nothing and the journey concluded
 * the invoice had never been raised. It put nine files on somebody's queue
 * telling them to invoice a vehicle that was already registered.
 *
 * **A registration file only exists because the sale was invoiced.** So an
 * absent deal is absence of evidence, and the honest reading is that the step
 * happened somewhere we cannot see. A deal we *can* see with no invoice number
 * on it is the real thing, and it stays work.
 */
const INVOICED: DeliveryStep = {
  id: "INVOICED",
  title: "Invoice raised",
  actor: "DMS",
  done: (f) => Boolean(f.invoiceNo) || !f.dealKnown,
  wait: (f): Wait => ({
    kind: "PERSON",
    who: "the invoicing desk",
    why: `The registration file is open and the deal ${f.dealId} has no invoice number against it.`,
    todo: "Raise the invoice — nothing on this file can be lodged without it",
    role: "ACCOUNTS",
  }),
};

/**
 * The only step whose wait is on **another journey**, and the reason that kind
 * exists in the vocabulary at all.
 *
 * The RTO will not accept a file without a policy, and issuing one is not a
 * task somebody ticks off — it is InsurRouter's whole process, with its own
 * steps and its own failures. Modelling it as *waiting on a person* would put
 * a row on the RTO agent's screen for work the insurance desk has to do.
 */
const INSURED: DeliveryStep = {
  id: "INSURED",
  title: "Insurance issued",
  actor: "PERSON",
  severityState: () => "BLOCKED_NO_INSURANCE",
  done: (f) => Boolean(f.policyNo),
  wait: (): Wait => ({
    kind: "JOURNEY",
    who: "the insurance desk",
    why: "The RTO will not accept this file without a policy, and there is no policy on it.",
    todo: "Issue the insurance — nothing else on this file can move first",
    role: null,
  }),
};

/**
 * Where the loop lands.
 *
 * Not done while a document is outstanding **or** while an objection is live —
 * and the second half is what makes a backwards move happen at all. A file that
 * reached the RTO and was rejected finds this step un-done on the next pass, so
 * the position moves back here by itself. There is no special edge to maintain:
 * the loop falls out of the same *first step that is not done* walk as
 * everything else.
 */
const DOCUMENTS: DeliveryStep = {
  id: "DOCUMENTS",
  title: "Documents complete",
  actor: "OUTSIDE",
  // Two urgencies, one step. An objection is the dealership's 3; a customer
  // who has not brought a document in is its 2.
  severityState: (f) => (underObjection(f) ? "OBJECTION" : "AWAITING_DOCS"),
  done: (f) => !f.hasPendingDoc && !underObjection(f),
  wait: (f): Wait => {
    if (underObjection(f)) {
      return {
        kind: "PERSON",
        who: "the RTO agent",
        why: `The RTO returned this file: ${f.objectionDesc}`,
        todo: "Rework the objection and resubmit",
        role: "RTO_AGENT",
      };
    }
    return {
      kind: "OUTSIDE",
      who: "the customer",
      why: `Waiting on the customer for ${f.pendingDocDesc ?? "a document"}.`,
      todo: "Chase the customer for the outstanding document",
      role: "RTO_AGENT",
    };
  },
  returnsTo: (f) =>
    underObjection(f)
      ? { stepId: "DOCUMENTS", reason: f.objectionDesc as string }
      : null,
};

const ROAD_TAX: DeliveryStep = {
  id: "ROAD_TAX",
  title: "Road tax remitted",
  actor: "PERSON",
  severityState: () => "TAX_HELD",
  /**
   * Nothing to remit is done, not stuck. Some models and some states carry no
   * tax at this counter, and a journey that stalled on an absent obligation
   * would stall every one of them.
   */
  done: (f) => !f.roadTaxAmount || f.roadTaxAmount <= 0 || Boolean(f.roadTaxPaidDate),
  wait: (f): Wait => {
    const held = daysBetween(f.roadTaxCollectedDate, f.today);
    return {
      kind: "PERSON",
      who: "accounts",
      why:
        `₹${(f.roadTaxAmount ?? 0).toLocaleString("en-IN")} of road tax was collected from the customer and has not been paid to the RTO.` +
        (held === null ? "" : ` It has been ${plural(held, "day")}.`),
      todo: "Remit the road tax — the file cannot be lodged until it clears",
      role: "ACCOUNTS",
    };
  },
};

/**
 * The step the classifier has no name for.
 *
 * Every document in, the tax paid, the policy on the file — and nobody has
 * taken it to the RTO. `registration-worklist.ts` produces no state for that
 * and therefore no queue row: it has `AWAITING_DOCS` for the step before and
 * `RTO_SILENT` for the step after, and the gap between them is invisible.
 * Writing the journey out found it, which is most of the argument for writing
 * journeys out.
 */
const LODGED: DeliveryStep = {
  id: "LODGED",
  title: "Lodged with the RTO",
  actor: "PERSON",
  done: (f) => Boolean(f.submittedDate),
  wait: (): Wait => ({
    kind: "PERSON",
    who: "the RTO agent",
    why: "Everything this file needs is in place and it has not been taken to the RTO.",
    todo: "Lodge the file — it is ready and nothing is holding it",
    role: "RTO_AGENT",
  }),
};

/**
 * The clearest case for separating a `TIME` wait from an `OUTSIDE` one.
 *
 * A file lodged on Tuesday is not late on Wednesday, and putting it on
 * somebody's queue teaches them that the queue is full of things they cannot
 * act on. The changeover is the dealership's own `RTO_QUIET_DAYS`, because how
 * long an RTO may reasonably take depends entirely on which RTO.
 */
const ALLOTTED: DeliveryStep = {
  id: "ALLOTTED",
  title: "Number allotted",
  actor: "OUTSIDE",
  severityState: () => "RTO_SILENT",
  done: (f) => Boolean(f.regNo),
  wait: (f): Wait => {
    const waiting = daysBetween(f.submittedDate, f.today) ?? 0;
    const dueOn = f.submittedDate ? addDays(f.submittedDate, f.rtoQuietDays) : null;
    if (waiting < f.rtoQuietDays) {
      return {
        kind: "TIME",
        who: "the RTO",
        why: `Lodged ${plural(waiting, "day")} ago. The RTO normally takes ${plural(f.rtoQuietDays, "day")}.`,
        todo: "Nothing yet — it is inside the normal turnaround",
        role: "RTO_AGENT",
        notBefore: dueOn,
      };
    }
    return {
      kind: "OUTSIDE",
      who: "the RTO",
      why: `Lodged ${plural(waiting, "day")} ago and nothing has come back.`,
      todo: "Chase the RTO for the allotment",
      role: "RTO_AGENT",
      notBefore: dueOn,
    };
  },
};

const HSRP: DeliveryStep = {
  id: "HSRP",
  title: "Plate fitted",
  actor: "PERSON",
  severityState: () => "HSRP_PENDING",
  done: (f) => Boolean(f.hsrpFittedDate),
  wait: (f): Wait => ({
    kind: "PERSON",
    who: "the workshop",
    why: `${f.regNo} was allotted and the high-security plate has not been fitted.`,
    todo: "Fit the plate — it is legally required and the vehicle is on the road",
    role: "RTO_AGENT",
  }),
};

/**
 * The certificate is despatched by the RTO and carried by India Post to the
 * address on the file — it does not pass through the dealer's hands, and
 * Anirban's correction is what put that here rather than in a chase rule.
 *
 * The dealership's controllable duty happened three steps ago: the
 * communication address being right at the point of lodging. This step is a
 * pure `OUTSIDE` wait and there is deliberately nothing to do about it, which
 * is exactly the sort of row the old weekly chase used to produce anyway.
 */
const RC_ISSUED: DeliveryStep = {
  id: "RC_ISSUED",
  title: "Certificate issued",
  actor: "OUTSIDE",
  severityState: () => "RTO_SILENT",
  done: (f) => Boolean(f.rcReceivedDate),
  wait: (f): Wait => {
    const since = daysBetween(f.regDate, f.today) ?? 0;
    const dueOn = f.regDate ? addDays(f.regDate, f.rtoQuietDays) : null;
    if (since < f.rtoQuietDays) {
      return {
        kind: "TIME",
        who: "the RTO and India Post",
        why: `Registered ${plural(since, "day")} ago. The certificate is posted to the address on the file.`,
        todo: "Nothing yet — it is in the post",
        role: null,
        notBefore: dueOn,
      };
    }
    return {
      kind: "OUTSIDE",
      who: "the RTO and India Post",
      why: `Registered ${plural(since, "day")} ago and the certificate has not turned up.`,
      todo: "Ask the RTO whether the certificate was despatched, and to what address",
      role: "RTO_AGENT",
      notBefore: dueOn,
    };
  },
};

/**
 * The only ending that counts, and the one the DMS has no report for: it
 * considers the vehicle finished at `REGISTERED`.
 */
const HANDED_OVER: DeliveryStep = {
  id: "HANDED_OVER",
  title: "Customer has the certificate",
  actor: "PERSON",
  severityState: () => "RC_IN_DRAWER",
  done: (f) => Boolean(f.rcDeliveredDate),
  wait: (f): Wait => {
    const held = daysBetween(f.rcReceivedDate, f.today) ?? 0;
    return {
      kind: "PERSON",
      who: f.customerNotifiedAt ? "the customer" : "whoever rings customers",
      why: f.customerNotifiedAt
        ? `The certificate has been here ${plural(held, "day")}. The customer was told and has not come in.`
        : `The certificate has been here ${plural(held, "day")} and the customer does not know.`,
      todo: f.customerNotifiedAt
        ? "Ring again — they were told and have not collected it"
        : "Ring the customer to come and collect the certificate",
      role: "RTO_AGENT",
    };
  },
};

export const VEHICLE_DELIVERY: JourneyDefinition<DeliveryFacts> & {
  steps: DeliveryStep[];
} = {
  id: "VEHICLE_DELIVERY",
  version: 1,
  title: "Invoice to certificate",
  subjectModule: "REGISTRATION",
  steps: [
    INVOICED,
    INSURED,
    DOCUMENTS,
    ROAD_TAX,
    LODGED,
    ALLOTTED,
    HSRP,
    RC_ISSUED,
    HANDED_OVER,
  ],

  abandoned: (f) =>
    f.disappeared
      ? "The registration file is no longer in the dealer's system."
      : null,

  /**
   * DDMS's own assignment first, the DMS's second. Same precedence the
   * registration screen uses, and for the same reason: an agent somebody here
   * put on the file outranks whoever the OEM's system happens to name.
   */
  assignee: (f) => ({
    empCode: f.assignedAgentEmpCode ?? f.agentEmpCode,
    role: "RTO_AGENT",
  }),

  label: (f) => ({
    title: f.customerName ?? f.regnFileNo,
    subtitle: [f.modelDescription, f.regNo ?? f.chassisNo].filter(Boolean).join(" · ") || null,
  }),

  contact: (f) => ({ name: f.customerName, mobile: f.customerMobile }),
};
