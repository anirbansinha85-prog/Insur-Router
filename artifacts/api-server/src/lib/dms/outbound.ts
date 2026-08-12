/**
 * The approval gate — the only place a message becomes something that may leave.
 *
 * Everything DDMS did before this was internal. A decision field changes what
 * an owner sees inside their own console and can be undone by whoever set it.
 * A message is different in every way that matters: somebody outside the
 * building reads it, it cannot be un-received, and it goes out under the
 * dealership's name.
 *
 * So the rule is stated once, here, and enforced in one function:
 *
 * > **Nothing leaves without either a rule permitting it or a person approving
 * > it** (R-48).
 *
 * `authoriseSend()` is that function. It is the only thing in the codebase that
 * may return a basis, and `sendMessage()` is the only thing that may write
 * `sentAt` — and it writes it only after `authoriseSend()` has said yes. A row
 * with a `sentAt` and no `authorisedBasis` is the state this file exists to
 * make unreachable.
 *
 * ## Which rules exist, and why there is only one
 *
 * Exactly one rule can permit a send without a person, and it covers internal
 * email to a member of staff about work already assigned to them (R-50).
 * Everything else — every message to a customer, without exception — needs
 * somebody signed in to approve it. There is no rule that can permit a customer
 * message and adding one is not a configuration change; it is a decision about
 * how much this product is trusted, and it belongs in this file where it can be
 * read.
 *
 * That rule also stops applying the moment somebody types into a draft (R-72).
 * It permits text a rule composed — checked, identical every time, reviewable
 * in `composer.ts`. A sentence a person wrote is none of those things, so an
 * unattended pass has nothing to stand on and the person who wrote it approves
 * it instead. Editing is therefore not a hole in the gate; it is the gate
 * routing a message down the path that suits who wrote it.
 *
 * ## No model is consulted here
 *
 * `composer.ts` may ask a model for better wording. This file never does
 * (R-49). Whether a message may be sent is knowable from the record, the
 * recipient and the audience, so it is a rule — and a rule that is right every
 * time beats a model that is right most of the time, especially when the
 * failure mode is a message a dealership has to apologise for.
 */

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  decisionLogTable,
  dmsEmployeesTable,
  outboundMessagesTable,
  showroomsTable,
  type OutboundMessageRow,
} from "@workspace/db";
import { deliver, statusFor } from "./channels";
import { logger } from "../logger";
import {
  draftAgentAssignment,
  draftLeadHandover,
  draftStatementOfAccount,
  draftRcReady,
  draftVehicleReady,
  finishDraft,
  type ComposedDraft,
  type MessageChannel,
} from "./composer";
import { buildLeadWorklist } from "./lead-worklist";
import { buildReceivablesWorklist } from "./receivables-worklist";
import { buildRegistrationWorklist } from "./registration-worklist";
import { buildServiceWorklist } from "./service-worklist";

export type TemplateId =
  | "SERVICE_VEHICLE_READY"
  | "REGISTRATION_RC_READY"
  | "REGISTRATION_AGENT_ASSIGNED"
  | "LEAD_HANDOVER"
  | "RECEIVABLE_STATEMENT";

export const TEMPLATE_IDS: ReadonlySet<string> = new Set<TemplateId>([
  "SERVICE_VEHICLE_READY",
  "REGISTRATION_RC_READY",
  "REGISTRATION_AGENT_ASSIGNED",
  "LEAD_HANDOVER",
  "RECEIVABLE_STATEMENT",
]);

// ── Transports ──────────────────────────────────────────────────────────────

/**
 * How a message actually goes, per channel (OBJ-27).
 *
 * This used to be an empty object with a long comment explaining that being
 * empty was the honest state of the system. It is no longer empty: WhatsApp
 * goes over Meta's Cloud API and email over SMTP, both in
 * `lib/dms/channels/`.
 *
 * **What has not changed is who owns the account.** There is no DDMS WhatsApp
 * number and no DDMS mail server. `deliver()` resolves the *dealership's own*
 * credential for the owner the message belongs to (R-106), and returns null
 * when they have not connected one — at which point this behaves exactly as it
 * did before, and the row says `HELD_NO_TRANSPORT` rather than showing a green
 * tick for something no customer received.
 *
 * The split is the whole of R-48. `authoriseSend()` above decides whether a
 * message *may* leave; everything here is plumbing. Plumbing that can authorise
 * is plumbing that will eventually authorise something nobody approved, so this
 * side of the line takes a message that has already been permitted and does not
 * look at the audience, the template or the basis.
 */
