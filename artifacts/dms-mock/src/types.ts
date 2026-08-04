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

/**
 * `DD-MM-YYYY HH:mm:ss`. What legacy ERPs put in a "last modified" column.
 *
 * Awkward on purpose, like everything else here. An incremental sync has to
 * parse and compare these, and a client that assumes ISO 8601 will silently
 * compare strings lexicographically and pull the wrong window.
 */
export type DmsTimestamp = string;

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

// ── CRM ─────────────────────────────────────────────────────────────────────
// Where a sale starts, and where most of them quietly stop.

/**
 * Where the enquiry came from.
 *
 * `OEM_PORTAL` is the one that behaves differently from every other source. The
 * manufacturer generates the lead on its own website or campaign and pushes it
 * to the dealer, then **measures how long the dealer took to respond** — 30
 * minutes is the common mandate — and allocates future leads accordingly. A
 * walk-in nobody greets is a lost sale; an OEM lead nobody rings is a lost sale
 * *and* a worse allocation next quarter.
 */
export type DmsEnquirySource =
  | "WALKIN"
  | "PHONE"
  | "WEB"
  | "OEM_PORTAL"
  | "REFERRAL"
  | "CAMPAIGN"
  | "EXCHANGE";

/** Hot/warm/cold. Universal in Indian dealer CRM, and set by the executive. */
export type DmsEnquiryGrade = "HOT" | "WARM" | "COLD";

export type DmsEnquiryStage =
  | "NEW"
  | "CONTACTED"
  | "TEST_RIDE"
  | "QUOTED"
  | "NEGOTIATION"
  | "BOOKED"
  | "LOST";

export interface DmsEnquiryFollowUp {
  fuId: string;
  dueDt: DmsDate;
  doneDt: DmsDate | null;
  outcomeDesc: string | null;
  empCode: string;
}

export interface DmsTestRide {
  trId: string;
  modelCode: string;
  scheduledDt: DmsTimestamp;
  doneFlg: "Y" | "N";
}

export interface DmsEnquiry {
  enqId: string;
  dealerCode: string;
  /** When the enquiry arrived. Timestamped, because the SLA is in minutes. */
  enqDt: DmsTimestamp;
  source: DmsEnquirySource;
  grade: DmsEnquiryGrade;
  stage: DmsEnquiryStage;
  custName: string;
  mobileNo: string;
  emailId: string | null;
  cityDesc: string | null;
  modelCodeInterest: string;
  /**
   * The executive who owns it. A DMS keeps this pointing at whoever was
   * assigned, whether or not that person still works here — which is how a lead
   * ends up with nobody actually looking at it.
   */
  assignedEmpCode: string;
  /**
   * First outbound contact. **Null is the interesting value**: on an OEM lead
   * it means the response clock is still running, or has already been missed.
   */
  firstContactAt: DmsTimestamp | null;
  lastContactDt: DmsDate | null;
  nextFollowUpDt: DmsDate | null;
  lostReasonDesc: string | null;
  convertedDealId: string | null;
  followUps: DmsEnquiryFollowUp[];
  testRides: DmsTestRide[];
  modifiedAt: DmsTimestamp;
}

// ── Workshop ────────────────────────────────────────────────────────────────
// The service side of the dealership. Structurally the same problem as the
// sales side: work sits still in a named state, and the state says nothing
// about whether anyone told the customer.

export type DmsEmployeeRole =
  | "SALES_EXEC"
  | "SERVICE_ADVISOR"
  | "TECHNICIAN"
  | "RTO_AGENT"
  | "ACCOUNTS"
  | "MANAGER";

/**
 * Staff master.
 *
 * `dol` — date of leaving — is the field that makes the staff-shortage case
 * arguable from data rather than anecdote. A dealership's own system already
 * knows its attrition; nobody reads it that way.
 */
export interface DmsEmployee {
  empCode: string;
  empName: string;
  dealerCode: string;
  role: DmsEmployeeRole;
  doj: DmsDate;
  dol: DmsDate | null;
  activeFlg: "Y" | "N";
  mobileNo: string | null;
}

// ── Registration ────────────────────────────────────────────────────────────
// What happens to a vehicle between the invoice and the customer holding a
// registration certificate. It is the longest-running open file in a
// dealership and the one with the most hands in it — the customer, the dealer,
// an RTO agent, the state's tax counter and the RTO itself — which is why it is
// also the one that most often stops moving without anybody noticing.

/**
 * Where a registration file has got to.
 *
 * The sequence is real and each step can stall for a different reason:
 *
 *   PENDING_DOCS   the customer still owes a document — address proof, a
 *                  signed Form 20, a passport photo
 *   READY_TO_FILE  paperwork complete. Road tax may have been collected from
 *                  the customer at invoice and not yet paid to the state
 *   TAX_PAID       road tax remitted, receipt in hand, file not yet lodged
 *   SUBMITTED      lodged with the RTO. Now it is somebody else's queue
 *   REGISTERED     number allotted
 *   RC_RECEIVED    the smart card has arrived at the dealership
 *   RC_DELIVERED   the customer has it. The only terminal state that counts
 *   REJECTED       the RTO raised an objection and sent the file back
 *
 * `RC_RECEIVED` is the one worth staring at. As far as the DMS is concerned
 * the vehicle is registered and the transaction is finished. In the building,
 * a plastic card is in a drawer and its owner does not have it.
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

/**
 * A document the customer has to produce.
 *
 * Relational rather than a flag per document, because the list genuinely varies
 * — a corporate buyer produces a GST certificate and a board resolution, an
 * individual produces neither — and because "which files are waiting on which
 * document" is the query somebody actually asks.
 */
