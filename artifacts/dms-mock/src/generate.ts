/**
 * A month of trading, generated around the hand-written fixtures.
 *
 * The seeded dealership was nine enquiries, eight job cards and five deals, and
 * every one of them was written to demonstrate a specific failure. That made it
 * an excellent test fixture and an unconvincing dealership: nothing needed
 * filtering, every row was interesting, and anybody shown the console asked a
 * question about the data rather than about the business (R-33, and OBJ-6's
 * done-when).
 *
 * ## The hand-written rows are untouched, and that is not politeness
 *
 * Everything generated here is **appended** to the existing arrays. Every
 * scenario the last six sessions proved something against — the certificate in
 * the drawer since March, the enquiry belonging to a salesman who left in
 * February, the file blocked on insurance while its temporary registration
 * lapses — keeps its id, its dates and its position. A generator that rewrote
 * them would silently invalidate every proof in the session log, and the proofs
 * are the reason to trust any of this.
 *
 * ## Deterministic, or it is not a fixture
 *
 * One seeded PRNG, no `Math.random`, no `Date.now()` in any decision. Reseeding
 * twice produces byte-identical output. `store.ts` already makes this argument
 * about state surviving restarts, and it applies with more force to generated
 * volume: a dealership that is different every morning cannot be demonstrated,
 * and a bug that appears in one shape of data and not the next cannot be found.
 *
 * ## Most of it is fine, and that is the point
 *
 * Roughly one row in six needs somebody. The hand-written fixtures were
 * effectively all stuck, which made the queue look like a dealership in crisis
 * rather than a dealership having a normal month with a normal amount going
 * wrong. The ratios below are the claim being made about a real Hero dealer,
 * and they are the thing to argue with — not the volume.
 *
 * ## Saraswati gets the volume; Deccan stays parked
 *
 * R-43. Deccan exists so that nothing in the product can be written as though
 * one outlet is all there is, and it is deliberately shallow — a second outlet
 * with a month of its own trading would double the surface without answering a
 * question the first outlet does not already answer.
 */

import type { EnquirySeed } from "./crm.ts";
import type { JobCardSeed } from "./workshop.ts";
import type { RegnFileSeed } from "./registration.ts";
import type { ReceivableSeed } from "./receivables.ts";
import type { VehicleStockSeed } from "./inventory.ts";
import type { PartStockSeed } from "./spares.ts";
import type {
  DmsEmployee,
  DmsEnquiryGrade,
  DmsEnquirySource,
  DmsEnquiryStage,
  DmsJobCardStatus,
  DmsJobCardType,
  DmsRegnStatus,
} from "./types.ts";

// ── Determinism ─────────────────────────────────────────────────────────────

/**
 * mulberry32. Small, fast, and good enough for names and dates.
 *
 * The constant is arbitrary and must never change: it *is* the dealership.
 * Changing it regenerates every customer, which would be a diff nobody could
 * review and would break any note anybody has written down about a record.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = rng(0x5a4157);

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(R() * xs.length)]!;
const int = (lo: number, hi: number): number => lo + Math.floor(R() * (hi - lo + 1));
const chance = (p: number): boolean => R() < p;

/** Pick by weight, so the model mix reads like a sales report rather than a menu. */
function weighted<T extends string>(table: Record<T, number>): T {
  const entries = Object.entries(table) as Array<[T, number]>;
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let n = R() * total;
  for (const [k, w] of entries) {
    n -= w;
    if (n <= 0) return k;
  }
  return entries[entries.length - 1]![0];
}

// ── People ──────────────────────────────────────────────────────────────────

/**
 * Delhi and NCR, which is where Saraswati is.
 *
 * The spread matters more than the individual names. A dealer's book in west
 * Delhi is Punjabi, Bania, Purvanchali, Muslim and South Indian in roughly this
 * proportion, and a customer list that is uniformly one of those reads as
 * generated the moment somebody who lives there looks at it.
 */
