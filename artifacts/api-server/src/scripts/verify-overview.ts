/**
 * OBJ-35's done-when, stated so it can fail.
 *
 * > *The overall view knows nothing the module screens do not, sums each
 * > outlet exactly once, never shows a role more than that role may read, and
 * > cites nothing it did not compute.*
 *
 * Four claims, and the first is the only reason this file exists. A dashboard
 * is the easiest thing in a product to make quietly wrong: nobody cross-checks
 * a headline against seven screens, so a fold that adds one outlet twice or a
 * summary that counts a state under two names survives for months and is
 * discovered by an owner who trusts a number and acts on it.
 *
 * ## What each section actually proves, having been caught getting this wrong
 *
 * The first version of this file counted rows through the same builders
 * `overview.ts` calls, and described that as independent. It is not. Removing
 * the outlet filter from `receivables-worklist.ts` — the single line that
 * stops a cross-branch builder returning the whole group for every outlet —
 * **left all twenty-two checks passing**, because the defect landed on both
 * sides of every comparison and cancelled itself out. A verifier that agrees
 * with the bug is worse than no verifier: it is a bug with a tick beside it.
 *
 * So the sections are now honest about their reach:
 *
 * - **§2 is a consistency check.** Summary against rows, both through the
 *   builder. It catches a summary that counts a state under two names or
 *   misses one. It cannot catch anything wrong inside the builder itself, and
 *   it no longer claims to.
 * - **§3 is the independent one**, and it has two halves. The first reads the
 *   mirror table in SQL with no classifier anywhere near it, which is the only
 *   comparison here that shares no code with the thing it checks. The second
 *   asserts the invariant the whole fold rests on: **a builder asked for one
 *   outlet returns that outlet's rows and no others.** That is the assertion
 *   the mutation above walks straight into, and it is three lines in three
 *   files that nothing else in the product would miss.
 *
 * Spares, receivables and inventory each read every outlet in the group to
 * answer their cross-branch questions and then filter back to one before
 * returning. Lose that filter and every money figure on the owner's screen
 * doubles, silently, each figure still internally consistent.
 *
 * Runs on the **worker credential**, like the rest, because the arithmetic
 * must not depend on who is signed in.
 *
 * `pnpm run verify:overview`.
 */

