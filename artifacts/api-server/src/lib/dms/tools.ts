/**
 * The typed tools the explanation panel reads through.
 *
 * Six functions, each owner-scoped, each returning rows. Between them they
 * answer the three questions a worklist row raises and cannot itself answer:
 * *why is this stuck*, *who else is affected*, *what happens if it waits*.
 *
 * ## Why a registry rather than query access
 *
 * The panel has a model in it, and a model with a database connection is a
 * model that can be talked into reading another dealership's customers. These
 * are ordinary functions with typed arguments: the owner id comes from the
 * session and is never a parameter, the tool names are a closed set, and
 * anything not listed here is unreachable no matter what the model asks for.
 * Row-level security is still underneath as the backstop, which is the same
 * arrangement as everywhere else in this codebase — the difference is that here
 * the caller is not a person.
 *
 * ## Nothing here decides anything
 *
 * Every tool returns what a query returned. None of them classifies, and the
 * one that looks like it does — `recordState` — is reading the *module's own*
 * `classify()` rather than forming a view. That is R-49 at the data layer: the
 * rules decide what is wrong, and the panel is only allowed to look up why.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  decisionLogTable,
  dmsEmployeesTable,
  entityLinksTable,
  entitiesTable,
  outboundMessagesTable,
} from "@workspace/db";
import { buildDossier } from "./entity-graph";
import { buildLeadWorklist } from "./lead-worklist";
import { buildRegistrationWorklist } from "./registration-worklist";
import { buildServiceWorklist } from "./service-worklist";
import { buildSparesWorklist } from "./spares-worklist";

export type ExplainModule = "JOB_CARD" | "ENQUIRY" | "REGISTRATION" | "PART";

export interface ToolContext {
  ownerId: number;
  showroomId: number;
  ownerShowroomIds: number[];
  module: ExplainModule;
  recordKey: string;
}

/**
 * One tool call and what it returned.
 *
 * The `rows` are the citation. An answer that cannot point at one of these for
 * a claim is an answer that made the claim up, and the panel is built so that
 * the evidence travels to the screen rather than being summarised away.
 */
export interface Evidence {
  tool: string;
  /** What this tool went and looked at, in a sentence, for the person reading. */
  looked: string;
  rows: Array<Record<string, unknown>>;
}

// ── The row itself ──────────────────────────────────────────────────────────

/**
 * What the module's own screen says about this record.
 *
 * Deliberately reads through `build…Worklist` rather than the mirror table.
 * Re-deriving the state here would be faster and would drift the first time a
 * rule changed in one place and not the other — and of all the places for the
 * product to contradict itself, an explanation of *why a row says what it says*
 * is the worst.
 */
export async function recordState(ctx: ToolContext): Promise<Evidence> {
  const looked = `the ${label(ctx.module)} screen's own reading of ${ctx.recordKey}`;

  if (ctx.module === "JOB_CARD") {
    const rows = await buildServiceWorklist({ showroomId: ctx.showroomId });
    const r = rows.find((x) => x.jcNo === ctx.recordKey);
    if (!r) return { tool: "record_state", looked, rows: [] };
    return {
      tool: "record_state",
      looked,
      rows: [
        {
          jobCard: r.jcNo,
          customer: r.customerName,
          vehicle: r.modelDescription,
          workshopStatus: r.dms.status,
          state: r.state,
          why: r.note,
          whatIsNeeded: r.actionRequired,
          promisedDate: r.dms.promisedDate,
          daysLate: r.daysLate,
          waitingOnAPart: r.dms.hasUnissuedPart,
          customerToldAt: r.ddms.customerInformedAt,
        },
      ],
    };
  }

  if (ctx.module === "REGISTRATION") {
    const rows = await buildRegistrationWorklist({ showroomId: ctx.showroomId });
    const r = rows.find((x) => x.regnFileNo === ctx.recordKey);
    if (!r) return { tool: "record_state", looked, rows: [] };
    return {
      tool: "record_state",
      looked,
      rows: [
        {
          file: r.regnFileNo,
          customer: r.customerName,
          vehicle: r.modelDescription,
          state: r.state,
          why: r.note,
          whatIsNeeded: r.actionRequired,
          rtoObjection: r.dms.objectionDesc,
          documentOutstanding: r.dms.pendingDoc,
          roadTaxHeld: r.dms.roadTaxPaidDate ? null : r.dms.roadTaxAmount,
          ageDays: r.ageDays,
          tempRegDaysLeft: r.tempRegDaysLeft,
          certificateHeldDays: r.rcHeldDays,
          assignedTo: r.ddms.assignedAgentEmpCode,
        },
      ],
    };
  }

  if (ctx.module === "ENQUIRY") {
    const rows = await buildLeadWorklist({ showroomId: ctx.showroomId });
    const r = rows.find((x) => x.enqId === ctx.recordKey);
    if (!r) return { tool: "record_state", looked, rows: [] };
    return {
      tool: "record_state",
      looked,
      rows: [
        {
          enquiry: r.enqId,
          customer: r.customerName,
          interestedIn: r.modelInterest,
          source: r.dms.source,
          state: r.state,
          why: r.note,
          whatIsNeeded: r.actionRequired,
          theHonestLimit: r.slaNote,
          minutesToFirstContact: r.responseMinutes,
          assignedTo: r.dms.assignedEmpName,
          assignedPersonStillHere: r.dms.assignedEmpActive,
          weLoggedAContactAt: r.ddms.contactedAt,
        },
      ],
    };
  }

  const rows = await buildSparesWorklist({
    showroomId: ctx.showroomId,
    ownerShowroomIds: ctx.ownerShowroomIds,
  });
  const r = rows.find((x) => x.partNo === ctx.recordKey);
  if (!r) return { tool: "record_state", looked, rows: [] };
  return {
    tool: "record_state",
    looked,
    rows: [
      {
        part: r.partNo,
        description: r.partDesc,
        state: r.state,
        why: r.note,
        whatIsNeeded: r.actionRequired,
        onShelf: r.dms.qtyOnHand,
        promisedToJobCards: r.dms.qtyReserved,
        freeToIssue: r.dms.qtyFree,
        reorderLevel: r.dms.reorderLevel,
        onOrder: r.dms.onOrderQty,
        idleCapital: r.idleCapital,
      },
    ],
  };
}

