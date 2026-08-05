/**
 * Seeded workshop: staff and job cards.
 *
 * Every record is fictional. The seed set is chosen so each job card is stuck in
 * a different way, because a workshop where everything flows teaches nothing:
 *
 *   JC-0417-24118  AWAITING_PARTS, 3 days   part not on shelf, customer not told
 *   JC-0417-24119  AWAITING_APPROVAL, 2 days estimate grew, nobody called
 *   JC-0417-24120  READY, 4 days             finished; customer does not know
 *   JC-0417-24121  IN_PROGRESS, promise today
 *   JC-0417-24122  OPEN, booked today        the normal case
 *   JC-0417-24123  DELIVERED, PSF done       a closed loop, for contrast
 *   JC-0417-24124  DELIVERED, PSF never made the follow-up nobody had time for
 *   JC-0417-24125  AWAITING_PARTS, 9 days    the one that has been forgotten
 *   JC-MH-8841     IN_PROGRESS               second dealer, so nothing is global
 *   JC-MH-8842     READY, 2 days
 *
 * Work email addresses are on the `.example` reserved TLD, which by RFC 2606
 * can never resolve or receive mail. That is deliberate: these are the
 * addresses DDMS's internal notifications are aimed at, and a fixture that
 * could accidentally deliver to a real mailbox is a fixture waiting to embarrass
 * somebody.
 *
 * Dates are written relative to a fixed anchor and shifted to "now" at seed
 * time, so a demo run a month later still shows a part outstanding for nine
 * days rather than forty. Ageing is the whole point of these rows; letting it
 * drift with the calendar would destroy the fixture.
 */

import type {
  DmsEmployee,
  DmsJobCard,
  DmsJobCardLabour,
  DmsJobCardPart,
} from "./types.ts";
import { generateJobCards, GENERATED_EMPLOYEES, VOLUME } from "./generate.ts";

export const EMPLOYEES: DmsEmployee[] = [
  // ── Saraswati, New Delhi ──────────────────────────────────────────────────
  { empCode: "SA-0417-19", empName: "Vikram Chandel", dealerCode: "HMC-DL-0417", role: "SALES_EXEC", doj: "11-04-2022", dol: null, activeFlg: "Y", mobileNo: "9810044219", emailId: "vikram.chandel@saraswatiauto.example" },
  { empCode: "SA-0417-23", empName: "Neha Grover", dealerCode: "HMC-DL-0417", role: "SALES_EXEC", doj: "02-01-2024", dol: null, activeFlg: "Y", mobileNo: "9810044223", emailId: "neha.grover@saraswatiauto.example" },
  // Three departures inside six months on a floor of nine. This is the
  // attrition the owner feels and cannot currently quantify.
  { empCode: "SA-0417-21", empName: "Imtiaz Khan", dealerCode: "HMC-DL-0417", role: "SALES_EXEC", doj: "19-08-2023", dol: "28-02-2026", activeFlg: "N", mobileNo: null, emailId: null },
  { empCode: "AD-0417-04", empName: "Sunil Rawat", dealerCode: "HMC-DL-0417", role: "SERVICE_ADVISOR", doj: "07-06-2021", dol: null, activeFlg: "Y", mobileNo: "9810044204", emailId: "sunil.rawat@saraswatiauto.example" },
  { empCode: "AD-0417-07", empName: "Farida Sheikh", dealerCode: "HMC-DL-0417", role: "SERVICE_ADVISOR", doj: "15-03-2025", dol: "30-06-2026", activeFlg: "N", mobileNo: null, emailId: null },
  { empCode: "TE-0417-11", empName: "Ramesh Yadav", dealerCode: "HMC-DL-0417", role: "TECHNICIAN", doj: "22-09-2020", dol: null, activeFlg: "Y", mobileNo: "9810044211", emailId: "ramesh.yadav@saraswatiauto.example" },
  { empCode: "TE-0417-14", empName: "Dinesh Sahu", dealerCode: "HMC-DL-0417", role: "TECHNICIAN", doj: "05-05-2024", dol: null, activeFlg: "Y", mobileNo: "9810044214", emailId: "dinesh.sahu@saraswatiauto.example" },
  { empCode: "TE-0417-16", empName: "Aslam Qureshi", dealerCode: "HMC-DL-0417", role: "TECHNICIAN", doj: "12-11-2024", dol: "15-05-2026", activeFlg: "N", mobileNo: null, emailId: null },
  { empCode: "MG-0417-01", empName: "Anand Saraswat", dealerCode: "HMC-DL-0417", role: "MANAGER", doj: "01-04-2018", dol: null, activeFlg: "Y", mobileNo: "9810044201", emailId: "anand.saraswat@saraswatiauto.example" },
  // One RTO agent for the whole branch, which is normal and is also why the
  // registration backlog is one person deep.
  { empCode: "RT-0417-02", empName: "Jaswinder Sethi", dealerCode: "HMC-DL-0417", role: "RTO_AGENT", doj: "03-03-2019", dol: null, activeFlg: "Y", mobileNo: "9810044202", emailId: "jaswinder.sethi@saraswatiauto.example" },
  { empCode: "AC-0417-06", empName: "Meera Joshi", dealerCode: "HMC-DL-0417", role: "ACCOUNTS", doj: "18-11-2021", dol: null, activeFlg: "Y", mobileNo: "9810044206", emailId: "meera.joshi@saraswatiauto.example" },

  // ── Deccan, Pune ──────────────────────────────────────────────────────────
  { empCode: "SA-1182-03", empName: "Prasad Kulkarni", dealerCode: "HMC-MH-1182", role: "SALES_EXEC", doj: "14-07-2023", dol: null, activeFlg: "Y", mobileNo: "9822011203", emailId: "prasad.kulkarni@deccantw.example" },
  { empCode: "AD-1182-02", empName: "Sneha Deshmukh", dealerCode: "HMC-MH-1182", role: "SERVICE_ADVISOR", doj: "09-02-2022", dol: null, activeFlg: "Y", mobileNo: "9822011202", emailId: "sneha.deshmukh@deccantw.example" },
  { empCode: "TE-1182-05", empName: "Balaji Pawar", dealerCode: "HMC-MH-1182", role: "TECHNICIAN", doj: "30-10-2021", dol: null, activeFlg: "Y", mobileNo: "9822011205", emailId: "balaji.pawar@deccantw.example" },
  { empCode: "RT-1182-01", empName: "Ganesh Shinde", dealerCode: "HMC-MH-1182", role: "RTO_AGENT", doj: "21-06-2020", dol: null, activeFlg: "Y", mobileNo: "9822011201", emailId: "ganesh.shinde@deccantw.example" },
];

