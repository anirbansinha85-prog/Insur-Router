/**
 * Hero MotoCorp DMS → canonical internal shape.
 *
 * This is where the per-OEM awkwardness is absorbed and nowhere else. Every
 * `DD-MM-YYYY`, every `"79150.00"`, every `Y`/`N` flag stops here. Downstream
 * code sees ISO dates, numbers and booleans, and has no idea which OEM the
 * data came from — that is the entire point of the registry.
 *
 * Confidence semantics matter as much as the mapping. The review UI in VeloDocs
 * highlights anything below 0.7 for a human to check, and the old stub stamped
 * 0.95 on every field including the ones it invented. A DMS field is not
 * *read*, it is authoritative — the dealer allocated that physical unit from
 * their own stock — so it scores 1.0 and must never ask for attention. Only
 * genuinely uncertain values score lower, and each tier below says why.
 */

import type { MsaFields, IngestResult } from "../document-extraction";
import { EMPTY_MSA_FIELDS } from "../document-extraction";
import { rtoForPincode } from "./rto";
import type { DmsAddress, DmsDeal } from "./types";

/** Straight from the dealer's own system. Not read, not inferred — known. */
const AUTHORITATIVE = 1.0;
/** Computed from an authoritative field by a rule, e.g. RTO from pincode. */
const DERIVED = 0.85;
/** Present but incomplete at source, e.g. an Aadhaar masked to its last four. */
const PARTIAL = 0.4;
/** Absent. Scored below the review threshold so the UI asks for it. */
const MISSING = 0.0;

/**
 * The fields a proposal needs that `MsaFields` has no room for.
 *
 * `MsaFields` predates this work and describes the original 18-field payload.
 * Rather than widen it — which would ripple through OCR, the scraper and the
 * review screen — the DMS-only facts travel alongside it. The `applications`
 * columns added for them exist; wiring this through `/ingest/push` so it lands
 * in those columns is the next step, not this one.
 */
export interface DmsDealContext {
  dealerCode: string;
  dealId: string;
  dealStatus: string;
  vehicle: {
    fuelType: "PETROL" | "ELECTRIC";
    cubicCapacity: number | null;
    motorKw: number | null;
    seatingCapacity: number | null;
    manufactureMonth: number | null;
    manufactureYear: number | null;
    colour: string | null;
    imported: boolean;
  };
  owner: {
    entityType: "INDIVIDUAL" | "CORPORATE";
    gender: "M" | "F" | "T" | null;
    gstin: string | null;
    areaType: "URBAN" | "RURAL" | null;
  };
  nominee: {
    fullName: string | null;
    dateOfBirth: string | null;
    relationship: string | null;
    appointeeName: string | null;
    appointeeRelationship: string | null;
  };
  hypothecation: {
    isHypothecated: boolean;
    financierName: string | null;
    loanAccountNumber: string | null;
  };
  invoice: {
    invoiceNo: string | null;
    invoiceDate: string | null;
    invoiceAmount: number | null;
  };
  /**
   * What the DMS could not supply and must therefore be asked. This is the
   * "identify gaps" step of the cascade made explicit, so the caller does not
   * have to re-derive it by scanning for empty strings.
   */
  gaps: string[];
}

// ── Primitive converters ─────────────────────────────────────────────────────