// ── Who else is affected ────────────────────────────────────────────────────

/**
 * Everything else open against the same person, across every outlet.
 *
 * This is the tool that could not have existed before the entity graph, and it
 * is the reason the graph was built first. A dealership's own system keys
 * everything by module and by dealer code, so "this customer is also waiting on
 * a registration certificate at the other branch" is not a hard question there,
 * it is an unaskable one.
 */
export async function whoElseIsAffected(ctx: ToolContext): Promise<Evidence> {
  const looked = "every other open record belonging to the same customer, across all outlets";

  const [link] = await db
    .select({ entityId: entityLinksTable.entityId })
    .from(entityLinksTable)
    .innerJoin(entitiesTable, eq(entitiesTable.id, entityLinksTable.entityId))
    .where(
      and(
        eq(entityLinksTable.ownerId, ctx.ownerId),
        eq(entityLinksTable.module, ctx.module === "PART" ? "JOB_CARD" : ctx.module),
        eq(entityLinksTable.recordKey, ctx.recordKey),
        eq(entitiesTable.kind, "CUSTOMER"),
      ),
    );

  if (!link) return { tool: "who_else_is_affected", looked, rows: [] };

  const dossier = await buildDossier(ctx.ownerId, link.entityId);
  if (!dossier) return { tool: "who_else_is_affected", looked, rows: [] };

  return {
    tool: "who_else_is_affected",
    looked: `${looked} — ${dossier.entity.displayName ?? "this customer"}`,
    rows: dossier.records
      // The record being explained is not news to whoever is reading.
      .filter((r) => !(r.module === ctx.module && r.recordKey === ctx.recordKey))
      .map((r) => ({
        module: r.module,
        record: r.recordKey,
        outlet: r.showroomCode,
        what: r.title,
        state: r.state,
        whatIsNeeded: r.actionRequired,
        ageDays: r.ageDays,
      })),
  };
}

/**
 * Everybody else waiting on the same part, and where there is one free.
 *
 * Runs for a part and for a job card alike: from the workshop's end the
 * question is "who else does this shortage hold up", and from the counter's end
 * it is the same list read the other way.
 */
export async function samePartWaiting(ctx: ToolContext): Promise<Evidence> {
  const looked = "the parts ledger across every outlet this owner holds";
  if (ctx.module !== "PART") return { tool: "same_part_waiting", looked, rows: [] };

  const rows = await buildSparesWorklist({
    showroomId: ctx.showroomId,
    ownerShowroomIds: ctx.ownerShowroomIds,
  });
  const r = rows.find((x) => x.partNo === ctx.recordKey);
  if (!r) return { tool: "same_part_waiting", looked, rows: [] };

  return {
    tool: "same_part_waiting",
    looked,
    rows: [
      ...r.waitingJobCards.map((w) => ({
        kind: "waiting",
        jobCard: w.jcNo,
        customer: w.customerName,
        daysWaiting: w.daysWaiting,
      })),
      ...r.availableAt.map((a) => ({
        kind: "free at another outlet",
        outlet: a.showroomCode,
        qtyFree: a.qtyFree,
        bin: a.binLocation,
      })),
      ...r.shortAt.map((s) => ({
        kind: "short at another outlet",
        outlet: s.showroomCode,
        qtyFree: s.qtyFree,
        reorderLevel: s.reorderLevel,
        onOrder: s.onOrderQty,
      })),
    ],
  };
}