/** Labour operation codes, priced per hour. Rates are invented. */
const LAB = {
  PMS: { labourCode: "L-PMS-01", labourDesc: "Periodic maintenance service", hrs: 1.5, rateAmt: "350.00" },
  BRAKE: { labourCode: "L-BRK-04", labourDesc: "Brake shoe replacement and adjustment", hrs: 0.8, rateAmt: "350.00" },
  CLUTCH: { labourCode: "L-CLT-02", labourDesc: "Clutch plate replacement", hrs: 2.0, rateAmt: "400.00" },
  ELEC: { labourCode: "L-ELE-09", labourDesc: "Electrical diagnosis — starting circuit", hrs: 1.0, rateAmt: "400.00" },
  BODY: { labourCode: "L-BDY-17", labourDesc: "Panel refit and alignment", hrs: 3.5, rateAmt: "450.00" },
  WASH: { labourCode: "L-WSH-01", labourDesc: "Wash and polish", hrs: 0.5, rateAmt: "200.00" },
} as const;

function labour(...keys: Array<keyof typeof LAB>): DmsJobCardLabour[] {
  return keys.map((k, i) => ({ seq: i + 1, ...LAB[k] }));
}

/** Part master rows the seeded job cards draw on. */
export const PARTS = {
  "HR-OIL-10W30": { partDesc: "Engine oil 10W30 (900ml)", mrpAmt: "410.00" },
  "HR-FLT-OIL-97": { partDesc: "Oil filter element 97cc", mrpAmt: "145.00" },
  "HR-BRK-SHOE-R": { partDesc: "Brake shoe set — rear", mrpAmt: "520.00" },
  "HR-CLT-PLATE-125": { partDesc: "Clutch plate set 125cc", mrpAmt: "1240.00" },
  "HR-SPK-PLUG": { partDesc: "Spark plug", mrpAmt: "180.00" },
  "HR-BAT-5AH": { partDesc: "Battery 12V 5Ah", mrpAmt: "1580.00" },
  "HR-PNL-SIDE-L": { partDesc: "Side panel — left, painted", mrpAmt: "2340.00" },
  "VID-BRK-PAD-F": { partDesc: "Brake pad set — front, Vida", mrpAmt: "890.00" },
} as const;

