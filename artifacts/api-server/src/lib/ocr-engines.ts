/**
 * OCR engine registry and the two-stage extraction chain.
 *
 * An engine is usable only when all three hold:
 *   isImplemented — a real integration exists (not a TODO)
 *   isConfigured  — its API key is present in the environment
 *   isEnabled     — the operator has it switched on (ocr_engines table)
 *
 * Engines expose transport only — `runVision` returns the model's raw text for
 * a given prompt, `runText` does the same without an image. All prompt design
 * and parsing lives in document-extraction.ts, so adding a provider never means
 * touching extraction logic.
 *
 * ── The stub is deliberately never reachable automatically ──────────────────
 * `stub` returns a fabricated RC book. If a key expired and the chain quietly
 * fell through to it, that fiction would flow into a real insurance application
 * looking like genuine OCR output. So `autoEligible` is false for stub, and it
 * runs only when named explicitly. Results from it are flagged `isDemoData`.
 */

import { logger } from "./logger";
import {
  DOCUMENT_EXTRACTION_PROMPT,
  buildMappingPrompt,
  parseDocumentExtraction,
  parseMappingResponse,
  mapDocumentToMsaByRules,
  type DocumentExtraction,
  type IngestResult,
  type OcrAttempt,
} from "./document-extraction";

export type OcrEngineId =
  | "paddleocr"
  | "qwen-vl"
  | "olmocr"
  | "gpt-vision"
  | "gemini"
  | "openrouter"
  | "stub";

export type {
  MsaFields,
  IngestResult,
  OcrAttempt,
  DocumentExtraction,
} from "./document-extraction";

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
  /** Stage 1. Returns the model's raw text response. */
  runVision(
    imageBase64: string,
    mimeType: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string>;
  /** Stage 2. Absent means this engine cannot map, so rules are used instead. */
  runText?(prompt: string, signal: AbortSignal): Promise<string>;
  /** Explains why the engine is unusable, when it is. */
  unavailableReason?(): string | null;
}

/** Per-attempt deadline. A hung provider must not stall the whole chain. */
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 45_000);

// ─── Transport: OpenAI-compatible ────────────────────────────────────────────

/**
 * Shared caller for any OpenAI-compatible /chat/completions endpoint. Used by
 * both `gpt-vision` (OpenAI proper) and `openrouter` (aggregator), which speak
 * the identical wire format and differ only in host, key and headers.
 */
async function callOpenAiCompatible(opts: {
  engineId: OcrEngineId;
  providerName: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  prompt: string;
  image?: { base64: string; mimeType: string };
  signal: AbortSignal;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const content: unknown[] = [];
  if (opts.image) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${opts.image.mimeType};base64,${opts.image.base64}`,
        detail: "high",
      },
    });
  }
  content.push({ type: "text", text: opts.prompt });

  const resp = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...opts.extraHeaders,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(
      `${opts.providerName} API error ${resp.status}: ${errBody.slice(0, 300)}`,
    );
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  // OpenRouter can return HTTP 200 with an error body when an upstream
  // provider fails. Treat that as a failure so the chain moves on.
  if (data.error?.message) {
    throw new Error(`${opts.providerName} error: ${data.error.message}`);
  }

  const rawText = data?.choices?.[0]?.message?.content ?? "";
  logger.info(
    { engine: opts.engineId, model: opts.model, rawLen: rawText.length },
    `${opts.providerName} response received`,
  );
  return rawText;
}

// ─── Transport: Gemini native ────────────────────────────────────────────────

/**
 * Google Gemini via the native API rather than its OpenAI-compatible shim, so
 * we can set responseMimeType: "application/json". That constrains the model to
 * emit valid JSON, removing the most common parse failure — prose or markdown
 * fences wrapped around the object.
 */
async function callGemini(opts: {
  prompt: string;
  image?: { base64: string; mimeType: string };
  signal: AbortSignal;
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  // Default to the moving alias, not a pinned version. Google retires specific
  // versions for new accounts WITHOUT removing them from the models list —
  // gemini-2.5-flash still lists but 404s with "no longer available to new
  // users". The alias always resolves to the current Flash, so this cannot rot.
  const model = process.env.GEMINI_VISION_MODEL ?? "gemini-flash-latest";
  const baseUrl =
    process.env.GEMINI_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta";

  const parts: unknown[] = [];
  if (opts.image) {
    parts.push({
      inline_data: { mime_type: opts.image.mimeType, data: opts.image.base64 },
    });
  }
  parts.push({ text: opts.prompt });

  const resp = await fetch(`${baseUrl}/models/${model}:generateContent`, {
    method: "POST",
    signal: opts.signal,
    headers: {
      // Header rather than ?key= so the credential stays out of URL logs.
      "x-goog-api-key": apiKey ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Gemini API error ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini blocked the request: ${data.promptFeedback.blockReason}`,
    );
  }

  const candidate = data?.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error(
      "Gemini hit the output token limit before completing the JSON",
    );
  }

  const rawText =
    candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  logger.info({ engine: "gemini", model, rawLen: rawText.length }, "Gemini response received");
  return rawText;
}

