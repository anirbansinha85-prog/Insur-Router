/**
 * What a dealer's column headings mean — worked out once, then fixed.
 *
 * Every DMS exports a different spreadsheet. One writes `Deal No`, the next
 * `DEAL_NUMBER`, the third `Order Ref`, and a fourth writes `Doc.No.` and means
 * the invoice. There is no standard and there will not be one, so something has
 * to read unfamiliar headings — and a model is genuinely good at exactly that
 * and nothing else in this pipeline.
 *
 * ## Three steps, and the middle one is a person
 *
 * ```
 *   propose   a model reads the headings          once per export shape
 *   confirm   a person says yes                   once per export shape
 *   apply     column position, no model at all    every file thereafter
 * ```
 *
 * **Nothing is extracted from a proposed mapping.** The model reads headings; a
 * person decides what they mean. That division is R-49 applied to onboarding,
 * and the consequence is the commercial one: model cost is **per report type
 * per dealer**, not per row. A dealership dropping a thousand-row stock file
 * every morning pays for one call, in total, ever.
 *
 * It is also the same shape as OBJ-26's graduation, arriving early. The
 * expensive fallible step happens on first encounter, a person's confirmation
 * is what promotes it, and everything after is deterministic.
 *
 * ## What the model is not allowed to do
 *
 * It sees **headings only** — never a cell, never a customer's name, never a
 * figure. It cannot therefore invent a value, because it is never shown one;
 * the worst it can do is misname a column, which is precisely what the
 * confirmation step is for. A field it cannot place is left absent rather than
 * guessed, because a gap is visible on the confirmation screen and a wrong
 * guess is not.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, ingestMappingsTable, type IngestMappingRow } from "@workspace/db";
import { askModel, modelAvailable } from "../model";
import { logger } from "../../logger";
import { DEAL_FIELDS, FIELDS_FOR, type DataType, type DealRecord, type FieldSpec } from "./types";
import { fingerprintOf, toAmount, toDate, toText } from "./table";

export type FieldMapping = Record<string, { column: string; confidence: number }>;

// ── Proposing ───────────────────────────────────────────────────────────────

/**
 * A first pass with no model in it at all.
 *
 * Most headings are not mysterious. `Deal No`, `Chassis No` and `Invoice Date`
 * match on a normalised string, and running a model over a file it can already
 * read is paying for nothing. The model is asked only about the headings this
 * cannot place — which on a typical export is two or three of sixteen, and on a
 * tidy one is none.
 */
const DEAL_SYNONYMS: Record<string, string[]> = {
  dealId: ["deal no", "deal number", "dealid", "deal id", "order no", "order number", "booking no", "booking number", "order ref", "sale order"],
  status: ["status", "deal status", "order status", "stage"],
  bookingDate: ["booking date", "booking dt", "order date", "booked on"],
  plannedDeliveryDate: ["planned delivery", "planned delivery date", "promised date", "committed date", "expected delivery"],
  actualDeliveryDate: ["delivery date", "actual delivery date", "delivered on", "gate pass date"],
  customerName: ["customer name", "customer", "buyer name", "party name", "cust name"],
  customerMobile: ["mobile", "mobile no", "customer mobile", "phone", "contact no", "mobile number"],
  modelDescription: ["model", "model desc", "model description", "variant", "vehicle model"],
  chassisNo: ["chassis no", "chassis", "chassis number", "vin", "frame no"],
  engineNo: ["engine no", "engine", "engine number", "motor no"],
  exShowroomAmount: ["ex showroom", "ex-showroom", "ex showroom price", "ex showroom amount", "basic price", "vehicle price"],
  dmsPolicyNo: ["policy no", "policy number", "insurance policy", "insurance no"],
  dmsInsurerCode: ["insurer", "insurance company", "insurer code", "insurance co"],
  dmsRegNo: ["registration no", "reg no", "registration number", "vehicle no"],
  invoiceNo: ["invoice no", "invoice number", "bill no", "tax invoice no", "doc no"],
  invoiceDate: ["invoice date", "invoice dt", "bill date", "billing date"],
};