// ── Who is carrying it ──────────────────────────────────────────────────────

/**
 * The person this record is on, whether they still work here, and what else
 * they are holding.
 *
 * The load figure is the one that turns a staffing anecdote into an argument.
 * One RTO agent with nine open files is not a scheduling problem, and a screen
 * that names the agent without the number invites handing them a tenth.
 */
export async function whoIsCarryingIt(ctx: ToolContext, empCode: string | null): Promise<Evidence> {
  const looked = "the staff master and everything currently assigned to that person";
  if (!empCode) return { tool: "who_is_carrying_it", looked, rows: [] };

  const [emp] = await db
    .select({
      empCode: dmsEmployeesTable.empCode,
      empName: dmsEmployeesTable.empName,
      role: dmsEmployeesTable.role,
      isActive: dmsEmployeesTable.isActive,
      dateOfLeaving: dmsEmployeesTable.dateOfLeaving,
      emailId: dmsEmployeesTable.emailId,
    })
    .from(dmsEmployeesTable)
    .where(
      and(
        eq(dmsEmployeesTable.showroomId, ctx.showroomId),
        eq(dmsEmployeesTable.empCode, empCode),
      ),
    );

  if (!emp) return { tool: "who_is_carrying_it", looked, rows: [] };

  const [enquiries, registrations] = await Promise.all([
    buildLeadWorklist({ showroomId: ctx.showroomId }),
    buildRegistrationWorklist({ showroomId: ctx.showroomId }),
  ]);

  const theirs = [
    ...enquiries
      .filter((e) => (e.ddms.reassignedToEmpCode ?? e.dms.assignedEmpCode) === empCode)
      .map((e) => ({ module: "ENQUIRY", record: e.enqId, state: e.state })),
    ...registrations
      .filter((r) => (r.ddms.assignedAgentEmpCode ?? r.agentEmpCode) === empCode)
      .map((r) => ({ module: "REGISTRATION", record: r.regnFileNo, state: r.state })),
  ];

  return {
    tool: "who_is_carrying_it",
    looked,
    rows: [
      {
        name: emp.empName,
        role: emp.role,
        stillEmployed: emp.isActive === "Y",
        leftOn: emp.dateOfLeaving,
        email: emp.emailId,
        openRecordsCarried: theirs.length,
      },
      ...theirs,
    ],
  };
}

// ── What happens if it waits ────────────────────────────────────────────────

/**
 * The deadlines already implied by the record, made explicit.
 *
 * Every figure here is subtraction over dates the dealer's own system holds.
 * That matters more than it sounds: "what happens if this waits another week"
 * is exactly the question somebody would otherwise be tempted to ask a model,
 * and it is arithmetic. A model that guessed it would be wrong occasionally and
 * confident always.
 */
