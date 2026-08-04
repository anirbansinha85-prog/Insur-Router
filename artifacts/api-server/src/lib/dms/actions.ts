/**
 * The controls behind every "what to do" on every screen.
 *
 * Until this file existed, DDMS could tell a dealership that a customer had
 * been waiting four days for a call and offered no way to make it, or to record
 * that somebody had. Every action was a sentence. That is the weakest thing in
 * the product (R-20) and it is the reason an agent would have been useless:
 * an agent with nothing to invoke is a chatbot.
 *
 * ## Nothing here uses a model
 *
 * Every action below is a deterministic write to a decision field that already
 * changes a derived state. `classify()` in each worklist decides *what is
 * wrong*; this decides *what may be done about it*; and neither asks a model,
 * because both are knowable (R-23, R-49). What a model will eventually add is
 * the wording of a message and the answer to "why" — not the authorisation.
 *
 * ## Every mark is reversible
 *
 * `clear: true` undoes any of them. This is not politeness. These fields
 * *remove work from a screen* — marking a customer as told takes their row out
 * of the calls-to-make count — so an irreversible mis-click would silently
 * delete a phone call somebody still needs to make. The decision log keeps both
 * the mark and the reversal, because a reversal with no trail is
 * indistinguishable from the mark never having happened.
 *
 * ## What is deliberately absent
 *
 * There is no action that writes to the dealer's DMS, and there never will be
 * (R-5, R-40). Where the only real fix is a person keying something into their
 * system, the row says so and gives the exact value to copy rather than
 * offering a button that pretends otherwise.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  decisionLogTable,
  dmsEmployeesTable,
  dmsEnquiriesTable,
  dmsJobCardsTable,
  dmsPartStockTable,
  dmsRegistrationsTable,
  showroomsTable,
} from "@workspace/db";
import { logger } from "../logger";

export type ActionModule = "JOB_CARD" | "ENQUIRY" | "REGISTRATION" | "PART";

export type ActionId =
  // Enquiries
  | "ENQUIRY_LOG_CONTACT"
  | "ENQUIRY_REASSIGN"
  // Workshop
  | "JOB_CARD_MARK_INFORMED"
  // Registration
  | "REGISTRATION_ASSIGN_AGENT"
  | "REGISTRATION_MARK_NOTIFIED"
  | "REGISTRATION_LOG_CHASE"
  // Spares
  | "PART_REQUEST_TRANSFER"
  | "PART_RAISE_REORDER";

export interface ApplyActionInput {
  ownerId: number;
  userId: number;
  action: ActionId;
  /** The mirror row's own key — enqId, jcNo, regnFileNo, partNo. */
  recordKey: string;
  /** Which outlet's copy. Checked against the owner before anything is written. */
  showroomId: number;
  /** Undo rather than do. Every action supports it. */
  clear?: boolean;
  /** `ENQUIRY_REASSIGN` and `REGISTRATION_ASSIGN_AGENT`: the employee code. */
  empCode?: string;
  /** `ENQUIRY_LOG_CONTACT`: how they were reached. */
  channel?: "CALL" | "WHATSAPP" | "SMS" | "EMAIL" | "VISIT";
  /** `PART_REQUEST_TRANSFER`: which outlet is sending it. */
  fromShowroomId?: number;
  note?: string;
}

export type ApplyResult =
  | { ok: true; module: ActionModule; changed: Record<string, unknown> }
  | { ok: false; status: 400 | 404 | 409; error: string };

const MODULE_OF: Record<ActionId, ActionModule> = {
  ENQUIRY_LOG_CONTACT: "ENQUIRY",
  ENQUIRY_REASSIGN: "ENQUIRY",
  JOB_CARD_MARK_INFORMED: "JOB_CARD",
  REGISTRATION_ASSIGN_AGENT: "REGISTRATION",
  REGISTRATION_MARK_NOTIFIED: "REGISTRATION",
  REGISTRATION_LOG_CHASE: "REGISTRATION",
  PART_REQUEST_TRANSFER: "PART",
  PART_RAISE_REORDER: "PART",
};

/**
 * The employee must still work here.
 *
 * The entire point of the reassignment actions is that the DMS goes on naming
 * somebody who left, so offering their name in the picker — or accepting it
 * from a stale client — would reproduce the bug this is meant to fix.
 */
