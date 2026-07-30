/**
 * Premium computation for a new two-wheeler.
 *
 * The third-party half is **not** an estimate. IRDAI fixes TP rates by engine
 * capacity and every insurer charges the identical figure, so this arithmetic
 * produces the real number. The own-damage half *is* an estimate: OD was
 * detariffed, so each insurer files its own rates and only that insurer's
 * quote engine knows the true figure.
 *
 * That split is the honest boundary of what can be computed without an insurer
 * relationship, and the UI labels it as such. Do not present the OD figure as
 * final.
 *
 * Sources and caveats are in docs/new-vehicle-issuance-fields.md. Rates move by
 * government notification — everything here is data, not logic.
 */

import type { DmsModel } from "./types.ts";

/** GST on motor insurance premium. */
export const GST_RATE = 0.18;

/**
 * Compulsory owner-driver personal accident cover.
 *
 * ₹15 lakh is mandated. ₹331/year is the figure in general use, but sources
 * conflict on whether it is charged separately or absorbed into the tariff —
 * some insurers show it as a line item, some do not. Treated as a separate line
 * here because that is what appears on most current policies, and because the
 * nominee requirement it carries needs to be visible rather than buried.
 *
 * Not applicable to a corporate owner: there is no owner-driver.
 */
export const CPA_SUM_INSURED = 1_500_000;
export const CPA_ANNUAL_PREMIUM = 331;

/** New two-wheelers must carry five years of third-party cover. */
export const NEW_VEHICLE_TP_YEARS = 5;

/** IDV depreciation for a vehicle under six months old. */
export const NEW_VEHICLE_DEPRECIATION = 0.05;

/**
 * IRDAI third-party premium, petrol. FY 2025-26.
 * Bands are on engine displacement in cc.
 */
const TP_PETROL = [
  { maxCc: 75, oneYear: 538, fiveYear: 2_901, label: "Up to 75cc" },
  { maxCc: 150, oneYear: 714, fiveYear: 3_851, label: "75cc to 150cc" },
  { maxCc: 350, oneYear: 1_366, fiveYear: 7_365, label: "150cc to 350cc" },
  { maxCc: Infinity, oneYear: 2_804, fiveYear: 15_117, label: "Above 350cc" },
];

/**
 * IRDAI third-party premium, electric. Rated on **motor kW, not cc**.
 *
 * Published one-year rates only; the five-year figure is derived with the same
 * multiplier the petrol bands exhibit (~5.39x, i.e. five years at a discount to
 * five single years). Flagged as derived in the returned breakdown — do not
 * charge on it without checking the current notification.
 */
const TP_ELECTRIC = [
  { maxKw: 3, oneYear: 457, label: "Up to 3 kW" },
  { maxKw: 7, oneYear: 607, label: "3 kW to 7 kW" },
  { maxKw: 16, oneYear: 1_161, label: "7 kW to 16 kW" },
  { maxKw: Infinity, oneYear: 2_383, label: "Above 16 kW" },
];

/** Ratio of the published 5-year TP to the 1-year TP, averaged over petrol bands. */
const FIVE_YEAR_MULTIPLIER =
  TP_PETROL.reduce((acc, b) => acc + b.fiveYear / b.oneYear, 0) / TP_PETROL.length;

/**
 * Zone A carries a higher own-damage loading — metros, where theft and traffic
 * density are worse. Keyed on the *registering* city.
 */
const ZONE_A_CITIES = new Set([
  "MUMBAI",
  "DELHI",
  "NEW DELHI",
  "KOLKATA",
  "CHENNAI",
  "BENGALURU",
  "BANGALORE",
  "HYDERABAD",
  "AHMEDABAD",
  "PUNE",
]);

export function zoneFor(city: string): "A" | "B" {
  return ZONE_A_CITIES.has(city.trim().toUpperCase()) ? "A" : "B";
}

