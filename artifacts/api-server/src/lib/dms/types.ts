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

/** Every non-2xx response from the mock carries this shape. */
export interface DmsErrorBody {
  errCode?: string;
  errDesc?: string;
}