async function carry(
  ownerId: number,
  msg: OutboundMessageRow,
): Promise<{ ok: true; providerMessageId: string | null } | { ok: false; error: string } | null> {
  if (!msg.toAddress) return { ok: false, error: "The message has no recipient address on it." };

  const result = await deliver({
    ownerId,
    channel: msg.channel,
    to: msg.toAddress,
    subject: msg.subject,
    body: msg.body,
  });

  if (result === null) return null;
  return result.ok
    ? { ok: true, providerMessageId: result.providerMessageId ?? null }
    : { ok: false, error: result.error ?? "Delivery failed and the provider gave no reason." };
}

// ── The gate ────────────────────────────────────────────────────────────────

export type Authorisation =
  | { ok: true; basis: "RULE"; rule: string }
  | { ok: true; basis: "PERSON"; userId: number }
  | { ok: false; reason: string };

/**
 * The one rule that permits a send without a person.
 *
 * Narrow on purpose, and every clause earns its place:
 *
 * - **Internal email only.** R-50. A member of staff being told about their own
 *   workload is the lowest-risk message this product can send, and it is the
 *   one worth automating first.
 * - **The recipient still works here.** Same check the reassignment actions
 *   make, for the same reason: the DMS goes on naming people who left, and
 *   mailing a revoked address means the work silently reaches nobody.
 * - **The address came from the mirror**, not from the request. A rule that
 *   trusted a caller-supplied address would be an open relay with extra steps.
 * - **The record is already assigned to them.** This is what keeps it a
 *   notification rather than a broadcast: the rule may tell somebody about work
 *   that is theirs, and a person has to decide anything wider.
 */
async function ruleAllowsInternalNotification(
  msg: OutboundMessageRow,
): Promise<{ ok: true; rule: string } | { ok: false; reason: string }> {
  // R-72, and it is the clause that makes editing safe rather than the clause
  // that limits it. This rule permits text a *rule* composed — checked against
  // the facts, identical every time, reviewable in `composer.ts`. The moment
  // somebody types into it, none of that is true of the sentence any more, and
  // an unattended pass has nothing left to stand on. So it does not send it;
  // the person who wrote it approves it, which is the same person taking the
  // same responsibility they took when they typed.
  if (msg.editedAt) {
    return {
      ok: false,
      reason:
        `${msg.editedByName ?? "Somebody"} added their own words to this. The rule only sends ` +
        `text it composed itself, so this needs approving before it can go.`,
    };
  }
  if (msg.audience !== "INTERNAL" || msg.channel !== "EMAIL") {
    return { ok: false, reason: "No rule permits this — only internal email is sent without a person." };
  }
  if (!msg.toEmpCode) {
    return { ok: false, reason: "No rule permits this — it is not addressed to a member of staff." };
  }

  const [emp] = await db
    .select({
      empName: dmsEmployeesTable.empName,
      isActive: dmsEmployeesTable.isActive,
      dateOfLeaving: dmsEmployeesTable.dateOfLeaving,
      emailId: dmsEmployeesTable.emailId,
    })
    .from(dmsEmployeesTable)
    .where(
      and(
        eq(dmsEmployeesTable.showroomId, msg.showroomId),
        eq(dmsEmployeesTable.empCode, msg.toEmpCode),
      ),
    );

  if (!emp) {
    return { ok: false, reason: `No employee ${msg.toEmpCode} at this showroom.` };
  }
  if (emp.isActive !== "Y") {
    return {
      ok: false,
      reason:
        `${emp.empName} has left the dealership` +
        (emp.dateOfLeaving ? ` (${emp.dateOfLeaving})` : "") +
        ` — their mailbox is gone and the work would reach nobody.`,
    };
  }
  if (!emp.emailId) {
    return { ok: false, reason: `There is no email address on record for ${emp.empName}.` };
  }
  if (emp.emailId !== msg.toAddress) {
    // The draft was composed against an address the staff master no longer
    // holds. Refuse rather than quietly correct it: an address that changed
    // between drafting and sending is a fact somebody should look at.
    return {
      ok: false,
      reason: `The address on this draft is not the one on ${emp.empName}'s record any more.`,
    };
  }

  const assigned = await recordIsAssignedTo(msg, msg.toEmpCode);
  if (!assigned) {
    return {
      ok: false,
      reason:
        `${emp.empName} is not the person this record is assigned to. The rule only ` +
        `covers telling somebody about their own work — anything wider needs approval.`,
    };
  }

  return { ok: true, rule: "INTERNAL_STAFF_NOTIFICATION" };
}

