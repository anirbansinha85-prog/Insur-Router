/**
 * Three ways in, one record.
 *
 * DDMS was built against an OEM API because that is the tidy case, and the tidy
 * case is the minority. **The dealers with no API are most of the market**, they
 * will not be given one, and they feel the pain the product exists to fix more
 * sharply than the groups that have one — a sub-dealer doing five units a month
 * cannot afford to lose a file, and nobody has built him anything.
 *
 * > **Ingestion varies. Completion does not.**
 *
 * That sentence is the whole design. Everything above the mirror — the seven
 * classifiers, the queue, the journey runtime, the invoice that is coming —
 * reads the same columns whatever produced them. Nothing downstream may branch
 * on the path, and the type system is the first line of that: `DealRecord`
 * below has no field saying where it came from. The provenance travels
 * *alongside* it and is written to a different column.
 *
 * ## The seam is a source, not a format
 *
 * A source answers two questions, and the split is what preserves the one
 * expensive optimisation the API path depends on:
 *
 * - **`list()`** — cheap. Every key I can see, and a fingerprint of its
 *   content. For the API that is the summary endpoint; for a report it is the
 *   file, parsed once; for documents it is what is waiting to be read.
 * - **`load(keys)`** — expensive. The full record for the ones that moved.
 *
 * On a busy dealership most rows are untouched most of the time, and syncing
 * without that split is N full round trips against an ERP that returns 503 at
 * month end. Every path fits the shape honestly, which is the test of whether
 * an abstraction is the right one.
 */

/** What kind of data. The seven modules, unchanged. */
export type DataType =
  | "DEAL"
  | "JOB_CARD"
  | "ENQUIRY"
  | "REGISTRATION"
  | "PART"
  | "RECEIVABLE"
  | "VEHICLE";

/**
 * How it gets in.
 *
 * Not a fallback chain. A dealership picks one per data type and it is theirs —
 * stock by report, invoices by document, and the API two years later when the
 * OEM opens it, without breaking anything already running.
 */
export type IngestPath = "API" | "REPORT" | "DOCUMENT";

/** How fresh a path's answer can possibly be, said out loud rather than implied. */
export const FRESHNESS: Record<IngestPath, string> = {
  API: "live",
  REPORT: "as at the last export",
  DOCUMENT: "as at each document",
};

/**
 * A record, plus what is known about how much to believe it.
 *
 * `confidence` is **sparse on purpose** — only fields there is a reason to doubt.
 * An API field is certain and writing 1.0 against every column of every row
 * would be a megabyte of JSON saying nothing. An absent entry means *no reason
 * to doubt it*, which is the same convention `dealer_policy` uses for a number
 * nobody has changed.
 */
export interface Sourced<T> {
  key: string;
  record: T;
  path: IngestPath;
  /** `field -> 0..1`, only below certainty. */
  confidence?: Record<string, number>;
  /** The drop it came from, where there was one. */
  batchId?: number;
}

/** What `list()` returns: enough to tell *moved* from *unchanged*, and no more. */
export interface Listed {
  key: string;
  /** Stable hash of whatever the source can see cheaply. */
  fingerprint: string;
}

export interface Source<T> {
  path: IngestPath;
  /** Cheap. Every key this source can see. */
  list(): Promise<Listed[]>;
  /** Expensive. Only what moved. */
  load(keys: string[]): Promise<Array<Sourced<T>>>;
  /**
   * Whether an absent key means the record is gone.
   *
   * **True for an API**, which lists a dealership's whole book every time, so a
   * deal that stops appearing has genuinely gone. **False for documents**,
   * which arrive one at a time and say nothing at all about the ones that did
   * not — marking every other deal in the dealership as disappeared because
   * somebody scanned one invoice is the kind of mistake a path-blind sync makes
   * unless the source is asked.
   *
   * A report is the interesting case and the answer is *it depends on the
   * export*, so it is a property of the source instance rather than of the
   * path.
   */
  listIsComplete: boolean;
}

/**
 * A deal, flat, canonical, and identical whichever path produced it.
 *
 * This is exactly what `projectDeal` has always lifted out of the API's nested
 * payload — which is the point: the canonical shape was already there, unnamed,
 * and naming it is most of what made three paths possible.
 */
export interface DealRecord {
  dealId: string;
  status: string;
  bookingDate: string | null;
  plannedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  customerName: string | null;
  customerMobile: string | null;
  modelDescription: string | null;
  chassisNo: string | null;
  engineNo: string | null;
  exShowroomAmount: number | null;
  dmsPolicyNo: string | null;
  dmsInsurerCode: string | null;
  dmsRegNo: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  /** The payload as received, whatever shape that was. */
  raw: Record<string, unknown>;
}

/**
 * The fields a mapping may fill, with what each is so a model has something to
 * match headings against.
 *
 * `dealId` is `required` because a row without a key is not a record — it
 * cannot be matched to an existing deal, cannot be updated, and would arrive as
 * a new deal on every single drop.
 */
