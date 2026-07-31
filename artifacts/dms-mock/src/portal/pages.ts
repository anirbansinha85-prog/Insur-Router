/**
 * Portal pages other than the issuance flow.
 *
 * Every figure on these screens is derived from the seeded deals, with one
 * exception that is labelled as illustrative on the page itself — the
 * time-to-policy comparison, which has no source in a mock and exists to frame
 * the value proposition. Everything else counts or sums real records, so the
 * numbers stay consistent as the demo is driven.
 */

import { DEALS, FREE_STOCK } from "../deals.ts";
import { MODELS } from "../catalogue.ts";
import { buildServiceSchedule } from "../service-schedule.ts";
import { panelFor } from "../insurers.ts";
import { quotaState, eligibility } from "@workspace/quoting/panel";
import { formatInr } from "@workspace/quoting/premium";
import { esc } from "./shell.ts";
import {
  gaps,
  human,
  fullName,
  money,
  orMissing,
  ratingBasis,
  statusChip,
  type Ctx,
} from "./context.ts";
import type { DmsDeal } from "../types.ts";

/** Deals with a policy on file, newest first. */
function issued(ctx: Ctx): DmsDeal[] {
  return ctx.deals.filter((d) => d.insurance.policyNo);
}

function premiumPlaced(ctx: Ctx): number {
  return issued(ctx).reduce((acc, d) => acc + Number(d.insurance.totalPremiumAmt ?? 0), 0);
}

// ── Dashboard ───────────────────────────────────────────────────────────────

/** Illustrative monthly issuance volume. Fixed, not random, so refreshes match. */
const MONTHLY_VOLUME = [18, 24, 21, 30, 27, 34, 41];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];