// ─── Transport: DashScope (Qwen) ─────────────────────────────────────────────

async function callQwen(opts: {
  prompt: string;
  image?: { base64: string; mimeType: string };
  signal: AbortSignal;
}): Promise<string> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const content: unknown[] = [];
  if (opts.image) {
    content.push({ image: `data:${opts.image.mimeType};base64,${opts.image.base64}` });
  }
  content.push({ text: opts.prompt });

  const resp = await fetch(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    {
      method: "POST",
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.DASHSCOPE_VISION_MODEL ?? "qwen-vl-plus",
        input: { messages: [{ role: "user", content }] },
        parameters: { result_format: "message" },
      }),
    },
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`DashScope API error ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    output?: {
      choices?: Array<{ message?: { content?: Array<{ text?: string }> | string } }>;
    };
  };
  const contentArr = data?.output?.choices?.[0]?.message?.content;
  const rawText = Array.isArray(contentArr)
    ? contentArr.map((c) => c.text ?? "").join("")
    : String(contentArr ?? "");

  logger.info({ engine: "qwen-vl", rawLen: rawText.length }, "DashScope response received");
  return rawText;
}

// ─── Stub ────────────────────────────────────────────────────────────────────

/**
 * A fabricated RC book, shaped exactly like a real stage-1 extraction so the
 * rest of the pipeline is exercised identically. Every value here is invented.
 *
 * The stub deliberately provides no `runText`, so stage 2 falls to the
 * deterministic rules mapper — meaning every stub run is also a live test of
 * the fallback path.
 */
const STUB_DOCUMENT: DocumentExtraction = {
  documentType: "RC_BOOK",
  documentTypeConfidence: 0.99,
  issuer: "Motor Vehicles Department, Government of NCT of Delhi",
  summary:
    "Vehicle registration certificate for a Yamaha FZ-S registered at RTO Delhi (DL01).",
  fields: [
    { label: "Registration Number", value: "DL01 AB 5678", group: "rto", confidence: 0.96 },
    { label: "Registered Owner", value: "PRIYA MEHRA", group: "owner", confidence: 0.93 },
    { label: "Address", value: "B-74, Lajpat Nagar, New Delhi - 110024", group: "owner", confidence: 0.78 },
    { label: "Date of Birth", value: "15-04-1992", group: "owner", confidence: 0.8 },
    { label: "Mobile Number", value: "9811223344", group: "owner", confidence: 0.55 },
    { label: "Aadhaar Number", value: "9988-7766-5544", group: "owner", confidence: 0.65 },
    { label: "Maker", value: "YAMAHA MOTOR INDIA", group: "vehicle", confidence: 0.97 },
    { label: "Model", value: "FZ-S", group: "vehicle", confidence: 0.95 },
    { label: "Variant", value: "V3.0 Fi", group: "vehicle", confidence: 0.72 },
    { label: "Vehicle Class", value: "M-Cycle/Scooter", group: "vehicle", confidence: 0.94 },
    { label: "Chassis No.", value: "ME1RG8219M0012345", group: "vehicle", confidence: 0.91 },
    { label: "Engine No.", value: "E5C3E0123456", group: "vehicle", confidence: 0.88 },
    { label: "Fuel Type", value: "PETROL", group: "vehicle", confidence: 0.96 },
    { label: "Ex-Showroom Price", value: "Rs. 1,22,400/-", group: "vehicle", confidence: 0.6 },
    { label: "Date of Registration", value: "10-11-2022", group: "vehicle", confidence: 0.85 },
    { label: "Registration City", value: "New Delhi", group: "rto", confidence: 0.92 },
    { label: "State", value: "Delhi", group: "rto", confidence: 0.94 },
    { label: "Registering Authority", value: "RTO DL-01, KAMLA NAGAR, NEW DELHI", group: "rto", confidence: 0.9 },
  ],
  rawText: `REGISTRATION CERTIFICATE
