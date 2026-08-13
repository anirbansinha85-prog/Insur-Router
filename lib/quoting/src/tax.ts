/**
 * What the tax actually is, as of 22 September 2025 (OBJ-36, R-121).
 *
 * This sits in `@workspace/quoting` for the same reason `panel` and `premium`
 * do: the seeder that builds a price list and the generator that raises an
 * invoice off it must not be able to disagree about what 350cc means. One
 * table, imported by both, and no second copy to drift.
 *
 * The 56th GST Council rationalised the slabs and the product did not notice.
 * Every price list seeded before this file believed a table two years out of
 * date — 28% with a three per cent cess above 350cc — and every invoice raised
 * off one overcharged by the difference.
 *
 * ```
 *   electric two-wheeler        5%
 *   petrol, up to 350cc        18%
 *   petrol, above 350cc        40%     the cess is folded into this, not added
 *   spare parts                18%     one uniform slab, whatever the part
 *   repair labour              18%     a service, so a SAC and not an HSN
 * ```
 *
 * **Compensation cess on two-wheelers is gone.** The columns stay — cess still
 * exists for cars, tobacco and coal, and a dealership that adds a car brand
 * would need them — but for every two-wheeler this product prices it is zero,
 * and the 40% band is a single consolidated rate rather than 37% plus 3%.
 *
 * There is no model anywhere near this file and there never will be (R-100).
 * A tax rate is arithmetic about the world, and the only honest way to hold one
 * is to write it down.
 */

/** Petrol or electric. The two propulsions that land in different slabs. */
export type Propulsion = "PETROL" | "ELECTRIC";

/**
 * The rate a two-wheeler attracts, defaulted from what it is rather than what
 * it is called.
 *
 * **The boundary is inclusive and this is the whole of the subtlety.** The law
 * says *exceeding 350cc*, so a machine of exactly 350cc is in the lower band. A
 * Classic 350, a Meteor 350 and a CB350 are all 18% and all read as "big" to
 * anything matching on the model name — which is what the seeder did, and it
 * was already wrong for cess before these rates existed.
 *
 * **And the rate cannot be derived from the HSN code.** `8711 30` covers 250cc
 * to 500cc and the boundary cuts straight through the middle of it. A product
 * that inferred the rate from HSN would put a CB350 and a CB500 in the same
 * band and be wrong about one of them. So capacity is the input, HSN is not,
 * and the answer this returns is only ever a **default** — the rate that ends
 * up on the document is the one recorded against the price-list item, because a
 * person may know something about a machine that its capacity does not say.
 *
 * A missing capacity resolves to 18%. That is the overwhelming majority of what
 * a two-wheeler dealership sells, and guessing 40% would overcharge far more
 * customers than it would ever protect.
 */
export function rateFor(input: {
  engineCc?: number | null;
  propulsion?: Propulsion | null;
}): { gstRatePct: number; cessRatePct: number } {
  if (input.propulsion === "ELECTRIC") return { gstRatePct: 5, cessRatePct: 0 };

  const cc = input.engineCc;
  if (typeof cc === "number" && Number.isFinite(cc) && cc > 350) {
    return { gstRatePct: 40, cessRatePct: 0 };
  }
  return { gstRatePct: 18, cessRatePct: 0 };
}

/**
 * Parts and labour, which sit at the same rate today and are not the same thing
 * (R-123).
 *
 * A spare part is goods under an HSN; fitting it is a service under a SAC. Both
 * are 18% as of September 2025, they were not before it, and GSTR-1 reports
 * them in one summary under different codes. Collapsing them because the
 * numbers happen to match is a decision that has to be unpicked the next time
 * they diverge, so they are two constants rather than one.
 */
export const SPARE_PART_GST_PCT = 18;
export const LABOUR_GST_PCT = 18;

/**
 * When this table came into force.
 *
 * Documents stamp their own rate, so nothing here reaches backwards — an
 * invoice reprinted next year shows what was charged. This date exists so that
 * the next time the Council moves the slabs, whoever is reading knows what this
 * file was true of.
 */
export const RATES_EFFECTIVE_FROM = "2025-09-22";
