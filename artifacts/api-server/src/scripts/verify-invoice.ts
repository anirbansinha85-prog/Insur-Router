/**
 * OBJ-25's done-when, issued rather than asserted.
 *
 * > *A dealer prices an invoice from a list that is no longer current and the
 * > document says so, the OEM claim is raised for the full scheme amount
 * > regardless of what was passed on, and the readiness row appears the moment
 * > the last condition is satisfied rather than when somebody opens a screen.*
 *
 * Three claims, and the third is the one that needed the journey runtime. A
 * derived row exists only while somebody is looking at it; a journey arriving
 * at `INVOICED` is a **timestamped record that the deal became ready**, written
 * by a scheduler pass with nobody signed in. That is the difference between a
 * screen that reports and a product that notices.
 *
 * ## And OBJ-30's, which is one sentence
 *
 * > *The same sale, issued twice — once from a mirrored deal and once from a
 * > form somebody typed — produces the same money.*
 *
 * That is R-96 stated in a way that can fail. It is not enough for the form
 * path to *work*; if it charged a rupee differently there would be two answers
 * to what a sale costs, which is the failure this whole product exists to fix,
 * arriving from inside. Section 11 issues both and compares every figure on the
 * two documents field by field.
 *
 * `pnpm run verify:invoice`.
 */

import {
  ownerDb,
  withWorkerScope,
  saleDocumentsTable,
  priceListsTable,
  priceListItemsTable,
  journeysTable,
  journeyStepsTable,
  dmsDealsTable,
} from "@workspace/db";
import { and, asc, eq, inArray, desc } from "drizzle-orm";
import {
  generateDocument,
  cancelDocument,
  readinessFor,
  unclaimedSchemes,
  priceFor,
  money,
  round2,
  taxOn,
  decideKind,
  financialYear,
  listDocuments,
  listPriceLists,
  factsFromMirror,
  doubtful,
  type SaleFacts,
} from "../lib/dms/invoice";
import { advanceJourneys, traceFor, journeyQueueRows, VEHICLE_SALE } from "../lib/dms/journeys";
import { buildQueue } from "../lib/dms/queue";
import { loadPolicy, setPolicy } from "../lib/dms/policy";
import { may, whyNot } from "../lib/dms/permissions";

const OWNER = 1;
const SHOWROOM = 1;
const ANIRBAN = { id: 1, name: "Anirban Sinha" };

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** Tidy on the CLI credential, exactly as OBJ-22 to OBJ-24 do. */
async function reset(): Promise<void> {
  await ownerDb.delete(saleDocumentsTable).where(eq(saleDocumentsTable.ownerId, OWNER));
  const sale = await ownerDb
    .select({ id: journeysTable.id })
    .from(journeysTable)
    .where(eq(journeysTable.definitionId, VEHICLE_SALE.id));
  if (sale.length > 0) {
    await ownerDb
      .delete(journeyStepsTable)
      .where(inArray(journeyStepsTable.journeyId, sale.map((j) => j.id)));
    await ownerDb.delete(journeysTable).where(inArray(journeysTable.id, sale.map((j) => j.id)));
  }
  await setPolicy(OWNER, SHOWROOM, ANIRBAN.id, "SWITCH.DDMS_HOLDS_TAX_SERIES", null);
}

await reset();

// ────────────────────────────────────────────────────────────────────────────

section("1. two lists, and the dealer may use either");

const lists = await ownerDb
  .select()
  .from(priceListsTable)
  .where(eq(priceListsTable.ownerId, OWNER))
  .orderBy(asc(priceListsTable.effectiveFrom));

check("the dealership has price history", lists.length >= 2, `${lists.length} lists — run db:seed-pricelists if not`);
const july = lists.find((l) => l.effectiveFrom < "2026-08-01");
const august = lists.find((l) => l.effectiveFrom >= "2026-08-01");
if (!july || !august) throw new Error("Expected a July and an August list. Run pnpm run db:seed-pricelists.");
console.log(`      ${july.name} (${july.effectiveFrom}) · ${august.name} (${august.effectiveFrom})`);

const deal = (
  await ownerDb
    .select()
    .from(dmsDealsTable)
    .where(and(eq(dmsDealsTable.showroomId, SHOWROOM), eq(dmsDealsTable.status, "BOOKED")))
    .limit(1)
)[0];
if (!deal) throw new Error("No BOOKED deal at showroom 1 to invoice.");

