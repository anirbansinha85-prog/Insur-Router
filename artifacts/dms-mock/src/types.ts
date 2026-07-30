/**
 * DMS wire shapes.
 *
 * These types describe what the mock *emits*, not what InsurRouter wants. The
 * two are deliberately different: an OEM dealer-management system is a
 * decade-old ERP, and its API reflects that. Dates arrive as `DD-MM-YYYY`,
 * money arrives as a decimal string, codes are uppercase, and field names are
 * abbreviated (`cc`, `mfgMth`). Nothing here should be consumed directly —
 * everything passes through an adapter that produces the canonical internal
 * shape.
 *
 * Keeping the mock awkward is the point. A mock that already speaks our
 * vocabulary would hide the translation work that a real integration requires,
 * and the adapter is where per-OEM differences get absorbed.
 *
 * SCOPE: constructed to be structurally representative of an Indian two-wheeler
 * OEM DMS. It is NOT a copy of any vendor's published contract, and no real
 * dealer API was consulted. Field *coverage* is driven by what an insurance
 * proposal actually needs (see README) — that part is researched.
 */

/** `DD-MM-YYYY`. The DMS has no concept of ISO 8601. */
export type DmsDate = string;

/** Decimal string, two places, no separators — e.g. `"79150.00"`. */
export type DmsAmount = string;

export type DmsFuel = "PETROL" | "ELECTRIC";
export type DmsBodyStyle = "MOTORCYCLE" | "SCOOTER";

/**
 * Deal lifecycle. `AWAITING_INSURANCE` is the state we care about: a unit has
 * been allocated and invoiced, but the registration file cannot go to the RTO
 * until a policy exists.
 */
export type DmsDealStatus =
  | "BOOKED"
  | "AWAITING_INSURANCE"
  | "AWAITING_REGISTRATION"
  | "DELIVERED"
  | "CANCELLED";

/** A model in the OEM catalogue. Static reference data. */
export interface DmsModel {
  modelCode: string;
  modelDesc: string;
  variantDesc: string;
  bodyStyle: DmsBodyStyle;
  fuel: DmsFuel;
  /** Engine displacement. Null on electric models. */
  cc: number | null;
  /** Continuous motor rating in kW. Null on petrol models. */
  motorKw: number | null;
  seatCap: number;
  /** Warranty in months and kilometres, whichever expires first. */
  warrantyMonths: number;
  warrantyKm: number;
  /** Free-service milestones, in order. */
  freeServices: DmsServiceMilestone[];
  /** Paid services recur at this interval once free services are exhausted. */
  paidServiceIntervalKm: number;
  paidServiceIntervalDays: number;
}

export interface DmsServiceMilestone {
  seq: number;
  /** Odometer target. */
  km: number;
  /** Days from delivery. Whichever of km/days comes first is the due point. */
  days: number;
}

/**
 * A physical unit in the dealer's yard. This is the authoritative source for
 * every vehicle attribute an insurer asks for — none of it should ever be read
 * off a document when the DMS is reachable.
 */
export interface DmsStockUnit {
  chassisNo: string;
  engineNo: string;
  modelCode: string;
  colourDesc: string;
  mfgMth: number;
  mfgYr: number;
  /** Ex-showroom, exclusive of registration/insurance/accessories. */
  exShowroomAmt: DmsAmount;
  /** `Y` if imported (CBU). Proposal forms ask indigenous vs imported. */
  importedFlg: "Y" | "N";
  yardInDt: DmsDate;
  allocatedToDealId: string | null;
}

/** Customer master record. */
export interface DmsCustomer {
  custId: string;
  custType: "INDIVIDUAL" | "CORPORATE";
  salutation: string;
  firstName: string;
  midName: string | null;
  lastName: string;
  /** `M` | `F` | `T` — the third option appears on current proposal forms. */
  gender: "M" | "F" | "T" | null;
  dob: DmsDate | null;
  occupationDesc: string | null;
  mobileNo: string | null;
  emailId: string | null;
  panNo: string | null;
  /** Masked in the DMS as it is in most real systems — last 4 only. */
  aadhaarLast4: string | null;
  gstin: string | null;
  addr: DmsAddress;
  /** IRDAI proposal forms segment the customer this way. */
  areaType: "URBAN" | "RURAL" | null;
}

export interface DmsAddress {
  line1: string;
  line2: string | null;
  locality: string | null;
  cityDesc: string;
  distDesc: string | null;
  stateDesc: string;
  pin: string;
}

