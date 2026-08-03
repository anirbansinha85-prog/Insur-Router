/**
 * Mock OEM Dealer Management System.
 *
 * Stands in for the dealer-side system InsurRouter pulls from, so the whole
 * pipeline can be built and tested before anyone has OEM API access. It is a
 * development fixture: state lives in memory and resets on restart, and it must
 * never be deployed anywhere reachable.
 *
 * Two behaviours exist purely to make the *client* honest, and both are off by
 * default:
 *   DMS_MOCK_LATENCY_MS   adds a delay, so nobody assumes a DMS is fast
 *   DMS_MOCK_FAIL_RATE    fails a fraction of calls with 503, so the adapter has
 *                         to handle a DMS being down rather than only the happy
 *                         path
 * A real OEM system is a shared ERP under load; pretending otherwise builds a
 * client that falls over the first time it meets one.
 *
 * Run:
 *   $env:DMS_PORT=9090; pnpm --filter @workspace/dms-mock run start
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { DEALERS, DEALS, FREE_STOCK } from "./deals.ts";
import { MODELS } from "./catalogue.ts";
import { buildServiceSchedule, formatDmsDate } from "./service-schedule.ts";
import portal from "./portal/routes.ts";
import {
  dealIdsModifiedSince,
  getEnquiry,
  getJobCard,
  listEmployees,
  listEnquiries,
  listJobCards,
  openStore,
  parseDmsTimestamp,
  saveDeal,
} from "./store.ts";
import type { DmsDealStatus } from "./types.ts";

const PORT = Number(process.env.DMS_PORT ?? 9090);
const API_KEY = process.env.DMS_API_KEY ?? "dev-dms-key";
const LATENCY_MS = Number(process.env.DMS_MOCK_LATENCY_MS ?? 0);
const FAIL_RATE = Number(process.env.DMS_MOCK_FAIL_RATE ?? 0);

// Open (and seed, first time) before any route can read. Everything below still
// reads the in-memory DEALS array; the store keeps it durable rather than
// replacing it.
openStore({ reset: process.env.DMS_RESET === "1" });

const app = express();
app.use(express.json({ limit: "256kb" }));

/** Health is deliberately unauthenticated — it is a liveness probe, not data. */
app.get("/dms/v1/health", (_req, res) => {
  res.json({ status: "ok", service: "dms-mock", oem: "HERO", deals: DEALS.length });
});

/**
 * The dealer portal.
 *
 * Mounted ahead of the API so `/` lands on the dashboard rather than a JSON dump.
 * The portal reads and writes the same in-memory records the API serves, which is
 * the point: driving the demo through the UI changes what the API returns, so the
 * two can never tell different stories.
 */
app.use(portal);
app.get("/", (_req, res) => res.redirect("/portal"));

/**
 * Shared-secret auth, which is what these systems actually use — a static key
 * per integration, rotated by email. Not a model to copy, just one to expect.
 *
 * `?apiKey=` is accepted as well as the header, purely so the mock can be poked
 * from a browser address bar — a browser cannot set a custom header on a plain
 * navigation. Never do this in real code: query strings land in access logs,
 * browser history and `Referer` headers. It is tolerable here only because the
 * key is a published default guarding invented data on localhost. The adapter
 * must use the header.
 */
app.use("/dms/v1", (req: Request, res: Response, next: NextFunction) => {
  const supplied = req.header("x-dms-api-key") ?? (req.query.apiKey as string | undefined);
  if (supplied !== API_KEY) {
    res.status(401).json({
      errCode: "AUTH_FAILED",
      errDesc: "Invalid or missing X-DMS-API-Key (or ?apiKey= when browsing)",
    });
    return;
  }
  next();
});

app.use("/dms/v1", async (_req: Request, res: Response, next: NextFunction) => {
  if (LATENCY_MS > 0) await new Promise((r) => setTimeout(r, LATENCY_MS));
  if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
    res.status(503).json({ errCode: "SYS_BUSY", errDesc: "Host system unavailable, retry later" });
    return;
  }
  next();
});

