/**
 * HTTP client for a dealer DMS.
 *
 * A real OEM DMS is a shared ERP under load, not a service built for us. It is
 * slow at month end, it returns 503 when the host system is busy, and it drops
 * connections. Everything in this file exists because of that: a deadline on
 * every call, bounded retries on the failures that are worth retrying, and no
 * retries at all on the ones that are not.
 *
 * Exercise it with the mock's failure injection rather than against a mock that
 * is always instant and always up:
 *
 *   $env:DMS_MOCK_LATENCY_MS=1200; $env:DMS_MOCK_FAIL_RATE=0.3
 *
 * Configuration, read live from the environment so a restart is enough:
 *   DMS_API_URL      base URL, e.g. http://localhost:9090
 *   DMS_API_KEY      sent as X-DMS-API-Key
 *   DMS_TIMEOUT_MS   per-attempt deadline, default 10000
 *   DMS_MAX_ATTEMPTS total attempts including the first, default 3
 */

import { logger } from "../logger";
import type {
  DmsDeal,
  DmsDealSummary,
  DmsEmployee,
  DmsEnquiry,
  DmsEnquirySummary,
  DmsErrorBody,
  DmsJobCard,
  DmsJobCardSummary,
  DmsPartStock,
  DmsRegnFile,
  DmsRegnFileSummary,
  DmsStockLookup,
} from "./types";

export class DmsError extends Error {
  constructor(
    message: string,
    readonly kind: "config" | "not_found" | "auth" | "unavailable" | "bad_response",
    readonly httpStatus?: number,
    readonly attempts?: number,
  ) {
    super(message);
    this.name = "DmsError";
  }
}

interface DmsConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
}