import {
  db,
  withWorkerScope,
  decisionLogTable,
  dmsVehicleStockTable,
  recordEventsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { buildOverview, type OverviewResult, type OverviewFigure } from "../lib/dms/overview";
import { loadPolicy } from "../lib/dms/policy";
import { buildReceivablesWorklist } from "../lib/dms/receivables-worklist";
import { buildRegistrationWorklist } from "../lib/dms/registration-worklist";
import { buildInventoryWorklist } from "../lib/dms/inventory-worklist";
import { buildWorklist } from "../lib/dms/worklist";
import { canRead, type AccessModule } from "../lib/dms/permissions";

const OWNER = 1;
const OUTLETS = [1, 2];

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

/** Every figure across every section, by key. */
function figures(o: OverviewResult): Map<string, OverviewFigure> {
  const m = new Map<string, OverviewFigure>();
  for (const s of o.sections) for (const f of s.figures) m.set(f.key, f);
  return m;
}

const value = (o: OverviewResult, key: string): number => figures(o).get(key)?.value ?? NaN;

/** Money compared to the paise, because `overview.ts` rounds there. */
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

const asOwner = () =>
  buildOverview({
    ownerId: OWNER,
    ownerShowroomIds: OUTLETS,
    visibleShowroomIds: OUTLETS,
    empCode: null,
    role: "OWNER",
  });

console.log("\nOBJ-35 — the overall view, against the rows underneath it");

// ═════════════════════════════════════════════════════════════════════════
section("1. It builds, for the whole group");

const overview = await withWorkerScope(asOwner);

check(
  "every visible outlet is in scope",
  overview.scope.outlets.length === OUTLETS.length,
  `${overview.scope.outlets.map((o) => o.name).join(", ")}`,
);
check(
  "an owner has every module and nothing is withheld",
  overview.scope.modules.length === 7 && overview.scope.withheld.length === 0,
  `${overview.scope.modules.length} modules, ${overview.scope.withheld.length} withheld`,
);
check("it produced sections", overview.sections.length > 0, `${overview.sections.length} sections`);

// ═════════════════════════════════════════════════════════════════════════
section("2. Each figure equals the rows the module screen shows");

/*
 * Summary against rows, both through the builder — a consistency check and not
 * an independent one. It catches a summary that counts a state under two names
 * or drops one, which is a real and common defect. It cannot catch a builder
 * returning the wrong rows, because both sides would be wrong together; §3 is
 * where that is caught.
 */
const rows = await withWorkerScope(async () => {
  const policy = await loadPolicy(OWNER);
  let overdueAmount = 0;
  let rcInDrawer = 0;
  let tempRegLapsed = 0;
  let capitalTiedUp = 0;
  let conflict = 0;

  for (const showroomId of OUTLETS) {
    for (const r of await buildReceivablesWorklist({
      showroomId,
      ownerShowroomIds: OUTLETS,
      policy,
    })) {
      if (r.state !== "SETTLED" && (r.daysOverdue ?? 0) > 0) overdueAmount += r.balance ?? 0;
    }
    for (const f of await buildRegistrationWorklist({ showroomId, policy })) {
      if (f.state === "RC_IN_DRAWER") rcInDrawer++;
      if (f.tempRegDaysLeft !== null && f.tempRegDaysLeft < 0 && !f.dms.regNo) tempRegLapsed++;
    }
    for (const u of await buildInventoryWorklist({
      showroomId,
      ownerShowroomIds: OUTLETS,
      policy,
    })) {
      if (!u.dms.invoicedDate) capitalTiedUp += u.dms.costAmount ?? 0;
    }
    for (const d of await buildWorklist({ showroomId })) {
      if (d.reconcile === "CONFLICT") conflict++;
    }
  }
  return { overdueAmount, rcInDrawer, tempRegLapsed, capitalTiedUp, conflict };
});

check(
  "money past its due date is the sum of the overdue rows",
  near(value(overview, "overdue"), rows.overdueAmount),
  `overview ₹${value(overview, "overdue").toFixed(2)} · rows ₹${rows.overdueAmount.toFixed(2)}`,
);
check(
  "certificates in the drawer is the count of RC_IN_DRAWER files",
  value(overview, "rcInDrawer") === rows.rcInDrawer,
  `overview ${value(overview, "rcInDrawer")} · rows ${rows.rcInDrawer}`,
);
check(
  "capital in stock is the cost of every uninvoiced unit",
  near(value(overview, "capitalTiedUp"), rows.capitalTiedUp),
  `overview ₹${value(overview, "capitalTiedUp").toFixed(2)} · rows ₹${rows.capitalTiedUp.toFixed(2)}`,
);
check(
  "two policies on one vehicle is the count of CONFLICT deals",
  value(overview, "conflict") === rows.conflict,
  `overview ${value(overview, "conflict")} · rows ${rows.conflict}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("3. Against the mirror, sharing no code with the thing it checks");

/*
 * The only comparison in this file that a bug cannot land on both sides of.
 *
 * `capital tied up` is the cost of every unit not yet invoiced. That is a
 * column and a null test — no classifier, no policy, no builder — so the same
 * figure can be read straight out of `dms_vehicle_stock` and set against what
 * the screen says. If the two ever disagree, something between the table and
 * the owner's eye is wrong, and this is the check that says so.
 *
 * Only one figure gets this treatment on purpose. Every other number on the
 * overall view is a classifier's answer, and reimplementing a classifier in
 * its own verifier produces a second opinion that drifts and then fails for
 * reasons that have nothing to do with the code under test.
 */
const fromMirror = await withWorkerScope(async () => {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${dmsVehicleStockTable.costAmount}), 0)::text` })
    .from(dmsVehicleStockTable)
    .where(
      and(
        inArray(dmsVehicleStockTable.showroomId, OUTLETS),
        isNull(dmsVehicleStockTable.invoicedDate),
        isNull(dmsVehicleStockTable.disappearedAt),
      ),
    );
  return Number(row?.total ?? 0);
});

check(
  "capital tied up equals the mirror, read in SQL with no classifier involved",
  near(value(overview, "capitalTiedUp"), fromMirror),
  `overview ₹${value(overview, "capitalTiedUp").toFixed(2)} · mirror ₹${fromMirror.toFixed(2)}`,
);