const onDate = "2026-08-10";
const currentPrice = await priceFor({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  modelDescription: deal.modelDescription!,
  onDate,
});
check("the current list is the August one", currentPrice?.list.id === august.id, currentPrice?.list.name);

/*
 * The count on the screen, checked against the count in the table.
 *
 * The first version of `listPriceLists` used a correlated subquery through the
 * ORM's SQL template and silently returned **1** for every list — not an error,
 * not an empty result, a plausible wrong number. Nothing in the product would
 * have failed; a dealership would simply have been told its price list had one
 * model in it.
 */
const shown = await listPriceLists(OWNER, SHOWROOM);
const counted = await ownerDb
  .select({ id: priceListItemsTable.priceListId })
  .from(priceListItemsTable);
const perList = new Map<number, number>();
for (const r of counted) perList.set(r.id, (perList.get(r.id) ?? 0) + 1);
check(
  "the model count each list reports is the number it holds",
  shown.every((l) => l.models === (perList.get(l.id) ?? 0)),
  shown.map((l) => `${l.name}: says ${l.models}, holds ${perList.get(l.id) ?? 0}`).join(" · "),
);

// ────────────────────────────────────────────────────────────────────────────

section("2. an invoice priced off a list that is no longer current");

const policy = await loadPolicy(OWNER);

const off = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  dealerCode: deal.dealerCode,
  dealId: deal.dealId,
  intent: "SALE",
  // The dealer's choice, and the objective in one field.
  priceListId: july.id,
  dealerDiscount: 2_000,
  oemSchemeAmount: 5_000,
  // He keeps the manufacturer's scheme. His decision, and lawful.
  oemSchemePassedOn: 0,
  otherCharges: [{ label: "Insurance", amount: 4_200 }, { label: "Registration", amount: 1_800 }],
  onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy,
});

if (!off.ok) throw new Error(`generate refused: ${off.error}`);
const doc = off.document;

console.log(
  `      ${doc.reference}  ${doc.kind}\n` +
    `      ${doc.modelDescription} · ${doc.customerName}\n` +
    `      ex-showroom ${rupees(money(doc.exShowroomAmount))} per ${doc.priceListName} (${doc.priceListEffectiveFrom})\n` +
    `      less dealer discount ${rupees(money(doc.dealerDiscount))}\n` +
    `      taxable ${rupees(money(doc.taxableAmount))} · CGST ${rupees(money(doc.cgstAmount))} + SGST ${rupees(money(doc.sgstAmount))}` +
    (money(doc.cessAmount) ? ` + cess ${rupees(money(doc.cessAmount))}` : "") +
    `\n      other charges ${rupees(money(doc.otherChargesTotal))}\n` +
    `      total ${rupees(money(doc.totalAmount))}`,
);

check(
  "it was priced off July, as asked",
  doc.priceListId === july.id && doc.priceListEffectiveFrom === july.effectiveFrom,
);
check(
  "**and the document says it was not the current list**",
  doc.pricedOffCurrentList === "N",
);
check(
  "with the reason surfaced to whoever issued it",
  off.warnings.some((w) => w.includes("not the current list")),
  off.warnings.find((w) => w.includes("not the current list")) ?? "no warning",
);
check(
  "the July price is genuinely lower than today's",
  money(doc.exShowroomAmount) < money(currentPrice!.item.exShowroomAmount),
  `${rupees(money(doc.exShowroomAmount))} against ${rupees(money(currentPrice!.item.exShowroomAmount))}`,
);

// ────────────────────────────────────────────────────────────────────────────

section("3. the tax split, and the halves that add back up");

const expected = taxOn({
  taxable: money(doc.taxableAmount),
  gstRatePct: money(doc.gstRatePct),
  cessRatePct: money(doc.cessRatePct),
  interState: false,
});
check(
  "CGST and SGST are halves of one whole, to the paisa",
  money(doc.cgstAmount) + money(doc.sgstAmount) === expected.cgst + expected.sgst,
  `${money(doc.cgstAmount)} + ${money(doc.sgstAmount)}`,
);
check("intra-state, so no IGST", money(doc.igstAmount) === 0);
check(
  "the total adds up",
  Math.abs(
    money(doc.taxableAmount) +
      money(doc.cgstAmount) +
      money(doc.sgstAmount) +
      money(doc.cessAmount) +
      money(doc.otherChargesTotal) -
      money(doc.totalAmount),
  ) < 0.01,
);