app.get("/dms/v1/dealers/:dealerCode", (req, res) => {
  const dealer = DEALERS[req.params.dealerCode];
  if (!dealer) {
    res.status(404).json({ errCode: "DEALER_NOT_FOUND", errDesc: req.params.dealerCode });
    return;
  }
  res.json(dealer);
});

app.get("/dms/v1/models", (_req, res) => {
  res.json({ models: Object.values(MODELS) });
});

/**
 * Deal list. `status=AWAITING_INSURANCE` is the work queue this product exists
 * to drain — every deal sitting here is a vehicle that cannot be registered
 * until a policy is issued.
 *
 * Returns a summary shape, not full deals: the list feeds a worklist screen, and
 * shipping complete customer records for rows nobody opens is needless PII
 * exposure. Callers fetch the full record by id when they act on one.
 */
app.get("/dms/v1/deals", (req, res) => {
  const { dealerCode, status, modifiedSince } = req.query as {
    dealerCode?: string;
    status?: DmsDealStatus;
    modifiedSince?: string;
  };

  // Incremental pull. Without it a mirror has to fetch everything every time,
  // which is what makes a sync expensive enough that people turn it off.
  let touched: Set<string> | null = null;
  if (modifiedSince) {
    const since = parseDmsTimestamp(modifiedSince);
    if (!since) {
      res.status(400).json({
        errCode: "VALIDATION",
        errDesc: "modifiedSince must be DD-MM-YYYY or DD-MM-YYYY HH:mm:ss",
      });
      return;
    }
    touched = dealIdsModifiedSince(since);
  }

  const matches = DEALS.filter(
    (d) =>
      (!dealerCode || d.dealerCode === dealerCode) &&
      (!status || d.status === status) &&
      (!touched || touched.has(d.dealId)),
  );

  res.json({
    count: matches.length,
    deals: matches.map((d) => ({
      dealId: d.dealId,
      dealerCode: d.dealerCode,
      status: d.status,
      bookingDt: d.bookingDt,
      custName: [d.customer.salutation, d.customer.firstName, d.customer.midName, d.customer.lastName]
        .filter(Boolean)
        .join(" "),
      modelDesc: d.vehicle.model.modelDesc,
      chassisNo: d.vehicle.chassisNo,
      policyNo: d.insurance.policyNo,
      regNo: d.registration.regNo,
    })),
  });
});

app.get("/dms/v1/deals/:dealId", (req, res) => {
  const deal = DEALS.find((d) => d.dealId === req.params.dealId);
  if (!deal) {
    res.status(404).json({ errCode: "DEAL_NOT_FOUND", errDesc: req.params.dealId });
    return;
  }
  res.json(deal);
});

/**
 * Chassis lookup — the natural key for a new vehicle, standing in for the
 * registration number that does not exist yet.
 *
 * Searches allocated units as well as free stock, because the caller usually has
 * a chassis number off an invoice and does not know whether it has been sold.
 */
app.get("/dms/v1/stock/:chassisNo", (req, res) => {
  const chassisNo = req.params.chassisNo.toUpperCase();

  const free = FREE_STOCK.find((s) => s.chassisNo === chassisNo);
  if (free) {
    res.json({ ...free, model: MODELS[free.modelCode], dealId: null });
    return;
  }

  const deal = DEALS.find((d) => d.vehicle.chassisNo === chassisNo);
  if (deal) {
    res.json({ ...deal.vehicle, dealId: deal.dealId });
    return;
  }

  res.status(404).json({ errCode: "CHASSIS_NOT_FOUND", errDesc: chassisNo });
});

app.get("/dms/v1/deals/:dealId/service-schedule", (req, res) => {
  const deal = DEALS.find((d) => d.dealId === req.params.dealId);
  if (!deal) {
    res.status(404).json({ errCode: "DEAL_NOT_FOUND", errDesc: req.params.dealId });
    return;
  }
  res.json(buildServiceSchedule(deal));
});