/** Is the record this message concerns currently assigned to that employee? */
async function recordIsAssignedTo(msg: OutboundMessageRow, empCode: string): Promise<boolean> {
  if (msg.module === "REGISTRATION") {
    const rows = await buildRegistrationWorklist({ showroomId: msg.showroomId });
    const row = rows.find((r) => r.regnFileNo === msg.recordKey);
    return row?.ddms.assignedAgentEmpCode === empCode;
  }
  if (msg.module === "ENQUIRY") {
    const rows = await buildLeadWorklist({ showroomId: msg.showroomId });
    const row = rows.find((r) => r.enqId === msg.recordKey);
    return row?.ddms.reassignedToEmpCode === empCode;
  }
  return false;
}

/**
 * May this message go, and on whose authority?
 *
 * Called by `sendMessage()` and by nothing else that writes. It is also safe to
 * call for display — the Outbox uses it to show, on a draft nobody has touched,
 * exactly what would happen if somebody pressed send.
 */
export async function authoriseSend(
  msg: OutboundMessageRow,
): Promise<Authorisation> {
  if (msg.status === "SENT") {
    return { ok: false, reason: "This has already been sent." };
  }
  if (msg.status === "CANCELLED") {
    return { ok: false, reason: "This was cancelled. Draft a new one rather than reviving it." };
  }
  if (!msg.toAddress) {
    return { ok: false, reason: "There is no address on this message to send it to." };
  }

  // A person's approval is the broadest basis there is and it settles the
  // question for any audience. Checked first so a rule can never be the reason
  // a message went when somebody had already taken responsibility for it.
  if (msg.approvedByUserId && msg.approvedAt) {
    return { ok: true, basis: "PERSON", userId: msg.approvedByUserId };
  }

  if (msg.audience === "CUSTOMER") {
    // The line this objective is built around. No rule reaches here, by
    // construction rather than by omission — there is no branch above that
    // could produce one for a customer.
    return {
      ok: false,
      reason:
        "This is addressed to a customer. No rule permits that, so it needs somebody " +
        "to read it and approve it before it can go.",
    };
  }

  const rule = await ruleAllowsInternalNotification(msg);
  return rule.ok ? { ok: true, basis: "RULE", rule: rule.rule } : { ok: false, reason: rule.reason };
}

// ── Drafting ────────────────────────────────────────────────────────────────

export interface DraftInput {
  ownerId: number;
  /**
   * Who is drafting. **Null means a rule did**, which is R-60's convention and
   * the reason the column was made nullable before anything could write null to
   * it: the system acting has to be distinguishable from having lost track of
   * who acted.
   */
  userId: number | null;
  showroomId: number;
  /**
   * Every outlet this owner holds. Only the statement needs it, and it needs it
   * for the one figure worth sending: what the party owes the *group*.
   */
  ownerShowroomIds: number[];
  template: TemplateId;
  recordKey: string;
  /**
   * How long a message about this record counts as *already raised*.
   *
   * A day by default, for the reason set out where the window is applied. A
   * rule with a cadence passes its own: a weekly nudge about an uncollected
   * certificate must not be blocked by last week's, and must not fire twice on
   * consecutive scheduler passes. The cadence is the window (R-57).
   */
  reuseWindowMs?: number;
}