/**
 * Leads, in the words a dealership's export uses for them.
 *
 * Worth reading beside the deal list rather than merged with it: `status` means
 * *deal status* on one and nothing at all on the other, where an enquiry export
 * calls the same idea `stage`. One flat table of synonyms would have matched
 * *Status* to a deal field on an enquiry file and looked like it worked.
 */
const ENQUIRY_SYNONYMS: Record<string, string[]> = {
  enqId: ["enquiry no", "enquiry number", "enq no", "enq id", "lead no", "lead id", "enquiry ref"],
  stage: ["stage", "enquiry stage", "lead stage", "status", "enquiry status", "lead status"],
  enqDt: ["enquiry date", "enq date", "enquiry dt", "lead date", "date of enquiry", "created on"],
  source: ["source", "lead source", "enquiry source", "channel"],
  grade: ["grade", "lead grade", "rating", "temperature", "category"],
  custName: ["customer name", "customer", "cust name", "prospect name", "party name", "name"],
  mobileNo: ["mobile", "mobile no", "customer mobile", "phone", "contact no", "mobile number"],
  modelCodeInterest: ["model interested", "model of interest", "model", "interested model", "enquiry model", "model code"],
  assignedEmpCode: ["sales exec", "salesman", "assigned to", "executive", "emp code", "sales executive", "consultant"],
  firstContactAt: ["first contact", "first contacted", "first response", "first call"],
  lastContactDt: ["last contact", "last contacted", "last call", "last follow up"],
  nextFollowUpDt: ["next follow up", "follow up date", "next followup", "next call", "due date"],
  lostReasonDesc: ["lost reason", "reason lost", "lost remarks", "closure reason"],
  convertedDealId: ["converted deal", "deal no", "booking no", "order no", "converted to"],
};

const JOB_CARD_SYNONYMS: Record<string, string[]> = {
  jcNo: ["jc no", "job card no", "job card number", "jobcard no", "jc number", "repair order no", "ro no"],
  status: ["status", "jc status", "job status", "job card status"],
  jcType: ["jc type", "job type", "service type", "repair type", "type"],
  jcDt: ["jc date", "job card date", "opened on", "date in", "arrival date"],
  promisedDt: ["promised date", "promised delivery", "committed date", "pdc", "promised on"],
  actualCloseDt: ["closed date", "close date", "actual close", "delivered on", "date out"],
  custName: ["customer name", "customer", "cust name", "party name"],
  mobileNo: ["mobile", "mobile no", "customer mobile", "phone", "contact no"],
  modelDesc: ["model", "model desc", "vehicle model", "model description"],
  regNo: ["reg no", "registration no", "vehicle no", "registration number"],
  chassisNo: ["chassis no", "chassis", "vin", "frame no"],
  advisorEmpCode: ["advisor", "service advisor", "sa code", "advisor code", "emp code"],
  estimateAmt: ["estimate", "estimate amount", "estimated amount", "quoted amount"],
  finalAmt: ["final amount", "bill amount", "invoice amount", "net amount", "total"],
  hasUnissuedPart: ["part awaited", "awaiting part", "part pending", "parts pending", "spare awaited"],
  psfDone: ["psf done", "psf", "follow up done", "post service call", "feedback done"],
};

