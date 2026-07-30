/**
 * The issuance flow — the part of the demo that carries the argument.
 *
 * Three steps: confirm what the DMS already knows, collect only what it cannot
 * know, then choose an insurer against real numbers.
 *
 * Two things are deliberately made visible rather than smoothed over:
 *
 *   1. **What is computed vs estimated.** Third-party premium is fixed by IRDAI
 *      and identical at every insurer, so that figure is exact. Own damage was
 *      detariffed and only the insurer's own engine is authoritative, so it is
 *      labelled an estimate everywhere it appears. A demo that presents both as
 *      final teaches a dealer to distrust the tool the first time a portal
 *      disagrees.
 *
 *   2. **The dealer's actual conflict.** The cheapest quote for the customer is
 *      usually not the best payout for the dealership. Surfacing both, instead of
 *      silently picking one, is what makes the routing screen honest — and it is
 *      the tension every dealer recognises immediately.
 *
 * Issuance here writes a policy record into the mock DMS and stops. No insurer is
 * contacted, and the page says so. Wiring a real insurer needs the dealer's own
 * credentials — an API where one exists, browser automation where it does not.
 */

import { DEALS } from "../deals.ts";
import { panelFor, eligibility, quotaState, type PanelEntry } from "../insurers.ts";
import { computePremium, type PremiumBreakdown } from "../premium.ts";
import { formatDmsDate } from "../service-schedule.ts";
import { esc } from "./shell.ts";
import { fullName, gaps, human, money, ratingBasis, type Ctx } from "./context.ts";
import type { DmsDeal } from "../types.ts";

/**
 * Answers collected at step 1, held until the deal is issued.
 *
 * In memory and per-process, which is correct for a mock but is the first thing a
 * real implementation must replace — a half-finished proposal that vanishes when
 * the server restarts is worse than one that was never started.
 */
const DRAFTS = new Map<string, Record<string, string>>();

export function saveDraft(dealId: string, answers: Record<string, string>): void {
  DRAFTS.set(dealId, { ...(DRAFTS.get(dealId) ?? {}), ...answers });
}

export function draftFor(dealId: string): Record<string, string> {
  return DRAFTS.get(dealId) ?? {};
}

export function findDeal(dealId: string): DmsDeal | undefined {
  return DEALS.find((d) => d.dealId === dealId);
}

/**
 * Writes the collected answers onto the DMS record.
 *
 * The dealership's system is the record of the transaction, so anything asked at
 * the counter belongs back in it — otherwise the same question gets asked again
 * at the next touchpoint.
 */
export function applyDraft(deal: DmsDeal): void {
  const d = draftFor(deal.dealId);
  if (d.emailId) deal.customer.emailId = d.emailId;
  if (d.mobileNo) deal.customer.mobileNo = d.mobileNo;
  if (d.dob) deal.customer.dob = d.dob;
  if (d.nomineeName) deal.nominee.nomineeName = d.nomineeName;
  if (d.nomineeDob) deal.nominee.nomineeDob = d.nomineeDob;
  if (d.relationDesc) deal.nominee.relationDesc = d.relationDesc;
  if (d.appointeeName) deal.nominee.appointeeName = d.appointeeName;
  if (d.appointeeRelationDesc) deal.nominee.appointeeRelationDesc = d.appointeeRelationDesc;
}

function steps(current: 1 | 2 | 3): string {
  const labels = ["Confirm details", "Choose insurer", "Policy issued"];
  return `<div class="steps">${labels
    .map((l, i) => {
      const n = i + 1;
      const cls = n < current ? "done" : n === current ? "on" : "";
      return `${i ? '<span class="sep"></span>' : ""}<span class="st ${cls}">
        <i>${n < current ? "✓" : n}</i>${esc(l)}</span>`;
    })
    .join("")}</div>`;
}

// ── Step 1 — confirm what the DMS knows, collect what it cannot ─────────────

