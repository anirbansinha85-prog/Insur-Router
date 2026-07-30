/**
 * Portal routing.
 *
 * Server-rendered, form-driven, no client framework. That is a deliberate choice
 * for a demo fixture: it starts instantly, has no build step, and cannot drift
 * out of sync with the mock's data. The real product's UI belongs in the React
 * artifacts, not here.
 */

import { Router, type IRouter, type Request } from "express";
import express from "express";
import { DEALERS, DEALS } from "../deals.ts";
import { layout } from "./shell.ts";
import { context, COOKIE, type Ctx } from "./context.ts";
import {
  dashboardPage,
  dealsPage,
  dealDetailPage,
  panelPage,
  policiesPage,
  remindersPage,
  servicePage,
  stockPage,
} from "./pages.ts";
import {
  commitPolicy,
  findDeal,
  issueStep1,
  issueStep2,
  policyPage,
  saveDraft,
} from "./issue.ts";
import { fullName } from "./context.ts";

const router: IRouter = Router();
router.use(express.urlencoded({ extended: false, limit: "64kb" }));

/** Wraps a page body in the shell, filling the chrome from context. */
function page(
  ctx: Ctx,
  opts: {
    title: string;
    active: string;
    heading: string;
    sub?: string;
    breadcrumb?: { label: string; href?: string }[];
    actions?: string;
    body: string;
  },
): string {
  return layout({
    title: opts.title,
    active: opts.active,
    heading: opts.heading,
    sub: opts.sub,
    breadcrumb: opts.breadcrumb,
    actions: opts.actions,
    body: opts.body,
    dealerName: ctx.dealer.dealerName,
    dealerCode: ctx.dealer.dealerCode,
    dealerCity: ctx.dealer.addr.cityDesc,
    userName: ctx.user.name,
    userRole: ctx.user.role,
    nav: ctx.nav,
    dealers: ctx.dealers,
  });
}

/**
 * Form fields from a POST, tolerating a missing body.
 *
 * Express 5 leaves `req.body` **undefined** when no parser matched — a POST with
 * no `Content-Type` never reaches `express.urlencoded`, so reading it directly
 * throws. A browser form always sets the header, but "the browser always does the
 * right thing" is not a safe assumption for a handler, and a 500 is a poor answer
 * to an empty request.
 */
function formBody(req: Request): Record<string, string> {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

function notFound(ctx: Ctx, what: string): string {
  return page(ctx, {
    title: "Not found",
    active: "",
    heading: "Not found",
    body: `<div class="card"><p class="empty">${what}</p></div>`,
  });
}

// ── Dealer switch ───────────────────────────────────────────────────────────

router.get("/portal/switch", (req, res) => {
  const code = String(req.query.dealerCode ?? "");
  if (DEALERS[code]) {
    // Demo shell: a cookie naming the tenant, with nothing verifying it. The
    // point is to show the same screens over a different panel and worklist.
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(code)}; Path=/; SameSite=Lax`);
  }
  res.redirect("/portal");
});

// ── Dashboard ───────────────────────────────────────────────────────────────

router.get("/portal", (req, res) => {
  const ctx = context(req);
  res.type("html").send(
    page(ctx, {
      title: "Dashboard",
      active: "/portal",
      heading: "Dashboard",
      sub: "Showroom, insurance and after-sales at a glance.",
      body: dashboardPage(ctx),
    }),
  );
});

// ── Deals ───────────────────────────────────────────────────────────────────

router.get("/portal/deals", (req, res) => {
  const ctx = context(req);
  res.type("html").send(
    page(ctx, {
      title: "Deals",
      active: "/portal/deals",
      heading: "Deals",
      sub: "Every booking at this dealership, whatever stage it has reached.",
      body: dealsPage(ctx, { q: req.query.q ? String(req.query.q) : undefined }),
    }),
  );
});

router.get("/portal/insurance", (req, res) => {
  const ctx = context(req);
  const n = ctx.deals.filter((d) => d.status === "AWAITING_INSURANCE").length;
  res.type("html").send(
    page(ctx, {
      title: "Issuance queue",
      active: "/portal/insurance",
      heading: "Issuance queue",
      sub: `${n} vehicle${n === 1 ? "" : "s"} cannot be registered until a policy exists. Fewest
            missing details first — those are the quickest to close.`,
      body: dealsPage(ctx, { onlyAwaiting: true, q: req.query.q ? String(req.query.q) : undefined }),
    }),
  );
});

router.get("/portal/deals/:dealId", (req, res) => {
  const ctx = context(req);
  const deal = findDeal(req.params.dealId);
  if (!deal) {
    res.status(404).type("html").send(notFound(ctx, `No deal ${req.params.dealId}.`));
    return;
  }
  res.type("html").send(
    page(ctx, {
      title: deal.dealId,
      active: "/portal/deals",
      heading: fullName(deal.customer),
      sub: `${deal.vehicle.model.modelDesc} · ${deal.dealId}`,
      breadcrumb: [{ label: "Deals", href: "/portal/deals" }, { label: deal.dealId }],
      actions:
        deal.status === "AWAITING_INSURANCE"
          ? `<a class="btn pri" href="/portal/deals/${deal.dealId}/issue">Issue insurance</a>`
          : undefined,
      body: dealDetailPage(ctx, deal),
    }),
  );
});

// ── Issuance flow ───────────────────────────────────────────────────────────

router.get("/portal/deals/:dealId/issue", (req, res) => {
  const ctx = context(req);
  const deal = findDeal(req.params.dealId);
  if (!deal) {
    res.status(404).type("html").send(notFound(ctx, `No deal ${req.params.dealId}.`));
    return;
  }
  // Already insured — showing the wizard again would invite a duplicate policy.
  if (deal.insurance.policyNo) {
    res.redirect(`/portal/policies/${encodeURIComponent(deal.insurance.policyNo)}`);
    return;
  }
  res.type("html").send(
    page(ctx, {
      title: "Issue insurance",
      active: "/portal/insurance",
      heading: "Issue insurance",
      sub: `${fullName(deal.customer)} · ${deal.vehicle.model.modelDesc}`,
      breadcrumb: [
        { label: "Issuance queue", href: "/portal/insurance" },
        { label: deal.dealId, href: `/portal/deals/${deal.dealId}` },
        { label: "Issue" },
      ],
      body: issueStep1(ctx, deal),
    }),
  );
});

router.post("/portal/deals/:dealId/quote", (req, res) => {
  const ctx = context(req);
  const deal = findDeal(req.params.dealId);
  if (!deal) {
    res.status(404).type("html").send(notFound(ctx, `No deal ${req.params.dealId}.`));
    return;
  }

  const answers = formBody(req);
  // Dates arrive from <input type="date"> as ISO; the DMS speaks DD-MM-YYYY.
  for (const key of ["dob", "nomineeDob"]) {
    const iso = answers[key]?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) answers[key] = `${iso[3]}-${iso[2]}-${iso[1]}`;
  }
  saveDraft(deal.dealId, answers);

  res.type("html").send(
    page(ctx, {
      title: "Choose insurer",
      active: "/portal/insurance",
      heading: "Choose insurer",
      sub: `${fullName(deal.customer)} · ${deal.vehicle.model.modelDesc} · ${
        deal.vehicle.model.fuel === "ELECTRIC"
          ? `${deal.vehicle.model.motorKw} kW`
          : `${deal.vehicle.model.cc} cc`
      }`,
      breadcrumb: [
        { label: "Issuance queue", href: "/portal/insurance" },
        { label: deal.dealId, href: `/portal/deals/${deal.dealId}` },
        { label: "Quotes" },
      ],
      body: issueStep2(ctx, deal),
    }),
  );
});

router.post("/portal/deals/:dealId/commit", (req, res) => {
  const ctx = context(req);
  const deal = findDeal(req.params.dealId);
  if (!deal) {
    res.status(404).type("html").send(notFound(ctx, `No deal ${req.params.dealId}.`));
    return;
  }

  const insurerCode = formBody(req).insurerCode ?? "";
  const policyNo = commitPolicy(ctx, deal, insurerCode);
  if (!policyNo) {
    res
      .status(400)
      .type("html")
      .send(
        notFound(
          ctx,
          `${insurerCode} is not available on this dealership's panel, or its quota is exhausted.`,
        ),
      );
    return;
  }

  res.type("html").send(
    page(ctx, {
      title: "Policy issued",
      active: "/portal/insurance",
      heading: "Policy issued",
      sub: `${policyNo} · ${fullName(deal.customer)}`,
      breadcrumb: [
        { label: "Issuance queue", href: "/portal/insurance" },
        { label: deal.dealId, href: `/portal/deals/${deal.dealId}` },
        { label: "Issued" },
      ],
      body: policyPage(ctx, deal, true),
    }),
  );
});

