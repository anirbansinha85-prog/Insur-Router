/**
 * The records DDMS owns, and the one rule that makes an agent safe to let near
 * them.
 *
 * Every table before OBJ-22 was a copy of the dealer's data or a decision field
 * hung off one. `record_activities` and `tasks` are neither: DDMS creates them,
 * no DMS has a field for them, and nothing upstream will ever overwrite one.
 *
 * ## Why this is the objective that unlocks the agent
 *
 * OBJ-17 opened two of twelve registry actions. Eight of the remaining ten are
 * closed because they assert *a person did something* against a record DDMS
 * does not own — and a model cannot make a phone call. Adding agents does not
 * move that number. Owning records does.
 *
 * > **An agent may record what the agent did. It may never record what a person
 * > did.**
 *
 * `AGENT_KINDS` below is that rule as a closed set rather than a comment.
 * `OBSERVED` and `SYSTEM` are the whole of it: *the address on the deal does
 * not match the KYC document* is something the agent genuinely did, and writing
 * it down asserts nothing about anybody else. `CALL`, `VISIT` and `MESSAGE`
 * describe human acts and stay human.
 *
 * ## Two layers, each doing what it is good at
 *
 * The permission table answers *may this principal write an activity at all*.
 * The row policy answers *about which records* — it gates on the same
 * `app.can_read(module)` as the mirror row the activity points at, so a service
 * advisor writing a note about a receivable is refused by Postgres without this
 * file knowing anything about roles. This file answers only the third question:
 * *what kind of thing may this principal claim happened.*
 */

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  recordActivitiesTable,
  tasksTable,
  dmsEmployeesTable,
  type RecordActivityRow,
  type TaskRow,
} from "@workspace/db";
import { logger } from "../logger";
import { may, type Permission } from "./permissions";

export type ActivityKind = RecordActivityRow["kind"];
export type ActivityModule = RecordActivityRow["module"];

/**
 * The kinds an agent may write, and it is a short list on purpose.
 *
 * Adding to it is a claim that the agent can do the thing the kind describes.
 * There is no configuration that widens it, which is the same shape as the
 * refusals in `permissions.ts` and the gate in `outbound.ts`: the floor lives
 * in code and configuration cannot reach it.
 */
export const AGENT_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  "OBSERVED",
  "SYSTEM",
]);

/** Why a kind is closed to the agent, for the refusal and for the reviewer. */
const KIND_CLOSED_TO_AGENT: Partial<Record<ActivityKind, string>> = {
  NOTE: "A note is somebody's opinion, and the agent does not have one to record. What it observed is an OBSERVED.",
  CALL: "Asserts a person picked up a telephone. The agent cannot, and a call logged that never happened takes the customer off somebody's list.",
  VISIT: "Asserts somebody walked into the showroom and was seen. Only the person who saw them can say so.",
  MESSAGE: "Asserts a person sent something by hand. What the product sent is already in the outbox, with the gate's verdict on it.",
  INBOUND: "The customer said this. It is written when a reply actually arrives, by the transport that received it — never composed.",
};

export type WriteResult<T> = { ok: true; row: T } | { ok: false; status: 400 | 403 | 404; error: string };

// ── Activities ──────────────────────────────────────────────────────────────

export interface WriteActivityInput {
  ownerId: number;
  showroomId: number;
  module: ActivityModule;
  recordKey: string;
  kind: ActivityKind;
  body: string;
  /**
   * Who is writing. **Null is the agent** — R-60's convention, unchanged since
   * the column was made nullable a fortnight before anything could write null
   * to it.
   */
  userId: number | null;
  /** Their name at the time. Ignored when `userId` is null. */
  authorName?: string | null;
  /** The principal, for the permission check. `AGENT` when nobody is signed in. */
  principal: string;
}