/** Common relationships, so a nominee can be captured without free-typing. */
const RELATIONSHIPS = ["SPOUSE", "FATHER", "MOTHER", "SON", "DAUGHTER", "BROTHER", "SISTER"];

export function issueStep1(ctx: Ctx, deal: DmsDeal): string {
  const g = gaps(deal);
  const draft = draftFor(deal.dealId);
  const pulled = 31;

  const field = (
    name: string,
    label: string,
    type = "text",
    hint = "",
    required = true,
  ) => `<div class="fld">
    <label class="fl" for="${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ""}</label>
    <input class="fi" id="${name}" name="${name}" type="${type}"
           value="${esc(draft[name] ?? "")}"${required ? " required" : ""}>
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
  </div>`;

  const needs = new Set(g.map((x) => x.field));

  return `${steps(1)}

<div class="note ok" style="margin-bottom:14px">
  <b>${pulled} of 38 proposal fields are already on file.</b>
  <p>Pulled straight from the dealership's own records — vehicle, customer, address, finance and
  documents. None of it needs re-typing, and none of it needs to be read off a scan.</p>
</div>

<div class="grid g2" style="margin-bottom:14px">
  <div class="card">
    <header><h2>From DMS — no entry required</h2>
      <span class="r">Read-only</span></header>
    <div class="pad"><dl class="kv">
      <dt>Customer</dt><dd>${esc(fullName(deal.customer))}</dd>
      <dt>Address</dt><dd>${esc(deal.customer.addr.cityDesc)}, ${esc(
        deal.customer.addr.stateDesc,
      )} — <code>${esc(deal.customer.addr.pin)}</code></dd>
      <dt>PAN</dt><dd><code>${esc(deal.customer.panNo ?? "—")}</code></dd>
      <dt>Vehicle</dt><dd>${esc(deal.vehicle.model.modelDesc)} ${esc(
        deal.vehicle.model.variantDesc,
      )}</dd>
      <dt>${deal.vehicle.model.fuel === "ELECTRIC" ? "Motor" : "Engine"}</dt>
        <dd><b>${esc(ratingBasis(deal))}</b></dd>
      <dt>Chassis</dt><dd><code>${esc(deal.vehicle.chassisNo)}</code></dd>
      <dt>Engine</dt><dd><code>${esc(deal.vehicle.engineNo)}</code></dd>
      <dt>Ex-showroom</dt><dd>${money(deal.vehicle.exShowroomAmt)}</dd>
      <dt>Hypothecation</dt><dd>${
        deal.finance.financedFlg === "Y" ? esc(deal.finance.financierName) : "None — cash sale"
      }</dd>
      <dt>Registration no.</dt><dd><span class="mut">Does not exist yet — policy is issued
        against the chassis number</span></dd>
    </dl></div>
  </div>

  <div class="card">
    <header><h2>${g.length ? `Needs asking — ${g.length} field${g.length === 1 ? "" : "s"}` : "Nothing to ask"}</h2></header>
    <div class="pad">
      ${
        g.length
          ? `<form method="post" action="/portal/deals/${esc(deal.dealId)}/quote">
              ${
                needs.has("nomineeName")
                  ? `<div class="note err" style="margin-bottom:13px">
                      <b>Nominee — no document carries this.</b>
                      <p>The compulsory ₹15 lakh owner-driver personal-accident cover cannot be
                      issued without one, and a vehicle sale never collects it.</p></div>
                    <div class="fields">
                      ${field("nomineeName", "Nominee name")}
                      ${field("nomineeDob", "Nominee date of birth", "date")}
                      <div class="fld">
                        <label class="fl" for="relationDesc">Relationship
                          <span class="req">*</span></label>
                        <select class="fi" id="relationDesc" name="relationDesc" required>
                          <option value="">Select…</option>
                          ${RELATIONSHIPS.map(
                            (r) =>
                              `<option${draft.relationDesc === r ? " selected" : ""}>${r}</option>`,
                          ).join("")}
                        </select>
                        <p class="hint">An appointee is also required if the nominee is a minor.</p>
                      </div>
                    </div>`
                  : ""
              }
              ${
                needs.has("emailId")
                  ? `<div class="fields">${field(
                      "emailId",
                      "Email",
                      "email",
                      "The policy document is delivered here.",
                    )}</div>`
                  : ""
              }
              ${
                needs.has("mobileNo")
                  ? `<div class="fields">${field("mobileNo", "Mobile", "tel")}</div>`
                  : ""
              }
              ${
                needs.has("dob")
                  ? `<div class="fields">${field("dob", "Date of birth", "date")}</div>`
                  : ""
              }
              <button class="btn pri" type="submit">Get quotes →</button>
            </form>`
          : `<p class="mut" style="margin:0 0 13px">Every mandatory field is already on file. Nothing
               to collect from the customer.</p>
             <form method="post" action="/portal/deals/${esc(deal.dealId)}/quote">
               <button class="btn pri" type="submit">Get quotes →</button>
             </form>`
      }
    </div>
  </div>
</div>`;
}

