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
import { logger } from "../../logger";
import { DEAL_FIELDS, type DataType, type DealRecord } from "./types";
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
const SYNONYMS: Record<string, string[]> = {
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

const norm = (s: string): string => s.trim().toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ");

export function matchByName(headings: string[]): FieldMapping {
  const out: FieldMapping = {};
  const used = new Set<string>();

  for (const [field, names] of Object.entries(SYNONYMS)) {
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

  for (const [field, names] of Object.entries(SYNONYMS)) {
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
): Promise<{ mapping: FieldMapping; model: string | null }> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key || process.env["INGEST_MAPPING_MODEL"] === "off") {
    return { mapping: {}, model: null };
  }

  const takenColumns = new Set(Object.values(alreadyPlaced).map((m) => m.column));
  const open = headings.filter((h) => !takenColumns.has(h));
  const wanted = DEAL_FIELDS.filter((f) => !alreadyPlaced[f.field as string]);
  if (open.length === 0 || wanted.length === 0) return { mapping: {}, model: null };

  const model = process.env["INGEST_MAPPING_MODEL"] || "gemini-flash-latest";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: MAPPING_SYSTEM }] },
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: 2_000,
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Fields still to place:",
                    ...wanted.map((f) => `  ${f.field} — ${f.what}`),
                    "",
                    "Headings still unclaimed:",
                    ...open.map((h) => `  ${h}`),
                  ].join("\n"),
                },
              ],
            },
          ],
        }),
      },
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, "Mapping model refused; name matches stand alone");
      return { mapping: {}, model: null };
    }

    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/, "")) as FieldMapping;

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
    const fields = new Set(DEAL_FIELDS.map((f) => f.field as string));
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
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Mapping model failed; name matches stand alone",
    );
    return { mapping: {}, model: null };
  } finally {
    clearTimeout(timer);
  }
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

  const byName = matchByName(input.headings);
  const { mapping: byModel, model } = await proposeWithModel(input.headings, byName);

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
export function gapsIn(mapping: FieldMapping): string[] {
  return DEAL_FIELDS.filter((f) => f.required && !mapping[f.field as string]).map(
    (f) => f.field as string,
  );
}

// ── Applying ────────────────────────────────────────────────────────────────

export interface Extraction {
  records: Array<{ record: DealRecord; confidence: Record<string, number> }>;
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
): Extraction {
  const records: Extraction["records"] = [];
  const rejected: string[] = [];
  const typeOf = new Map(DEAL_FIELDS.map((f) => [f.field as string, f.type]));

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

    if (!record.dealId) {
      rejected.push(`Row ${n + 2}: no deal number, so nothing to match it to.`);
      continue;
    }

    /*
     * A key alone does not make a record, and this is not a nicety.
     *
     * Every dealer export ends `Total,,,,,,,78 deals,,,` — and the word *Total*
     * lands in the deal-number column. The first version of this checked only
     * that a key was present, so the footer arrived in the mirror as a deal
     * called **Total** with an ex-showroom price of 78: a phantom row on the
     * worklist, in the queue, and in the count an owner reads.
     *
     * The test is *the key plus at least two other fields*, which separates a
     * deal from a footer without guessing at the word "Total" in whatever
     * language or abbreviation this dealer's system uses. A real deal row
     * carries a status, a customer and a model at the very least; a footer
     * carries a label and a count.
     *
     * Counted and reported rather than dropped, because *300 rows, 299
     * accepted* is a healthy import and *300 rows, 40 accepted* is a mapping
     * problem, and only the count can tell them apart.
     */
    const filled = Object.keys(record).filter(
      (k) => k !== "raw" && k !== "dealId" && (record as Record<string, unknown>)[k] != null,
    );
    if (filled.length < 2) {
      rejected.push(
        `Row ${n + 2}: "${record.dealId}" carries no other data — a total or subtotal line, not a deal.`,
      );
      continue;
    }

    records.push({
      record: {
        dealId: record.dealId,
        status: record.status ?? "UNKNOWN",
        bookingDate: record.bookingDate ?? null,
        plannedDeliveryDate: record.plannedDeliveryDate ?? null,
        actualDeliveryDate: record.actualDeliveryDate ?? null,
        customerName: record.customerName ?? null,
        customerMobile: record.customerMobile ?? null,
        modelDescription: record.modelDescription ?? null,
        chassisNo: record.chassisNo ?? null,
        engineNo: record.engineNo ?? null,
        exShowroomAmount: record.exShowroomAmount ?? null,
        dmsPolicyNo: record.dmsPolicyNo ?? null,
        dmsInsurerCode: record.dmsInsurerCode ?? null,
        dmsRegNo: record.dmsRegNo ?? null,
        invoiceNo: record.invoiceNo ?? null,
        invoiceDate: record.invoiceDate ?? null,
        raw: row,
      },
      confidence,
    });
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