const MALE_FIRST = [
  "Rohit", "Amit", "Sandeep", "Vikas", "Manoj", "Rakesh", "Deepak", "Naveen", "Gaurav", "Ankit",
  "Pankaj", "Sourav", "Nitin", "Rajeev", "Sunil", "Harpreet", "Gurmeet", "Jaspal", "Tarun", "Mohit",
  "Imran", "Faisal", "Naushad", "Salim", "Arif", "Rehan",
  "Ravi", "Suresh", "Mahesh", "Dinesh", "Umesh", "Ashok", "Rajesh", "Yogesh",
  "Bhupinder", "Karan", "Aditya", "Shubham", "Piyush", "Nikhil", "Varun", "Kunal",
  "Santosh", "Ramkumar", "Shyam", "Brijesh", "Chandan", "Dhiraj",
  "Arun", "Vinod", "Prakash", "Satish", "Anil", "Subhash",
];
const FEMALE_FIRST = [
  "Kavita", "Sunita", "Anjali", "Priya", "Neha", "Pooja", "Rekha", "Meena", "Shalini", "Ritu",
  "Simran", "Harleen", "Jasleen", "Mandeep", "Nusrat", "Farhana", "Shabnam",
  "Deepika", "Swati", "Nidhi", "Bhavna", "Kiran", "Seema", "Usha", "Geeta", "Preeti",
];
const SURNAME = [
  "Sharma", "Verma", "Gupta", "Agarwal", "Bansal", "Jain", "Mittal", "Singhal", "Goel", "Garg",
  "Singh", "Chadha", "Bhatia", "Sethi", "Kohli", "Anand", "Malhotra", "Arora", "Khurana", "Sabharwal",
  "Yadav", "Chauhan", "Rathore", "Tomar", "Solanki", "Panwar",
  "Khan", "Qureshi", "Ansari", "Siddiqui", "Sheikh", "Alam",
  "Nair", "Menon", "Pillai", "Iyer", "Reddy", "Rao",
  "Mishra", "Tiwari", "Pandey", "Dubey", "Tripathi", "Shukla",
  "Das", "Ghosh", "Banerjee", "Chatterjee",
  "Sahu", "Mahto", "Prasad", "Kumar",
];

interface Person {
  salutation: "Mr" | "Mrs" | "Ms";
  name: string;
  mobileNo: string;
}

/**
 * About one buyer in five is a woman, which is what a Hero dealer's book in
 * Delhi actually looks like on commuter models. Titled `Mrs` more often than
 * `Ms` because that is how the DMS's own data entry goes.
 */
function person(): Person {
  const female = chance(0.21);
  const first = female ? pick(FEMALE_FIRST) : pick(MALE_FIRST);
  const salutation = female ? (chance(0.7) ? "Mrs" : "Ms") : "Mr";
  return {
    salutation,
    name: `${salutation} ${first} ${pick(SURNAME)}`,
    mobileNo: mobile(),
  };
}

/**
 * A ten-digit Indian mobile.
 *
 * Series 9, 8 and 7 in roughly the proportion a customer list carries them.
 * Nothing here is a real allocated block that could reach somebody: the
 * fixtures have never been dialled and the WhatsApp control opens a draft, but
 * a generated number that happens to be live is a mistake with a person on the
 * other end of it.
 */
function mobile(): string {
  const series = weighted({ "9": 5, "8": 3, "7": 2 });
  let n = series;
  // 98xx / 87xx / 70xx style, then six digits.
  n += String(int(0, 9));
  for (let i = 0; i < 8; i++) n += String(int(0, 9));
  return n;
}

// ── The floor ───────────────────────────────────────────────────────────────

/**
 * The model mix, weighted the way a Hero dealer actually sells.
 *
 * Splendor and HF Deluxe are more than half of everything a mass-market Hero
 * dealership moves, and a fixture with an even spread misrepresents the
 * business badly enough to change what the screens are for: dead stock, ageing
 * and "somebody wants this model" all depend on the tail being a tail.
 *
 * **Only codes the catalogue actually holds.** The first version of this table
 * carried Passion, Glamour and Xoom, which a real Hero dealer certainly sells
 * and `catalogue.ts` does not have — and the mock's own portal died on the
 * first request looking up a warranty period for a model that did not exist.
 * Adding four more entries would have meant inventing four more service
 * schedules, and the catalogue says in its own header that its schedules are
 * representative rather than authoritative. The shape of the mix is what
 * matters here, not the number of rows in it.
 */
const MODEL_MIX = {
  "HER-SPL-PLUS": 38,
  "HER-HFD-100": 27,
  "HER-XTR-125R": 13,
  "HER-DST-125": 10,
  "HER-XPL-200": 7,
  "VID-V2-PLUS": 5,
} as const;

type ModelCode = keyof typeof MODEL_MIX;

const MODEL_DESC: Record<ModelCode, string> = {
  "HER-SPL-PLUS": "Splendor Plus",
  "HER-HFD-100": "HF Deluxe",
  "HER-XTR-125R": "Xtreme 125R",
  "HER-DST-125": "Destini 125",
  "HER-XPL-200": "Xpulse 200 4V",
  "VID-V2-PLUS": "Vida V2 Plus",
};

const EX_SHOWROOM: Record<ModelCode, number> = {
  "HER-SPL-PLUS": 79_150,
  "HER-HFD-100": 61_400,
  "HER-XTR-125R": 104_800,
  "HER-DST-125": 84_300,
  "HER-XPL-200": 154_800,
  "VID-V2-PLUS": 132_500,
};

const COLOURS: Record<string, readonly string[]> = {
  DEFAULT: ["Black with Purple", "Heavy Grey Green", "Sports Red", "Candy Blazing Red", "Nexus Blue", "Techno Blue", "Matte Axis Grey", "Glaze Black"],
};

const DEALER = "HMC-DL-0417";

