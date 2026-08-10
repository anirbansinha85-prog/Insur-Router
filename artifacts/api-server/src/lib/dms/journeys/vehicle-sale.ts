/**
 * **Booking → invoice → out of the door.**
 *
 * The second journey, and the one that proves the first was a model rather than
 * a special case. It reads entirely different tables, walks a different module,
 * has a different ending, and the runtime that walks both did not change.
 *
 * It also closes the loop Anirban pointed at: *from lead generation to
 * pre-sales, from sale confirmation to finance and invoicing — there are plenty
 * of journeys, and the main one you have not listed.* This is the second half
 * of it. Where it finishes, `VEHICLE_DELIVERY` begins, and that journey's
 * `INSURED` step already knows how to say *waiting on another process*.
 *
 * ## The step this objective exists for
 *
 * `INVOICED` is the first thing in DDMS that produces a queue row which is not
 * a problem:
 *
 * > **Invoices are not late because typing is hard. They are late because
 * > nobody noticed the deal became ready.**
 *
 * A dealership working down a list of things going wrong has no line of sight
 * to the six deals that quietly became invoiceable overnight — a chassis got
 * allocated, a payment cleared. Each of those is money standing still, and none
 * of them is on anybody's screen today.
 *
 * ## Every fork is still a column test
 *
 * Is there a chassis, does a price list cover the model, has a document been
 * issued. R-78 unchanged: a model may write a sentence inside a step and may
 * never choose an edge.
 */

import type { JourneyDefinition, Step, Wait } from "./types";

export interface SaleFacts {
  dealerCode: string;
  dealId: string;
  showroomId: number;
  status: string;

  customerName: string | null;
  customerMobile: string | null;
  modelDescription: string | null;
  chassisNo: string | null;

  bookingDate: string | null;
  plannedDeliveryDate: string | null;
  actualDeliveryDate: string | null;

  /** The dealer's own invoice, from the mirror. */
  dmsInvoiceNo: string | null;
  dmsInvoiceDate: string | null;

  /** DDMS's own document, where one has been issued (OBJ-25). */
  documentReference: string | null;
  documentKind: string | null;
  documentDate: string | null;

  /** What a price list says this model costs today, and which list said it. */
  pricedAmount: number | null;
  priceListName: string | null;
  priceListEffectiveFrom: string | null;
  pricedOffCurrentList: boolean;

  disappeared: boolean;
  today: string;
}

function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

/** Either system's invoice counts. The customer has a document either way. */
function invoiced(f: SaleFacts): boolean {
  return Boolean(f.dmsInvoiceNo || f.documentReference);
}

const BOOKED: Step<SaleFacts> = {
  id: "BOOKED",
  title: "Booked",
  actor: "DMS",
  done: (f) => Boolean(f.bookingDate),
  wait: (): Wait => ({
    kind: "PERSON",
    who: "the salesman",
    why: "The deal exists in the dealer's system with no booking date on it.",
    todo: "Key the booking date in — nothing downstream can be dated without it",
    role: "SALES_EXEC",
  }),
};

/**
 * A booked deal with no vehicle against it.
 *
 * Not urgent early — a customer who booked yesterday is not waiting on
 * anything — and increasingly urgent as the promised delivery date approaches,
 * which is what the wait sentence says rather than what a severity table could.
 */
const ALLOCATED: Step<SaleFacts> = {
  id: "ALLOCATED",
  title: "Vehicle allocated",
  actor: "PERSON",
  severityState: () => "UNALLOCATED",
  done: (f) => Boolean(f.chassisNo),
  wait: (f): Wait => {
    const waiting = daysBetween(f.bookingDate, f.today);
    const until = daysBetween(f.today, f.plannedDeliveryDate ?? f.today);
    return {
      kind: "PERSON",
      who: "whoever allocates stock",
      why:
        `Booked ${waiting === null ? "" : plural(waiting, "day") + " ago "}with no chassis against it.` +
        (until !== null && f.plannedDeliveryDate
          ? until < 0
            ? ` The promised date was ${plural(-until, "day")} ago.`
            : ` It was promised in ${plural(until, "day")}.`
          : ""),
      todo: "Allocate a unit from the floor to this deal",
      role: "SALES_EXEC",
    };
  },
};

/**
 * The stall nothing in the product could previously describe.
 *
 * Not *the customer has not paid* and not *the RTO is slow*: **we cannot
 * invoice this because nobody has told us what the model costs.** It is an
 * onboarding gap rather than a dealership failure, and it is invisible until
 * something tries to price a sale — which is exactly what a journey does and a
 * classifier never did.
 */