/**
 * Job card list — the workshop's equivalent of the deal queue.
 *
 * `status=AWAITING_PARTS` and `status=AWAITING_APPROVAL` are the two queues
 * worth draining: in both the vehicle is stationary because somebody has not
 * made a phone call. Summary shape for the same reason the deal list is —
 * complaint text and part lines are not needed to decide which row to open.
 */
app.get("/dms/v1/jobcards", (req, res) => {
  const { dealerCode, status, modifiedSince, awaitingParts } = req.query as Record<string, string | undefined>;

  let since: Date | undefined;
  if (modifiedSince) {
    const parsed = parseDmsTimestamp(modifiedSince);
    if (!parsed) {
      res.status(400).json({
        errCode: "VALIDATION",
        errDesc: "modifiedSince must be DD-MM-YYYY or DD-MM-YYYY HH:mm:ss",
      });
      return;
    }
    since = parsed;
  }

  const cards = listJobCards({
    dealerCode,
    status,
    modifiedSince: since,
    awaitingPartsOnly: awaitingParts === "Y",
  });

  res.json({
    count: cards.length,
    jobCards: cards.map((j) => ({
      jcNo: j.jcNo,
      jcDt: j.jcDt,
      dealerCode: j.dealerCode,
      status: j.status,
      jcType: j.jcType,
      regNo: j.regNo,
      chassisNo: j.chassisNo,
      custName: j.custName,
      modelDesc: j.modelDesc,
      advisorEmpCode: j.advisorEmpCode,
      promisedDt: j.promisedDt,
      actualCloseDt: j.actualCloseDt,
      estimateAmt: j.estimateAmt,
      finalAmt: j.finalAmt,
      modifiedAt: j.modifiedAt,
    })),
  });
});

app.get("/dms/v1/jobcards/:jcNo", (req, res) => {
  const jc = getJobCard(req.params.jcNo);
  if (!jc) {
    res.status(404).json({ errCode: "JOBCARD_NOT_FOUND", errDesc: req.params.jcNo });
    return;
  }
  res.json(jc);
});

/**
 * Enquiry list.
 *
 * `source=OEM_PORTAL` is the queue with a contract behind it: the manufacturer
 * generates the lead, pushes it down, and measures how long the dealer took to
 * respond. `firstContactAt` is therefore the field that matters most, and null
 * is its most important value.
 */
app.get("/dms/v1/enquiries", (req, res) => {
  const { dealerCode, stage, source, modifiedSince, uncontacted } = req.query as Record<string, string | undefined>;

  let since: Date | undefined;
  if (modifiedSince) {
    const parsed = parseDmsTimestamp(modifiedSince);
    if (!parsed) {
      res.status(400).json({
        errCode: "VALIDATION",
        errDesc: "modifiedSince must be DD-MM-YYYY or DD-MM-YYYY HH:mm:ss",
      });
      return;
    }
    since = parsed;
  }

  const enquiries = listEnquiries({
    dealerCode,
    stage,
    source,
    modifiedSince: since,
    uncontactedOnly: uncontacted === "Y",
  });

  res.json({
    count: enquiries.length,
    enquiries: enquiries.map((e) => ({
      enqId: e.enqId,
      dealerCode: e.dealerCode,
      enqDt: e.enqDt,
      source: e.source,
      grade: e.grade,
      stage: e.stage,
      custName: e.custName,
      mobileNo: e.mobileNo,
      modelCodeInterest: e.modelCodeInterest,
      assignedEmpCode: e.assignedEmpCode,
      firstContactAt: e.firstContactAt,
      lastContactDt: e.lastContactDt,
      nextFollowUpDt: e.nextFollowUpDt,
      convertedDealId: e.convertedDealId,
      modifiedAt: e.modifiedAt,
    })),
  });
});

app.get("/dms/v1/enquiries/:enqId", (req, res) => {
  const enquiry = getEnquiry(req.params.enqId);
  if (!enquiry) {
    res.status(404).json({ errCode: "ENQUIRY_NOT_FOUND", errDesc: req.params.enqId });
    return;
  }
  res.json(enquiry);
});