/** Sales executives who can be assigned generated work at Saraswati. */
const SALES = ["SA-0417-19", "SA-0417-23"] as const;
const ADVISORS = ["AD-0417-04"] as const;
const TECHS = ["TE-0417-11", "TE-0417-14"] as const;

// ── More staff, because a floor of two cannot sell eighty bikes ─────────────

/**
 * The roster the generated volume implies.
 *
 * The hand-written eleven were written to make three departures visible on a
 * small floor. Eighty units a month and ninety job cards need a real branch
 * behind them, so this adds the rest of it — and keeps the departures, which
 * are the point of the original list.
 *
 * Employee codes continue the existing series rather than restarting, because
 * a code is a fact about when somebody joined and a dealership's numbering has
 * history in it.
 */
export const GENERATED_EMPLOYEES: DmsEmployee[] = [
  { empCode: "SA-0417-24", empName: "Rajat Khurana", dealerCode: DEALER, role: "SALES_EXEC", doj: "16-09-2024", dol: null, activeFlg: "Y", mobileNo: "9810044224", emailId: "rajat.khurana@saraswatiauto.example" },
  { empCode: "SA-0417-26", empName: "Pooja Bhatia", dealerCode: DEALER, role: "SALES_EXEC", doj: "03-02-2025", dol: null, activeFlg: "Y", mobileNo: "9810044226", emailId: "pooja.bhatia@saraswatiauto.example" },
  { empCode: "SA-0417-27", empName: "Sameer Ansari", dealerCode: DEALER, role: "SALES_EXEC", doj: "21-04-2025", dol: null, activeFlg: "Y", mobileNo: "9810044227", emailId: "sameer.ansari@saraswatiauto.example" },
  { empCode: "SA-0417-29", empName: "Divya Nair", dealerCode: DEALER, role: "SALES_EXEC", doj: "12-01-2026", dol: null, activeFlg: "Y", mobileNo: "9810044229", emailId: "divya.nair@saraswatiauto.example" },
  { empCode: "AD-0417-09", empName: "Harish Rawal", dealerCode: DEALER, role: "SERVICE_ADVISOR", doj: "08-08-2023", dol: null, activeFlg: "Y", mobileNo: "9810044209", emailId: "harish.rawal@saraswatiauto.example" },
  { empCode: "AD-0417-12", empName: "Nusrat Jahan", dealerCode: DEALER, role: "SERVICE_ADVISOR", doj: "27-05-2025", dol: null, activeFlg: "Y", mobileNo: "9810044212", emailId: "nusrat.jahan@saraswatiauto.example" },
  { empCode: "TE-0417-18", empName: "Mukesh Tomar", dealerCode: DEALER, role: "TECHNICIAN", doj: "14-02-2022", dol: null, activeFlg: "Y", mobileNo: "9810044218", emailId: "mukesh.tomar@saraswatiauto.example" },
  { empCode: "TE-0417-21", empName: "Irfan Sheikh", dealerCode: DEALER, role: "TECHNICIAN", doj: "09-10-2023", dol: null, activeFlg: "Y", mobileNo: "9810044221", emailId: "irfan.sheikh@saraswatiauto.example" },
  { empCode: "TE-0417-23", empName: "Sandeep Panwar", dealerCode: DEALER, role: "TECHNICIAN", doj: "05-06-2025", dol: null, activeFlg: "Y", mobileNo: "9810044223x", emailId: "sandeep.panwar@saraswatiauto.example" },
  // A fourth departure, and the only generated one. Six months after the last,
  // so the attrition reads as a rate rather than as a single bad quarter.
  { empCode: "SA-0417-25", empName: "Kunal Sabharwal", dealerCode: DEALER, role: "SALES_EXEC", doj: "01-07-2024", dol: "31-07-2026", activeFlg: "N", mobileNo: null, emailId: null },
];

const ALL_SALES = [...SALES, "SA-0417-24", "SA-0417-26", "SA-0417-27", "SA-0417-29"] as const;
const ALL_ADVISORS = [...ADVISORS, "AD-0417-09", "AD-0417-12"] as const;
const ALL_TECHS = [...TECHS, "TE-0417-18", "TE-0417-21", "TE-0417-23"] as const;

// ── Identifiers ─────────────────────────────────────────────────────────────

/**
 * A Hero chassis number, in the shape the real ones take.
 *
 * `MBL` is Hero's WMI. The rest is not decoded by anything in this system, but
 * it is generated to the right length and character set because a seventeen
 * character chassis that is obviously fake is exactly the kind of detail
 * somebody notices before they notice anything else.
 */
function chassis(n: number): string {
  return `MBL${pick(["HAR0748", "KAR0921", "VID0912", "PAS0633"])}NK${String(60_000 + n)}`;
}

function engine(n: number): string {
  return `${pick(["HA11", "KA21", "PA33", "VD12"])}ERNHK${String(60_000 + n)}`;
}