// ────────────────────────────────────────────────────────────────────────────

section("4. the claim is owed on the whole scheme, whatever was passed on");

const claims = await unclaimedSchemes(OWNER, [SHOWROOM]);
const mine = claims.documents.find((d) => d.reference === doc.reference)!;
console.log(
  `      ${mine.reference}: scheme ${rupees(mine.schemeAmount)} · passed on ${rupees(mine.passedOn)} · retained ${rupees(mine.retained)}`,
);
check("the full scheme is claimable", mine.schemeAmount === 5_000);
check("even though none of it reached the customer", mine.passedOn === 0);
check(
  "and the taxable value only fell by what the customer was actually given",
  money(doc.taxableAmount) === money(doc.exShowroomAmount) - 2_000,
  "the scheme he kept never reaches that line, because the customer never got it",
);
console.log(`      across the outlet: ${rupees(claims.totalClaimable)} claimable, ${rupees(claims.totalRetained)} retained`);

// ────────────────────────────────────────────────────────────────────────────

section("5. only one system holds the series, and the document says which");

check(
  "off by default, so ours is a sale confirmation",
  doc.kind === "SALE_CONFIRMATION" && doc.taxInvoiceNo === null,
  `${doc.kind}, reference ${doc.reference}`,
);
const offKind = decideKind("SALE", policy);
console.log(`      titled "${offKind.title}" — ${offKind.disclaimer}`);
check("and it carries the DMS's number for linkage", doc.dmsInvoiceNo === deal.invoiceNo);
check(
  "a quotation is never a tax invoice, whoever holds the series",
  decideKind("QUOTATION", policy).kind === "QUOTATION",
);

await setPolicy(OWNER, SHOWROOM, ANIRBAN.id, "SWITCH.DDMS_HOLDS_TAX_SERIES", 1);
const withSeries = await loadPolicy(OWNER);
const onKind = decideKind("SALE", withSeries);
check("switched on, ours is the tax invoice", onKind.kind === "TAX_INVOICE" && onKind.disclaimer === null);

const second = (
  await ownerDb
    .select()
    .from(dmsDealsTable)
    .where(and(eq(dmsDealsTable.showroomId, SHOWROOM), eq(dmsDealsTable.status, "BOOKED")))
    .limit(3)
)[1];
if (second) {
  const taxDoc = await generateDocument({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    dealerCode: second.dealerCode,
    dealId: second.dealId,
    intent: "SALE",
    onDate,
    userId: ANIRBAN.id,
    userName: ANIRBAN.name,
    principal: "OWNER",
    policy: withSeries,
  });
  if (!taxDoc.ok) throw new Error(`tax invoice refused: ${taxDoc.error}`);
  console.log(`      ${taxDoc.document.taxInvoiceNo}  (${taxDoc.document.kind})`);
  check(
    "it drew a number from the sequential series",
    taxDoc.document.taxInvoiceNo === `INV/${financialYear(onDate)}/00001`,
    taxDoc.document.taxInvoiceNo ?? "none",
  );
  check("the financial year is April to March", financialYear("2026-03-31") === "2526" && financialYear("2026-04-01") === "2627");
}

// ────────────────────────────────────────────────────────────────────────────

section("6. issued once, cancelled rather than deleted");

const again = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  dealerCode: deal.dealerCode,
  dealId: deal.dealId,
  intent: "SALE",
  onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: withSeries,
});
check("a second document for the same deal is refused", !again.ok, again.ok ? "ALLOWED" : again.error);

const quote = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  dealerCode: deal.dealerCode,
  dealId: deal.dealId,
  intent: "QUOTATION",
  onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: withSeries,
});
check(
  "but a quotation is not — a dealership may quote the same customer five times",
  quote.ok,
  quote.ok ? `${quote.document.reference} ${quote.document.kind}` : quote.error,
);

