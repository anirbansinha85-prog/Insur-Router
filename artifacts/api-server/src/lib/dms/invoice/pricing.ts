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

/**
 * The figures the document charges on, however they were arrived at (OBJ-30).
 *
 * `priceFor` above answers *what does the list say*, which presumes a list. A
 * dealership selling five units a month has not built one yet, and telling him
 * to enter his whole range before he can raise his first invoice is how a
 * product gets uninstalled on the first afternoon.
 *
 * So a price may also be **stated**: the amount, the HSN and the rates typed
 * onto this one document by the person raising it. Under R-97 that is a
 * *confirmed* figure — a person entered it — which is a stronger provenance
 * than a model's read, and the reason a stated price is allowed onto a tax
 * invoice at all.
 *
 * It is still worse in every other way, because it teaches the product nothing
 * about the next sale. The document records which it was and the screen says
 * so, in the same voice as *priced off a list that is not the current one*.
 */
export interface Priced {
  origin: "LIST" | "STATED";
  exShowroomAmount: number;
  hsn: string | null;
  gstRatePct: number;
  cessRatePct: number;
  /** Null on a stated price: there was no list, so there is nothing to print. */
  list: { id: number; name: string; effectiveFrom: string } | null;
  /** Whether the list used was the current one. Always false without a list. */
  isCurrent: boolean;
  /** What the current list would have said, when something else was used. */
  currentAmount: number | null;
}

export interface StatedPrice {
  exShowroomAmount: number;
  hsn?: string | null;
  gstRatePct?: number;
  cessRatePct?: number;
}

/**
 * Look it up, or take what was stated — and warn where the two disagree.
 *
 * A dealer overriding a list he *has* is a legitimate thing to do and is not
 * refused; it is the same commercial freedom R-87 protects when he prices off
 * July's list in August. But it is said out loud, with the list's own figure in
 * the sentence, because a price that quietly ignored the list would hide the
 * dealer's decision from the person checking the invoice — which is the exact
 * failure `pricedOffCurrentList` exists to prevent, arriving by another door.
 */
export async function resolvePrice(input: {
  ownerId: number;
  showroomId: number;
  modelDescription: string;
  onDate: string;
  preferListId?: number | null;
  stated?: StatedPrice | null;
}): Promise<
  | { ok: true; priced: Priced; warnings: string[] }
  | { ok: false; error: string }
> {
  const warnings: string[] = [];

  if (input.stated) {
    const amount = round2(input.stated.exShowroomAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "A stated price has to be a positive amount." };
    }

    // Only to compare against, never to override with. If a list covers this
    // model the dealer is entitled to ignore it; he is not entitled to do so
    // without the document noticing.
    const fromList = await priceFor({ ...input, preferListId: input.preferListId ?? null });
    if (fromList && round2(money(fromList.item.exShowroomAmount)) !== amount) {
      warnings.push(
        `Priced at ₹${amount.toLocaleString("en-IN")} as entered, where "${fromList.list.name}" says ` +
          `₹${money(fromList.item.exShowroomAmount).toLocaleString("en-IN")}.`,
      );
    }

    /*
     * The rates fall back to the list's where there is one and to 28% / 0%
     * otherwise, which is the two-wheeler default and is wrong above 350cc.
     * That is why the form asks: a guessed cess is a short-paid return, and the
     * default exists so the ordinary case needs no thought rather than so the
     * unusual one can be ignored.
     */
    const gst = input.stated.gstRatePct ?? (fromList ? money(fromList.item.gstRatePct) : 28);
    const cess = input.stated.cessRatePct ?? (fromList ? money(fromList.item.cessRatePct) : 0);

    return {
      ok: true,
      warnings,
      priced: {
        origin: "STATED",
        exShowroomAmount: amount,
        hsn: input.stated.hsn?.trim() || fromList?.item.hsn || null,
        gstRatePct: gst,
        cessRatePct: cess,
        list: null,
        isCurrent: false,
        currentAmount: fromList ? money(fromList.item.exShowroomAmount) : null,
      },
    };
  }

  const found = await priceFor({ ...input, preferListId: input.preferListId ?? null });
  if (!found) {
    return {
      ok: false,
      error: input.preferListId
        ? "That price list does not cover this model."
        : `No price list covers ${input.modelDescription} on ${input.onDate}. Enter the price on the document, or add the model to a list.`,
    };
  }

  if (!found.isCurrent) {
    warnings.push(
      `Priced from "${found.list.name}", effective ${found.list.effectiveFrom}, which is not the current list.` +
        (found.currentAmount !== null
          ? ` The current list says ₹${found.currentAmount.toLocaleString("en-IN")}.`
          : ""),
    );
  }

  return {
    ok: true,
    warnings,
    priced: {
      origin: "LIST",
      exShowroomAmount: money(found.item.exShowroomAmount),
      hsn: found.item.hsn,
      gstRatePct: money(found.item.gstRatePct),
      cessRatePct: money(found.item.cessRatePct),
      list: {
        id: found.list.id,
        name: found.list.name,
        effectiveFrom: found.list.effectiveFrom,
      },
      isCurrent: found.isCurrent,
      currentAmount: found.currentAmount,
    },
  };
}