/** Delhi series, the format the RTO issues. */
function regNo(): string {
  return `DL${int(1, 13)}S${pick(["AB", "BX", "CK", "DL", "ER", "FG"])}${int(1000, 9999)}`;
}

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * How many days ago something happened, shaped like a trading month.
 *
 * Not uniform: a dealership sells more at the end of the month and more at
 * weekends, and a flat spread makes every list look like a spreadsheet. The
 * bias here is mild — enough that the dates do not read as a sequence, not so
 * much that anything depends on it.
 */
function daysAgoInMonth(maxDays: number): number {
  const raw = Math.floor(Math.pow(R(), 0.8) * maxDays);
  return Math.min(maxDays, Math.max(0, raw));
}

// ── Enquiries ───────────────────────────────────────────────────────────────

const SOURCE_MIX: Record<DmsEnquirySource, number> = {
  WALKIN: 42,
  OEM_PORTAL: 18,
  PHONE: 14,
  REFERRAL: 10,
  WEB: 8,
  CAMPAIGN: 5,
  EXCHANGE: 3,
};

const LOST_REASONS = [
  "Bought a competitor model",
  "Finance not approved",
  "Postponed purchase",
  "Price too high",
  "Went to another dealer",
  "No response after repeated calls",
];

/**
 * A month of leads.
 *
 * The stage spread is the claim: most enquiries are contacted and then decay
 * quietly, a minority convert, and a real fraction are simply lost. Only about
 * one in six is in a state the queue will pick up, which is the difference
 * between a dealership having a normal month and a dealership on fire.
 */
export function generateEnquiries(count: number): EnquirySeed[] {
  const out: EnquirySeed[] = [];
  for (let i = 0; i < count; i++) {
    const p = person();
    const model = weighted(MODEL_MIX);
    const stage = weighted<DmsEnquiryStage>({
      CONTACTED: 28,
      QUOTED: 18,
      LOST: 16,
      TEST_RIDE: 12,
      NEGOTIATION: 10,
      BOOKED: 9,
      NEW: 7,
    });
    const source = weighted(SOURCE_MIX);
    const arrivedDays = daysAgoInMonth(30);
    const arrivedMinutesAgo = arrivedDays * 1_440 + int(0, 600);

    // NEW means nobody has spoken to them yet. Everything else has been
    // contacted, and the response time is what separates a good floor from a
    // slow one — most inside the hour, a tail that is much worse.
    const contacted = stage !== "NEW";
    const firstContactAfterMinutes = contacted
      ? weighted({ fast: 62, slow: 28, bad: 10 }) === "fast"
        ? int(2, 55)
        : R() < 0.7
          ? int(60, 600)
          : int(900, 4_000)
      : null;

    // A handful sit with somebody who has left. This is the band the queue and
    // the agent exist for, and at a realistic rate rather than the fixture's.
    const gone = chance(0.05);
    const assignedEmpCode = gone
      ? pick(["SA-0417-21", "SA-0417-25"])
      : pick(ALL_SALES);

    const openStage = stage !== "LOST" && stage !== "BOOKED";
    const nextFollowUpInDays = openStage
      ? chance(0.34)
        ? -int(1, 12) // overdue
        : int(0, 9)
      : null;

    out.push({
      enqId: `ENQ-0417-${9200 + i}`,
      dealerCode: DEALER,
      source,
      grade: weighted<DmsEnquiryGrade>({ WARM: 47, COLD: 32, HOT: 21 }),
      stage,
      custName: p.name,
      mobileNo: p.mobileNo,
      emailId: null,
      cityDesc: pick(["New Delhi", "Rohini", "Janakpuri", "Dwarka", "Pitampura", "Uttam Nagar", "Najafgarh", "Paschim Vihar"]),
      modelCodeInterest: model,
      assignedEmpCode,
      lostReasonDesc: stage === "LOST" ? pick(LOST_REASONS) : null,
      convertedDealId: null,
      arrivedMinutesAgo,
      firstContactAfterMinutes,
      lastContactDaysAgo: contacted ? Math.max(0, arrivedDays - int(0, Math.max(1, arrivedDays))) : null,
      nextFollowUpInDays,
      modifiedMinutesAgo: int(60, arrivedMinutesAgo || 60),
      followUpSeeds: [],
      testRideSeeds:
        stage === "TEST_RIDE" || (stage === "BOOKED" && chance(0.5))
          ? [
              {
                trId: `TR-0417-${7000 + i}`,
                modelCode: model,
                scheduledMinutesAgo: int(600, arrivedMinutesAgo || 600),
                doneFlg: chance(0.75) ? "Y" : "N",
              },
            ]
          : [],
    });
  }
  return out;
}

// ── Job cards ───────────────────────────────────────────────────────────────

