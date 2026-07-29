/**
 * OCR engine registry and automatic fallback chain.
 *
 * An engine is usable only when all three hold:
 *   isImplemented — a real integration exists (not a TODO)
 *   isConfigured  — its API key is present in the environment
 *   isEnabled     — the operator has it switched on (ocr_engines table)
 *
 * The chain tries each usable engine in priority order and returns the first
 * success, recording every attempt so the UI can explain what happened.
 *
 * ── The stub is deliberately never reachable automatically ──────────────────
 * `stub` returns a fabricated Yamaha FZ-S with an invented chassis number and
 * Aadhaar number, at high confidence. If a key expired and the chain quietly
 * fell through to it, that fiction would flow into a real insurance application
 * looking like genuine OCR output. So `autoEligible` is false for stub, and it
 * runs only when named explicitly. Results from it are flagged `isDemoData`.
 */

import { logger } from "./logger";

export type OcrEngineId =
  | "paddleocr"
  | "qwen-vl"
  | "olmocr"
  | "gpt-vision"
  | "stub";

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

export interface IngestResult {
  fields: MsaFields;
  confidence: Record<string, number>;
  rawText?: string | null;
  engineUsed?: string | null;
  isDemoData?: boolean;
  attempts?: OcrAttempt[];
}

export interface OcrAttempt {
  engineId: OcrEngineId;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

interface EngineDefinition {
  id: OcrEngineId;
  label: string;
  /** A real integration exists. False = deliberately unwired. */
  isImplemented: boolean;
  /** Never true for engines that fabricate data. */
  autoEligible: boolean;
  /** Env var that must be set; null when the engine needs no credentials. */
  requiredEnvVar: string | null;
  /** Default ordering when the database has no row for this engine. */
  defaultPriority: number;
  defaultEnabled: boolean;
  isConfigured(): boolean;
  run(imageBase64: string, mimeType: string, signal: AbortSignal): Promise<IngestResult>;
  /** Explains why the engine is unusable, when it is. */
  unavailableReason?(): string | null;
}

/** Per-attempt deadline. A hung provider must not stall the whole chain. */
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 45_000);

const ID_PROOF_TYPES = [
  "AADHAR",
  "PAN",
  "PASSPORT",
  "DRIVING_LICENSE",
  "VOTER_ID",
] as const;

/** Shared prompt asking the model to extract RC-book/invoice fields as JSON. */
export const OCR_EXTRACTION_PROMPT = `You are processing an Indian vehicle Registration Certificate (RC Book) or dealer invoice image.
Extract all visible text and identify the following fields. Return a single JSON object — no markdown, no extra text.

Required JSON structure:
{
  "vehicleMake": "manufacturer e.g. Yamaha, Honda, TVS, Bajaj, Royal Enfield, Hero",
  "vehicleModel": "model name e.g. FZ-S, CB350",
  "vehicleVariant": "variant e.g. V3.0 Fi, Standard, or empty string if not visible",
  "vehicleEngineNumber": "engine number from document",
  "vehicleChassisNumber": "chassis/VIN number",
  "vehicleExShowroomPrice": numeric price in INR or 0,
  "vehicleDateOfPurchase": "YYYY-MM-DD or empty string",
  "ownerFullName": "owner full name",
  "ownerBillingAddress": "full address string",
  "ownerPincode": numeric 6-digit pincode or 0,
  "ownerPhoneNumber": "10-digit phone number or empty string",
  "ownerEmail": "email if visible or empty string",
  "ownerDateOfBirth": "YYYY-MM-DD or empty string",
  "ownerIdProofType": "AADHAR or PAN or PASSPORT or DRIVING_LICENSE or VOTER_ID",
  "ownerIdProofNumber": "ID number or empty string",
  "rtoRegistrationCity": "city where vehicle is registered",
  "rtoRegistrationState": "state e.g. Delhi, Maharashtra",
  "rtoCode": "RTO code e.g. DL01, MH02",
  "confidence": {
    "vehicleMake": 0.0 to 1.0,
    "vehicleModel": 0.0 to 1.0,
    "vehicleVariant": 0.0 to 1.0,
    "vehicleEngineNumber": 0.0 to 1.0,
    "vehicleChassisNumber": 0.0 to 1.0,
    "vehicleExShowroomPrice": 0.0 to 1.0,
    "vehicleDateOfPurchase": 0.0 to 1.0,
    "ownerFullName": 0.0 to 1.0,
    "ownerBillingAddress": 0.0 to 1.0,
    "ownerPincode": 0.0 to 1.0,
    "ownerPhoneNumber": 0.0 to 1.0,
    "ownerEmail": 0.0 to 1.0,
    "ownerDateOfBirth": 0.0 to 1.0,
    "ownerIdProofType": 0.0 to 1.0,
    "ownerIdProofNumber": 0.0 to 1.0,
    "rtoRegistrationCity": 0.0 to 1.0,
    "rtoRegistrationState": 0.0 to 1.0,
    "rtoCode": 0.0 to 1.0
  }
}

Confidence rules:
- 0.90–1.00: text is clear, unambiguous, and directly matches a known format
- 0.70–0.89: text is readable but could have minor ambiguity
- 0.40–0.69: partially visible, blurry, or inferred from context
- 0.20–0.39: guessed or not visible in the document

Return ONLY the JSON object. No markdown fences, no prose.`;