Reg No: DL01AB5678
Owner: PRIYA MEHRA
Address: B-74, LAJPAT NAGAR, NEW DELHI - 110024
Vehicle Class: M-Cycle/Scooter
Maker: YAMAHA MOTOR INDIA
Model: FZ-S V3.0 Fi
Chasis No: ME1RG8219M0012345
Engine No: E5C3E0123456
Date of Registration: 10/11/2022
Fuel: PETROL
RTO: DL-01, KAMLA NAGAR, NEW DELHI`,
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const OCR_ENGINES: EngineDefinition[] = [
  {
    // Free tier includes vision on the Flash models, so this goes first.
    id: "gemini",
    label: "Gemini Flash (Google — free tier)",
    isImplemented: true,
    autoEligible: true,
    requiredEnvVar: "GEMINI_API_KEY",
    defaultPriority: 5,
    defaultEnabled: true,
    isConfigured: () =>
      Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY),
    runVision: (base64, mimeType, prompt, signal) =>
      callGemini({ prompt, image: { base64, mimeType }, signal }),
    runText: (prompt, signal) => callGemini({ prompt, signal }),
  },
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
    runVision: (base64, mimeType, prompt, signal) =>
      callOpenAiCompatible({
        engineId: "gpt-vision",
        providerName: "OpenAI",
        baseUrl:
          process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
          "https://api.openai.com/v1",
        apiKey:
          process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??
          process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
        prompt,
        image: { base64, mimeType },
        signal,
      }),
    runText: (prompt, signal) =>
      callOpenAiCompatible({
        engineId: "gpt-vision",
        providerName: "OpenAI",
        baseUrl:
          process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
          "https://api.openai.com/v1",
        apiKey:
          process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??
          process.env.OPENAI_API_KEY,
        // Stage 2 is text-only, so a cheaper model is enough.
        model: process.env.OPENAI_TEXT_MODEL ?? "gpt-4o-mini",
        prompt,
        signal,
      }),
  },
  {
    // Aggregator: one key, many upstream models, several free.
    id: "openrouter",
    label: "OpenRouter (aggregator — free models available)",
    isImplemented: true,
    autoEligible: true,
    requiredEnvVar: "OPENROUTER_API_KEY",
    defaultPriority: 15,
    defaultEnabled: true,
    isConfigured: () => Boolean(process.env.OPENROUTER_API_KEY),
    runVision: (base64, mimeType, prompt, signal) =>
      callOpenAiCompatible({
        engineId: "openrouter",
        providerName: "OpenRouter",
        baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        model:
          process.env.OPENROUTER_VISION_MODEL ?? "google/gemma-4-31b-it:free",
        prompt,
        image: { base64, mimeType },
        signal,
        extraHeaders: {
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost",
          "X-Title": "InsurRouter / VeloDocs",
        },
      }),
    runText: (prompt, signal) =>
      callOpenAiCompatible({
        engineId: "openrouter",
        providerName: "OpenRouter",
        baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        model:
          process.env.OPENROUTER_TEXT_MODEL ??
          process.env.OPENROUTER_VISION_MODEL ??
          "google/gemma-4-31b-it:free",
        prompt,
        signal,
        extraHeaders: {
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost",
          "X-Title": "InsurRouter / VeloDocs",
        },
      }),
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
    runVision: (base64, mimeType, prompt, signal) =>
      callQwen({ prompt, image: { base64, mimeType }, signal }),
    runText: (prompt, signal) => callQwen({ prompt, signal }),
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
    runVision: async () => {
      throw new Error(
        "PaddleOCR returns raw text lines, not the structured JSON stage 1 expects. It needs a text-to-fields extractor before it can be wired.",
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
    runVision: async () => {
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
    runVision: async () => JSON.stringify(STUB_DOCUMENT),
    // No runText on purpose — stage 2 uses the rules mapper, so every stub run
    // exercises the deterministic fallback path.
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

export class OcrChainError extends Error {
  constructor(
    message: string,
    public readonly attempts: OcrAttempt[],
  ) {
    super(message);
    this.name = "OcrChainError";
  }
}

/**
 * Stage 2. Ask the engine to map the extraction onto MSA fields; if it cannot
 * or the call fails, fall back to deterministic label matching so a mapping
 * outage degrades to a partial result rather than losing stage 1's work.
 */
async function mapToMsa(
  engine: EngineDefinition,
  doc: DocumentExtraction,
): Promise<{
  fields: IngestResult["fields"];
  provenance: Record<string, string | null>;
  confidence: Record<string, number>;
  mappingMethod: "llm" | "rules";
}> {
  if (engine.runText) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
    try {
      const raw = await engine.runText(
        buildMappingPrompt(doc),
        controller.signal,
      );
      const mapped = parseMappingResponse(raw);
      return { ...mapped, mappingMethod: "llm" };
    } catch (err) {
      logger.warn(
        { engineId: engine.id, err: err instanceof Error ? err.message : err },
        "Stage 2 mapping failed, falling back to rules",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { ...mapDocumentToMsaByRules(doc), mappingMethod: "rules" };
}

export interface ChainOutcome {
  result: IngestResult;
  attempts: OcrAttempt[];
}

/**
 * Run the chain: stage 1 on each engine until one produces a readable document,
 * then stage 2 on that same engine. Throws if every engine fails stage 1.
 */
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
      attempts.push({ engineId, ok: false, error: "Unknown engine", durationMs: 0 });
      continue;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

    try {
      // ── Stage 1: what is this document, and what does it say? ────────────
      const raw = await engine.runVision(
        imageBase64,
        mimeType,
        DOCUMENT_EXTRACTION_PROMPT,
        controller.signal,
      );
      const document = parseDocumentExtraction(raw);
      clearTimeout(timer);

      attempts.push({
        engineId,
        ok: true,
        error: null,
        durationMs: Date.now() - startedAt,
      });

      // ── Stage 2: map that document onto the MSA payload ──────────────────
      const { fields, provenance, confidence, mappingMethod } = await mapToMsa(
        engine,
        document,
      );

      logger.info(
        {
          engineId,
          documentType: document.documentType,
          docFields: document.fields.length,
          mappingMethod,
        },
        "Extraction complete",
      );

      return {
        result: {
          fields,
          confidence,
          provenance,
          document,
          mappingMethod,
          rawText: document.rawText,
          engineUsed: engineId,
          isDemoData: engineId === "stub",
          attempts,
        },
        attempts,
      };
    } catch (err) {
      clearTimeout(timer);
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
    }
  }

  throw new OcrChainError(
    `All ${attempts.length} OCR engine(s) failed: ${attempts
      .map((a) => `${a.engineId} (${a.error})`)
      .join("; ")}`,
    attempts,
  );
}