/*
 * The invariant the entire fold rests on, asserted rather than assumed.
 *
 * This is the check the removed-filter mutation walks into. The additive test
 * below it does not catch that — with every builder returning the group, both
 * the group run and the per-outlet runs inflate by the same factor and the sum
 * still balances. Asking each row which outlet it belongs to does not balance.
 */
const strayRows = await withWorkerScope(async () => {
  const policy = await loadPolicy(OWNER);
  const stray: string[] = [];
  for (const showroomId of OUTLETS) {
    const rec = await buildReceivablesWorklist({ showroomId, ownerShowroomIds: OUTLETS, policy });
    const inv = await buildInventoryWorklist({ showroomId, ownerShowroomIds: OUTLETS, policy });
    for (const [name, list] of [
      ["receivables", rec],
      ["inventory", inv],
    ] as const) {
      const wrong = (list as Array<{ showroomId: number }>).filter(
        (r) => r.showroomId !== showroomId,
      ).length;
      if (wrong > 0) stray.push(`${name} at outlet ${showroomId}: ${wrong} row(s) from elsewhere`);
    }
  }
  return stray;
});

check(
  "a builder asked for one outlet returns that outlet's rows and no others",
  strayRows.length === 0,
  strayRows.join(" · ") ||
    "the cross-branch builders read the group and filter back, as the fold requires",
);

section("4. Each outlet is counted exactly once");

const perOutlet = await withWorkerScope(async () => {
  const out: OverviewResult[] = [];
  for (const id of OUTLETS) {
    out.push(
      await buildOverview({
        ownerId: OWNER,
        ownerShowroomIds: OUTLETS,
        visibleShowroomIds: [id],
        empCode: null,
        role: "OWNER",
      }),
    );
  }
  return out;
});

for (const key of ["overdue", "outstanding", "capitalTiedUp", "idleCapital", "taxHeldAmount"]) {
  const parts = perOutlet.map((o) => value(o, key));
  const sum = parts.reduce((a, b) => a + b, 0);
  check(
    `${key}: the group total is the outlets added, not doubled`,
    near(value(overview, key), sum),
    `group ₹${value(overview, key).toFixed(2)} · ${parts.map((p) => p.toFixed(2)).join(" + ")} = ₹${sum.toFixed(2)}`,
  );
}

// ═════════════════════════════════════════════════════════════════════════
section("5. A narrower role never sees a wider number");

const advisor = await withWorkerScope(async () =>
  buildOverview({
    ownerId: OWNER,
    ownerShowroomIds: OUTLETS,
    visibleShowroomIds: [1],
    empCode: "AD-0417-04",
    role: "SERVICE_ADVISOR",
  }),
);

check(
  "the modules outside the role are named rather than counted as zero",
  advisor.scope.withheld.length > 0 &&
    advisor.scope.withheld.every((w) => w.reason.length > 0),
  advisor.scope.withheld.map((w) => w.module).join(", ") || "none withheld — expected several",
);

const advisorFigures = figures(advisor);
const RECEIVABLE_ONLY = ["overdue", "outstanding", "worstDaysOverdue"];
check(
  "no figure from a withheld module is present at all",
  !advisor.scope.withheld.some((w) => w.module === "RECEIVABLE") ||
    RECEIVABLE_ONLY.every((k) => !advisorFigures.has(k)),
  `ledger figures present: ${RECEIVABLE_ONLY.filter((k) => advisorFigures.has(k)).join(", ") || "none"}`,
);

const ownerFigures = figures(overview);
const wider: string[] = [];
for (const [key, f] of advisorFigures) {
  const owners = ownerFigures.get(key);
  // `mine` is the one figure that is legitimately larger for a member of staff
  // than for an owner, who has no employee code and therefore no own work.
  if (!owners || key === "mine") continue;
  if (f.value > owners.value + 0.011) wider.push(`${key}: ${f.value} > ${owners.value}`);
}
check(
  "no figure is larger for the advisor than for the owner",
  wider.length === 0,
  wider.join(" · ") || "every shared figure is less than or equal",
);

check(
  "the honest limit about scope is stated on the page",
  advisor.limits.some((l) => l.includes("outlet")) &&
    advisor.limits.some((l) => l.includes("modules")),
  advisor.limits.length + " limits stated",
);

// ═════════════════════════════════════════════════════════════════════════
section("6. The headline cites only what was computed");