const REGISTRATION_SYNONYMS: Record<string, string[]> = {
  regnFileNo: ["file no", "file number", "registration file no", "regn file no", "rto file no"],
  status: ["status", "file status", "registration status", "rto status"],
  dealId: ["deal no", "deal number", "booking no", "order no", "invoice ref"],
  chassisNo: ["chassis no", "chassis", "vin", "frame no"],
  custName: ["customer name", "customer", "cust name", "applicant name", "party name"],
  mobileNo: ["mobile", "mobile no", "customer mobile", "phone", "contact no"],
  modelDesc: ["model", "model desc", "vehicle model"],
  openedDt: ["opened date", "file date", "opened on", "file opened"],
  rtoCode: ["rto code", "rto", "rto office code"],
  rtoOfficeDesc: ["rto office", "rto name", "office", "rto office name"],
  agentEmpCode: ["agent emp code", "agent", "rto agent", "agent code", "emp code"],
  tempRegNo: ["temp reg no", "temporary reg no", "trn", "temp number"],
  tempRegExpiryDt: ["temp reg expiry", "temporary reg expiry", "trn expiry", "temp valid till"],
  policyNo: ["policy no", "policy number", "insurance no", "insurance policy"],
  roadTaxAmt: ["road tax amount", "road tax", "tax amount", "rto tax"],
  roadTaxCollectedDt: ["tax collected on", "road tax collected", "tax received on", "collected on"],
  roadTaxPaidDt: ["tax paid on", "road tax paid", "paid to rto", "tax remitted on"],
  submittedDt: ["submitted on", "lodged on", "submission date", "submitted date"],
  regNo: ["reg no", "registration no", "registration number", "vehicle no"],
  regDt: ["reg date", "registration date", "registered on"],
  hsrpFittedDt: ["hsrp fitted on", "hsrp date", "plate fitted", "hsrp fitment"],
  rcReceivedDt: ["rc received on", "rc received", "rc receipt date"],
  rcDeliveredDt: ["rc delivered on", "rc delivered", "rc handover date", "rc given on"],
  objectionDesc: ["objection", "objection reason", "rto objection", "remarks"],
  hasPendingDoc: ["pending doc", "document pending", "docs pending", "doc awaited"],
  pendingDocDesc: ["pending doc detail", "pending documents", "documents awaited", "doc details"],
};

const PART_SYNONYMS: Record<string, string[]> = {
  partNo: ["part no", "part number", "item code", "material no", "sku"],
  partDesc: ["part description", "description", "part desc", "item description", "particulars"],
  binLocation: ["bin location", "bin", "location", "rack", "shelf"],
  qtyOnHand: ["qty on hand", "on hand", "closing stock", "stock qty", "quantity", "balance qty"],
  qtyReserved: ["qty reserved", "reserved", "allocated qty", "blocked qty"],
  reorderLevel: ["reorder level", "min level", "minimum level", "safety stock"],
  mrpAmt: ["mrp", "mrp amount", "retail price", "selling price"],
  costAmt: ["cost", "cost amount", "purchase price", "landed cost", "rate"],
  lastReceivedDt: ["last received", "last receipt", "last grn date", "last inward"],
  lastIssuedDt: ["last issued", "last issue date", "last outward", "last consumed"],
  onOrderQty: ["on order qty", "on order", "ordered qty", "po qty", "in transit"],
  onOrderEtaDt: ["on order eta", "eta", "expected date", "po eta"],
};

const RECEIVABLE_SYNONYMS: Record<string, string[]> = {
  receivableId: ["doc no", "document no", "voucher no", "receivable id", "ref no", "entry no"],
  status: ["status", "settlement status", "outstanding status"],
  partyType: ["party type", "type", "account type", "category"],
  partyCode: ["party code", "ledger code", "account code", "customer code", "party id"],
  partyName: ["party name", "party", "account name", "ledger name", "customer name"],
  partyEmailId: ["party email", "email", "email id", "contact email"],
  invoiceNo: ["invoice no", "bill no", "invoice number", "tax invoice no"],
  invoiceDt: ["invoice date", "bill date", "invoice dt"],
  invoiceAmt: ["invoice amount", "bill amount", "gross amount", "debit"],
  receivedAmt: ["received amount", "received", "paid amount", "credit", "collected"],
  dueDt: ["due date", "due on", "payment due"],
  againstType: ["against", "against type", "reference type"],
  againstKey: ["against ref", "reference", "against key", "ref key"],
  narrationDesc: ["narration", "remarks", "particulars", "description"],
  lastReceiptDt: ["last receipt", "last payment", "last received on"],
  promisedDt: ["promised date", "ptp date", "promise to pay", "committed date"],
};

