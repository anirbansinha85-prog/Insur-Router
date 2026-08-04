/**
 * Seeded registration files.
 *
 * Every record is fictional. As with the workshop, the set is chosen so each
 * file is stuck in a different way — a registration desk where everything flows
 * demonstrates nothing:
 *
 *   REG-0417-3309  READY_TO_FILE, no policy    ridden away on a temp reg that
 *                                              lapses in four days
 *   REG-0417-3308  PENDING_DOCS, no policy     customer owes an address proof
 *   REG-0417-3310  TAX_PAID, 6 days            tax remitted, file never lodged
 *   REG-0417-3307  READY_TO_FILE               road tax taken from the customer
 *                                              and still sitting in the account
 *   REG-0417-3304  REJECTED, 8 days            RTO objection, nobody reworked it
 *   REG-0417-3301  SUBMITTED, 19 days          nothing back, never chased
 *   REG-0417-3306  REGISTERED                  number allotted, no plate fitted
 *   REG-0417-3311  RC_RECEIVED, 21 days        card here, customer does not know
 *   REG-0417-3298  RC_RECEIVED, 47 days        the same, and much older
 *   REG-0417-3312  RC_DELIVERED                a closed file, for contrast
 *   REG-1182-1104  SUBMITTED                   second dealer, so nothing is global
 *   REG-1182-1101  RC_RECEIVED, 33 days        and the drawer is not one branch's
 *
 * Four of these point at deals the sales module already knows about, so the two
 * screens describe one dealership rather than two unrelated fixtures. The rest
 * are earlier sales — a registration desk is always carrying files from months
 * nobody is talking about any more, and that backlog is the point.
 *
 * Dates are relative to now and resolved at seed time, for the same reason as
 * the workshop: a file untouched for 47 days is the fixture, and letting it
 * drift with the calendar would turn it into a file untouched for a year, which
 * reads as a broken mock rather than a neglected drawer.
 */

import type { DmsRegnDoc, DmsRegnFile } from "./types.ts";

/** The document checklist a registration file is opened with. */
const DOCS = {
  FORM20: { docCode: "FORM20", docDesc: "Form 20 — application for registration, customer signed" },
  ADDR: { docCode: "ADDR_PROOF", docDesc: "Address proof (Aadhaar / utility bill)" },
  ID: { docCode: "ID_PROOF", docDesc: "Photo identity proof" },
  PHOTO: { docCode: "PHOTO", docDesc: "Passport photographs (2)" },
  PUC: { docCode: "PUC", docDesc: "Pollution under control certificate" },
  GST: { docCode: "GST_CERT", docDesc: "GST registration certificate (corporate buyer)" },
  BOARD: { docCode: "BOARD_RES", docDesc: "Board resolution authorising the purchase" },
} as const;

type DocKey = keyof typeof DOCS;

/**
 * `-1` means outstanding. Anything else is how many days ago it came in, so a
 * document received on the day the file opened and one that arrived a week late
 * are distinguishable — which is what makes a stalled file readable.
 */
function docs(...entries: Array<[DocKey, number]>): Array<Omit<DmsRegnDoc, "receivedDt"> & { receivedDaysAgo: number | null }> {
  return entries.map(([key, daysAgo], i) => ({
    seq: i + 1,
    ...DOCS[key],
    receivedFlg: daysAgo < 0 ? "N" : "Y",
    receivedDaysAgo: daysAgo < 0 ? null : daysAgo,
  }));
}

/** Individual buyer's standard checklist, all received `n` days ago. */
function standardDocs(daysAgo: number) {
  return docs(["FORM20", daysAgo], ["ADDR", daysAgo], ["ID", daysAgo], ["PHOTO", daysAgo], ["PUC", daysAgo]);
}

export interface RegnFileSeed
  extends Omit<
    DmsRegnFile,
    | "openedDt" | "tempRegExpiryDt" | "roadTaxCollectedDt" | "roadTaxPaidDt"
    | "submittedDt" | "regDt" | "hsrpFittedDt" | "rcReceivedDt" | "rcDeliveredDt"
    | "modifiedAt" | "docs"
  > {
  openedDaysAgo: number;
  /** Days from now. Negative is already lapsed. */
  tempRegExpiresInDays: number | null;
  roadTaxCollectedDaysAgo: number | null;
  roadTaxPaidDaysAgo: number | null;
  submittedDaysAgo: number | null;
  regDaysAgo: number | null;
  hsrpFittedDaysAgo: number | null;
  rcReceivedDaysAgo: number | null;
  rcDeliveredDaysAgo: number | null;
  modifiedDaysAgo: number;
  docSeeds: ReturnType<typeof docs>;
}