const COMPLAINTS: Array<[string, string]> = [
  ["Periodic service due", "Routine service carried out. Oil, filter, chain adjustment."],
  ["Engine noise at idle", "Tappet clearance out of spec. Adjusted."],
  ["Poor pickup", "Air filter choked, carburettor cleaned."],
  ["Brake not holding", "Rear brake shoes worn. Replaced."],
  ["Chain noise", "Chain and sprocket worn beyond limit."],
  ["Self start not working", "Starter relay faulty."],
  ["Headlamp not working", "Bulb fused, holder corroded."],
  ["Mileage dropped", "Spark plug fouled, valve timing checked."],
  ["Clutch slipping", "Clutch plates glazed."],
  ["Front suspension leaking", "Fork oil seal leaking."],
  ["Puncture and wheel alignment", "Tube replaced, wheel balanced."],
  ["Accident damage — left side", "Left panel and mirror replaced. Fork checked."],
];

/**
 * A month in the workshop.
 *
 * Most job cards are closed — that is what a workshop does — and the interest
 * is in the small number that are not. Two ratios carry the weight: how many
 * finished vehicles are still sitting uncollected, and how many of the closed
 * ones never got a post-service call. Both are things a dealership loses money
 * on quietly, and both are invisible in a DMS's own reporting.
 */
export function generateJobCards(count: number): JobCardSeed[] {
  const out: JobCardSeed[] = [];
  for (let i = 0; i < count; i++) {
    const p = person();
    const model = weighted(MODEL_MIX);
    const [complaint, observation] = pick(COMPLAINTS);
    const status = weighted<DmsJobCardStatus>({
      DELIVERED: 58,
      INVOICED: 12,
      READY: 9,
      IN_PROGRESS: 8,
      AWAITING_PARTS: 6,
      AWAITING_APPROVAL: 4,
      OPEN: 3,
    });
    const closed = status === "DELIVERED" || status === "INVOICED";
    const openedDaysAgo = closed ? daysAgoInMonth(45) : daysAgoInMonth(9);
    const jcType = weighted<DmsJobCardType>({
      PAID: 44,
      FREE: 30,
      RUNNING_REPAIR: 16,
      WARRANTY: 6,
      ACCIDENT: 3,
      CAMPAIGN: 1,
    });
    const amount = jcType === "FREE" ? int(180, 620) : int(650, 6_400);
    const called = status === "DELIVERED" && chance(0.81);

    out.push({
      jcNo: `JC-0417-${24200 + i}`,
      dealerCode: DEALER,
      chassisNo: chassis(3_000 + i),
      regNo: regNo(),
      custId: `CUST-0417-${72000 + i}`,
      custName: p.name,
      mobileNo: p.mobileNo,
      modelDesc: MODEL_DESC[model],
      odometerKm: int(900, 68_000),
      jcType,
      status,
      advisorEmpCode: pick(ALL_ADVISORS),
      technicianEmpCode: status === "OPEN" ? null : pick(ALL_TECHS),
      bayNo: status === "OPEN" ? null : `B-${int(1, 6)}`,
      complaintDesc: complaint,
      observationDesc: status === "OPEN" ? null : observation,
      estimateAmt: `${amount}.00`,
      approvedAmt: status === "AWAITING_APPROVAL" || status === "OPEN" ? null : `${amount}.00`,
      finalAmt: closed ? `${amount}.00` : null,
      labour: [],
      parts: [],
      // About a fifth of closed job cards never get the satisfaction call, and
      // the ones that do average a score a dealership would be pleased with.
      //
      // `called` is decided **once**. The first version asked `chance(0.66)`
      // separately for the object and for the date, which are two different
      // draws from the same stream — so a third of job cards ended up with a
      // PSF record and no date or a date and no record, and thirty-eight of
      // them landed on the queue as a follow-up call that had already been
      // made.
      psf: called
        ? {
            callDt: null,
            satisfactionScore: int(3, 5),
            complaintFlg: chance(0.08) ? "Y" : "N",
            remarksDesc: null,
          }
        : null,
      openedDaysAgo,
      promisedDaysFromOpen: int(0, 3),
      closedDaysAgo: closed ? Math.max(0, openedDaysAgo - int(0, 2)) : null,
      modifiedDaysAgo: closed ? Math.max(0, openedDaysAgo - int(0, 2)) : openedDaysAgo,
      psfDaysAgo: called ? Math.max(0, openedDaysAgo - int(1, 4)) : null,
    });
  }
  return out;
}

// ── Registration files ──────────────────────────────────────────────────────

/**
 * A month of paperwork.
 *
 * Most files complete and are handed over. The tail is where the money and the
 * complaints are, and the shape of that tail is the claim: certificates sitting
 * in a drawer because nobody rang, files at an RTO that has gone quiet, and a
 * small number rejected on an objection.
 */
