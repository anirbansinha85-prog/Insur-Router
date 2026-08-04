/**
 * VeloDocs — Document Ingestion Routes
 *
 * Ingest sources → normalised MsaFields + confidence scores:
 *   POST /api/ingest/dms-pull       — Dealer DMS, keyed on dealId or chassisNo
 *   POST /api/ingest/browser-scrape — Playwright scrape of dealer portal
 *   POST /api/ingest/ocr            — two-stage document extraction
 *   GET  /api/ingest/ocr/engines    — engine availability and priority
 *   PUT  /api/ingest/ocr/engines    — set engine priority and enabled state
 *   POST /api/ingest/push           — Push reviewed payload to InsurRouter as draft
 *
 * OCR runs in two stages (see lib/document-extraction.ts): the model first
 * identifies the document and transcribes it under its own printed labels, then
 * a second pass maps that onto the MSA payload with provenance. DMS and scrape
 * sources produce MSA fields directly and carry no document extraction.
 */

import { Router, type IRouter } from "express";
import { URL } from "url";
import dns from "dns/promises";
import net from "net";
import { eq } from "drizzle-orm";
import {
  IngestDmsPullBody,
  IngestBrowserScrapeBody,
  IngestOcrBody,
  IngestPushBody,
  UpdateOcrEnginesBody,
  ListOcrEnginesResponse,
  UpdateOcrEnginesResponse,
} from "@workspace/api-zod";
import {
  db,
  applicationsTable,
  submissionLogsTable,
  ocrEnginesTable,
} from "@workspace/db";
import { chromiumLaunchOptions } from "../lib/browser-executor";
import { createDraftApplication } from "../lib/draft-application";
import {
  DmsError,
  adapterForDealer,
  fetchDeal,
  fetchStockByChassis,
  isDmsConfigured,
  resolveTenantByDealerCode,
  type DmsDealContext,
} from "../lib/dms";
import {
  buildEngineStatuses,
  resolveChain,
  runOcrChain,
  OcrChainError,
  type EngineSetting,
  type MsaFields,
  type IngestResult,
  type OcrEngineId,
} from "../lib/ocr-engines";
import { EMPTY_MSA_FIELDS } from "../lib/document-extraction";
import { logger } from "../lib/logger";
import { requireModule, requireUser, resolveOwningShowroom, sessionScope } from "../lib/session";

// ─── SSRF protection ─────────────────────────────────────────────────────────

/**
 * Returns true when an IPv4 dotted-decimal address is in a private/reserved range:
 *   loopback 127.x, 10.x (RFC-1918 A), 172.16-31.x (RFC-1918 B),
 *   192.168.x (RFC-1918 C), link-local 169.254.x (inc. AWS metadata 169.254.169.254),
 *   0.0.0.0/8, 100.64.x (CGNAT), 192.0.x (IETF), multicast 224+, reserved 240+.
 */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  return (
    a === 0 ||                                      // 0.0.0.0/8
    a === 10 ||                                     // 10.0.0.0/8  RFC-1918 A
    a === 127 ||                                    // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) ||           // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) ||                     // 169.254.0.0/16 link-local / metadata
    (a === 172 && b >= 16 && b <= 31) ||            // 172.16.0.0/12 RFC-1918 B
    (a === 192 && b === 0 && c === 0) ||            // 192.0.0.0/24 IETF protocol
    (a === 192 && b === 0 && c === 2) ||            // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 168) ||                     // 192.168.0.0/16 RFC-1918 C
    (a === 198 && (b === 18 || b === 19)) ||        // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) ||         // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||          // 203.0.113.0/24 TEST-NET-3
    a >= 224                                        // 224+ multicast / reserved
  );
}

/**
 * Returns true when an IPv6 address (canonical or abbreviated) is in a
 * private/reserved range:
 *   ::1 loopback, :: unspecified, fe80::/10 link-local, fc00::/7 unique-local,
 *   ff00::/8 multicast, ::ffff:0:0/96 IPv4-mapped (checked separately below),
 *   2001:db8::/32 documentation, 64:ff9b::/96 NAT64.
 */