type PartNo = keyof typeof PARTS;

function part(
  seq: number,
  partNo: PartNo,
  qty: number,
  issued: boolean,
  warranty = false,
): DmsJobCardPart {
  return {
    seq,
    partNo,
    partDesc: PARTS[partNo].partDesc,
    qty,
    rateAmt: PARTS[partNo].mrpAmt,
    warrantyFlg: warranty ? "Y" : "N",
    issuedFlg: issued ? "Y" : "N",
  };
}

/**
 * A job card written in *days relative to now*, resolved at seed time.
 *
 * `dayOffset` is negative for the past. A card opened 9 days ago with a part
 * still unissued reads as nine days of nobody chasing it, whenever the demo is
 * run.
 */
export interface JobCardSeed extends Omit<DmsJobCard, "jcDt" | "promisedDt" | "actualCloseDt" | "modifiedAt"> {
  openedDaysAgo: number;
  promisedDaysFromOpen: number;
  closedDaysAgo: number | null;
  modifiedDaysAgo: number;
  psfDaysAgo: number | null;
}

export const JOB_CARD_SEEDS: JobCardSeed[] = [
  {
    jcNo: "JC-0417-24118",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK39114",
    regNo: "DL3SCK4471",
    custId: "CUST-0417-71204",
    custName: "Mrs Kavita Sharma",
    mobileNo: "9811207744",
    modelDesc: "Splendor Plus",
    odometerKm: 18_420,
    jcType: "PAID",
    // The part is not on the shelf and the customer has not been told. Three
    // days is long enough that they have started assuming the worst.
    status: "AWAITING_PARTS",
    advisorEmpCode: "AD-0417-04",
    technicianEmpCode: "TE-0417-11",
    bayNo: "B-3",
    complaintDesc: "Rear brake not holding, noise on braking",
    observationDesc: "Rear brake shoes worn beyond limit. Shoe set out of stock.",
    estimateAmt: "1180.00",
    approvedAmt: null,
    finalAmt: null,
    labour: labour("BRAKE"),
    parts: [part(1, "HR-BRK-SHOE-R", 1, false)],
    psf: null,
    openedDaysAgo: 3,
    promisedDaysFromOpen: 1,
    closedDaysAgo: null,
    modifiedDaysAgo: 3,
    psfDaysAgo: null,
  },
  {
    jcNo: "JC-0417-24119",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK38220",
    regNo: "DL8SBX1192",
    custId: "CUST-0417-66910",
    custName: "Mr Arjun Menon",
    mobileNo: "9910442210",
    modelDesc: "Xtreme 125R",
    odometerKm: 24_115,
    jcType: "RUNNING_REPAIR",
    // Estimate grew once the clutch was opened up. Work stops until someone
    // rings the customer, and nobody has.
    status: "AWAITING_APPROVAL",
    advisorEmpCode: "AD-0417-04",
    technicianEmpCode: "TE-0417-14",
    bayNo: "B-1",
    complaintDesc: "Clutch slipping, poor pickup",
    observationDesc: "Clutch plates glazed. Revised estimate exceeds original by 1,640.",
    estimateAmt: "1450.00",
    approvedAmt: null,
    finalAmt: null,
    labour: labour("CLUTCH"),
    parts: [part(1, "HR-CLT-PLATE-125", 1, true), part(2, "HR-OIL-10W30", 1, true)],
    psf: null,
    openedDaysAgo: 2,
    promisedDaysFromOpen: 1,
    closedDaysAgo: null,
    modifiedDaysAgo: 2,
    psfDaysAgo: null,
  },
  {
    jcNo: "JC-0417-24120",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK37655",
    regNo: "DL4SDA8830",
    custId: "CUST-0417-59331",
    custName: "Mr Satish Verma",
    mobileNo: "9873001188",
    modelDesc: "HF Deluxe",
    odometerKm: 31_090,
    jcType: "PAID",
    // Finished four days ago. The bay is occupied, the customer is on a bus,
    // and the invoice is not raised. Nobody made the call.
    status: "READY",
    advisorEmpCode: "AD-0417-04",
    technicianEmpCode: "TE-0417-11",
    bayNo: "B-2",
    complaintDesc: "Periodic service, headlamp dim",
    observationDesc: "Service completed. Battery replaced.",
    estimateAmt: "2410.00",
    approvedAmt: "2410.00",
    finalAmt: "2390.00",
    labour: labour("PMS", "ELEC"),
    parts: [part(1, "HR-OIL-10W30", 1, true), part(2, "HR-FLT-OIL-97", 1, true), part(3, "HR-BAT-5AH", 1, true)],
    psf: null,
    openedDaysAgo: 5,
    promisedDaysFromOpen: 1,
    closedDaysAgo: null,
    modifiedDaysAgo: 4,
    psfDaysAgo: null,
  },
  {
    jcNo: "JC-0417-24121",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK40012",
    regNo: "DL1SEE2204",
    custId: "CUST-0417-80112",
    custName: "Ms Priya Nair",
    mobileNo: "9990114477",
    modelDesc: "Destini 125",
    odometerKm: 9_240,
    jcType: "FREE",
    status: "IN_PROGRESS",
    advisorEmpCode: "AD-0417-04",
    technicianEmpCode: "TE-0417-14",
    bayNo: "B-4",
    complaintDesc: "Third free service",
    observationDesc: null,
    estimateAmt: "640.00",
    approvedAmt: "640.00",
    finalAmt: null,
    labour: labour("PMS", "WASH"),
    parts: [part(1, "HR-OIL-10W30", 1, true), part(2, "HR-SPK-PLUG", 1, true)],
    psf: null,
    openedDaysAgo: 0,
    promisedDaysFromOpen: 0,
    closedDaysAgo: null,
    modifiedDaysAgo: 0,
    psfDaysAgo: null,
  },
  {
    jcNo: "JC-0417-24122",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK41103",
    regNo: "DL9SFF7761",
    custId: "CUST-0417-83440",
    custName: "Mr Harpreet Singh",
    mobileNo: "9818224466",
    modelDesc: "Xpulse 200 4V",
    odometerKm: 4_870,
    jcType: "FREE",
    status: "OPEN",
    advisorEmpCode: "AD-0417-04",
    technicianEmpCode: null,
    bayNo: null,
    complaintDesc: "Second free service, chain noise",
    observationDesc: null,
    estimateAmt: "520.00",
    approvedAmt: null,
    finalAmt: null,
    labour: labour("PMS"),
    parts: [part(1, "HR-OIL-10W30", 1, true)],
    psf: null,
    openedDaysAgo: 0,
    promisedDaysFromOpen: 1,
    closedDaysAgo: null,
    modifiedDaysAgo: 0,
    psfDaysAgo: null,
  },
  {
    jcNo: "JC-0417-24123",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK36004",
    regNo: "DL2SCC5519",
    custId: "CUST-0417-44120",
    custName: "Mr Gopal Krishnan",
    mobileNo: "9871119933",
    modelDesc: "Splendor Plus",
    odometerKm: 41_770,
    jcType: "PAID",
    // The one that went right, so the others have something to be measured
    // against. Follow-up made two days after delivery, score recorded.
    status: "DELIVERED",
    advisorEmpCode: "AD-0417-04",
    technicianEmpCode: "TE-0417-11",
    bayNo: "B-2",
    complaintDesc: "Periodic service",
    observationDesc: "Completed, road tested.",
    estimateAmt: "1290.00",
    approvedAmt: "1290.00",
    finalAmt: "1265.00",
    labour: labour("PMS", "WASH"),
    parts: [part(1, "HR-OIL-10W30", 1, true), part(2, "HR-FLT-OIL-97", 1, true)],
    psf: { callDt: null, satisfactionScore: 9, complaintFlg: "N", remarksDesc: "Satisfied. Asked about extended warranty." },
    openedDaysAgo: 11,
    promisedDaysFromOpen: 1,
    closedDaysAgo: 10,
    modifiedDaysAgo: 10,
    psfDaysAgo: 8,
  },
  {
    jcNo: "JC-0417-24124",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK35281",
    regNo: "DL7SBB3040",
    custId: "CUST-0417-39887",
    custName: "Mrs Anita Bhatt",
    mobileNo: "9868774411",
    modelDesc: "Destini 125",
    odometerKm: 22_360,
    jcType: "PAID",
    // Delivered fourteen days ago, follow-up never made. The advisor who owned
    // it left. This is what a departure costs, in one row.
    status: "DELIVERED",
    advisorEmpCode: "AD-0417-07",
    technicianEmpCode: "TE-0417-16",
    bayNo: "B-3",
    complaintDesc: "Starting trouble, service due",
    observationDesc: "Battery replaced under warranty. Service completed.",
    estimateAmt: "980.00",
    approvedAmt: "980.00",
    finalAmt: "940.00",
    labour: labour("PMS", "ELEC"),
    parts: [part(1, "HR-BAT-5AH", 1, true, true), part(2, "HR-OIL-10W30", 1, true)],
    psf: null,
    openedDaysAgo: 15,
    promisedDaysFromOpen: 1,
    closedDaysAgo: 14,
    modifiedDaysAgo: 14,
    psfDaysAgo: null,
  },
  {
    jcNo: "JC-0417-24125",
    dealerCode: "HMC-DL-0417",
    chassisNo: "MBLHAR0748NK33902",
    regNo: "DL5SAA1177",
    custId: "CUST-0417-30115",
    custName: "Mr Deepak Ahuja",
    mobileNo: "9811556622",
    modelDesc: "Xtreme 125R",
    odometerKm: 38_540,
    jcType: "ACCIDENT",
    // Nine days. A painted panel on back order, an owner who has stopped
    // ringing, and a bay that has been unusable for over a week.
    status: "AWAITING_PARTS",
    advisorEmpCode: "AD-0417-07",
    technicianEmpCode: "TE-0417-11",
    bayNo: "B-5",
    complaintDesc: "Left side damage after fall",
    observationDesc: "Side panel to be replaced. Painted panel on back order from OEM.",
    estimateAmt: "4120.00",
    approvedAmt: "4120.00",
    finalAmt: null,
    labour: labour("BODY"),
    parts: [part(1, "HR-PNL-SIDE-L", 1, false)],
    psf: null,
    openedDaysAgo: 9,
    promisedDaysFromOpen: 3,
    closedDaysAgo: null,
    modifiedDaysAgo: 6,
    psfDaysAgo: null,
  },

  // ── Deccan — so nothing in the worklist is accidentally global ────────────
  {
    jcNo: "JC-MH-8841",
    dealerCode: "HMC-MH-1182",
    chassisNo: "MBLHAR0748PK21044",
    regNo: "MH12QR8890",
    custId: "CUST-1182-11002",
    custName: "Mr Sameer Joshi",
    mobileNo: "9823114455",
    modelDesc: "Vida V2 Plus",
    odometerKm: 6_110,
    jcType: "WARRANTY",
    status: "IN_PROGRESS",
    advisorEmpCode: "AD-1182-02",
    technicianEmpCode: "TE-1182-05",
    bayNo: "P-1",
    complaintDesc: "Front brake squeal",
    observationDesc: "Pads replaced under warranty.",
    estimateAmt: "0.00",
    approvedAmt: "0.00",
    finalAmt: null,
    labour: labour("BRAKE"),
    parts: [part(1, "VID-BRK-PAD-F", 1, true, true)],
    psf: null,
    openedDaysAgo: 1,
    promisedDaysFromOpen: 1,
    closedDaysAgo: null,
    modifiedDaysAgo: 0,
    psfDaysAgo: null,
  },
  {
    jcNo: "JC-MH-8842",
    dealerCode: "HMC-MH-1182",
    chassisNo: "MBLHAR0748PK20551",
    regNo: "MH14ST2201",
    custId: "CUST-1182-10440",
    custName: "Mrs Rekha Patil",
    mobileNo: "9823117788",
    modelDesc: "HF Deluxe",
    odometerKm: 19_880,
    jcType: "PAID",
    status: "READY",
    advisorEmpCode: "AD-1182-02",
    technicianEmpCode: "TE-1182-05",
    bayNo: "P-2",
    complaintDesc: "Periodic service",
    observationDesc: "Completed.",
    estimateAmt: "1120.00",
    approvedAmt: "1120.00",
    finalAmt: "1110.00",
    labour: labour("PMS"),
    parts: [part(1, "HR-OIL-10W30", 1, true), part(2, "HR-FLT-OIL-97", 1, true)],
    psf: null,
    openedDaysAgo: 3,
    promisedDaysFromOpen: 1,
    closedDaysAgo: null,
    modifiedDaysAgo: 2,
    psfDaysAgo: null,
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
JOB_CARD_SEEDS.push(...generateJobCards(VOLUME.jobCards));

/*
 * And the rest of the branch.
 *
 * The eleven above were written to make three departures visible on a small
 * floor, and they stay exactly as they are. Ninety job cards and a hundred and
 * thirty enquiries need more people behind them than two salesmen and one
 * advisor, or the workload figures the queue and the agent both reason about
 * describe a dealership nobody would recognise.
 */
EMPLOYEES.push(...GENERATED_EMPLOYEES);