export type DraftResult =
  | { ok: true; message: OutboundMessageRow; reused: boolean; rationale: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Compose a draft against a worklist row, if the row's state supports it.
 *
 * The state check is not decoration. "Your vehicle is ready" sent about a
 * vehicle still in the bay is worse than saying nothing at all, and the only
 * thing that knows whether it is ready is the same `classify()` the screen
 * uses. Reimplementing that test here would let the message and the screen
 * drift apart, and the message is the half a customer sees.
 */
export async function createDraft(input: DraftInput): Promise<DraftResult> {
  const [showroom] = await db
    .select({ id: showroomsTable.id, name: showroomsTable.name })
    .from(showroomsTable)
    .where(and(eq(showroomsTable.id, input.showroomId), eq(showroomsTable.ownerId, input.ownerId)));

  if (!showroom) return { ok: false, status: 404, error: `No showroom ${input.showroomId}` };

  let base: Omit<ComposedDraft, "draftedBy"> | null = null;
  let refusal: string | null = null;

  switch (input.template) {
    case "SERVICE_VEHICLE_READY": {
      const rows = await buildServiceWorklist({ showroomId: input.showroomId });
      const row = rows.find((r) => r.jcNo === input.recordKey);
      if (!row) return { ok: false, status: 404, error: `No job card ${input.recordKey}` };
      if (row.state !== "READY_UNCOLLECTED") {
        refusal =
          `Job card ${row.jcNo} is ${row.state.replace(/_/g, " ").toLowerCase()}, not ready for ` +
          `collection. Telling a customer otherwise is worse than telling them nothing.`;
        break;
      }
      base = draftVehicleReady(row, showroom.name);
      break;
    }

    case "REGISTRATION_RC_READY": {
      const rows = await buildRegistrationWorklist({ showroomId: input.showroomId });
      const row = rows.find((r) => r.regnFileNo === input.recordKey);
      if (!row) return { ok: false, status: 404, error: `No registration file ${input.recordKey}` };
      if (row.state !== "RC_IN_DRAWER") {
        refusal =
          `File ${row.regnFileNo} is ${row.state.replace(/_/g, " ").toLowerCase()} — the ` +
          `certificate is not at the dealership waiting to be handed over.`;
        break;
      }
      base = draftRcReady(row, showroom.name);
      break;
    }

    case "REGISTRATION_AGENT_ASSIGNED": {
      const rows = await buildRegistrationWorklist({ showroomId: input.showroomId });
      const row = rows.find((r) => r.regnFileNo === input.recordKey);
      if (!row) return { ok: false, status: 404, error: `No registration file ${input.recordKey}` };
      const empCode = row.ddms.assignedAgentEmpCode;
      if (!empCode) {
        refusal = `Nobody is assigned to file ${row.regnFileNo} yet — assign it first, then tell them.`;
        break;
      }
      const emp = await staffRow(input.showroomId, empCode);
      if (!emp) {
        refusal = `No employee ${empCode} at this showroom.`;
        break;
      }
      base = draftAgentAssignment(row, emp.empName, emp.emailId, empCode, showroom.name);
      break;
    }

    case "LEAD_HANDOVER": {
      const rows = await buildLeadWorklist({ showroomId: input.showroomId });
      const row = rows.find((r) => r.enqId === input.recordKey);
      if (!row) return { ok: false, status: 404, error: `No enquiry ${input.recordKey}` };
      const empCode = row.ddms.reassignedToEmpCode;
      if (!empCode) {
        refusal = `Enquiry ${row.enqId} has not been reassigned — do that first, then tell them.`;
        break;
      }
      const emp = await staffRow(input.showroomId, empCode);
      if (!emp) {
        refusal = `No employee ${empCode} at this showroom.`;
        break;
      }
      base = draftLeadHandover(row, emp.empName, emp.emailId, empCode, showroom.name);
      break;
    }

    case "RECEIVABLE_STATEMENT": {
      const rows = await buildReceivablesWorklist({
        showroomId: input.showroomId,
        ownerShowroomIds: input.ownerShowroomIds,
      });
      const row = rows.find((r) => r.receivableId === input.recordKey);
      if (!row) return { ok: false, status: 404, error: `No receivable ${input.recordKey}` };
      if (row.state === "SETTLED") {
        refusal = `${row.dms.invoiceNo} is settled. Asking somebody to pay a bill they have paid is the one letter a dealership cannot take back.`;
        break;
      }
      if (row.state === "DISPUTED") {
        refusal = `${row.dms.invoiceNo} is marked disputed here. Resolve that before asking them to pay it.`;
        break;
      }
      base = draftStatementOfAccount(row, showroom.name);
      break;
    }

    default:
      return { ok: false, status: 400, error: `Unknown template ${String(input.template)}` };
  }

  if (refusal) return { ok: false, status: 409, error: refusal };
  if (!base) return { ok: false, status: 400, error: "Nothing to draft" };

  // One message per record, audience and channel per day. Returning the
  // existing one rather than erroring is the friendlier half of the rule the
  // partial unique index enforces: a second press shows you the draft you
  // already have, not a duplicate and not a stack trace.
  //
  // **The window is wider than the index**, and that gap was visible on screen
  // before it was reasoned about: the index only blocks a second message while
  // the first is `DRAFT` or `APPROVED`, so once one had gone out the same
  // notification could be raised again immediately, and the outbox showed the
  // RTO agent being told about the same file twice two minutes apart. The index
  // has to release — a nudge next week is legitimate — so the window belongs
  // here, where "again already?" and "again, later" can be told apart.
  const since = new Date(Date.now() - (input.reuseWindowMs ?? 24 * 60 * 60 * 1_000));
  const [existing] = await db
    .select()
    .from(outboundMessagesTable)
    .where(
      and(
        eq(outboundMessagesTable.module, base.module),
        eq(outboundMessagesTable.recordKey, base.recordKey),
        eq(outboundMessagesTable.audience, base.audience),
        eq(outboundMessagesTable.channel, base.channel),
        // CANCELLED and FAILED are absent on purpose. Somebody who cancelled a
        // draft and wants another has said so, and a message that failed to go
        // is the one case where trying again is the whole point.
        inArray(outboundMessagesTable.status, ["DRAFT", "APPROVED", "SENT", "HELD_NO_TRANSPORT"]),
        gte(outboundMessagesTable.createdAt, since),
      ),
    )
    .orderBy(desc(outboundMessagesTable.createdAt));

  if (existing) return { ok: true, message: existing, reused: true, rationale: base.rationale };

  const draft = await finishDraft(base);

  const [row] = await db
    .insert(outboundMessagesTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      module: draft.module,
      recordKey: draft.recordKey,
      audience: draft.audience,
      channel: draft.channel,
      toName: draft.toName,
      toAddress: draft.toAddress,
      toEmpCode: draft.toEmpCode,
      subject: draft.subject,
      body: draft.body,
      template: draft.template,
      draftedBy: draft.draftedBy,
      facts: draft.facts,
      status: "DRAFT",
      createdByUserId: input.userId,
    })
    .returning();

  return { ok: true, message: row!, reused: false, rationale: draft.rationale };
}

