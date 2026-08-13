/**
 * Two price lists, and the second one is why this objective exists.
 *
 * A dealership bootstraps its price list from what it has been selling at,
 * which is exactly what this does: every model in the deal mirror, at the
 * ex-showroom amount the OEM's system carries. That is the **July** list.
 *
 * Then an **August** list, four per cent higher, because the manufacturer put
 * prices up — and now the interesting thing is possible. A dealer may still
 * price a sale off July: a customer who booked before the rise, ageing stock he
 * wants moved, a promise somebody made. All three are lawful and all three are
 * his decision.
 *
 * > *"He might want to sell at an old rate. It is legally not incorrect."*
 *
 * The product's job is to let him, and to print which list he used.
 *
 * `pnpm run db:seed-pricelists`. Idempotent — it clears its own two lists and
 * rewrites them, so reseeding the mirror and rerunning this stays consistent.
 */

import {
  ownerDb,
  dmsDealsTable,
  priceListsTable,
  priceListItemsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { rateFor, type Propulsion } from "@workspace/quoting/tax";

const OWNER = 1;

/**
 * What each machine in the mirror actually is.
 *
 * **The deal mirror does not carry engine capacity**, and that is a fact about
 * the OEM's export rather than an oversight here: it records what was sold and
 * for how much, not what the machine displaces. So a dealer bootstrapping a
 * price list out of his own sales history has the prices and not the capacities,
 * which is exactly why `engine_cc` is nullable and why a missing one defaults to
 * 18% — the band nearly every two-wheeler sits in.
 *
 * This map is the fixture supplying what the mirror cannot, and it matches the
 * mock OEM catalogue in `artifacts/dms-mock/src/catalogue.ts`. Anything absent
 * from it seeds with a null capacity and takes the default, which is the same
 * thing that happens to a real dealer with a model he has not filled in.
 */
const CAPACITY: Record<string, { engineCc: number | null; propulsion: Propulsion }> = {
  "Splendor Plus": { engineCc: 97, propulsion: "PETROL" },
  "HF Deluxe": { engineCc: 97, propulsion: "PETROL" },
  "Xtreme 125R": { engineCc: 125, propulsion: "PETROL" },
  "Destini 125": { engineCc: 125, propulsion: "PETROL" },
  "Xpulse 200 4V": { engineCc: 200, propulsion: "PETROL" },
  "Vida V2 Plus": { engineCc: null, propulsion: "ELECTRIC" },
};

/**
 * The classification and the rates, which come from what the machine is (R-121).
 *
 * This used to match on the model **name** — `/(350|390|...|classic|meteor)/`
 * — and it was wrong in a way worth recording, because the same mistake is
 * available to anybody who writes this in a hurry. A Classic 350 is *exactly*
 * 350cc, the law says *exceeding* 350cc, so it belongs in the **lower** band and
 * the regex put it in the upper one. Under the old rates that was a cess charged
 * where none was due; under the new ones it is 40% charged where 18% is due, on
 * a bike that sells in volume.
 *
 * So capacity is the input, `rateFor` is the one table, and there is no second
 * copy of the slabs in this file to drift away from it.
 *
 * The HSN stays `87112019` for every model here — all six are under 350cc or
 * electric — and it is deliberately *not* what the rate is read from, since
 * `8711 30` spans the boundary.
 */
function taxFor(model: string): {
  hsn: string;
  gst: string;
  cess: string;
  engineCc: number | null;
  propulsion: Propulsion;
} {
  const spec = CAPACITY[model] ?? { engineCc: null, propulsion: "PETROL" as Propulsion };
  const rate = rateFor(spec);
  return {
    hsn: "87112019",
    gst: String(rate.gstRatePct),
    cess: String(rate.cessRatePct),
    engineCc: spec.engineCc,
    propulsion: spec.propulsion,
  };
}

const JULY = "2026-07-01";
const AUGUST = "2026-08-01";

async function main(): Promise<void> {
  const deals = await ownerDb
    .select({
      model: dmsDealsTable.modelDescription,
      amount: dmsDealsTable.exShowroomAmount,
    })
    .from(dmsDealsTable);

  /*
   * One price per model, and the *highest* seen rather than the average.
   *
   * A deal's `exShowroomAmount` is what that customer was charged, which may
   * already carry a discount. Taking the maximum recovers something close to
   * list; taking a mean would bake every discount ever given into the list
   * price and then the invoice would discount it again.
   */
  const byModel = new Map<string, number>();
  for (const d of deals) {
    if (!d.model || !d.amount) continue;
    byModel.set(d.model, Math.max(byModel.get(d.model) ?? 0, d.amount));
  }

  if (byModel.size === 0) {
    console.log("No models in the deal mirror. Sync a showroom first.");
    return;
  }

  // Clear our own two and rewrite, so this is safe to run twice.
  const existing = await ownerDb
    .select({ id: priceListsTable.id, name: priceListsTable.name })
    .from(priceListsTable)
    .where(eq(priceListsTable.ownerId, OWNER));
  const ours = existing.filter((l) => l.name.startsWith("Hero list "));
  if (ours.length > 0) {
    await ownerDb.delete(priceListItemsTable).where(
      inArray(priceListItemsTable.priceListId, ours.map((l) => l.id)),
    );
    await ownerDb.delete(priceListsTable).where(inArray(priceListsTable.id, ours.map((l) => l.id)));
  }

  for (const [label, effectiveFrom, multiplier] of [
    ["Hero list July 2026", JULY, 1],
    ["Hero list August 2026", AUGUST, 1.04],
  ] as const) {
    const [list] = await ownerDb
      .insert(priceListsTable)
      .values({
        ownerId: OWNER,
        showroomId: null,
        name: label,
        source: "OEM",
        effectiveFrom,
        ingestPath: "MANUAL",
        createdByName: "Seed",
      })
      .returning();

    let n = 0;
    for (const [model, amount] of byModel) {
      const tax = taxFor(model);
      await ownerDb.insert(priceListItemsTable).values({
        priceListId: list!.id,
        ownerId: OWNER,
        modelDescription: model,
        // Rounded to the nearest ten rupees, which is how a price list reads.
        exShowroomAmount: String(Math.round((amount * multiplier) / 10) * 10),
        hsn: tax.hsn,
        engineCc: tax.engineCc,
        propulsion: tax.propulsion,
        gstRatePct: tax.gst,
        cessRatePct: tax.cess,
      });
      n++;
    }
    console.log(`  ${label.padEnd(24)} effective ${effectiveFrom}  ${n} models`);
  }

  console.log(
    "\nTwo lists, and the August one is current. A deal priced off July is a\n" +
      "commercial decision the dealer is entitled to make, and the document says so.\n" +
      "\nEvery amount is ex-showroom and therefore includes GST (R-122): the\n" +
      "invoice back-calculates the taxable value out of it rather than adding tax\n" +
      "on top, so a bike listed at 84,000 invoices at 84,000.\n",
  );
}

await main();
process.exit(0);