export function generateRegistrations(count: number): RegnFileSeed[] {
  const out: RegnFileSeed[] = [];
  for (let i = 0; i < count; i++) {
    const p = person();
    const model = weighted(MODEL_MIX);
    const status = weighted<DmsRegnStatus>({
      RC_DELIVERED: 54,
      REGISTERED: 12,
      SUBMITTED: 11,
      RC_RECEIVED: 8,
      TAX_PAID: 6,
      PENDING_DOCS: 5,
      READY_TO_FILE: 3,
      REJECTED: 1,
    });
    const openedDaysAgo = status === "RC_DELIVERED" ? daysAgoInMonth(60) : daysAgoInMonth(28);
    const done = (offset: number): number | null => Math.max(0, openedDaysAgo - offset);

    const submitted = ["SUBMITTED", "REGISTERED", "RC_RECEIVED", "RC_DELIVERED"].includes(status);
    const registered = ["REGISTERED", "RC_RECEIVED", "RC_DELIVERED"].includes(status);
    const taxPaid = submitted || status === "TAX_PAID";
    const price = EX_SHOWROOM[model];

    out.push({
      regnFileNo: `REG-0417-${3400 + i}`,
      dealerCode: DEALER,
      // Never null: a registration file is opened *by* a sale, so a file with
      // no deal against it would be a shape the dealer's own system cannot
      // produce. These point at invoices the sales module does not carry a
      // fixture for, which is itself true of a real month — the DMS keeps far
      // more history than any one screen shows.
      dealId: `HMC-DL-2026-${String(100 + i).padStart(6, "0")}`,
      chassisNo: chassis(4_000 + i),
      custName: p.name,
      mobileNo: p.mobileNo,
      modelDesc: MODEL_DESC[model],
      status,
      rtoCode: "DL03",
      rtoOfficeDesc: "RTO Sarai Kale Khan (MLO Delhi)",
      // A minority land on the file with nobody against them. One RTO agent for
      // the whole branch is the real constraint, and the ones that fall off his
      // list are the ones nothing else in the dealership will catch.
      agentEmpCode: chance(0.08) ? null : "RT-0417-02",
      tempRegNo: registered ? null : `DL03TR26/${int(4000, 4999)}`,
      policyNo: taxPaid ? `SIM-${int(1000000, 9999999)}` : null,
      roadTaxAmt: `${Math.round(price * 0.07)}.00`,
      hsrpAmt: "425.00",
      agentFeeAmt: "900.00",
      regNo: registered ? regNo() : null,
      objectionDesc:
        status === "REJECTED"
          ? pick([
              "Chassis pencil print not legible",
              "Form 20 signature mismatch",
              "Address proof not accepted — old address",
              "Insurance policy dates do not match invoice",
            ])
          : null,
      remarksDesc: null,
      openedDaysAgo,
      tempRegExpiresInDays: registered ? null : 30 - openedDaysAgo,
      roadTaxCollectedDaysAgo: done(1),
      roadTaxPaidDaysAgo: taxPaid ? done(3) : null,
      submittedDaysAgo: submitted ? done(5) : null,
      regDaysAgo: registered ? done(11) : null,
      hsrpFittedDaysAgo: registered && chance(0.82) ? done(13) : null,
      rcReceivedDaysAgo: ["RC_RECEIVED", "RC_DELIVERED"].includes(status) ? done(16) : null,
      rcDeliveredDaysAgo: status === "RC_DELIVERED" ? done(19) : null,
      modifiedDaysAgo: Math.max(0, openedDaysAgo - int(0, 3)),
      docSeeds: [],
    });
  }
  return out;
}

// ── Vehicle stock ───────────────────────────────────────────────────────────

/**
 * What is standing on the floor and in the yard.
 *
 * Ageing is the whole point of this module, so the received dates run much
 * further back than a month: a dealership's problem is the six units that
 * arrived in March, not the forty that arrived last week.
 */
export function generateVehicleStock(count: number): VehicleStockSeed[] {
  const out: VehicleStockSeed[] = [];
  for (let i = 0; i < count; i++) {
    const model = weighted(MODEL_MIX);
    const allocated = chance(0.18);
    const receivedDaysAgo = weighted({ fresh: 64, ageing: 26, old: 10 }) === "fresh"
      ? int(1, 45)
      : R() < 0.72
        ? int(46, 110)
        : int(111, 260);

    out.push({
      dealerCode: DEALER,
      chassisNo: chassis(5_000 + i),
      engineNo: engine(5_000 + i),
      modelCode: model,
      modelDesc: MODEL_DESC[model],
      variantDesc: MODEL_DESC[model],
      colourDesc: pick(COLOURS["DEFAULT"]!),
      status: allocated ? "ALLOCATED" : "IN_STOCK",
      allocatedDealId: null,
      costAmt: `${Math.round(EX_SHOWROOM[model] * 0.91)}.00`,
      // Most of the floor is on the floor-plan line, which is why ageing costs
      // a dealership real money rather than only shelf space.
      financedFlg: chance(0.78) ? "Y" : "N",
      interestRatePct: chance(0.78) ? "9.85" : null,
      receivedDaysAgo,
      allocatedDaysAgo: allocated ? Math.max(0, receivedDaysAgo - int(1, 10)) : null,
      invoicedDaysAgo: null,
      modifiedDaysAgo: allocated ? Math.max(0, receivedDaysAgo - int(1, 10)) : receivedDaysAgo,
    });
  }
  return out;
}

