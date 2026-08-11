/**
 * The whole record, every field, exactly as it is held.
 *
 * The queue tells somebody *what to do*. It was the only thing that told them
 * anything: a row said *"mark customer told"* and offered a button, and there
 * was no way to see the record that instruction was derived from. Acting on a
 * conclusion you cannot inspect is a thing people do twice and then stop doing.
 *
 * > *"I understand the automation is working fine, but it should open the
 * > case."*
 *
 * So this is deliberately **complete rather than curated**. Every column on the
 * row appears, labelled where there is a label and humanised where there is
 * not. A field this file has not been taught about still shows up, because the
 * failure being designed against is a value that exists and is invisible — and
 * a curated view is exactly how that happens quietly, six months after somebody
 * adds a column.
 *
 * ## Two groups, and the split is the product's whole argument
 *
 * **What the manufacturer's system holds** — pulled, never written back (R-5).
 * **What DDMS concluded** — decision fields, ours, and the thing the dealer's
 * system has no room for.
 *
 * Somebody looking at a stuck file needs to know which half a value came from,
 * because only one of the two halves is theirs to change here.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  dmsDealsTable,
  dmsRegistrationsTable,
  dmsJobCardsTable,
  dmsEnquiriesTable,
  dmsPartStockTable,
  dmsReceivablesTable,
  dmsVehicleStockTable,
} from "@workspace/db";
import type { AccessModule } from "./permissions";

export interface CaseField {
  key: string;
  label: string;
  value: string | null;
  /** `MIRROR` is the dealer's; `DDMS` is ours; `META` is sync bookkeeping. */
  origin: "MIRROR" | "DDMS" | "META";
}

export interface CaseRecord {
  module: string;
  recordKey: string;
  title: string;
  subtitle: string | null;
  fields: CaseField[];
  /** How this row got here, where the mirror records it (OBJ-24). */
  provenance: { path: string | null; confidence: Record<string, number> | null };
  lastSyncedAt: string | null;
  disappearedFromDms: boolean;
}

/**
 * Columns that are plumbing rather than fact.
 *
 * `raw` is excluded because it is the whole payload again and would bury the
 * projected columns underneath a screenful of JSON — it is reachable from the
 * mirror if anybody genuinely needs it, and nothing on this screen is a
 * substitute for that.
 */
const HIDDEN = new Set(["id", "ownerId", "raw", "rawHash", "ingestBatchId", "fieldConfidence"]);

/** Sync bookkeeping. True and rarely what somebody came here to read. */
const META = new Set([
  "firstSeenAt",
  "statusSince",
  "lastSyncedAt",
  "lastChangedAt",
  "disappearedAt",
  "showroomId",
  "dealerCode",
  "ingestPath",
]);

/**
 * Ours rather than the dealer's.
 *
 * Every one of these is something DDMS concluded or somebody here decided, and
 * the dealer's system has no field for any of them. Anything not named here and
 * not in `META` is treated as the manufacturer's — which is the safe direction:
 * a field wrongly shown as theirs is read-only on screen, and one wrongly shown
 * as ours invites somebody to think they can change it here.
 */
const OURS = new Set([
  "customerNotifiedAt",
  "customerNotifiedByUserId",
  "rtoChasedAt",
  "rtoChasedByUserId",
  "assignedAgentEmpCode",
  "assignedAgentAt",
  "contactLoggedAt",
  "contactLoggedByUserId",
  "reassignedToEmpCode",
  "reassignedAt",
  "informedAt",
  "informedByUserId",
  "transferRequestedAt",
  "transferRequestedFromShowroomId",
  "reorderRaisedAt",
  "chaseLoggedAt",
  "chaseLoggedByUserId",
  "disputedAt",
  "disputedByUserId",
  "offeredToEnqId",
  "offeredAt",
  "transferProposedToShowroomId",
  "transferProposedAt",
]);

