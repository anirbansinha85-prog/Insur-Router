/**
 * Two-stage document extraction.
 *
 *   Stage 1 (vision)  image → DocumentExtraction
 *     The model identifies WHAT the document is and transcribes every field
 *     using the document's OWN printed labels. Nothing is forced into MSA
 *     shape, so data with no MSA equivalent (fuel type, valid-upto, vehicle
 *     class) still survives.
 *
 *   Stage 2 (text)    DocumentExtraction → MsaFields + provenance
 *     A cheap text-only call maps labels onto MSA fields and reformats values
 *     (Indian digit grouping, DD-MM-YYYY dates, pincode out of a free-text
 *     address). Falls back to a deterministic label matcher if it fails, so a
 *     mapping failure degrades rather than losing the extraction.
 *
 * Why two stages rather than one prompt straight to MSA: a single MSA-shaped
 * prompt silently discards anything that does not fit, and biases what the
 * model "sees" toward the fields it was told to find. Splitting them keeps the
 * transcription faithful and makes the mapping re-runnable without paying for
 * vision again.
 */

import { logger } from "./logger";

export const DOCUMENT_TYPES = [
  "RC_BOOK",
  "DEALER_INVOICE",
  "AADHAAR",
  "PAN",
  "DRIVING_LICENCE",
  "INSURANCE_POLICY",
  "OTHER",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const FIELD_GROUPS = [
  "vehicle",
  "owner",
  "rto",
  "policy",
  "other",
] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

export interface DocumentField {
  /** The label exactly as printed on the document. */
  label: string;
  value: string;
  group: FieldGroup;
  confidence: number;
}

export interface DocumentExtraction {
  documentType: DocumentType;
  documentTypeConfidence: number;
  issuer: string | null;
  summary: string;
  fields: DocumentField[];
  rawText: string | null;
}

export interface MsaFields {
  vehicleMake: string;
  vehicleModel: string;
  vehicleVariant: string;
  vehicleEngineNumber: string;
  vehicleChassisNumber: string;
  vehicleExShowroomPrice: number;
  vehicleDateOfPurchase: string;
  ownerFullName: string;
  ownerBillingAddress: string;
  ownerPincode: number;
  ownerPhoneNumber: string;
  ownerEmail: string;
  ownerDateOfBirth: string;
  ownerIdProofType:
    | "AADHAR"
    | "PAN"
    | "PASSPORT"
    | "DRIVING_LICENSE"
    | "VOTER_ID";
  ownerIdProofNumber: string;
  rtoRegistrationCity: string;
  rtoRegistrationState: string;
  rtoCode: string;
}

export type MsaFieldName = keyof MsaFields;

export interface OcrAttempt {
  engineId: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

export interface IngestResult {
  fields: MsaFields;
  confidence: Record<string, number>;
  rawText?: string | null;
  engineUsed?: string | null;
  isDemoData?: boolean;
  attempts?: OcrAttempt[];
  /** Stage 1 output — the document as the model actually read it. */
  document?: DocumentExtraction | null;
  /** MSA field name → the document label it came from, or null if unmapped. */
  provenance?: Record<string, string | null>;
  /** How stage 2 resolved: an LLM call, or the deterministic fallback. */
  mappingMethod?: "llm" | "rules" | null;
}

const ID_PROOF_TYPES = [
  "AADHAR",
  "PAN",
  "PASSPORT",
  "DRIVING_LICENSE",
  "VOTER_ID",
] as const;

export const EMPTY_MSA_FIELDS: MsaFields = {
  vehicleMake: "",
  vehicleModel: "",
  vehicleVariant: "",
  vehicleEngineNumber: "",
  vehicleChassisNumber: "",
  vehicleExShowroomPrice: 0,
  vehicleDateOfPurchase: "",
  ownerFullName: "",
  ownerBillingAddress: "",
  ownerPincode: 0,
  ownerPhoneNumber: "",
  ownerEmail: "",
  ownerDateOfBirth: "",
  ownerIdProofType: "AADHAR",
  ownerIdProofNumber: "",
  rtoRegistrationCity: "",
  rtoRegistrationState: "",
  rtoCode: "",
};

// ─── Stage 1: document understanding ─────────────────────────────────────────

export const DOCUMENT_EXTRACTION_PROMPT = `You are reading a scanned Indian document, most often related to a two-wheeler vehicle or its owner's KYC.

TASK
1. Identify what the document is.
2. Transcribe EVERY labelled piece of information you can read, using the document's OWN printed label wording — do not rename, normalise or invent labels.
3. Do not omit a field just because it seems irrelevant. Fuel type, vehicle class, validity dates, seating capacity, cubic capacity, tax details and authority names all matter.

Return a single JSON object and nothing else — no markdown fences, no prose.

{
  "documentType": one of "RC_BOOK" | "DEALER_INVOICE" | "AADHAAR" | "PAN" | "DRIVING_LICENCE" | "INSURANCE_POLICY" | "OTHER",
  "documentTypeConfidence": 0.0 to 1.0,
  "issuer": "issuing authority or dealer name as printed, or null",
  "summary": "one plain sentence describing the document and its subject",
  "fields": [
    {
      "label": "the label exactly as printed, e.g. 'Chassis No.' or 'Registered Owner'",
      "value": "the value exactly as printed, preserving original formatting",
      "group": one of "vehicle" | "owner" | "rto" | "policy" | "other",
      "confidence": 0.0 to 1.0
    }
  ],
  "rawText": "all visible text on the document, reading order preserved"
}

RULES
- Copy values VERBATIM. Keep "Rs. 1,93,750/-" as-is, keep "14-02-2023" as-is. Reformatting happens later.
- If a value is partly illegible, transcribe what you can and lower the confidence.
- Never guess a value that is not visible. Omit the field instead.
- Group by what the field describes: the vehicle, the owner/person, the registering authority (rto), an insurance policy, or other.

Confidence guide:
- 0.90–1.00 crisp and unambiguous
- 0.70–0.89 readable with minor ambiguity
- 0.40–0.69 blurry, partially obscured, or inferred from context
- 0.20–0.39 barely legible`;

/** Coerce whatever the model returned into a well-formed DocumentExtraction. */
export function parseDocumentExtraction(rawText: string): DocumentExtraction {
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    logger.warn(
      { rawText: rawText.slice(0, 300) },
      "Stage 1 response was not parseable JSON",
    );
    throw new Error(
      "Model returned unparseable output (expected a JSON object)",
    );
  }

  const rawFields = Array.isArray(obj.fields) ? obj.fields : [];
  const fields: DocumentField[] = rawFields
    .map((f) => {
      const rec = (f ?? {}) as Record<string, unknown>;
      const label = rec.label != null ? String(rec.label).trim() : "";
      const value = rec.value != null ? String(rec.value).trim() : "";
      const group = FIELD_GROUPS.includes(rec.group as FieldGroup)
        ? (rec.group as FieldGroup)
        : "other";
      const conf = Number(rec.confidence);
      return {
        label,
        value,
        group,
        confidence: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0.5,
      };
    })
    .filter((f) => f.label !== "" && f.value !== "");

  // An extraction with no fields is a failure, not an empty success — let the
  // chain fall through to the next engine rather than hand back a blank form.
  if (fields.length === 0) {
    throw new Error("Model returned no readable fields");
  }

  const docType = DOCUMENT_TYPES.includes(obj.documentType as DocumentType)
    ? (obj.documentType as DocumentType)
    : "OTHER";
  const typeConf = Number(obj.documentTypeConfidence);

  return {
    documentType: docType,
    documentTypeConfidence: Number.isFinite(typeConf)
      ? Math.min(Math.max(typeConf, 0), 1)
      : 0.5,
    issuer: obj.issuer != null && obj.issuer !== "null" ? String(obj.issuer) : null,
    summary: obj.summary != null ? String(obj.summary) : "",
    fields,
    rawText: obj.rawText != null ? String(obj.rawText) : null,
  };
}

// ─── Stage 2: map the document onto MSA fields ───────────────────────────────

export function buildMappingPrompt(doc: DocumentExtraction): string {
  return `You are mapping an already-transcribed Indian document onto a fixed insurance data model (the MSA payload).

DOCUMENT
${JSON.stringify(
  {
    documentType: doc.documentType,
    issuer: doc.issuer,
    summary: doc.summary,
    fields: doc.fields.map((f) => ({
      label: f.label,
      value: f.value,
      group: f.group,
    })),
  },
  null,
  2,
)}

TASK
Fill in the MSA fields below from the document. Return a single JSON object and nothing else.

{
  "fields": {
    "vehicleMake": "manufacturer only, e.g. Royal Enfield",
    "vehicleModel": "model only, e.g. Classic 350",
    "vehicleVariant": "variant/trim, or empty string",
    "vehicleEngineNumber": "",
    "vehicleChassisNumber": "chassis or VIN",
    "vehicleExShowroomPrice": numeric INR, digits only, 0 if absent,
    "vehicleDateOfPurchase": "YYYY-MM-DD or empty string",
    "ownerFullName": "",
    "ownerBillingAddress": "street address WITHOUT the pincode",
    "ownerPincode": numeric 6-digit, 0 if absent,
    "ownerPhoneNumber": "10 digits only, no country code or spaces",
    "ownerEmail": "",
    "ownerDateOfBirth": "YYYY-MM-DD or empty string",
    "ownerIdProofType": "AADHAR" | "PAN" | "PASSPORT" | "DRIVING_LICENSE" | "VOTER_ID",
    "ownerIdProofNumber": "",
    "rtoRegistrationCity": "",
    "rtoRegistrationState": "",
    "rtoCode": "two letters + two digits, e.g. MH12"
  },
  "provenance": {
    "<msaFieldName>": "the exact document label this came from, or null if you derived or could not find it"
  },
  "confidence": {
    "<msaFieldName>": 0.0 to 1.0
  }
}

CONVERSION RULES
- "Rs. 1,93,750/-" → 193750. Indian digit grouping: 1,93,750 is one hundred ninety-three thousand seven hundred fifty.
- "14-02-2023" or "14/02/2023" → "2023-02-14". Indian documents are DD-MM-YYYY, never MM-DD-YYYY.
- Split a combined address: put the 6-digit pincode in ownerPincode and leave it out of ownerBillingAddress.
- Split a combined make+model, e.g. "ROYAL ENFIELD CLASSIC 350" → make "Royal Enfield", model "Classic 350".
- Derive rtoCode from a registration number when not separately labelled: "MH12 QR 4471" → "MH12".
- Infer ownerIdProofType from whichever ID actually appears on the document.
- Strip "+91" and spaces from phone numbers.

RULES
- Never invent a value. If it is not in the document, use "" or 0 and set that field's confidence to 0.2 with provenance null.
- Set confidence for a field you derived or reformatted slightly BELOW the source field's own reliability.
- provenance must quote the document label verbatim, so a human can check it.`;

}

/** Coerce stage-2 output into MSA fields, provenance and confidence. */
export function parseMappingResponse(rawText: string): {
  fields: MsaFields;
  provenance: Record<string, string | null>;
  confidence: Record<string, number>;
} {
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const obj = JSON.parse(stripped) as {
    fields?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
    confidence?: Record<string, unknown>;
  };

  const src = obj.fields ?? {};
  const str = (v: unknown) => (v != null && v !== "null" ? String(v).trim() : "");
  const num = (v: unknown) => {
    if (v == null) return 0;
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  const fields: MsaFields = {
    vehicleMake: str(src.vehicleMake),
    vehicleModel: str(src.vehicleModel),
    vehicleVariant: str(src.vehicleVariant),
    vehicleEngineNumber: str(src.vehicleEngineNumber),
    vehicleChassisNumber: str(src.vehicleChassisNumber),
    vehicleExShowroomPrice: num(src.vehicleExShowroomPrice),
    vehicleDateOfPurchase: str(src.vehicleDateOfPurchase),
    ownerFullName: str(src.ownerFullName),
    ownerBillingAddress: str(src.ownerBillingAddress),
    ownerPincode: num(src.ownerPincode),
    ownerPhoneNumber: str(src.ownerPhoneNumber).replace(/\D/g, "").slice(-10),
    ownerEmail: str(src.ownerEmail),
    ownerDateOfBirth: str(src.ownerDateOfBirth),
    ownerIdProofType: ID_PROOF_TYPES.includes(
      src.ownerIdProofType as MsaFields["ownerIdProofType"],
    )
      ? (src.ownerIdProofType as MsaFields["ownerIdProofType"])
      : "AADHAR",
    ownerIdProofNumber: str(src.ownerIdProofNumber),
    rtoRegistrationCity: str(src.rtoRegistrationCity),
    rtoRegistrationState: str(src.rtoRegistrationState),
    rtoCode: str(src.rtoCode).toUpperCase(),
  };

  const provenance: Record<string, string | null> = {};
  const confidence: Record<string, number> = {};
  for (const key of Object.keys(fields) as MsaFieldName[]) {
    const p = obj.provenance?.[key];
    provenance[key] = p != null && p !== "null" ? String(p) : null;
    const c = Number(obj.confidence?.[key]);
    confidence[key] = Number.isFinite(c)
      ? Math.min(Math.max(c, 0), 1)
      : fields[key]
        ? 0.6
        : 0.2;
  }

  return { fields, provenance, confidence };
}

// ─── Stage 2 fallback: deterministic label matching ──────────────────────────

/**
 * Label patterns per MSA field, tried in order. Used when the stage-2 LLM call
 * fails, so a mapping outage degrades to a partial result instead of losing the
 * whole extraction. Deliberately conservative — it will leave a field blank
 * rather than guess.
 */
const LABEL_PATTERNS: Partial<Record<MsaFieldName, RegExp[]>> = {
  vehicleMake: [/^(maker|make|manufacturer)/i, /manufacturer.*name/i],
  vehicleModel: [/^model/i, /model.*name/i],
  vehicleVariant: [/variant/i, /trim/i],
  vehicleEngineNumber: [/engine\s*(no|number)/i],
  vehicleChassisNumber: [/chass?is\s*(no|number)/i, /\bvin\b/i],
  vehicleExShowroomPrice: [/ex.?showroom/i, /invoice\s*(value|amount)/i, /price/i],
  vehicleDateOfPurchase: [/date\s*of\s*(purchase|sale)/i, /invoice\s*date/i, /date\s*of\s*registration/i],
  ownerFullName: [/registered\s*owner/i, /owner.*name/i, /^name/i, /customer\s*name/i],
  ownerBillingAddress: [/address/i],
  ownerPhoneNumber: [/mobile/i, /phone/i, /contact\s*(no|number)/i],
  ownerEmail: [/e.?mail/i],
  ownerDateOfBirth: [/date\s*of\s*birth/i, /\bdob\b/i],
  ownerIdProofNumber: [/aadhaar|aadhar/i, /\bpan\b/i, /passport\s*(no|number)/i, /licence\s*(no|number)/i],
  rtoRegistrationCity: [/registration\s*city/i, /city/i],
  rtoRegistrationState: [/state/i],
  rtoCode: [/rto\s*code/i, /registering\s*authority/i, /registration\s*(no|number)/i],
};

const INDIAN_STATES_BY_RTO: Record<string, { state: string }> = {
  MH: { state: "Maharashtra" }, DL: { state: "Delhi" }, KA: { state: "Karnataka" },
  TN: { state: "Tamil Nadu" }, GJ: { state: "Gujarat" }, UP: { state: "Uttar Pradesh" },
  RJ: { state: "Rajasthan" }, WB: { state: "West Bengal" }, TS: { state: "Telangana" },
  AP: { state: "Andhra Pradesh" }, KL: { state: "Kerala" }, HR: { state: "Haryana" },
  PB: { state: "Punjab" }, MP: { state: "Madhya Pradesh" }, BR: { state: "Bihar" },
  OD: { state: "Odisha" }, JH: { state: "Jharkhand" }, AS: { state: "Assam" },
  CG: { state: "Chhattisgarh" }, UK: { state: "Uttarakhand" }, HP: { state: "Himachal Pradesh" },
  GA: { state: "Goa" }, JK: { state: "Jammu and Kashmir" }, CH: { state: "Chandigarh" },
  PY: { state: "Puducherry" },
};

/** "14-02-2023", "14/02/2023", "2023-02-14" → "2023-02-14"; else "". */
function toIsoDate(value: string): string {
  const v = value.trim();
  const iso = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  // Indian documents are DD-MM-YYYY. Never interpret as MM-DD-YYYY.
  const dmy = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return "";
}

/**
 * "Rs. 1,93,750/-" → 193750
 *
 * Takes the longest digit run rather than stripping non-digits wholesale: a
 * naive strip keeps the period in "Rs." and reads "Rs. 1,22,400/-" as the
 * decimal 0.1224, which rounds to 0.
 */
function toAmount(value: string): number {
  const matches = value.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!matches) return 0;
  const longest = matches.reduce((a, b) =>
    b.replace(/\D/g, "").length > a.replace(/\D/g, "").length ? b : a,
  );
  const n = Number(longest.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function mapDocumentToMsaByRules(doc: DocumentExtraction): {
  fields: MsaFields;
  provenance: Record<string, string | null>;
  confidence: Record<string, number>;
} {
  const fields: MsaFields = { ...EMPTY_MSA_FIELDS };
  const provenance: Record<string, string | null> = {};
  const confidence: Record<string, number> = {};

  for (const key of Object.keys(fields) as MsaFieldName[]) {
    provenance[key] = null;
    confidence[key] = 0.2;
  }

  const find = (patterns: RegExp[]): DocumentField | undefined => {
    for (const re of patterns) {
      const hit = doc.fields.find((f) => re.test(f.label));
      if (hit) return hit;
    }
    return undefined;
  };

  for (const [key, patterns] of Object.entries(LABEL_PATTERNS) as [
    MsaFieldName,
    RegExp[],
  ][]) {
    const hit = find(patterns);
    if (!hit) continue;
    provenance[key] = hit.label;
    // Rule-based mapping is less reliable than the model's own read of the
    // field, so cap what we claim.
    confidence[key] = Math.min(hit.confidence, 0.7);

    switch (key) {
      case "vehicleExShowroomPrice":
        fields.vehicleExShowroomPrice = toAmount(hit.value);
        break;
      case "vehicleDateOfPurchase":
        fields.vehicleDateOfPurchase = toIsoDate(hit.value);
        break;
      case "ownerDateOfBirth":
        fields.ownerDateOfBirth = toIsoDate(hit.value);
        break;
      case "ownerPhoneNumber":
        fields.ownerPhoneNumber = hit.value.replace(/\D/g, "").slice(-10);
        break;
      case "rtoCode": {
        const m = hit.value.toUpperCase().match(/([A-Z]{2})\s*-?\s*(\d{1,2})/);
        fields.rtoCode = m ? `${m[1]}${m[2].padStart(2, "0")}` : "";
        break;
      }
      default:
        (fields[key] as string) = hit.value;
    }
  }

  // Pincode is almost never its own label — pull the trailing 6-digit group
  // out of the address and remove it from the address text.
  const addr = fields.ownerBillingAddress;
  const pin = addr.match(/\b(\d{6})\b/);
  if (pin) {
    fields.ownerPincode = Number(pin[1]);
    fields.ownerBillingAddress = addr
      .replace(pin[0], "")
      .replace(/[\s,–-]+$/, "")
      .trim();
    confidence.ownerPincode = 0.6;
    provenance.ownerPincode = provenance.ownerBillingAddress;
  }

  // Split a combined "ROYAL ENFIELD CLASSIC 350" into make + model.
  if (fields.vehicleMake && !fields.vehicleModel) {
    const parts = fields.vehicleMake.split(/\s+/);
    if (parts.length > 2) {
      fields.vehicleMake = parts.slice(0, 2).join(" ");
      fields.vehicleModel = parts.slice(2).join(" ");
      confidence.vehicleModel = 0.4;
      provenance.vehicleModel = provenance.vehicleMake;
    }
  }

  // Derive the state from the RTO code when it was not separately labelled.
  if (fields.rtoCode && !fields.rtoRegistrationState) {
    const st = INDIAN_STATES_BY_RTO[fields.rtoCode.slice(0, 2)];
    if (st) {
      fields.rtoRegistrationState = st.state;
      confidence.rtoRegistrationState = 0.5;
      provenance.rtoRegistrationState = `derived from ${fields.rtoCode}`;
    }
  }

  // Infer the ID type from whichever ID label actually matched.
  const idLabel = provenance.ownerIdProofNumber ?? "";
  if (/pan/i.test(idLabel)) fields.ownerIdProofType = "PAN";
  else if (/passport/i.test(idLabel)) fields.ownerIdProofType = "PASSPORT";
  else if (/licence|license/i.test(idLabel))
    fields.ownerIdProofType = "DRIVING_LICENSE";
  else if (/aadhaar|aadhar/i.test(idLabel)) fields.ownerIdProofType = "AADHAR";
  if (idLabel) {
    provenance.ownerIdProofType = idLabel;
    confidence.ownerIdProofType = 0.6;
  }

  return { fields, provenance, confidence };
}