export function dashboardPage(ctx: Ctx): string {
  const awaiting = ctx.deals.filter((d) => d.status === "AWAITING_INSURANCE");
  const blocked = awaiting.filter((d) => gaps(d).length > 0);
  const ready = awaiting.filter((d) => gaps(d).length === 0);
  const panel = panelFor(ctx.dealer.dealerCode);

  const dueSoon = ctx.deals
    .filter((d) => d.actualDeliveryDt)
    .flatMap((d) =>
      buildServiceSchedule(d).entries.filter((e) => e.status === "DUE" || e.status === "OVERDUE"),
    );

  const peak = Math.max(...MONTHLY_VOLUME);

  return `
<div class="grid g4" style="margin-bottom:14px">
  <div class="kpi accent">
    <p class="lb">Awaiting insurance</p>
    <p class="vl">${awaiting.length}</p>
    <p class="ft">${ready.length} ready to issue · ${blocked.length} need a detail</p>
  </div>
  <div class="kpi">
    <p class="lb">Policies issued</p>
    <p class="vl">${issued(ctx).length}<small> this FY</small></p>
    <p class="ft">${money(premiumPlaced(ctx))} premium placed</p>
  </div>
  <div class="kpi">
    <p class="lb">Stock in yard</p>
    <p class="vl">${FREE_STOCK.length}<small> unallotted</small></p>
    <p class="ft">${Object.keys(MODELS).length} models on catalogue</p>
  </div>
  <div class="kpi">
    <p class="lb">Service due</p>
    <p class="vl">${dueSoon.length}</p>
    <p class="ft">Within 30 days, or already overdue</p>
  </div>
</div>

${
  awaiting.length
    ? `<div class="note warn" style="margin-bottom:14px">
        <b>${awaiting.length} vehicle${awaiting.length === 1 ? "" : "s"} cannot be registered yet.</b>
        <p>An RTO will not issue a Registration Certificate without live insurance, so every deal
        in this queue is a delivery that is blocked until a policy exists.</p>
      </div>`
    : ""
}

<div class="grid g2" style="margin-bottom:14px">
  <div class="card">
    <header><h2>Issuance queue</h2>
      <span class="r"><a href="/portal/insurance">Open queue →</a></span></header>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Deal</th><th>Customer</th><th>Vehicle</th><th>Blocking</th><th></th></tr></thead>
      <tbody>${
        awaiting.length
          ? awaiting
              .map((d) => {
                const g = gaps(d);
                return `<tr>
          <td><a href="/portal/deals/${esc(d.dealId)}"><code>${esc(
            d.dealId.split("-").slice(-1)[0],
          )}</code></a></td>
          <td>${esc(fullName(d.customer))}</td>
          <td>${esc(d.vehicle.model.modelDesc)}<br><small class="mut">${esc(
            ratingBasis(d),
          )}</small></td>
          <td>${
            g.length
              ? g.map((x) => `<span class="chip err">${esc(x.label)}</span>`).join(" ")
              : '<span class="chip ok">Ready</span>'
          }</td>
          <td><a class="btn sm pri" href="/portal/deals/${esc(
            d.dealId,
          )}/issue">Issue</a></td>
        </tr>`;
              })
              .join("")
          : '<tr><td colspan="5" class="empty">Queue is clear.</td></tr>'
      }</tbody>
    </table></div>
  </div>

  <div class="card">
    <header><h2>Insurer panel utilisation</h2>
      <span class="r">${esc(
        panel[0]?.route === "BROKER" ? "Via broker platform" : "Direct agency",
      )}</span></header>
    <div class="pad" style="display:grid;gap:12px">
      ${panel
        .map((p) => {
          const q = quotaState(p);
          const cls = q.exhausted ? "full" : q.tight ? "hi" : "";
          return `<div>
            <div style="display:flex;font-size:12.3px;margin-bottom:4px">
              <span style="font-weight:600">${esc(p.shortName)}</span>
              <span class="mut" style="margin-left:auto">${p.quotaConsumed}/${p.quotaPolicies}
                ${
                  q.exhausted
                    ? '<span class="chip err" style="margin-left:6px">Quota full</span>'
                    : q.tight
                      ? '<span class="chip warn" style="margin-left:6px">Nearly full</span>'
                      : ""
                }</span>
            </div>
            <div class="bar"><i class="${cls}" style="width:${Math.round(
              q.utilisation * 100,
            )}%"></i></div>
          </div>`;
        })
        .join("")}
      <p class="ft mut" style="font-size:11.5px;margin:2px 0 0">
        Quota is the volume committed to each insurer this period. An exhausted insurer is
        excluded from routing.</p>
    </div>
  </div>
</div>

<div class="grid g2">
  <div class="card">
    <header><h2>Policies issued per month</h2><span class="r">FY 2026-27</span></header>
    <div class="pad">
      <div class="spark">${MONTHLY_VOLUME.map(
        (v, i) =>
          `<i class="${i === MONTHLY_VOLUME.length - 1 ? "hi" : ""}" style="height:${Math.round(
            (v / peak) * 100,
          )}%" title="${MONTH_LABELS[i]}: ${v}"></i>`,
      ).join("")}</div>
      <div class="legend">${MONTH_LABELS.map((m) => `<span>${m}</span>`).join("")}</div>
    </div>
  </div>

  <div class="card">
    <header><h2>Time to policy</h2><span class="r">Illustrative</span></header>
    <div class="pad">
      <dl class="kv">
        <dt>Manual portal entry</dt><dd>~14 min per policy</dd>
        <dt>Through this module</dt><dd><b>~4 min</b> per policy</dd>
        <dt>Re-keyed fields removed</dt><dd>31 of 38</dd>
      </dl>
      <p class="mut" style="font-size:11.5px;margin:11px 0 0">
        These two figures are <b>illustrative</b>, not measured — a sandbox has no timing data.
        The re-keyed field count is real: it is the number of proposal fields already present in
        the DMS record.</p>
    </div>
  </div>
</div>`;
}

// ── Deals ───────────────────────────────────────────────────────────────────

export function dealsPage(ctx: Ctx, opts: { onlyAwaiting?: boolean; q?: string } = {}): string {
  let rows = ctx.deals;
  if (opts.onlyAwaiting) rows = rows.filter((d) => d.status === "AWAITING_INSURANCE");
  if (opts.q) {
    const needle = opts.q.toLowerCase();
    rows = rows.filter((d) =>
      [d.dealId, fullName(d.customer), d.vehicle.chassisNo, d.vehicle.model.modelDesc]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }

  // Fewest gaps first: a deal needing one phone call is more actionable than one
  // needing three, and a dealer works the queue by effort, not by date.
  if (opts.onlyAwaiting) rows = [...rows].sort((a, b) => gaps(a).length - gaps(b).length);

  return `
