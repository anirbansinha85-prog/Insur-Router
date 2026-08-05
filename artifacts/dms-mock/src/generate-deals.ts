/**
 * A month of sales — the module that carries the product's whole thesis.
 *
 * Its own file rather than another section of `generate.ts` because a deal is
 * the one fixture stored as a **document** with its dates already formatted,
 * while every other seed is an offset that `store.ts` turns into a date at seed
 * time. Two storage styles in one generator would invite somebody to copy the
 * wrong pattern; `store.ts` already explains why the two exist.
 *
 * ## Why deals could not be left thin
 *
 * Everything else could. A mirror holding a hundred and forty enquiries, ninety
 * registration files and **four deals** is not a small dealership — it is an
 * inconsistent one, and it is the first thing anybody looking at the console
 * would notice. Registration files reference a deal, reconciliation compares
 * our policy against the OEM's, and both of those need a book of sales behind
 * them or they are demonstrating themselves against nothing.
 *
 * The ids continue the series `generateRegistrations` opened files against, so
 * the two modules describe the same sales rather than two unrelated books.
 *
 * ## The nulls are the point
 *
 * `insurance.policyNo` is null on every deal whose state says the policy has
 * not been recorded, and that null is the entire reconciliation story: DDMS
 * exists to notice that the OEM's system does not hold a policy the dealership
 * believes exists. Filling all of them in would have produced a tidier fixture
 * that demonstrates nothing.
 *
 * Where a policy number is present it carries an insurer's own format and is
 * prefixed `SIM-`, on this side of the boundary too. R-41 asks that a policy
 * number no insurer issued stays marked on the policy itself, and every number
 * in this fixture is exactly that — the rule does not become optional on the
 * side we happen not to be writing.
 *
 * It is also load-bearing for reconciliation, which compares the two numbers as
 * **strings**. Marking one side and not the other manufactured fifty-five
 * `CONFLICT` rows — *two different policies against one vehicle*, the sharpest
 * state that screen has — out of deals where both systems held the same policy.
 */

import { MODELS } from "./catalogue.ts";
import { DEAL_HELPERS } from "./generate.ts";
import type { DmsDeal } from "./types.ts";

const { R, pick, int, chance, weighted, person, chassis, engine, regNo, daysAgoInMonth, MODEL_MIX, EX_SHOWROOM, COLOURS, ALL_SALES, FEMALE_FIRST, DEALER } = DEAL_HELPERS;

const OCCUPATIONS = [
  "Salaried - Private Sector", "Self Employed - Trader", "Salaried - Government",
  "Self Employed - Professional", "Student", "Retired", "Agriculture", "Homemaker",
];

/** Where a west-Delhi Hero dealer's customers actually live. */
const LOCALITIES: Array<[string, string, string]> = [
  ["Ramesh Nagar", "West Delhi", "110015"],
  ["Rohini Sector 7", "North West Delhi", "110085"],
  ["Janakpuri", "West Delhi", "110058"],
  ["Dwarka Sector 12", "South West Delhi", "110078"],
  ["Pitampura", "North West Delhi", "110034"],
  ["Uttam Nagar", "West Delhi", "110059"],
  ["Paschim Vihar", "West Delhi", "110063"],
  ["Karol Bagh", "Central Delhi", "110005"],
  ["Ajmeri Gate", "Central Delhi", "110006"],
  ["Najafgarh", "South West Delhi", "110043"],
];

const FINANCIERS: Array<[string, string]> = [
  ["Bajaj Finance Limited", "Rajouri Garden"],
  ["HDB Financial Services", "Janakpuri"],
  ["TVS Credit Services", "Pitampura"],
  ["IDFC First Bank", "Rohini"],
];

const INSURER_CODES = ["BAJAJ", "ICICI", "TATA", "HDFC"];

function pan(): string {
  const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 5; i++) s += L[int(0, 25)];
  s += String(int(1000, 9999));
  s += L[int(0, 25)];
  return s;
}

