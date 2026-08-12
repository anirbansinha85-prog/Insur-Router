/**
 * The overall view — how the business is doing, without opening a module.
 *
 * OBJ-35, and the second half of the one-line description of this product:
 * *it automates your routine tasks and gives you a dashboard with the overall
 * view.* The first half has been the whole of the work since 3 August. This is
 * the other one.
 *
 * ## It derives nothing
 *
 * Every figure on this screen is already computed somewhere else. The seven
 * classifiers, the queue's bands, the reconciliation, the outbox gate and the
 * ladder's standing all exist and all have verifiers behind them. This module
 * loops the visible outlets, calls the same builders every worklist route
 * calls, and adds up what comes back.
 *
 * That is a deliberate refusal rather than laziness. A dashboard that computes
 * its own version of *overdue* is a second answer to a question the product
 * already answers, and the two drift within a month — the owner's screen says
 * eleven and the receivables screen says nine, and from then on nobody trusts
 * either. **The overall view is not allowed to know anything the module screens
 * do not.** `verify:overview` states exactly that as a claim it could fail.
 *
 * Nothing is stored. Same rule as reconciliation in R-12: this is a read.
 *
 * ## Every figure opens the rows underneath it
 *
 * `href` is not decoration. R-20 says this product is a control panel and not a
 * report, and a number you cannot walk into is a report — it tells somebody
 * that eleven things are wrong and leaves them to find which eleven. The two
 * figures with a null `href` are the ones with genuinely no list behind them,
 * and they say so.
 *
 * ## A module you may not read is named, never zeroed
 *
 * The same defect the route guard in `permitted.ts` was written for: rendering
 * a screen for somebody without the permission produced four zeroes and an
 * empty state, which reads as *your dealership has none of these* — a false
 * claim about somebody's own business. Here it would be worse, because the
 * zeroes would be summed into a headline. Modules outside the role are left out
 * of the arithmetic and listed by name in `scope.withheld`.
 *
 * ## The headline is written by a rule
 *
 * R-49 does not bend for a summary sentence. The findings are ordered by a
 * fixed table, the top three are taken, and each is worded by a function. No
 * model is called from this file, and there is no branch where one could be.
 */

import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  ownersTable,
  saleDocumentsTable,
  showroomsTable,
} from "@workspace/db";

import { buildQueue } from "./queue";
import { canRead, refusalFor, type AccessModule } from "./permissions";
import { loadPolicy, type ResolvedPolicy } from "./policy";
import { listMessages, summariseOutbox } from "./outbound";
import { standingFor } from "./autonomy";
import { buildWorklist, summarise } from "./worklist";
import { buildLeadWorklist, summariseLeads } from "./lead-worklist";
import { buildServiceWorklist, summariseService } from "./service-worklist";
import { buildRegistrationWorklist, summariseRegistrations } from "./registration-worklist";
import { buildSparesWorklist, summariseSpares } from "./spares-worklist";
import { buildReceivablesWorklist, summariseReceivables } from "./receivables-worklist";
import { buildInventoryWorklist, summariseInventory } from "./inventory-worklist";

export type FigureUnit = "COUNT" | "RUPEES" | "DAYS";

/**
 * How much attention a figure is asking for.
 *
 * `BAD` is reserved for numbers that should be zero and are not — money past
 * its date, work with nobody on it, a vehicle on the road with no registration.
 * `WATCH` is a number that is fine now and will not stay fine. `PLAIN` is
 * context, and most of the screen is context: a dashboard where everything is
 * red is a dashboard nobody reads twice.
 */
export type FigureTone = "PLAIN" | "WATCH" | "BAD";

export interface OverviewFigure {
  key: string;
  label: string;
  value: number;
  unit: FigureUnit;
  tone: FigureTone;
  /** The screen listing the rows behind this number. Null where none lists them. */
  href: string | null;
  /** One line of what the number means, where the label cannot carry it. */
  hint: string | null;
}

export type SectionId =
  | "ATTENTION"
  | "MONEY"
  | "HELD"
  | "AGEING"
  | "GAP"
  | "UNATTENDED";

export interface OverviewSection {
  id: SectionId;
  title: string;
  blurb: string;
  figures: OverviewFigure[];
}

