/**
 * DMS wire shapes, as this service expects to receive them.
 *
 * Deliberately a *separate* declaration from `artifacts/dms-mock/src/types.ts`
 * rather than an import. The mock is a development fixture; a real OEM DMS is
 * an external system we do not control and cannot typecheck against. Importing
 * the fixture's types would make the compiler agree with us about a contract
 * the vendor never signed, and the first real integration would silently
 * inherit assumptions the mock happened to make.
 *
 * Everything here is untrusted input. The adapter validates and converts; no
 * field is consumed in this shape.
 *
 * The awkwardness is representative, not incidental: `DD-MM-YYYY` dates, money
 * as decimal strings, `Y`/`N` flags, abbreviated names, denormalised blocks.
 * That is what decade-old dealer ERPs emit.
 */

/** `DD-MM-YYYY`. The DMS has no concept of ISO 8601. */
export type DmsDate = string;

/** Decimal string, two places, no separators — e.g. `"79150.00"`. */
export type DmsAmount = string;

export interface DmsAddress {
  line1: string;
  line2: string | null;
  locality: string | null;
  cityDesc: string;
  distDesc: string | null;
  stateDesc: string;
  pin: string;
}

export interface DmsModel {
  modelCode: string;
  modelDesc: string;
  variantDesc: string;
  bodyStyle: string;
  fuel: "PETROL" | "ELECTRIC";
  /** Engine displacement. Null on electric models. */
  cc: number | null;
  /** Continuous motor rating in kW. Null on petrol models. */
  motorKw: number | null;
  seatCap: number;
}

export interface DmsStockUnit {
  chassisNo: string;
  engineNo: string;
  modelCode: string;
  colourDesc: string;
  mfgMth: number;
  mfgYr: number;
  exShowroomAmt: DmsAmount;
  importedFlg: "Y" | "N";
  yardInDt: DmsDate;
  allocatedToDealId: string | null;
}

export interface DmsCustomer {
  custId: string;
  custType: "INDIVIDUAL" | "CORPORATE";
  salutation: string;
  firstName: string;
  midName: string | null;
  lastName: string;
  gender: "M" | "F" | "T" | null;
  dob: DmsDate | null;
  occupationDesc: string | null;
  mobileNo: string | null;
  emailId: string | null;
  panNo: string | null;
  /** Masked at source — last four digits only, as in most real systems. */
  aadhaarLast4: string | null;
  gstin: string | null;
  addr: DmsAddress;
  areaType: "URBAN" | "RURAL" | null;
}

export interface DmsNominee {
  nomineeName: string | null;
  nomineeDob: DmsDate | null;
  relationDesc: string | null;
  appointeeName: string | null;
  appointeeRelationDesc: string | null;
}

export interface DmsFinance {
  financedFlg: "Y" | "N";
  financierName: string | null;
  financierBranchDesc: string | null;
  loanAcctNo: string | null;
  loanAmt: DmsAmount | null;
  tenureMths: number | null;
}

export interface DmsRegistration {
  regNo: string | null;
  regDt: DmsDate | null;
  rtoCode: string | null;
  form21No: string | null;
  form21Dt: DmsDate | null;
  form22No: string | null;
}

