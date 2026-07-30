/**
 * Service-schedule derivation.
 *
 * Not stored anywhere — computed from the delivery date plus the model's
 * milestone table. This is the data a reminder agent would consume: "your
 * second free service is due by 26-03-2027 or 4,000 km, whichever comes first".
 *
 * The schedule only exists once the vehicle is actually delivered. Before that
 * there is no clock to count from, so an undelivered deal returns an empty
 * schedule rather than dates measured from the booking.
 *
 * Km status cannot be determined here — the DMS does not know the odometer
 * between workshop visits. Status is therefore date-only, and a km-based due
 * point can arrive earlier than the date suggests. A real integration reads the
 * last recorded odometer from the workshop module to close that gap.
 */

import type {
  DmsDate,
  DmsDeal,
  DmsModel,
  DmsServiceSchedule,
  DmsServiceScheduleEntry,
} from "./types.ts";

/** `DD-MM-YYYY` → Date (UTC midnight). Returns null on anything unparseable. */
export function parseDmsDate(value: DmsDate | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  // Reject impossible dates that Date silently rolls over (e.g. 31-02-2026).
  if (d.getUTCDate() !== Number(dd) || d.getUTCMonth() !== Number(mm) - 1) return null;
  return d;
}

/** Date → `DD-MM-YYYY`. */
export function formatDmsDate(d: Date): DmsDate {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/**
 * Classify a milestone against today.
 *
 * "DUE" is a 30-day window before the target so a reminder has somewhere to
 * land — firing on the due date itself is useless to a customer who needs to
 * book a slot.
 */
function statusFor(dueBy: Date, today: Date): DmsServiceScheduleEntry["status"] {
  const daysOut = Math.floor((dueBy.getTime() - today.getTime()) / 86_400_000);
  if (daysOut < 0) return "OVERDUE";
  if (daysOut <= 30) return "DUE";
  return "PENDING";
}

/**
 * How many paid services to project past the free ones.
 *
 * Bounded rather than open-ended: the list is for reminders, and nobody needs a
 * paid-service date five years out. Projection stops at the warranty horizon,
 * because staying inside the authorised-workshop schedule is what keeps the
 * warranty alive — after it lapses, the reminder has no leverage.
 */
const MAX_PROJECTED_PAID_SERVICES = 8;

export function buildServiceSchedule(deal: DmsDeal): DmsServiceSchedule {
  const model: DmsModel = deal.vehicle.model;
  const delivered = parseDmsDate(deal.actualDeliveryDt);
  const today = new Date();

  const base: DmsServiceSchedule = {
    dealId: deal.dealId,
    chassisNo: deal.vehicle.chassisNo,
    warrantyStartDt: deal.actualDeliveryDt,
    warrantyEndDt: delivered ? formatDmsDate(addMonths(delivered, model.warrantyMonths)) : null,
    warrantyKm: model.warrantyKm,
    entries: [],
  };

  // No delivery, no clock. Returning speculative dates from the booking would
  // be worse than returning nothing.
  if (!delivered) return base;

  const warrantyEnd = addMonths(delivered, model.warrantyMonths);

  for (const ms of model.freeServices) {
    const dueBy = addDays(delivered, ms.days);
    base.entries.push({
      seq: ms.seq,
      kind: "FREE",
      dueByDt: formatDmsDate(dueBy),
      dueByKm: ms.km,
      status: statusFor(dueBy, today),
    });
  }

  const lastFree = model.freeServices.at(-1);
  let cursorDays = lastFree?.days ?? 0;
  let cursorKm = lastFree?.km ?? 0;
  let seq = (lastFree?.seq ?? 0) + 1;

  for (let i = 0; i < MAX_PROJECTED_PAID_SERVICES; i += 1) {
    cursorDays += model.paidServiceIntervalDays;
    cursorKm += model.paidServiceIntervalKm;
    const dueBy = addDays(delivered, cursorDays);
    if (dueBy > warrantyEnd) break;
    base.entries.push({
      seq,
      kind: "PAID",
      dueByDt: formatDmsDate(dueBy),
      dueByKm: cursorKm,
      status: statusFor(dueBy, today),
    });
    seq += 1;
  }

  return base;
}
