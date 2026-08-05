/**
 * Seeded vehicle stock — what is standing on the floor and how long it has been.
 *
 * Every record is fictional. Unlike parts, a vehicle costs money every day it
 * does not sell: almost all dealership stock is bought on a floor-plan line and
 * the interest runs whether anybody looks at the unit or not. So the set is
 * arranged around the three ways that goes wrong, plus one that only shows up
 * across modules:
 *
 *   MBLHAR0748NK52201  Xtreme 125R, 118 days on the floor, financed. **And Mrs
 *                      Shalini Kapoor asked for exactly this model nine days
 *                      ago** — enquiry ENQ-0417-9104, quoted, follow-up
 *                      overdue. Neither the stock screen nor the CRM screen can
 *                      see the other one; the match is the whole product.
 *   MBLHAR0748NK52202  Xpulse 200, 96 days, financed. Ageing, nothing matched.
 *   MBLHAR0748NK52204  allocated to a deal in March and never invoiced. The
 *                      unit is neither sellable nor sold, and it is invisible
 *                      on an ageing report that filters on IN_STOCK.
 *   MBLVID0912PL33101  Vida V2 Plus at Deccan, 131 days — and Saraswati has an
 *                      open Vida enquiry. The parts finding, in vehicles.
 *   MBLHAR0748NK52205  arrived last week. Healthy, so the screen is not
 *                      uniformly red.
 *
 * `interestRatePct` is annual and applies only where `financedFlg` is Y. The
 * daily cost of a standing vehicle is arithmetic over that, which is the point:
 * nobody at a dealership disputes the number, they have just never seen it
 * attached to a specific bike.
 */

import type { DmsVehicleStock } from "./types.ts";
import { generateVehicleStock, VOLUME } from "./generate.ts";

export interface VehicleStockSeed
  extends Omit<DmsVehicleStock, "receivedDt" | "allocatedDt" | "invoicedDt" | "modifiedAt"> {
  receivedDaysAgo: number;
  allocatedDaysAgo: number | null;
  invoicedDaysAgo: number | null;
  modifiedDaysAgo: number;
}

