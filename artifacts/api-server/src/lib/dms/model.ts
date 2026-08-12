import { logger } from "../logger";
import { meterModel } from "./trace";

/**
 * The one place this product calls a model (OBJ-28, R-92).
 *
 * ## Why it had to become one function
 *
 * There were three near-identical copies of the same fetch — the composer's
 * rewrite, the explanation's narration and the ingest mapping's heading reader.
 * Same endpoint, same headers, same envelope, three sets of error handling that
 * had drifted apart, and **no single place that could count what any of it
 * cost**. R-92 asks for a per-run cost and a daily ceiling, and a ceiling that
 * only knows about two of the three call sites is not a ceiling.
 *
 * So metering is by construction rather than by whoever adds the fourth call
 * site remembering to do it. That is the same argument R-81 makes about writes:
 * one door, or eventually two answers.
 *
 * ## It never throws and never returns half an answer
 *
 * Every caller here has a rules-only fallback that is a legitimate answer —
 * the template wording, the findings without a narration, the headings matched
 * by name. So a missing key, a rate limit, a timeout and a malformed response
 * all resolve to `{ ok: false }` with a reason, and the caller carries on.
 *
 * **The reason is logged in every branch**, because a silent fallback and a
 * silent failure look identical from the outside. They looked identical here
 * for a whole session once: a malformed request made the composer's model path
 * inert and every draft came back `RULE`, which is exactly what healthy
 * fallback looks like.
 */

export interface ModelAsk {
  /** What this call is for, and it appears in the trace: `compose`, `narrate`. */
  purpose: string;
  system: string;
  user: string;
  /** Overridable per call site, because the prompts differ by an order of magnitude. */
  maxOutputTokens: number;
  temperature?: number;
  /** Environment override, e.g. `EXPLAIN_MODEL`. `off` disables that call site. */
  modelEnvVar?: string;
  timeoutMs?: number;
  /** Ask the model for JSON, for the ingest heading reader. */
  json?: boolean;
}

export type ModelAnswer =
  | { ok: true; text: string; finishReason: string | null; costPaise: number }
  | { ok: false; reason: string; costPaise: number };

const DEFAULT_MODEL = "gemini-flash-latest";

export function modelAvailable(envVar?: string): boolean {
  if (!process.env["GEMINI_API_KEY"]) return false;
  return !(envVar && process.env[envVar] === "off");
}

export async function askModel(ask: ModelAsk): Promise<ModelAnswer> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) return { ok: false, reason: "No GEMINI_API_KEY is set.", costPaise: 0 };
  if (ask.modelEnvVar && process.env[ask.modelEnvVar] === "off") {
    return { ok: false, reason: `${ask.modelEnvVar} is off.`, costPaise: 0 };
  }

  const model = (ask.modelEnvVar && process.env[ask.modelEnvVar]) || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ask.timeoutMs ?? 15_000);
  const started = Date.now();

  /*
   * Metering happens on **every** exit, including the failures.
   *
   * A call that timed out still consumed the provider's compute and may still
   * be billed, and more importantly a run where nine calls out of ten fail is
   * the thing somebody most needs to see in the trace. Recording only the
   * successes would produce a tidy trace of a broken pass.
   */
  const finish = async (
    result: ModelAnswer,
    usage: { input: number; output: number },
    detail?: string,
  ): Promise<ModelAnswer> => {
    const costPaise = await meterModel({
      purpose: ask.purpose,
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      ms: Date.now() - started,
      ok: result.ok,
      detail,
    });
    return { ...result, costPaise } as ModelAnswer;
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: ask.system }] },
          generationConfig: {
            temperature: ask.temperature ?? 0.2,
            maxOutputTokens: ask.maxOutputTokens,
            ...(ask.json ? { responseMimeType: "application/json" } : {}),
          },
          contents: [{ role: "user", parts: [{ text: ask.user }] }],
        }),
      },
    );

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      logger.warn({ purpose: ask.purpose, status: res.status, body }, "Model call refused");
      return finish(
        { ok: false, reason: `HTTP ${res.status}`, costPaise: 0 },
        { input: 0, output: 0 },
        `The provider refused it with HTTP ${res.status}.`,
      );
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    /*
     * The provider's own token counts, not an estimate of an estimate.
     *
     * `usageMetadata` is what Google will bill against, so using it makes the
     * only inaccuracy in the cost figure the rate table — which is a number we
     * can correct in one place rather than a guess compounding per call.
     */
    const usage = {
      input: json.usageMetadata?.promptTokenCount ?? 0,
      output: json.usageMetadata?.candidatesTokenCount ?? 0,
    };

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const finishReason = json.candidates?.[0]?.finishReason ?? null;

    if (!text) {
      // The commonest real failure, and it used to be invisible. On a thinking
      // model the token budget covers the reasoning as well as the reply, so a
      // budget set too low buys a paragraph of deliberation and no output at
      // all — with `finishReason: MAX_TOKENS` as the only sign.
      logger.warn({ purpose: ask.purpose, finishReason }, "Model returned nothing usable");
      return finish(
        { ok: false, reason: `No text (${finishReason ?? "no reason given"})`, costPaise: 0 },
        usage,
        `It returned no text — ${finishReason ?? "no reason given"}.`,
      );
    }

    return finish({ ok: true, text, finishReason, costPaise: 0 }, usage);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ purpose: ask.purpose, reason }, "Model call threw");
    return finish({ ok: false, reason, costPaise: 0 }, { input: 0, output: 0 }, reason);
  } finally {
    clearTimeout(timer);
  }
}
