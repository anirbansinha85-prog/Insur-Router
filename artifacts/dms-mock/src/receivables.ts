/**
 * Seeded receivables — money the dealership is owed and has not been paid.
 *
 * Every record is fictional. The set is arranged around findings a single
 * branch's ledger cannot produce, in the same way the parts seed is:
 *
 *   ICICI Lombard   owes **both** outlets. Neither branch's ageing report can
 *                   see the group's exposure to one insurer, because each is
 *                   keyed to a dealer code — and it is the largest number on
 *                   the screen once the two are added up.
 *   Sharma Logistics a fleet customer 104 days past a 30-day credit period,
 *                   never chased. The oldest thing on the ledger.
 *   Hero MotoCorp   a warranty claim the OEM short-settled. Disputed, and the
 *                   dispute has been sitting untouched since March.
 *   Mr Ashok Verma  promised to pay by a date that has now passed. A broken
 *                   promise is a different state from an unchased bill and the
 *                   screen has to say which.
 *   Bajaj Allianz   chased last week and inside its credit period — so the
 *                   screen is not uniformly red.
 *   TVS Credit      settled in full, for contrast.
 *
 * Every amount is in rupees as a string, which is how the DMS carries money and
 * therefore how it arrives. Dates are relative to now and resolved at seed
 * time: an ageing screen where the ageing does not age teaches nothing.
 */

import type { DmsReceivable } from "./types.ts";
import { generateReceivables, VOLUME } from "./generate.ts";

export interface ReceivableSeed
  extends Omit<
    DmsReceivable,
    "invoiceDt" | "dueDt" | "lastReceiptDt" | "promisedDt" | "modifiedAt"
  > {
  invoiceDaysAgo: number;
  /** Credit period in days, from the invoice date. `dueDt` is derived from it. */
  creditDays: number;
  lastReceiptDaysAgo: number | null;
  /** Days from now. Negative means the customer's promised date has passed. */
  promisedInDays: number | null;
  modifiedDaysAgo: number;
}