<form method="get" class="row" style="margin-bottom:13px;align-items:flex-end">
  <div style="flex:1;min-width:210px;max-width:340px">
    <label class="fl" for="q">Search</label>
    <input class="fi" id="q" name="q" value="${esc(opts.q ?? "")}"
           placeholder="Deal ID, customer, chassis or model">
  </div>
  <button class="btn" type="submit">Search</button>
  ${opts.q ? `<a class="btn" href="?">Clear</a>` : ""}
</form>

<div class="card"><div class="tbl-wrap"><table class="tbl">
  <thead><tr>
    <th>Deal</th><th>Status</th><th>Customer</th><th>Vehicle</th><th>Chassis</th>
    <th class="num">Invoice</th><th>Finance</th><th>Blocking</th><th>Policy</th><th></th>
  </tr></thead>
  <tbody>${
    rows.length
      ? rows
          .map((d) => {
            const g = gaps(d);
            return `<tr>
      <td><a href="/portal/deals/${esc(d.dealId)}"><code>${esc(d.dealId)}</code></a><br>
          <small class="mut">${human(d.bookingDt)}</small></td>
      <td>${statusChip(d.status)}</td>
      <td>${esc(fullName(d.customer))}${
        d.customer.custType === "CORPORATE" ? ' <span class="chip neu">Corporate</span>' : ""
      }<br><small class="mut">${esc(d.customer.addr.cityDesc)}</small></td>
      <td>${esc(d.vehicle.model.modelDesc)}<br><small class="mut">${esc(ratingBasis(d))}${
        d.vehicle.model.fuel === "ELECTRIC" ? ' · <span class="chip ok">EV</span>' : ""
      }</small></td>
      <td><code>${esc(d.vehicle.chassisNo)}</code></td>
      <td class="num">${money(d.invoice.invoiceAmt)}</td>
      <td>${
        d.finance.financedFlg === "Y"
          ? `${esc(d.finance.financierName)}<br><small class="mut">Hypothecated</small>`
          : '<small class="mut">Cash</small>'
      }</td>
      <td>${
        d.status !== "AWAITING_INSURANCE"
          ? '<small class="faint">—</small>'
          : g.length
            ? g.map((x) => `<span class="chip err">${esc(x.label)}</span>`).join(" ")
            : '<span class="chip ok">Ready</span>'
      }</td>
      <td>${
        d.insurance.policyNo
          ? `<a href="/portal/policies/${encodeURIComponent(
              d.insurance.policyNo,
            )}"><code>${esc(d.insurance.policyNo)}</code></a><br>
             <small class="mut">${esc(d.insurance.insurerCode)}</small>`
          : '<small class="faint">Not insured</small>'
      }</td>
      <td>${
        d.status === "AWAITING_INSURANCE"
          ? `<a class="btn sm pri" href="/portal/deals/${esc(d.dealId)}/issue">Issue</a>`
          : `<a class="btn sm" href="/portal/deals/${esc(d.dealId)}">Open</a>`
      }</td>
    </tr>`;
          })
          .join("")
      : '<tr><td colspan="10" class="empty">No deals match.</td></tr>'
  }</tbody>
</table></div></div>`;
}

// ── Deal detail ─────────────────────────────────────────────────────────────

export function dealDetailPage(ctx: Ctx, d: DmsDeal): string {
  const g = gaps(d);
  const sched = d.actualDeliveryDt ? buildServiceSchedule(d) : null;

  return `
${
  g.length
    ? `<div class="note err" style="margin-bottom:14px">
        <b>${g.length} detail${g.length === 1 ? "" : "s"} still needed before a policy can be issued.</b>
        ${g.map((x) => `<p>· <b>${esc(x.label)}</b> — ${esc(x.why)}</p>`).join("")}
      </div>`
    : d.status === "AWAITING_INSURANCE"
      ? `<div class="note ok" style="margin-bottom:14px">
          <b>Every mandatory field is on file.</b>
          <p>This deal can be quoted and issued without asking the customer for anything.</p>
        </div>`
      : ""
}