const VEHICLE_SYNONYMS: Record<string, string[]> = {
  chassisNo: ["chassis no", "chassis", "vin", "frame no", "chassis number"],
  status: ["stock status", "status", "vehicle status"],
  engineNo: ["engine no", "engine", "engine number", "motor no"],
  modelCode: ["model code", "item code", "material code"],
  modelDesc: ["model", "model desc", "model description", "vehicle model"],
  variantDesc: ["variant", "variant desc", "grade"],
  colourDesc: ["colour", "color", "colour desc", "shade"],
  allocatedDealId: ["allocated deal", "deal no", "booking no", "allocated to", "order no"],
  costAmt: ["cost value", "cost", "purchase price", "invoice value", "landed cost"],
  financedFlg: ["financed", "floor plan", "funded", "trade advance"],
  interestRatePct: ["interest %", "interest rate", "rate of interest", "roi"],
  receivedDt: ["received date", "grn date", "inward date", "date received"],
  allocatedDt: ["allocated date", "allocation date", "blocked on"],
  invoicedDt: ["invoiced date", "invoice date", "billed on"],
};

const SYNONYMS_FOR: Partial<Record<DataType, Record<string, string[]>>> = {
  DEAL: DEAL_SYNONYMS,
  ENQUIRY: ENQUIRY_SYNONYMS,
  JOB_CARD: JOB_CARD_SYNONYMS,
  REGISTRATION: REGISTRATION_SYNONYMS,
  PART: PART_SYNONYMS,
  RECEIVABLE: RECEIVABLE_SYNONYMS,
  VEHICLE: VEHICLE_SYNONYMS,
};

/**
 * The vocabulary for a data type, and a refusal rather than an empty one.
 *
 * A module with no field list cannot be read from a report, and returning `{}`
 * would have every heading go unmatched and the file arrive as a mapping with
 * nothing in it — which looks like a badly-formatted export rather than like a
 * module nobody has taught the product to read yet.
 */
function vocabularyFor(dataType: DataType): {
  fields: FieldSpec[];
  synonyms: Record<string, string[]>;
} {
  const fields = FIELDS_FOR[dataType];
  const synonyms = SYNONYMS_FOR[dataType];
  if (!fields || !synonyms) {
    throw new Error(
      `No report vocabulary for ${dataType}. Add it to FIELDS_FOR and SYNONYMS_FOR before offering the report path for this module.`,
    );
  }
  return { fields, synonyms };
}

/** `enqId` → *enquiry number*, for a sentence somebody has to act on. */
function labelOf(field: string): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return spaced
    .replace(/\bno\b/, "number")
    .replace(/\bdt\b/, "date")
    .replace(/\benq\b/, "enquiry")
    .replace(/\bid\b/, "number");
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ");

export function matchByName(headings: string[], dataType: DataType = "DEAL"): FieldMapping {
  const { synonyms } = vocabularyFor(dataType);
  const out: FieldMapping = {};
  const used = new Set<string>();

  for (const [field, names] of Object.entries(synonyms)) {
    for (const heading of headings) {
      if (used.has(heading)) continue;
      const h = norm(heading);
      // Exact first, across every field, before anything fuzzy — otherwise
      // `Invoice Date` can be claimed by `invoiceNo` on a loose match and the
      // real `Invoice No` column is then unreachable.
      if (names.includes(h)) {
        out[field] = { column: heading, confidence: 0.98 };
        used.add(heading);
        break;
      }
    }
  }

  for (const [field, names] of Object.entries(synonyms)) {
    if (out[field]) continue;
    for (const heading of headings) {
      if (used.has(heading)) continue;
      const h = norm(heading);
      if (names.some((n) => h === n.replace(/\s+/g, "") || h.replace(/\s+/g, "") === n.replace(/\s+/g, ""))) {
        out[field] = { column: heading, confidence: 0.9 };
        used.add(heading);
        break;
      }
    }
  }

  return out;
}