/*
 * And the other way round: a quotation must not block the sale.
 *
 * The comment in `generate.ts` always said so and the query did not agree with
 * it — any issued document blocked, so a salesman quoting a customer in the
 * morning made the deal un-invoiceable for the rest of the day. Found by doing
 * exactly that through the API.
 */
const thirdDeal = (
  await ownerDb
    .select()
    .from(dmsDealsTable)
    .where(and(eq(dmsDealsTable.showroomId, SHOWROOM), eq(dmsDealsTable.status, "BOOKED")))
    .limit(4)
)[2];
if (thirdDeal) {
  const q = await generateDocument({
    ownerId: OWNER, showroomId: SHOWROOM, dealerCode: thirdDeal.dealerCode, dealId: thirdDeal.dealId,
    intent: "QUOTATION", onDate, userId: ANIRBAN.id, userName: ANIRBAN.name, principal: "OWNER", policy: withSeries,
  });
  const sale = await generateDocument({
    ownerId: OWNER, showroomId: SHOWROOM, dealerCode: thirdDeal.dealerCode, dealId: thirdDeal.dealId,
    intent: "SALE", onDate, userId: ANIRBAN.id, userName: ANIRBAN.name, principal: "OWNER", policy: withSeries,
  });
  check(
    "a quotation does not block the sale that follows it",
    q.ok && sale.ok,
    sale.ok ? `${q.ok ? q.document.reference : "?"} then ${sale.document.reference}` : sale.error,
  );
}

const cancelled = await cancelDocument({
  ownerId: OWNER,
  id: doc.id,
  reason: "Customer changed the variant.",
  principal: "OWNER",
});
check("cancelling needs a reason", !(await cancelDocument({ ownerId: OWNER, id: doc.id, reason: "  ", principal: "OWNER" })).ok);
check("and the row stays, with the number spent", cancelled.ok && cancelled.document.status === "CANCELLED");

// ────────────────────────────────────────────────────────────────────────────

section("7. who may put a price on a piece of paper");

check("an owner may", may("OWNER", "invoice.generate"));
check("accounts may", may("ACCOUNTS", "invoice.generate"));
check("a technician may not", !may("TECHNICIAN", "invoice.generate"));
check("**the agent may not**", !may("AGENT", "invoice.generate"));
console.log(`      ${whyNot("AGENT", "invoice.generate")}`);

/*
 * And the refusal has to name the right reason.
 *
 * `whyNot` returned the `policy.set` sentence for every permission belonging to
 * no module, with a comment saying that was the only one. OBJ-25 added three
 * more, so a service advisor asking to read an invoice was told they may not
 * set the dealership's thresholds — true of them, and not the question they
 * asked. Same defect OBJ-21 fixed on `POST /dms/actions`, from the other side.
 */
const advisorOnInvoice = whyNot("SERVICE_ADVISOR", "invoice.view");
console.log(`      SERVICE_ADVISOR -> invoice.view
      ${advisorOnInvoice}`);
check(
  "the refusal is about invoices, not about the dealership's numbers",
  !advisorOnInvoice.includes("sets these") && advisorOnInvoice.toLowerCase().includes("customer paid"),
  advisorOnInvoice,
);
check(
  "and policy.set still says its own thing",
  whyNot("SERVICE_ADVISOR", "policy.set").includes("sets these"),
);

const byAgent = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  dealerCode: deal.dealerCode,
  dealId: deal.dealId,
  intent: "SALE",
  onDate,
  userId: 0,
  userName: null,
  principal: "AGENT",
  policy: withSeries,
});
check("and is refused by the same table that refuses a technician", !byAgent.ok && byAgent.status === 403);

// ────────────────────────────────────────────────────────────────────────────

section("8. the readiness row, produced by the runtime rather than a screen");