async function staffRow(
  showroomId: number,
  empCode: string,
): Promise<{ empName: string; emailId: string | null } | null> {
  const [emp] = await db
    .select({ empName: dmsEmployeesTable.empName, emailId: dmsEmployeesTable.emailId })
    .from(dmsEmployeesTable)
    .where(
      and(eq(dmsEmployeesTable.showroomId, showroomId), eq(dmsEmployeesTable.empCode, empCode)),
    );
  return emp ?? null;
}

// ── Approve, cancel, send ───────────────────────────────────────────────────

export type MessageResult =
  | { ok: true; message: OutboundMessageRow }
  | { ok: false; status: 400 | 404 | 409; error: string };

async function loadOwned(
  ownerId: number,
  messageId: number,
): Promise<OutboundMessageRow | null> {
  const [row] = await db
    .select()
    .from(outboundMessagesTable)
    .where(
      and(eq(outboundMessagesTable.id, messageId), eq(outboundMessagesTable.ownerId, ownerId)),
    );
  return row ?? null;
}

/**
 * A person takes responsibility for this message.
 *
 * Approval is recorded on the row *and* in the decision log, because the two
 * answer different questions: the row answers "may this go", and the log
 * answers "who said so", which is the one somebody asks three months later.
 *
 * Approving does not send. That separation is deliberate — approval is a
 * judgement and sending is an act, and collapsing them means a mis-click
 * becomes a message the moment it happens.
 */
