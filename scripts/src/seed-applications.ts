/**
 * A book of insurance applications that reads like a dealership's.
 *
 *   pnpm run db:seed-applications
 *
 * Two jobs, and the first one is a repair.
 *
 * ## The five that belonged to nobody
 *
 * Five applications survived the Replit export with no showroom: "Jane Smith",
 * a Honda Activa, a Bangalore RTO code, invented from the form's own prefilled
 * placeholders. That was harmless while `applications` was unscoped. It stopped
 * being harmless in OBJ-8, when the row policies started applying to
 * InsurRouter: a row with no showroom belongs to no owner, so those five became
 * invisible to every login including the one that created them — data that
 * quietly disappears, which is the failure this product refuses everywhere
 * else.
 *
 * They are rewritten here rather than deleted. Their ids are in URLs and three
 * of them carry issued policies; what was wrong with them was the *content*,
 * not their existence.
 *
 * ## And then a book worth demonstrating
 *
 * Both outlets sell Hero, so every vehicle below is one Hero actually makes at
 * a price they actually charge, to customers with Delhi and Pune addresses that
 * match the outlet that sold them. Nothing is labelled as sample data, because
 * a dealership evaluating this should be looking at something that reads like
 * their own week — and because a "demo data" banner is a thing nobody removes
 * before the meeting.
 *
 * **Simulated policy numbers stay marked.** Every provider in this database has
 * a `.invalid` endpoint, so no insurer has issued any of these. The executor
 * prefixes what it invents with `SIM-` for exactly that reason, and this script
 * does the same — including fixing one pre-existing row that predates the rule
 * and reads like a genuine Go Digit policy number.
 *
 * Idempotent: keyed on the chassis number, which is the one field a vehicle
 * genuinely has only one of.
 */

import { eq, inArray, sql } from "drizzle-orm";
import {
  ownerDb,
  applicationsTable,
  policiesTable,
  providersTable,
  submissionLogsTable,
} from "@workspace/db";

type Status = "draft" | "pending_confirmation" | "submitting" | "completed" | "failed";
type LogStep = "data_ingestion" | "validation" | "routing" | "execution_api" | "execution_browser" | "browser_launch" | "form_submit" | "policy_issued" | "error";
type LogStatus = "info" | "success" | "warning" | "error";
type Relationship = "SPOUSE" | "FATHER" | "MOTHER" | "SON" | "DAUGHTER" | "BROTHER" | "SISTER" | "OTHER";

interface Seed {
  /** Identity for re-runs, and the one field a vehicle has exactly one of. */
  chassis: string;
  /** Which of these is one of the five orphans being repaired, if any. */
  repairs?: number;
  showroomId: number;
  status: Status;
  providerCode: string | null;
  executionMode: "API" | "BROWSER" | "AUTO";
  resolved?: "API" | "BROWSER";
  model: string;
  variant: string;
  price: number;
  cc: number | null;
  motorKw?: number;
  purchased: string;
  name: string;
  address: string;
  pincode: number;
  phone: string;
  email: string;
  dob: string;
  idType: "AADHAR" | "PAN" | "DRIVING_LICENSE" | "VOTER_ID";
  idNumber: string;
  city: string;
  state: string;
  rto: string;
  financier?: string;
  nominee?: { name: string; dob: string; relationship: Relationship };
  /** The invented policy number, for the ones that reached an insurer's stub. */
  policy?: string;
  /** What the timeline says, oldest first. */
  logs: Array<{ step: LogStep; status: LogStatus; message: string }>;
}

const DELHI = 1;
const PUNE = 2;

/**
 * The vehicle rows are Hero's actual line-up because both outlets are Hero
 * dealers — `showroom_dms_accounts` says `HMC-DL-0417` and `HMC-MH-1182`. A
 * Honda Activa on a Hero dealer's book is the kind of detail that tells a
 * dealership nobody looked at their business.
 */