export interface OverviewResult {
  generatedAt: string;
  scope: {
    ownerName: string;
    outlets: Array<{ id: number; name: string; code: string }>;
    /** Modules folded into the arithmetic. */
    modules: AccessModule[];
    /** Modules left out because this role may not read them, with the reason. */
    withheld: Array<{ module: AccessModule; reason: string }>;
  };
  /**
   * How old the mirror is, and it belongs at the top rather than in a corner.
   *
   * Every number below is as true as the last sync and no truer. The oldest
   * sync across the visible outlets is the honest bound — reporting the newest
   * would let one outlet that synced a minute ago vouch for another that has
   * not synced since Tuesday.
   */
  mirror: { lastSyncedAt: string | null; staleHours: number | null };
  /** Two or three sentences, chosen and worded by rules. */
  headline: string[];
  sections: OverviewSection[];
  /** What this view cannot tell you, derived from the state it just read. */
  limits: string[];
}

export interface OverviewInput {
  ownerId: number;
  ownerShowroomIds: number[];
  visibleShowroomIds: number[];
  empCode: string | null;
  role: string;
  policy?: ResolvedPolicy;
}

const ALL_MODULES: AccessModule[] = [
  "DEAL",
  "ENQUIRY",
  "JOB_CARD",
  "REGISTRATION",
  "PART",
  "RECEIVABLE",
  "VEHICLE",
];

/**
 * Counting issued documents, because nothing else does.
 *
 * `listDocuments` caps at a hundred rows, which is right for a screen and
 * wrong for a total — a dealership past its hundredth invoice would see the
 * count stop climbing and have no way to tell that from a quiet month. This is
 * a `count(*)`, not a new derivation: it groups on the same `status` and `kind`
 * the invoice module already writes, and answers no question that module does
 * not already answer one row at a time.
 */
async function issuedDocuments(
  ownerId: number,
  showroomIds: number[],
): Promise<{ taxInvoices: number; confirmations: number; cancelled: number }> {
  if (showroomIds.length === 0) return { taxInvoices: 0, confirmations: 0, cancelled: 0 };

  const rows = await db
    .select({
      kind: saleDocumentsTable.kind,
      status: saleDocumentsTable.status,
      n: count(),
    })
    .from(saleDocumentsTable)
    .where(
      and(
        eq(saleDocumentsTable.ownerId, ownerId),
        inArray(saleDocumentsTable.showroomId, showroomIds),
      ),
    )
    .groupBy(saleDocumentsTable.kind, saleDocumentsTable.status);

  let taxInvoices = 0;
  let confirmations = 0;
  let cancelled = 0;
  for (const r of rows) {
    if (r.status === "CANCELLED") cancelled += r.n;
    else if (r.status === "ISSUED" && r.kind === "TAX_INVOICE") taxInvoices += r.n;
    else if (r.status === "ISSUED" && r.kind === "SALE_CONFIRMATION") confirmations += r.n;
  }
  return { taxInvoices, confirmations, cancelled };
}

/** The stalest of the outlets' sync times, or null when none has ever synced. */
function oldestSync(stamps: Array<string | null>): string | null {
  const real = stamps.filter((s): s is string => s !== null);
  if (real.length === 0) return null;
  return real.reduce((a, b) => (a < b ? a : b));
}

function figure(
  key: string,
  label: string,
  value: number,
  unit: FigureUnit,
  tone: FigureTone,
  href: string | null,
  hint: string | null = null,
): OverviewFigure {
  /*
   * Money is rounded to paise here rather than on the screen.
   *
   * Interest accrued comes out of a daily rate and arrived as
   * `36733.291024657534` — a figure asserting fourteen significant digits of
   * precision about a number derived from an annual percentage. Rounding in
   * the response rather than in the formatter means the printable diagnostic,
   * the screen and anything anybody exports all carry the same figure; a
   * display-only round is how two copies of one number start to disagree.
   *
   * Counts and days are already whole and are left alone.
   */
  return {
    key,
    label,
    value: unit === "RUPEES" ? Math.round(value * 100) / 100 : value,
    unit,
    tone,
    href,
    hint,
  };
}

