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
 * Only the model and its rules live here. The panels themselves are per-tenant
 * data — the mock keeps them in memory, and the real app will read them from
 * the database once `providers` becomes tenant-owned. Nothing in this file
 * knows where a panel came from.
 */

export interface PanelEntry {
  insurerCode: string;
  insurerName: string;
  shortName: string;
  /** How the dealer reaches this insurer. */
  route: "BROKER" | "DIRECT_AGENT";
  /** Integration surface. `PORTAL` means browser automation is the only option. */
  integration: "API" | "PORTAL";
  /** Filed own-damage rate as a fraction of IDV, before zone loading. */
  odBaseRate: number;
  /** Policies the dealer has committed to place this period. */
  quotaPolicies: number;
  quotaConsumed: number;
  /** Commission the dealer earns, as a fraction of OD premium. */
  payoutRate: number;
  isEnabled: boolean;
  /** Turnaround the dealer can promise the customer. */
  slaMinutes: number;
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

/** Look up one insurer within an already-resolved panel. */
export function findInsurer(
  panel: PanelEntry[],
  insurerCode: string,
): PanelEntry | undefined {
  return panel.find((p) => p.insurerCode === insurerCode);
}