/** `DD-MM-YYYY` → `YYYY-MM-DD`. Returns "" for null or anything unparseable. */
export function toIsoDate(d: string | null | undefined): string {
  if (!d) return "";
  const m = d.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return "";
  const [, dd, mm, yyyy] = m;
  // Reject impossible dates rather than passing them on: a date column will
  // take 31-02-2026 and a proposal form will not.
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${yyyy}-${mm}-${dd}`;
}

/** `"79150.00"` → `79150`. Returns null rather than 0 for absent input. */
export function toAmount(a: string | null | undefined): number | null {
  if (a === null || a === undefined || a.trim() === "") return null;
  const n = Number(a);
  return Number.isFinite(n) ? n : null;
}

/** `"Y"` → true. Anything else, including null, is false. */
function toBool(flag: string | null | undefined): boolean {
  return flag === "Y";
}

/**
 * Assemble a display name from the DMS's split fields.
 *
 * The salutation is dropped: it is presentation, and an insurer's name field
 * wants the legal name. Middle name is kept when present because it appears on
 * the Aadhaar and a mismatch causes a KYC rejection.
 */
export function assembleName(c: {
  firstName: string;
  midName: string | null;
  lastName: string;
}): string {
  return [c.firstName, c.midName, c.lastName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ");
}

/** Flatten the DMS address block into the single line the MSA payload holds. */
export function flattenAddress(a: DmsAddress): string {
  return [a.line1, a.line2, a.locality, a.cityDesc, a.distDesc, a.stateDesc]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");
}

// ── The adapter ──────────────────────────────────────────────────────────────

export interface AdaptedDeal extends IngestResult {
  dealContext: DmsDealContext;
}

export function adaptHeroDeal(deal: DmsDeal): AdaptedDeal {
  const { customer: cust, vehicle, nominee, finance, invoice } = deal;
  const model = vehicle.model;

  const fields: MsaFields = { ...EMPTY_MSA_FIELDS };
  const confidence: Record<string, number> = {};
  const gaps: string[] = [];

  const set = <K extends keyof MsaFields>(key: K, value: MsaFields[K], score: number) => {
    fields[key] = value;
    confidence[key] = score;
  };

  // ── Vehicle: all authoritative, the dealer allocated this physical unit ────
  set("vehicleMake", inferMake(deal.dealerCode), DERIVED);
  set("vehicleModel", model.modelDesc, AUTHORITATIVE);
  set("vehicleVariant", model.variantDesc, AUTHORITATIVE);
  set("vehicleEngineNumber", vehicle.engineNo, AUTHORITATIVE);
  set("vehicleChassisNumber", vehicle.chassisNo, AUTHORITATIVE);

  const exShowroom = toAmount(vehicle.exShowroomAmt);
  set("vehicleExShowroomPrice", exShowroom ?? 0, exShowroom === null ? MISSING : AUTHORITATIVE);
  if (exShowroom === null) gaps.push("Ex-showroom price is missing from the DMS record");

  // Date of purchase is the invoice date. Booking is when the customer agreed
  // to buy; the invoice is when they did.
  const purchaseDate = toIsoDate(invoice.invoiceDt) || toIsoDate(deal.bookingDt);
  set("vehicleDateOfPurchase", purchaseDate, purchaseDate ? AUTHORITATIVE : MISSING);
  if (!purchaseDate) gaps.push("Date of purchase: neither invoice date nor booking date is usable");

  // ── Owner ─────────────────────────────────────────────────────────────────
  set("ownerFullName", assembleName(cust), AUTHORITATIVE);
  set("ownerBillingAddress", flattenAddress(cust.addr), AUTHORITATIVE);

  const pin = Number(String(cust.addr.pin).replace(/\D/g, ""));
  const pinValid = /^\d{6}$/.test(String(cust.addr.pin).replace(/\D/g, ""));
  set("ownerPincode", pinValid ? pin : 0, pinValid ? AUTHORITATIVE : MISSING);
  if (!pinValid) gaps.push("Pincode is missing or malformed, so the RTO cannot be derived");

  const mobile = (cust.mobileNo ?? "").replace(/\D/g, "").slice(-10);
  set("ownerPhoneNumber", mobile, mobile.length === 10 ? AUTHORITATIVE : MISSING);
  if (mobile.length !== 10) gaps.push("Mobile number is missing or not 10 digits");

  // Email is routinely absent — a vehicle sale does not require one, an
  // e-policy does. This is a normal gap, not a data-quality problem.
  set("ownerEmail", cust.emailId ?? "", cust.emailId ? AUTHORITATIVE : MISSING);
  if (!cust.emailId) gaps.push("Email address — required for e-policy delivery, must be asked");

  const dob = toIsoDate(cust.dob);
  set("ownerDateOfBirth", dob, dob ? AUTHORITATIVE : MISSING);
  if (!dob) {
    // A company has no date of birth, so for a corporate buyer this is not a
    // missing value to chase — it is a field that does not apply. Validation
    // still demands it, which is an unresolved question about how corporate
    // proposals work rather than a data-quality problem. Say which it is,
    // because the review screen otherwise shows an amber field with nothing
    // the salesperson can do about it.
    gaps.push(
      cust.custType === "CORPORATE"
        ? "Date of birth does not apply to a corporate buyer, but validation currently requires it"
        : "Date of birth is missing",
    );
  }

  // PAN is preferred over Aadhaar because the DMS holds it in full. Aadhaar is
  // masked to its last four at source — as it is in most real systems — so it
  // cannot satisfy an ID-proof field on its own and is scored to force review.
  if (cust.panNo) {
    set("ownerIdProofType", "PAN", AUTHORITATIVE);
    set("ownerIdProofNumber", cust.panNo, AUTHORITATIVE);
  } else if (cust.aadhaarLast4) {
    set("ownerIdProofType", "AADHAR", AUTHORITATIVE);
    set("ownerIdProofNumber", `XXXXXXXX${cust.aadhaarLast4}`, PARTIAL);
    gaps.push("Aadhaar is masked in the DMS — the full number must be captured from the document");
  } else {
    set("ownerIdProofType", "AADHAR", MISSING);
    set("ownerIdProofNumber", "", MISSING);
    gaps.push("No ID proof on file — KYC document required");
  }

  // ── RTO: derived, never read ──────────────────────────────────────────────
  // There is no registration certificate to copy this from. The vehicle will be
  // registered where the owner lives, so the address decides it.
  const rto = pinValid ? rtoForPincode(pin) : null;
  if (rto) {
    set("rtoRegistrationCity", rto.city, DERIVED);
    set("rtoRegistrationState", rto.state, DERIVED);
    set("rtoCode", rto.rtoCode, DERIVED);
  } else {
    // Fall back to the address's own city/state, which are authoritative even
    // when the RTO code cannot be resolved. Leaving the code blank is correct:
    // guessing one would put an unverifiable code on a proposal.
    set("rtoRegistrationCity", cust.addr.cityDesc, AUTHORITATIVE);
    set("rtoRegistrationState", cust.addr.stateDesc, AUTHORITATIVE);
    set("rtoCode", "", MISSING);
    gaps.push(
      `RTO code could not be derived from pincode ${cust.addr.pin} — not in the lookup table`,
    );
  }

  // ── Non-MSA facts ─────────────────────────────────────────────────────────
  if (cust.custType === "INDIVIDUAL" && !nominee.nomineeName) {
    gaps.push(
      "Nominee for the compulsory PA cover — no document carries this, it must be asked",
    );
  }
  if (model.fuel === "ELECTRIC" && model.motorKw === null) {
    gaps.push("Electric model with no motor kW — third-party premium cannot be banded");
  }
  if (model.fuel === "PETROL" && model.cc === null) {
    gaps.push("Petrol model with no cubic capacity — third-party premium cannot be banded");
  }

  const dealContext: DmsDealContext = {
    dealerCode: deal.dealerCode,
    dealId: deal.dealId,
    dealStatus: deal.status,
    vehicle: {
      fuelType: model.fuel,
      cubicCapacity: model.cc,
      motorKw: model.motorKw,
      seatingCapacity: model.seatCap ?? null,
      manufactureMonth: vehicle.mfgMth ?? null,
      manufactureYear: vehicle.mfgYr ?? null,
      colour: vehicle.colourDesc ?? null,
      imported: toBool(vehicle.importedFlg),
    },
    owner: {
      entityType: cust.custType,
      gender: cust.gender,
      gstin: cust.gstin,
      areaType: cust.areaType,
    },
    nominee: {
      fullName: nominee.nomineeName,
      dateOfBirth: toIsoDate(nominee.nomineeDob) || null,
      relationship: nominee.relationDesc,
      appointeeName: nominee.appointeeName,
      appointeeRelationship: nominee.appointeeRelationDesc,
    },
    hypothecation: {
      isHypothecated: toBool(finance.financedFlg),
      financierName: finance.financierName,
      loanAccountNumber: finance.loanAcctNo,
    },
    invoice: {
      invoiceNo: invoice.invoiceNo,
      invoiceDate: toIsoDate(invoice.invoiceDt) || null,
      invoiceAmount: toAmount(invoice.invoiceAmt),
    },
    gaps,
  };

  return { fields, confidence, rawText: null, engineUsed: "dms:hero", dealContext };
}

/**
 * Make is not a field in this DMS — a Hero dealer's system only ever holds Hero
 * vehicles, so the OEM is implied by the dealer rather than stored per unit.
 * Scored as derived because it comes from the integration's configuration, not
 * from the record.
 */
function inferMake(_dealerCode: string): string {
  return "Hero MotoCorp";
}