/**
 * Formatted against a base the caller supplies rather than `new Date()`.
 *
 * Taking the base as an argument is what keeps this reproducible: the clock is
 * read once, by the seeder, and everything below is a pure function of it.
 */
function dt(daysAgo: number, base: Date): string {
  const d = new Date(base.getTime() - daysAgo * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export function generateDeals(count: number, base: Date): DmsDeal[] {
  const out: DmsDeal[] = [];
  for (let i = 0; i < count; i++) {
    const p = person();
    const parts = p.name.split(" ");
    const first = parts[1] ?? "Rohit";
    const last = parts.slice(2).join(" ") || "Kumar";
    const model = weighted(MODEL_MIX);
    const price = EX_SHOWROOM[model as keyof typeof EX_SHOWROOM];
    const [locality, district, pin] = pick(LOCALITIES);
    const booked = daysAgoInMonth(45);
    const dealId = `HMC-DL-2026-${String(100 + i).padStart(6, "0")}`;

    // The state spread is the claim being made. Most sales complete; the ones
    // that matter are stuck before insurance or before registration, and those
    // are the two the mirror can see and the dealership's own reporting cannot.
    const status = weighted({
      DELIVERED: 62,
      AWAITING_REGISTRATION: 18,
      AWAITING_INSURANCE: 12,
      BOOKED: 6,
      CANCELLED: 2,
    }) as DmsDeal["status"];

    const delivered = status === "DELIVERED";
    const insured = delivered || status === "AWAITING_REGISTRATION";
    const invoiced = status !== "BOOKED" && status !== "CANCELLED";
    const financed = chance(0.44);
    const [finName, finBranch] = pick(FINANCIERS);
    const od = Math.round(price * 0.014);
    const tp = model === "HER-XPL-200" ? 3_851 : 2_901;
    const registered = delivered && chance(0.86);

    out.push({
      dealId,
      dealerCode: DEALER,
      status,
      bookingDt: dt(booked, base),
      plannedDeliveryDt: dt(Math.max(0, booked - int(2, 6)), base),
      actualDeliveryDt: delivered ? dt(Math.max(0, booked - int(2, 8)), base) : null,
      salesPerson: { empCode: pick(ALL_SALES), empName: "", mobileNo: null },
      customer: {
        custId: `CUST-0417-${89000 + i}`,
        custType: "INDIVIDUAL",
        salutation: p.salutation,
        firstName: first,
        midName: null,
        lastName: last,
        gender: p.salutation === "Mr" ? "M" : "F",
        dob: `${String(int(1, 28)).padStart(2, "0")}-${String(int(1, 12)).padStart(2, "0")}-${int(1968, 2004)}`,
        occupationDesc: pick(OCCUPATIONS),
        mobileNo: p.mobileNo,
        emailId: chance(0.62) ? `${first.toLowerCase()}.${last.split(" ")[0]!.toLowerCase()}@example.in` : null,
        panNo: chance(0.8) ? pan() : null,
        aadhaarLast4: String(int(1000, 9999)),
        gstin: null,
        areaType: "URBAN",
        addr: {
          line1: `${int(1, 400)}${pick(["", "-A", "/2", "-B"])}, ${pick(["Main Road", "Gali No 4", "Block C", "Sector 3"])}`,
          line2: locality,
          locality,
          cityDesc: "New Delhi",
          distDesc: district,
          stateDesc: "Delhi",
          pin,
        },
      },
      vehicle: {
        chassisNo: chassis(7_000 + i),
        engineNo: engine(7_000 + i),
        modelCode: model,
        model: MODELS[model]!,
        colourDesc: pick(COLOURS),
        mfgMth: int(1, 7),
        mfgYr: 2026,
        exShowroomAmt: `${price}.00`,
        importedFlg: "N",
        yardInDt: dt(booked + int(5, 40), base),
        allocatedToDealId: dealId,
      },
      // A real proportion of files carry no nominee, which is a compliance gap
      // a dealership does not know it has until somebody asks for the policy.
      nominee: chance(0.72)
        ? {
            nomineeName: `${pick(FEMALE_FIRST)} ${last}`,
            nomineeDob: `${String(int(1, 28)).padStart(2, "0")}-${String(int(1, 12)).padStart(2, "0")}-${int(1948, 1990)}`,
            relationDesc: pick(["MOTHER", "FATHER", "SPOUSE", "BROTHER", "SISTER"]),
            appointeeName: null,
            appointeeRelationDesc: null,
          }
        : null,
      finance: financed
        ? {
            financedFlg: "Y",
            financierName: finName,
            financierBranchDesc: finBranch,
            loanAcctNo: `${pick(["BFL", "HDB", "TVS", "IDF"])}${int(10_000_000, 99_999_999)}`,
            loanAmt: `${Math.round(price * (0.6 + R() * 0.25))}.00`,
            tenureMths: pick([12, 18, 24, 30, 36]),
          }
        : {
            financedFlg: "N",
            financierName: null,
            financierBranchDesc: null,
            loanAcctNo: null,
            loanAmt: null,
            tenureMths: null,
          },
      invoice: invoiced
        ? {
            invoiceNo: `INV/0417/26-27/0${1400 + i}`,
            invoiceDt: dt(Math.max(0, booked - int(1, 3)), base),
            invoiceAmt: `${price}.00`,
          }
        : { invoiceNo: null, invoiceDt: null, invoiceAmt: null },
      registration: {
        regNo: registered ? regNo() : null,
        regDt: registered ? dt(Math.max(0, booked - int(9, 18)), base) : null,
        rtoCode: delivered ? "DL03" : null,
        form21No: invoiced ? `F21/0417/26-27/0${1400 + i}` : null,
        form21Dt: invoiced ? dt(Math.max(0, booked - int(1, 3)), base) : null,
        form22No: `F22-HMC-2026-${int(4_000_000, 4_999_999)}`,
      },
      insurance: insured
        ? {
            insurerCode: pick(INSURER_CODES),
            // `SIM-` on the OEM's copy too, and this is a correction rather
            // than a flourish. R-41 says a policy number no insurer issued
            // stays marked on the policy itself, and every number in this mock
            // is exactly that — marking DDMS's copy while leaving the dealer's
            // unmarked would be applying the rule to whichever side we happened
            // to write.
            //
            // It is also load-bearing for reconciliation, which is **string
            // equality** between the two numbers. Marking one side and not the
            // other manufactured fifty-five CONFLICT rows — *two different
            // policies against one vehicle* — out of deals where both systems
            // held the same policy. The prefix has to be on both sides or on
            // neither, and R-41 says which.
            policyNo: `SIM-${pick(["OG-27", "3005", "0231", "2311"])}-${int(1000, 9999)}-${int(1000, 9999)}-${int(10_000, 99_999)}`,
            odStartDt: dt(Math.max(0, booked - int(1, 3)), base),
            odEndDt: dt(Math.max(0, booked - int(1, 3)) - 365, base),
            tpStartDt: dt(Math.max(0, booked - int(1, 3)), base),
            tpEndDt: dt(Math.max(0, booked - int(1, 3)) - 1_826, base),
            odPremiumAmt: `${od}.00`,
            tpPremiumAmt: `${tp}.00`,
            paPremiumAmt: "330.00",
            totalPremiumAmt: `${od + tp + 330}.00`,
            idvAmt: `${Math.round(price * 0.85)}.00`,
          }
        : {
            insurerCode: null,
            policyNo: null,
            odStartDt: null,
            odEndDt: null,
            tpStartDt: null,
            tpEndDt: null,
            odPremiumAmt: null,
            tpPremiumAmt: null,
            paPremiumAmt: null,
            totalPremiumAmt: null,
            idvAmt: null,
          },
    } as DmsDeal);
  }
  return out;
}