export const DEAL_FIELDS: Array<{
  field: keyof DealRecord;
  what: string;
  required?: boolean;
  type: "text" | "date" | "amount";
}> = [
  { field: "dealId", what: "The deal, order or booking number. The dealer's own reference.", required: true, type: "text" },
  { field: "status", what: "Where the deal is: booked, invoiced, delivered.", required: true, type: "text" },
  { field: "bookingDate", what: "When the customer booked.", type: "date" },
  { field: "plannedDeliveryDate", what: "The delivery date promised to the customer.", type: "date" },
  { field: "actualDeliveryDate", what: "When the vehicle actually went out.", type: "date" },
  { field: "customerName", what: "The buyer's name.", type: "text" },
  { field: "customerMobile", what: "The buyer's mobile number.", type: "text" },
  { field: "modelDescription", what: "The model sold, as the dealer writes it.", type: "text" },
  { field: "chassisNo", what: "Chassis or VIN.", type: "text" },
  { field: "engineNo", what: "Engine number.", type: "text" },
  { field: "exShowroomAmount", what: "Ex-showroom price, in rupees.", type: "amount" },
  { field: "dmsPolicyNo", what: "The insurance policy number the dealer's system holds.", type: "text" },
  { field: "dmsInsurerCode", what: "Which insurer.", type: "text" },
  { field: "dmsRegNo", what: "The registration number, once allotted.", type: "text" },
  { field: "invoiceNo", what: "The tax invoice number.", type: "text" },
  { field: "invoiceDate", what: "The invoice date.", type: "date" },
];

/**
 * What a report may carry, per data type (OBJ-24 widened).
 *
 * `DEAL_FIELDS` was the only vocabulary for as long as deals were the only
 * module a report could feed, and `mapping.ts` referred to it by name in six
 * places. That is the whole of what made the report path deals-only: the parser,
 * the batches, the provenance columns and the graduation were already
 * data-type agnostic, and one constant was not.
 *
 * **The field names are the DMS's, not ours.** `enqDt`, not `enquiredAt`. Each
 * sync already converts its own summary shape into mirror columns, and a report
 * that produced *our* names would need a second converter that could disagree
 * with the first. So a report source produces exactly what the client produces,
 * and the sync below it cannot tell them apart — which is the same seam
 * `Source<T>` is, one level down.
 */
export interface FieldSpec {
  field: string;
  what: string;
  required?: boolean;
  type: "text" | "date" | "amount";
}

/**
 * Leads. The biggest worklist in the product and the one a dealership without
 * an API loses most by not having: an enquiry nobody answered is invisible
 * everywhere else.
 */
export const ENQUIRY_FIELDS: FieldSpec[] = [
  { field: "enqId", what: "The enquiry or lead number. The dealer's own reference.", required: true, type: "text" },
  { field: "stage", what: "Where the lead has got to: open, test ride done, lost, converted.", required: true, type: "text" },
  { field: "enqDt", what: "When the enquiry came in.", type: "date" },
  { field: "source", what: "Where the lead came from — walk-in, the OEM's portal, a referral.", type: "text" },
  { field: "grade", what: "How warm the salesman graded it: hot, warm, cold.", type: "text" },
  { field: "custName", what: "The customer's name.", type: "text" },
  { field: "mobileNo", what: "The customer's mobile number.", type: "text" },
  { field: "modelCodeInterest", what: "The model they asked about.", type: "text" },
  { field: "assignedEmpCode", what: "The employee code of the salesman it sits with.", type: "text" },
  /*
   * The manufacturer's clock, and it is theirs.
   *
   * A call logged in DDMS does not stop it — the OEM measures this field in
   * their own system — so a report that leaves it out leaves the dealership
   * unable to see the one breach the OEM will bill them for.
   */
  { field: "firstContactAt", what: "When somebody first contacted them. The manufacturer measures its response clock on this.", type: "date" },
  { field: "lastContactDt", what: "The most recent contact.", type: "date" },
  { field: "nextFollowUpDt", what: "When the salesman said they would call back.", type: "date" },
  { field: "lostReasonDesc", what: "Why the lead was lost, where it was.", type: "text" },
  { field: "convertedDealId", what: "The deal number, once the lead became a sale.", type: "text" },
];

export const FIELDS_FOR: Partial<Record<DataType, FieldSpec[]>> = {
  DEAL: DEAL_FIELDS as unknown as FieldSpec[],
  ENQUIRY: ENQUIRY_FIELDS,
};

/**
 * Which data types a dealership may actually feed by report today.
 *
 * Derived from the vocabularies rather than written beside them, so a module
 * cannot be offered on a screen before it can be read. **A picker that lists a
 * path which does nothing is worse than a picker with two entries** — the
 * dealership drops the file, nothing happens, and the product has told them a
 * lie with a dropdown.
 */
export function reportableTypes(): DataType[] {
  return (Object.keys(FIELDS_FOR) as DataType[]).filter((t) => (FIELDS_FOR[t]?.length ?? 0) > 0);
}