export const REGN_FILE_SEEDS: RegnFileSeed[] = [
  // ── Files against deals the sales module is also showing ──────────────────
  {
    regnFileNo: "REG-0417-3308",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000181",
    chassisNo: "MBLHAR0748NK41694",
    custName: "Mr Rohit Bansal",
    mobileNo: "9811443320",
    modelDesc: "Splendor Plus",
    // Two blockages at once, and only one of them is the customer's fault.
    status: "PENDING_DOCS",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/4471",
    policyNo: null,
    roadTaxAmt: "5540.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: null,
    objectionDesc: null,
    remarksDesc: "Address proof shows an old address. Customer to bring a current utility bill.",
    openedDaysAgo: 4,
    tempRegExpiresInDays: 26,
    roadTaxCollectedDaysAgo: 4,
    roadTaxPaidDaysAgo: null,
    submittedDaysAgo: null,
    regDaysAgo: null,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 4,
    docSeeds: docs(["FORM20", 4], ["ADDR", -1], ["ID", 4], ["PHOTO", 4], ["PUC", 4]),
  },
  {
    regnFileNo: "REG-0417-3309",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000182",
    chassisNo: "MBLKAR0921NK18337",
    custName: "Mr Imran Qureshi",
    mobileNo: "9871220054",
    modelDesc: "Xpulse 200 4V",
    // The sharpest row in the fixture. Paperwork is complete, road tax is paid,
    // and the file cannot move because there is no policy — while the customer
    // rides on a temporary registration that lapses in four days.
    status: "READY_TO_FILE",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/4402",
    policyNo: null,
    roadTaxAmt: "10836.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: null,
    objectionDesc: null,
    remarksDesc: "Held for insurance. Temporary registration issued at delivery.",
    openedDaysAgo: 26,
    tempRegExpiresInDays: 4,
    roadTaxCollectedDaysAgo: 26,
    roadTaxPaidDaysAgo: 24,
    submittedDaysAgo: null,
    regDaysAgo: null,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 24,
    docSeeds: standardDocs(26),
  },
  {
    regnFileNo: "REG-0417-3310",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000183",
    chassisNo: "MBLVDA0114NK07219",
    custName: "Ms Ananya Iyer",
    mobileNo: "9899017762",
    modelDesc: "Vida V2 Plus",
    // Nothing is blocking this one. Tax paid six days ago, file simply never
    // walked to the counter.
    status: "TAX_PAID",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/4488",
    policyNo: "SIM-BAJAJ-API-MSD9PEXS",
    roadTaxAmt: "0.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: null,
    objectionDesc: null,
    remarksDesc: "Electric two-wheeler — road tax exempt in Delhi. File ready for submission.",
    openedDaysAgo: 8,
    tempRegExpiresInDays: 22,
    roadTaxCollectedDaysAgo: null,
    roadTaxPaidDaysAgo: 6,
    submittedDaysAgo: null,
    regDaysAgo: null,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 6,
    docSeeds: standardDocs(8),
  },
  {
    regnFileNo: "REG-1182-1104",
    dealerCode: "HMC-MH-1182",
    dealId: "HMC-MH-2026-000184",
    chassisNo: "MBLDST0125NK55210",
    custName: "M/s Greenmile Logistics Private Limited",
    mobileNo: "9822440091",
    modelDesc: "Destini 125",
    // Corporate buyer: two extra documents, and the board resolution is the one
    // that always arrives last.
    status: "PENDING_DOCS",
    rtoCode: "MH12",
    rtoOfficeDesc: "RTO Pune (Sangamwadi)",
    agentEmpCode: "RT-1182-01",
    tempRegNo: null,
    policyNo: null,
    roadTaxAmt: "8240.00",
    hsrpAmt: "450.00",
    agentFeeAmt: "1100.00",
    regNo: null,
    objectionDesc: null,
    remarksDesc: "Awaiting board resolution from the company secretary.",
    openedDaysAgo: 5,
    tempRegExpiresInDays: null,
    roadTaxCollectedDaysAgo: 5,
    roadTaxPaidDaysAgo: null,
    submittedDaysAgo: null,
    regDaysAgo: null,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 5,
    docSeeds: docs(["FORM20", 5], ["ADDR", 5], ["ID", 5], ["PHOTO", 5], ["PUC", 5], ["GST", 5], ["BOARD", -1]),
  },
  {
    regnFileNo: "REG-0417-3311",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000185",
    chassisNo: "MBLHFD0097NK30118",
    custName: "Mr Devender Singh Rathee",
    mobileNo: "9871004412",
    modelDesc: "HF Deluxe",
    // The DMS calls this deal DELIVERED and stops caring. The registration
    // certificate has been in the drawer for three weeks.
    status: "RC_RECEIVED",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/3980",
    policyNo: "OG-27-1201-1847-00004471",
    roadTaxAmt: "4361.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: "DL03SR4471",
    objectionDesc: null,
    remarksDesc: null,
    openedDaysAgo: 62,
    tempRegExpiresInDays: -32,
    roadTaxCollectedDaysAgo: 62,
    roadTaxPaidDaysAgo: 60,
    submittedDaysAgo: 57,
    regDaysAgo: 34,
    hsrpFittedDaysAgo: 30,
    rcReceivedDaysAgo: 21,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 21,
    docSeeds: standardDocs(62),
  },

  // ── Earlier sales the registration desk is still carrying ─────────────────
  {
    regnFileNo: "REG-0417-3298",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000164",
    chassisNo: "MBLHAR0748NK39902",
    custName: "Mrs Sunita Chauhan",
    mobileNo: "9810337719",
    modelDesc: "Destini 125",
    // Forty-seven days. Nobody is looking for it, because as far as every
    // screen in the dealership is concerned this sale closed in June.
    status: "RC_RECEIVED",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/3711",
    policyNo: "HDFC/2W/2026/0088142",
    roadTaxAmt: "5788.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: "DL03SQ8817",
    objectionDesc: null,
    remarksDesc: null,
    openedDaysAgo: 88,
    tempRegExpiresInDays: -58,
    roadTaxCollectedDaysAgo: 88,
    roadTaxPaidDaysAgo: 86,
    submittedDaysAgo: 82,
    regDaysAgo: 58,
    hsrpFittedDaysAgo: 54,
    rcReceivedDaysAgo: 47,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 47,
    docSeeds: standardDocs(88),
  },
  {
    regnFileNo: "REG-0417-3301",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000171",
    chassisNo: "MBLHAR0748NK40337",
    custName: "Mr Naveen Kohli",
    mobileNo: "9868220145",
    modelDesc: "Xtreme 125R",
    // Nineteen days at the RTO with nothing back. A normal file returns in
    // about a week, so this one has a problem nobody has gone to ask about.
    status: "SUBMITTED",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/4106",
    policyNo: "ICICI/TW/26/551903",
    roadTaxAmt: "7940.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: null,
    objectionDesc: null,
    remarksDesc: null,
    openedDaysAgo: 27,
    tempRegExpiresInDays: 3,
    roadTaxCollectedDaysAgo: 27,
    roadTaxPaidDaysAgo: 25,
    submittedDaysAgo: 19,
    regDaysAgo: null,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 19,
    docSeeds: standardDocs(27),
  },
  {
    regnFileNo: "REG-0417-3304",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000176",
    chassisNo: "MBLHAR0748NK40881",
    custName: "Mr Sandeep Tomar",
    mobileNo: "9911447703",
    modelDesc: "Splendor Plus",
    // Rejected eight days ago. The agent brought the file back, put it on the
    // desk, and it has not moved since.
    status: "REJECTED",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/4231",
    policyNo: "TATA/2W/26/771208",
    roadTaxAmt: "5540.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: null,
    objectionDesc: "Name on Form 20 does not match the address proof. Resubmit with an affidavit.",
    remarksDesc: null,
    openedDaysAgo: 21,
    tempRegExpiresInDays: -3,
    roadTaxCollectedDaysAgo: 21,
    roadTaxPaidDaysAgo: 19,
    submittedDaysAgo: 14,
    regDaysAgo: null,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 8,
    docSeeds: standardDocs(21),
  },
  {
    regnFileNo: "REG-0417-3306",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000179",
    chassisNo: "MBLKAR0921NK18110",
    custName: "Ms Farah Ansari",
    mobileNo: "9990332218",
    modelDesc: "Xpulse 200 4V",
    // Registered, so every report shows it as done. The vehicle is on the road
    // without a high-security plate, which is the customer's fine to pay.
    status: "REGISTERED",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/4290",
    policyNo: "BAJAJ/OG-27-1201-1847-00003318",
    roadTaxAmt: "10836.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: "DL03SR2210",
    objectionDesc: null,
    remarksDesc: null,
    openedDaysAgo: 30,
    tempRegExpiresInDays: 0,
    roadTaxCollectedDaysAgo: 30,
    roadTaxPaidDaysAgo: 28,
    submittedDaysAgo: 24,
    regDaysAgo: 11,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 11,
    docSeeds: standardDocs(30),
  },
  {
    regnFileNo: "REG-0417-3307",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000180",
    chassisNo: "MBLHFD0097NK30442",
    custName: "Mrs Poonam Sethi",
    mobileNo: "9873661140",
    modelDesc: "HF Deluxe",
    // The money one. Road tax was taken from the customer at invoice sixteen
    // days ago and has not been paid to the state. It is not the dealer's
    // money, and the customer's file cannot move until it goes.
    status: "READY_TO_FILE",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: null,
    tempRegNo: "DL03TR26/4318",
    policyNo: "HDFC/2W/2026/0091077",
    roadTaxAmt: "4361.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: null,
    objectionDesc: null,
    remarksDesc: null,
    openedDaysAgo: 16,
    tempRegExpiresInDays: 14,
    roadTaxCollectedDaysAgo: 16,
    roadTaxPaidDaysAgo: null,
    submittedDaysAgo: null,
    regDaysAgo: null,
    hsrpFittedDaysAgo: null,
    rcReceivedDaysAgo: null,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 16,
    docSeeds: standardDocs(16),
  },
  {
    regnFileNo: "REG-0417-3312",
    dealerCode: "HMC-DL-0417",
    dealId: "HMC-DL-2026-000186",
    chassisNo: "MBLHFD0097NK30559",
    custName: "Mr Yogesh Malik",
    mobileNo: "9810992277",
    modelDesc: "HF Deluxe",
    // The file that went right, so the others have something to be measured
    // against. Twenty-nine days invoice to certificate in the customer's hand.
    status: "RC_DELIVERED",
    rtoCode: "DL03",
    rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
    agentEmpCode: "RT-0417-02",
    tempRegNo: "DL03TR26/4355",
    policyNo: "ICICI/TW/26/558820",
    roadTaxAmt: "4361.00",
    hsrpAmt: "425.00",
    agentFeeAmt: "900.00",
    regNo: "DL03SR3902",
    objectionDesc: null,
    remarksDesc: null,
    openedDaysAgo: 41,
    tempRegExpiresInDays: -11,
    roadTaxCollectedDaysAgo: 41,
    roadTaxPaidDaysAgo: 40,
    submittedDaysAgo: 36,
    regDaysAgo: 20,
    hsrpFittedDaysAgo: 17,
    rcReceivedDaysAgo: 14,
    rcDeliveredDaysAgo: 12,
    modifiedDaysAgo: 12,
    docSeeds: standardDocs(41),
  },

  // ── Deccan, so nothing on this screen is accidentally one branch's ────────
  {
    regnFileNo: "REG-1182-1101",
    dealerCode: "HMC-MH-1182",
    dealId: "HMC-MH-2026-000177",
    chassisNo: "MBLHAR0748PK21990",
    custName: "Mr Sameer Joshi",
    mobileNo: "9823114455",
    modelDesc: "Vida V2 Plus",
    status: "RC_RECEIVED",
    rtoCode: "MH12",
    rtoOfficeDesc: "RTO Pune (Sangamwadi)",
    agentEmpCode: "RT-1182-01",
    tempRegNo: "MH12TR26/0881",
    policyNo: "BAJAJ/OG-27-1201-1847-00002204",
    roadTaxAmt: "0.00",
    hsrpAmt: "450.00",
    agentFeeAmt: "1100.00",
    regNo: "MH12RQ7714",
    objectionDesc: null,
    remarksDesc: null,
    openedDaysAgo: 71,
    tempRegExpiresInDays: -41,
    roadTaxCollectedDaysAgo: null,
    roadTaxPaidDaysAgo: 69,
    submittedDaysAgo: 64,
    regDaysAgo: 44,
    hsrpFittedDaysAgo: 40,
    rcReceivedDaysAgo: 33,
    rcDeliveredDaysAgo: null,
    modifiedDaysAgo: 33,
    docSeeds: standardDocs(71),
  },
];
