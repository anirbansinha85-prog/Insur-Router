/**
 * VeloDocs — Document Ingestion Routes
 *
 * Three ingest sources → normalised MsaFields + confidence scores:
 *   POST /api/ingest/dms-pull       — Dealer DMS stub (reg-no lookup)
 *   POST /api/ingest/browser-scrape — Playwright scrape of dealer portal
 *   POST /api/ingest/ocr            — OCR model switcher (stub / TODO real models)
 *   POST /api/ingest/push           — Push reviewed payload to InsurRouter as draft
 */

import { Router, type IRouter } from "express";
import { URL } from "url";
import dns from "dns/promises";
import net from "net";
import {
  IngestDmsPullBody,
  IngestBrowserScrapeBody,
  IngestOcrBody,
  IngestPushBody,
} from "@workspace/api-zod";
import { db, applicationsTable, submissionLogsTable } from "@workspace/db";
import { logger } from "../lib/logger";

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

// ─── Shared types ────────────────────────────────────────────────────────────

interface MsaFields {
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
  ownerIdProofType: "AADHAR" | "PAN" | "PASSPORT" | "DRIVING_LICENSE" | "VOTER_ID";
  ownerIdProofNumber: string;
  rtoRegistrationCity: string;
  rtoRegistrationState: string;
  rtoCode: string;
}

interface IngestResult {
  fields: MsaFields;
  confidence: Record<string, number>;
  rawText?: string | null;
}

// ─── DMS Pull ─────────────────────────────────────────────────────────────────

/**
 * Stub Dealer DMS lookup.
 *
 * // TODO: Connect real Dealer DMS API here
 * Replace the stub below with a real DMS HTTP call, e.g.:
 *   const resp = await fetch(`${process.env.DMS_API_URL}/vehicle/${regNo}`, {
 *     headers: { Authorization: `Bearer ${process.env.DMS_API_TOKEN}` }
 *   });
 *   const data = await resp.json();
 *   return mapDmsResponseToMsaFields(data);
 */
function callDealerDMS(regNo: string): IngestResult {
  // // TODO: Connect real Dealer DMS API here — replace this stub with a real
  // integration once the DMS vendor API credentials are available.
  // The stub generates a plausible-looking record from the reg number.
  const seed = regNo.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const makes = ["Yamaha", "Honda", "TVS", "Bajaj", "Royal Enfield", "Hero"];
  const models: Record<string, string[]> = {
    Yamaha: ["FZ-S", "R15", "MT-15", "FZ25"],
    Honda: ["CB350", "Hornet 2.0", "CB300R", "Unicorn"],
    TVS: ["Apache RTR 160", "Apache RR 310", "Ntorq 125"],
    Bajaj: ["Pulsar NS200", "Dominar 400", "Pulsar 150"],
    "Royal Enfield": ["Classic 350", "Meteor 350", "Hunter 350", "Himalayan"],
    Hero: ["Splendor Plus", "HF Deluxe", "Xpulse 200"],
  };
  const makeIdx = seed.charCodeAt(0) % makes.length;
  const make = makes[makeIdx];
  const modelList = models[make];
  const model = modelList[seed.charCodeAt(1) % modelList.length];

  const priceBase = 85000 + (seed.charCodeAt(2) % 10) * 15000;
  const purchaseYear = 2021 + (seed.charCodeAt(3) % 4);

  const rtoCodes = ["DL01", "DL02", "MH02", "MH12", "KA01", "TN09", "GJ01"];
  const rtoCities = ["New Delhi", "New Delhi", "Mumbai", "Pune", "Bengaluru", "Chennai", "Ahmedabad"];
  const rtoStates = ["Delhi", "Delhi", "Maharashtra", "Maharashtra", "Karnataka", "Tamil Nadu", "Gujarat"];
  const rtoIdx = seed.charCodeAt(4) % rtoCodes.length;

  const fields: MsaFields = {
    vehicleMake: make,
    vehicleModel: model,
    vehicleVariant: "Standard",
    vehicleEngineNumber: `ENG${seed.slice(0, 6).padEnd(6, "0")}`,
    vehicleChassisNumber: `CHS${seed.padEnd(9, "0").slice(0, 9)}`,
    vehicleExShowroomPrice: priceBase,
    vehicleDateOfPurchase: `${purchaseYear}-03-15`,
    ownerFullName: "Rajesh Kumar Sharma",
    ownerBillingAddress: "42, MG Road, Sector 14",
    ownerPincode: 110001,
    ownerPhoneNumber: "9876543210",
    ownerEmail: "rajesh.sharma@example.in",
    ownerDateOfBirth: "1985-06-20",
    ownerIdProofType: "AADHAR",
    ownerIdProofNumber: "1234-5678-9012",
    rtoRegistrationCity: rtoCities[rtoIdx],
    rtoRegistrationState: rtoStates[rtoIdx],
    rtoCode: rtoCodes[rtoIdx],
  };

  // All DMS fields have high confidence since they come directly from the DB
  const confidence: Record<string, number> = {};
  for (const k of Object.keys(fields)) confidence[k] = 0.95;

  return { fields, confidence, rawText: null };
}