export interface DmsInsurance {
  insurerCode: string | null;
  policyNo: string | null;
  odStartDt: DmsDate | null;
  odEndDt: DmsDate | null;
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

export interface DmsDeal {
  dealId: string;
  dealerCode: string;
  status: string;
  bookingDt: DmsDate;
  plannedDeliveryDt: DmsDate | null;
  actualDeliveryDt: DmsDate | null;
  customer: DmsCustomer;
  /** Denormalised model attributes, as DMS APIs habitually do. */
  vehicle: DmsStockUnit & { model: DmsModel };
  nominee: DmsNominee;
  finance: DmsFinance;
  invoice: DmsInvoice;
  registration: DmsRegistration;
  insurance: DmsInsurance;
}

/**
 * `GET /deals` — the worklist shape. Deliberately not the full record: the DMS
 * withholds complete customer data from a list, which is correct of it.
 */
export interface DmsDealSummary {
  dealId: string;
  dealerCode: string;
  status: string;
  bookingDt: DmsDate;
  custName: string;
  modelDesc: string;
  chassisNo: string;
  policyNo: string | null;
  regNo: string | null;
}

/** `GET /stock/:chassisNo` — a unit, with the deal it belongs to if allocated. */
export type DmsStockLookup = DmsStockUnit & {
  model: DmsModel;
  dealId: string | null;
};

// ── CRM ─────────────────────────────────────────────────────────────────────

export interface DmsEnquirySummary {
  enqId: string;
  dealerCode: string;
  /** `DD-MM-YYYY HH:mm:ss`. Timestamped because the OEM SLA is in minutes. */
  enqDt: string;
  source: string;
  grade: string;
  stage: string;
  custName: string;
  mobileNo: string;
  modelCodeInterest: string;
  assignedEmpCode: string;
  /** Null means nobody has made contact at all. */
  firstContactAt: string | null;
  lastContactDt: DmsDate | null;
  nextFollowUpDt: DmsDate | null;
  convertedDealId: string | null;
  modifiedAt: string;
}

export interface DmsEnquiry extends DmsEnquirySummary {
  emailId: string | null;
  cityDesc: string | null;
  lostReasonDesc: string | null;
  followUps: Array<{
    fuId: string;
    dueDt: DmsDate;
    doneDt: DmsDate | null;
    outcomeDesc: string | null;
    empCode: string;
  }>;
  testRides: Array<{
    trId: string;
    modelCode: string;
    scheduledDt: string;
    doneFlg: "Y" | "N";
  }>;
}

export interface DmsEmployee {
  empCode: string;
  empName: string;
  dealerCode: string;
  role: string;
  doj: DmsDate;
  dol: DmsDate | null;
  activeFlg: "Y" | "N";
  mobileNo: string | null;
  /** Work email, null once they have left. The address internal mail goes to. */
  emailId: string | null;
}

// ── Workshop ────────────────────────────────────────────────────────────────

export interface DmsJobCardSummary {
  jcNo: string;
  jcDt: DmsDate;
  dealerCode: string;
  status: string;
  jcType: string;
  regNo: string | null;
  chassisNo: string;
  custName: string;
  modelDesc: string;
  advisorEmpCode: string;
  promisedDt: DmsDate;
  actualCloseDt: DmsDate | null;
  estimateAmt: string;
  finalAmt: string | null;
  /** `DD-MM-YYYY HH:mm:ss`. Not ISO — see `toIsoDate` in the adapter. */
  modifiedAt: string;
}

export interface DmsJobCardLabour {
  seq: number;
  labourCode: string;
  labourDesc: string;
  hrs: number;
  rateAmt: string;
}

export interface DmsJobCardPart {
  seq: number;
  partNo: string;
  partDesc: string;
  qty: number;
  rateAmt: string;
  warrantyFlg: "Y" | "N";
  /** `N` while the part is not on the shelf — what AWAITING_PARTS actually means. */
  issuedFlg: "Y" | "N";
}

export interface DmsPsf {
  callDt: DmsDate | null;
  satisfactionScore: number | null;
  complaintFlg: "Y" | "N" | null;
  remarksDesc: string | null;
}

export interface DmsJobCard extends DmsJobCardSummary {
  custId: string;
  mobileNo: string | null;
  odometerKm: number;
  technicianEmpCode: string | null;
  bayNo: string | null;
  complaintDesc: string;
  observationDesc: string | null;
  approvedAmt: string | null;
  labour: DmsJobCardLabour[];
  parts: DmsJobCardPart[];
  psf: DmsPsf | null;
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Where a registration file has got to. Treated as an opaque string everywhere
 * it is stored — a real OEM will have its own vocabulary, and the derivation is
 * written against the fields, not the label.
 */
export type DmsRegnStatus =
  | "PENDING_DOCS"
  | "READY_TO_FILE"
  | "TAX_PAID"
  | "SUBMITTED"
  | "REGISTERED"
  | "RC_RECEIVED"
  | "RC_DELIVERED"
  | "REJECTED";

export interface DmsRegnFileSummary {
  regnFileNo: string;
  dealerCode: string;
  dealId: string;
  chassisNo: string;
  custName: string;
  mobileNo: string | null;
  modelDesc: string;
  status: DmsRegnStatus;
  openedDt: DmsDate;
  rtoCode: string;
  rtoOfficeDesc: string;
  agentEmpCode: string | null;
  tempRegNo: string | null;
  tempRegExpiryDt: DmsDate | null;
  policyNo: string | null;
  roadTaxAmt: DmsAmount;
  roadTaxCollectedDt: DmsDate | null;
  roadTaxPaidDt: DmsDate | null;
  submittedDt: DmsDate | null;
  regNo: string | null;
  regDt: DmsDate | null;
  hsrpFittedDt: DmsDate | null;
  rcReceivedDt: DmsDate | null;
  rcDeliveredDt: DmsDate | null;
  objectionDesc: string | null;
  modifiedAt: string;
}

export interface DmsRegnDoc {
  seq: number;
  docCode: string;
  docDesc: string;
  receivedFlg: "Y" | "N";
  receivedDt: DmsDate | null;
}

export interface DmsRegnFile extends DmsRegnFileSummary {
  hsrpAmt: DmsAmount;
  agentFeeAmt: DmsAmount;
  remarksDesc: string | null;
  docs: DmsRegnDoc[];
}

// ── Spares ──────────────────────────────────────────────────────────────────

/**
 * One part in one branch's bin.
 *
 * `qtyOnHand - qtyReserved` is what can actually be issued today. A DMS counter
 * screen shows the first number, and the difference is how one part gets
 * promised to two customers.
 */
export interface DmsPartStock {
  dealerCode: string;
  partNo: string;
  partDesc: string;
  binLocation: string | null;
  qtyOnHand: number;
  qtyReserved: number;
  reorderLevel: number;
  mrpAmt: DmsAmount;
  costAmt: DmsAmount;
  lastReceivedDt: DmsDate | null;
  lastIssuedDt: DmsDate | null;
  onOrderQty: number;
  onOrderEtaDt: DmsDate | null;
  modifiedAt: string;
}

/**
 * One thing the dealership is owed, at one outlet.
 *
 * `partyCode` is the field this module exists for: it is stable across outlets,
 * so an owner can ask what one insurer owes the group. Neither branch's own
 * ageing report can, because both are keyed to a dealer code.
 */
export interface DmsReceivable {
  dealerCode: string;
  receivableId: string;
  partyType: "CUSTOMER" | "INSURER" | "OEM" | "FINANCIER";
  partyCode: string;
  partyName: string;
  /** Where a statement would go. Null for walk-in customers. */
  partyEmailId: string | null;
  invoiceNo: string;
  invoiceDt: DmsDate;
  invoiceAmt: DmsAmount;
  receivedAmt: DmsAmount;
  dueDt: DmsDate;
  againstType: "JOB_CARD" | "DEAL" | null;
  againstKey: string | null;
  narrationDesc: string | null;
  status: "OPEN" | "PART_PAID" | "SETTLED" | "WRITTEN_OFF";
  lastReceiptDt: DmsDate | null;
  promisedDt: DmsDate | null;
  modifiedAt: string;
}

/**
 * One vehicle on the floor.
 *
 * `receivedDt` with `costAmt` and `interestRatePct` is the whole of the ageing
 * question, and nothing in the dealer's system puts the three together.
 */
export interface DmsVehicleStock {
  dealerCode: string;
  chassisNo: string;
  engineNo: string;
  modelCode: string;
  modelDesc: string;
  variantDesc: string;
  colourDesc: string;
  status: "IN_STOCK" | "ALLOCATED" | "INVOICED";
  allocatedDealId: string | null;
  costAmt: DmsAmount;
  financedFlg: "Y" | "N";
  interestRatePct: DmsAmount | null;
  receivedDt: DmsDate;
  allocatedDt: DmsDate | null;
  invoicedDt: DmsDate | null;
  modifiedAt: string;
}

/** Every non-2xx response from the mock carries this shape. */
export interface DmsErrorBody {
  errCode?: string;
  errDesc?: string;
}