/**
 * Parses the JSON blob returned by a vision-language model into MsaFields.
 *
 * Only ever call this on output from a model prompted with
 * OCR_EXTRACTION_PROMPT. Raw-text OCR engines (PaddleOCR) return text lines,
 * which would JSON-parse-fail and yield silently empty fields — worse than an
 * explicit error. They need their own extractor first.
 */
export function parseVisionLLMResponseToMsaFields(rawText: string): IngestResult {
  let parsed: Record<string, unknown> = {};
  let confidence: Record<string, number> = {};

  // Strip markdown fences if the model wrapped the JSON in ```json ... ```
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const obj = JSON.parse(stripped) as Record<string, unknown>;
    if (obj.confidence && typeof obj.confidence === "object") {
      confidence = obj.confidence as Record<string, number>;
      delete obj.confidence;
    }
    parsed = obj;
  } catch {
    // A model that returns unparseable output has failed. Throwing here lets
    // the chain fall through to the next engine instead of handing the
    // reviewer a silently blank form.
    logger.warn(
      { rawText: rawText.slice(0, 300) },
      "Vision LLM response was not parseable JSON",
    );
    throw new Error("Model returned unparseable output (expected a JSON object)");
  }

  const str = (v: unknown) => (v != null && v !== "null" ? String(v) : "");
  const num = (v: unknown) => (v != null && !isNaN(Number(v)) ? Number(v) : 0);
  const idType = (v: unknown): MsaFields["ownerIdProofType"] =>
    ID_PROOF_TYPES.includes(v as MsaFields["ownerIdProofType"])
      ? (v as MsaFields["ownerIdProofType"])
      : "AADHAR";

  const fields: MsaFields = {
    vehicleMake: str(parsed.vehicleMake),
    vehicleModel: str(parsed.vehicleModel),
    vehicleVariant: str(parsed.vehicleVariant),
    vehicleEngineNumber: str(parsed.vehicleEngineNumber),
    vehicleChassisNumber: str(parsed.vehicleChassisNumber),
    vehicleExShowroomPrice: num(parsed.vehicleExShowroomPrice),
    vehicleDateOfPurchase: str(parsed.vehicleDateOfPurchase),
    ownerFullName: str(parsed.ownerFullName),
    ownerBillingAddress: str(parsed.ownerBillingAddress),
    ownerPincode: num(parsed.ownerPincode),
    ownerPhoneNumber: str(parsed.ownerPhoneNumber),
    ownerEmail: str(parsed.ownerEmail),
    ownerDateOfBirth: str(parsed.ownerDateOfBirth),
    ownerIdProofType: idType(parsed.ownerIdProofType),
    ownerIdProofNumber: str(parsed.ownerIdProofNumber),
    rtoRegistrationCity: str(parsed.rtoRegistrationCity),
    rtoRegistrationState: str(parsed.rtoRegistrationState),
    rtoCode: str(parsed.rtoCode),
  };

  // An engine that produced nothing usable is a failure, not a blank success.
  const populated = Object.values(fields).filter(
    (v) => v !== "" && v !== 0,
  ).length;
  if (populated === 0) {
    throw new Error("Model returned no recognisable fields");
  }

  for (const k of Object.keys(fields) as (keyof MsaFields)[]) {
    if (confidence[k] === undefined) {
      confidence[k] = fields[k] ? 0.65 : 0.2;
    }
  }

  return { fields, confidence, rawText };
}