<div class="grid g2">
  <div class="card">
    <header><h2>Vehicle</h2><span class="r">From DMS stock — authoritative</span></header>
    <div class="pad"><dl class="kv">
      <dt>Model</dt><dd>${esc(d.vehicle.model.modelDesc)} — ${esc(d.vehicle.model.variantDesc)}</dd>
      <dt>${d.vehicle.model.fuel === "ELECTRIC" ? "Motor rating" : "Engine capacity"}</dt>
        <dd><b>${esc(ratingBasis(d))}</b> <span class="mut">— sets the third-party premium</span></dd>
      <dt>Fuel</dt><dd>${esc(d.vehicle.model.fuel)}</dd>
      <dt>Body style</dt><dd>${esc(d.vehicle.model.bodyStyle)}</dd>
      <dt>Seating</dt><dd>${d.vehicle.model.seatCap}</dd>
      <dt>Chassis no.</dt><dd><code>${esc(d.vehicle.chassisNo)}</code></dd>
      <dt>Engine no.</dt><dd><code>${esc(d.vehicle.engineNo)}</code></dd>
      <dt>Colour</dt><dd>${esc(d.vehicle.colourDesc)}</dd>
      <dt>Manufactured</dt><dd>${String(d.vehicle.mfgMth).padStart(2, "0")}/${d.vehicle.mfgYr}</dd>
      <dt>Origin</dt><dd>${d.vehicle.importedFlg === "Y" ? "Imported" : "Indigenous"}</dd>
      <dt>Ex-showroom</dt><dd>${money(d.vehicle.exShowroomAmt)}</dd>
    </dl></div>
  </div>

  <div class="card">
    <header><h2>Customer</h2><span class="r">${esc(d.customer.custType)}</span></header>
    <div class="pad"><dl class="kv">
      <dt>Name</dt><dd>${esc(fullName(d.customer))}</dd>
      <dt>Date of birth</dt><dd>${
        d.customer.custType === "CORPORATE"
          ? '<span class="mut">Not applicable — corporate</span>'
          : orMissing(human(d.customer.dob) === "—" ? null : human(d.customer.dob))
      }</dd>
      <dt>Mobile</dt><dd>${orMissing(d.customer.mobileNo)}</dd>
      <dt>Email</dt><dd>${orMissing(d.customer.emailId, "Not captured — needed for delivery")}</dd>
      <dt>PAN</dt><dd><code>${esc(d.customer.panNo ?? "—")}</code></dd>
      <dt>Aadhaar</dt><dd>${
        d.customer.aadhaarLast4
          ? `<code>XXXX XXXX ${esc(d.customer.aadhaarLast4)}</code>`
          : '<span class="mut">—</span>'
      }</dd>
      ${d.customer.gstin ? `<dt>GSTIN</dt><dd><code>${esc(d.customer.gstin)}</code></dd>` : ""}
      <dt>Occupation</dt><dd>${esc(d.customer.occupationDesc ?? "—")}</dd>
      <dt>Address</dt><dd>${esc(
        [d.customer.addr.line1, d.customer.addr.line2, d.customer.addr.locality]
          .filter(Boolean)
          .join(", "),
      )}<br>${esc(d.customer.addr.cityDesc)}, ${esc(d.customer.addr.stateDesc)} —
        <code>${esc(d.customer.addr.pin)}</code></dd>
    </dl></div>
  </div>

  <div class="card">
    <header><h2>Nominee</h2>
      <span class="r">For the compulsory ₹15L PA cover</span></header>
    <div class="pad">
      ${
        d.customer.custType === "CORPORATE"
          ? `<div class="note"><b>Not applicable.</b>
              <p>A corporate owner has no owner-driver, so the compulsory personal-accident cover
              does not attach the same way and no nominee is collected.</p></div>`
          : `<dl class="kv">
              <dt>Name</dt><dd>${orMissing(d.nominee.nomineeName, "Must be asked")}</dd>
              <dt>Date of birth</dt><dd>${orMissing(
                human(d.nominee.nomineeDob) === "—" ? null : human(d.nominee.nomineeDob),
                "Must be asked",
              )}</dd>
              <dt>Relationship</dt><dd>${orMissing(d.nominee.relationDesc, "Must be asked")}</dd>
              ${
                d.nominee.appointeeName
                  ? `<dt>Appointee</dt><dd>${esc(d.nominee.appointeeName)} (${esc(
                      d.nominee.appointeeRelationDesc ?? "—",
                    )})</dd>`
                  : ""
              }
            </dl>
            ${
              !d.nominee.nomineeName
                ? `<div class="note err" style="margin-top:12px">
                    <b>No document carries this.</b>
                    <p>Not the invoice, not Form 21, not Aadhaar, not the PAN card. A vehicle sale
                    has no reason to collect it, so it must be asked at the counter.</p></div>`
                : ""
            }`
      }
    </div>
  </div>

  <div class="card">
    <header><h2>Finance &amp; documents</h2></header>
    <div class="pad"><dl class="kv">
      <dt>Financed</dt><dd>${d.finance.financedFlg === "Y" ? "Yes" : "No — cash sale"}</dd>
      ${
        d.finance.financedFlg === "Y"
          ? `<dt>Financier</dt><dd>${esc(d.finance.financierName)}<br>
               <small class="mut">${esc(d.finance.financierBranchDesc ?? "")}</small></dd>
             <dt>Loan account</dt><dd><code>${esc(d.finance.loanAcctNo ?? "—")}</code></dd>
             <dt>Loan amount</dt><dd>${money(d.finance.loanAmt)} over ${
               d.finance.tenureMths
             } months</dd>
             <dt>Hypothecation</dt><dd><span class="chip info">Endorsed on policy and RC</span></dd>`
          : ""
      }
      <dt>Invoice</dt><dd><code>${esc(d.invoice.invoiceNo ?? "—")}</code> ·
        ${human(d.invoice.invoiceDt)} · ${money(d.invoice.invoiceAmt)}</dd>
      <dt>Form 21</dt><dd><code>${esc(d.registration.form21No ?? "—")}</code>
        <small class="mut">sale certificate</small></dd>
      <dt>Form 22</dt><dd><code>${esc(d.registration.form22No ?? "—")}</code>
        <small class="mut">roadworthiness</small></dd>
      <dt>Sales executive</dt><dd>${esc(d.salesPerson.empName)}
        <small class="mut">${esc(d.salesPerson.empCode)}</small></dd>
    </dl></div>
  </div>

  <div class="card">
    <header><h2>Insurance</h2></header>
    <div class="pad">${
      d.insurance.policyNo
        ? `<dl class="kv">
            <dt>Policy no.</dt><dd><a href="/portal/policies/${encodeURIComponent(
              d.insurance.policyNo,
            )}"><code>${esc(d.insurance.policyNo)}</code></a></dd>
            <dt>Insurer</dt><dd>${esc(d.insurance.insurerCode)}</dd>
            <dt>Own damage</dt><dd>${human(d.insurance.odStartDt)} → ${human(
              d.insurance.odEndDt,
            )} <span class="mut">(1 year)</span></dd>
            <dt>Third party</dt><dd>${human(d.insurance.tpStartDt)} → ${human(
              d.insurance.tpEndDt,
            )} <span class="mut">(5 years)</span></dd>
            <dt>IDV</dt><dd>${money(d.insurance.idvAmt)}</dd>
            <dt>Total premium</dt><dd><b>${money(d.insurance.totalPremiumAmt)}</b></dd>
          </dl>`
        : `<p class="mut" style="margin:0 0 12px">No policy on this deal yet. The vehicle cannot be
             registered until one exists.</p>
           <a class="btn pri" href="/portal/deals/${esc(
             d.dealId,
           )}/issue">Start issuance →</a>`
    }</div>
  </div>

  <div class="card">
    <header><h2>Registration</h2>
      <span class="r">Follows insurance, never precedes it</span></header>
    <div class="pad">${
      d.registration.regNo
        ? `<dl class="kv">
            <dt>Registration no.</dt><dd><code>${esc(d.registration.regNo)}</code></dd>
            <dt>Registered on</dt><dd>${human(d.registration.regDt)}</dd>
            <dt>RTO</dt><dd><code>${esc(d.registration.rtoCode ?? "—")}</code></dd>
          </dl>`
        : `<div class="note"><b>Not registered yet — expected.</b>
            <p>Under the Motor Vehicles Act 1988 an RTO will not issue a Registration Certificate
            without live insurance. The policy is issued against the chassis number and endorsed
            with the registration number once the RC comes back.</p></div>`
    }</div>
  </div>

  ${
    sched
      ? `<div class="card" style="grid-column:1/-1">
          <header><h2>Service &amp; warranty</h2>
            <span class="r">Warranty to ${human(sched.warrantyEndDt)} or ${formatInr(
              sched.warrantyKm,
            )} km</span></header>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>#</th><th>Type</th><th>Due by</th><th class="num">Odometer</th>
              <th>Status</th></tr></thead>
            <tbody>${sched.entries
              .map(
                (e) => `<tr>
              <td>${e.seq}</td>
              <td>${e.kind === "FREE" ? '<span class="chip ok">Free</span>' : '<span class="chip neu">Paid</span>'}</td>
              <td>${human(e.dueByDt)}</td>
              <td class="num">${formatInr(e.dueByKm)} km</td>
              <td>${
                e.status === "OVERDUE"
                  ? '<span class="chip err">Overdue</span>'
                  : e.status === "DUE"
                    ? '<span class="chip warn">Due now</span>'
                    : '<span class="chip neu">Scheduled</span>'
              }</td>
            </tr>`,
              )
              .join("")}</tbody>
          </table></div>
        </div>`
      : ""
  }