export const RECEIVABLE_SEEDS: ReceivableSeed[] = [
  // ── Saraswati, New Delhi ─────────────────────────────────────────────────
  {
    dealerCode: "HMC-DL-0417",
    receivableId: "REC-0417-5501",
    partyType: "INSURER",
    partyCode: "ICICI-LOM",
    partyEmailId: "motorclaims.north@icicilombard.example",
    partyName: "ICICI Lombard General Insurance",
    invoiceNo: "INV-0417-24118",
    invoiceAmt: "48200.00",
    receivedAmt: "0.00",
    // Cashless accident repair. The work is done, the vehicle has gone home,
    // and the insurer has had the file for two months.
    againstType: "JOB_CARD",
    againstKey: "JC-0417-24125",
    narrationDesc: "Cashless claim — surveyor report submitted",
    status: "OPEN",
    invoiceDaysAgo: 63,
    creditDays: 30,
    lastReceiptDaysAgo: null,
    promisedInDays: null,
    modifiedDaysAgo: 63,
  },
  {
    dealerCode: "HMC-DL-0417",
    receivableId: "REC-0417-5502",
    partyType: "CUSTOMER",
    partyCode: "CUST-SHARMA-LOG",
    partyEmailId: "accounts@sharmalogistics.example",
    partyName: "Sharma Logistics Pvt Ltd",
    invoiceNo: "INV-0417-23904",
    invoiceAmt: "127400.00",
    receivedAmt: "40000.00",
    // A fleet account. Part-paid once, four months ago, and nobody has rung
    // them since. The oldest and least excusable row on the ledger.
    againstType: "JOB_CARD",
    againstKey: "JC-0417-23904",
    narrationDesc: "Fleet servicing — 6 vehicles, monthly account",
    status: "PART_PAID",
    invoiceDaysAgo: 134,
    creditDays: 30,
    lastReceiptDaysAgo: 118,
    promisedInDays: null,
    modifiedDaysAgo: 118,
  },
  {
    dealerCode: "HMC-DL-0417",
    receivableId: "REC-0417-5503",
    partyType: "OEM",
    partyCode: "HERO-WTY",
    partyEmailId: "warranty.claims@heromotocorp.example",
    partyName: "Hero MotoCorp — warranty claims",
    invoiceNo: "WTY-0417-1188",
    invoiceAmt: "18650.00",
    receivedAmt: "11200.00",
    // Short-settled: the OEM paid part and rejected the rest. Somebody has to
    // rework the claim, and until they do this is neither collectable nor a
    // write-off. It has been in that state since March.
    againstType: "JOB_CARD",
    againstKey: "JC-0417-24119",
    narrationDesc: "Labour hours disallowed on claim line 3 — rework and resubmit",
    status: "PART_PAID",
    invoiceDaysAgo: 97,
    creditDays: 45,
    lastReceiptDaysAgo: 71,
    promisedInDays: null,
    modifiedDaysAgo: 71,
  },
  {
    dealerCode: "HMC-DL-0417",
    receivableId: "REC-0417-5504",
    partyType: "CUSTOMER",
    partyCode: "CUST-A-VERMA",
    partyEmailId: null,
    partyName: "Mr Ashok Verma",
    invoiceNo: "INV-0417-24101",
    invoiceAmt: "9840.00",
    receivedAmt: "0.00",
    // Said he would pay by a date that has now gone past. A broken promise is
    // not the same thing as an unchased bill, and a screen that treats them
    // alike sends somebody to ring a person they rang last week.
    againstType: "JOB_CARD",
    againstKey: "JC-0417-24124",
    narrationDesc: "Customer to transfer on salary date",
    status: "OPEN",
    invoiceDaysAgo: 41,
    creditDays: 15,
    lastReceiptDaysAgo: null,
    promisedInDays: -6,
    modifiedDaysAgo: 12,
  },
  {
    dealerCode: "HMC-DL-0417",
    receivableId: "REC-0417-5505",
    partyType: "INSURER",
    partyCode: "BAJAJ-ALZ",
    partyEmailId: "motorclaims@bajajallianz.example",
    partyName: "Bajaj Allianz General Insurance",
    invoiceNo: "INV-0417-24140",
    invoiceAmt: "21750.00",
    receivedAmt: "0.00",
    againstType: "JOB_CARD",
    againstKey: "JC-0417-24121",
    narrationDesc: "Cashless claim — approved, payment run pending",
    status: "OPEN",
    invoiceDaysAgo: 11,
    creditDays: 30,
    lastReceiptDaysAgo: null,
    promisedInDays: null,
    modifiedDaysAgo: 4,
  },
  {
    dealerCode: "HMC-DL-0417",
    receivableId: "REC-0417-5506",
    partyType: "FINANCIER",
    partyCode: "TVS-CREDIT",
    partyEmailId: "disbursements@tvscredit.example",
    partyName: "TVS Credit Services",
    invoiceNo: "INV-0417-24095",
    invoiceAmt: "74900.00",
    receivedAmt: "74900.00",
    againstType: "DEAL",
    againstKey: "HMC-DL-2026-000181",
    narrationDesc: "Loan disbursement against invoice",
    status: "SETTLED",
    invoiceDaysAgo: 29,
    creditDays: 7,
    lastReceiptDaysAgo: 22,
    promisedInDays: null,
    modifiedDaysAgo: 22,
  },

  // ── Deccan, Pune ─────────────────────────────────────────────────────────
  {
    dealerCode: "HMC-MH-1182",
    receivableId: "REC-1182-3301",
    partyType: "INSURER",
    partyCode: "ICICI-LOM",
    // The same insurer as REC-0417-5501, at the other outlet — same party code
    // and same mailbox, which is what lets the group figure be computed at all.
    // Each branch sees a bill worth chasing. Only the owner sees an insurer
    // holding ₹85,000 of the group's money, and that is a different conversation.
    partyEmailId: "motorclaims.north@icicilombard.example",
    partyName: "ICICI Lombard General Insurance",
    invoiceNo: "INV-1182-8840",
    invoiceAmt: "37300.00",
    receivedAmt: "0.00",
    againstType: "JOB_CARD",
    againstKey: "JC-MH-8841",
    narrationDesc: "Cashless claim — awaiting insurer approval",
    status: "OPEN",
    invoiceDaysAgo: 52,
    creditDays: 30,
    lastReceiptDaysAgo: null,
    promisedInDays: null,
    modifiedDaysAgo: 52,
  },
  {
    dealerCode: "HMC-MH-1182",
    receivableId: "REC-1182-3302",
    partyType: "CUSTOMER",
    partyCode: "CUST-M-JADHAV",
    partyEmailId: null,
    partyName: "Mrs Manisha Jadhav",
    invoiceNo: "INV-1182-8852",
    invoiceAmt: "4260.00",
    receivedAmt: "0.00",
    againstType: "JOB_CARD",
    againstKey: "JC-MH-8842",
    narrationDesc: "Periodic service",
    status: "OPEN",
    invoiceDaysAgo: 8,
    creditDays: 15,
    lastReceiptDaysAgo: null,
    promisedInDays: null,
    modifiedDaysAgo: 8,
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
RECEIVABLE_SEEDS.push(...generateReceivables(VOLUME.receivables));