/**
 * Everything the seven classifiers said, folded across the visible outlets.
 *
 * Each builder is outlet-scoped in the rows it returns — spares, receivables
 * and inventory read the whole group to answer their cross-branch questions and
 * then filter back to one outlet before returning. That is what makes summing
 * them safe. It is also the thing that would silently double every money
 * figure on this screen if it ever changed, which is why `verify:overview`
 * checks a total against the rows rather than against another total.
 */
async function foldModules(
  input: OverviewInput,
  policy: ResolvedPolicy,
  modules: Set<AccessModule>,
) {
  const outlets = input.visibleShowroomIds;
  const owned = input.ownerShowroomIds;

  const zero = {
    dealTotal: 0,
    ahead: 0,
    behind: 0,
    conflict: 0,
    notStarted: 0,
    oldestDaysInStatus: 0,

    leadTotal: 0,
    slaBreached: 0,
    leadOrphaned: 0,

    readyUncollected: 0,
    worstDaysLate: 0,

    rcInDrawer: 0,
    blockedOnInsurance: 0,
    tempRegLapsed: 0,
    tempRegAtRisk: 0,
    taxHeldAmount: 0,
    oldestOpenDays: 0,

    availableElsewhere: 0,
    stockoutBlocking: 0,
    belowReorder: 0,
    idleCapital: 0,

    outstanding: 0,
    overdue: 0,
    worstDaysOverdue: 0,

    capitalTiedUp: 0,
    interestAccrued: 0,
    interestPerDay: 0,
    wanted: 0,
    oldestStockDays: 0,

    syncs: [] as Array<string | null>,
  };

  for (const showroomId of outlets) {
    if (modules.has("DEAL")) {
      const s = summarise(await buildWorklist({ showroomId }));
      zero.dealTotal += s.total;
      zero.ahead += s.byReconcile.AHEAD;
      zero.behind += s.byReconcile.BEHIND;
      zero.conflict += s.byReconcile.CONFLICT;
      zero.notStarted += s.byReconcile.NOT_STARTED;
      zero.oldestDaysInStatus = Math.max(zero.oldestDaysInStatus, s.oldestDaysInStatus);
      zero.syncs.push(s.lastSyncedAt);
    }
    if (modules.has("ENQUIRY")) {
      const s = summariseLeads(await buildLeadWorklist({ showroomId }));
      zero.leadTotal += s.total;
      zero.slaBreached += s.slaBreached;
      zero.leadOrphaned += s.orphaned;
      zero.syncs.push(s.lastSyncedAt);
    }
    if (modules.has("JOB_CARD")) {
      const s = summariseService(await buildServiceWorklist({ showroomId }));
      zero.readyUncollected += s.readyUncollected;
      zero.worstDaysLate = Math.max(zero.worstDaysLate, s.worstDaysLate);
      zero.syncs.push(s.lastSyncedAt);
    }
    if (modules.has("REGISTRATION")) {
      const s = summariseRegistrations(
        await buildRegistrationWorklist({ showroomId, policy }),
      );
      zero.rcInDrawer += s.rcInDrawer;
      zero.blockedOnInsurance += s.blockedOnInsurance;
      zero.tempRegLapsed += s.tempRegLapsed;
      zero.tempRegAtRisk += s.tempRegAtRisk;
      zero.taxHeldAmount += s.taxHeldAmount;
      zero.oldestOpenDays = Math.max(zero.oldestOpenDays, s.oldestOpenDays);
      zero.syncs.push(s.lastSyncedAt);
    }
    if (modules.has("PART")) {
      const s = summariseSpares(
        await buildSparesWorklist({ showroomId, ownerShowroomIds: owned, policy }),
      );
      zero.availableElsewhere += s.availableElsewhere;
      zero.stockoutBlocking += s.stockoutBlocking;
      zero.belowReorder += s.belowReorder;
      zero.idleCapital += s.idleCapital;
      zero.syncs.push(s.lastSyncedAt);
    }
    if (modules.has("RECEIVABLE")) {
      const s = summariseReceivables(
        await buildReceivablesWorklist({ showroomId, ownerShowroomIds: owned, policy }),
      );
      zero.outstanding += s.outstanding;
      zero.overdue += s.overdue;
      zero.worstDaysOverdue = Math.max(zero.worstDaysOverdue, s.worstDaysOverdue);
      zero.syncs.push(s.lastSyncedAt);
    }
    if (modules.has("VEHICLE")) {
      const s = summariseInventory(
        await buildInventoryWorklist({ showroomId, ownerShowroomIds: owned, policy }),
      );
      zero.capitalTiedUp += s.capitalTiedUp;
      zero.interestAccrued += s.interestAccrued;
      zero.interestPerDay += s.interestPerDay;
      zero.wanted += s.wanted;
      zero.oldestStockDays = Math.max(zero.oldestStockDays, s.oldestDays);
      zero.syncs.push(s.lastSyncedAt);
    }
  }

  return zero;
}

