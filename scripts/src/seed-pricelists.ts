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

const OWNER = 1;

/**
 * The rates, and they are per model rather than one number in a settings
 * screen.
 *
 * A motorcycle above 350cc attracts a compensation cess the one below it does
 * not, and the HSN is a fact about the goods. A single rate would have been
 * tidier and wrong for part of the range — which is the same reason the columns
 * live on the price list item.
 */
function taxFor(model: string): { hsn: string; gst: string; cess: string } {
  const big = /(350|390|440|450|500|650|classic|meteor|himalayan|interceptor)/i.test(model);
  return { hsn: "87112019", gst: "28", cess: big ? "3" : "0" };
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
        gstRatePct: tax.gst,
        cessRatePct: tax.cess,
      });
      n++;
    }
    console.log(`  ${label.padEnd(24)} effective ${effectiveFrom}  ${n} models`);
  }

  console.log(
    "\nTwo lists, and the August one is current. A deal priced off July is a\n" +
      "commercial decision the dealer is entitled to make, and the document says so.\n",
  );
}

await main();
process.exit(0);
