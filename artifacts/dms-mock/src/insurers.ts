/**
 * The dealer's insurer panel.
 *
 * This is the part of the domain the existing schema has no concept of. The
 * global `providers` table lists six insurers with no owner; in reality the
 * panel is **per dealer**, because reach is a commercial arrangement:
 *
 *   BROKER        the dealer transacts on a broker's consolidated platform that
 *                 fronts several insurers behind one login. Integrating that
 *                 platform reaches every insurer on it at once.
 *   DIRECT_AGENT  the dealer holds its own agency code with one insurer and logs
 *                 into that insurer's portal. One integration, one insurer.
 *
 * Each entry carries a **quota** — the volume the dealer has committed to place
 * with that insurer for the period. Today that allocation lives in a spreadsheet
 * or a manager's head, and the sales executive at the counter picks an insurer
 * with no visibility of it. Surfacing it is the actual product; data entry is
 * only the wedge.
 *
 * Insurer names are real companies, which is normal — a dealer's panel really
 * does list these. The **filed OD rates here are invented**. Real rates are
 * confidential, filed per insurer, and vary by model and zone. They exist to
 * make quotes differ plausibly, which is the point being demonstrated: TP is
 * identical everywhere by law, so OD is the only thing that varies.
 */

export interface PanelEntry {
  insurerCode: string;
  insurerName: string;
  shortName: string;
  /** How the dealer reaches this insurer. */
  route: "BROKER" | "DIRECT_AGENT";
  /** Integration surface. `PORTAL` means browser automation is the only option. */
  integration: "API" | "PORTAL";
  /** Filed own-damage rate as a fraction of IDV, before zone loading. Invented. */
  odBaseRate: number;
  /** Policies the dealer has committed to place this period. */
  quotaPolicies: number;
  quotaConsumed: number;
  /** Commission the dealer earns, as a fraction of OD premium. Illustrative. */
  payoutRate: number;
  isEnabled: boolean;
  /** Turnaround the dealer can promise the customer. */
  slaMinutes: number;
}

/**
 * Panels are keyed by dealer code. Two dealers, deliberately different:
 * 0417 reaches five insurers through one broker platform; 1182 reaches exactly
 * one, directly. That asymmetry is the whole reason routing is per-tenant.
 */
export const PANELS: Record<string, PanelEntry[]> = {
  "HMC-DL-0417": [
    {
      insurerCode: "BAJAJ",
      insurerName: "Bajaj Allianz General Insurance Co. Ltd.",
      shortName: "Bajaj Allianz",
      route: "BROKER",
      integration: "API",
      odBaseRate: 0.0192,
      quotaPolicies: 60,
      quotaConsumed: 41,
      payoutRate: 0.19,
      isEnabled: true,
      slaMinutes: 4,
    },
    {
      insurerCode: "HDFC",
      insurerName: "HDFC ERGO General Insurance Co. Ltd.",
      shortName: "HDFC ERGO",
      route: "BROKER",
      integration: "API",
      odBaseRate: 0.0205,
      quotaPolicies: 50,
      quotaConsumed: 47,
      payoutRate: 0.2,
      isEnabled: true,
      slaMinutes: 5,
    },
    {
      insurerCode: "ICICI",
      insurerName: "ICICI Lombard General Insurance Co. Ltd.",
      shortName: "ICICI Lombard",
      route: "BROKER",
      // No API on this one — the broker platform only exposes a web portal, so
      // Playwright is the only route. This is the common case, not the exception.
      integration: "PORTAL",
      odBaseRate: 0.0221,
      quotaPolicies: 40,
      quotaConsumed: 12,
      payoutRate: 0.175,
      isEnabled: true,
      slaMinutes: 9,
    },
    {
      insurerCode: "DIGIT",
      insurerName: "Go Digit General Insurance Ltd.",
      shortName: "Go Digit",
      route: "BROKER",
      integration: "API",
      odBaseRate: 0.0178,
      quotaPolicies: 35,
      quotaConsumed: 8,
      payoutRate: 0.155,
      isEnabled: true,
      slaMinutes: 3,
    },
    {
      insurerCode: "TATAAIG",
      insurerName: "Tata AIG General Insurance Co. Ltd.",
      shortName: "Tata AIG",
      route: "BROKER",
      integration: "PORTAL",
      odBaseRate: 0.0247,
      quotaPolicies: 25,
      // Fully consumed. The router must exclude it, and the demo should show why.
      quotaConsumed: 25,
      payoutRate: 0.21,
      isEnabled: true,
      slaMinutes: 11,
    },
  ],
  "HMC-MH-1182": [
    {
      insurerCode: "BAJAJ",
      insurerName: "Bajaj Allianz General Insurance Co. Ltd.",
      shortName: "Bajaj Allianz",
      // Direct agency code, not a broker. One insurer, and no panel to compare
      // against — which is exactly why this dealer's screen looks different.
      route: "DIRECT_AGENT",
      integration: "PORTAL",
      odBaseRate: 0.0198,
      quotaPolicies: 80,
      quotaConsumed: 33,
      payoutRate: 0.225,
      isEnabled: true,
      slaMinutes: 7,
    },
  ],
};

export function panelFor(dealerCode: string): PanelEntry[] {
  return PANELS[dealerCode] ?? [];
}

export function insurerFor(dealerCode: string, insurerCode: string): PanelEntry | undefined {
  return panelFor(dealerCode).find((p) => p.insurerCode === insurerCode);
}

export interface QuotaState {
  remaining: number;
  utilisation: number;
  /** Exhausted quota excludes an insurer from routing. */
  exhausted: boolean;
  /** Near the limit — worth warning about but still selectable. */
  tight: boolean;
}

export function quotaState(p: PanelEntry): QuotaState {
  const remaining = Math.max(0, p.quotaPolicies - p.quotaConsumed);
  const utilisation = p.quotaPolicies === 0 ? 1 : p.quotaConsumed / p.quotaPolicies;
  return {
    remaining,
    utilisation,
    exhausted: remaining === 0,
    tight: remaining > 0 && utilisation >= 0.85,
  };
}

/**
 * Why an insurer is or is not eligible for a given deal.
 *
 * Returned as a list rather than a boolean so the UI can *explain* the routing
 * decision. A dealer who cannot see why an insurer was excluded will not trust
 * the recommendation, and an unexplained recommendation is worse than none.
 */
export function eligibility(p: PanelEntry): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const q = quotaState(p);

  if (!p.isEnabled) reasons.push("Disabled by the dealership");
  if (q.exhausted) reasons.push(`Period quota fully placed (${p.quotaConsumed}/${p.quotaPolicies})`);

  return { eligible: reasons.length === 0, reasons };
}