export interface TpResult {
  band: string;
  basis: string;
  years: number;
  amount: number;
  /** True when the figure was derived rather than read from a published table. */
  derived: boolean;
}

/** Third-party premium — the figure that is identical at every insurer. */
export function computeTp(model: DmsModel, years = NEW_VEHICLE_TP_YEARS): TpResult {
  if (model.fuel === "ELECTRIC") {
    const kw = model.motorKw ?? 0;
    const band = TP_ELECTRIC.find((b) => kw <= b.maxKw) ?? TP_ELECTRIC.at(-1)!;
    const amount =
      years === 1 ? band.oneYear : Math.round(band.oneYear * FIVE_YEAR_MULTIPLIER);
    return {
      band: band.label,
      basis: `${kw} kW motor rating`,
      years,
      amount,
      derived: years !== 1,
    };
  }

  const cc = model.cc ?? 0;
  const band = TP_PETROL.find((b) => cc <= b.maxCc) ?? TP_PETROL.at(-1)!;
  return {
    band: band.label,
    basis: `${cc} cc engine capacity`,
    years,
    amount: years === 1 ? band.oneYear : band.fiveYear,
    derived: false,
  };
}

/** IDV — ex-showroom less depreciation. Basis for the own-damage premium. */
export function computeIdv(exShowroom: number): number {
  return Math.round(exShowroom * (1 - NEW_VEHICLE_DEPRECIATION));
}

export interface PremiumBreakdown {
  idv: number;
  zone: "A" | "B";
  tp: TpResult;
  /** Estimated. The insurer's own engine is authoritative. */
  od: { rate: number; amount: number; years: number; estimated: true };
  cpa: { sumInsured: number; amount: number; applicable: boolean; reason?: string };
  addOns: { label: string; amount: number }[];
  netPremium: number;
  gst: number;
  totalPayable: number;
}

export interface PremiumInput {
  model: DmsModel;
  exShowroomAmt: number;
  registeringCity: string;
  /** Insurer's filed OD rate as a fraction of IDV, before zone loading. */
  odBaseRate: number;
  /** Corporate owners have no owner-driver, so no compulsory PA cover. */
  isCorporate: boolean;
  addOns?: { label: string; rateOfIdv: number }[];
}

/** Zone A loading applied on top of the insurer's filed base rate. */
const ZONE_A_LOADING = 1.1;

export function computePremium(input: PremiumInput): PremiumBreakdown {
  const idv = computeIdv(input.exShowroomAmt);
  const zone = zoneFor(input.registeringCity);
  const tp = computeTp(input.model);

  const effectiveOdRate = input.odBaseRate * (zone === "A" ? ZONE_A_LOADING : 1);
  // OD is annual even on a bundled policy — only the TP half runs five years.
  const odAmount = Math.round(idv * effectiveOdRate);

  const cpaApplicable = !input.isCorporate;
  const cpa = {
    sumInsured: CPA_SUM_INSURED,
    amount: cpaApplicable ? CPA_ANNUAL_PREMIUM : 0,
    applicable: cpaApplicable,
    reason: cpaApplicable ? undefined : "Corporate owner — no owner-driver",
  };

  const addOns = (input.addOns ?? []).map((a) => ({
    label: a.label,
    amount: Math.round(idv * a.rateOfIdv),
  }));

  const netPremium =
    tp.amount + odAmount + cpa.amount + addOns.reduce((acc, a) => acc + a.amount, 0);
  const gst = Math.round(netPremium * GST_RATE);

  return {
    idv,
    zone,
    tp,
    od: { rate: effectiveOdRate, amount: odAmount, years: 1, estimated: true },
    cpa,
    addOns,
    netPremium,
    gst,
    totalPayable: netPremium + gst,
  };
}

/** `193750` → `1,93,750` — Indian digit grouping, not thousands. */
export function formatInr(n: number): string {
  const s = Math.round(n).toString();
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}