await withWorkerScope(async () => {
  const p = await loadPolicy(OWNER);
  const moved = await advanceJourneys({
    ownerId: OWNER,
    showroomIds: [SHOWROOM, 2],
    policy: p,
    only: VEHICLE_SALE.id,
  });
  console.log(
    `      ${moved.started} sale journeys opened · ${moved.finished} already finished · ${moved.live} still going`,
  );
  check("the second journey runs on the same runtime, unchanged", moved.started > 0);

  const rows = await journeyQueueRows({ ownerId: OWNER, showroomIds: [SHOWROOM, 2], policy: p });
  const sale = rows.filter((r) => r.definitionId === VEHICLE_SALE.id);
  const opportunities = sale.filter((r) => r.tone === "OPPORTUNITY");

  const steps = new Map<string, number>();
  for (const r of sale) steps.set(r.stepId, (steps.get(r.stepId) ?? 0) + 1);
  console.log(`      ${sale.length} rows from the sale journey:`);
  for (const [step, n] of [...steps.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`        ${String(n).padStart(3)}  ${step}`);
  }

  check(
    "**at least one is an opportunity rather than a problem**",
    opportunities.length > 0,
    `${opportunities.length} deals ready to invoice`,
  );
  const example = opportunities[0];
  if (example) {
    console.log(`      "${example.title}" — ${example.why}`);
    console.log(`      → ${example.todo}`);
  }
  check(
    "every problem row is still a problem",
    sale.filter((r) => r.stepId !== "INVOICED").every((r) => r.tone === "PROBLEM"),
  );

  /*
   * The claim the done-when actually makes.
   *
   * A derived queue row exists only while somebody is looking at it. A journey
   * arriving at `INVOICED` is a row in `journey_steps` with a timestamp on it,
   * written by a scheduler pass with nobody signed in — so *when did this
   * become ready* is answerable afterwards, which is the whole difference
   * between a screen that reports and a product that notices.
   */
  if (example) {
    const trace = await traceFor("DEAL", example.subjectKey, p);
    const arrival = trace?.arrivals[trace.arrivals.length - 1];
    check(
      "and the moment it became ready is written down",
      Boolean(arrival) && trace?.standingOn === "INVOICED",
      `${trace?.subjectKey} reached ${trace?.standingOn} at ${arrival?.occurredAt}, with nobody signed in`,
    );
    check("the trace says which map", trace?.definitionId === VEHICLE_SALE.id, trace?.title);
  }

  const unpriced = sale.filter((r) => r.stepId === "PRICEABLE");
  console.log(
    unpriced.length > 0
      ? `      ${unpriced.length} deals cannot be invoiced at all: ${unpriced[0]!.why}`
      : "      every model on a live sale is covered by a price list",
  );
});

section("9. it reaches the one queue, sorted with everything else");

const queue = await buildQueue({
  ownerId: OWNER,
  ownerShowroomIds: [SHOWROOM, 2],
  visibleShowroomIds: [SHOWROOM, 2],
  empCode: null,
  role: "OWNER",
  policy: await loadPolicy(OWNER),
});

const opp = queue.items.filter((i) => i.tone === "OPPORTUNITY");
const dealJourney = queue.items.filter((i) => i.journey?.definitionId === VEHICLE_SALE.id);
console.log(
  `      ${queue.total} on the queue — ${dealJourney.length} from the sale journey, ${opp.length} of them opportunities`,
);
check("opportunities are on the one queue", opp.length > 0);
check(
  "and they are sorted among the problems rather than pinned anywhere",
  opp.some((o) => queue.items.indexOf(o) > 0 && queue.items.indexOf(o) < queue.items.length - 1),
);
check("every other row is still a problem", queue.items.filter((i) => i.source !== "JOURNEY").every((i) => i.tone === "PROBLEM"));

const first = opp[0];
if (first) {
  console.log(
    `      sev${first.severity} ${first.band} · ${first.journey?.stepTitle} · step ${first.journey?.completed}/${first.journey?.total}`,
  );
  console.log(`        ${first.actionRequired}`);
}

section("10. what has been issued");

const documents = await listDocuments(OWNER, SHOWROOM);
for (const d of documents) {
  console.log(
    `      ${d.reference.padEnd(16)} ${d.kind.padEnd(18)} ${(d.taxInvoiceNo ?? "—").padEnd(18)} ` +
      `${rupees(money(d.totalAmount)).padStart(12)}  ${d.status}`,
  );
}
check("each is answerable for", documents.every((d) => d.issuedByName === ANIRBAN.name));

section("11. the same sale, twice, from two different doors (OBJ-30, R-96)");