const PRICEABLE: Step<SaleFacts> = {
  id: "PRICEABLE",
  title: "Price known",
  actor: "PERSON",
  severityState: () => "UNPRICED",
  done: (f) => f.pricedAmount !== null || invoiced(f),
  wait: (f): Wait => ({
    kind: "PERSON",
    who: "whoever keeps the price list",
    why: `No price list covers ${f.modelDescription ?? "this model"}, so nothing can be priced against it.`,
    todo: `Add ${f.modelDescription ?? "the model"} to a price list`,
    role: null,
  }),
};

/**
 * **The opportunity.**
 *
 * Everything before this is done: a customer, a vehicle, a price. The only
 * thing between the dealership and an invoice is somebody pressing the button —
 * and the row carries the figures so that pressing it is the whole action
 * rather than the start of one.
 */
const INVOICED: Step<SaleFacts> = {
  id: "INVOICED",
  title: "Invoiced",
  actor: "PERSON",
  severityState: () => "READY_TO_INVOICE",
  done: invoiced,
  wait: (f): Wait => {
    /*
     * A vehicle that has gone out with no invoice is not an opportunity.
     *
     * The distinction the first version missed, and it matters because it is
     * the difference between *here is money you can collect* and *you have
     * delivered a vehicle you never billed for*. Same step, same missing
     * document, opposite reading — and a row that called the second one an
     * opportunity would be the product being cheerful about an accounting hole.
     */
    if (f.actualDeliveryDate) {
      return {
        kind: "PERSON",
        who: "whoever invoices",
        why: `The vehicle went out on ${f.actualDeliveryDate} and nothing has been billed for it.`,
        todo: "Raise the invoice — the vehicle has already been handed over",
        role: "ACCOUNTS",
        tone: "PROBLEM",
      };
    }

    return {
      kind: "PERSON",
      who: "whoever invoices",
      why:
        `Everything this sale needs is in place — ${f.customerName ?? "the customer"}, ` +
        `${f.modelDescription ?? "the vehicle"}, chassis ${f.chassisNo}` +
        (f.pricedAmount !== null
          ? `, ${rupees(f.pricedAmount)} per ${f.priceListName}` +
            (f.pricedOffCurrentList ? "" : ` (effective ${f.priceListEffectiveFrom}, not the current list)`)
          : "") +
        ".",
      todo: "Generate the invoice",
      role: "ACCOUNTS",
      tone: "OPPORTUNITY",
    };
  },
};

const DELIVERED: Step<SaleFacts> = {
  id: "DELIVERED",
  title: "Vehicle delivered",
  actor: "PERSON",
  severityState: () => "UNDELIVERED",
  done: (f) => Boolean(f.actualDeliveryDate),
  wait: (f): Wait => {
    const since = daysBetween(f.dmsInvoiceDate ?? f.documentDate, f.today);
    return {
      kind: "PERSON",
      who: "the delivery desk",
      why:
        `Invoiced${since === null ? "" : ` ${plural(since, "day")} ago`} and not handed over. ` +
        "The vehicle is sold and still on the floor.",
      todo: "Hand the vehicle over, or record the date it went out",
      role: "SALES_EXEC",
    };
  },
};

export const VEHICLE_SALE: JourneyDefinition<SaleFacts> = {
  id: "VEHICLE_SALE",
  version: 1,
  title: "Booking to delivery",
  subjectModule: "DEAL",
  severityModule: "DEAL",
  steps: [BOOKED, ALLOCATED, PRICEABLE, INVOICED, DELIVERED],

  abandoned: (f) =>
    f.disappeared ? "The deal is no longer in the dealer's system." : null,

  /*
   * No assignee anywhere in the DMS's deal record, which is why every deal row
   * on the queue has always landed in the **Nobody's** band. That is honest
   * rather than a gap: a dealership that cannot say whose sale this is has a
   * real problem, and hiding it behind a default would be the product covering
   * for it.
   */
  assignee: () => ({ empCode: null, role: null }),

  label: (f) => ({
    title: f.customerName ?? f.dealId,
    subtitle: [f.modelDescription, f.chassisNo].filter(Boolean).join(" · ") || null,
  }),

  contact: (f) => ({ name: f.customerName, mobile: f.customerMobile }),

  loadFacts: async () => {
    throw new Error("loadFacts is attached in runtime.ts");
  },
};
