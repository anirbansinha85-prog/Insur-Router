/**
 * The vocabulary a journey is written in.
 *
 * DDMS knows what is wrong with a **record**. This is the first thing in the
 * product that understands a **journey** — one real-world process, walking
 * through the building, with a beginning and an ending and the same set of
 * hands on it every time.
 *
 * ## Why a definition is code
 *
 * Almost every fork in a dealership is knowable from data: is the tax paid, is
 * the policy on the file, did the RTO answer. Those are rules, so they are
 * written in TypeScript and reviewed like any other change (R-52 unchanged,
 * R-78 added). There is no journey builder and there will not be one — the
 * failure being designed against is eighty flows on one object that nobody can
 * predict, and DDMS's customer has no administrator to untangle it.
 *
 * > **A model may write a sentence inside a step. It may never choose an edge.**
 *
 * Every `done`, `blocked` and `wait` below is a pure function of facts. None of
 * them may become a model call, and the type system is the first line of that:
 * they are synchronous and take no client.
 *
 * ## The four kinds of waiting
 *
 * This is the part DDMS could not express at all before. A stalled step is not
 * a state, it is a **wait on somebody**, and who that somebody is decides
 * whether the row is work or just news:
 *
 * | | |
 * |---|---|
 * | `PERSON` | somebody here has to do something. This is the only kind that is always work |
 * | `OUTSIDE` | the RTO, India Post, the customer. Work only once it has gone on too long |
 * | `JOURNEY` | another process must finish first — insurance, before registration can move |
 * | `TIME` | nothing to do until a date. Never work, and saying so is the point |
 *
 * A queue that cannot tell *waiting on the RTO, day two* from *waiting on the
 * RTO, day forty* puts both on somebody's screen and teaches them to scroll.
 */

/** Who moves a step. Not who is blamed for it — who physically acts. */
export type Actor =
  /** Nothing to do: it follows from something else being true. */
  | "RULE"
  /** Somebody in the dealership. */
  | "PERSON"
  /** DDMS's own agent, within what OBJ-17 and OBJ-22 permit it. */
  | "AGENT"
  /** The RTO, the customer, India Post, a financier. Nobody we employ. */
  | "OUTSIDE"
  /** Keyed into the dealer's own system, which DDMS never writes to (R-5). */
  | "DMS";

export type WaitKind = "PERSON" | "OUTSIDE" | "JOURNEY" | "TIME";

/**
 * Why a journey is not moving, in enough detail to be a queue row on its own.
 *
 * The mechanic that pays for the whole model: seven classifiers each hand-write
 * a *what to do* sentence today. A stalled step already knows where it stopped,
 * what it was trying to do and who it is waiting for, so the sentence is a
 * property of the definition rather than a string in a switch statement.
 */
export interface Wait {
  kind: WaitKind;
  /** Who or what is being waited on, named. `the RTO`, `the customer`, `accounts`. */
  who: string;
  /** Why it is stopped, in the dealership's words. Becomes the queue row's note. */
  why: string;
  /** What would move it. Becomes the queue row's `actionRequired`. */
  todo: string;
  /**
   * The role that would do it, where there is one. Feeds the queue's assignment
   * picker, and is null for anything nobody here can act on.
   */
  role?: string | null;
  /**
   * For a `TIME` wait: nothing is expected before this date. For an `OUTSIDE`
   * wait: the day it stops being normal and starts being late.
   */
  notBefore?: string | null;
  /**
   * Whether this is something going wrong or something worth doing (OBJ-25).
   *
   * Every row this product has ever put on a queue has been a problem — a file
   * the RTO sent back, a certificate nobody collected. *Everything is in place,
   * the invoice can be generated* is not a problem, and presenting it as one
   * would teach a dealership that the queue is a list of failures and that
   * finishing it is the goal.
   *
   * > **Invoices are not late because typing is hard. They are late because
   * > nobody noticed the deal became ready.**
   *
   * It does not change urgency — an opportunity is sorted on the same three
   * keys as everything else. It changes what the row says it is.
   */
  tone?: "PROBLEM" | "OPPORTUNITY";
}