const SEEDS: Seed[] = [
  // ── The five repairs ──────────────────────────────────────────────────────
  {
    chassis: "MBLHA11AWPHA41207",
    repairs: 2,
    showroomId: DELHI,
    status: "failed",
    providerCode: "HDFC",
    executionMode: "API",
    resolved: "API",
    model: "Splendor Plus",
    variant: "Xtec",
    price: 79_500,
    cc: 97.2,
    purchased: "2026-07-18",
    name: "Sunita Aggarwal",
    address: "C-114, Vikas Puri, New Delhi",
    pincode: 110018,
    phone: "9871204416",
    email: "sunita.aggarwal@gmail.com",
    dob: "1988-03-22",
    idType: "AADHAR",
    idNumber: "5412 8890 3317",
    city: "New Delhi",
    state: "Delhi",
    rto: "DL09",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Splendor Plus Xtec (Sunita Aggarwal)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "execution_api", status: "error", message: "HDFC ERGO rejected the payload: engine number does not match the chassis on their VAHAN lookup. Re-key from the invoice and resubmit." },
    ],
  },
  {
    chassis: "MBLJA06EWPGA88931",
    repairs: 3,
    showroomId: DELHI,
    status: "completed",
    providerCode: "DIGIT",
    executionMode: "API",
    resolved: "API",
    model: "Passion Pro",
    variant: "Drum",
    price: 82_400,
    cc: 113.2,
    purchased: "2026-07-11",
    name: "Mohd Arif Ansari",
    address: "1832, Gali Chandiwali, Ballimaran, Delhi",
    pincode: 110006,
    phone: "9013448027",
    email: "arif.ansari82@gmail.com",
    dob: "1982-11-09",
    idType: "AADHAR",
    idNumber: "7739 1024 8865",
    city: "Delhi",
    state: "Delhi",
    rto: "DL06",
    nominee: { name: "Rukhsana Ansari", dob: "1986-05-14", relationship: "SPOUSE" },
    policy: "SIM-DIGIT-API-MS5QULK8",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Passion Pro Drum (Mohd Arif Ansari)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "execution_api", status: "success", message: "Submitted to Go Digit General Insurance" },
      { step: "policy_issued", status: "success", message: "Policy SIM-DIGIT-API-MS5QULK8 issued" },
    ],
  },
  {
    chassis: "MBLHAW118PHB20554",
    repairs: 4,
    showroomId: PUNE,
    status: "failed",
    providerCode: "ICICI",
    executionMode: "BROWSER",
    resolved: "BROWSER",
    model: "HF Deluxe",
    variant: "Self Start",
    price: 63_200,
    cc: 97.2,
    purchased: "2026-07-24",
    name: "Rajesh Kumar Sharma",
    address: "Flat 7, Sai Residency, Kothrud, Pune",
    pincode: 411038,
    phone: "9822016745",
    email: "rk.sharma1979@gmail.com",
    dob: "1979-06-30",
    idType: "PAN",
    idNumber: "AKQPS4471L",
    city: "Pune",
    state: "Maharashtra",
    rto: "MH12",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero HF Deluxe Self Start (Rajesh Kumar Sharma)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "browser_launch", status: "success", message: "Opened ICICI Lombard agent portal" },
      { step: "form_submit", status: "error", message: "Portal session expired at the payment step. The agent login needs re-authorising before this can be retried." },
    ],
  },
  {
    chassis: "MBLKC12EXPKA77410",
    repairs: 6,
    showroomId: PUNE,
    status: "completed",
    providerCode: "DIGIT",
    executionMode: "API",
    resolved: "API",
    model: "Destini 125",
    variant: "VX",
    price: 81_900,
    cc: 124.6,
    purchased: "2026-07-14",
    name: "Shraddha Kulkarni",
    address: "22 Sahakar Nagar, Parvati, Pune",
    pincode: 411009,
    phone: "9765330218",
    email: "shraddha.kulkarni@outlook.com",
    dob: "1994-09-02",
    idType: "AADHAR",
    idNumber: "3021 7754 9908",
    city: "Pune",
    state: "Maharashtra",
    rto: "MH12",
    policy: "SIM-DIGIT-API-MS7HKDKJ",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Destini 125 VX (Shraddha Kulkarni)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "execution_api", status: "success", message: "Submitted to Go Digit General Insurance" },
      { step: "policy_issued", status: "success", message: "Policy SIM-DIGIT-API-MS7HKDKJ issued" },
    ],
  },
  {
    chassis: "MBLXP200XPHC31866",
    repairs: 7,
    showroomId: DELHI,
    status: "completed",
    providerCode: "TATAAIG",
    executionMode: "BROWSER",
    resolved: "BROWSER",
    model: "Xpulse 200 4V",
    variant: "Pro",
    price: 1_52_800,
    cc: 199.6,
    purchased: "2026-07-21",
    name: "Devansh Chaudhary",
    address: "B-9/3, Sector 11, Rohini, Delhi",
    pincode: 110085,
    phone: "9540117823",
    email: "devansh.chaudhary@gmail.com",
    dob: "1997-01-28",
    idType: "DRIVING_LICENSE",
    idNumber: "DL0420220034117",
    city: "Delhi",
    state: "Delhi",
    rto: "DL08",
    financier: "HDFC Bank",
    policy: "SIM-TATAAIG-BROWSER-MS8XCRMX",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Xpulse 200 4V Pro (Devansh Chaudhary)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "browser_launch", status: "success", message: "Opened TATA AIG agent portal" },
      { step: "form_submit", status: "success", message: "Proposal submitted" },
      { step: "policy_issued", status: "success", message: "Policy SIM-TATAAIG-BROWSER-MS8XCRMX issued" },
    ],
  },

  // ── The rest of the book ──────────────────────────────────────────────────
  {
    chassis: "MBLHA11AWRHA52031",
    showroomId: DELHI,
    status: "draft",
    providerCode: null,
    executionMode: "AUTO",
    model: "Splendor Plus",
    variant: "Drum",
    price: 78_100,
    cc: 97.2,
    purchased: "2026-08-02",
    name: "Naveen Bhardwaj",
    address: "H-42, Laxmi Nagar, Delhi",
    pincode: 110092,
    phone: "9718820394",
    email: "naveen.bhardwaj@gmail.com",
    dob: "1991-12-05",
    idType: "AADHAR",
    idNumber: "6650 2287 4413",
    city: "Delhi",
    state: "Delhi",
    rto: "DL07",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Splendor Plus Drum (Naveen Bhardwaj)" },
    ],
  },
  {
    chassis: "MBLGL124XRGA10298",
    showroomId: DELHI,
    status: "pending_confirmation",
    providerCode: "BAJAJ",
    executionMode: "AUTO",
    model: "Glamour X",
    variant: "125",
    price: 87_600,
    cc: 124.7,
    purchased: "2026-08-01",
    name: "Preeti Malhotra",
    address: "24 Hauz Khas Enclave, New Delhi",
    pincode: 110016,
    phone: "9899471002",
    email: "preeti.malhotra@yahoo.in",
    dob: "1993-04-17",
    idType: "AADHAR",
    idNumber: "8814 6690 2255",
    city: "New Delhi",
    state: "Delhi",
    rto: "DL03",
    nominee: { name: "Anil Malhotra", dob: "1961-08-23", relationship: "FATHER" },
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Glamour X 125 (Preeti Malhotra)" },
      { step: "validation", status: "success", message: "All required MSA fields present — awaiting confirmation before submission" },
    ],
  },
  {
    chassis: "MBLX125RXRHA66172",
    showroomId: DELHI,
    status: "completed",
    providerCode: "BAJAJ",
    executionMode: "API",
    resolved: "API",
    model: "Xtreme 125R",
    variant: "ABS",
    price: 1_01_400,
    cc: 124.7,
    purchased: "2026-07-27",
    name: "Faizan Sheikh",
    address: "45-B, Jamia Nagar, Okhla, New Delhi",
    pincode: 110025,
    phone: "9354008812",
    email: "faizan.sheikh96@gmail.com",
    dob: "1996-07-13",
    idType: "AADHAR",
    idNumber: "2290 4471 8836",
    city: "New Delhi",
    state: "Delhi",
    rto: "DL02",
    financier: "Bajaj Finance",
    policy: "SIM-BAJAJ-API-MSF2QK7T",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Xtreme 125R ABS (Faizan Sheikh)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "execution_api", status: "success", message: "Submitted to Bajaj Allianz General Insurance" },
      { step: "policy_issued", status: "success", message: "Policy SIM-BAJAJ-API-MSF2QK7T issued" },
    ],
  },
  {
    chassis: "MBLVD002XRVA30419",
    showroomId: DELHI,
    status: "draft",
    providerCode: "RELIANCE",
    executionMode: "AUTO",
    model: "Vida V2 Lite",
    variant: "Standard",
    price: 1_09_500,
    cc: null,
    motorKw: 3.9,
    purchased: "2026-08-03",
    name: "Ritika Sabharwal",
    address: "T-3/802, Ardee City, Sector 52, New Delhi",
    pincode: 110044,
    phone: "9910337748",
    email: "ritika.sabharwal@gmail.com",
    dob: "1999-02-11",
    idType: "AADHAR",
    idNumber: "4471 9902 6613",
    city: "New Delhi",
    state: "Delhi",
    rto: "DL01",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Vida V2 Lite (Ritika Sabharwal) — electric, rated on 3.9 kW rather than cc" },
    ],
  },
  {
    chassis: "MBLXM110XRXA45520",
    showroomId: DELHI,
    status: "failed",
    providerCode: "RELIANCE",
    executionMode: "API",
    resolved: "API",
    model: "Xoom 110",
    variant: "VX",
    price: 77_300,
    cc: 110.9,
    purchased: "2026-07-30",
    name: "Gurpreet Singh Bedi",
    address: "A-77, Tilak Nagar, New Delhi",
    pincode: 110018,
    phone: "9313880275",
    email: "gs.bedi@gmail.com",
    dob: "1985-10-19",
    idType: "AADHAR",
    idNumber: "9925 3348 7701",
    city: "New Delhi",
    state: "Delhi",
    rto: "DL04",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Xoom 110 VX (Gurpreet Singh Bedi)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "execution_api", status: "error", message: "Reliance General returned 503 three times. Their proposal API is down; nothing was submitted and this can be retried as-is." },
    ],
  },
  {
    chassis: "MBLME125XRMA88103",
    showroomId: PUNE,
    status: "draft",
    providerCode: null,
    executionMode: "AUTO",
    model: "Maestro Edge 125",
    variant: "ZX",
    price: 85_200,
    cc: 124.6,
    purchased: "2026-08-02",
    name: "Amol Deshpande",
    address: "Flat 12, Shivneri Apartments, Aundh, Pune",
    pincode: 411007,
    phone: "9881204473",
    email: "amol.deshpande@gmail.com",
    dob: "1990-05-26",
    idType: "AADHAR",
    idNumber: "1178 4402 9963",
    city: "Pune",
    state: "Maharashtra",
    rto: "MH12",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Maestro Edge 125 ZX (Amol Deshpande)" },
    ],
  },
  {
    chassis: "MBLHAW118RHB74926",
    showroomId: PUNE,
    status: "completed",
    providerCode: "ICICI",
    executionMode: "API",
    resolved: "API",
    model: "HF Deluxe",
    variant: "Kick Start",
    price: 61_800,
    cc: 97.2,
    purchased: "2026-07-25",
    name: "Balasaheb Jagtap",
    address: "Survey 88/2, Wagholi, Pune",
    pincode: 412207,
    phone: "9970118824",
    email: "b.jagtap1975@gmail.com",
    dob: "1975-01-04",
    idType: "VOTER_ID",
    idNumber: "MHT2947118",
    city: "Pune",
    state: "Maharashtra",
    rto: "MH14",
    nominee: { name: "Sarika Jagtap", dob: "1980-03-16", relationship: "SPOUSE" },
    policy: "SIM-ICICI-API-MSF7LP2W",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero HF Deluxe Kick Start (Balasaheb Jagtap)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "execution_api", status: "success", message: "Submitted to ICICI Lombard General Insurance" },
      { step: "policy_issued", status: "success", message: "Policy SIM-ICICI-API-MSF7LP2W issued" },
    ],
  },
  {
    chassis: "MBLJA06EWRGA92238",
    showroomId: PUNE,
    status: "pending_confirmation",
    providerCode: "TATAAIG",
    executionMode: "BROWSER",
    model: "Passion Plus",
    variant: "Drum",
    price: 80_600,
    cc: 113.2,
    purchased: "2026-08-01",
    name: "Nilofer Shaikh",
    address: "18 Mominpura, Camp, Pune",
    pincode: 411001,
    phone: "9028447106",
    email: "nilofer.shaikh@gmail.com",
    dob: "1992-08-08",
    idType: "AADHAR",
    idNumber: "5563 2201 8874",
    city: "Pune",
    state: "Maharashtra",
    rto: "MH12",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Passion Plus Drum (Nilofer Shaikh)" },
      { step: "validation", status: "success", message: "All required MSA fields present — awaiting confirmation before submission" },
    ],
  },
  {
    chassis: "MBLX125RXRHA71504",
    showroomId: PUNE,
    status: "draft",
    providerCode: null,
    executionMode: "AUTO",
    model: "Xtreme 125R",
    variant: "Drum",
    price: 96_700,
    cc: 124.7,
    purchased: "2026-08-03",
    name: "Sagar Pawar",
    address: "Row House 4, Bavdhan Khurd, Pune",
    pincode: 411021,
    phone: "9922870441",
    email: "sagar.pawar@rediffmail.com",
    dob: "1998-11-30",
    idType: "PAN",
    idNumber: "BQWPP8821K",
    city: "Pune",
    state: "Maharashtra",
    rto: "MH12",
    financier: "Hero FinCorp",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Xtreme 125R Drum (Sagar Pawar)" },
    ],
  },
  {
    chassis: "MBLKC12EXRKA80877",
    showroomId: PUNE,
    status: "completed",
    providerCode: "HDFC",
    executionMode: "BROWSER",
    resolved: "BROWSER",
    model: "Destini 125",
    variant: "LX",
    price: 78_400,
    cc: 124.6,
    purchased: "2026-07-19",
    name: "Meenakshi Rane",
    address: "9 Ganesh Nagar, Chinchwad, Pune",
    pincode: 411033,
    phone: "9673302218",
    email: "meenakshi.rane@gmail.com",
    dob: "1987-06-21",
    idType: "AADHAR",
    idNumber: "7702 4418 9930",
    city: "Pune",
    state: "Maharashtra",
    rto: "MH14",
    policy: "SIM-HDFC-BROWSER-MSF9RT4A",
    logs: [
      { step: "data_ingestion", status: "success", message: "Application created for Hero Destini 125 LX (Meenakshi Rane)" },
      { step: "validation", status: "success", message: "All required MSA fields present" },
      { step: "browser_launch", status: "success", message: "Opened HDFC ERGO agent portal" },
      { step: "form_submit", status: "success", message: "Proposal submitted" },
      { step: "policy_issued", status: "success", message: "Policy SIM-HDFC-BROWSER-MSF9RT4A issued" },
    ],
  },
];