const MAPPING_SYSTEM = [
  "You match spreadsheet column headings from an Indian vehicle dealership's",
  "management system to a fixed list of fields.",
  "",
  "Rules you must follow exactly:",
  "- You are shown HEADINGS ONLY. You will never be shown a value, and you must",
  "  never invent one.",
  "- Every column you name must appear verbatim in the headings given.",
  "- If you are not confident a heading means a field, LEAVE THE FIELD OUT.",
  "  A gap is reviewed by a person; a wrong guess is not.",
  "- One heading maps to at most one field.",
  "",
  'Return JSON only: {"fieldName": {"column": "exact heading", "confidence": 0.0-1.0}}',
].join("\n");

/**
 * Ask a model about the headings the table above could not place.
 *
 * Never blocks and never required. No key, a timeout, a refusal or a malformed
 * reply all end the same way: the name matches stand alone and a person maps
 * the rest by hand on the confirmation screen. That is a worse morning for
 * whoever is onboarding the dealer and it is not a failure of the product.
 */
async function proposeWithModel(
  headings: string[],
  alreadyPlaced: FieldMapping,
  dataType: DataType,
): Promise<{ mapping: FieldMapping; model: string | null }> {
  if (!modelAvailable("INGEST_MAPPING_MODEL")) return { mapping: {}, model: null };

  const takenColumns = new Set(Object.values(alreadyPlaced).map((m) => m.column));
  const open = headings.filter((h) => !takenColumns.has(h));
  const wanted = vocabularyFor(dataType).fields.filter((f) => !alreadyPlaced[f.field]);
  if (open.length === 0 || wanted.length === 0) return { mapping: {}, model: null };

  /*
   * Through the one door (OBJ-28), and `json: true` is not cosmetic.
   *
   * It constrains the model to emit a valid object and removes the commonest
   * parse failure — prose or markdown fences around it. The fence-stripping
   * below stays anyway, because a belt that costs two `replace` calls is
   * cheaper than an onboarding that fails on its first afternoon.
   */
  const answer = await askModel({
    purpose: "map-headings",
    modelEnvVar: "INGEST_MAPPING_MODEL",
    system: MAPPING_SYSTEM,
    temperature: 0,
    maxOutputTokens: 2_000,
    timeoutMs: 20_000,
    json: true,
    user: [
                    "Fields still to place:",
                    ...wanted.map((f) => `  ${f.field} — ${f.what}`),
                    "",
                    "Headings still unclaimed:",
                    ...open.map((h) => `  ${h}`),
    ].join("\n"),
  });

  if (!answer.ok) return { mapping: {}, model: null };

  const model = process.env["INGEST_MAPPING_MODEL"] || "gemini-flash-latest";
  let parsed: FieldMapping;
  try {
    parsed = JSON.parse(
      answer.text.replace(/^```json\s*/i, "").replace(/```$/, ""),
    ) as FieldMapping;
  } catch {
    logger.warn("Mapping model returned something that is not JSON; name matches stand alone");
    return { mapping: {}, model: null };
  }

  /*
   * Everything the model said, checked before it is kept.
   *
   * A named column that is not in the file is the failure that matters: it
   * produces a mapping which extracts nothing and a confirmation screen that
   * looks complete. Same class of check as `checkRewrite` — the model may
   * propose, and what it proposes is verified against the thing it was
   * describing.
   */
  const known = new Set(headings);
  const valid: FieldMapping = {};
  const fields = new Set(vocabularyFor(dataType).fields.map((f) => f.field));
  for (const [field, m] of Object.entries(parsed)) {
    if (!fields.has(field) || alreadyPlaced[field]) continue;
    if (!m || typeof m.column !== "string" || !known.has(m.column)) continue;
    if (takenColumns.has(m.column)) continue;
    takenColumns.add(m.column);
    valid[field] = {
      column: m.column,
      // Capped below the name matches. A model reading a heading it has never
      // seen is a good guess and not the same kind of fact as `Chassis No`
      // meaning the chassis number, and the confirmation screen sorts by this.
      confidence: Math.min(0.8, Math.max(0.1, Number(m.confidence) || 0.5)),
    };
  }
  return { mapping: valid, model };
}