async function assertActiveEmployee(
  showroomId: number,
  empCode: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const [emp] = await db
    .select({
      empName: dmsEmployeesTable.empName,
      isActive: dmsEmployeesTable.isActive,
      dateOfLeaving: dmsEmployeesTable.dateOfLeaving,
    })
    .from(dmsEmployeesTable)
    .where(
      and(eq(dmsEmployeesTable.showroomId, showroomId), eq(dmsEmployeesTable.empCode, empCode)),
    );

  if (!emp) return { ok: false, error: `No employee ${empCode} at this showroom` };
  if (emp.isActive !== "Y") {
    return {
      ok: false,
      error:
        `${emp.empName} has left the dealership` +
        (emp.dateOfLeaving ? ` (${emp.dateOfLeaving})` : "") +
        ` — assigning work to them is the problem this is meant to fix.`,
    };
  }
  return { ok: true, name: emp.empName };
}

/**
 * Apply one decision, scoped to the owner, and record who did it.
 *
 * Returns a result rather than throwing, because every caller is an HTTP route
 * that needs to distinguish "not yours" from "not allowed" from "worked".
 */
export async function applyAction(input: ApplyActionInput): Promise<ApplyResult> {
  const module = MODULE_OF[input.action];
  if (!module) return { ok: false, status: 400, error: `Unknown action ${input.action}` };

  // The showroom must belong to this owner. Row-level security would return
  // nothing anyway, but a 404 said here is clearer than an update that silently
  // matches zero rows and reports success.
  const [showroom] = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(and(eq(showroomsTable.id, input.showroomId), eq(showroomsTable.ownerId, input.ownerId)));

  if (!showroom) return { ok: false, status: 404, error: `No showroom ${input.showroomId}` };

  const now = new Date();
  const clear = input.clear === true;

  let previous: Record<string, unknown> = {};
  let changed: Record<string, unknown> = {};

  switch (input.action) {
    // ── Enquiries ─────────────────────────────────────────────────────────
    case "ENQUIRY_LOG_CONTACT": {
      const [row] = await db
        .select({
          contactedAt: dmsEnquiriesTable.contactedAt,
          contactChannel: dmsEnquiriesTable.contactChannel,
        })
        .from(dmsEnquiriesTable)
        .where(
          and(
            eq(dmsEnquiriesTable.showroomId, input.showroomId),
            eq(dmsEnquiriesTable.enqId, input.recordKey),
          ),
        );
      if (!row) return { ok: false, status: 404, error: `No enquiry ${input.recordKey}` };

      previous = { contactedAt: row.contactedAt, contactChannel: row.contactChannel };
      changed = clear
        ? { contactedAt: null, contactChannel: null, contactNote: null }
        : {
            contactedAt: now,
            contactChannel: input.channel ?? "CALL",
            contactNote: input.note ?? null,
          };

      await db
        .update(dmsEnquiriesTable)
        .set(changed)
        .where(
          and(
            eq(dmsEnquiriesTable.showroomId, input.showroomId),
            eq(dmsEnquiriesTable.enqId, input.recordKey),
          ),
        );
      break;
    }

    case "ENQUIRY_REASSIGN": {
      if (!clear && !input.empCode) {
        return { ok: false, status: 400, error: "empCode is required to reassign" };
      }
      if (!clear) {
        const check = await assertActiveEmployee(input.showroomId, input.empCode!);
        if (!check.ok) return { ok: false, status: 409, error: check.error };
      }

      const [row] = await db
        .select({ reassignedToEmpCode: dmsEnquiriesTable.reassignedToEmpCode })
        .from(dmsEnquiriesTable)
        .where(
          and(
            eq(dmsEnquiriesTable.showroomId, input.showroomId),
            eq(dmsEnquiriesTable.enqId, input.recordKey),
          ),
        );
      if (!row) return { ok: false, status: 404, error: `No enquiry ${input.recordKey}` };

      previous = { reassignedToEmpCode: row.reassignedToEmpCode };
      changed = clear
        ? { reassignedToEmpCode: null, reassignedAt: null }
        : { reassignedToEmpCode: input.empCode!, reassignedAt: now };

      await db
        .update(dmsEnquiriesTable)
        .set(changed)
        .where(
          and(
            eq(dmsEnquiriesTable.showroomId, input.showroomId),
            eq(dmsEnquiriesTable.enqId, input.recordKey),
          ),
        );
      break;
    }

    // ── Workshop ──────────────────────────────────────────────────────────
    case "JOB_CARD_MARK_INFORMED": {
      const [row] = await db
        .select({ customerInformedAt: dmsJobCardsTable.customerInformedAt })
        .from(dmsJobCardsTable)
        .where(
          and(
            eq(dmsJobCardsTable.showroomId, input.showroomId),
            eq(dmsJobCardsTable.jcNo, input.recordKey),
          ),
        );
      if (!row) return { ok: false, status: 404, error: `No job card ${input.recordKey}` };

      previous = { customerInformedAt: row.customerInformedAt };
      changed = { customerInformedAt: clear ? null : now };

      await db
        .update(dmsJobCardsTable)
        .set(changed)
        .where(
          and(
            eq(dmsJobCardsTable.showroomId, input.showroomId),
            eq(dmsJobCardsTable.jcNo, input.recordKey),
          ),
        );
      break;
    }

    // ── Registration ──────────────────────────────────────────────────────
    case "REGISTRATION_ASSIGN_AGENT":
    case "REGISTRATION_MARK_NOTIFIED":
    case "REGISTRATION_LOG_CHASE": {
      const [row] = await db
        .select({
          assignedAgentEmpCode: dmsRegistrationsTable.assignedAgentEmpCode,
          customerNotifiedAt: dmsRegistrationsTable.customerNotifiedAt,
          rtoChasedAt: dmsRegistrationsTable.rtoChasedAt,
        })
        .from(dmsRegistrationsTable)
        .where(
          and(
            eq(dmsRegistrationsTable.showroomId, input.showroomId),
            eq(dmsRegistrationsTable.regnFileNo, input.recordKey),
          ),
        );
      if (!row) return { ok: false, status: 404, error: `No registration file ${input.recordKey}` };

      if (input.action === "REGISTRATION_ASSIGN_AGENT") {
        if (!clear && !input.empCode) {
          return { ok: false, status: 400, error: "empCode is required to assign" };
        }
        if (!clear) {
          const check = await assertActiveEmployee(input.showroomId, input.empCode!);
          if (!check.ok) return { ok: false, status: 409, error: check.error };
        }
        previous = { assignedAgentEmpCode: row.assignedAgentEmpCode };
        changed = clear
          ? { assignedAgentEmpCode: null, assignedAgentAt: null }
          : { assignedAgentEmpCode: input.empCode!, assignedAgentAt: now };
      } else if (input.action === "REGISTRATION_MARK_NOTIFIED") {
        previous = { customerNotifiedAt: row.customerNotifiedAt };
        changed = { customerNotifiedAt: clear ? null : now };
      } else {
        previous = { rtoChasedAt: row.rtoChasedAt };
        changed = { rtoChasedAt: clear ? null : now };
      }

      await db
        .update(dmsRegistrationsTable)
        .set(changed)
        .where(
          and(
            eq(dmsRegistrationsTable.showroomId, input.showroomId),
            eq(dmsRegistrationsTable.regnFileNo, input.recordKey),
          ),
        );
      break;
    }

    // ── Spares ────────────────────────────────────────────────────────────
    case "PART_REQUEST_TRANSFER":
    case "PART_RAISE_REORDER": {
      const [row] = await db
        .select({
          transferRequestedAt: dmsPartStockTable.transferRequestedAt,
          transferFromShowroomId: dmsPartStockTable.transferFromShowroomId,
          reorderRaisedAt: dmsPartStockTable.reorderRaisedAt,
        })
        .from(dmsPartStockTable)
        .where(
          and(
            eq(dmsPartStockTable.showroomId, input.showroomId),
            eq(dmsPartStockTable.partNo, input.recordKey),
          ),
        );
      if (!row) return { ok: false, status: 404, error: `No part ${input.recordKey} at this showroom` };

      if (input.action === "PART_REQUEST_TRANSFER") {
        if (!clear && !input.fromShowroomId) {
          return { ok: false, status: 400, error: "fromShowroomId is required to request a transfer" };
        }
        if (!clear) {
          // The sending outlet has to be the same owner's. Asking another
          // dealership to post you a brake shoe is not a feature.
          const [source] = await db
            .select({ id: showroomsTable.id })
            .from(showroomsTable)
            .where(
              and(
                eq(showroomsTable.id, input.fromShowroomId!),
                eq(showroomsTable.ownerId, input.ownerId),
              ),
            );
          if (!source) {
            return { ok: false, status: 404, error: `No showroom ${input.fromShowroomId}` };
          }
        }
        previous = {
          transferRequestedAt: row.transferRequestedAt,
          transferFromShowroomId: row.transferFromShowroomId,
        };
        changed = clear
          ? { transferRequestedAt: null, transferFromShowroomId: null }
          : { transferRequestedAt: now, transferFromShowroomId: input.fromShowroomId! };
      } else {
        previous = { reorderRaisedAt: row.reorderRaisedAt };
        changed = { reorderRaisedAt: clear ? null : now };
      }

      await db
        .update(dmsPartStockTable)
        .set(changed)
        .where(
          and(
            eq(dmsPartStockTable.showroomId, input.showroomId),
            eq(dmsPartStockTable.partNo, input.recordKey),
          ),
        );
      break;
    }

    default:
      return { ok: false, status: 400, error: `Unhandled action ${String(input.action)}` };
  }

  await db.insert(decisionLogTable).values({
    ownerId: input.ownerId,
    showroomId: input.showroomId,
    userId: input.userId,
    module,
    recordKey: input.recordKey,
    action: clear ? `${input.action}_CLEARED` : input.action,
    previousValue: previous,
    newValue: changed,
    note: input.note ?? null,
  });

  logger.info(
    { action: input.action, clear, module, recordKey: input.recordKey, userId: input.userId },
    "Decision recorded",
  );

  return { ok: true, module, changed };
}

