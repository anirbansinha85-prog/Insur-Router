/**
 * Which price applied, and when that was true.
 *
 * The dealer's own system holds today's price and forgets yesterday's. That is
 * correct for a system whose job is to price today's sale and useless the
 * moment a dealer sells at an older rate — which happens, is lawful, and is his
 * decision alone.
 *
 * > *"He might want to sell at an old rate. It is legally not incorrect. Who am
 * > I to stop him — I have to give him the product which gives him the invoice."*
 *
 * So this file answers *which list applies* and, just as importantly, **whether
 * that was the current one**. A document priced off a superseded list is
 * perfectly proper and must say so; one that quietly used it would be the
 * product hiding the dealer's own commercial decision from the customer it was
 * made for.
 */

import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  priceListsTable,
  priceListItemsTable,
  type PriceListRow,
  type PriceListItemRow,
} from "@workspace/db";

export interface PricedModel {
  list: PriceListRow;
  item: PriceListItemRow;
  /** False when a newer list also covers this model on this date. */
  isCurrent: boolean;
  /** What the current list would have charged, when it is not this one. */
  currentAmount: number | null;
}

/** `numeric` comes back as a string, and treating it as a number silently is how precision goes. */
export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Every list that could price this model on this date, newest first.
 *
 * An outlet's own list outranks the group's — a clearance rate at one branch is
 * exactly the case that exists for — and within that, the later effective date
 * wins. Overlapping lists are deliberately not prevented by a constraint: an
 * OEM list and a dealer's scheme running against each other is the ordinary
 * situation, and which applies is a commercial choice rather than something a
 * unique index should be deciding.
 */
export async function listsFor(input: {
  ownerId: number;
  showroomId: number;
  modelDescription: string;
  onDate: string;
}): Promise<Array<{ list: PriceListRow; item: PriceListItemRow }>> {
  const rows = await db
    .select({ list: priceListsTable, item: priceListItemsTable })
    .from(priceListItemsTable)
    .innerJoin(priceListsTable, eq(priceListsTable.id, priceListItemsTable.priceListId))
    .where(
      and(
        eq(priceListsTable.ownerId, input.ownerId),
        or(
          isNull(priceListsTable.showroomId),
          eq(priceListsTable.showroomId, input.showroomId),
        ),
        lte(priceListsTable.effectiveFrom, input.onDate),
        eq(priceListItemsTable.modelDescription, input.modelDescription),
      ),
    )
    .orderBy(
      // The outlet's own list first, then the later effective date.
      desc(sql`case when ${priceListsTable.showroomId} is null then 0 else 1 end`),
      desc(priceListsTable.effectiveFrom),
      desc(priceListsTable.id),
    );

  return rows;
}

/**
 * The price, and whether it was the current one.
 *
 * `preferListId` is how a dealer says *use the July list*. Honouring it is the
 * whole point of the objective; the return value simply records that the choice
 * was made so the document can print it.
 */
export async function priceFor(input: {
  ownerId: number;
  showroomId: number;
  modelDescription: string;
  onDate: string;
  preferListId?: number | null;
}): Promise<PricedModel | null> {
  const candidates = await listsFor(input);
  if (candidates.length === 0) return null;

  const current = candidates[0]!;
  const chosen = input.preferListId
    ? (candidates.find((c) => c.list.id === input.preferListId) ?? null)
    : current;

  // A list the dealer named that does not cover this model is a refusal rather
  // than a silent fall back to the current one: he asked for a specific price
  // and getting a different one without being told is the failure this whole
  // file exists to prevent.
  if (!chosen) return null;

  const isCurrent = chosen.list.id === current.list.id;
  return {
    list: chosen.list,
    item: chosen.item,
    isCurrent,
    currentAmount: isCurrent ? null : money(current.item.exShowroomAmount),
  };
}

/**
 * The tax split, recorded as an answer rather than a rule.
 *
 * Intra-state is CGST and SGST in halves; inter-state is IGST alone. Which
 * applies is place of supply. The **document stores the amounts**, not the
 * rule, because a document reprinted next year has to show what was charged and
 * not what today's rule would charge — the same instinct as `record_events`
 * keeping the state it detected rather than re-deriving it.
 */
export function taxOn(input: {
  taxable: number;
  gstRatePct: number;
  cessRatePct: number;
  interState: boolean;
}): { cgst: number; sgst: number; igst: number; cess: number; total: number } {
  const gst = round2((input.taxable * input.gstRatePct) / 100);
  const cess = round2((input.taxable * input.cessRatePct) / 100);

  if (input.interState) {
    return { cgst: 0, sgst: 0, igst: gst, cess, total: round2(gst + cess) };
  }
  // Halved and then rounded, so the two halves always add back to the whole.
  // Rounding each half independently is how an invoice ends up a paisa short of
  // its own total.
  const half = round2(gst / 2);
  return { cgst: half, sgst: round2(gst - half), igst: 0, cess, total: round2(gst + cess) };
}
