/**
 * Which insurers each mock dealer is empanelled with.
 *
 * The panel *model* — what an entry means, how quota is read, why an insurer is
 * excluded — moved to `@workspace/quoting/panel` so the real API server shares
 * one implementation. What stays here is the per-tenant data: two dealerships,
 * deliberately different.
 *
 * Insurer names are real companies, which is normal — a dealer's panel really
 * does list these. The **filed OD rates here are invented**. Real rates are
 * confidential, filed per insurer, and vary by model and zone. They exist to
 * make quotes differ plausibly, which is the point being demonstrated: TP is
 * identical everywhere by law, so OD is the only thing that varies.
 *
 * ── The same numbers also live in scripts/src/seed-owners.ts ────────────────
 * That copy seeds `insurer_panel_entries`, which is where the *real* server
 * reads a panel from. **Change both together.**
 *
 * They are not shared from one file on purpose. This is a mock of somebody
 * else's system and holds its data in memory by design; importing the real
 * seed would couple the fake OEM to our database, and sharing a fixture across
 * the package boundary hits the .ts-specifier conflict documented in
 * lib/quoting/package.json. Two small copies with a pointer beat either.
 *
 * Strictly, a real OEM's DMS would not know a dealer's quota or payout at all —
 * that is the dealer's private commercial data. It sits here because this file
 * predates the panel being a real table, and the mock portal still reads it.
 */

import { findInsurer, type PanelEntry } from "@workspace/quoting/panel";

/**
 * Panels are keyed by dealer code. 0417 reaches five insurers through one
 * broker platform; 1182 reaches exactly one, directly. That asymmetry is the
 * whole reason routing is per-tenant.
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
  return findInsurer(panelFor(dealerCode), insurerCode);
}