export async function approveMessage(
  ownerId: number,
  userId: number,
  messageId: number,
  note?: string,
): Promise<MessageResult> {
  const msg = await loadOwned(ownerId, messageId);
  if (!msg) return { ok: false, status: 404, error: `No message ${messageId}` };
  if (msg.status === "SENT") return { ok: false, status: 409, error: "This has already been sent." };
  if (msg.status === "CANCELLED") {
    return { ok: false, status: 409, error: "This was cancelled." };
  }

  const now = new Date();
  const [row] = await db
    .update(outboundMessagesTable)
    .set({
      status: "APPROVED",
      approvedByUserId: userId,
      approvedAt: now,
      authorisedBasis: "PERSON",
      authorisedRule: null,
      failureReason: null,
    })
    .where(eq(outboundMessagesTable.id, messageId))
    .returning();

  await db.insert(decisionLogTable).values({
    ownerId,
    showroomId: msg.showroomId,
    userId,
    module: msg.module,
    recordKey: msg.recordKey,
    action: "MESSAGE_APPROVED",
    previousValue: { status: msg.status },
    newValue: { status: "APPROVED", template: msg.template, audience: msg.audience },
    note: note ?? null,
  });

  return { ok: true, message: row! };
}

/**
 * A person writes their own sentence into a draft.
 *
 * The Outbox shipped with no editing at all, and the reasoning written at the
 * top of `Outbox.tsx` was half right. `checkRewrite()` exists because a *model*
 * asked to rephrase a message can invent a figure — a date, an amount, a
 * registration number — that the facts do not support. That is a real risk and
 * the check still stands. It is not this one. A named manager adding *"Mr Verma
 * is coming in on Saturday, please have the file ready"* is asserting something
 * only they know, and there is nothing in the mirror to check it against
 * because it is not the mirror's kind of fact.
 *
 * What the old answer produced in practice was worse than the risk it avoided:
 * *cancel it and fix the record instead* means somebody cancels the draft and
 * picks up the phone, and the Outbox stops being used.
 *
 * Four things keep R-48 intact while allowing it:
 *
 * - **`DRAFT` only** (R-75). Approval means somebody read it. Text that changes
 *   after that has not been read by the person whose name is on the approval,
 *   and 409 is the right answer rather than silently reverting them to draft.
 * - **The rule path closes** (R-72). `authoriseSend()` refuses an edited
 *   message a `RULE` basis, so an internal notification that would have gone
 *   unattended now waits for the person who edited it to approve it.
 * - **The composed text survives** (R-73), written once so it stays the rule's
 *   words rather than the previous edit's.
 * - **It is a decision and is logged like one** (R-74), with both versions.
 */
export async function editMessage(
  ownerId: number,
  userId: number,
  userName: string,
  messageId: number,
  edit: { subject?: string | null; body: string },
): Promise<MessageResult> {
  const msg = await loadOwned(ownerId, messageId);
  if (!msg) return { ok: false, status: 404, error: `No message ${messageId}` };

  if (msg.status !== "DRAFT") {
    return {
      ok: false,
      status: 409,
      error:
        msg.status === "APPROVED"
          ? "This has been approved — somebody has read it as it stands. Cancel it and draft again."
          : `This is ${msg.status.replace(/_/g, " ").toLowerCase()} and can no longer be edited.`,
    };
  }

  const body = edit.body.trim();
  if (!body) {
    return { ok: false, status: 400, error: "A message cannot be empty." };
  }
  // Long enough for the case this exists for, short enough that the Outbox
  // stays something people read rather than a document store.
  if (body.length > 4_000) {
    return { ok: false, status: 400, error: "That is longer than a message — keep it under 4,000 characters." };
  }

  const subject = edit.subject === undefined ? msg.subject : (edit.subject?.trim() || null);

  // Somebody opened the editor and closed it. Recording an edit that changed
  // nothing would close the rule path on a message a rule could still send.
  if (body === msg.body && subject === msg.subject) {
    return { ok: true, message: msg };
  }

  const now = new Date();
  const [row] = await db
    .update(outboundMessagesTable)
    .set({
      subject,
      body,
      draftedBy: "PERSON",
      // Written once. On the second edit these already hold the rule's words
      // and must not be moved on to the first edit's.
      composedSubject: msg.composedBody === null ? msg.subject : msg.composedSubject,
      composedBody: msg.composedBody ?? msg.body,
      editedByUserId: userId,
      editedByName: userName,
      editedAt: now,
      // The old refusal was about the old text and the gate is about to be
      // asked again. Leaving it would print a stale sentence under a message
      // that no longer says what it was refused for.
      failureReason: null,
    })
    .where(eq(outboundMessagesTable.id, messageId))
    .returning();

  await db.insert(decisionLogTable).values({
    ownerId,
    showroomId: msg.showroomId,
    userId,
    module: msg.module,
    recordKey: msg.recordKey,
    action: "MESSAGE_EDITED",
    previousValue: { subject: msg.subject, body: msg.body, draftedBy: msg.draftedBy },
    newValue: { subject, body, draftedBy: "PERSON" },
    note: null,
  });

  return { ok: true, message: row! };
}