/** Real words for the columns worth having them. */
const LABELS: Record<string, string> = {
  dealId: "Deal number",
  regnFileNo: "Registration file",
  jcNo: "Job card number",
  enqId: "Enquiry number",
  partNo: "Part number",
  chassisNo: "Chassis number",
  engineNo: "Engine number",
  status: "Status",
  stage: "Stage",
  grade: "Grade",
  customerName: "Customer",
  customerMobile: "Mobile",
  modelDescription: "Model",
  modelCode: "Model code",
  variantDescription: "Variant",
  colourDescription: "Colour",
  bookingDate: "Booked on",
  plannedDeliveryDate: "Delivery promised",
  actualDeliveryDate: "Delivered on",
  exShowroomAmount: "Ex-showroom price",
  dmsPolicyNo: "Policy number (their system)",
  dmsInsurerCode: "Insurer (their system)",
  dmsRegNo: "Registration number (their system)",
  invoiceNo: "Invoice number",
  invoiceDate: "Invoice date",
  policyNo: "Policy number",
  rtoCode: "RTO code",
  rtoOffice: "RTO office",
  agentEmpCode: "RTO agent (their system)",
  assignedAgentEmpCode: "RTO agent (assigned here)",
  assignedAgentAt: "Agent assigned",
  tempRegNo: "Temporary registration",
  tempRegExpiryDate: "Temporary registration expires",
  roadTaxAmount: "Road tax",
  roadTaxCollectedDate: "Road tax collected",
  roadTaxPaidDate: "Road tax remitted",
  submittedDate: "Lodged with the RTO",
  regNo: "Registration number",
  regDate: "Registered on",
  hsrpFittedDate: "Plate fitted",
  rcReceivedDate: "Certificate received",
  rcDeliveredDate: "Certificate handed over",
  objectionDesc: "RTO objection",
  hasPendingDoc: "Documents outstanding",
  pendingDocDesc: "Which documents",
  customerNotifiedAt: "Customer told",
  rtoChasedAt: "RTO chased",
  receivedDate: "Received on the floor",
  allocatedDate: "Allocated",
  invoicedDate: "Invoiced",
  costAmount: "Cost",
  interestRatePct: "Floor-plan rate",
  isFinanced: "On floor plan",
  offeredToEnqId: "Offered against",
  offeredAt: "Offered on",
  partyCode: "Party code",
  partyName: "Party",
  dueDate: "Due",
  outstandingAmount: "Outstanding",
  promisedDate: "Payment promised",
  onOrderQty: "On order",
  reorderLevel: "Reorder level",
  quantityOnHand: "In stock",
  reservedQty: "Reserved",
  lastIssuedDate: "Last issued",
  enquiredAt: "Enquired",
  firstContactAt: "First contact (their system)",
  followUpDate: "Follow-up due",
  modelInterest: "Model of interest",
  empCode: "Employee code",
  empName: "Employee",
  promisedDeliveryDate: "Promised to the customer",
  ingestPath: "Arrived by",
  lastSyncedAt: "Last synced",
  disappearedAt: "Vanished from their system",
  showroomId: "Outlet",
  dealerCode: "Dealer code",
  firstSeenAt: "First seen",
  statusSince: "In this status since",
  lastChangedAt: "Last changed",
};

/** `hsrpFittedDate` → `Hsrp fitted date`. Better than showing the camelCase. */
function humanise(key: string): string {
  const words = key.replace(/([A-Z])/g, " $1").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function render(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  if (s === "Y") return "Yes";
  if (s === "N") return "No";
  return s;
}

const TABLES = {
  DEAL: { table: dmsDealsTable, key: dmsDealsTable.dealId },
  REGISTRATION: { table: dmsRegistrationsTable, key: dmsRegistrationsTable.regnFileNo },
  JOB_CARD: { table: dmsJobCardsTable, key: dmsJobCardsTable.jcNo },
  ENQUIRY: { table: dmsEnquiriesTable, key: dmsEnquiriesTable.enqId },
  PART: { table: dmsPartStockTable, key: dmsPartStockTable.partNo },
  RECEIVABLE: { table: dmsReceivablesTable, key: dmsReceivablesTable.invoiceNo },
  VEHICLE: { table: dmsVehicleStockTable, key: dmsVehicleStockTable.chassisNo },
} as const;

/** What a record is called, in the words a person would use. */
function titleOf(module: string, row: Record<string, unknown>): { title: string; subtitle: string | null } {
  const s = (k: string) => (row[k] === null || row[k] === undefined ? null : String(row[k]));
  switch (module) {
    case "VEHICLE":
      return {
        title: s("modelDescription") ?? s("chassisNo") ?? "Vehicle",
        subtitle: [s("variantDescription"), s("colourDescription"), s("chassisNo")].filter(Boolean).join(" · ") || null,
      };
    case "PART":
      return { title: s("partDescription") ?? s("partNo") ?? "Part", subtitle: s("partNo") };
    case "RECEIVABLE":
      return { title: s("partyName") ?? s("partyCode") ?? "Receivable", subtitle: s("invoiceNo") };
    default:
      return {
        title: s("customerName") ?? s("dealId") ?? s("regnFileNo") ?? s("jcNo") ?? s("enqId") ?? "Record",
        subtitle: [s("modelDescription"), s("chassisNo")].filter(Boolean).join(" · ") || null,
      };
  }
}

export async function caseFor(module: AccessModule, recordKey: string): Promise<CaseRecord | null> {
  const spec = TABLES[module as keyof typeof TABLES];
  if (!spec) return null;

  const [row] = await db
    .select()
    .from(spec.table)
    .where(eq(spec.key, recordKey))
    .limit(1);

  if (!row) return null;

  const record = row as unknown as Record<string, unknown>;
  const { title, subtitle } = titleOf(module, record);

  const fields: CaseField[] = Object.entries(record)
    .filter(([key]) => !HIDDEN.has(key))
    .map(([key, value]) => ({
      key,
      label: LABELS[key] ?? humanise(key),
      value: render(value),
      origin: META.has(key) ? ("META" as const) : OURS.has(key) ? ("DDMS" as const) : ("MIRROR" as const),
    }));

  return {
    module,
    recordKey,
    title,
    subtitle,
    fields,
    provenance: {
      path: (record["ingestPath"] as string) ?? null,
      confidence: (record["fieldConfidence"] as Record<string, number>) ?? null,
    },
    lastSyncedAt: record["lastSyncedAt"] instanceof Date ? (record["lastSyncedAt"] as Date).toISOString() : null,
    disappearedFromDms: Boolean(record["disappearedAt"]),
  };
}
