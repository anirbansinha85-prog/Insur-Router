/**
 * Adapter registry, keyed by OEM.
 *
 * The commercial fact this exists to serve: **a dealer's DMS is determined by
 * the OEM it represents.** Hero dealers run Hero's system, Honda dealers run
 * Honda's. So fifty dealers across five brands is five integrations, not fifty
 * — and the second dealer of a brand already covered costs a configuration
 * row, while the second dealer of a new brand costs an adapter.
 *
 * Adding an OEM therefore means: write `<oem>-adapter.ts`, register it here,
 * and change nothing else. If adding one ever requires touching the route or
 * the client, the seam is in the wrong place.
 */

import { adaptHeroDeal, type AdaptedDeal } from "./hero-adapter";
import type { DmsDeal } from "./types";

export type OemCode = "HERO";

export interface DmsAdapter {
  oemCode: OemCode;
  label: string;
  adaptDeal: (deal: DmsDeal) => AdaptedDeal;
}

const ADAPTERS: Record<OemCode, DmsAdapter> = {
  HERO: {
    oemCode: "HERO",
    label: "Hero MotoCorp",
    adaptDeal: adaptHeroDeal,
  },
};

/**
 * Which OEM a dealer belongs to.
 *
 * A placeholder for a real tenant table. `providers` is currently global with
 * no owner, and until it becomes tenant → panel → credentials there is nowhere
 * to store this properly. The dealer-code prefix is a stand-in, not a scheme to
 * build on: `HMC-` is Hero MotoCorp's, and every mock dealer uses it.
 */
export function oemForDealer(dealerCode: string | null | undefined): OemCode {
  if (dealerCode?.toUpperCase().startsWith("HMC-")) return "HERO";
  return DEFAULT_OEM;
}

/**
 * Only one adapter exists, so an unrecognised dealer resolves to it rather than
 * failing. Revisit the moment a second OEM lands — at that point guessing is
 * worse than refusing, because the wrong adapter produces plausible nonsense
 * instead of an error.
 */
export const DEFAULT_OEM: OemCode = "HERO";

export function adapterFor(oemCode: OemCode): DmsAdapter {
  return ADAPTERS[oemCode] ?? ADAPTERS[DEFAULT_OEM];
}

export function adapterForDealer(dealerCode: string | null | undefined): DmsAdapter {
  return adapterFor(oemForDealer(dealerCode));
}

export function listAdapters(): DmsAdapter[] {
  return Object.values(ADAPTERS);
}