/**
 * Staff master.
 *
 * Included because `dol` — date of leaving — is what turns "we are short
 * staffed" from an anecdote into a number, and because a job card owned by a
 * departed advisor is work with nobody's name against it.
 */
app.get("/dms/v1/employees", (req, res) => {
  const { dealerCode, activeFlg } = req.query as Record<string, string | undefined>;
  const employees = listEmployees(dealerCode, activeFlg === "Y");
  res.json({ count: employees.length, employees });
});

/**
 * Write the issued policy back onto the deal.
 *
 * The DMS is the dealer's record of the transaction, so the policy has to land
 * here or the dealership has no idea the vehicle is insured. This also unblocks
 * the registration file: status moves to AWAITING_REGISTRATION.
 */
app.patch("/dms/v1/deals/:dealId/insurance", (req, res) => {
  const deal = DEALS.find((d) => d.dealId === req.params.dealId);
  if (!deal) {
    res.status(404).json({ errCode: "DEAL_NOT_FOUND", errDesc: req.params.dealId });
    return;
  }

  const body = req.body as Record<string, string | undefined>;
  if (!body.policyNo || !body.insurerCode) {
    res.status(400).json({ errCode: "VALIDATION", errDesc: "policyNo and insurerCode are required" });
    return;
  }

  // Whitelisted so a caller cannot overwrite unrelated blocks by posting extra
  // keys — an in-memory mock is still a place to not learn bad habits.
  const allowed = [
    "insurerCode",
    "policyNo",
    "odStartDt",
    "odEndDt",
    "tpStartDt",
    "tpEndDt",
    "odPremiumAmt",
    "tpPremiumAmt",
    "paPremiumAmt",
    "totalPremiumAmt",
    "idvAmt",
  ] as const;

  for (const key of allowed) {
    if (body[key] !== undefined) deal.insurance[key] = body[key] as never;
  }

  if (deal.status === "AWAITING_INSURANCE") deal.status = "AWAITING_REGISTRATION";

  saveDeal(deal);
  res.json({ dealId: deal.dealId, status: deal.status, insurance: deal.insurance });
});

/**
 * Write the registration number back, weeks later.
 *
 * Endorsing this onto the existing policy is a separate transaction with the
 * insurer — recording it here does not tell the insurer anything.
 */
app.patch("/dms/v1/deals/:dealId/registration", (req, res) => {
  const deal = DEALS.find((d) => d.dealId === req.params.dealId);
  if (!deal) {
    res.status(404).json({ errCode: "DEAL_NOT_FOUND", errDesc: req.params.dealId });
    return;
  }

  const { regNo, regDt, rtoCode } = req.body as Record<string, string | undefined>;
  if (!regNo) {
    res.status(400).json({ errCode: "VALIDATION", errDesc: "regNo is required" });
    return;
  }

  deal.registration.regNo = regNo.toUpperCase();
  deal.registration.regDt = regDt ?? formatDmsDate(new Date());
  // Derivable from the reg number itself, so accept it or infer it.
  deal.registration.rtoCode = rtoCode ?? regNo.toUpperCase().slice(0, 4);
  if (deal.status === "AWAITING_REGISTRATION") deal.status = "DELIVERED";

  saveDeal(deal);
  res.json({ dealId: deal.dealId, status: deal.status, registration: deal.registration });
});

app.use((req, res) => {
  res.status(404).json({ errCode: "NO_ROUTE", errDesc: `${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`[dms-mock] listening on http://localhost:${PORT}`);
  console.log(`[dms-mock] api key: ${API_KEY}${process.env.DMS_API_KEY ? "" : "  (default — set DMS_API_KEY to change)"}`);
  if (LATENCY_MS) console.log(`[dms-mock] simulating ${LATENCY_MS}ms latency`);
  if (FAIL_RATE) console.log(`[dms-mock] simulating ${(FAIL_RATE * 100).toFixed(0)}% failure rate`);
});
