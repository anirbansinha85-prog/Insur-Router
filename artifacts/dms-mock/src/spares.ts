/**
 * Seeded parts stock, for both branches.
 *
 * Every record is fictional. The set is arranged around one finding that only
 * exists because the owner holds more than one outlet:
 *
 *   HR-BRK-SHOE-R    Saraswati has none and a job card has been waiting three
 *                    days for it. Deccan has four on the shelf, unreserved.
 *   HR-PNL-SIDE-L    Saraswati has none and a job card has been waiting nine
 *                    days. Neither branch has one — a genuine stockout, and it
 *                    has to look different from the one above or the screen is
 *                    just noise.
 *   HR-BAT-5AH       below reorder level at Saraswati with nothing on order
 *   HR-CLT-PLATE-125 on order, ETA passed a week ago
 *   HR-FLT-OIL-97    healthy, so the screen is not uniformly red
 *   VID-BRK-PAD-F    Saraswati bought eight for a model it barely sells and has
 *                    issued none in five months. Capital on a shelf.
 *   HR-SPK-PLUG      reserved down to nothing — the shelf says four, the
 *                    counter can issue none, and only one of those numbers is
 *                    on the storeman's screen
 *
 * The two branches deliberately do not carry the same catalogue. A group's
 * outlets never do, and a transfer that is obvious to an owner is invisible to
 * both branch systems.
 *
 * Dates are relative to now and resolved at seed time, for the same reason as
 * everywhere else: dead stock is dead because of how long it has sat.
 */

import type { DmsPartStock } from "./types.ts";
import { generateParts, VOLUME } from "./generate.ts";

export interface PartStockSeed
  extends Omit<DmsPartStock, "lastReceivedDt" | "lastIssuedDt" | "onOrderEtaDt" | "modifiedAt"> {
  lastReceivedDaysAgo: number | null;
  lastIssuedDaysAgo: number | null;
  /** Days from now. Negative means the delivery date has already passed. */
  onOrderEtaInDays: number | null;
  modifiedDaysAgo: number;
}