function isPrivateIpv6(address: string): boolean {
  const n = address.toLowerCase();
  return (
    n === "::1" ||                               // loopback
    n === "::" ||                                // unspecified
    /^fe[89ab]/i.test(n) ||                      // fe80::/10 link-local (fe80–febf)
    /^f[cd]/i.test(n) ||                         // fc00::/7 unique-local (fc00–fdff)
    n.startsWith("ff") ||                        // ff00::/8 multicast
    n.startsWith("2001:db8") ||                  // documentation
    n.startsWith("64:ff9b:") ||                  // NAT64
    n.startsWith("::ffff:") ||                   // IPv4-mapped  — checked below too
    n.startsWith("::ffff:0:")                    // IPv4-translated
  );
}

/**
 * Expand an IPv4-mapped IPv6 address "::ffff:<v4>" to the embedded IPv4 part.
 * Returns null if not an IPv4-mapped form.
 */
function extractIpv4FromMapped(address: string): string | null {
  // dotted form: ::ffff:1.2.3.4
  const dottedMatch = address.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dottedMatch) return dottedMatch[1];
  // hex form: ::ffff:7f00:0001  (127.0.0.1)
  const hexMatch = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** True if an IP string (v4 or v6) resolves to a private/internal range. */
function ipIsInternal(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (net.isIPv6(address)) {
    const mapped = extractIpv4FromMapped(address);
    if (mapped !== null) return isPrivateIpv4(mapped);
    return isPrivateIpv6(address);
  }
  return false; // unknown format — let it through to DNS resolution
}

/**
 * Validates a URL for safe server-side navigation:
 *   1. Must use http(s) protocol only.
 *   2. If the hostname is a bare IP, reject private/internal addresses directly.
 *   3. For hostname labels, also reject known-internal TLDs and "localhost".
 *   4. Resolve the hostname via DNS and reject if any A/AAAA record is internal.
 *
 * Returns { ok, href } on success or { ok, reason } on failure.
 */