// ── Policies ────────────────────────────────────────────────────────────────

router.get("/portal/policies", (req, res) => {
  const ctx = context(req);
  res.type("html").send(
    page(ctx, {
      title: "Policies",
      active: "/portal/policies",
      heading: "Policies",
      sub: "Issued at this dealership. Cover dates, IDV and premium as recorded.",
      body: policiesPage(ctx),
    }),
  );
});

router.get("/portal/policies/:policyNo", (req, res) => {
  const ctx = context(req);
  const deal = DEALS.find((d) => d.insurance.policyNo === req.params.policyNo);
  if (!deal) {
    res.status(404).type("html").send(notFound(ctx, `No policy ${req.params.policyNo}.`));
    return;
  }
  res.type("html").send(
    page(ctx, {
      title: deal.insurance.policyNo ?? "Policy",
      active: "/portal/policies",
      heading: "Policy schedule",
      sub: `${deal.insurance.policyNo} · ${fullName(deal.customer)}`,
      breadcrumb: [
        { label: "Policies", href: "/portal/policies" },
        { label: deal.insurance.policyNo ?? "" },
      ],
      body: policyPage(ctx, deal, false),
    }),
  );
});

// ── Remaining sections ──────────────────────────────────────────────────────

router.get("/portal/stock", (req, res) => {
  const ctx = context(req);
  res.type("html").send(
    page(ctx, {
      title: "Stock",
      active: "/portal/stock",
      heading: "Stock & allotment",
      sub: "Physical units in the yard, and what each is allotted to.",
      body: stockPage(ctx),
    }),
  );
});

router.get("/portal/panel", (req, res) => {
  const ctx = context(req);
  res.type("html").send(
    page(ctx, {
      title: "Insurer panel",
      active: "/portal/panel",
      heading: "Insurer panel",
      sub: "Who this dealership can place business with, how it reaches them, and how much of each commitment is already used.",
      body: panelPage(ctx),
    }),
  );
});

router.get("/portal/service", (req, res) => {
  const ctx = context(req);
  res.type("html").send(
    page(ctx, {
      title: "Service & warranty",
      active: "/portal/service",
      heading: "Service & warranty",
      sub: "Derived from the delivery date and the model's schedule. Free services must be taken at an authorised workshop to keep the warranty valid.",
      body: servicePage(ctx),
    }),
  );
});

router.get("/portal/reminders", (req, res) => {
  const ctx = context(req);
  res.type("html").send(
    page(ctx, {
      title: "Reminders",
      active: "/portal/reminders",
      heading: "Reminders",
      sub: "Policy expiry and service milestones falling due.",
      body: remindersPage(ctx),
    }),
  );
});

export default router;