// ── Step 2 — quotes ─────────────────────────────────────────────────────────

interface Quote {
  p: PanelEntry;
  b: PremiumBreakdown;
  eligible: boolean;
  reasons: string[];
  payout: number;
}

export function quotesFor(ctx: Ctx, deal: DmsDeal): Quote[] {
  return panelFor(ctx.dealer.dealerCode).map((p) => {
    const b = computePremium({
      model: deal.vehicle.model,
      exShowroomAmt: Number(deal.vehicle.exShowroomAmt),
      registeringCity: deal.customer.addr.cityDesc,
      odBaseRate: p.odBaseRate,
      isCorporate: deal.customer.custType === "CORPORATE",
    });
    const el = eligibility(p);
    return { p, b, eligible: el.eligible, reasons: el.reasons, payout: b.od.amount * p.payoutRate };
  });
}

export function issueStep2(ctx: Ctx, deal: DmsDeal): string {
  const quotes = quotesFor(ctx, deal);
  const ok = quotes.filter((q) => q.eligible);

  const cheapest = ok.reduce<Quote | null>(
    (best, q) => (!best || q.b.totalPayable < best.b.totalPayable ? q : best),
    null,
  );
  const bestPayout = ok.reduce<Quote | null>(
    (best, q) => (!best || q.payout > best.payout ? q : best),
    null,
  );

  const tp = quotes[0]?.b.tp;
  const spread = ok.length
    ? Math.max(...ok.map((q) => q.b.totalPayable)) - Math.min(...ok.map((q) => q.b.totalPayable))
    : 0;

  const card = (q: Quote) => {
    const qs = quotaState(q.p);
    const badges = [
      q === cheapest ? '<span class="chip ok">Lowest premium</span>' : "",
      q === bestPayout && q !== cheapest
        ? '<span class="chip info">Best dealer payout</span>'
        : q === bestPayout && q === cheapest
          ? '<span class="chip info">Best payout too</span>'
          : "",
      q.p.integration === "PORTAL" ? '<span class="chip warn">Portal only</span>' : "",
      qs.tight ? '<span class="chip warn">Quota nearly full</span>' : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `<div class="quote ${q === cheapest ? "best" : ""} ${q.eligible ? "" : "off"}">
      <header><b>${esc(q.p.shortName)}</b>${badges}</header>
      <div class="amt">${money(q.b.totalPayable)}
        <small>incl. GST · ${q.p.slaMinutes} min turnaround</small></div>
      <div class="brk">
        <div><span>Third party — 5 years</span><span>${money(q.b.tp.amount)}</span></div>
        <div><span>Own damage — 1 year <em class="mut">est.</em></span>
          <span>${money(q.b.od.amount)}</span></div>
        ${
          q.b.cpa.applicable
            ? `<div><span>Owner-driver PA — ₹15L</span><span>${money(q.b.cpa.amount)}</span></div>`
            : `<div class="mut"><span>Owner-driver PA</span><span>${esc(
                q.b.cpa.reason ?? "n/a",
              )}</span></div>`
        }
        <div class="mut"><span>GST @ 18%</span><span>${money(q.b.gst)}</span></div>
        <div class="tot"><span>Total payable</span><span>${money(q.b.totalPayable)}</span></div>
      </div>
      <div class="mut" style="font-size:11.3px">
        IDV ${money(q.b.idv)} · OD rate ${(q.b.od.rate * 100).toFixed(2)}% ·
        Zone ${q.b.zone} · dealer payout ${money(q.payout)} ·
        quota ${q.p.quotaConsumed}/${q.p.quotaPolicies}
      </div>
      ${
        q.eligible
          ? `<form method="post" action="/portal/deals/${esc(deal.dealId)}/commit">
              <input type="hidden" name="insurerCode" value="${esc(q.p.insurerCode)}">
              <button class="btn ${q === cheapest ? "pri" : ""}" type="submit"
                style="width:100%">Issue with ${esc(q.p.shortName)}</button>
            </form>`
          : `<div class="note err" style="font-size:11.5px;padding:7px 10px">
              <b>Excluded.</b> ${esc(q.reasons.join("; "))}</div>`
      }
    </div>`;
  };

  return `${steps(2)}

<div class="grid g2" style="margin-bottom:14px">
  <div class="note ok">
    <b>Third-party premium is ${money(tp?.amount ?? 0)} at every insurer on the panel.</b>
    <p>IRDAI fixes it on ${esc(tp?.basis ?? "")} — band <b>${esc(tp?.band ?? "")}</b>, five years,
    mandatory on a new two-wheeler since September 2018. There is nothing to compare and nothing
    to negotiate on this half.${
      tp?.derived
        ? " <b>This model is electric</b>, rated on motor kW; the five-year figure is derived from the published one-year rate and should be checked against the current notification before being charged."
        : ""
    }</p>
  </div>
  <div class="note warn">
    <b>Own damage is an estimate — ${money(spread)} spread across the panel.</b>
    <p>OD was detariffed, so each insurer files its own rate and only that insurer's engine returns
    the binding figure. Everything below is computed from filed rates held in this sandbox, which
    is why the totals differ. Treat them as indicative until a real quote comes back.</p>
  </div>
</div>

<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(285px,1fr));margin-bottom:14px">
  ${quotes.map(card).join("")}
</div>

${
  cheapest && bestPayout && cheapest !== bestPayout
    ? `<div class="note">
        <b>The cheapest policy is not the best payout.</b>
        <p><b>${esc(cheapest.p.shortName)}</b> saves the customer
        ${money(bestPayout.b.totalPayable - cheapest.b.totalPayable)}.
        <b>${esc(bestPayout.p.shortName)}</b> earns the dealership
        ${money(bestPayout.payout - cheapest.payout)} more.
        Both are shown rather than one being chosen silently — that trade-off belongs to the
        dealership, not to the software.</p>
      </div>`
    : ""
}

<p style="margin-top:14px"><a href="/portal/deals/${esc(
    deal.dealId,
  )}/issue">← Back to details</a></p>`;
}

// ── Step 3 — issue ──────────────────────────────────────────────────────────

let policySeq = 4471;

/**
 * Plausible insurer-specific policy number formats.
 *
 * Real ICICI numbers use slashes (`3005/T…/00/000`); hyphens are substituted here
 * because a slash inside a URL path segment is a routing hazard, and fidelity in
 * a demo number is not worth the bug it would eventually cause.
 */
function policyNumber(insurerCode: string): string {
  const n = String(++policySeq).padStart(8, "0");
  switch (insurerCode) {
    case "BAJAJ":
      return `OG-27-1201-1847-${n}`;
    case "HDFC":
      return `2311${n}`;
    case "ICICI":
      return `3005-T${n}-00-000`;
    case "DIGIT":
      return `D${n}TW`;
    default:
      return `${insurerCode}-${n}`;
  }
}

function addYears(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/**
 * Commits the policy onto the deal.
 *
 * Cover starts today and OD runs one year while TP runs five — the bundled shape
 * mandated on a new two-wheeler. Returns the policy number so the caller can
 * redirect to it.
 */
export function commitPolicy(ctx: Ctx, deal: DmsDeal, insurerCode: string): string | null {
  const q = quotesFor(ctx, deal).find((x) => x.p.insurerCode === insurerCode);
  if (!q || !q.eligible) return null;

  applyDraft(deal);

  const start = new Date();
  // Cover ends the day before the anniversary, which is how motor policies run.
  const odEnd = new Date(addYears(start, 1).getTime() - 86_400_000);
  const tpEnd = new Date(addYears(start, 5).getTime() - 86_400_000);
  const policyNo = policyNumber(insurerCode);

  deal.insurance = {
    insurerCode,
    policyNo,
    odStartDt: formatDmsDate(start),
    odEndDt: formatDmsDate(odEnd),
    tpStartDt: formatDmsDate(start),
    tpEndDt: formatDmsDate(tpEnd),
    odPremiumAmt: q.b.od.amount.toFixed(2),
    tpPremiumAmt: q.b.tp.amount.toFixed(2),
    paPremiumAmt: q.b.cpa.amount.toFixed(2),
    totalPremiumAmt: q.b.totalPayable.toFixed(2),
    idvAmt: q.b.idv.toFixed(2),
  };

  if (deal.status === "AWAITING_INSURANCE") deal.status = "AWAITING_REGISTRATION";
  q.p.quotaConsumed += 1;
  DRAFTS.delete(deal.dealId);

  return policyNo;
}

export function policyPage(ctx: Ctx, deal: DmsDeal, justIssued: boolean): string {
  const ins = deal.insurance;
  const panel = panelFor(ctx.dealer.dealerCode).find((p) => p.insurerCode === ins.insurerCode);
  const net = Number(ins.totalPremiumAmt) / 1.18;

  return `${justIssued ? steps(3) : ""}

${
  justIssued
    ? `<div class="note ok" style="margin-bottom:14px">
        <b>Policy recorded — the registration file can now go to the RTO.</b>
        <p>The deal has moved to <b>Awaiting registration</b>, and the policy has been written back
        onto the dealership record so nobody has to ask these questions again.</p>
      </div>
      <div class="note warn" style="margin-bottom:14px">
        <b>No insurer was contacted.</b>
        <p>This policy exists only in the sandbox. Issuing for real needs the dealership's own
        credentials with ${esc(panel?.shortName ?? "the insurer")} — its API where one exists,
        browser automation against the portal where it does not. That is a commercial arrangement
        the dealership already has; it is not something the software can manufacture.</p>
      </div>`
    : ""
}

<div class="policy">
  <div class="ph">
    <div>
      <h2>${esc(panel?.insurerName ?? ins.insurerCode)}</h2>
      <p class="mut" style="margin:3px 0 0;font-size:12px">
        Two Wheeler Package Policy — Bundled (1 year Own Damage + 5 years Third Party)</p>
    </div>
    <div class="stamp">
      <div><b>Policy no.</b></div>
      <div class="mono" style="font-size:12.5px">${esc(ins.policyNo)}</div>
      <div style="margin-top:5px">Issued ${human(ins.odStartDt)}</div>
      <div>via ${esc(ctx.dealer.intermediary.intermediaryName)}</div>
    </div>
  </div>

  <div class="grid g2">
    <div>
      <h3 style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--tx-mut);margin:0 0 7px">Insured</h3>
      <dl class="kv">
        <dt>Name</dt><dd>${esc(fullName(deal.customer))}</dd>
        <dt>Address</dt><dd>${esc(
          [deal.customer.addr.line1, deal.customer.addr.locality].filter(Boolean).join(", "),
        )}<br>${esc(deal.customer.addr.cityDesc)}, ${esc(deal.customer.addr.stateDesc)} —
          ${esc(deal.customer.addr.pin)}</dd>
        <dt>Mobile</dt><dd>${esc(deal.customer.mobileNo ?? "—")}</dd>
        <dt>Email</dt><dd>${esc(deal.customer.emailId ?? "—")}</dd>
        ${
          deal.nominee.nomineeName
            ? `<dt>Nominee</dt><dd>${esc(deal.nominee.nomineeName)}
                 (${esc(deal.nominee.relationDesc ?? "—")})</dd>`
            : ""
        }
        ${
          deal.finance.financedFlg === "Y"
            ? `<dt>Hypothecated to</dt><dd>${esc(deal.finance.financierName)}</dd>`
            : ""
        }
      </dl>
    </div>
    <div>
      <h3 style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--tx-mut);margin:0 0 7px">Vehicle</h3>
      <dl class="kv">
        <dt>Make / model</dt><dd>Hero ${esc(deal.vehicle.model.modelDesc)}</dd>
        <dt>Variant</dt><dd>${esc(deal.vehicle.model.variantDesc)}</dd>
        <dt>${deal.vehicle.model.fuel === "ELECTRIC" ? "Motor" : "Cubic capacity"}</dt>
          <dd>${esc(ratingBasis(deal))}</dd>
        <dt>Chassis no.</dt><dd><code>${esc(deal.vehicle.chassisNo)}</code></dd>
        <dt>Engine no.</dt><dd><code>${esc(deal.vehicle.engineNo)}</code></dd>
        <dt>Manufactured</dt><dd>${String(deal.vehicle.mfgMth).padStart(2, "0")}/${
          deal.vehicle.mfgYr
        }</dd>
        <dt>Registration no.</dt><dd>${
          deal.registration.regNo
            ? `<code>${esc(deal.registration.regNo)}</code>`
            : '<span class="mut">To be endorsed on receipt of RC</span>'
        }</dd>
        <dt>IDV</dt><dd><b>${money(ins.idvAmt)}</b></dd>
      </dl>
    </div>
  </div>

  <h3 style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--tx-mut);margin:20px 0 7px">Cover &amp; premium</h3>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Section</th><th>Period</th><th class="num">Premium</th></tr></thead>
    <tbody>
      <tr><td>Third-party liability <small class="mut">— IRDAI tariff</small></td>
        <td>${human(ins.tpStartDt)} → ${human(ins.tpEndDt)} <small class="mut">(5 yr)</small></td>
        <td class="num">${money(ins.tpPremiumAmt)}</td></tr>
      <tr><td>Own damage</td>
        <td>${human(ins.odStartDt)} → ${human(ins.odEndDt)} <small class="mut">(1 yr)</small></td>
        <td class="num">${money(ins.odPremiumAmt)}</td></tr>
      <tr><td>Compulsory PA — owner-driver <small class="mut">₹15,00,000</small></td>
        <td>${human(ins.odStartDt)} → ${human(ins.odEndDt)}</td>
        <td class="num">${money(ins.paPremiumAmt)}</td></tr>
      <tr><td colspan="2"><b>Net premium</b></td>
        <td class="num"><b>${money(net)}</b></td></tr>
      <tr><td colspan="2">GST @ 18%</td>
        <td class="num">${money(Number(ins.totalPremiumAmt) - net)}</td></tr>
      <tr><td colspan="2"><b>Total payable</b></td>
        <td class="num"><b>${money(ins.totalPremiumAmt)}</b></td></tr>
    </tbody>
  </table></div>

  <p class="watermark">Sandbox document · invented data · not a contract of insurance</p>
</div>

<div class="row" style="margin-top:14px">
  <a class="btn" href="/portal/deals/${esc(deal.dealId)}">Open deal</a>
  <a class="btn" href="/portal/insurance">Back to queue</a>
  <button class="btn" onclick="window.print()">Print</button>
</div>`;
}