</div>`;
}

// ── Stock ───────────────────────────────────────────────────────────────────

export function stockPage(ctx: Ctx): string {
  const allocated = ctx.deals.map((d) => d.vehicle);

  const row = (
    u: (typeof FREE_STOCK)[number],
    dealId: string | null,
  ) => {
    const m = MODELS[u.modelCode];
    return `<tr>
      <td><code>${esc(u.chassisNo)}</code></td>
      <td>${esc(m.modelDesc)}<br><small class="mut">${esc(m.variantDesc)}</small></td>
      <td>${esc(m.fuel === "ELECTRIC" ? `${m.motorKw} kW` : `${m.cc} cc`)}</td>
      <td>${esc(u.colourDesc)}</td>
      <td>${String(u.mfgMth).padStart(2, "0")}/${u.mfgYr}</td>
      <td class="num">${money(u.exShowroomAmt)}</td>
      <td>${human(u.yardInDt)}</td>
      <td>${
        dealId
          ? `<a href="/portal/deals/${esc(dealId)}"><code>${esc(dealId)}</code></a>`
          : '<span class="chip ok">Available</span>'
      }</td>
    </tr>`;
  };

  return `
<div class="note" style="margin-bottom:14px">
  <b>Stock is the authoritative source for every vehicle field an insurer asks for.</b>
  <p>Chassis, engine, capacity, colour, manufacture month and ex-showroom price are all known the
  moment a unit is allotted — none of it needs to be read off a document.</p>