export interface DmsRegnDoc {
  seq: number;
  docCode: string;
  docDesc: string;
  receivedFlg: "Y" | "N";
  receivedDt: DmsDate | null;
}

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
  /** The dealership's RTO agent. Null when nobody has picked the file up. */
  agentEmpCode: string | null;
  /**
   * Temporary registration. Valid one month, and the reason a customer can ride
   * away the same day — which also means a lapsed one is a vehicle on the road
   * with no valid registration at all.
   */
  tempRegNo: string | null;
  tempRegExpiryDt: DmsDate | null;
  /**
   * The policy the RTO will not register the vehicle without. Null here is the
   * single most actionable value in this module, because it is the one blockage
   * the dealership can clear from its own desk.
   */
  policyNo: string | null;
  /** Collected from the customer at invoice; remitted to the state later. */
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
  modifiedAt: DmsTimestamp;
}

export interface DmsRegnFile extends DmsRegnFileSummary {
  hsrpAmt: DmsAmount;
  agentFeeAmt: DmsAmount;
  remarksDesc: string | null;
  docs: DmsRegnDoc[];
}

// ── Spares ──────────────────────────────────────────────────────────────────
// The parts counter. A DMS holds this per dealer code, because a dealer code is
// what it thinks a business is — which is precisely why a group that owns three
// outlets cannot see across them and keeps ordering what it already has.

/**
 * One part, in one branch's bin.
 *
 * `qtyOnHand` minus `qtyReserved` is what can actually be issued today; a real
 * DMS shows the first of those on the counter screen and the difference is how
 * a storeman promises a part twice.
 */
export interface DmsPartStock {
  dealerCode: string;
  partNo: string;
  partDesc: string;
  /** Where it physically is. Useless across branches, which is the point. */
  binLocation: string | null;
  qtyOnHand: number;
  /** Committed to an open job card. Not free, though the shelf says otherwise. */
  qtyReserved: number;
  reorderLevel: number;
  mrpAmt: DmsAmount;
  /** What the dealership paid. What ageing stock is costing, in other words. */
  costAmt: DmsAmount;
  lastReceivedDt: DmsDate | null;
  /** Null means it has never moved since it arrived. */
  lastIssuedDt: DmsDate | null;
  /** Raised on the OEM and not yet delivered. */
  onOrderQty: number;
  onOrderEtaDt: DmsDate | null;
  modifiedAt: DmsTimestamp;
}

export type DmsJobCardType =
  | "FREE"
  | "PAID"
  | "RUNNING_REPAIR"
  | "ACCIDENT"
  | "CAMPAIGN"
  | "WARRANTY";

/**
 * Workshop states, in the order every DMS moves them.
 *
 * `AWAITING_PARTS` and `AWAITING_APPROVAL` are the two that matter: in both the
 * vehicle is stationary because **somebody has not made a phone call**. That is
 * the same shape as a deal sitting in `AWAITING_INSURANCE`, and it is why the
 * workshop was the right second module.
 *
 * `READY` is the quiet one. The work is finished and the customer does not know.
 */
export type DmsJobCardStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "AWAITING_PARTS"
  | "AWAITING_APPROVAL"
  | "READY"
  | "INVOICED"
  | "DELIVERED";

export interface DmsJobCardLabour {
  seq: number;
  labourCode: string;
  labourDesc: string;
  hrs: number;
  rateAmt: DmsAmount;
}

export interface DmsJobCardPart {
  seq: number;
  partNo: string;
  partDesc: string;
  qty: number;
  rateAmt: DmsAmount;
  /** Covered under warranty — billed to the OEM, not the customer. */
  warrantyFlg: "Y" | "N";
  /** `N` while the part is not on the shelf. This is what AWAITING_PARTS means. */
  issuedFlg: "Y" | "N";
}

/** Post-service follow-up. Recorded days later, if at all. */
export interface DmsPsf {
  callDt: DmsDate | null;
  satisfactionScore: number | null;
  complaintFlg: "Y" | "N" | null;
  remarksDesc: string | null;
}

export interface DmsJobCard {
  jcNo: string;
  jcDt: DmsDate;
  dealerCode: string;
  chassisNo: string;
  /** Present here, unlike on a new-vehicle deal — a serviced vehicle is registered. */
  regNo: string | null;
  custId: string;
  custName: string;
  mobileNo: string | null;
  modelDesc: string;
  odometerKm: number;
  jcType: DmsJobCardType;
  status: DmsJobCardStatus;
  advisorEmpCode: string;
  technicianEmpCode: string | null;
  bayNo: string | null;
  complaintDesc: string;
  observationDesc: string | null;
  /** What the customer was told. The number the workshop is judged on. */
  promisedDt: DmsDate;
  actualCloseDt: DmsDate | null;
  estimateAmt: DmsAmount;
  /** Null until the customer approves an estimate that grew. */
  approvedAmt: DmsAmount | null;
  finalAmt: DmsAmount | null;
  labour: DmsJobCardLabour[];
  parts: DmsJobCardPart[];
  psf: DmsPsf | null;
  modifiedAt: DmsTimestamp;
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