// ─── Engine implementations ──────────────────────────────────────────────────

async function runGptVision(
  imageBase64: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<IngestResult> {
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl =
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1";

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: "high",
              },
            },
            { type: "text", text: OCR_EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawText = data?.choices?.[0]?.message?.content ?? "";

  logger.info(
    { engine: "gpt-vision", rawLen: rawText.length },
    "OpenAI GPT Vision OCR response received",
  );
  return parseVisionLLMResponseToMsaFields(rawText);
}

async function runQwenVl(
  imageBase64: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<IngestResult> {
  const apiKey = process.env.DASHSCOPE_API_KEY;

  const resp = await fetch(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.DASHSCOPE_VISION_MODEL ?? "qwen-vl-plus",
        input: {
          messages: [
            {
              role: "user",
              content: [
                { image: `data:${mimeType};base64,${imageBase64}` },
                { text: OCR_EXTRACTION_PROMPT },
              ],
            },
          ],
        },
        parameters: { result_format: "message" },
      }),
    },
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(
      `DashScope API error ${resp.status}: ${errBody.slice(0, 300)}`,
    );
  }

  const data = (await resp.json()) as {
    output?: {
      choices?: Array<{
        message?: { content?: Array<{ text?: string }> | string };
      }>;
    };
  };
  const contentArr = data?.output?.choices?.[0]?.message?.content;
  const rawText = Array.isArray(contentArr)
    ? contentArr.map((c) => c.text ?? "").join("")
    : String(contentArr ?? "");

  logger.info(
    { engine: "qwen-vl", rawLen: rawText.length },
    "DashScope OCR response received",
  );
  return parseVisionLLMResponseToMsaFields(rawText);
}

/**
 * Stub OCR — a realistic hardcoded RC-book extraction, for testing the review
 * and push flow without an API key. A Yamaha FZ-S registered in Delhi.
 * Every value here is invented.
 */
function runStub(): IngestResult {
  const fields: MsaFields = {
    vehicleMake: "Yamaha",
    vehicleModel: "FZ-S",
    vehicleVariant: "V3.0 Fi",
    vehicleEngineNumber: "E5C3E0123456",
    vehicleChassisNumber: "ME1RG8219M0012345",
    vehicleExShowroomPrice: 122400,
    vehicleDateOfPurchase: "2022-11-10",
    ownerFullName: "Priya Mehra",
    ownerBillingAddress: "B-74, Lajpat Nagar, New Delhi",
    ownerPincode: 110024,
    ownerPhoneNumber: "9811223344",
    ownerEmail: "priya.mehra@gmail.com",
    ownerDateOfBirth: "1992-04-15",
    ownerIdProofType: "AADHAR",
    ownerIdProofNumber: "9988-7766-5544",
    rtoRegistrationCity: "New Delhi",
    rtoRegistrationState: "Delhi",
    rtoCode: "DL01",
  };

  const confidence: Record<string, number> = {
    vehicleMake: 0.97,
    vehicleModel: 0.95,
    vehicleVariant: 0.72,
    vehicleEngineNumber: 0.88,
    vehicleChassisNumber: 0.91,
    vehicleExShowroomPrice: 0.6,
    vehicleDateOfPurchase: 0.85,
    ownerFullName: 0.93,
    ownerBillingAddress: 0.78,
    ownerPincode: 0.82,
    ownerPhoneNumber: 0.55,
    ownerEmail: 0.45,
    ownerDateOfBirth: 0.8,
    ownerIdProofType: 0.9,
    ownerIdProofNumber: 0.65,
    rtoRegistrationCity: 0.92,
    rtoRegistrationState: 0.94,
    rtoCode: 0.96,
  };

  const rawText = `REGISTRATION CERTIFICATE\nReg No: DL01AB5678\nOwner: PRIYA MEHRA\nAddress: B-74, LAJPAT NAGAR, NEW DELHI - 110024\nVehicle Class: M-Cycle/Scooter\nMaker: YAMAHA MOTOR INDIA\nModel: FZ-S V3.0 Fi\nChasis No: ME1RG8219M0012345\nEngine No: E5C3E0123456\nDate of Registration: 10/11/2022\nFuel: PETROL\nRTO: DL-01, KAMLA NAGAR, NEW DELHI`;

  return { fields, confidence, rawText, isDemoData: true };
}