/** Decided against. Kept as a row, because "we chose not to" is a fact worth keeping. */
export async function cancelMessage(
  ownerId: number,
  /** Null when a rule withdrew it because the record it was about moved on. */
  userId: number | null,
  messageId: number,
  note?: string,
): Promise<MessageResult> {
  const msg = await loadOwned(ownerId, messageId);
  if (!msg) return { ok: false, status: 404, error: `No message ${messageId}` };
  if (msg.status === "SENT") {
    return { ok: false, status: 409, error: "This has already been sent — it cannot be cancelled." };
  }

  const [row] = await db
    .update(outboundMessagesTable)
    .set({ status: "CANCELLED", authorisedBasis: null, authorisedRule: null })
    .where(eq(outboundMessagesTable.id, messageId))
    .returning();

  await db.insert(decisionLogTable).values({
    ownerId,
    showroomId: msg.showroomId,
    userId,
    module: msg.module,
    recordKey: msg.recordKey,
    action: "MESSAGE_CANCELLED",
    previousValue: { status: msg.status },
    newValue: { status: "CANCELLED" },
    note: note ?? null,
  });

  return { ok: true, message: row! };
}

/**
 * Send it, if it may go.
 *
 * **The only function permitted to write `sentAt`**, and it writes it only
 * after `authoriseSend()` has returned a basis. Everything else in this file
 * exists to make that sentence true.
 *
 * A refusal is recorded on the row rather than only returned, so the Outbox can
 * show why a draft is stuck without the person having to press send to find
 * out.
 */
export async function sendMessage(
  ownerId: number,
  /** Null when a rule is pressing send. `logSend` already nulls it for a rule
   *  basis, so this only widens what may be passed, not what is recorded. */
  userId: number | null,
  messageId: number,
): Promise<MessageResult> {
  const msg = await loadOwned(ownerId, messageId);
  if (!msg) return { ok: false, status: 404, error: `No message ${messageId}` };

  const auth = await authoriseSend(msg);

  if (!auth.ok) {
    await db
      .update(outboundMessagesTable)
      .set({ failureReason: auth.reason })
      .where(eq(outboundMessagesTable.id, messageId));

    logger.info(
      { messageId, audience: msg.audience, template: msg.template, reason: auth.reason },
      "Outbound message refused",
    );
    return { ok: false, status: 409, error: auth.reason };
  }

  const now = new Date();
  const carried = await carry(ownerId, msg);

  /*
   * Authorised, and this dealership has nothing to carry it on.
   *
   * Held rather than sent — the gate said yes and no customer received
   * anything, and the row says both. What changed with OBJ-27 is the sentence:
   * it used to read *no transport is configured*, which describes a gap in the
   * product. Three of the four reasons are the dealership's own (no account
   * connected, connected but switched off, a key the server is missing) and
   * `statusFor` words each of them separately, because somebody looking at an
   * undelivered message is entitled to know whose problem it is and what the
   * fix is.
   */
  if (carried === null) {
    const status = (await statusFor(ownerId)).find((c) => c.channel === msg.channel);
    const [row] = await db
      .update(outboundMessagesTable)
      .set({
        status: "HELD_NO_TRANSPORT",
        authorisedBasis: auth.basis,
        authorisedRule: auth.basis === "RULE" ? auth.rule : null,
        failureReason:
          `Authorised${auth.basis === "RULE" ? ` by rule ${auth.rule}` : " by a person"}, ` +
          `and nothing was delivered. ${status?.blocker ?? `No ${msg.channel.toLowerCase()} account is connected.`}`,
      })
      .where(eq(outboundMessagesTable.id, messageId))
      .returning();

    await logSend(ownerId, userId, msg, auth, "HELD_NO_TRANSPORT");
    return { ok: true, message: row! };
  }

  const [row] = await db
    .update(outboundMessagesTable)
    .set({
      status: carried.ok ? "SENT" : "FAILED",
      sentAt: carried.ok ? now : null,
      // The provider's id, and it is not bookkeeping: it is what lets a reply
      // arriving in three days be threaded back to the record this message was
      // about, rather than to whichever message went to that number last.
      providerMessageId: carried.ok ? carried.providerMessageId : null,
      authorisedBasis: auth.basis,
      authorisedRule: auth.basis === "RULE" ? auth.rule : null,
      failureReason: carried.ok ? null : carried.error,
    })
    .where(eq(outboundMessagesTable.id, messageId))
    .returning();

  await logSend(ownerId, userId, msg, auth, carried.ok ? "SENT" : "FAILED");
  return { ok: true, message: row! };
}