/*
 * `citationsHold()` applied to a summary written by a rule rather than a model.
 *
 * The rule is not exempt because it is a rule: a sentence built from the wrong
 * figure is as wrong as one a model invented, and the failure is quieter
 * because nobody suspects a template. Every number in the headline has to be a
 * figure on the page.
 */
const onThePage = new Set<string>();
for (const f of ownerFigures.values()) {
  onThePage.add(String(f.value));
  onThePage.add(String(Math.round(f.value)));
  onThePage.add(Math.round(f.value).toLocaleString("en-IN"));
}

const uncited: string[] = [];
for (const sentence of overview.headline) {
  for (const n of sentence.match(/[\d,]*\d/g) ?? []) {
    if (!onThePage.has(n) && !onThePage.has(n.replace(/,/g, ""))) uncited.push(`"${n}" in: ${sentence}`);
  }
}
check(
  "every figure quoted in the headline is on the page",
  uncited.length === 0,
  uncited.join(" · ") || `${overview.headline.length} sentence(s), all cited`,
);
check(
  "at most three, because a summary of nine things has not summarised anything",
  overview.headline.length <= 3,
  `${overview.headline.length}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("7. Every figure opens the rows underneath it");

const SCREENS = new Set([
  "/queue",
  "/worklist",
  "/enquiries",
  "/service",
  "/registrations",
  "/spares",
  "/receivables",
  "/inventory",
  "/outbox",
  "/learned",
  "/invoices",
]);

const badHref = [...ownerFigures.values()].filter((f) => f.href !== null && !SCREENS.has(f.href));
check(
  "no figure points at a screen that does not exist",
  badHref.length === 0,
  badHref.map((f) => `${f.key} → ${f.href}`).join(" · ") || `${ownerFigures.size} figures checked`,
);

const noWay = [...ownerFigures.values()].filter((f) => f.href === null);
check(
  "a figure with no list behind it is the exception, not the rule",
  noWay.length <= 2,
  noWay.map((f) => f.key).join(", ") || "every figure is walkable",
);

// ═════════════════════════════════════════════════════════════════════════
section("8. It is a read, and it stored nothing");

const before = await withWorkerScope(async () => ({
  decisions: (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(decisionLogTable)
      .where(eq(decisionLogTable.ownerId, OWNER))
  )[0]?.n,
  events: (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recordEventsTable)
      .where(eq(recordEventsTable.ownerId, OWNER))
  )[0]?.n,
}));

const again = await withWorkerScope(asOwner);

const after = await withWorkerScope(async () => ({
  decisions: (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(decisionLogTable)
      .where(eq(decisionLogTable.ownerId, OWNER))
  )[0]?.n,
  events: (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recordEventsTable)
      .where(eq(recordEventsTable.ownerId, OWNER))
  )[0]?.n,
}));

check(
  "building the view wrote no decision and no event",
  before.decisions === after.decisions && before.events === after.events,
  `decisions ${before.decisions}→${after.decisions}, events ${before.events}→${after.events}`,
);

const drifted: string[] = [];
const againFigures = figures(again);
for (const [key, f] of ownerFigures) {
  const b = againFigures.get(key);
  if (!b || !near(b.value, f.value)) drifted.push(`${key}: ${f.value} → ${b?.value}`);
}
check(
  "two builds of the same mirror produce the same figures",
  drifted.length === 0,
  drifted.join(" · ") || `${ownerFigures.size} figures identical`,
);
check(
  "and each says when it was built",
  again.generatedAt !== overview.generatedAt,
  `${overview.generatedAt} then ${again.generatedAt}`,
);

// ═════════════════════════════════════════════════════════════════════════
section("9. The permission table is the only thing deciding what is folded");

const advisorModules = new Set(advisor.scope.modules);
const wrong = (["DEAL", "ENQUIRY", "JOB_CARD", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"] as AccessModule[]).filter(
  (m) => advisorModules.has(m) !== canRead("SERVICE_ADVISOR", m),
);
check(
  "the modules folded in are exactly the ones `canRead` allows",
  wrong.length === 0,
  wrong.join(", ") || `${advisorModules.size} of 7, and the table agrees on all seven`,
);

console.log(
  failures === 0
    ? "\nAll checks passed. The overall view knows nothing the module screens do not.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
