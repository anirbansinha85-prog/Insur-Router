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
import type { DmsDealStatus } from "./types.ts";

const PORT = Number(process.env.DMS_PORT ?? 9090);
const API_KEY = process.env.DMS_API_KEY ?? "dev-dms-key";
const LATENCY_MS = Number(process.env.DMS_MOCK_LATENCY_MS ?? 0);
const FAIL_RATE = Number(process.env.DMS_MOCK_FAIL_RATE ?? 0);

const app = express();
app.use(express.json({ limit: "256kb" }));

/** Health is deliberately unauthenticated — it is a liveness probe, not data. */
app.get("/dms/v1/health", (_req, res) => {
  res.json({ status: "ok", service: "dms-mock", oem: "HERO", deals: DEALS.length });
});

/**
 * A browsable index at `/`.
 *
 * Exists only so the mock can be inspected by eye instead of by curl — raw JSON
 * in a browser is unreadable, and the point of the seed data is that each record
 * is broken in a *different* way. Surfacing those gaps in a table makes them
 * obvious; a JSON dump hides them.
 *
 * This is not part of the DMS contract and nothing should consume it. A real DMS
 * has a full dealer UI that is none of our business.
 */
app.get("/", (_req, res) => {
  const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

  /** What is missing on this deal that a policy cannot be issued without. */
  const gapsFor = (d: (typeof DEALS)[number]) => {
    const gaps: string[] = [];
    if (!d.nominee.nomineeName && d.customer.custType === "INDIVIDUAL") gaps.push("nominee");
    if (!d.customer.emailId) gaps.push("email");
    if (!d.customer.dob && d.customer.custType === "INDIVIDUAL") gaps.push("date of birth");
    return gaps;
  };

  const ratingBasis = (d: (typeof DEALS)[number]) =>
    d.vehicle.model.fuel === "ELECTRIC"
      ? `${d.vehicle.model.motorKw} kW`
      : `${d.vehicle.model.cc} cc`;

  const rows = DEALS.map((d) => {
    const gaps = gapsFor(d);
    return `<tr>
      <td><a href="/dms/v1/deals/${esc(d.dealId)}?apiKey=${esc(API_KEY)}"><code>${esc(d.dealId)}</code></a></td>
      <td><span class="st st-${esc(d.status)}">${esc(d.status.replace(/_/g, " "))}</span></td>
      <td>${esc(d.customer.salutation)} ${esc(d.customer.firstName)} ${esc(d.customer.lastName)}
          ${d.customer.custType === "CORPORATE" ? '<span class="tag">corporate</span>' : ""}</td>
      <td>${esc(d.vehicle.model.modelDesc)}<br><small>${esc(ratingBasis(d))}${
        d.vehicle.model.fuel === "ELECTRIC" ? ' <span class="tag tag-ev">EV</span>' : ""
      }</small></td>
      <td><code>${esc(d.vehicle.chassisNo)}</code></td>
      <td>${d.finance.financedFlg === "Y" ? esc(d.finance.financierName) : "<small>cash</small>"}</td>
      <td>${
        gaps.length
          ? gaps.map((g) => `<span class="gap">${esc(g)}</span>`).join(" ")
          : '<span class="ok">complete</span>'
      }</td>
      <td>${
        d.registration.regNo
          ? `<code>${esc(d.registration.regNo)}</code>`
          : '<small class="none">not registered yet</small>'
      }</td>
      <td>${
        d.actualDeliveryDt
          ? `<a href="/dms/v1/deals/${esc(d.dealId)}/service-schedule?apiKey=${esc(API_KEY)}">schedule</a>`
          : "<small>—</small>"
      }</td>
    </tr>`;
  }).join("");

  const dealerRows = Object.values(DEALERS)
    .map(
      (dl) => `<tr>
        <td><a href="/dms/v1/dealers/${esc(dl.dealerCode)}?apiKey=${esc(API_KEY)}"><code>${esc(dl.dealerCode)}</code></a></td>
        <td>${esc(dl.dealerName)}</td>
        <td>${esc(dl.addr.cityDesc)}, ${esc(dl.addr.stateDesc)}</td>
        <td><span class="st st-${esc(dl.intermediary.channel)}">${esc(dl.intermediary.channel.replace(/_/g, " "))}</span></td>
        <td>${esc(dl.intermediary.intermediaryName)}<br><small><code>${esc(dl.intermediary.intermediaryCode)}</code></small></td>
      </tr>`,
    )
    .join("");

  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock OEM DMS — Hero</title>
<style>
  :root { color-scheme: light dark; --bd:#d0d7de; --mut:#57606a; --bg2:#f6f8fa; --acc:#0969da; }
  @media (prefers-color-scheme: dark) {
    :root { --bd:#30363d; --mut:#8b949e; --bg2:#161b22; --acc:#4493f8; }
  }
  body { font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:2rem 1.25rem 4rem; max-width:1180px; }
  h1 { font-size:1.35rem; margin:0 0 .2rem; }
  h2 { font-size:1rem; margin:2.25rem 0 .6rem; }
  .sub { color:var(--mut); margin:0 0 1.5rem; }
  .warn { border:1px solid var(--bd); border-left:3px solid #bf8700; background:var(--bg2);
          padding:.7rem .9rem; border-radius:6px; margin:0 0 1.5rem; }
  .scroll { overflow-x:auto; border:1px solid var(--bd); border-radius:6px; }
  table { border-collapse:collapse; width:100%; min-width:900px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
       color:var(--mut); padding:.55rem .7rem; background:var(--bg2); border-bottom:1px solid var(--bd);
       white-space:nowrap; }
  td { padding:.55rem .7rem; border-bottom:1px solid var(--bd); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  small { color:var(--mut); font-size:12px; }
  a { color:var(--acc); }
  .st { font-size:11px; padding:.15rem .45rem; border-radius:10px; border:1px solid var(--bd);
        white-space:nowrap; display:inline-block; }
  .st-AWAITING_INSURANCE { border-color:#bf8700; color:#9a6700; }
  .st-DELIVERED { border-color:#1a7f37; color:#1a7f37; }
  .st-BROKER { border-color:#0969da; color:var(--acc); }
  .st-DIRECT_AGENT { border-color:#8250df; color:#8250df; }
  .gap { font-size:11px; padding:.15rem .45rem; border-radius:4px; background:#ffebe9;
         color:#a40e26; border:1px solid #ff818266; display:inline-block; }
  @media (prefers-color-scheme: dark) { .gap { background:#3c1618; color:#ff9b96; } }
  .ok { font-size:11px; color:#1a7f37; }
  .none { font-style:italic; }
  .tag { font-size:10px; padding:.1rem .35rem; border:1px solid var(--bd); border-radius:3px; color:var(--mut); }
  .tag-ev { border-color:#1a7f37; color:#1a7f37; }
  ul { padding-left:1.2rem; }
</style></head><body>

<h1>Mock OEM DMS &mdash; Hero</h1>
<p class="sub">Development fixture standing in for a dealer management system.
State is in memory and resets on restart.</p>

<div class="warn"><strong>This is not InsurRouter.</strong> It is the fake
<em>dealer-side</em> system InsurRouter will pull from. Every record is invented.
The adapter that consumes this is not written yet, so nothing here flows into the
app.</div>

<h2>Deals</h2>
<p class="sub">Each row is broken differently on purpose &mdash; a seed set where
everything is complete teaches nothing. The <strong>gaps</strong> column is what
blocks issuance.</p>
<div class="scroll"><table>
<thead><tr>
  <th>Deal</th><th>Status</th><th>Customer</th><th>Vehicle</th><th>Chassis</th>
  <th>Finance</th><th>Gaps blocking issuance</th><th>Registration</th><th>Service</th>
</tr></thead>
<tbody>${rows}</tbody></table></div>

<h2>Dealers</h2>
<p class="sub">Two channels, because how a dealer reaches insurers differs. A
broker's consolidated platform fronts several insurers behind one login; a direct
agency code reaches exactly one.</p>
<div class="scroll"><table>
<thead><tr><th>Code</th><th>Name</th><th>Location</th><th>Channel</th><th>Intermediary</th></tr></thead>
<tbody>${dealerRows}</tbody></table></div>

<h2>Raw endpoints</h2>
<ul>
  <li><a href="/dms/v1/health">/dms/v1/health</a> &mdash; no key needed</li>
  <li><a href="/dms/v1/deals?status=AWAITING_INSURANCE&apiKey=${esc(API_KEY)}">/dms/v1/deals?status=AWAITING_INSURANCE</a>
      &mdash; the queue this product exists to drain</li>
  <li><a href="/dms/v1/models?apiKey=${esc(API_KEY)}">/dms/v1/models</a> &mdash; OEM catalogue</li>
  <li><a href="/dms/v1/stock/MBLHAR0748NK41772?apiKey=${esc(API_KEY)}">/dms/v1/stock/&lt;chassisNo&gt;</a>
      &mdash; unallocated yard stock</li>
</ul>
<p><small>Links carry <code>?apiKey=</code> so a browser can reach them &mdash; a
browser cannot set a custom header on a navigation. Real clients send
<code>X-DMS-API-Key</code>.</small></p>

</body></html>`);
});

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
  const { dealerCode, status } = req.query as { dealerCode?: string; status?: DmsDealStatus };

  const matches = DEALS.filter(
    (d) => (!dealerCode || d.dealerCode === dealerCode) && (!status || d.status === status),
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