async function main(): Promise<void> {
  const providers = await ownerDb
    .select({ id: providersTable.id, code: providersTable.code, name: providersTable.name })
    .from(providersTable);
  const byCode = new Map(providers.map((p) => [p.code, p]));

  if (providers.length === 0) {
    console.error("No providers. Run `pnpm run db:seed` first — these applications point at them.");
    process.exit(1);
  }

  let repaired = 0;
  let created = 0;
  let updated = 0;

  for (const s of SEEDS) {
    const provider = s.providerCode ? byCode.get(s.providerCode) : null;
    if (s.providerCode && !provider) {
      console.warn(`  ! no provider ${s.providerCode} — leaving this one unrouted`);
    }

    const values = {
      showroomId: s.showroomId,
      status: s.status,
      executionMode: s.executionMode,
      resolvedExecutionMode: s.resolved ?? null,
      providerId: provider?.id ?? null,
      vehicleMake: "Hero MotoCorp",
      vehicleModel: s.model,
      vehicleVariant: s.variant,
      vehicleEngineNumber: `HA${s.chassis.slice(-8)}`,
      vehicleChassisNumber: s.chassis,
      vehicleExShowroomPrice: s.price,
      vehicleDateOfPurchase: s.purchased,
      vehicleFuelType: s.cc === null ? ("ELECTRIC" as const) : ("PETROL" as const),
      vehicleCubicCapacity: s.cc,
      vehicleMotorKw: s.motorKw ?? null,
      vehicleSeatingCapacity: 2,
      vehicleManufactureMonth: Number(s.purchased.slice(5, 7)),
      vehicleManufactureYear: Number(s.purchased.slice(0, 4)),
      ownerFullName: s.name,
      ownerBillingAddress: s.address,
      ownerPincode: s.pincode,
      ownerPhoneNumber: s.phone,
      ownerEmail: s.email,
      ownerDateOfBirth: s.dob,
      ownerIdProofType: s.idType,
      ownerIdProofNumber: s.idNumber,
      ownerEntityType: "INDIVIDUAL" as const,
      nomineeFullName: s.nominee?.name ?? null,
      nomineeDateOfBirth: s.nominee?.dob ?? null,
      nomineeRelationship: s.nominee?.relationship ?? null,
      isHypothecated: Boolean(s.financier),
      hypothecationFinancierName: s.financier ?? null,
      // A new two-wheeler in India is sold with five years of third-party cover
      // and one of own-damage. Not a detail worth inventing differently per row.
      coverageType: "BUNDLED_1OD_5TP" as const,
      coverageTpTermYears: 5,
      coverageOdTermYears: 1,
      coverageIdv: Math.round(s.price * 0.95),
      rtoRegistrationCity: s.city,
      rtoRegistrationState: s.state,
      rtoCode: s.rto,
    };

    // Identity is the chassis, except for the five being repaired — those are
    // found by id, because the whole point is to keep the row they already have.
    const [existing] = s.repairs
      ? await ownerDb
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(eq(applicationsTable.id, s.repairs))
      : await ownerDb
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(eq(applicationsTable.vehicleChassisNumber, s.chassis));

    let id: number;
    if (existing) {
      await ownerDb.update(applicationsTable).set(values).where(eq(applicationsTable.id, existing.id));
      id = existing.id;
      if (s.repairs) repaired++;
      else updated++;
    } else {
      const [row] = await ownerDb.insert(applicationsTable).values(values).returning({ id: applicationsTable.id });
      id = row!.id;
      created++;
    }

    // The timeline is rewritten wholesale rather than appended to. These lines
    // describe the row as it now reads, and a log that still names the customer
    // this application used to be about is worse than no log.
    await ownerDb.delete(submissionLogsTable).where(eq(submissionLogsTable.applicationId, id));
    for (const line of s.logs) {
      await ownerDb.insert(submissionLogsTable).values({
        applicationId: id,
        step: line.step,
        status: line.status,
        message: line.message,
      });
    }

    if (s.policy && provider) {
      const [pol] = await ownerDb
        .select({ id: policiesTable.id })
        .from(policiesTable)
        .where(eq(policiesTable.applicationId, id));
      if (pol) {
        await ownerDb
          .update(policiesTable)
          .set({ policyNumber: s.policy, providerName: provider.name })
          .where(eq(policiesTable.id, pol.id));
      } else {
        await ownerDb.insert(policiesTable).values({
          applicationId: id,
          policyNumber: s.policy,
          providerName: provider.name,
        });
      }
    }
  }

  // Nothing should be left unattributed. If it is, say so rather than leaving
  // somebody to discover it as a missing row on a screen.
  const [orphans] = await ownerDb
    .select({ n: sql<number>`count(*)::int` })
    .from(applicationsTable)
    .where(sql`showroom_id is null`);

  console.log(
    `\n  repaired ${repaired}   updated ${updated}   created ${created}` +
      `\n  applications with no showroom: ${orphans!.n}` +
      (orphans!.n > 0
        ? "  ← these belong to nobody and no login can see them"
        : "  ✓"),
  );

  // And the rule that outlives this script: nothing in `policies` may read like
  // a number an insurer issued. Every provider here has a `.invalid` endpoint.
  const unmarked = await ownerDb
    .select({ id: policiesTable.id, number: policiesTable.policyNumber })
    .from(policiesTable)
    .where(sql`policy_number not like 'SIM-%'`);
  if (unmarked.length > 0) {
    await ownerDb
      .update(policiesTable)
      .set({ policyNumber: sql`'SIM-' || ${policiesTable.policyNumber}` })
      .where(inArray(policiesTable.id, unmarked.map((p) => p.id)));
    console.log(`  marked ${unmarked.length} simulated policy number(s) that were not: ${unmarked.map((p) => p.number).join(", ")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seeding applications failed:", err);
    process.exit(1);
  });
