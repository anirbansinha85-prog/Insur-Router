/**
 * Seeded enquiries.
 *
 * Every record is fictional. As with the workshop, each row is stuck a
 * different way, and the ones that matter are the two nobody at the dealership
 * can currently see:
 *
 *   ENQ-0417-9101  OEM lead, 4 hours old, NEVER CONTACTED   the SLA is already blown
 *   ENQ-0417-9102  OEM lead, 14 minutes old, uncontacted    16 minutes left on the clock
 *   ENQ-0417-9103  owner left the company in February       a lead with nobody on it
 *   ENQ-0417-9104  owner left in June, quoted, then silence  the expensive version of the same
 *   ENQ-0417-9105  contacted in 4 minutes, test ride booked  what good looks like
 *   ENQ-0417-9106  negotiation, follow-up due today          on track
 *   ENQ-0417-9107  follow-up 9 days overdue, cold            slow decay
 *   ENQ-0417-9108  booked, converted to a real deal          the closed loop
 *   ENQ-0417-9109  lost, reason recorded                     for contrast
 *   ENQ-MH-4401    second dealer, so nothing is global
 *
 * Offsets are relative to seed time for the same reason the job cards are: an
 * SLA measured in minutes is meaningless if the fixture is dated.
 */

import type {
  DmsEnquiry,
  DmsEnquiryFollowUp,
  DmsEnquiryGrade,
  DmsEnquirySource,
  DmsEnquiryStage,
  DmsTestRide,
} from "./types.ts";
import { generateEnquiries, VOLUME } from "./generate.ts";

export interface EnquirySeed
  extends Omit<
    DmsEnquiry,
    "enqDt" | "firstContactAt" | "lastContactDt" | "nextFollowUpDt" | "modifiedAt" | "followUps" | "testRides"
  > {
  /** Minutes since the enquiry arrived. Minutes, not days — the OEM clock is short. */
  arrivedMinutesAgo: number;
  /** Minutes after arrival that someone first made contact. Null means never. */
  firstContactAfterMinutes: number | null;
  lastContactDaysAgo: number | null;
  /** Negative is overdue. */
  nextFollowUpInDays: number | null;
  modifiedMinutesAgo: number;
  followUpSeeds: Array<{ fuId: string; dueInDays: number; doneDaysAgo: number | null; outcomeDesc: string | null; empCode: string }>;
  testRideSeeds: Array<{ trId: string; modelCode: string; scheduledMinutesAgo: number; doneFlg: "Y" | "N" }>;
}

function enq(
  enqId: string,
  dealerCode: string,
  source: DmsEnquirySource,
  grade: DmsEnquiryGrade,
  stage: DmsEnquiryStage,
  custName: string,
  mobileNo: string,
  modelCodeInterest: string,
  assignedEmpCode: string,
  rest: Partial<EnquirySeed> & Pick<EnquirySeed, "arrivedMinutesAgo" | "firstContactAfterMinutes" | "modifiedMinutesAgo">,
): EnquirySeed {
  return {
    enqId,
    dealerCode,
    source,
    grade,
    stage,
    custName,
    mobileNo,
    emailId: null,
    cityDesc: null,
    modelCodeInterest,
    assignedEmpCode,
    lostReasonDesc: null,
    convertedDealId: null,
    lastContactDaysAgo: null,
    nextFollowUpInDays: null,
    followUpSeeds: [],
    testRideSeeds: [],
    ...rest,
  };
}