// ── Receivables ─────────────────────────────────────────────────────────────

const INSURERS: Array<[string, string, string]> = [
  ["ICICI-LOM", "ICICI Lombard General Insurance", "claims.north@icicilombard.example"],
  ["BAJAJ-ALZ", "Bajaj Allianz General Insurance", "dealer.settlements@bajajallianz.example"],
  ["TATA-AIG", "Tata AIG General Insurance", "north.dealer@tataaig.example"],
  ["HDFC-ERG", "HDFC ERGO General Insurance", "motor.dealer@hdfcergo.example"],
];

const FINANCIERS: Array<[string, string, string]> = [
  ["BAJAJ-FIN", "Bajaj Finance Limited", "dealer.payouts@bajajfinserv.example"],
  ["HDB-FS", "HDB Financial Services", "subvention@hdbfs.example"],
  ["TVS-CRED", "TVS Credit Services", "dealer.claims@tvscredit.example"],
];

/**
 * What the dealership is owed.
 *
 * Weighted towards insurers and financiers rather than customers, because that
 * is where a two-wheeler dealer's receivables actually sit — a customer pays on
 * delivery, and the money that goes missing is a subvention claim or a policy
 * commission nobody chased.
 */
export function generateReceivables(count: number): ReceivableSeed[] {
  const out: ReceivableSeed[] = [];
  for (let i = 0; i < count; i++) {
    const kind = weighted({ INSURER: 40, FINANCIER: 34, CUSTOMER: 20, OEM: 6 });
    const invoiceDaysAgo = daysAgoInMonth(120);
    const creditDays = kind === "CUSTOMER" ? int(7, 21) : int(30, 60);
    const overdue = invoiceDaysAgo > creditDays;
    const settled = chance(overdue ? 0.42 : 0.72);
    const amount = kind === "CUSTOMER" ? int(4_000, 38_000) : int(12_000, 240_000);

    let partyCode: string, partyName: string, partyEmailId: string | null;
    if (kind === "INSURER") {
      [partyCode, partyName, partyEmailId] = pick(INSURERS);
    } else if (kind === "FINANCIER") {
      [partyCode, partyName, partyEmailId] = pick(FINANCIERS);
    } else if (kind === "OEM") {
      [partyCode, partyName, partyEmailId] = ["HERO-MC", "Hero MotoCorp Limited", "dealer.claims@heromotocorp.example"];
    } else {
      const p = person();
      partyCode = `CUST-0417-${74000 + i}`;
      partyName = p.name;
      // A real proportion of walk-in customers have no email on file, and that
      // is why some statements of account simply cannot be sent.
      partyEmailId = chance(0.45) ? null : `${p.name.split(" ").slice(1).join(".").toLowerCase()}@example.in`;
    }

    out.push({
      dealerCode: DEALER,
      receivableId: `REC-0417-${5600 + i}`,
      partyType: kind as never,
      partyCode,
      partyName,
      partyEmailId,
      invoiceNo: `INV/0417/26-27/0${1200 + i}`,
      invoiceAmt: `${amount}.00`,
      receivedAmt: settled ? `${amount}.00` : chance(0.3) ? `${Math.round(amount / 2)}.00` : "0.00",
      status: settled ? "SETTLED" : "OPEN",
      againstType: kind === "CUSTOMER" ? (chance(0.5) ? "JOB_CARD" : "DEAL") : kind === "OEM" ? "JOB_CARD" : "DEAL",
      againstKey: null,
      narrationDesc:
        kind === "INSURER"
          ? "Motor policy commission — monthly settlement"
          : kind === "FINANCIER"
            ? "Subvention and payout claim"
            : kind === "OEM"
              ? "Warranty claim reimbursement"
              : "Balance against vehicle invoice",
      invoiceDaysAgo,
      creditDays,
      lastReceiptDaysAgo: settled ? Math.max(0, invoiceDaysAgo - int(1, 20)) : null,
      // A third of the overdue ones gave a date, and a good number of those
      // have let it pass. That is the state the queue calls a broken promise.
      promisedInDays: !settled && overdue && chance(0.36) ? -int(1, 18) : null,
      modifiedDaysAgo: settled ? Math.max(0, invoiceDaysAgo - int(1, 20)) : invoiceDaysAgo,
    });
  }
  return out;
}

// ── Spares ──────────────────────────────────────────────────────────────────