// ── The picker ──────────────────────────────────────────────────────────────

export interface StaffMember {
  empCode: string;
  empName: string;
  role: string;
  mobileNo: string | null;
  /** Null once they have left, and null is what stops an internal email going. */
  emailId: string | null;
  /** How many live enquiries and registration files they are already carrying. */
  carrying: number;
}

/**
 * Staff who still work here, optionally filtered by role.
 *
 * Departed employees are excluded rather than greyed out. They are the reason
 * the reassignment field exists, and a picker that lists them invites somebody
 * to hand work back to a person who left in February.
 *
 * `carrying` is why this is not a plain lookup: reassigning an orphaned lead to
 * whoever is already carrying the most is a decision made worse by DDMS rather
 * than better, and the number is one join away.
 */
export async function listStaff(showroomId: number, role?: string): Promise<StaffMember[]> {
  const staff = await db
    .select({
      empCode: dmsEmployeesTable.empCode,
      empName: dmsEmployeesTable.empName,
      role: dmsEmployeesTable.role,
      mobileNo: dmsEmployeesTable.mobileNo,
      emailId: dmsEmployeesTable.emailId,
    })
    .from(dmsEmployeesTable)
    .where(
      and(
        eq(dmsEmployeesTable.showroomId, showroomId),
        eq(dmsEmployeesTable.isActive, "Y"),
        role ? eq(dmsEmployeesTable.role, role) : undefined,
      ),
    );

  // Counted in memory over two small lists rather than as two grouped
  // subqueries. A showroom has tens of staff and hundreds of open records;
  // this is one round trip each and stays readable.
  const [enquiries, registrations] = await Promise.all([
    db
      .select({
        assigned: dmsEnquiriesTable.assignedEmpCode,
        reassigned: dmsEnquiriesTable.reassignedToEmpCode,
      })
      .from(dmsEnquiriesTable)
      .where(eq(dmsEnquiriesTable.showroomId, showroomId)),
    db
      .select({
        agent: dmsRegistrationsTable.agentEmpCode,
        assigned: dmsRegistrationsTable.assignedAgentEmpCode,
      })
      .from(dmsRegistrationsTable)
      .where(eq(dmsRegistrationsTable.showroomId, showroomId)),
  ]);

  const load = new Map<string, number>();
  const bump = (code: string | null) => {
    if (code) load.set(code, (load.get(code) ?? 0) + 1);
  };
  // Our reassignment wins over the DMS's, because that is what it means.
  for (const e of enquiries) bump(e.reassigned ?? e.assigned);
  for (const r of registrations) bump(r.assigned ?? r.agent);

  return staff
    .map((s) => ({ ...s, carrying: load.get(s.empCode) ?? 0 }))
    .sort((a, b) => a.carrying - b.carrying || a.empName.localeCompare(b.empName));
}
