/**
 * Per-request context and shared view helpers.
 *
 * "Who is logged in" is a cookie holding a dealer code, and nothing more. There
 * is no password, no session store and no authorisation — this is a demo shell,
 * and pretending otherwise would invite someone to reuse it. The dealer switcher
 * in the top bar exists precisely so the multi-tenant story can be shown: the
 * same screens, a different panel, a different worklist.
 */

import type { Request } from "express";
import { DEALERS, DEALS } from "../deals.ts";
import type { DmsDeal, DmsDealer } from "../types.ts";
import { esc, type NavSection } from "./shell.ts";

export const COOKIE = "dms_dealer";
export const DEFAULT_DEALER = "HMC-DL-0417";

/** Fictional staff, one per dealership, so the top bar is not empty. */
const USERS: Record<string, { name: string; role: string }> = {
  "HMC-DL-0417": { name: "Vikram Chandel", role: "Sales Manager" },
  "HMC-MH-1182": { name: "Prashant Kulkarni", role: "Sales Executive" },
};

export interface Ctx {
  dealer: DmsDealer;
  user: { name: string; role: string };
  deals: DmsDeal[];
  nav: NavSection[];
  dealers: { code: string; name: string }[];
}

/** Reads the dealer cookie without a cookie-parser dependency. */
function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function context(req: Request): Ctx {
  const code = readCookie(req, COOKIE) ?? DEFAULT_DEALER;
  const dealer = DEALERS[code] ?? DEALERS[DEFAULT_DEALER];
  const deals = DEALS.filter((d) => d.dealerCode === dealer.dealerCode);

  const awaiting = deals.filter((d) => d.status === "AWAITING_INSURANCE").length;
  const serviceDue = deals
    .filter((d) => d.actualDeliveryDt)
    .filter((d) => d.status === "DELIVERED").length;

  return {
    dealer,
    user: USERS[dealer.dealerCode] ?? { name: "Demo User", role: "Sales" },
    deals,
    dealers: Object.values(DEALERS).map((d) => ({ code: d.dealerCode, name: d.dealerName })),
    nav: [
      {
        title: "Showroom",
        items: [
          { href: "/portal", label: "Dashboard", icon: "grid" },
          { href: "/portal/deals", label: "Deals", icon: "clipboard", badge: awaiting || null },
          { href: "/portal/stock", label: "Stock & Allotment", icon: "box" },
        ],
      },
      {
        title: "Insurance",
        items: [
          {
            href: "/portal/insurance",
            label: "Issuance Queue",
            icon: "shield",
            badge: awaiting || null,
          },
          { href: "/portal/policies", label: "Policies", icon: "file" },
          { href: "/portal/panel", label: "Insurer Panel", icon: "users" },
        ],
      },
      {
        title: "After Sales",
        items: [
          { href: "/portal/service", label: "Service & Warranty", icon: "wrench" },
          { href: "/portal/reminders", label: "Reminders", icon: "bell", badge: serviceDue || null },
        ],
      },
    ],
  };
}

// ── view helpers ────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `28-07-2026` → `28 Jul 2026`. Returns an em dash for null. */
export function human(dmsDate: string | null): string {
  if (!dmsDate) return "—";
  const m = dmsDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return dmsDate;
  return `${m[1]} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[3]}`;
}

export function fullName(c: DmsDeal["customer"]): string {
  return [c.salutation, c.firstName, c.midName, c.lastName].filter(Boolean).join(" ");
}

/** Engine capacity or motor rating, whichever the model is rated on. */
export function ratingBasis(deal: DmsDeal): string {
  const m = deal.vehicle.model;
  return m.fuel === "ELECTRIC" ? `${m.motorKw} kW` : `${m.cc} cc`;
}

/**
 * What is missing that blocks issuance.
 *
 * Deliberately not a boolean. The dealer needs to know *which* field to collect,
 * and the count drives the queue's sort order — a deal needing one phone call is
 * more actionable than one needing three.
 */
export interface Gap {
  field: string;
  label: string;
  why: string;
}

export function gaps(deal: DmsDeal): Gap[] {
  const out: Gap[] = [];
  const individual = deal.customer.custType === "INDIVIDUAL";

  if (individual && !deal.nominee.nomineeName) {
    out.push({
      field: "nomineeName",
      label: "Nominee",
      why: "Compulsory ₹15 lakh owner-driver PA cover cannot be issued without a nominee. No customer document carries this — it must be asked.",
    });
  }
  if (!deal.customer.emailId) {
    out.push({
      field: "emailId",
      label: "Email",
      why: "The policy document is delivered by email. No document carries it.",
    });
  }
  if (individual && !deal.customer.dob) {
    out.push({ field: "dob", label: "Date of birth", why: "Required on the proposal form." });
  }
  if (!deal.customer.mobileNo) {
    out.push({ field: "mobileNo", label: "Mobile", why: "Required on the proposal form." });
  }
  return out;
}

export function statusChip(status: DmsDeal["status"]): string {
  const map: Record<DmsDeal["status"], [string, string]> = {
    BOOKED: ["neu", "Booked"],
    AWAITING_INSURANCE: ["warn", "Awaiting insurance"],
    AWAITING_REGISTRATION: ["info", "Awaiting registration"],
    DELIVERED: ["ok", "Delivered"],
    CANCELLED: ["err", "Cancelled"],
  };
  const [cls, label] = map[status];
  return `<span class="chip ${cls}"><span class="dot"></span>${label}</span>`;
}

/** Renders a value, or a visible "not captured" marker so gaps cannot hide. */
export function orMissing(value: string | null | undefined, what = "Not captured"): string {
  return value ? esc(value) : `<span class="miss">${esc(what)}</span>`;
}

export function money(n: number | string | null): string {
  if (n === null) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return `₹${new Intl.NumberFormat("en-IN").format(Math.round(v))}`;
}