// ── The three steps ─────────────────────────────────────────────────────────

export interface MappingLookup {
  row: IngestMappingRow;
  /** True when this file's shape had been seen and confirmed before. */
  wasKnown: boolean;
  /** True when a model was called. The number OBJ-24 is measured on. */
  usedModel: boolean;
}

/**
 * Find the mapping for this file's shape, proposing one if it is new.
 *
 * The whole objective in one function. A second file of the same shape reaches
 * the first return and no model is called — which is not an optimisation, it is
 * the commercial argument: onboarding a dealer costs one model call per export
 * type, and running them costs nothing.
 */
export async function mappingFor(input: {
  ownerId: number;
  showroomId: number;
  dataType: DataType;
  headings: string[];
}): Promise<MappingLookup> {
  const fingerprint = fingerprintOf(input.headings);

  const [existing] = await db
    .select()
    .from(ingestMappingsTable)
    .where(
      and(
        eq(ingestMappingsTable.showroomId, input.showroomId),
        eq(ingestMappingsTable.dataType, input.dataType),
        eq(ingestMappingsTable.fingerprint, fingerprint),
      ),
    )
    .limit(1);

  if (existing) {
    return { row: existing, wasKnown: existing.status === "CONFIRMED", usedModel: false };
  }

  const byName = matchByName(input.headings, input.dataType);
  const { mapping: byModel, model } = await proposeWithModel(
    input.headings,
    byName,
    input.dataType,
  );

  const [row] = await db
    .insert(ingestMappingsTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      dataType: input.dataType,
      fingerprint,
      headings: input.headings,
      mapping: { ...byName, ...byModel },
      status: "PROPOSED",
      proposedBy: model ? "MODEL" : "PERSON",
      proposedByModel: model,
    })
    .returning();

  return { row: row!, wasKnown: false, usedModel: Boolean(model) };
}

/** A person says yes. This is the only thing that makes a mapping usable. */
export async function confirmMapping(input: {
  id: number;
  userId: number;
  userName: string | null;
  /** Corrections the person made on the screen, replacing the proposal wholesale. */
  mapping?: FieldMapping;
}): Promise<IngestMappingRow | null> {
  const [row] = await db
    .update(ingestMappingsTable)
    .set({
      ...(input.mapping ? { mapping: input.mapping, proposedBy: "PERSON" as const } : {}),
      status: "CONFIRMED",
      confirmedByUserId: input.userId,
      confirmedByName: input.userName,
      confirmedAt: new Date(),
    })
    .where(eq(ingestMappingsTable.id, input.id))
    .returning();
  return row ?? null;
}

export async function rejectMapping(id: number, note: string): Promise<void> {
  await db
    .update(ingestMappingsTable)
    .set({ status: "REJECTED", note })
    .where(eq(ingestMappingsTable.id, id));
}

/** Which fields a mapping still cannot fill. What the confirmation screen leads with. */
export function gapsIn(mapping: FieldMapping, dataType: DataType = "DEAL"): string[] {
  return vocabularyFor(dataType)
    .fields.filter((f) => f.required && !mapping[f.field])
    .map((f) => f.field);
}

// ── Applying ────────────────────────────────────────────────────────────────

export interface Extraction {
  /**
   * Flat, and typed as loosely as the file it came from.
   *
   * This said `DealRecord` while deals were the only module a report could
   * feed. The extractor now builds from whichever vocabulary it was given, so
   * the caller is the one that knows what shape it asked for and the one that
   * narrows — the same division `Source<T>` makes one level up.
   */
  records: Array<{ record: Record<string, unknown>; confidence: Record<string, number> }>;
  /** Rows that could not be read, with why. A silent skip is not a result. */
  rejected: string[];
}

/**
 * Rows to records, by column position, with no model anywhere near it.
 *
 * The confidence carried per field is the **mapping's** confidence, not the
 * value's: once a person has confirmed that `Doc.No.` is the invoice number,
 * every invoice number read out of that column is as good as the column. What
 * stays below certainty is the fact that a person read a heading rather than an
 * API returning a named field, and R-85 says the row must keep saying so.
 */