export const ENQUIRY_SEEDS: EnquirySeed[] = [
  // The headline. An OEM-generated lead that has been sitting for four hours
  // with nobody on it — the response window closed three and a half hours ago,
  // and the dealership has no screen anywhere that says so.
  enq("ENQ-0417-9101", "HMC-DL-0417", "OEM_PORTAL", "HOT", "NEW", "Mr Nitin Rawal", "9811340077", "HER-XPL-200", "SA-0417-23", {
    arrivedMinutesAgo: 244,
    firstContactAfterMinutes: null,
    modifiedMinutesAgo: 244,
    emailId: "nitin.rawal@example.in",
    cityDesc: "New Delhi",
  }),
  // Still inside the window, but only just. This is the row that should make
  // somebody put down their tea.
  enq("ENQ-0417-9102", "HMC-DL-0417", "OEM_PORTAL", "HOT", "NEW", "Ms Ritu Malhotra", "9910228844", "HER-DST-125", "SA-0417-19", {
    arrivedMinutesAgo: 14,
    firstContactAfterMinutes: null,
    modifiedMinutesAgo: 14,
    emailId: "ritu.m@example.in",
    cityDesc: "New Delhi",
  }),
  // Assigned to an executive who left in February. The DMS still shows his
  // name against it, which is exactly why nobody notices.
  enq("ENQ-0417-9103", "HMC-DL-0417", "WALKIN", "WARM", "CONTACTED", "Mr Suresh Pillai", "9873221100", "HER-SPL-PLUS", "SA-0417-21", {
    arrivedMinutesAgo: 60 * 24 * 6,
    firstContactAfterMinutes: 90,
    modifiedMinutesAgo: 60 * 24 * 5,
    lastContactDaysAgo: 5,
    nextFollowUpInDays: -3,
    cityDesc: "New Delhi",
    followUpSeeds: [
      { fuId: "FU-9103-1", dueInDays: -3, doneDaysAgo: null, outcomeDesc: null, empCode: "SA-0417-21" },
    ],
  }),
  // The expensive version: quoted, so the customer is real and close, and then
  // the person holding it left in June.
  enq("ENQ-0417-9104", "HMC-DL-0417", "WEB", "HOT", "QUOTED", "Mrs Shalini Kapoor", "9818445566", "HER-XTR-125R", "SA-0417-21", {
    arrivedMinutesAgo: 60 * 24 * 11,
    firstContactAfterMinutes: 35,
    modifiedMinutesAgo: 60 * 24 * 8,
    lastContactDaysAgo: 8,
    nextFollowUpInDays: -6,
    emailId: "shalini.kapoor@example.in",
    cityDesc: "New Delhi",
    followUpSeeds: [
      { fuId: "FU-9104-1", dueInDays: -9, doneDaysAgo: 9, outcomeDesc: "Quote shared on WhatsApp", empCode: "SA-0417-21" },
      { fuId: "FU-9104-2", dueInDays: -6, doneDaysAgo: null, outcomeDesc: null, empCode: "SA-0417-21" },
    ],
  }),
  // What good looks like: OEM lead answered in four minutes, test ride booked.
  enq("ENQ-0417-9105", "HMC-DL-0417", "OEM_PORTAL", "HOT", "TEST_RIDE", "Mr Farhan Ali", "9990117733", "HER-XPL-200", "SA-0417-19", {
    arrivedMinutesAgo: 60 * 26,
    firstContactAfterMinutes: 4,
    modifiedMinutesAgo: 60 * 3,
    lastContactDaysAgo: 0,
    nextFollowUpInDays: 1,
    emailId: "farhan.ali@example.in",
    cityDesc: "New Delhi",
    testRideSeeds: [{ trId: "TR-9105-1", modelCode: "HER-XPL-200", scheduledMinutesAgo: -60 * 20, doneFlg: "N" }],
  }),
  enq("ENQ-0417-9106", "HMC-DL-0417", "REFERRAL", "WARM", "NEGOTIATION", "Mr Jaspal Sethi", "9871009988", "HER-DST-125", "SA-0417-23", {
    arrivedMinutesAgo: 60 * 24 * 4,
    firstContactAfterMinutes: 20,
    modifiedMinutesAgo: 60 * 20,
    lastContactDaysAgo: 1,
    nextFollowUpInDays: 0,
    cityDesc: "New Delhi",
    followUpSeeds: [
      { fuId: "FU-9106-1", dueInDays: 0, doneDaysAgo: null, outcomeDesc: null, empCode: "SA-0417-23" },
    ],
  }),
  enq("ENQ-0417-9107", "HMC-DL-0417", "PHONE", "COLD", "CONTACTED", "Mrs Geeta Iyer", "9868112200", "HER-HFD-100", "SA-0417-23", {
    arrivedMinutesAgo: 60 * 24 * 21,
    firstContactAfterMinutes: 240,
    modifiedMinutesAgo: 60 * 24 * 12,
    lastContactDaysAgo: 12,
    nextFollowUpInDays: -9,
    cityDesc: "New Delhi",
    followUpSeeds: [
      { fuId: "FU-9107-1", dueInDays: -9, doneDaysAgo: null, outcomeDesc: null, empCode: "SA-0417-23" },
    ],
  }),
  // Converted — points at a real seeded deal, so the two modules join up.
  enq("ENQ-0417-9108", "HMC-DL-0417", "WALKIN", "HOT", "BOOKED", "Mr Rohit Kumar Bansal", "9873310482", "HER-SPL-PLUS", "SA-0417-19", {
    arrivedMinutesAgo: 60 * 24 * 9,
    firstContactAfterMinutes: 5,
    modifiedMinutesAgo: 60 * 24 * 7,
    lastContactDaysAgo: 7,
    convertedDealId: "HMC-DL-2026-000181",
    cityDesc: "New Delhi",
    testRideSeeds: [{ trId: "TR-9108-1", modelCode: "HER-SPL-PLUS", scheduledMinutesAgo: 60 * 24 * 8, doneFlg: "Y" }],
  }),
  enq("ENQ-0417-9109", "HMC-DL-0417", "CAMPAIGN", "COLD", "LOST", "Mr Vinod Chauhan", "9811667788", "HER-HFD-100", "SA-0417-23", {
    arrivedMinutesAgo: 60 * 24 * 16,
    firstContactAfterMinutes: 55,
    modifiedMinutesAgo: 60 * 24 * 13,
    lastContactDaysAgo: 13,
    lostReasonDesc: "Bought a competitor model — price",
    cityDesc: "New Delhi",
  }),
  enq("ENQ-MH-4401", "HMC-MH-1182", "OEM_PORTAL", "HOT", "NEW", "Mr Nilesh Gaikwad", "9823445566", "VID-V2-PLUS", "SA-1182-03", {
    arrivedMinutesAgo: 95,
    firstContactAfterMinutes: null,
    modifiedMinutesAgo: 95,
    cityDesc: "Pune",
  }),
];

export type { DmsEnquiryFollowUp, DmsTestRide };

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
ENQUIRY_SEEDS.push(...generateEnquiries(VOLUME.enquiries));