function readConfig(): DmsConfig {
  const baseUrl = process.env.DMS_API_URL?.trim();
  const apiKey = process.env.DMS_API_KEY?.trim();

  if (!baseUrl) {
    throw new DmsError(
      "DMS_API_URL is not set. Point it at the dealer DMS (http://localhost:9090 for the mock).",
      "config",
    );
  }
  if (!apiKey) {
    throw new DmsError(
      "DMS_API_KEY is not set. The DMS rejects unauthenticated requests.",
      "config",
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    timeoutMs: Number(process.env.DMS_TIMEOUT_MS ?? 10_000),
    maxAttempts: Math.max(1, Number(process.env.DMS_MAX_ATTEMPTS ?? 3)),
  };
}

/** True for failures where trying the same request again is reasonable. */
function isRetryable(status: number): boolean {
  // 503 is what the mock emits for "host system busy" and what a real DMS
  // emits under load. 502/504 are the same story through a gateway. 429 is
  // rate limiting. Everything else — including 400 and 404 — will fail again
  // identically, so retrying only adds latency to a certain failure.
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One GET against the DMS, with a deadline and bounded retries.
 *
 * `notFoundIsNull` distinguishes "this chassis is not in stock" — an ordinary
 * answer the caller handles — from a transport failure.
 */
async function dmsGet<T>(path: string, opts: { notFoundIsNull?: boolean } = {}): Promise<T | null> {
  const cfg = readConfig();
  const url = `${cfg.baseUrl}${path}`;
  let lastError = "";

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const startedAt = Date.now();

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          // Header, never `?apiKey=`. The mock accepts the query string so it
          // can be poked from a browser bar; query strings land in access logs,
          // browser history and Referer headers.
          "X-DMS-API-Key": cfg.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (resp.status === 404 && opts.notFoundIsNull) return null;

      if (resp.status === 401 || resp.status === 403) {
        throw new DmsError(
          `DMS rejected the API key (HTTP ${resp.status}). Check DMS_API_KEY.`,
          "auth",
          resp.status,
          attempt,
        );
      }

      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as DmsErrorBody;
        const detail = body.errDesc ? `${body.errCode ?? "ERR"}: ${body.errDesc}` : `HTTP ${resp.status}`;

        if (isRetryable(resp.status) && attempt < cfg.maxAttempts) {
          lastError = detail;
          // Linear backoff. A busy ERP recovers on the scale of seconds, and
          // exponential growth would blow past any sensible request deadline.
          const delay = 300 * attempt;
          logger.warn(
            { url, attempt, maxAttempts: cfg.maxAttempts, status: resp.status, delay },
            "DMS call failed, retrying",
          );
          await sleep(delay);
          continue;
        }

        throw new DmsError(
          `DMS call failed after ${attempt} attempt(s): ${detail}`,
          isRetryable(resp.status) ? "unavailable" : "bad_response",
          resp.status,
          attempt,
        );
      }

      const json = (await resp.json()) as T;
      logger.debug({ url, attempt, ms: Date.now() - startedAt }, "DMS call ok");
      return json;
    } catch (err) {
      if (err instanceof DmsError) throw err;

      // AbortError (deadline) and network-level failures are both worth one
      // more try — neither says anything about whether the request was valid.
      const aborted = err instanceof Error && err.name === "AbortError";
      lastError = aborted ? `timed out after ${cfg.timeoutMs}ms` : String(err);

      if (attempt < cfg.maxAttempts) {
        logger.warn({ url, attempt, err: lastError }, "DMS call errored, retrying");
        await sleep(300 * attempt);
        continue;
      }

      throw new DmsError(
        `DMS unreachable after ${attempt} attempt(s): ${lastError}`,
        "unavailable",
        undefined,
        attempt,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new DmsError(`DMS call failed: ${lastError}`, "unavailable", undefined, cfg.maxAttempts);
}

/**
 * Deal summaries for one dealer code.
 *
 * The DMS returns a summary shape here rather than full records, which is the
 * right call on their side — shipping complete customer records for rows
 * nobody opens is needless PII exposure. It also gives a sync a cheap way to
 * tell what moved before deciding which full records to pull.
 */
export async function dmsList(
  dealerCode: string,
  status?: string,
): Promise<DmsDealSummary[]> {
  const params = new URLSearchParams({ dealerCode });
  if (status) params.set("status", status);
  const body = await dmsGet<{ count: number; deals: DmsDealSummary[] }>(
    `/dms/v1/deals?${params.toString()}`,
  );
  return body?.deals ?? [];
}

/** Full deal record. Null when the DMS has no such deal. */
export function fetchDeal(dealId: string): Promise<DmsDeal | null> {
  return dmsGet<DmsDeal>(`/dms/v1/deals/${encodeURIComponent(dealId)}`, {
    notFoundIsNull: true,
  });
}

/**
 * Workshop job cards for a dealer.
 *
 * Summaries only, like the deal list: complaint text and part lines are not
 * needed to decide which row to open, and shipping them for rows nobody opens
 * is needless PII over the wire.
 */
export async function dmsJobCards(
  dealerCode: string,
  status?: string,
): Promise<DmsJobCardSummary[]> {
  const params = new URLSearchParams({ dealerCode });
  if (status) params.set("status", status);
  const body = await dmsGet<{ count: number; jobCards: DmsJobCardSummary[] }>(
    `/dms/v1/jobcards?${params.toString()}`,
  );
  return body?.jobCards ?? [];
}

export function fetchJobCard(jcNo: string): Promise<DmsJobCard | null> {
  return dmsGet<DmsJobCard>(`/dms/v1/jobcards/${encodeURIComponent(jcNo)}`, {
    notFoundIsNull: true,
  });
}

/** Enquiries for a dealer. Summaries only, like the other lists. */
export async function dmsEnquiries(
  dealerCode: string,
  stage?: string,
): Promise<DmsEnquirySummary[]> {
  const params = new URLSearchParams({ dealerCode });
  if (stage) params.set("stage", stage);
  const body = await dmsGet<{ count: number; enquiries: DmsEnquirySummary[] }>(
    `/dms/v1/enquiries?${params.toString()}`,
  );
  return body?.enquiries ?? [];
}

export function fetchEnquiry(enqId: string): Promise<DmsEnquiry | null> {
  return dmsGet<DmsEnquiry>(`/dms/v1/enquiries/${encodeURIComponent(enqId)}`, {
    notFoundIsNull: true,
  });
}

/**
 * Registration files for a dealer. Summaries only, like the other lists — the
 * document checklist is only needed once a row is opened.
 */
export async function dmsRegistrations(
  dealerCode: string,
  status?: string,
): Promise<DmsRegnFileSummary[]> {
  const params = new URLSearchParams({ dealerCode });
  if (status) params.set("status", status);
  const body = await dmsGet<{ count: number; registrations: DmsRegnFileSummary[] }>(
    `/dms/v1/registrations?${params.toString()}`,
  );
  return body?.registrations ?? [];
}

export function fetchRegnFile(regnFileNo: string): Promise<DmsRegnFile | null> {
  return dmsGet<DmsRegnFile>(`/dms/v1/registrations/${encodeURIComponent(regnFileNo)}`, {
    notFoundIsNull: true,
  });
}

/**
 * Parts stock for one dealer code.
 *
 * The whole ledger rather than summaries, unlike every other list here. A parts
 * ledger is a few hundred lines of numbers with no personal data in it, and the
 * cross-branch comparison needs all of them — asking per part would be one HTTP
 * call per line to answer a question about the whole shelf.
 */
export async function dmsPartStock(dealerCode: string): Promise<DmsPartStock[]> {
  const body = await dmsGet<{ count: number; stock: DmsPartStock[] }>(
    `/dms/v1/parts/stock?dealerCode=${encodeURIComponent(dealerCode)}`,
  );
  return body?.stock ?? [];
}

/** The dealer's staff master, including who has left. */
export async function dmsEmployees(dealerCode: string): Promise<DmsEmployee[]> {
  const body = await dmsGet<{ count: number; employees: DmsEmployee[] }>(
    `/dms/v1/employees?dealerCode=${encodeURIComponent(dealerCode)}`,
  );
  return body?.employees ?? [];
}

/**
 * Look a chassis up in stock. Returns the unit and, if it has been allocated,
 * the deal it belongs to — which is how a chassis number becomes a deal.
 */
export function fetchStockByChassis(chassisNo: string): Promise<DmsStockLookup | null> {
  return dmsGet<DmsStockLookup>(`/dms/v1/stock/${encodeURIComponent(chassisNo)}`, {
    notFoundIsNull: true,
  });
}

/** Whether the DMS is configured at all, without throwing. */
export function isDmsConfigured(): boolean {
  return Boolean(process.env.DMS_API_URL?.trim() && process.env.DMS_API_KEY?.trim());
}