async function validateUrlSsrf(
  raw: string,
): Promise<{ ok: true; href: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Protocol '${parsed.protocol}' is not allowed; only http and https are permitted`,
    };
  }

  // Strip IPv6 brackets that URL includes but net.isIPv6 doesn't expect
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");

  // Block bare IP addresses without DNS
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (ipIsInternal(hostname)) {
      return { ok: false, reason: `IP address ${hostname} is in a private/internal range` };
    }
    return { ok: true, href: parsed.href };
  }

  // Block known-internal hostname patterns (no DNS needed)
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".corp") ||
    hostname.endsWith(".lan")
  ) {
    return { ok: false, reason: `Hostname '${hostname}' is reserved for internal use` };
  }

  // DNS resolution — reject if any resolved address is internal
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: `Cannot resolve hostname '${hostname}'` };
  }

  for (const { address } of records) {
    if (ipIsInternal(address)) {
      return {
        ok: false,
        reason: `Hostname '${hostname}' resolves to internal address ${address}`,
      };
    }
  }

  return { ok: true, href: parsed.href };
}

const router: IRouter = Router();

/**
 * Behind a session since OBJ-8, mounted on the prefix rather than path-less —
 * a path-less `router.use` here is precisely the bug that made these routes
 * answer 401 for a whole session once before.
 *
 * Ingest is where somebody else's data physically enters this system: a deal
 * pulled from a dealer's DMS, a scraped portal, an Aadhaar card photographed on
 * a counter. Running it unauthenticated meant the shared service key was the
 * only thing between a caller and a draft holding a stranger's KYC.
 */
router.use("/ingest", requireUser, sessionScope, requireModule("DEAL"));

// MsaFields / IngestResult are defined alongside the engine registry in
// lib/ocr-engines.ts and imported above — they are shared by all ingest sources.

// ─── DMS Pull ─────────────────────────────────────────────────────────────────

/**
 * Pull a deal from the dealer's DMS.
 *
 * This replaces a stub that took a registration number and hashed it into a
 * plausible-looking record. Both halves were wrong for this scope: an RTO will
 * not register a vehicle without live insurance, so a new vehicle has **no
 * registration number** at the moment the policy is bought — and fabricating
 * the record is the same defect as the OCR stub, output that reads as a
 * successful lookup while being invented.
 *
 * The key is the dealer's deal ID, or the chassis number of the allocated unit.
 * A chassis resolves to a deal via stock; unallocated stock has no customer, so
 * there is nothing to insure yet and that is reported rather than guessed.
 */
router.post("/ingest/dms-pull", async (req, res): Promise<void> => {
  const parsed = IngestDmsPullBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { dealId, chassisNo } = parsed.data;

  // The spec says minProperties: 1, but Orval does not carry that into the
  // generated Zod, so the gate lives here. Same pattern as the MSA validation
  // rules, which are also enforced in the route rather than by the schema.
  if (!dealId && !chassisNo) {
    res.status(400).json({
      error: "Supply either dealId or chassisNo. A new vehicle has no registration number yet.",
    });
    return;
  }

  if (!isDmsConfigured()) {
    res.status(503).json({
      error:
        "DMS is not configured. Set DMS_API_URL and DMS_API_KEY " +
        "(http://localhost:9090 and dev-dms-key for the local mock).",
    });
    return;
  }

  try {
    let resolvedDealId = dealId ?? null;

    // Chassis → deal. The chassis is the vehicle's natural key: it exists
    // before registration, it is printed on Form 21, and unlike a registration
    // number it never changes on transfer.
    if (!resolvedDealId && chassisNo) {
      const unit = await fetchStockByChassis(chassisNo);
      if (!unit) {
        res.status(404).json({ error: `No stock unit with chassis ${chassisNo}` });
        return;
      }
      if (!unit.dealId) {
        res.status(409).json({
          error:
            `Chassis ${chassisNo} is unallocated stock — no customer is attached, ` +
            `so there is no deal to insure yet.`,
        });
        return;
      }
      resolvedDealId = unit.dealId;
    }

    const deal = await fetchDeal(resolvedDealId!);
    if (!deal) {
      res.status(404).json({ error: `No deal ${resolvedDealId}` });
      return;
    }

    // Which OEM's DMS this is decides the translation. One adapter per OEM, so
    // the second brand is a new file rather than a rewrite of this route.
    const adapter = adapterForDealer(deal.dealerCode);
    const result = adapter.adaptDeal(deal);

    // Who the deal belongs to. Resolved here rather than in the adapter: an
    // adapter translates a wire format and should not touch the database, and
    // keeping the split means a second OEM inherits this for free.
    const tenant = await resolveTenantByDealerCode(deal.dealerCode);
    if (!tenant) {
      // A configuration gap, not a failure. The deal is real; the operator has
      // simply not linked this dealer code to a showroom yet. Say so and carry
      // on rather than failing the pull or inventing an owner.
      result.dealContext.gaps.push(
        `Dealer code ${deal.dealerCode} is not linked to a showroom — ` +
          `the application cannot be attributed to an owner until it is`,
      );
    }

    logger.info(
      {
        dealId: deal.dealId,
        dealerCode: deal.dealerCode,
        oem: adapter.oemCode,
        status: deal.status,
        owner: tenant?.ownerCode ?? null,
        showroom: tenant?.showroomCode ?? null,
        gaps: result.dealContext.gaps.length,
      },
      "DMS pull completed",
    );

    res.json({ ...result, tenant });
  } catch (err) {
    if (err instanceof DmsError) {
      // Configuration and auth problems are ours; unavailability is theirs.
      // Both are 502/503 rather than 500 so the caller can tell "the DMS is
      // down, retry" from "this request was wrong".
      const status = err.kind === "not_found" ? 404 : err.kind === "bad_response" ? 502 : 503;
      logger.error({ err: err.message, kind: err.kind, attempts: err.attempts }, "DMS pull failed");
      res.status(status).json({ error: err.message, kind: err.kind });
      return;
    }
    throw err;
  }
});

// ─── Browser Scrape ───────────────────────────────────────────────────────────

router.post("/ingest/browser-scrape", async (req, res): Promise<void> => {
  const parsed = IngestBrowserScrapeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { url, username, password } = parsed.data;

  // SSRF protection: reject requests to private/internal addresses (DNS-resolved)
  const urlCheck = await validateUrlSsrf(url);
  if (!urlCheck.ok) {
    res.status(400).json({ error: `Unsafe URL: ${urlCheck.reason}` });
    return;
  }

  logger.info({ url: urlCheck.href }, "Browser scrape requested");

  let rawText = "";
  const scrapedFields: Partial<MsaFields> = {};
  const confidence: Record<string, number> = {};

  try {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch(chromiumLaunchOptions());

    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();

      // Block any redirect that leads to a private/internal address
      await page.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        const check = await validateUrlSsrf(requestUrl);
        if (!check.ok) {
          logger.warn({ requestUrl, reason: check.reason }, "SSRF: blocking redirect to internal address");
          await route.abort("blockedbyclient");
        } else {
          await route.continue();
        }
      });

      await page.goto(urlCheck.href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1000);

      // Optional login if credentials provided
      if (username && password) {
        // Attempt generic login: look for common username/password selectors
        try {
          await page.fill('input[type="email"], input[name="username"], input[name="user"], input[name="email"]', username);
          await page.fill('input[type="password"]', password);
          await Promise.all([
            page.click('button[type="submit"], input[type="submit"]'),
            page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
          ]);
          await page.waitForTimeout(1000);
        } catch {
          // Login attempt failed silently — continue with scrape
        }
      }

      // Extract all visible text from the page
      // String-based evaluation avoids TypeScript DOM-lib errors in server context
      rawText = (await page.evaluate("document.body.innerText")) as string;

      // Extract form input values (vehicle / owner data commonly in forms)
      type InputEntry = { name: string; value: string; placeholder: string; label: string };
      const inputValues = (await page.evaluate(`(() => {
        var results = [];
        document.querySelectorAll("input, select, textarea").forEach(function(el) {
          var name = el.name || el.id || "";
          var value = el.value || "";
          var placeholder = el.placeholder || "";
          var label = "";
          if (el.id) {
            var lbl = document.querySelector('label[for="' + el.id + '"]');
            if (lbl) label = (lbl.textContent || "").trim();
          }
          if (name || placeholder || value) {
            results.push({ name: name, value: value, placeholder: placeholder, label: label });
          }
        });
        return results;
      })()`)) as InputEntry[];

      // Map scraped inputs to MSA fields using heuristic name/label matching
      for (const { name, value, placeholder, label } of inputValues) {
        if (!value) continue;
        const key = (name + placeholder + label).toLowerCase();
        if (/vehicle.*(make|brand)|make/i.test(key)) {
          scrapedFields.vehicleMake = value;
          confidence.vehicleMake = 0.75;
        } else if (/vehicle.*(model)|model/i.test(key)) {
          scrapedFields.vehicleModel = value;
          confidence.vehicleModel = 0.75;
        } else if (/chassis|vin/i.test(key)) {
          scrapedFields.vehicleChassisNumber = value;
          confidence.vehicleChassisNumber = 0.8;
        } else if (/engine/i.test(key)) {
          scrapedFields.vehicleEngineNumber = value;
          confidence.vehicleEngineNumber = 0.8;
        } else if (/owner|full.?name|name/i.test(key)) {
          scrapedFields.ownerFullName = value;
          confidence.ownerFullName = 0.7;
        } else if (/phone|mobile/i.test(key)) {
          scrapedFields.ownerPhoneNumber = value;
          confidence.ownerPhoneNumber = 0.7;
        } else if (/email/i.test(key)) {
          scrapedFields.ownerEmail = value;
          confidence.ownerEmail = 0.7;
        } else if (/reg.*no|registration/i.test(key)) {
          scrapedFields.rtoCode = value.slice(0, 4).toUpperCase();
          confidence.rtoCode = 0.6;
        }
      }

      await context.close();
    } finally {
      await browser.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ url, err }, "Browser scrape failed");
    res.status(400).json({ error: `Browser scrape failed: ${msg}` });
    return;
  }

  // Merge scraped fields over a blank stub — anything not scraped gets a low-confidence default
  const fields: MsaFields = {
    vehicleMake: scrapedFields.vehicleMake ?? "",
    vehicleModel: scrapedFields.vehicleModel ?? "",
    vehicleVariant: scrapedFields.vehicleVariant ?? "",
    vehicleEngineNumber: scrapedFields.vehicleEngineNumber ?? "",
    vehicleChassisNumber: scrapedFields.vehicleChassisNumber ?? "",
    vehicleExShowroomPrice: scrapedFields.vehicleExShowroomPrice ?? 0,
    vehicleDateOfPurchase: scrapedFields.vehicleDateOfPurchase ?? "",
    ownerFullName: scrapedFields.ownerFullName ?? "",
    ownerBillingAddress: scrapedFields.ownerBillingAddress ?? "",
    ownerPincode: scrapedFields.ownerPincode ?? 0,
    ownerPhoneNumber: scrapedFields.ownerPhoneNumber ?? "",
    ownerEmail: scrapedFields.ownerEmail ?? "",
    ownerDateOfBirth: scrapedFields.ownerDateOfBirth ?? "",
    ownerIdProofType: scrapedFields.ownerIdProofType ?? "AADHAR",
    ownerIdProofNumber: scrapedFields.ownerIdProofNumber ?? "",
    rtoRegistrationCity: scrapedFields.rtoRegistrationCity ?? "",
    rtoRegistrationState: scrapedFields.rtoRegistrationState ?? "",
    rtoCode: scrapedFields.rtoCode ?? "",
  };

  // Fill in defaults for any fields not seen by heuristics
  for (const k of Object.keys(fields) as (keyof MsaFields)[]) {
    if (confidence[k] === undefined) confidence[k] = 0.4;
  }

  res.json({ fields, confidence, rawText } satisfies IngestResult);
});

// ─── OCR ──────────────────────────────────────────────────────────────────────
//
// Engine definitions, the shared extraction prompt, the response parser and the
// fallback chain all live in lib/ocr-engines.ts. These routes only translate
// between HTTP and that module.

/** Read operator settings, falling back to registry defaults for missing rows. */
async function loadEngineSettings(): Promise<EngineSetting[]> {
  const rows = await db
    .select({
      engineId: ocrEnginesTable.engineId,
      priority: ocrEnginesTable.priority,
      isEnabled: ocrEnginesTable.isEnabled,
    })
    .from(ocrEnginesTable);
  return rows;
}

// ─── Engine configuration ─────────────────────────────────────────────────────

router.get("/ingest/ocr/engines", async (_req, res): Promise<void> => {
  const statuses = buildEngineStatuses(await loadEngineSettings());
  res.json(ListOcrEnginesResponse.parse(statuses));
});

router.put("/ingest/ocr/engines", async (req, res): Promise<void> => {
  const parsed = UpdateOcrEnginesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Upsert each engine's row. Priority and enabled state are operator
  // preferences only — availability still depends on the API key at run time.
  for (const engine of parsed.data.engines) {
    const values = {
      engineId: engine.engineId as OcrEngineId,
      priority: engine.priority,
      isEnabled: engine.isEnabled,
    };
    await db
      .insert(ocrEnginesTable)
      .values(values)
      .onConflictDoUpdate({
        target: ocrEnginesTable.engineId,
        set: {
          priority: values.priority,
          isEnabled: values.isEnabled,
          updatedAt: new Date(),
        },
      });
  }

  logger.info(
    { engines: parsed.data.engines.map((e) => `${e.engineId}:${e.priority}`) },
    "OCR engine configuration updated",
  );

  const statuses = buildEngineStatuses(await loadEngineSettings());
  res.json(UpdateOcrEnginesResponse.parse(statuses));
});

// ─── OCR extraction ───────────────────────────────────────────────────────────

router.post("/ingest/ocr", async (req, res): Promise<void> => {
  const parsed = IngestOcrBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { imageBase64, mimeType } = parsed.data;
  const requested = (parsed.data.model ?? "auto") as OcrEngineId | "auto";
  const allowFallback = parsed.data.allowFallback ?? true;

  const statuses = buildEngineStatuses(await loadEngineSettings());
  const chain = resolveChain(statuses, requested, allowFallback);

  logger.info(
    { requested, allowFallback, chain, mimeType },
    "OCR requested",
  );

  try {
    const { result } = await runOcrChain(chain, imageBase64, mimeType);
    res.json(result satisfies IngestResult);
  } catch (err) {
    if (err instanceof OcrChainError) {
      // 502: every upstream engine failed. The attempt list tells the UI which
      // ones were tried and why each one failed.
      res.status(502).json({ error: err.message, attempts: err.attempts });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ─── Push to InsurRouter ──────────────────────────────────────────────────────
//
// The draft creation itself lives in lib/draft-application.ts, because DDMS
// starts applications from a worklist row too and a forty-column insert written
// twice is one that drifts. This route now only translates HTTP to that call.

router.post("/ingest/push", async (req, res): Promise<void> => {
  const parsed = IngestPushBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { fields } = parsed.data;

  // A DMS pull hands back `tenant` and `dealContext`; the caller passes both
  // straight through. OCR and scrape send neither, and the engine-capacity
  // columns stay null, which is the honest answer — a scanned Aadhaar cannot
  // say what the cubic capacity is.
  const ctx = (parsed.data.dealContext ?? null) as DmsDealContext | null;
  const doc = parsed.data.document;

  // The showroom is the one thing that can no longer stay null. It used to,
  // and the row was then invisible to every session including the one that
  // created it. A pulled deal names its outlet through the dealer code; a
  // photographed document cannot, so the person holding the phone does.
  const tenant = parsed.data.tenant ?? null;
  let owningShowroomId = tenant?.showroomId ?? null;
  if (owningShowroomId === null) {
    const owning = await resolveOwningShowroom(req, res, parsed.data.showroomId);
    if (!owning.ok) return;
    if (owning.showroomId === null) {
      res.status(400).json({
        error:
          "Which outlet is this document for? You hold more than one, and a " +
          "draft that names none belongs to none.",
      });
      return;
    }
    owningShowroomId = owning.showroomId;
  }

  logger.info(
    {
      vehicleMake: fields.vehicleMake,
      ownerFullName: fields.ownerFullName,
      showroom: tenant?.showroomCode ?? null,
      dealId: ctx?.dealId ?? null,
    },
    "Ingest push to InsurRouter",
  );

  const result = await createDraftApplication({
    fields: fields as unknown as MsaFields,
    tenant: { showroomId: owningShowroomId },
    ctx,
    document: doc ? (doc as unknown as Record<string, unknown>) : null,
    sourceDesc: doc
      ? `Draft created via VeloDocs ingest from ${doc.documentType} (${doc.fields.length} fields read): ${fields.vehicleMake} ${fields.vehicleModel} (${fields.ownerFullName})`
      : `Draft created via VeloDocs ingest: ${fields.vehicleMake} ${fields.vehicleModel} (${fields.ownerFullName})`,
  });

  if (result.kind === "duplicate") {
    res.status(409).json({
      error:
        `Deal ${ctx?.dealId} already has application #${result.applicationId}` +
        (result.status ? ` (${result.status}).` : "."),
      applicationId: result.applicationId,
      status: result.status ?? undefined,
    });
    return;
  }

  if (result.kind === "invalid") {
    res.status(400).json({ errors: result.errors, invalidFields: result.invalidFields });
    return;
  }

  res.status(201).json({ applicationId: result.applicationId });
});

export default router;