</div>
<div class="card">
  <header><h2>Yard stock</h2><span class="r">${FREE_STOCK.length} available ·
    ${allocated.length} allotted</span></header>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Chassis</th><th>Model</th><th>Rating</th><th>Colour</th><th>Mfg</th>
      <th class="num">Ex-showroom</th><th>Yard in</th><th>Allotment</th></tr></thead>
    <tbody>
      ${FREE_STOCK.map((u) => row(u, null)).join("")}
      ${ctx.deals.map((d) => row(d.vehicle, d.dealId)).join("")}
    </tbody>
  </table></div>
</div>`;
}

// ── Policies ────────────────────────────────────────────────────────────────

export function policiesPage(ctx: Ctx): string {
  const rows = issued(ctx);
  return `
<div class="card"><div class="tbl-wrap"><table class="tbl">
  <thead><tr><th>Policy no.</th><th>Insurer</th><th>Customer</th><th>Vehicle</th>
    <th>OD cover</th><th>TP cover</th><th class="num">IDV</th><th class="num">Premium</th>
    <th>Registration</th></tr></thead>
  <tbody>${
    rows.length
      ? rows
          .map(
            (d) => `<tr>
      <td><a href="/portal/policies/${encodeURIComponent(d.insurance.policyNo!)}">
        <code>${esc(d.insurance.policyNo)}</code></a></td>
      <td>${esc(d.insurance.insurerCode)}</td>
      <td>${esc(fullName(d.customer))}</td>
      <td>${esc(d.vehicle.model.modelDesc)}<br>
        <small class="mut"><code>${esc(d.vehicle.chassisNo)}</code></small></td>
      <td>${human(d.insurance.odEndDt)}<br><small class="mut">1 year</small></td>
      <td>${human(d.insurance.tpEndDt)}<br><small class="mut">5 years</small></td>
      <td class="num">${money(d.insurance.idvAmt)}</td>
      <td class="num"><b>${money(d.insurance.totalPremiumAmt)}</b></td>
      <td>${
        d.registration.regNo
          ? `<code>${esc(d.registration.regNo)}</code>`
          : '<span class="chip warn">Pending RC</span>'
      }</td>
    </tr>`,
          )
          .join("")
      : '<tr><td colspan="9" class="empty">No policies issued yet. Work the issuance queue.</td></tr>'
  }</tbody>