export async function writeActivity(
  input: WriteActivityInput,
): Promise<WriteResult<RecordActivityRow>> {
  if (!may(input.principal, "activity.write")) {
    return { ok: false, status: 403, error: "You may not add to a record's timeline." };
  }

  const body = input.body.trim();
  if (!body) return { ok: false, status: 400, error: "An activity cannot be empty." };
  if (body.length > 2_000) {
    return { ok: false, status: 400, error: "That is longer than a timeline entry — keep it under 2,000 characters." };
  }

  const isAgent = input.userId === null;

  // The rule this file exists for.
  if (isAgent && !AGENT_KINDS.has(input.kind)) {
    return {
      ok: false,
      status: 403,
      error:
        KIND_CLOSED_TO_AGENT[input.kind] ??
        `The agent may only record ${[...AGENT_KINDS].join(" or ")}.`,
    };
  }

  // And the mirror of it: a person writing OBSERVED is claiming the *system*
  // found something, which muddles who noticed. Not refused — people do notice
  // things — but recorded as a NOTE, because that is what it is.
  const kind: ActivityKind = !isAgent && input.kind === "SYSTEM" ? "NOTE" : input.kind;

  const [row] = await db
    .insert(recordActivitiesTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      module: input.module,
      recordKey: input.recordKey,
      kind,
      body,
      userId: input.userId,
      authorName: isAgent ? null : (input.authorName ?? null),
      authoredBy: isAgent ? "AGENT" : "PERSON",
    })
    .returning();

  if (!row) {
    // The row policy refused. Same shape as everywhere else in this codebase:
    // the database is the thing that actually decides, and a caller that gets
    // nothing back should be told, not left to infer it from a missing row.
    return {
      ok: false,
      status: 403,
      error: "That record is not one your role can write about.",
    };
  }

  logger.info(
    { module: row.module, recordKey: row.recordKey, kind: row.kind, agent: isAgent },
    "Activity recorded",
  );
  return { ok: true, row };
}

/**
 * Withdraw a claim without erasing that it was made.
 *
 * Retracted rather than deleted, and the row still renders — struck through,
 * with the reason. *We decided this was wrong* and *it never happened* are
 * different facts about a dealership and only one of them is defensible. Same
 * argument as cancelling a message rather than removing it.
 */
export async function retractActivity(
  ownerId: number,
  userId: number,
  principal: string,
  activityId: number,
  reason: string,
): Promise<WriteResult<RecordActivityRow>> {
  if (!may(principal, "activity.retract")) {
    return { ok: false, status: 403, error: "You may not withdraw a timeline entry." };
  }

  const [existing] = await db
    .select()
    .from(recordActivitiesTable)
    .where(
      and(eq(recordActivitiesTable.id, activityId), eq(recordActivitiesTable.ownerId, ownerId)),
    );
  if (!existing) return { ok: false, status: 404, error: `No activity ${activityId}` };
  if (existing.retractedAt) {
    return { ok: false, status: 400, error: "That was already withdrawn." };
  }

  const [row] = await db
    .update(recordActivitiesTable)
    .set({
      retractedAt: new Date(),
      retractedByUserId: userId,
      retractedReason: reason.trim() || null,
    })
    .where(eq(recordActivitiesTable.id, activityId))
    .returning();

  return { ok: true, row: row! };
}

/** One record's timeline, newest first. */
export async function listActivities(
  ownerId: number,
  module: ActivityModule,
  recordKey: string,
): Promise<RecordActivityRow[]> {
  return db
    .select()
    .from(recordActivitiesTable)
    .where(
      and(
        eq(recordActivitiesTable.ownerId, ownerId),
        eq(recordActivitiesTable.module, module),
        eq(recordActivitiesTable.recordKey, recordKey),
      ),
    )
    .orderBy(desc(recordActivitiesTable.createdAt))
    .limit(200);
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  ownerId: number;
  showroomId: number;
  title: string;
  detail?: string | null;
  module?: ActivityModule | null;
  recordKey?: string | null;
  assignedEmpCode?: string | null;
  dueOn?: string | null;
  source: TaskRow["source"];
  userId: number | null;
  userName?: string | null;
  principal: string;
}