const PART_CATALOGUE: Array<[string, string, number]> = [
  ["HR-OIL-FLT-97", "Oil filter — 97cc", 95],
  ["HR-AIR-FLT-125", "Air filter element — 125cc", 240],
  ["HR-SPK-PLUG-A", "Spark plug", 128],
  ["HR-CHN-SPR-KIT", "Chain and sprocket kit", 1_340],
  ["HR-BRK-SHOE-F", "Brake shoe set — front", 385],
  ["HR-CLT-CBL", "Clutch cable", 165],
  ["HR-ACC-CBL", "Accelerator cable", 152],
  ["HR-MIR-RH", "Rear view mirror — right", 210],
  ["HR-HDL-BULB", "Headlamp bulb", 118],
  ["HR-FRK-SEAL", "Front fork oil seal — pair", 296],
  ["HR-BAT-4AH", "Battery 4Ah maintenance free", 1_180],
  ["HR-ENG-OIL-1L", "Engine oil 10W30 — 1 litre", 480],
  ["HR-TYR-REAR-90", "Rear tyre 90/90-18", 1_620],
  ["HR-TUBE-18", "Tube 18 inch", 245],
  ["HR-IND-LENS-L", "Indicator lens — left", 96],
  ["HR-SDE-STND-SPR", "Side stand spring", 64],
  ["HR-PNL-SIDE-R", "Side panel — right", 720],
  ["HR-SEAT-ASSY", "Seat assembly", 1_480],
  ["HR-HRN-12V", "Horn 12V", 285],
  ["HR-CRB-KIT", "Carburettor repair kit", 410],
  ["HR-VLV-SET", "Valve set", 690],
  ["HR-PST-RING", "Piston ring set", 545],
  ["HR-DSC-PAD-F", "Disc brake pad set — front", 620],
  ["HR-SWG-BUSH", "Swing arm bush kit", 178],
];

/**
 * The shelf.
 *
 * Most parts are stocked and moving. The interest is in the three shapes that
 * cost money: a part at zero with a vehicle waiting for it, a part that has not
 * moved in months, and stock that is all reserved and therefore effectively
 * absent while the screen says it is there.
 */
export function generateParts(count: number): PartStockSeed[] {
  const out: PartStockSeed[] = [];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const [partNo, partDesc, mrp] = PART_CATALOGUE[i % PART_CATALOGUE.length]!;
    const suffix = i >= PART_CATALOGUE.length ? `-${Math.floor(i / PART_CATALOGUE.length)}` : "";
    const no = `${partNo}${suffix}`;
    if (used.has(no)) continue;
    used.add(no);

    const shape = weighted({ healthy: 62, low: 16, dead: 12, out: 6, reserved: 4 });
    const reorderLevel = int(2, 8);
    const qtyOnHand =
      shape === "out" ? 0 : shape === "low" ? int(1, reorderLevel) : shape === "dead" ? int(2, 9) : int(reorderLevel + 2, reorderLevel + 24);
    const onOrder = shape === "out" || shape === "low" ? chance(0.55) : false;

    out.push({
      dealerCode: DEALER,
      partNo: no,
      partDesc,
      binLocation: `${pick(["A", "B", "C", "D"])}-${String(int(1, 18)).padStart(2, "0")}-${int(1, 4)}`,
      qtyOnHand,
      qtyReserved: shape === "reserved" ? qtyOnHand : qtyOnHand > 2 && chance(0.25) ? int(1, 2) : 0,
      reorderLevel,
      mrpAmt: `${mrp}.00`,
      costAmt: `${Math.round(mrp * 0.72)}.00`,
      onOrderQty: onOrder ? int(4, 20) : 0,
      lastReceivedDaysAgo: shape === "dead" ? int(150, 400) : int(3, 60),
      lastIssuedDaysAgo: shape === "dead" ? int(140, 380) : chance(0.9) ? int(0, 30) : null,
      // A third of what is on order is already late, which is the state the
      // spares screen calls an overdue order.
      onOrderEtaInDays: onOrder ? (chance(0.34) ? -int(1, 14) : int(1, 12)) : null,
      modifiedDaysAgo: int(0, 20),
    });
  }
  return out;
}

// ── How much of each ────────────────────────────────────────────────────────

/**
 * The size of the dealership, in one place so it can be argued with.
 *
 * These are a mid-size urban Hero dealer doing roughly seventy to eighty units
 * a month with a workshop attached — big enough that every list needs
 * filtering, small enough that the queue is a morning's work rather than a
 * hopeless number.
 */
export const VOLUME = {
  deals: 74,
  enquiries: 132,
  jobCards: 96,
  registrations: 78,
  vehicleStock: 52,
  receivables: 44,
  parts: 58,
} as const;

/**
 * The primitives, handed to `generate-deals.ts`.
 *
 * Exported as one object rather than as loose names so that the sharing is
 * visible: **the deal generator draws from the same PRNG**, which is what keeps
 * the whole dealership one deterministic sequence instead of two that happen to
 * be seeded the same way. Two independent streams would produce a dealership
 * whose sales and whose service book were unrelated, and reordering a call in
 * one file would silently change the other.
 */
export const DEAL_HELPERS = {
  R,
  pick,
  int,
  chance,
  weighted,
  person,
  chassis,
  engine,
  regNo,
  daysAgoInMonth,
  MODEL_MIX,
  EX_SHOWROOM,
  COLOURS: COLOURS["DEFAULT"]!,
  ALL_SALES,
  FEMALE_FIRST,
  DEALER,
};