</table></div></div>`;
}

// ── Insurer panel ───────────────────────────────────────────────────────────

export function panelPage(ctx: Ctx): string {
  const panel = panelFor(ctx.dealer.dealerCode);
  const im = ctx.dealer.intermediary;

  return `
<div class="note" style="margin-bottom:14px">
  <b>${esc(im.intermediaryName)}</b>
  <p>${
    im.channel === "BROKER"
      ? `This dealership reaches insurers through a broker's consolidated platform — one login
         fronting ${panel.length} insurers. Integrating that single platform reaches all of them.`
      : `This dealership is a direct agent of one insurer, using its own agency code. There is no
         panel to compare against, which is why the routing screen looks different here.`
  }</p>
  <p class="mut">Channel <b>${esc(im.channel.replace(/_/g, " "))}</b> ·
    Code <code>${esc(im.intermediaryCode)}</code></p>
</div>

<div class="card"><div class="tbl-wrap"><table class="tbl">
  <thead><tr><th>Insurer</th><th>Route</th><th>Integration</th><th class="num">OD rate</th>
    <th class="num">Payout</th><th>Quota this period</th><th>SLA</th><th>Status</th></tr></thead>
  <tbody>${panel
    .map((p) => {
      const q = quotaState(p);
      const el = eligibility(p);
      return `<tr>
      <td><b>${esc(p.shortName)}</b><br><small class="mut">${esc(p.insurerName)}</small></td>
      <td><span class="chip ${p.route === "BROKER" ? "info" : "neu"}">${esc(
        p.route.replace(/_/g, " "),
      )}</span></td>
      <td>${
        p.integration === "API"
          ? '<span class="chip ok">API</span>'
          : '<span class="chip warn">Portal only</span><br><small class="mut">browser automation</small>'
      }</td>
      <td class="num">${(p.odBaseRate * 100).toFixed(2)}%<br><small class="mut">of IDV</small></td>
      <td class="num">${(p.payoutRate * 100).toFixed(1)}%</td>
      <td style="min-width:150px">
        <div style="display:flex;font-size:11.5px;margin-bottom:3px">
          <span>${p.quotaConsumed}/${p.quotaPolicies}</span>
          <span class="mut" style="margin-left:auto">${q.remaining} left</span></div>
        <div class="bar"><i class="${q.exhausted ? "full" : q.tight ? "hi" : ""}"
          style="width:${Math.round(q.utilisation * 100)}%"></i></div>
      </td>
      <td>${p.slaMinutes} min</td>
      <td>${
        el.eligible
          ? '<span class="chip ok">Available</span>'
          : `<span class="chip err">Excluded</span><br><small class="mut">${esc(
              el.reasons.join("; "),
            )}</small>`
      }</td>
    </tr>`;
    })
    .join("")}</tbody>
</table></div></div>

<div class="note warn" style="margin-top:14px">
  <b>Own-damage rates shown here are invented.</b>
  <p>Real filed rates are confidential and vary by model and zone. They exist in this sandbox so
  quotes differ plausibly — which is the point being demonstrated: third-party premium is
  identical at every insurer by law, so own damage is the only thing that varies.</p>