/**
 * Which findings lead, in a fixed order, with no model anywhere near it.
 *
 * Ordered by what a short-staffed dealership loses by ignoring it for a week:
 * a vehicle on the road with no registration is a legal exposure, money past
 * its date is cash, orphaned work is the thing this product exists to surface,
 * and a conflict between two systems about one vehicle's insurance is how a
 * bike gets delivered uninsured.
 *
 * Three at most. A summary that lists nine things has not summarised anything,
 * and the fourth-worst finding is one click away on its own screen.
 */
const HEADLINE_ORDER: Array<{
  key: string;
  when: (f: Map<string, OverviewFigure>) => boolean;
  say: (f: Map<string, OverviewFigure>) => string;
}> = [
  {
    key: "tempRegLapsed",
    when: (f) => (f.get("tempRegLapsed")?.value ?? 0) > 0,
    say: (f) =>
      `${f.get("tempRegLapsed")!.value} vehicle${plural(f.get("tempRegLapsed")!.value)} ${isAre(f.get("tempRegLapsed")!.value)} on the road with no valid registration.`,
  },
  {
    key: "conflict",
    when: (f) => (f.get("conflict")?.value ?? 0) > 0,
    say: (f) =>
      `${f.get("conflict")!.value} vehicle${plural(f.get("conflict")!.value)} ${hasHave(f.get("conflict")!.value)} two different insurance policies between DDMS and the DMS.`,
  },
  {
    key: "overdue",
    when: (f) => (f.get("overdue")?.value ?? 0) > 0,
    say: (f) =>
      `${rupees(f.get("overdue")!.value)} is past its due date${f.get("worstDaysOverdue")?.value ? `, the oldest by ${f.get("worstDaysOverdue")!.value} days` : ""}.`,
  },
  {
    key: "unassigned",
    when: (f) => (f.get("unassigned")?.value ?? 0) > 0,
    say: (f) =>
      `${f.get("unassigned")!.value} piece${plural(f.get("unassigned")!.value)} of work ${hasHave(f.get("unassigned")!.value)} nobody on ${itThem(f.get("unassigned")!.value)}.`,
  },
  {
    key: "rcInDrawer",
    when: (f) => (f.get("rcInDrawer")?.value ?? 0) > 0,
    say: (f) =>
      `${f.get("rcInDrawer")!.value} registration certificate${plural(f.get("rcInDrawer")!.value)} ${isAre(f.get("rcInDrawer")!.value)} in the drawer and not with ${theirOwner(f.get("rcInDrawer")!.value)}.`,
  },
  {
    key: "stockoutBlocking",
    when: (f) => (f.get("stockoutBlocking")?.value ?? 0) > 0,
    say: (f) =>
      `${f.get("stockoutBlocking")!.value} customer${plural(f.get("stockoutBlocking")!.value)} ${isAre(f.get("stockoutBlocking")!.value)} waiting on a part that is out of stock.`,
  },
  {
    key: "interestAccrued",
    when: (f) => (f.get("interestPerDay")?.value ?? 0) > 0,
    say: (f) =>
      `Standing stock is costing ${rupees(f.get("interestPerDay")!.value)} a day in interest.`,
  },
];

const plural = (n: number) => (n === 1 ? "" : "s");
const isAre = (n: number) => (n === 1 ? "is" : "are");
const hasHave = (n: number) => (n === 1 ? "has" : "have");
const itThem = (n: number) => (n === 1 ? "it" : "them");
const theirOwner = (n: number) => (n === 1 ? "its owner" : "their owners");