export const VEHICLE_STOCK_SEEDS: VehicleStockSeed[] = [
  // ── Saraswati, New Delhi ─────────────────────────────────────────────────
  {
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK52201",
    engineNo: "HA11ELNK52201",
    modelCode: "HER-XTR-125R",
    modelDesc: "Xtreme 125R",
    variantDesc: "Xtreme 125R ABS",
    colourDesc: "Sports Red",
    status: "IN_STOCK",
    allocatedDealId: null,
    costAmt: "104800.00",
    financedFlg: "Y",
    interestRatePct: "9.25",
    receivedDaysAgo: 118,
    allocatedDaysAgo: null,
    invoicedDaysAgo: null,
    modifiedDaysAgo: 118,
  },
  {
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK52202",
    engineNo: "HA11ELNK52202",
    modelCode: "HER-XPL-200",
    modelDesc: "Xpulse 200 4V",
    variantDesc: "Xpulse 200 4V Pro",
    colourDesc: "Matte Nexus Blue",
    status: "IN_STOCK",
    allocatedDealId: null,
    costAmt: "148900.00",
    financedFlg: "Y",
    interestRatePct: "9.25",
    receivedDaysAgo: 96,
    allocatedDaysAgo: null,
    invoicedDaysAgo: null,
    modifiedDaysAgo: 96,
  },
  {
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK52203",
    engineNo: "HA11ELNK52203",
    modelCode: "HER-SPL-PLUS",
    modelDesc: "Splendor Plus",
    variantDesc: "Splendor Plus Xtec",
    colourDesc: "Black with Red",
    status: "IN_STOCK",
    allocatedDealId: null,
    costAmt: "78200.00",
    financedFlg: "Y",
    interestRatePct: "9.25",
    receivedDaysAgo: 47,
    allocatedDaysAgo: null,
    invoicedDaysAgo: null,
    modifiedDaysAgo: 47,
  },
  {
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK52204",
    engineNo: "HA11ELNK52204",
    modelCode: "HER-DST-125",
    modelDesc: "Destini 125",
    variantDesc: "Destini 125 Alloy",
    colourDesc: "Pearl Silver White",
    // Allocated to a deal five months ago and never invoiced. Somebody put a
    // customer's name on it and the sale did not happen, so the unit is held
    // out of stock and out of sales at the same time.
    status: "ALLOCATED",
    allocatedDealId: "HMC-DL-2026-000174",
    costAmt: "84600.00",
    financedFlg: "Y",
    interestRatePct: "9.25",
    receivedDaysAgo: 151,
    allocatedDaysAgo: 142,
    invoicedDaysAgo: null,
    modifiedDaysAgo: 142,
  },
  {
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK52205",
    engineNo: "HA11ELNK52205",
    modelCode: "HER-HFD-100",
    modelDesc: "HF Deluxe",
    variantDesc: "HF Deluxe Self Alloy",
    colourDesc: "Heavy Grey",
    status: "IN_STOCK",
    allocatedDealId: null,
    costAmt: "61400.00",
    financedFlg: "Y",
    interestRatePct: "9.25",
    receivedDaysAgo: 9,
    allocatedDaysAgo: null,
    invoicedDaysAgo: null,
    modifiedDaysAgo: 9,
  },
  {
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK52206",
    engineNo: "HA11ELNK52206",
    modelCode: "HER-SPL-PLUS",
    modelDesc: "Splendor Plus",
    variantDesc: "Splendor Plus Xtec",
    colourDesc: "Candy Blazing Red",
    status: "INVOICED",
    allocatedDealId: "HMC-DL-2026-000181",
    costAmt: "78200.00",
    financedFlg: "Y",
    interestRatePct: "9.25",
    receivedDaysAgo: 34,
    allocatedDaysAgo: 21,
    invoicedDaysAgo: 19,
    modifiedDaysAgo: 19,
  },

  // ── Deccan, Pune ─────────────────────────────────────────────────────────
  {
    dealerCode: "HMC-MH-1182",
    chassisNo: "MBLVID0912PL33101",
    engineNo: "VD22ELPL33101",
    modelCode: "VID-V2-PLUS",
    modelDesc: "Vida V2 Plus",
    variantDesc: "Vida V2 Plus",
    colourDesc: "Matte Sports Red",
    // The parts finding again, in vehicles: the electric scooter nobody in Pune
    // wants, and an open Vida enquiry sitting at the other outlet.
    status: "IN_STOCK",
    allocatedDealId: null,
    costAmt: "121500.00",
    financedFlg: "Y",
    interestRatePct: "9.75",
    receivedDaysAgo: 131,
    allocatedDaysAgo: null,
    invoicedDaysAgo: null,
    modifiedDaysAgo: 131,
  },
  {
    dealerCode: "HMC-MH-1182",
    chassisNo: "MBLHAR0748PL33102",
    engineNo: "HA11ELPL33102",
    modelCode: "HER-SPL-PLUS",
    modelDesc: "Splendor Plus",
    variantDesc: "Splendor Plus Xtec",
    colourDesc: "Black with Red",
    status: "IN_STOCK",
    allocatedDealId: null,
    costAmt: "78200.00",
    financedFlg: "N",
    interestRatePct: null,
    receivedDaysAgo: 22,
    allocatedDaysAgo: null,
    invoicedDaysAgo: null,
    modifiedDaysAgo: 22,
  },
];

/*
 * A month of trading, appended.
 *
 * `push` rather than a spread inside the array literal, so that "the
 * hand-written rows are untouched" is a property of the code rather than a
 * claim in a comment: everything above this line keeps its id, its dates and
 * its position, and every proof in the session log that names one of them
 * stays reproducible. See `generate.ts` for what is being added and why the
 * ratios are what they are.
 */
VEHICLE_STOCK_SEEDS.push(...generateVehicleStock(VOLUME.vehicleStock));