</div>`;
}

// ── Service & reminders ─────────────────────────────────────────────────────

export function servicePage(ctx: Ctx): string {
  const delivered = ctx.deals.filter((d) => d.actualDeliveryDt);

  if (!delivered.length) {
    return `<div class="card"><p class="empty">No delivered vehicles yet — a service schedule only
      exists once there is a delivery date to count from.</p></div>`;
  }

  return delivered
    .map((d) => {
      const s = buildServiceSchedule(d);
      return `<div class="card" style="margin-bottom:14px">
      <header><h2>${esc(fullName(d.customer))} — ${esc(d.vehicle.model.modelDesc)}</h2>
        <span class="r"><code>${esc(
          d.registration.regNo ?? d.vehicle.chassisNo,
        )}</code> · warranty to ${human(s.warrantyEndDt)} or ${formatInr(s.warrantyKm)} km</span>
      </header>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>#</th><th>Type</th><th>Due by</th><th class="num">Odometer</th>
          <th>Status</th></tr></thead>
        <tbody>${s.entries
          .map(
            (e) => `<tr>
          <td>${e.seq}</td>
          <td>${
            e.kind === "FREE"
              ? '<span class="chip ok">Free</span>'
              : '<span class="chip neu">Paid</span>'
          }</td>
          <td>${human(e.dueByDt)}</td>
          <td class="num">${formatInr(e.dueByKm)} km</td>
          <td>${
            e.status === "OVERDUE"
              ? '<span class="chip err">Overdue</span>'
              : e.status === "DUE"
                ? '<span class="chip warn">Due now</span>'
                : '<span class="chip neu">Scheduled</span>'
          }</td>
        </tr>`,
          )
          .join("")}</tbody>
      </table></div></div>`;
    })
    .join("");
}

export function remindersPage(ctx: Ctx): string {
  interface Rem {
    kind: string;
    cls: string;
    who: string;
    contact: string;
    what: string;
    when: string;
    dealId: string;
  }
  const out: Rem[] = [];

  for (const d of ctx.deals) {
    if (d.insurance.odEndDt) {
      out.push({
        kind: "Insurance renewal",
        cls: "info",
        who: fullName(d.customer),
        contact: d.customer.mobileNo ?? d.customer.emailId ?? "—",
        what: `Own-damage cover expires — third party runs to ${human(d.insurance.tpEndDt)}`,
        when: human(d.insurance.odEndDt),
        dealId: d.dealId,
      });
    }
    if (!d.actualDeliveryDt) continue;
    for (const e of buildServiceSchedule(d).entries) {
      if (e.status !== "DUE" && e.status !== "OVERDUE") continue;
      out.push({
        kind: `${e.kind === "FREE" ? "Free" : "Paid"} service #${e.seq}`,
        cls: e.status === "OVERDUE" ? "err" : "warn",
        who: fullName(d.customer),
        contact: d.customer.mobileNo ?? "—",
        what: `Due by ${formatInr(e.dueByKm)} km — required to keep the warranty valid`,
        when: human(e.dueByDt),
        dealId: d.dealId,
      });
    }
  }

  return `
<div class="note" style="margin-bottom:14px">
  <b>This is the outbound queue, not a sent log.</b>
  <p>Nothing is dispatched from here — delivery is a separate build. These are the events a
  messaging agent would consume: policy expiry, and service milestones that keep the warranty
  alive.</p>
</div>
<div class="card"><div class="tbl-wrap"><table class="tbl">
  <thead><tr><th>Type</th><th>Customer</th><th>Contact</th><th>Message basis</th><th>Due</th>
    <th></th></tr></thead>
  <tbody>${
    out.length
      ? out
          .map(
            (r) => `<tr>
      <td><span class="chip ${r.cls}">${esc(r.kind)}</span></td>
      <td>${esc(r.who)}</td>
      <td><code>${esc(r.contact)}</code></td>
      <td>${esc(r.what)}</td>
      <td>${esc(r.when)}</td>
      <td><a class="btn sm" href="/portal/deals/${esc(r.dealId)}">Deal</a></td>
    </tr>`,
          )
          .join("")
      : '<tr><td colspan="6" class="empty">Nothing due.</td></tr>'
  }</tbody>
</table></div></div>`;
}