/** Indian grouping, whole rupees. The paise on a dashboard is noise. */
function rupees(n: number): string {
  const whole = Math.round(n);
  const s = String(Math.abs(whole));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return `${whole < 0 ? "-" : ""}₹${grouped}`;
}

export async function buildOverview(input: OverviewInput): Promise<OverviewResult> {
  const policy = input.policy ?? (await loadPolicy(input.ownerId));

  const modules = new Set(ALL_MODULES.filter((m) => canRead(input.role, m)));
  const withheld = ALL_MODULES.filter((m) => !modules.has(m)).map((m) => ({
    module: m,
    reason: refusalFor(input.role, m),
  }));

  /*
   * The group's name, not the first outlet's.
   *
   * `outlets[0].name` was the shortcut and it puts *Saraswati Motors — Rohini*
   * at the top of a page covering three branches. It also changes when
   * somebody's login is scoped to a different outlet, so the same dealership
   * would be headed two different things depending on who signed in.
   */
  const [owner] = await db
    .select({ name: ownersTable.name })
    .from(ownersTable)
    .where(eq(ownersTable.id, input.ownerId));

  const outlets = await db
    .select({ id: showroomsTable.id, name: showroomsTable.name, code: showroomsTable.code })
    .from(showroomsTable)
    .where(
      and(
        eq(showroomsTable.ownerId, input.ownerId),
        input.visibleShowroomIds.length > 0
          ? inArray(showroomsTable.id, input.visibleShowroomIds)
          : sql`false`,
      ),
    );

  /*
   * Two passes over the same mirror, and it is the honest simple thing here.
   *
   * `buildQueue` runs the seven builders to order what is waiting on a person;
   * `foldModules` runs them again for the money and ageing figures. A
   * dealership holds hundreds of open records, not hundreds of thousands, and
   * one extra pass on a screen somebody opens in the morning is cheaper than
   * the alternative — which is either a second set of queries that answer the
   * same questions differently, or a `buildQueue` signature that takes
   * pre-built rows and can therefore be handed rows from somewhere else.
   *
   * If a group ever gets large enough for this to matter, the fix is to give
   * `buildQueue` an optional pre-built set, not to compute anything twice.
   */
  const [folded, queue, outbox, standing, docs] = await Promise.all([
    foldModules(input, policy, modules),
    buildQueue({
      ownerId: input.ownerId,
      ownerShowroomIds: input.ownerShowroomIds,
      visibleShowroomIds: input.visibleShowroomIds,
      empCode: input.empCode,
      role: input.role,
      policy,
    }),
    listMessages(input.ownerId).then(summariseOutbox),
    standingFor({
      ownerId: input.ownerId,
      showroomIds: input.visibleShowroomIds,
      policy,
      label: () => null,
    }),
    issuedDocuments(input.ownerId, input.visibleShowroomIds),
  ]);

  const sections: OverviewSection[] = [];
  const index = new Map<string, OverviewFigure>();
  const add = (section: OverviewSection) => {
    for (const f of section.figures) index.set(f.key, f);
    if (section.figures.length > 0) sections.push(section);
  };

  // ── Waiting on a person ──────────────────────────────────────────────────
  add({
    id: "ATTENTION",
    title: "Waiting on somebody",
    blurb:
      "Everything across every module that needs a person, in one number. The queue works it one at a time in the order these outlets said they wanted.",
    figures: [
      figure("queueTotal", "Waiting on a person", queue.total, "COUNT", "PLAIN", "/queue"),
      figure(
        "unassigned",
        "With nobody on it",
        queue.unassigned,
        "COUNT",
        queue.unassigned > 0 ? "BAD" : "PLAIN",
        "/queue",
        "Nobody active is carrying these. The number this product was built to surface.",
      ),
      /*
       * Only for somebody the work can actually be assigned to.
       *
       * An owner has no employee code, so nothing on the queue is ever theirs
       * and the figure is structurally zero. Rendered, it reads as *you are on
       * top of your own work* to the one person on the screen who has none —
       * the same false-reassurance shape as four zeroes on a module nobody may
       * read.
       */
      ...(input.empCode
        ? [figure("mine", "Yours", queue.mine, "COUNT", "PLAIN", "/queue")]
        : []),
      ...(modules.has("ENQUIRY")
        ? [
            figure(
              "slaBreached",
              "Leads past the manufacturer's clock",
              folded.slaBreached,
              "COUNT",
              folded.slaBreached > 0 ? "BAD" : "PLAIN",
              "/enquiries",
              "The response window closed with no contact recorded.",
            ),
          ]
        : []),
    ],
  });

  // ── The dealership's own money ───────────────────────────────────────────
  const money: OverviewFigure[] = [];
  if (modules.has("RECEIVABLE")) {
    money.push(
      figure(
        "overdue",
        "Past its due date",
        folded.overdue,
        "RUPEES",
        folded.overdue > 0 ? "BAD" : "PLAIN",
        "/receivables",
        "The number that should be zero.",
      ),
      figure("outstanding", "Outstanding", folded.outstanding, "RUPEES", "PLAIN", "/receivables"),
    );
  }
  if (modules.has("VEHICLE")) {
    money.push(
      figure(
        "capitalTiedUp",
        "Tied up in stock",
        folded.capitalTiedUp,
        "RUPEES",
        "PLAIN",
        "/inventory",
        "Cost of every unit not yet invoiced — what the floor-plan line is funding.",
      ),
      figure(
        "interestAccrued",
        "Interest paid on unsold stock",
        folded.interestAccrued,
        "RUPEES",
        folded.interestAccrued > 0 ? "WATCH" : "PLAIN",
        "/inventory",
      ),
      figure(
        "interestPerDay",
        "Cost of another day",
        folded.interestPerDay,
        "RUPEES",
        "WATCH",
        "/inventory",
        "What doing nothing costs, per day.",
      ),
    );
  }
  if (modules.has("PART")) {
    money.push(
      figure(
        "idleCapital",
        "Parts that have not moved",
        folded.idleCapital,
        "RUPEES",
        "PLAIN",
        "/spares",
        "Capital, not inventory.",
      ),
    );
  }
  add({
    id: "MONEY",
    title: "The dealership's money",
    blurb: "What the business is owed and what it has standing on the floor.",
    figures: money,
  });

  // ── Money that is not the dealership's ───────────────────────────────────
  //
  // R-103, on the screen rather than only in the ledger. Road tax collected
  // from a customer is the RTO's money sitting in a dealer's account, and a
  // dashboard that adds it to the cash position is teaching somebody to spend
  // it. It gets its own band for that reason and for no other.
  if (modules.has("REGISTRATION")) {
    add({
      id: "HELD",
      title: "Money held for somebody else",
      blurb:
        "Collected from customers and owed onward. It is in the dealership's account and it is not the dealership's — it belongs in the cash position as a liability, never as income.",
      figures: [
        figure(
          "taxHeldAmount",
          "Customers' road tax not yet paid over",
          folded.taxHeldAmount,
          "RUPEES",
          folded.taxHeldAmount > 0 ? "WATCH" : "PLAIN",
          "/registrations",
        ),
      ],
    });
  }

  // ── Time ─────────────────────────────────────────────────────────────────
  const ageing: OverviewFigure[] = [];
  if (modules.has("REGISTRATION")) {
    ageing.push(
      figure(
        "tempRegLapsed",
        "On the road with no valid registration",
        folded.tempRegLapsed,
        "COUNT",
        folded.tempRegLapsed > 0 ? "BAD" : "PLAIN",
        "/registrations",
        "Temporary registration expired and no permanent number yet.",
      ),
      figure(
        "tempRegAtRisk",
        "Temporary registration expiring this week",
        folded.tempRegAtRisk,
        "COUNT",
        folded.tempRegAtRisk > 0 ? "WATCH" : "PLAIN",
        "/registrations",
      ),
      figure(
        "rcInDrawer",
        "RCs held that the owner does not have",
        folded.rcInDrawer,
        "COUNT",
        folded.rcInDrawer > 0 ? "BAD" : "PLAIN",
        "/registrations",
      ),
      figure(
        "oldestOpenDays",
        "Oldest open registration file",
        folded.oldestOpenDays,
        "DAYS",
        "PLAIN",
        "/registrations",
      ),
    );
  }
  if (modules.has("JOB_CARD")) {
    ageing.push(
      figure(
        "readyUncollected",
        "Finished and not collected",
        folded.readyUncollected,
        "COUNT",
        folded.readyUncollected > 0 ? "WATCH" : "PLAIN",
        "/service",
        "Occupied bays and unmade calls.",
      ),
      figure(
        "worstDaysLate",
        "Furthest past a promised date",
        folded.worstDaysLate,
        "DAYS",
        folded.worstDaysLate > 0 ? "BAD" : "PLAIN",
        "/service",
      ),
    );
  }
  if (modules.has("PART")) {
    ageing.push(
      figure(
        "stockoutBlocking",
        "Customers waiting on a part nobody has",
        folded.stockoutBlocking,
        "COUNT",
        folded.stockoutBlocking > 0 ? "BAD" : "PLAIN",
        "/spares",
      ),
      figure(
        "availableElsewhere",
        "Waiting on a part another outlet holds",
        folded.availableElsewhere,
        "COUNT",
        folded.availableElsewhere > 0 ? "BAD" : "PLAIN",
        "/spares",
        "The company already owns it. No branch system can see this.",
      ),
    );
  }
  if (modules.has("VEHICLE")) {
    ageing.push(
      figure(
        "wanted",
        "Aged stock somebody is asking for",
        folded.wanted,
        "COUNT",
        folded.wanted > 0 ? "WATCH" : "PLAIN",
        "/inventory",
        "Standing units with a live enquiry against the model.",
      ),
      figure("oldestStockDays", "Longest a unit has stood", folded.oldestStockDays, "DAYS", "PLAIN", "/inventory"),
    );
  }
  if (modules.has("RECEIVABLE")) {
    ageing.push(
      figure(
        "worstDaysOverdue",
        "Oldest unpaid bill",
        folded.worstDaysOverdue,
        "DAYS",
        folded.worstDaysOverdue > 0 ? "BAD" : "PLAIN",
        "/receivables",
      ),
    );
  }
  add({
    id: "AGEING",
    title: "What time is costing",
    blurb: "Nothing here is urgent because it is new. Age is the severity.",
    figures: ageing,
  });

  // ── The gap between the two systems ──────────────────────────────────────
  if (modules.has("DEAL")) {
    add({
      id: "GAP",
      title: "What the DMS still believes",
      blurb:
        "DDMS is the current one and the difference is the signal. Nothing here writes to the DMS — each row names the exact value for somebody to key in.",
      figures: [
        figure(
          "conflict",
          "Two policies on one vehicle",
          folded.conflict,
          "COUNT",
          folded.conflict > 0 ? "BAD" : "PLAIN",
          "/worklist",
          "DDMS and the DMS disagree about which policy is on the bike.",
        ),
        figure(
          "ahead",
          "Issued here, not yet in the DMS",
          folded.ahead,
          "COUNT",
          folded.ahead > 0 ? "WATCH" : "PLAIN",
          "/worklist",
          "Somebody has to key these in. The value to copy is on the row.",
        ),
        figure(
          "behind",
          "In the DMS, not here",
          folded.behind,
          "COUNT",
          folded.behind > 0 ? "WATCH" : "PLAIN",
          "/worklist",
        ),
        figure(
          "notStarted",
          "No insurance either side",
          folded.notStarted,
          "COUNT",
          folded.notStarted > 0 ? "BAD" : "PLAIN",
          "/worklist",
        ),
      ],
    });
  }

  // ── What ran without being asked ─────────────────────────────────────────
  const patterns = [...standing.values()];
  const offered = patterns.reduce((n, p) => n + p.offered, 0);
  const accepted = patterns.reduce((n, p) => n + p.accepted, 0);
  const overridden = patterns.reduce((n, p) => n + p.overridden, 0);
  add({
    id: "UNATTENDED",
    title: "What the product did on its own",
    blurb:
      "Rules and the agent, and what happened to each thing they proposed. Nothing leaves the building without a rule permitting it or a person approving it.",
    figures: [
      figure(
        "held",
        "Approved and undelivered",
        outbox.held,
        "COUNT",
        outbox.held > 0 ? "WATCH" : "PLAIN",
        "/outbox",
        outbox.held > 0 ? "No WhatsApp or mail account is connected." : null,
      ),
      figure(
        "awaitingApproval",
        "Drafted, waiting for a person",
        outbox.awaitingApproval,
        "COUNT",
        "PLAIN",
        "/outbox",
      ),
      figure("sent", "Delivered", outbox.sent, "COUNT", "PLAIN", "/outbox"),
      /*
       * `offered` first, and it is not padding.
       *
       * *Accepted 0, overruled 0* on its own reads as a product whose every
       * suggestion was ignored. With the count they are out of in front, the
       * same two zeroes read as what they are — nothing has been proposed yet.
       * Two numbers cannot say which of those is true; three can.
       */
      figure(
        "offered",
        "Agent proposals made",
        offered,
        "COUNT",
        "PLAIN",
        "/learned",
        offered === 0 ? "The agent has not proposed anything at these outlets yet." : null,
      ),
      /*
       * Self-contained labels, not `…accepted` under the figure above.
       *
       * They read fine in a four-column grid until the grid wraps and the
       * parent ends one row while its two children start the next — which is
       * what the printed page does at A4. A label that depends on the label
       * beside it is a label that breaks at whatever width somebody's paper
       * happens to be.
       */
      figure("accepted", "Proposals accepted", accepted, "COUNT", "PLAIN", "/learned"),
      figure(
        "overridden",
        "Proposals overruled",
        overridden,
        "COUNT",
        "PLAIN",
        "/learned",
        "Overruling is how the ladder comes back down. A rising number is the product being corrected, not failing.",
      ),
      figure(
        "taxInvoices",
        "Tax invoices issued",
        docs.taxInvoices,
        "COUNT",
        "PLAIN",
        "/invoices",
      ),
      figure(
        "confirmations",
        "Sale confirmations issued",
        docs.confirmations,
        "COUNT",
        "PLAIN",
        "/invoices",
      ),
    ],
  });

  // ── The headline ─────────────────────────────────────────────────────────
  const headline = HEADLINE_ORDER.filter((h) => h.when(index))
    .slice(0, 3)
    .map((h) => h.say(index));

  // ── What this view cannot tell you ───────────────────────────────────────
  const lastSyncedAt = oldestSync(folded.syncs);
  const staleHours =
    lastSyncedAt === null
      ? null
      : Math.floor((Date.now() - new Date(lastSyncedAt).getTime()) / 3_600_000);

  const limits: string[] = [];
  limits.push(
    "Every figure here is as true as the last sync from the DMS and no truer. DDMS reads that system and never writes to it.",
  );
  if (staleHours !== null && staleHours >= 24) {
    limits.push(
      `The stalest outlet last synced ${staleHours} hours ago, so anything that changed in the DMS since then is not on this screen.`,
    );
  }
  if (lastSyncedAt === null) {
    limits.push("No outlet in this view has ever synced. Every figure below is zero for that reason and not because there is nothing to show.");
  }
  if (withheld.length > 0) {
    limits.push(
      `This view covers ${modules.size} of ${ALL_MODULES.length} modules. ${withheld.map((w) => w.module).join(", ")} ${withheld.length === 1 ? "is" : "are"} outside your role and left out of the arithmetic rather than counted as zero.`,
    );
  }
  if (outbox.held > 0) {
    limits.push(
      `${outbox.held} message${plural(outbox.held)} ${isAre(outbox.held)} approved and undelivered because no WhatsApp or mail account is connected. Nothing has reached a customer.`,
    );
  }
  if (input.visibleShowroomIds.length < input.ownerShowroomIds.length) {
    limits.push(
      `${input.visibleShowroomIds.length} of the group's ${input.ownerShowroomIds.length} outlets. Figures from the others are not included.`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      ownerName: owner?.name ?? "",
      outlets,
      modules: [...modules],
      withheld,
    },
    mirror: { lastSyncedAt, staleHours },
    headline,
    sections,
    limits,
  };
}