// ─── Registry ────────────────────────────────────────────────────────────────

export const OCR_ENGINES: EngineDefinition[] = [
  {
    id: "gpt-vision",
    label: "GPT-4 Vision (OpenAI)",
    isImplemented: true,
    autoEligible: true,
    requiredEnvVar: "OPENAI_API_KEY",
    defaultPriority: 10,
    defaultEnabled: true,
    isConfigured: () =>
      Boolean(
        process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      ),
    run: runGptVision,
  },
  {
    id: "qwen-vl",
    label: "Qwen-VL (Alibaba DashScope)",
    isImplemented: true,
    autoEligible: true,
    requiredEnvVar: "DASHSCOPE_API_KEY",
    defaultPriority: 20,
    defaultEnabled: true,
    isConfigured: () => Boolean(process.env.DASHSCOPE_API_KEY),
    run: runQwenVl,
  },
  {
    id: "paddleocr",
    label: "PaddleOCR",
    isImplemented: false,
    autoEligible: true,
    requiredEnvVar: "PADDLEOCR_API_URL",
    defaultPriority: 30,
    defaultEnabled: false,
    isConfigured: () => Boolean(process.env.PADDLEOCR_API_URL),
    run: async () => {
      throw new Error(
        "PaddleOCR returns raw text lines, not the structured JSON the shared parser expects. A dedicated text-to-MsaFields extractor is needed before it can be wired.",
      );
    },
    unavailableReason: () =>
      "Not integrated — needs a text-to-fields extractor, see CLAUDE.md",
  },
  {
    id: "olmocr",
    label: "olmOCR",
    isImplemented: false,
    autoEligible: true,
    requiredEnvVar: null,
    defaultPriority: 40,
    defaultEnabled: false,
    isConfigured: () => false,
    run: async () => {
      throw new Error("olmOCR is not yet integrated.");
    },
    unavailableReason: () => "Not integrated",
  },
  {
    id: "stub",
    label: "Stub (demo data — not real OCR)",
    isImplemented: true,
    // Never reachable by the automatic chain. See the note at the top.
    autoEligible: false,
    requiredEnvVar: null,
    defaultPriority: 99,
    defaultEnabled: true,
    isConfigured: () => true,
    run: async () => runStub(),
  },
];

export function getEngine(id: OcrEngineId): EngineDefinition | undefined {
  return OCR_ENGINES.find((e) => e.id === id);
}

export interface EngineSetting {
  engineId: OcrEngineId;
  priority: number;
  isEnabled: boolean;
}

export interface EngineStatus {
  engineId: OcrEngineId;
  label: string;
  priority: number;
  isEnabled: boolean;
  isImplemented: boolean;
  isConfigured: boolean;
  isAvailable: boolean;
  autoEligible: boolean;
  statusReason: string;
  requiredEnvVar: string | null;
}

/**
 * Merge the code registry with operator settings from the database. Engines
 * with no stored row fall back to their registry defaults, so this works
 * against a database that has never been configured.
 */