/**
 * Nominee for the compulsory owner-driver personal-accident cover.
 *
 * Present in the DMS only if the dealer happened to capture it — it is not part
 * of a vehicle sale, so it is frequently null. That gap is real and the seeded
 * data preserves it: no document a customer brings carries a nominee, so this
 * is the one mandatory field that must always be *asked*.
 */
export interface DmsNominee {
  nomineeName: string | null;
  nomineeDob: DmsDate | null;
  relationDesc: string | null;
  /** Required when the nominee is a minor. */
  appointeeName: string | null;
  appointeeRelationDesc: string | null;
}

/** Hypothecation. Most two-wheelers in India are financed. */
export interface DmsFinance {
  financedFlg: "Y" | "N";
  financierName: string | null;
  financierBranchDesc: string | null;
  loanAcctNo: string | null;
  loanAmt: DmsAmount | null;
  tenureMths: number | null;
}

/**
 * Fields that do not exist at insurance time and get written back later.
 *
 * The whole point of a new-vehicle policy is that it is issued *before* any of
 * this exists. The RTO will not register the vehicle without a live policy, so
 * `regNo` is necessarily null when the proposal is made and is endorsed onto
 * the policy afterwards.
 */
export interface DmsRegistration {
  regNo: string | null;
  regDt: DmsDate | null;
  rtoCode: string | null;
  /** Form 21 (sale certificate) — issued by the dealer, precedes registration. */
  form21No: string | null;
  form21Dt: DmsDate | null;
  /** Form 22 (roadworthiness) — issued by the manufacturer. */
  form22No: string | null;
}

/** Written back once an insurer responds. Null until then. */
export interface DmsInsurance {
  insurerCode: string | null;
  policyNo: string | null;
  /** Own-damage cover, renewed annually. */
  odStartDt: DmsDate | null;
  odEndDt: DmsDate | null;
  /** Third-party cover — five years on a new two-wheeler. */
  tpStartDt: DmsDate | null;
  tpEndDt: DmsDate | null;
  odPremiumAmt: DmsAmount | null;
  tpPremiumAmt: DmsAmount | null;
  paPremiumAmt: DmsAmount | null;
  totalPremiumAmt: DmsAmount | null;
  idvAmt: DmsAmount | null;
}

export interface DmsInvoice {
  invoiceNo: string | null;
  invoiceDt: DmsDate | null;
  invoiceAmt: DmsAmount | null;
}

/** The dealership itself — the tenant, in product terms. */
export interface DmsDealer {
  dealerCode: string;
  dealerName: string;
  oemCode: string;
  addr: DmsAddress;
  gstin: string;
  /** Dealer's own insurance intermediary identity, printed on the proposal. */
  intermediary: DmsIntermediary;
}

/**
 * How this dealer reaches insurers.
 *
 * `BROKER` — the dealer transacts through a broker's consolidated platform,
 * which fronts several insurers on one login. Integrating that platform reaches
 * every insurer on it at once.
 * `DIRECT_AGENT` — the dealer holds its own agency code with one insurer and
 * logs into that insurer's portal.
 */
export interface DmsIntermediary {
  channel: "BROKER" | "DIRECT_AGENT";
  intermediaryName: string;
  /** Broker's IRDAI registration, or the dealer's own agency code. */
  intermediaryCode: string;
  contactEmail: string | null;
  contactMobile: string | null;
}

export interface DmsSalesPerson {
  empCode: string;
  empName: string;
  mobileNo: string | null;
}

/** The full deal — one customer buying one allocated unit. */
export interface DmsDeal {
  dealId: string;
  dealerCode: string;
  status: DmsDealStatus;
  bookingDt: DmsDate;
  plannedDeliveryDt: DmsDate | null;
  actualDeliveryDt: DmsDate | null;
  salesPerson: DmsSalesPerson;
  customer: DmsCustomer;
  /** Denormalised model attributes, as DMS APIs habitually do. */
  vehicle: DmsStockUnit & { model: DmsModel };
  nominee: DmsNominee;
  finance: DmsFinance;
  invoice: DmsInvoice;
  registration: DmsRegistration;
  insurance: DmsInsurance;
}

/** Computed, not stored — derived from delivery date and the model schedule. */
export interface DmsServiceScheduleEntry {
  seq: number;
  kind: "FREE" | "PAID";
  dueByDt: DmsDate;
  dueByKm: number;
  status: "PENDING" | "DUE" | "OVERDUE" | "DONE";
}

export interface DmsServiceSchedule {
  dealId: string;
  chassisNo: string;
  warrantyStartDt: DmsDate | null;
  warrantyEndDt: DmsDate | null;
  warrantyKm: number;
  entries: DmsServiceScheduleEntry[];
}
