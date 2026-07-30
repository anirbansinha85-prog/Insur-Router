/**
 * OEM model catalogue.
 *
 * Hero MotoCorp was chosen as the reference OEM because it has the largest
 * dealer network in India, so a first DMS integration against it reaches the
 * most dealers. Specs are approximate and the service schedules are
 * *representative, not authoritative* — the real intervals come off each model's
 * service booklet and vary by model and market. Treat these as placeholders to
 * be replaced with the booklet values, not as facts.
 *
 * The spread is chosen to exercise every rating path:
 *   - 97.2cc and 124.x cc  → IRDAI TP band "75cc to 150cc"
 *   - 199.6cc              → IRDAI TP band "150cc to 350cc"
 *   - 6 kW electric        → IRDAI rates EVs on motor kW, not on cc
 * An integration that only ever sees a Splendor will silently hardcode the
 * wrong assumption.
 */

import type { DmsModel } from "./types.ts";

/**
 * Five free services at roughly 3,000 km intervals after an early first
 * service. Day targets are generous because the km target is what usually
 * triggers first on a commuter bike.
 */
const COMMUTER_FREE_SERVICES = [
  { seq: 1, km: 1_000, days: 60 },
  { seq: 2, km: 4_000, days: 240 },
  { seq: 3, km: 7_000, days: 420 },
  { seq: 4, km: 10_000, days: 600 },
  { seq: 5, km: 13_000, days: 780 },
];

export const MODELS: Record<string, DmsModel> = {
  "HER-SPL-PLUS": {
    modelCode: "HER-SPL-PLUS",
    modelDesc: "Splendor Plus",
    variantDesc: "Self Start Alloy Wheel i3S",
    bodyStyle: "MOTORCYCLE",
    fuel: "PETROL",
    cc: 97.2,
    motorKw: null,
    seatCap: 2,
    warrantyMonths: 60,
    warrantyKm: 70_000,
    freeServices: COMMUTER_FREE_SERVICES,
    paidServiceIntervalKm: 3_000,
    paidServiceIntervalDays: 90,
  },
  "HER-HFD-100": {
    modelCode: "HER-HFD-100",
    modelDesc: "HF Deluxe",
    variantDesc: "Kick Start Spoke",
    bodyStyle: "MOTORCYCLE",
    fuel: "PETROL",
    cc: 97.2,
    motorKw: null,
    seatCap: 2,
    warrantyMonths: 60,
    warrantyKm: 70_000,
    freeServices: COMMUTER_FREE_SERVICES,
    paidServiceIntervalKm: 3_000,
    paidServiceIntervalDays: 90,
  },
  "HER-XTR-125R": {
    modelCode: "HER-XTR-125R",
    modelDesc: "Xtreme 125R",
    variantDesc: "ABS Combi Brake",
    bodyStyle: "MOTORCYCLE",
    fuel: "PETROL",
    cc: 124.7,
    motorKw: null,
    seatCap: 2,
    warrantyMonths: 60,
    warrantyKm: 70_000,
    freeServices: COMMUTER_FREE_SERVICES,
    paidServiceIntervalKm: 3_000,
    paidServiceIntervalDays: 90,
  },
  "HER-XPL-200": {
    modelCode: "HER-XPL-200",
    modelDesc: "Xpulse 200 4V",
    variantDesc: "Pro Dual ABS",
    bodyStyle: "MOTORCYCLE",
    fuel: "PETROL",
    // Crosses the 150cc boundary — TP premium is materially higher here.
    cc: 199.6,
    motorKw: null,
    seatCap: 2,
    warrantyMonths: 60,
    warrantyKm: 70_000,
    freeServices: COMMUTER_FREE_SERVICES,
    paidServiceIntervalKm: 3_000,
    paidServiceIntervalDays: 90,
  },
  "HER-DST-125": {
    modelCode: "HER-DST-125",
    modelDesc: "Destini 125",
    variantDesc: "XTEC Drum",
    bodyStyle: "SCOOTER",
    fuel: "PETROL",
    cc: 124.6,
    motorKw: null,
    seatCap: 2,
    warrantyMonths: 60,
    // Scooters carry a lower km cap than motorcycles.
    warrantyKm: 50_000,
    freeServices: COMMUTER_FREE_SERVICES,
    paidServiceIntervalKm: 3_000,
    paidServiceIntervalDays: 90,
  },
  "VID-V2-PLUS": {
    modelCode: "VID-V2-PLUS",
    modelDesc: "Vida V2 Plus",
    variantDesc: "3.44 kWh",
    bodyStyle: "SCOOTER",
    fuel: "ELECTRIC",
    // No displacement. Any code that reads `cc` unconditionally breaks here,
    // which is exactly why an EV is in the seed set.
    cc: null,
    motorKw: 6,
    seatCap: 2,
    warrantyMonths: 60,
    warrantyKm: 50_000,
    freeServices: [
      { seq: 1, km: 1_000, days: 60 },
      { seq: 2, km: 5_000, days: 300 },
      { seq: 3, km: 10_000, days: 600 },
    ],
    paidServiceIntervalKm: 5_000,
    paidServiceIntervalDays: 180,
  },
};