function logSend(
  ownerId: number,
  userId: number | null,
  msg: OutboundMessageRow,
  auth: Extract<Authorisation, { ok: true }>,
  outcome: string,
): Promise<unknown> {
  return db.insert(decisionLogTable).values({
    ownerId,
    showroomId: msg.showroomId,
    // Null when a rule acted, which the column's own comment insists reads as
    // "the system did this" rather than "we lost track of who did".
    userId: auth.basis === "PERSON" ? userId : null,
    module: msg.module,
    recordKey: msg.recordKey,
    action: `MESSAGE_${outcome}`,
    previousValue: { status: msg.status },
    newValue: {
      status: outcome,
      basis: auth.basis,
      rule: auth.basis === "RULE" ? auth.rule : null,
      audience: msg.audience,
      channel: msg.channel,
      to: msg.toAddress,
    },
    note: null,
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface OutboxRow {
  message: OutboundMessageRow;
  /** What would happen if somebody pressed send right now. */
  gate: Authorisation;
}

/**
 * The outbox, with the gate's verdict already computed on every row.
 *
 * Evaluating the gate on read rather than storing it is the same choice as
 * deriving reconciliation rather than storing it: an approval that was valid
 * when it was written can stop being valid — the recipient leaves, the file is
 * reassigned — and a cached "may send" is exactly the stale flag that would let
 * one through.
 */
export async function listMessages(
  ownerId: number,
  opts: { showroomId?: number; status?: string[] } = {},
): Promise<OutboxRow[]> {
  const rows = await db
    .select()
    .from(outboundMessagesTable)
    .where(
      and(
        eq(outboundMessagesTable.ownerId, ownerId),
        opts.showroomId ? eq(outboundMessagesTable.showroomId, opts.showroomId) : undefined,
        opts.status?.length
          ? inArray(outboundMessagesTable.status, opts.status as never[])
          : undefined,
      ),
    )
    .orderBy(desc(outboundMessagesTable.createdAt))
    .limit(200);

  return Promise.all(rows.map(async (m) => ({ message: m, gate: await authoriseSend(m) })));
}

export interface OutboxSummary {
  drafts: number;
  awaitingApproval: number;
  approvedNotSent: number;
  held: number;
  sent: number;
  /** Drafts a rule would send right now with nobody reading them. */
  ruleWouldSend: number;
}

export function summariseOutbox(rows: OutboxRow[]): OutboxSummary {
  let drafts = 0,
    awaitingApproval = 0,
    approvedNotSent = 0,
    held = 0,
    sent = 0,
    ruleWouldSend = 0;

  for (const { message, gate } of rows) {
    if (message.status === "DRAFT") {
      drafts++;
      if (gate.ok && gate.basis === "RULE") ruleWouldSend++;
      else awaitingApproval++;
    }
    if (message.status === "APPROVED") approvedNotSent++;
    if (message.status === "HELD_NO_TRANSPORT") held++;
    if (message.status === "SENT") sent++;
  }

  return { drafts, awaitingApproval, approvedNotSent, held, sent, ruleWouldSend };
}