export function extract(
  table: { headings: string[]; rows: Array<Record<string, string>> },
  mapping: FieldMapping,
  dataType: DataType = "DEAL",
): Extraction {
  const { fields } = vocabularyFor(dataType);
  const records: Extraction["records"] = [];
  const rejected: string[] = [];
  const typeOf = new Map(fields.map((f) => [f.field, f.type]));
  /*
   * The key is the first required field, not `dealId`.
   *
   * Every module has exactly one thing that identifies a record and it is
   * always the first entry in its vocabulary — the deal number, the enquiry
   * number. Hard-coding `dealId` here was the last place the extractor knew
   * what kind of thing it was reading.
   */
  const keyField = fields.find((f) => f.required)?.field ?? "dealId";

  for (const [n, row] of table.rows.entries()) {
    const record: Partial<DealRecord> = { raw: row };
    const confidence: Record<string, number> = {};

    for (const [field, m] of Object.entries(mapping)) {
      const cell = row[m.column];
      if (cell === undefined) continue;
      const kind = typeOf.get(field) ?? "text";
      const value = kind === "date" ? toDate(cell) : kind === "amount" ? toAmount(cell) : toText(cell);
      if (value === null) continue;
      (record as Record<string, unknown>)[field] = value;
      if (m.confidence < 1) confidence[field] = m.confidence;
    }

    const key = (record as Record<string, unknown>)[keyField];
    if (!key) {
      rejected.push(`Row ${n + 2}: no ${labelOf(keyField)}, so nothing to match it to.`);
      continue;
    }

    /*
     * A key alone does not make a record, and this is not a nicety.
     *
     * Every dealer export ends `Total,,,,,,,78 deals,,,` — and the word *Total*
     * lands in the key column. The first version of this checked only that a
     * key was present, so the footer arrived in the mirror as a deal called
     * **Total** with an ex-showroom price of 78: a phantom row on the worklist,
     * in the queue, and in the count an owner reads.
     *
     * The test is *the key plus at least two other fields*, which separates a
     * record from a footer without guessing at the word "Total" in whatever
     * language or abbreviation this dealer's system uses. A real row carries a
     * status, a customer and a model at the very least; a footer carries a
     * label and a count.
     *
     * Counted and reported rather than dropped, because *300 rows, 299
     * accepted* is a healthy import and *300 rows, 40 accepted* is a mapping
     * problem, and only the count can tell them apart.
     */
    const filled = Object.keys(record).filter(
      (k) => k !== "raw" && k !== keyField && (record as Record<string, unknown>)[k] != null,
    );
    if (filled.length < 2) {
      rejected.push(
        `Row ${n + 2}: "${String(key)}" carries no other data — a total or subtotal line, not a record.`,
      );
      continue;
    }

    /*
     * Built from the vocabulary rather than from a literal.
     *
     * This was the shape of a `DealRecord`, written out field by field, and it
     * was the last thing in the extractor that knew what kind of record it was
     * producing. Every field the module declares appears, absent ones as null,
     * so a sync below can read a column without checking whether the report
     * happened to carry it.
     *
     * A **required** field that the file did not fill becomes `UNKNOWN` rather
     * than null, because the columns downstream are not nullable and *the
     * export did not say* is a better answer than a crash — it shows up on the
     * screen as a state nobody recognises, which is exactly what it is.
     */
    const out: Record<string, unknown> = { raw: row };
    for (const f of fields) {
      const v = (record as Record<string, unknown>)[f.field];
      out[f.field] = v ?? (f.required ? "UNKNOWN" : null);
    }
    out[keyField] = key;

    records.push({ record: out, confidence });
  }

  return { records, rejected };
}

/** One more file read with this mapping. The graduation, counted. */
export async function noteMappingUse(id: number): Promise<void> {
  await db
    .update(ingestMappingsTable)
    .set({ usedCount: sql`${ingestMappingsTable.usedCount} + 1` })
    .where(eq(ingestMappingsTable.id, id));
}