/**
 * One step of a journey.
 *
 * The five things a step declares, and each earns its place: what must be true
 * for it to count as finished, who does it, why it might be stuck, what to say
 * about that, and — for the ones that can go backwards — what sent it back.
 */
export interface Step<F> {
  id: string;
  /** What this step is, in the dealership's words rather than the schema's. */
  title: string;
  actor: Actor;
  /** A `SEVERITY.<module>.<state>` this step shares, where one fits. */
  severityState?: (f: F) => string | null;

  /**
   * Has it happened? A rule over facts, and the only question the runtime asks
   * to work out where a journey stands.
   *
   * **Not** *is it currently in progress* — a step is done or it is not, and
   * the position is the first one that is not. That makes the walk total: any
   * fact-set maps to exactly one position, so a journey that was never seen
   * before can be placed correctly on its first pass, and one whose facts moved
   * three steps between passes lands on the right one rather than shuffling
   * forward once per scheduler run.
   */
  done(f: F): boolean;

  /**
   * Where it is waiting, when it is not done. Called only for the step the
   * journey is standing on.
   */
  wait(f: F): Wait;

  /**
   * A step it must go back to, and why.
   *
   * Only meaningful on steps that can be undone by the outside world — an RTO
   * objection is the case this exists for. Returning a step id sends the
   * journey backwards and the reason travels with it into `journey_steps`, so a
   * file on its third loop reads as one.
   */
  returnsTo?(f: F): { stepId: string; reason: string } | null;
}

/**
 * A map. Hardcoded, versioned, and the only thing in layer 2.
 *
 * `version` is bumped whenever the steps change in a way that would make an old
 * trace read wrongly. Journeys already running keep the version they started
 * under, so *what somebody was asked to do in March* stays answerable in
 * September.
 */
export interface JourneyDefinition<F> {
  id: string;
  version: number;
  /** What this journey is, for a person reading the panel. */
  title: string;
  /** The module its subject lives in — a registration file, a deal. */
  subjectModule: "DEAL" | "JOB_CARD" | "ENQUIRY" | "REGISTRATION" | "PART" | "RECEIVABLE" | "VEHICLE";
  /** In order. The position is the index of the first step that is not done. */
  steps: Array<Step<F>>;
  /**
   * Whether this subject still exists to have a journey about it. A file that
   * vanished from the DMS is abandoned rather than finished, and the two must
   * not be counted together.
   */
  abandoned?(f: F): string | null;
  /** Who is carrying it, for the queue's bands. */
  assignee(f: F): { empCode: string | null; role: string | null };
  /** The row's two lines. */
  label(f: F): { title: string; subtitle: string | null };
  /** Somebody to ring, where the journey has one. */
  contact(f: F): { name: string | null; mobile: string | null };
  /**
   * Everything this map needs, gathered once per outlet.
   *
   * On the definition rather than in the runtime, which is what made a **second
   * journey** possible without touching the runtime at all (OBJ-25). Two maps
   * read two entirely different sets of tables — one joins the registration
   * mirror to the deal mirror, the other joins deals to price lists — and the
   * runtime that walks them both must not know either.
   */
  loadFacts(input: {
    ownerId: number;
    showroomIds: number[];
    /** The dealership's own numbers. */
    policy: unknown;
    now: Date;
  }): Promise<Map<string, F>>;
  /**
   * Which `SEVERITY.*` state a step borrows, where one fits.
   *
   * On the definition because it is a property of the map, and a function of
   * the facts because one step can be two degrees of urgent — `DOCUMENTS` is
   * *waiting on the customer* most of the time and *the RTO rejected this*
   * after a loop, and the dealership rated those differently.
   */
  severityModule: string;
}

/** Where a journey stands, worked out fresh from facts. Never stored. */
export interface Position<F> {
  /** `null` when every step is done — the journey has finished. */
  step: Step<F> | null;
  index: number;
  /** How many of the steps are behind it, for a progress reading. */
  completed: number;
  total: number;
  /** Null on a finished journey. */
  wait: Wait | null;
  /** Set when the outside world has undone something already done. */
  returnedTo: { stepId: string; reason: string } | null;
}