/*
 * The whole claim in one comparison.
 *
 * A mirrored deal is read, then the *same facts* are retyped as though a
 * sub-dealer with no manufacturer's system had entered them by hand — same
 * customer, same model, same frame, same discount, same scheme. Two documents
 * come out and every figure on them has to match.
 *
 * The two are deliberately not issued for the same subject: the sold-this-twice
 * check would refuse the second, and correctly. The typed one is given its own
 * chassis, which is the only field allowed to differ.
 */
const donor = await ownerDb
  .select()
  .from(dmsDealsTable)
  .where(eq(dmsDealsTable.showroomId, SHOWROOM))
  .limit(400);

/*
 * The dealer code comes off the deal rather than being written in here.
 *
 * The first version had `HERO-SARASWATI-01` in the query, which is a plausible
 * dealer code and is not this dealership's — the seed issues `HMC-DL-0417`. It
 * returned no rows and the section reported *none priceable*, which reads like
 * a finding about price lists rather than a typo in a filter. A verifier that
 * can fail for a reason it does not name is a verifier that will one day pass
 * for a reason it does not name either.
 */
let subject: { dealerCode: string; dealId: string; model: string } | undefined;
for (const d of donor) {
  if (!d.modelDescription || !d.chassisNo) continue;
  const p = await priceFor({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    modelDescription: d.modelDescription,
    onDate,
  });
  if (!p) continue;
  subject = { dealerCode: d.dealerCode, dealId: d.dealId, model: d.modelDescription };
  break;
}
check("a mirrored deal to compare against", Boolean(subject), subject ? `${subject.dealerCode}/${subject.dealId} — ${subject.model}` : "no deal at this outlet is covered by a price list");

if (subject) {
  const mirrored = await factsFromMirror({ dealerCode: subject.dealerCode, dealId: subject.dealId });
  check("its facts resolve from the mirror", mirrored.ok);

  if (mirrored.ok) {
    const f = mirrored.facts;
    check("and they say so", f.origin === "MIRROR" && f.dealerCode === subject.dealerCode);

    const AGREED = { dealerDiscount: 3000, oemSchemeAmount: 2500, oemSchemePassedOn: 1000 };

    const fromMirror = await generateDocument({
      ownerId: OWNER,
      showroomId: SHOWROOM,
      dealerCode: subject.dealerCode,
      dealId: subject.dealId,
      intent: "SALE",
      ...AGREED,
      onDate: onDate,
      userId: ANIRBAN.id,
      userName: ANIRBAN.name,
      principal: "OWNER",
      policy: await loadPolicy(OWNER),
    });
    check("the mirror path issues", fromMirror.ok, fromMirror.ok ? fromMirror.document.reference : fromMirror.error);

    /*
     * The sub-dealer's version of the same sale. No dealer code, no deal row,
     * nothing in `dms_deals` this could have been read from — which is the
     * point, and is why the chassis is invented rather than borrowed.
     */
    const TYPED_CHASSIS = "MBLHAR0ANP9Z99001";
    const fromForm = await generateDocument({
      ownerId: OWNER,
      showroomId: SHOWROOM,
      sale: {
        showroomId: SHOWROOM,
        customerName: f.customerName,
        customerMobile: f.customerMobile,
        customerAddress: "14 Bidhan Sarani, Agartala",
        customerGstin: null,
        modelDescription: f.modelDescription,
        chassisNo: TYPED_CHASSIS,
        engineNo: "HA11EN9Z99001",
      },
      intent: "SALE",
      ...AGREED,
      onDate: onDate,
      userId: ANIRBAN.id,
      userName: ANIRBAN.name,
      principal: "OWNER",
      policy: await loadPolicy(OWNER),
    });
    check(
      "a dealership with no manufacturer's system issues the same sale",
      fromForm.ok,
      fromForm.ok ? fromForm.document.reference : fromForm.error,
    );

    if (fromMirror.ok && fromForm.ok) {
      const a = fromMirror.document;
      const b = fromForm.document;

      // Every figure that is money or tax. Not a sample — the whole set, because
      // a comparison that skips a column is a comparison that will pass while
      // that column is wrong.
      const MONEY = [
        "exShowroomAmount",
        "dealerDiscount",
        "oemSchemeAmount",
        "oemSchemePassedOn",
        "taxableAmount",
        "gstRatePct",
        "cessRatePct",
        "cgstAmount",
        "sgstAmount",
        "igstAmount",
        "cessAmount",
        "otherChargesTotal",
        "totalAmount",
      ] as const;

      const differing = MONEY.filter(
        (k) => money(a[k] as string) !== money(b[k] as string),
      );
      check(
        "every figure on the two documents is identical",
        differing.length === 0,
        differing.length === 0
          ? `${MONEY.length} fields compared — ${rupees(money(a.totalAmount))} either way`
          : `differ on ${differing.join(", ")}`,
      );

      check(
        "the tax split too",
        money(a.cgstAmount) === money(b.cgstAmount) && money(a.sgstAmount) === money(b.sgstAmount),
        `CGST ${rupees(money(a.cgstAmount))} + SGST ${rupees(money(a.sgstAmount))}`,
      );

      // And the only things that should differ, do.
      check("the documents say where their facts came from", a.factsOrigin === "MIRROR" && b.factsOrigin === "FORM");
      check("a sub-dealer's document carries no dealer code", b.dealerCode === null, `dealId is the chassis: ${b.dealId}`);
      check("and the mirror's does", a.dealerCode === subject.dealerCode);
      check("both were priced off a list", a.priceOrigin === "LIST" && b.priceOrigin === "LIST", a.priceListName ?? "");
      check("the typed one kept the address the mirror never had", b.customerAddress !== null && a.customerAddress === null);

      // The sold-this-twice check, on the path where `dealer_code` is null —
      // the one place a careless equality would have let the same frame be
      // invoiced twice while looking like it was checking.
      const again = await generateDocument({
        ownerId: OWNER,
        showroomId: SHOWROOM,
        sale: { showroomId: SHOWROOM, modelDescription: f.modelDescription, chassisNo: TYPED_CHASSIS },
        intent: "SALE",
        onDate: onDate,
        userId: ANIRBAN.id,
        userName: ANIRBAN.name,
        principal: "OWNER",
        policy: await loadPolicy(OWNER),
      });
      check(
        "the same frame cannot be invoiced twice without a dealer code",
        !again.ok && again.status === 409,
        again.ok ? "IT ISSUED A SECOND ONE" : again.error,
      );
    }
  }
}