export function buildEngineStatuses(settings: EngineSetting[]): EngineStatus[] {
  const byId = new Map(settings.map((s) => [s.engineId, s]));

  return OCR_ENGINES.map((engine) => {
    const setting = byId.get(engine.id);
    const priority = setting?.priority ?? engine.defaultPriority;
    const isEnabled = setting?.isEnabled ?? engine.defaultEnabled;
    const isConfigured = engine.isConfigured();
    const isAvailable = isEnabled && engine.isImplemented && isConfigured;

    let statusReason: string;
    if (!engine.isImplemented) {
      statusReason = engine.unavailableReason?.() ?? "Not integrated";
    } else if (!isConfigured) {
      statusReason = engine.requiredEnvVar
        ? `No API key — set ${engine.requiredEnvVar} in .env`
        : "Not configured";
    } else if (!isEnabled) {
      statusReason = "Disabled";
    } else if (!engine.autoEligible) {
      statusReason = "Ready, but only when selected explicitly";
    } else {
      statusReason = "Ready";
    }

    return {
      engineId: engine.id,
      label: engine.label,
      priority,
      isEnabled,
      isImplemented: engine.isImplemented,
      isConfigured,
      isAvailable,
      autoEligible: engine.autoEligible,
      statusReason,
      requiredEnvVar: engine.requiredEnvVar,
    };
  }).sort((a, b) => a.priority - b.priority || a.engineId.localeCompare(b.engineId));
}

/**
 * Decide which engines to try, in order.
 *
 * requested "auto"      → every available, auto-eligible engine by priority
 * requested <engine>    → that engine first, then the auto chain behind it
 * allowFallback false   → only the requested engine
 *
 * The stub never enters the chain implicitly; it appears only when requested
 * by name, and then only as the single entry.
 */
export function resolveChain(
  statuses: EngineStatus[],
  requested: OcrEngineId | "auto",
  allowFallback: boolean,
): OcrEngineId[] {
  const autoChain = statuses
    .filter((s) => s.isAvailable && s.autoEligible)
    .map((s) => s.engineId);

  if (requested === "auto") return autoChain;
  if (!allowFallback) return [requested];

  const requestedStatus = statuses.find((s) => s.engineId === requested);
  // Naming the stub means you want demo data, not a fallback chain.
  if (requestedStatus && !requestedStatus.autoEligible) return [requested];

  return [requested, ...autoChain.filter((id) => id !== requested)];
}

export interface ChainOutcome {
  result: IngestResult;
  attempts: OcrAttempt[];
}

/** Run the chain, returning the first success. Throws if every engine fails. */
export async function runOcrChain(
  chain: OcrEngineId[],
  imageBase64: string,
  mimeType: string,
): Promise<ChainOutcome> {
  const attempts: OcrAttempt[] = [];

  if (chain.length === 0) {
    throw new OcrChainError(
      "No OCR engine is available. Add an API key to .env, or enable an engine in VeloDocs settings.",
      attempts,
    );
  }

  for (const engineId of chain) {
    const engine = getEngine(engineId);
    if (!engine) {
      attempts.push({
        engineId,
        ok: false,
        error: "Unknown engine",
        durationMs: 0,
      });
      continue;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

    try {
      const result = await engine.run(imageBase64, mimeType, controller.signal);
      attempts.push({
        engineId,
        ok: true,
        error: null,
        durationMs: Date.now() - startedAt,
      });
      logger.info({ engineId, attempts: attempts.length }, "OCR succeeded");
      return {
        result: { ...result, engineUsed: engineId, attempts },
        attempts,
      };
    } catch (err) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? `Timed out after ${OCR_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      attempts.push({
        engineId,
        ok: false,
        error: message,
        durationMs: Date.now() - startedAt,
      });
      logger.warn({ engineId, err: message }, "OCR engine failed, trying next");
    } finally {
      clearTimeout(timer);
    }
  }

  throw new OcrChainError(
    `All ${attempts.length} OCR engine(s) failed: ${attempts
      .map((a) => `${a.engineId} (${a.error})`)
      .join("; ")}`,
    attempts,
  );
}

export class OcrChainError extends Error {
  constructor(
    message: string,
    public readonly attempts: OcrAttempt[],
  ) {
    super(message);
    this.name = "OcrChainError";
  }
}