export async function createTask(input: CreateTaskInput): Promise<WriteResult<TaskRow>> {
  if (!may(input.principal, "task.create")) {
    return { ok: false, status: 403, error: "You may not raise a task." };
  }

  const title = input.title.trim();
  if (!title) return { ok: false, status: 400, error: "A task needs a title." };
  if (title.length > 200) {
    return { ok: false, status: 400, error: "Keep the title under 200 characters — the detail field is for the rest." };
  }
  if (input.dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) {
    return { ok: false, status: 400, error: "dueOn must be a date, as YYYY-MM-DD." };
  }

  /*
   * The assignee must still work here.
   *
   * The same check the reassignment actions make, for the same reason: the DMS
   * goes on naming people who left, and a task on a departed employee's list is
   * a task nobody will ever do. This is the failure the queue's middle band
   * exists to surface — putting new work into it would be perverse.
   */
  let assignedEmpName: string | null = null;
  if (input.assignedEmpCode) {
    const [emp] = await db
      .select({
        empName: dmsEmployeesTable.empName,
        isActive: dmsEmployeesTable.isActive,
        dateOfLeaving: dmsEmployeesTable.dateOfLeaving,
      })
      .from(dmsEmployeesTable)
      .where(
        and(
          eq(dmsEmployeesTable.showroomId, input.showroomId),
          eq(dmsEmployeesTable.empCode, input.assignedEmpCode),
        ),
      );
    if (!emp) {
      return { ok: false, status: 404, error: `No employee ${input.assignedEmpCode} at this showroom.` };
    }
    if (emp.isActive !== "Y") {
      return {
        ok: false,
        status: 400,
        error:
          `${emp.empName} has left the dealership` +
          (emp.dateOfLeaving ? ` (${emp.dateOfLeaving})` : "") +
          ` — a task on their list is a task nobody will do.`,
      };
    }
    assignedEmpName = emp.empName;
  }

  const [row] = await db
    .insert(tasksTable)
    .values({
      ownerId: input.ownerId,
      showroomId: input.showroomId,
      title,
      detail: input.detail?.trim() || null,
      module: input.module ?? null,
      recordKey: input.recordKey ?? null,
      assignedEmpCode: input.assignedEmpCode ?? null,
      assignedEmpName,
      dueOn: input.dueOn ?? null,
      status: "OPEN",
      source: input.source,
      createdByUserId: input.userId,
      createdByName: input.userId === null ? null : (input.userName ?? null),
    })
    .returning();

  if (!row) {
    return { ok: false, status: 403, error: "That record is not one your role can raise a task against." };
  }

  logger.info(
    { taskId: row.id, source: row.source, assignedTo: row.assignedEmpCode },
    "Task raised",
  );
  return { ok: true, row };
}

/**
 * Done, or decided against.
 *
 * `task.complete` is deliberately absent from the agent's grants. Closing a
 * task asserts the work was done, and whether it was is a fact only the person
 * who did it holds — the same reasoning that keeps eight registry actions
 * closed to it.
 */
export async function closeTask(
  ownerId: number,
  userId: number,
  principal: string,
  taskId: number,
  status: "DONE" | "CANCELLED",
  outcome?: string,
): Promise<WriteResult<TaskRow>> {
  if (!may(principal, "task.complete")) {
    return { ok: false, status: 403, error: "You may not close a task." };
  }

  const [existing] = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.ownerId, ownerId)));
  if (!existing) return { ok: false, status: 404, error: `No task ${taskId}` };
  if (existing.status !== "OPEN") {
    return { ok: false, status: 400, error: `That task is already ${existing.status.toLowerCase()}.` };
  }

  const [row] = await db
    .update(tasksTable)
    .set({
      status,
      completedAt: new Date(),
      completedByUserId: userId,
      outcome: outcome?.trim() || null,
    })
    .where(eq(tasksTable.id, taskId))
    .returning();

  return { ok: true, row: row! };
}

/**
 * Open tasks, for the queue.
 *
 * No `showroomId` filter here — the caller passes the outlets the session may
 * see, exactly as the queue does, so a task follows the same visibility rules
 * as everything beside it on the list.
 */
export async function openTasks(
  ownerId: number,
  showroomIds: number[],
): Promise<TaskRow[]> {
  if (showroomIds.length === 0) return [];
  return db
    .select()
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.ownerId, ownerId),
        inArray(tasksTable.showroomId, showroomIds),
        eq(tasksTable.status, "OPEN"),
      ),
    )
    .orderBy(desc(tasksTable.createdAt))
    .limit(500);
}

/**
 * How overdue a task is, in whole days, negative when it is not due yet.
 *
 * A date rather than a timestamp because dealerships work in days, and `null`
 * when no date was set — a task with no due date is not late, it is simply
 * outstanding, and treating those the same would put every standing job at the
 * top of somebody's morning.
 */
export function daysLate(dueOn: string | null): number {
  if (!dueOn) return 0;
  const due = Date.parse(`${dueOn}T00:00:00Z`);
  if (Number.isNaN(due)) return 0;
  return Math.floor((Date.now() - due) / 86_400_000);
}