section("12. a dealership with no price list at all");

/*
 * The customer OBJ-30 exists for, in full: no DMS, no mirror, no deal row and
 * no price list either. Everything on the document is something a person typed
 * while the customer stood there — which under R-97 is a *confirmed* figure,
 * and is why it is allowed onto a tax invoice at all.
 */
const NOVEL = "TVS Jupiter 110 Sub-Dealer Stock";
const noList = await priceFor({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  modelDescription: NOVEL,
  onDate: onDate,
});
check("no list covers this model", noList === null, NOVEL);

const refused = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  sale: { showroomId: SHOWROOM, modelDescription: NOVEL, chassisNo: "MD626BG0ANP111222" },
  intent: "SALE",
  onDate: onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: await loadPolicy(OWNER),
});
check(
  "and the refusal says what to do about it",
  !refused.ok && refused.status === 400 && refused.error.includes("Enter the price on the document"),
  refused.ok ? "it issued" : refused.error,
);

const stated = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  sale: {
    showroomId: SHOWROOM,
    customerName: "Sujit Debbarma",
    customerMobile: "9856012345",
    customerAddress: "Ramnagar Road No. 4, Agartala, Tripura",
    modelDescription: NOVEL,
    chassisNo: "MD626BG0ANP111222",
    engineNo: "BG0AN111222",
  },
  statedPrice: { exShowroomAmount: 79_500, hsn: "8711", gstRatePct: 28, cessRatePct: 0 },
  intent: "SALE",
  otherCharges: [
    { label: "Insurance (1+5)", amount: 6_240 },
    { label: "Registration and road tax", amount: 5_120 },
  ],
  onDate: onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: await loadPolicy(OWNER),
});