router.post("/ingest/dms-pull", async (req, res): Promise<void> => {
  const parsed = IngestDmsPullBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  logger.info({ regNo: parsed.data.regNo }, "DMS pull requested");
  const result = callDealerDMS(parsed.data.regNo);
  res.json(result);
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

    const browser = await chromium.launch({
      headless: true,
      executablePath:
        "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

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

/**
 * OCR model switcher.
 *
 * Only the "stub" branch returns real data. All other branches are clearly
 * marked TODO for connecting to real OCR services.
 */
async function runOcr(
  imageBase64: string,
  mimeType: string,
  model: "paddleocr" | "qwen-vl" | "olmocr" | "stub",
): Promise<IngestResult> {
  switch (model) {
    case "stub":
      return ocrStub(imageBase64, mimeType);

    case "paddleocr":
      // TODO: Connect PaddleOCR here
      // PaddleOCR can be run as a local service or via paddle-serving.
      // Typical integration:
      //   const resp = await fetch(`${process.env.PADDLEOCR_API_URL}/predict/ocr_system`, {
      //     method: "POST",
      //     headers: { "Content-Type": "application/json" },
      //     body: JSON.stringify({ images: [imageBase64] }),
      //   });
      //   const data = await resp.json();
      //   const rawText = data.results.flatMap((r: any) => r.map((item: any) => item[1][0])).join("\n");
      //   return parseRawTextToMsaFields(rawText, "paddleocr");
      throw new Error("PaddleOCR not yet connected — use model=stub for demo");

    case "qwen-vl":
      // TODO: Connect Qwen2.5-VL here
      // Qwen2.5-VL can parse RC-book images via its vision-language API.
      // Typical integration (Alibaba Cloud DashScope):
      //   const resp = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
      //     method: "POST",
      //     headers: {
      //       Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      //       "Content-Type": "application/json",
      //     },
      //     body: JSON.stringify({
      //       model: "qwen-vl-plus",
      //       input: { messages: [{ role: "user", content: [
      //         { image: `data:${mimeType};base64,${imageBase64}` },
      //         { text: "Extract vehicle registration details as JSON: make, model, chassisNumber, engineNumber, ownerName, address, rtoCode" }
      //       ]}]},
      //     }),
      //   });
      //   const data = await resp.json();
      //   return parseQwenResponseToMsaFields(data.output.choices[0].message.content[0].text);
      throw new Error("Qwen2.5-VL not yet connected — use model=stub for demo");

    case "olmocr":
      // TODO: Connect olmOCR here
      // olmOCR (Allen Institute) provides structured document extraction.
      // Typical integration:
      //   import { OlmOCR } from "olmocr";
      //   const client = new OlmOCR({ apiKey: process.env.OLMOCR_API_KEY });
      //   const result = await client.extract({ image: imageBase64, mimeType, schema: MSA_JSON_SCHEMA });
      //   return mapOlmOcrToMsaFields(result);
      throw new Error("olmOCR not yet connected — use model=stub for demo");

    default:
      throw new Error(`Unknown OCR model: ${model}`);
  }
}

/**
 * Stub OCR — returns a realistic hardcoded RC-book extraction.
 * Represents a Yamaha FZ-S registered in Delhi (DL01 RTO).
 */
function ocrStub(_imageBase64: string, _mimeType: string): IngestResult {
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
    vehicleExShowroomPrice: 0.60,   // OCR on price is often inaccurate
    vehicleDateOfPurchase: 0.85,
    ownerFullName: 0.93,
    ownerBillingAddress: 0.78,
    ownerPincode: 0.82,
    ownerPhoneNumber: 0.55,         // phone often partially visible
    ownerEmail: 0.45,               // email rarely on RC book — low confidence
    ownerDateOfBirth: 0.80,
    ownerIdProofType: 0.90,
    ownerIdProofNumber: 0.65,
    rtoRegistrationCity: 0.92,
    rtoRegistrationState: 0.94,
    rtoCode: 0.96,
  };

  const rawText = `REGISTRATION CERTIFICATE\nReg No: DL01AB5678\nOwner: PRIYA MEHRA\nAddress: B-74, LAJPAT NAGAR, NEW DELHI - 110024\nVehicle Class: M-Cycle/Scooter\nMaker: YAMAHA MOTOR INDIA\nModel: FZ-S V3.0 Fi\nChasis No: ME1RG8219M0012345\nEngine No: E5C3E0123456\nDate of Registration: 10/11/2022\nFuel: PETROL\nRTO: DL-01, KAMLA NAGAR, NEW DELHI`;

  return { fields, confidence, rawText };
}

router.post("/ingest/ocr", async (req, res): Promise<void> => {
  const parsed = IngestOcrBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { imageBase64, mimeType, model } = parsed.data;
  logger.info({ model, mimeType }, "OCR requested");

  try {
    const result = await runOcr(imageBase64, mimeType, model as "paddleocr" | "qwen-vl" | "olmocr" | "stub");
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ─── Push to InsurRouter ──────────────────────────────────────────────────────

/** Convert a Date or ISO string to YYYY-MM-DD for Drizzle date columns (mode:"string") */
function toDateStr(val: Date | string): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

router.post("/ingest/push", async (req, res): Promise<void> => {
  const parsed = IngestPushBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { fields } = parsed.data;
  logger.info({ vehicleMake: fields.vehicleMake, ownerFullName: fields.ownerFullName }, "Ingest push to InsurRouter");

  // Zod coerces date-formatted strings to Date objects; Drizzle date columns use mode:"string"
  const dateOfPurchase = toDateStr(fields.vehicleDateOfPurchase as unknown as Date | string);
  const dateOfBirth = toDateStr(fields.ownerDateOfBirth as unknown as Date | string);

  // Insert directly into the shared database — same table that InsurRouter reads
  // executionMode omitted — schema default "AUTO" applies
  const [app] = await db
    .insert(applicationsTable)
    .values({
      vehicleMake: fields.vehicleMake,
      vehicleModel: fields.vehicleModel,
      vehicleVariant: fields.vehicleVariant,
      vehicleEngineNumber: fields.vehicleEngineNumber,
      vehicleChassisNumber: fields.vehicleChassisNumber,
      vehicleExShowroomPrice: fields.vehicleExShowroomPrice,
      vehicleDateOfPurchase: dateOfPurchase,
      ownerFullName: fields.ownerFullName,
      ownerBillingAddress: fields.ownerBillingAddress,
      ownerPincode: fields.ownerPincode,
      ownerPhoneNumber: String(fields.ownerPhoneNumber),
      ownerEmail: fields.ownerEmail,
      ownerDateOfBirth: dateOfBirth,
      ownerIdProofType: fields.ownerIdProofType,
      ownerIdProofNumber: fields.ownerIdProofNumber,
      rtoRegistrationCity: fields.rtoRegistrationCity,
      rtoRegistrationState: fields.rtoRegistrationState,
      rtoCode: fields.rtoCode,
    })
    .returning();

  await db.insert(submissionLogsTable).values({
    applicationId: app.id,
    step: "data_ingestion",
    status: "success",
    message: `Draft created via VeloDocs ingest: ${fields.vehicleMake} ${fields.vehicleModel} (${fields.ownerFullName})`,
  });

  res.status(201).json({ applicationId: app.id });
});

export default router;