export const PART_STOCK_SEEDS: PartStockSeed[] = [
  // ── Saraswati, New Delhi ─────────────────────────────────────────────────
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-BRK-SHOE-R",
    partDesc: "Brake shoe set — rear",
    binLocation: "A-04-2",
    // The one the workshop screen has been calling "waiting on a part" for
    // three days. There is one, four hundred kilometres away, in the other
    // branch this owner also pays for.
    qtyOnHand: 0,
    qtyReserved: 0,
    reorderLevel: 4,
    mrpAmt: "520.00",
    costAmt: "398.00",
    lastReceivedDaysAgo: 34,
    lastIssuedDaysAgo: 5,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 5,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-PNL-SIDE-L",
    partDesc: "Side panel — left, painted",
    binLocation: "D-11-1",
    // Nine days, and nothing to transfer. A painted panel is a slow OEM order
    // and this is what a real stockout looks like next to the one above.
    qtyOnHand: 0,
    qtyReserved: 0,
    reorderLevel: 1,
    mrpAmt: "2340.00",
    costAmt: "1810.00",
    lastReceivedDaysAgo: 96,
    lastIssuedDaysAgo: 41,
    onOrderQty: 1,
    onOrderEtaInDays: 6,
    modifiedDaysAgo: 6,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-BAT-5AH",
    partDesc: "Battery 12V 5Ah",
    binLocation: "B-02-4",
    qtyOnHand: 1,
    qtyReserved: 0,
    reorderLevel: 4,
    mrpAmt: "1580.00",
    costAmt: "1195.00",
    lastReceivedDaysAgo: 21,
    lastIssuedDaysAgo: 1,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 1,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-CLT-PLATE-125",
    partDesc: "Clutch plate set 125cc",
    binLocation: "C-07-3",
    // Ordered, promised, and a week past the promise. Nothing chases it.
    qtyOnHand: 0,
    qtyReserved: 0,
    reorderLevel: 2,
    mrpAmt: "1240.00",
    costAmt: "940.00",
    lastReceivedDaysAgo: 47,
    lastIssuedDaysAgo: 2,
    onOrderQty: 3,
    onOrderEtaInDays: -7,
    modifiedDaysAgo: 7,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-OIL-10W30",
    partDesc: "Engine oil 10W30 (900ml)",
    binLocation: "A-01-1",
    qtyOnHand: 34,
    qtyReserved: 4,
    reorderLevel: 12,
    mrpAmt: "410.00",
    costAmt: "302.00",
    lastReceivedDaysAgo: 9,
    lastIssuedDaysAgo: 0,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 0,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-FLT-OIL-97",
    partDesc: "Oil filter element 97cc",
    binLocation: "A-01-3",
    qtyOnHand: 18,
    qtyReserved: 2,
    reorderLevel: 8,
    mrpAmt: "145.00",
    costAmt: "104.00",
    lastReceivedDaysAgo: 9,
    lastIssuedDaysAgo: 0,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 0,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-SPK-PLUG",
    partDesc: "Spark plug",
    binLocation: "A-03-2",
    // The shelf says four. Every one of them is promised to an open job card,
    // so the counter can issue none — and the storeman's screen shows the four.
    qtyOnHand: 4,
    qtyReserved: 4,
    reorderLevel: 10,
    mrpAmt: "180.00",
    costAmt: "121.00",
    lastReceivedDaysAgo: 16,
    lastIssuedDaysAgo: 0,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 0,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "VID-BRK-PAD-F",
    partDesc: "Brake pad set — front, Vida",
    binLocation: "E-02-1",
    // Eight bought for an electric model this branch barely sells, and not one
    // issued in five months. ₹7,120 of somebody's working capital, on a shelf.
    qtyOnHand: 8,
    qtyReserved: 0,
    reorderLevel: 2,
    mrpAmt: "890.00",
    costAmt: "712.00",
    lastReceivedDaysAgo: 152,
    lastIssuedDaysAgo: null,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 152,
  },
  {
    dealerCode: "HMC-DL-0417",
    partNo: "HR-CBL-THR-01",
    partDesc: "Throttle cable assembly",
    binLocation: "C-03-1",
    qtyOnHand: 11,
    qtyReserved: 0,
    reorderLevel: 4,
    mrpAmt: "265.00",
    costAmt: "188.00",
    lastReceivedDaysAgo: 118,
    lastIssuedDaysAgo: 97,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 97,
  },

  // ── Deccan, Pune ─────────────────────────────────────────────────────────
  // A different catalogue, as a real second outlet has. The overlap is where
  // the owner's advantage lives.
  {
    dealerCode: "HMC-MH-1182",
    partNo: "HR-BRK-SHOE-R",
    partDesc: "Brake shoe set — rear",
    binLocation: "P-02-1",
    // Four, none reserved, and a customer in Delhi has been waiting three days.
    qtyOnHand: 4,
    qtyReserved: 0,
    reorderLevel: 3,
    mrpAmt: "520.00",
    costAmt: "398.00",
    lastReceivedDaysAgo: 12,
    lastIssuedDaysAgo: 4,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 4,
  },
  {
    dealerCode: "HMC-MH-1182",
    partNo: "HR-BAT-5AH",
    partDesc: "Battery 12V 5Ah",
    binLocation: "P-01-3",
    qtyOnHand: 6,
    qtyReserved: 1,
    reorderLevel: 3,
    mrpAmt: "1580.00",
    costAmt: "1195.00",
    lastReceivedDaysAgo: 8,
    lastIssuedDaysAgo: 2,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 2,
  },
  {
    dealerCode: "HMC-MH-1182",
    partNo: "VID-BRK-PAD-F",
    partDesc: "Brake pad set — front, Vida",
    binLocation: "P-04-2",
    // Deccan sells the electric model. Delhi bought the pads.
    qtyOnHand: 2,
    qtyReserved: 1,
    reorderLevel: 4,
    mrpAmt: "890.00",
    costAmt: "712.00",
    lastReceivedDaysAgo: 19,
    lastIssuedDaysAgo: 3,
    onOrderQty: 4,
    onOrderEtaInDays: 3,
    modifiedDaysAgo: 3,
  },
  {
    dealerCode: "HMC-MH-1182",
    partNo: "HR-OIL-10W30",
    partDesc: "Engine oil 10W30 (900ml)",
    binLocation: "P-01-1",
    qtyOnHand: 22,
    qtyReserved: 2,
    reorderLevel: 10,
    mrpAmt: "410.00",
    costAmt: "302.00",
    lastReceivedDaysAgo: 6,
    lastIssuedDaysAgo: 0,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 0,
  },
  {
    dealerCode: "HMC-MH-1182",
    partNo: "HR-SPK-PLUG",
    partDesc: "Spark plug",
    binLocation: "P-03-1",
    qtyOnHand: 14,
    qtyReserved: 0,
    reorderLevel: 8,
    mrpAmt: "180.00",
    costAmt: "121.00",
    lastReceivedDaysAgo: 11,
    lastIssuedDaysAgo: 1,
    onOrderQty: 0,
    onOrderEtaInDays: null,
    modifiedDaysAgo: 1,
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
PART_STOCK_SEEDS.push(...generateParts(VOLUME.parts));