export async function whatTheClockSays(ctx: ToolContext): Promise<Evidence> {
  const looked = "the dates on the record, and what they run out of";
  const rows: Array<Record<string, unknown>> = [];

  if (ctx.module === "REGISTRATION") {
    const all = await buildRegistrationWorklist({ showroomId: ctx.showroomId });
    const r = all.find((x) => x.regnFileNo === ctx.recordKey);
    if (r) {
      if (r.tempRegDaysLeft !== null) {
        rows.push(
          r.tempRegDaysLeft < 0
            ? {
                clock: "temporary registration",
                status: "already lapsed",
                daysAgo: Math.abs(r.tempRegDaysLeft),
                consequence: "the vehicle is on the road unregistered",
              }
            : {
                clock: "temporary registration",
                status: "running",
                daysLeft: r.tempRegDaysLeft,
                lapsesOn: r.dms.tempRegExpiryDate,
                inAWeek: r.tempRegDaysLeft - 7 < 0 ? "will have lapsed" : "still valid",
              },
        );
      }
      if (r.dms.roadTaxAmount && !r.dms.roadTaxPaidDate) {
        rows.push({
          clock: "road tax",
          status: "collected from the customer, not remitted",
          amount: r.dms.roadTaxAmount,
          collectedOn: r.dms.roadTaxCollectedDate,
          consequence: "the file cannot be lodged until it goes",
        });
      }
      if (r.rcHeldDays !== null) {
        rows.push({
          clock: "certificate in the drawer",
          daysHeld: r.rcHeldDays,
          inAWeek: r.rcHeldDays + 7,
        });
      }
      rows.push({ clock: "file age", days: r.ageDays, inAWeek: r.ageDays + 7 });
    }
  }

  if (ctx.module === "JOB_CARD") {
    const all = await buildServiceWorklist({ showroomId: ctx.showroomId });
    const r = all.find((x) => x.jcNo === ctx.recordKey);
    if (r) {
      rows.push({
        clock: "the promise made to the customer",
        promisedDate: r.dms.promisedDate,
        daysLate: r.daysLate,
        inAWeek: r.daysLate + 7,
        consequence: r.daysLate > 0 ? "already past it" : "still in hand",
      });
      rows.push({ clock: "days in this state", days: r.daysInStatus, inAWeek: r.daysInStatus + 7 });
    }
  }

  if (ctx.module === "ENQUIRY") {
    const all = await buildLeadWorklist({ showroomId: ctx.showroomId });
    const r = all.find((x) => x.enqId === ctx.recordKey);
    if (r) {
      rows.push({
        clock: "the manufacturer's response window",
        minutesTaken: r.responseMinutes,
        state: r.state,
        // Said plainly, because it is the one thing about this screen people
        // get wrong: our record of a call does not stop their clock (R-46).
        consequence:
          r.slaNote ??
          "the OEM measures their own first-contact field, which only a person keying it into their portal changes",
      });
      if (r.dms.nextFollowUpDate) {
        rows.push({ clock: "next follow-up", due: r.dms.nextFollowUpDate });
      }
    }
  }

  if (ctx.module === "PART") {
    const all = await buildSparesWorklist({
      showroomId: ctx.showroomId,
      ownerShowroomIds: ctx.ownerShowroomIds,
    });
    const r = all.find((x) => x.partNo === ctx.recordKey);
    if (r) {
      for (const w of r.waitingJobCards) {
        rows.push({
          clock: "a customer waiting",
          jobCard: w.jcNo,
          daysWaiting: w.daysWaiting,
          inAWeek: w.daysWaiting + 7,
        });
      }
      if (r.dms.onOrderQty > 0) {
        rows.push({ clock: "stock on order", qty: r.dms.onOrderQty, eta: r.dms.onOrderEtaDate });
      }
      if (r.daysSinceIssued !== null) {
        rows.push({
          clock: "days since it last moved",
          days: r.daysSinceIssued,
          idleCapital: r.idleCapital,
        });
      }
    }
  }

  return { tool: "what_the_clock_says", looked, rows };
}

// ── What has already been done ──────────────────────────────────────────────

/**
 * Everything DDMS has recorded against this record, and anything drafted about
 * it.
 *
 * The two together are the answer to "has anybody touched this", which is the
 * first thing somebody asks about a row that has been sitting for a fortnight
 * and the one thing the dealer's own system cannot say — because none of these
 * decisions live there.
 */
export async function whatWeHaveDone(ctx: ToolContext): Promise<Evidence> {
  const looked = "the decision log and the outbox for this record";

  const [decisions, messages] = await Promise.all([
    db
      .select({
        action: decisionLogTable.action,
        note: decisionLogTable.note,
        at: decisionLogTable.createdAt,
      })
      .from(decisionLogTable)
      .where(
        and(
          eq(decisionLogTable.ownerId, ctx.ownerId),
          eq(decisionLogTable.module, ctx.module),
          eq(decisionLogTable.recordKey, ctx.recordKey),
        ),
      )
      .orderBy(desc(decisionLogTable.createdAt))
      .limit(20),
    db
      .select({
        audience: outboundMessagesTable.audience,
        channel: outboundMessagesTable.channel,
        to: outboundMessagesTable.toName,
        status: outboundMessagesTable.status,
        basis: outboundMessagesTable.authorisedBasis,
        at: outboundMessagesTable.createdAt,
      })
      .from(outboundMessagesTable)
      .where(
        and(
          eq(outboundMessagesTable.ownerId, ctx.ownerId),
          eq(outboundMessagesTable.module, ctx.module),
          eq(outboundMessagesTable.recordKey, ctx.recordKey),
          inArray(outboundMessagesTable.status, [
            "DRAFT",
            "APPROVED",
            "SENT",
            "HELD_NO_TRANSPORT",
          ]),
        ),
      )
      .orderBy(desc(outboundMessagesTable.createdAt))
      .limit(10),
  ]);

  return {
    tool: "what_we_have_done",
    looked,
    rows: [
      ...decisions.map((d) => ({
        kind: "decision",
        what: d.action,
        note: d.note,
        at: d.at?.toISOString?.() ?? d.at,
      })),
      ...messages.map((m) => ({
        kind: "message",
        audience: m.audience,
        channel: m.channel,
        to: m.to,
        status: m.status,
        authorisedBy: m.basis,
        at: m.at?.toISOString?.() ?? m.at,
      })),
    ],
  };
}

function label(module: ExplainModule): string {
  return module === "JOB_CARD"
    ? "workshop"
    : module === "REGISTRATION"
      ? "registration"
      : module === "ENQUIRY"
        ? "enquiries"
        : "spares";
}