check("it issues on a stated price", stated.ok, stated.ok ? stated.document.reference : stated.error);
if (stated.ok) {
  const d = stated.document;
  const gst = round2(79_500 * 0.28);
  check("the document says the price was stated, not looked up", d.priceOrigin === "STATED" && d.priceListName === null);
  check("the arithmetic is the same arithmetic", money(d.taxableAmount) === 79_500 && money(d.cgstAmount) + money(d.sgstAmount) === gst,
    `${rupees(79_500)} + ${rupees(gst)} GST`);
  check(
    "and the pass-throughs are on it but not taxed",
    money(d.otherChargesTotal) === 11_360 && money(d.totalAmount) === round2(79_500 + gst + 11_360),
    `total ${rupees(money(d.totalAmount))}`,
  );
  console.log(`      ${d.reference} — ${d.customerName}, ${d.chassisNo}, no DMS anywhere near it`);
}

section("13. a model's read may not reach a tax invoice (R-97)");

/*
 * The gate, exercised on facts rather than on a database row, because the claim
 * is about what `generateDocument` refuses and not about how a deal got its
 * confidence map. A scanned invoice reaching 55% on the chassis number is
 * exactly VeloDocs' below-threshold case (OBJ-24, R-85).
 */
const scanned: SaleFacts = {
  origin: "MIRROR",
  showroomId: SHOWROOM,
  dealerCode: subject?.dealerCode ?? "HMC-DL-0417",
  dealId: "SCAN-OBJ30-01",
  customerName: "Renu Prasad",
  customerMobile: "9811122233",
  customerAddress: null,
  customerGstin: null,
  modelDescription: subject?.model ?? "Hero HF Deluxe",
  chassisNo: "MBLHAR0ANP9Z55555",
  engineNo: "HA11EN9Z55555",
  dmsInvoiceNo: null,
  ingestPath: "DOCUMENT",
  confidence: { chassisNo: 0.55, customerName: 0.62, customerMobile: 0.4 },
};

const named = doubtful(scanned);
check(
  "two fields on the document are proposals, and the mobile is not one of them",
  named.length === 2 && named.every((n) => n.field !== "customerMobile"),
  named.map((n) => `${n.field} ${Math.round(n.confidence * 100)}%`).join(", "),
);

const blocked = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  facts: scanned,
  intent: "SALE",
  onDate: onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: await loadPolicy(OWNER),
});
check(
  "the invoice is refused, and the refusal names them",
  !blocked.ok && blocked.status === 400 && blocked.error.includes("chassisNo (55%)"),
  blocked.ok ? "IT ISSUED" : blocked.error,
);

const quoted = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  facts: scanned,
  /*
   * Priced on the document, so that pricing cannot be what refuses.
   *
   * This section is about the R-97 gate and nothing else. The first version
   * left the quotation to find a price list, the seeded model was not on one,
   * and the check failed with *no price list covers this* — a true sentence
   * about the wrong subject. A test that can fail for a reason other than its
   * claim is not testing its claim.
   */
  statedPrice: { exShowroomAmount: 64_790 },
  intent: "QUOTATION",
  onDate: onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: await loadPolicy(OWNER),
});
check(
  "the same read is fine on a quotation, and says so",
  quoted.ok && quoted.warnings.some((w) => w.includes("Not yet confirmed")),
  quoted.ok ? quoted.warnings.join(" | ") : quoted.error,
);
console.log("      the gate is on the consequence, not on the provenance");

section("14. both shapes at once is two sales, and is refused");

const both = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  dealerCode: subject?.dealerCode ?? "HMC-DL-0417",
  dealId: subject?.dealId ?? "DEAL-1",
  sale: { showroomId: SHOWROOM, modelDescription: "Hero HF Deluxe", chassisNo: "MBLHAR0ANP9Z77777" },
  intent: "SALE",
  onDate: onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: await loadPolicy(OWNER),
});
check("two sales described at once", !both.ok && both.status === 400, both.ok ? "it picked one" : both.error);

const neither = await generateDocument({
  ownerId: OWNER,
  showroomId: SHOWROOM,
  intent: "SALE",
  onDate: onDate,
  userId: ANIRBAN.id,
  userName: ANIRBAN.name,
  principal: "OWNER",
  policy: await loadPolicy(OWNER),
});
check("and none at all", !neither.ok && neither.status === 400, neither.ok ? "it invented one" : neither.error);

await reset();
console.log("  (documents, sale journeys and the series switch reset, on the CLI credential)");

console.log(
  failures === 0
    ? "\nAll checks passed. The dealer's price, the dealer's discount, a document that says what it is —\nand a dealership with no manufacturer's system behind it gets the same one.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
