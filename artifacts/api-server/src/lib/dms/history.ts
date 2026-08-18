/**
 * One record's history, assembled from every place that holds a piece of it
 * (OBJ-49, R-133, R-134).
 *
 * ## The gap this closes, and it is sharper than it sounds
 *
 * The timeline on the queue reads `record_activities` — what somebody **wrote
 * down**. It does not read `decision_log`, which is what somebody **did**. So
 * an advisor who pressed *Mark customer told* left no trace on the record's own
 * history: the decision was recorded, correctly and with his name on it, in a
 * table no screen was reading.
 *
 * That is survivable while the person who pressed the button is the person
 * reading the screen. It stops being survivable the moment somebody else picks
 * the record up — which, in a dealership short of staff, is the ordinary case
 * rather than the exception. **The question a manager has at nine in the
 * morning is *has anyone already rung her*, and the answer was in the database
 * and on no page.**
 *
 * ## Five sources, and they do not share a clock
 *
 * ```
 *   dms_*.lastChangedAt      their system changed it
 *   record_events            we noticed the derived state move
 *   decision_log             somebody here did something, or the agent did
 *   record_activities        somebody wrote something down
 *   outbound / inbound       we said something, or they answered
 * ```
 *
 * Merging those into one `when` column would be the easy version and it would
 * lie. A record can move in the dealer's system on the 2nd, be pulled on the
 * 5th and be *noticed* on the 5th; a single timestamp reads as *nothing
 * happened for three days*, which is false in the direction that makes somebody
 * stop chasing. So **every entry carries the clock it is on** and says so on
 * its face.
 *
 * ## What it will not do
 *
 * It does not infer. If nobody logged a call, the history says nobody logged a
 * call — it does not read a sent message as a conversation or an elapsed day as
 * an attempt. And it cannot go back further than `firstSeenAt`: a job card
 * opened before this dealership onboarded has history in the dealer's own
 * system that was never pulled and cannot be invented, so the history states
 * how far back it can see rather than opening in the middle and looking whole.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  decisionLogTable,
  recordActivitiesTable,
  recordEventsTable,
  outboundMessagesTable,
  inboundMessagesTable,
  dmsEmployeesTable,
  dmsDealsTable,
  dmsRegistrationsTable,
  dmsJobCardsTable,
  dmsEnquiriesTable,
  dmsPartStockTable,
  dmsReceivablesTable,
  dmsVehicleStockTable,
} from "@workspace/db";

import type { AccessModule } from "./permissions";

/**
 * Which clock an entry is on. The whole point of the file.
 *
 * `WE_NOTICED` is deliberately not called *changed*: the derived state moving
 * is our reading of their data, and the moment we read it is not the moment it
 * became true.
 */
export type HistoryClock =
  | "THEIRS"
  | "WE_NOTICED"
  | "SOMEBODY_HERE"
  | "THE_AGENT"
  | "THE_CUSTOMER";

const CLOCK_NOTE: Record<HistoryClock, string> = {
  THEIRS: "their system",
  WE_NOTICED: "when we noticed",
  SOMEBODY_HERE: "somebody here",
  THE_AGENT: "the agent",
  THE_CUSTOMER: "the customer",
};

export interface HistoryEntry {
  at: string;
  clock: HistoryClock;
  /** The clock in words, so the screen never has to know what the enum means. */
  clockNote: string;
  kind:
    | "FIRST_SEEN"
    | "THEIR_CHANGE"
    | "STATE_MOVED"
    | "DECISION"
    | "ACTIVITY"
    | "MESSAGE_SENT"
    | "MESSAGE_HELD"
    | "REPLY";
  /** A person's name, "the agent", or null where nobody is claimed. */
  who: string | null;
  headline: string;
  detail: string | null;
  /** Which table and row this came off, so nothing here is unattributable. */
  source: { table: string; id: number };
  /** Whether this counts as an **attempt to move the record along**. */
  tried: boolean;
  retracted: boolean;
}

export interface RecordOwner {
  empCode: string | null;
  name: string | null;
  /** Whose claim this is — theirs from the mirror, or a handover we recorded. */
  origin: "MIRROR" | "DDMS" | null;
  /**
   * `false` when the dealer's own staff master gives them a leaving date.
   *
   * Null when we cannot say — an employee code that is not in the roster at
   * all, which is a different thing from having left and must not be reported
   * as the same.
   */
  stillHere: boolean | null;
  note: string;
}

export interface RecordHistory {
  module: string;
  recordKey: string;
  /**
   * Which outlet the record is at, read off the mirror row.
   *
   * Returned rather than required, because every control on the page needs it
   * and the alternative is each of them digging it out of the field list and
   * parsing a string back into a number.
   */
  showroomId: number;
  entries: HistoryEntry[];
  /** The subset that is somebody actually trying to move it along. */
  tried: HistoryEntry[];
  owner: RecordOwner;
  /** How far back this history can see, and it is not the record's beginning. */
  knownSince: string | null;
  /** How long the record has been in the state it is in now. */
  inCurrentStateSince: string | null;
  currentState: string | null;
  limits: string[];
}

// ── what a decision looks like when a person reads it ───────────────────────

/**
 * One sentence per action, in the past tense and naming the customer's side of
 * it where there is one.
 *
 * Not derived from the action id, because `JOB_CARD_MARK_INFORMED` renders as
 * *"job card mark informed"* and that is the kind of half-English that makes a
 * screen read as though nobody uses it.
 */
const DID: Record<string, { did: string; undid: string; tried: boolean }> = {
  ENQUIRY_LOG_CONTACT: { did: "Logged contact with the customer", undid: "Took back the logged contact", tried: true },
  ENQUIRY_REASSIGN: { did: "Handed the lead to somebody else", undid: "Took back the reassignment", tried: false },
  JOB_CARD_MARK_INFORMED: { did: "Told the customer where their vehicle is", undid: "Took back — the customer was not told", tried: true },
  JOB_CARD_REASSIGN: { did: "Handed the job card to somebody else", undid: "Took back the handover", tried: false },
  REGISTRATION_ASSIGN_AGENT: { did: "Gave the file to an RTO agent", undid: "Took the file back off the agent", tried: false },
  REGISTRATION_MARK_NOTIFIED: { did: "Told the customer about their registration", undid: "Took back — the customer was not told", tried: true },
  REGISTRATION_LOG_CHASE: { did: "Chased the RTO", undid: "Took back the chase", tried: true },
  PART_REQUEST_TRANSFER: { did: "Asked another branch to send the part", undid: "Cancelled the transfer request", tried: true },
  PART_RAISE_REORDER: { did: "Raised a reorder", undid: "Took back the reorder", tried: false },
  RECEIVABLE_LOG_CHASE: { did: "Chased the customer for payment", undid: "Took back the chase", tried: true },
  RECEIVABLE_MARK_DISPUTED: { did: "Marked the account disputed", undid: "Took back the dispute", tried: false },
  VEHICLE_MARK_OFFERED: { did: "Offered the machine to a customer", undid: "Took back the offer", tried: true },
  VEHICLE_PROPOSE_TRANSFER: { did: "Proposed moving the machine to another branch", undid: "Withdrew the proposal", tried: false },
};

/**
 * A clear is an undo, and the decision log already says so.
 *
 * `applyAction` writes the action as `${id}_CLEARED` when somebody undoes one,
 * so the row itself carries the answer. The first version of this file inferred
 * it by checking whether every changed value was null — which is true of an undo
 * and would also have been true of an action that legitimately set one field to
 * null, so it was a guess dressed as a derivation when the fact was on the row.
 */
function readAction(action: string): { id: string; cleared: boolean } {
  return action.endsWith("_CLEARED")
    ? { id: action.slice(0, -"_CLEARED".length), cleared: true }
    : { id: action, cleared: false };
}

const ACTIVITY_TRIED = new Set(["CALL", "VISIT", "MESSAGE"]);

const ACTIVITY_LABEL: Record<string, string> = {
  NOTE: "Left a note",
  CALL: "Rang the customer",
  VISIT: "The customer came in",
  MESSAGE: "Messaged the customer",
  OBSERVED: "Noticed",
  SYSTEM: "The system recorded",
};

const MIRROR = {
  DEAL: { table: dmsDealsTable, key: dmsDealsTable.dealId, assignee: null },
  REGISTRATION: {
    table: dmsRegistrationsTable,
    key: dmsRegistrationsTable.regnFileNo,
    assignee: "assignedAgentEmpCode",
  },
  JOB_CARD: { table: dmsJobCardsTable, key: dmsJobCardsTable.jcNo, assignee: "advisorEmpCode" },
  ENQUIRY: { table: dmsEnquiriesTable, key: dmsEnquiriesTable.enqId, assignee: "assignedEmpCode" },
  PART: { table: dmsPartStockTable, key: dmsPartStockTable.partNo, assignee: null },
  /* receivableId, not invoiceNo — see the note in case.ts. */
  RECEIVABLE: { table: dmsReceivablesTable, key: dmsReceivablesTable.receivableId, assignee: null },
  VEHICLE: { table: dmsVehicleStockTable, key: dmsVehicleStockTable.chassisNo, assignee: null },
} as const;

/**
 * Which field carries a handover **we** recorded, where the module has one.
 *
 * Read before the mirror's own assignee, because a handover is the more recent
 * claim by construction: the dealer's system still names whoever opened the
 * card, and the whole reason the field exists is that it did not notice the
 * work moving to somebody else.
 */
const HANDOVER: Partial<Record<string, string>> = {
  ENQUIRY: "reassignedToEmpCode",
  JOB_CARD: "reassignedToEmpCode",
  REGISTRATION: "assignedAgentEmpCode",
};

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : String(d);

/**
 * Who is holding this record, and whether they still work here.
 *
 * The second half is the one a manager needs and the one the dealer's own
 * system already answers — `dateOfLeaving` is on the staff master and is what
 * puts orphaned work in the queue's *Nobody's* band.
 *
 * **It cannot say whether they came in this morning**, and does not try. No DMS
 * carries attendance, and a page that guessed at absence would be wrong twice a
 * week and stop being read.
 */
export async function ownerOfRecord(input: {
  module: AccessModule;
  recordKey: string;
  /** Where the record lives. Read off the mirror row rather than asked for. */
  showroomId: number;
}): Promise<RecordOwner> {
  const spec = MIRROR[input.module as keyof typeof MIRROR];
  const none: RecordOwner = {
    empCode: null,
    name: null,
    origin: null,
    stillHere: null,
    note: "Nobody is named against this record.",
  };
  if (!spec) return none;

  const [row] = await db
    .select()
    .from(spec.table)
    .where(eq(spec.key, input.recordKey))
    .limit(1);
  if (!row) return none;

  const record = row as unknown as Record<string, unknown>;
  const handoverField = HANDOVER[input.module];
  const handedTo = handoverField ? (record[handoverField] as string | null) : null;
  const mirrorAssignee = spec.assignee ? (record[spec.assignee] as string | null) : null;

  const empCode = handedTo ?? mirrorAssignee;
  if (!empCode) return none;
  const origin: "MIRROR" | "DDMS" = handedTo ? "DDMS" : "MIRROR";

  const [emp] = await db
    .select({
      empName: dmsEmployeesTable.empName,
      dateOfLeaving: dmsEmployeesTable.dateOfLeaving,
      role: dmsEmployeesTable.role,
    })
    .from(dmsEmployeesTable)
    .where(
      and(
        eq(dmsEmployeesTable.showroomId, input.showroomId),
        eq(dmsEmployeesTable.empCode, empCode),
      ),
    )
    .limit(1);

  if (!emp) {
    return {
      empCode,
      name: null,
      origin,
      stillHere: null,
      /*
       * Not "they have left". An employee code the staff master has never heard
       * of is a keying error or a roster that has not synced, and reporting it
       * as a departure would send a manager to reassign work that is fine.
       */
      note: `${empCode} is not in the staff master, so we cannot say whether they still work here.`,
    };
  }

  const stillHere = !emp.dateOfLeaving;
  return {
    empCode,
    name: emp.empName,
    origin,
    stillHere,
    note: stillHere
      ? `${emp.empName} (${emp.role})${origin === "DDMS" ? " — handed over here, the dealer's system still names somebody else" : ""}`
      : `${emp.empName} left on ${emp.dateOfLeaving}. This work is on nobody's list.`,
  };
}

/**
 * Everything that has happened to one record, newest first.
 *
 * Read-only, and it writes nothing — including no *viewed* marker. A history
 * that recorded being read would put a row on every page load and drown the
 * thing it exists to show.
 */
export async function recordHistory(input: {
  ownerId: number;
  module: AccessModule;
  recordKey: string;
}): Promise<RecordHistory> {
  const entries: HistoryEntry[] = [];
  const limits: string[] = [];

  /*
   * The outlet is **read off the record**, not passed in.
   *
   * `caseFor` takes no showroom either, and for the same reason: row-level
   * security already decides which rows this connection can see, so asking the
   * caller which branch a record is at adds a parameter that can be wrong
   * without adding anything that can be right.
   */
  let showroomId = 0;

  // ── the mirror: how far back we can see, and their last change ───────────
  const spec = MIRROR[input.module as keyof typeof MIRROR];
  let knownSince: string | null = null;
  if (spec) {
    const [row] = await db
      .select()
      .from(spec.table)
      .where(eq(spec.key, input.recordKey))
      .limit(1);
    if (row) {
      const record = row as unknown as Record<string, unknown>;
      showroomId = Number(record["showroomId"] ?? 0);
      knownSince = iso(record["firstSeenAt"] as Date | null);
      const changed = iso(record["lastChangedAt"] as Date | null);

      if (knownSince) {
        entries.push({
          at: knownSince,
          clock: "WE_NOTICED",
          clockNote: CLOCK_NOTE.WE_NOTICED,
          kind: "FIRST_SEEN",
          who: null,
          headline: "This record first appeared in a sync",
          detail:
            "Anything that happened before this is in the dealer's own system and was never pulled, " +
            "so it is not here and cannot be.",
          source: { table: "mirror", id: Number(record["id"] ?? 0) },
          tried: false,
          retracted: false,
        });
      }
      if (changed && changed !== knownSince) {
        entries.push({
          at: changed,
          clock: "THEIRS",
          clockNote: CLOCK_NOTE.THEIRS,
          kind: "THEIR_CHANGE",
          who: null,
          headline: "Their system last changed this record",
          /*
           * One entry and not a series, because the mirror keeps a single
           * `lastChangedAt` rather than a log. Saying so is better than showing
           * one dot and letting it read as the only thing they ever did.
           */
          detail: "The mirror keeps only the most recent change, so earlier ones are not shown.",
          source: { table: "mirror", id: Number(record["id"] ?? 0) },
          tried: false,
          retracted: false,
        });
      }
    }
  }

  // ── the derived state moving ─────────────────────────────────────────────
  const events = await db
    .select()
    .from(recordEventsTable)
    .where(
      and(
        eq(recordEventsTable.ownerId, input.ownerId),
        eq(recordEventsTable.module, input.module as never),
        eq(recordEventsTable.recordKey, input.recordKey),
      ),
    )
    .orderBy(desc(recordEventsTable.detectedAt))
    .limit(100);

  for (const e of events) {
    entries.push({
      at: iso(e.detectedAt)!,
      clock: "WE_NOTICED",
      clockNote: CLOCK_NOTE.WE_NOTICED,
      kind: "STATE_MOVED",
      who: null,
      headline: e.fromState ? `${e.fromState} → ${e.toState}` : `Became ${e.toState}`,
      detail: null,
      source: { table: "record_events", id: e.id },
      tried: false,
      retracted: false,
    });
  }

  // ── what somebody did, with their name on it ─────────────────────────────
  const decisions = await db
    .select({
      id: decisionLogTable.id,
      action: decisionLogTable.action,
      userId: decisionLogTable.userId,
      /*
       * The name off the decision log's own row, not a join.
       *
       * `ddms_app` has no grants on `users` - it cannot read a token hash and
       * therefore cannot invent a session - so a join here is refused by
       * Postgres, correctly, and the first version of this file was. The name
       * is copied onto the row at the moment of the decision instead.
       */
      userName: decisionLogTable.userName,
      previousValue: decisionLogTable.previousValue,
      newValue: decisionLogTable.newValue,
      note: decisionLogTable.note,
      createdAt: decisionLogTable.createdAt,
    })
    .from(decisionLogTable)
    .where(
      and(
        eq(decisionLogTable.ownerId, input.ownerId),
        eq(decisionLogTable.module, input.module as never),
        eq(decisionLogTable.recordKey, input.recordKey),
      ),
    )
    .orderBy(desc(decisionLogTable.createdAt))
    .limit(100);

  for (const d of decisions) {
    const { id, cleared } = readAction(d.action);
    const known = DID[id];
    entries.push({
      at: iso(d.createdAt)!,
      /*
       * A null user is the agent and never "we lost track" - R-60, and the same
       * convention the outbox and the rules already use.
       */
      clock: d.userId === null ? "THE_AGENT" : "SOMEBODY_HERE",
      clockNote: d.userId === null ? CLOCK_NOTE.THE_AGENT : CLOCK_NOTE.SOMEBODY_HERE,
      kind: "DECISION",
      who: d.userId === null ? "the agent" : (d.userName ?? "somebody"),
      headline: known ? (cleared ? known.undid : known.did) : d.action,
      detail: d.note,
      source: { table: "decision_log", id: d.id },
      tried: Boolean(known?.tried) && !cleared,
      retracted: false,
    });
  }

  // ── what somebody wrote down ─────────────────────────────────────────────
  const activities = await db
    .select()
    .from(recordActivitiesTable)
    .where(
      and(
        eq(recordActivitiesTable.ownerId, input.ownerId),
        eq(recordActivitiesTable.module, input.module as never),
        eq(recordActivitiesTable.recordKey, input.recordKey),
      ),
    )
    .orderBy(desc(recordActivitiesTable.createdAt))
    .limit(200);

  for (const a of activities) {
    const byAgent = a.authoredBy === "AGENT";
    entries.push({
      at: iso(a.createdAt)!,
      clock: byAgent ? "THE_AGENT" : "SOMEBODY_HERE",
      clockNote: byAgent ? CLOCK_NOTE.THE_AGENT : CLOCK_NOTE.SOMEBODY_HERE,
      kind: "ACTIVITY",
      who: byAgent ? "the agent" : (a.authorName ?? "somebody"),
      headline: ACTIVITY_LABEL[a.kind] ?? a.kind,
      detail: a.body,
      source: { table: "record_activities", id: a.id },
      /*
       * A retracted call is not an attempt. Somebody withdrew the claim that it
       * happened, and counting it would leave a manager believing the customer
       * has been spoken to on the strength of a note struck through above.
       */
      tried: ACTIVITY_TRIED.has(a.kind) && !a.retractedAt,
      retracted: Boolean(a.retractedAt),
    });
  }

  // ── what we said to them ─────────────────────────────────────────────────
  const out = await db
    .select({
      id: outboundMessagesTable.id,
      channel: outboundMessagesTable.channel,
      audience: outboundMessagesTable.audience,
      toName: outboundMessagesTable.toName,
      body: outboundMessagesTable.body,
      status: outboundMessagesTable.status,
      draftedBy: outboundMessagesTable.draftedBy,
      authorisedBasis: outboundMessagesTable.authorisedBasis,
      sentAt: outboundMessagesTable.sentAt,
      createdAt: outboundMessagesTable.createdAt,
      /*
       * The outbox stores an approver **id** and no name, and `ddms_app` may
       * not read `users` to resolve it. So an approved message says *somebody
       * here* rather than naming them — a limit worth stating rather than
       * papering over, and the fix when it matters is a name column on the
       * outbox, the same one the decision log now carries.
       */
      approvedByUserId: outboundMessagesTable.approvedByUserId,
    })
    .from(outboundMessagesTable)
    .where(
      and(
        eq(outboundMessagesTable.ownerId, input.ownerId),
        eq(outboundMessagesTable.module, input.module as never),
        eq(outboundMessagesTable.recordKey, input.recordKey),
      ),
    )
    .orderBy(desc(outboundMessagesTable.createdAt))
    .limit(50);

  for (const m of out) {
    const sent = iso(m.sentAt);
    const byRule = m.authorisedBasis === "RULE";
    if (sent) {
      entries.push({
        at: sent,
        clock: byRule ? "THE_AGENT" : "SOMEBODY_HERE",
        clockNote: byRule ? CLOCK_NOTE.THE_AGENT : CLOCK_NOTE.SOMEBODY_HERE,
        kind: "MESSAGE_SENT",
        who: byRule ? "the agent" : m.approvedByUserId ? "somebody here" : "somebody",
        headline: `${m.channel} sent to ${m.toName ?? m.audience.toLowerCase()}`,
        detail: m.body,
        source: { table: "outbound_messages", id: m.id },
        tried: m.audience === "CUSTOMER",
        retracted: false,
      });
      continue;
    }
    /*
     * A draft that never left is on the history and is **not** an attempt.
     * Whoever picks this record up needs to know a message is sitting waiting
     * for approval; treating it as contact is how a customer is recorded as
     * told about something nobody ever sent them.
     */
    entries.push({
      at: iso(m.createdAt)!,
      clock: m.draftedBy === "PERSON" ? "SOMEBODY_HERE" : "THE_AGENT",
      clockNote: m.draftedBy === "PERSON" ? CLOCK_NOTE.SOMEBODY_HERE : CLOCK_NOTE.THE_AGENT,
      kind: "MESSAGE_HELD",
      who: m.draftedBy === "PERSON" ? "somebody" : "the agent",
      headline: `${m.channel} drafted and not sent — ${m.status}`,
      detail: m.body,
      source: { table: "outbound_messages", id: m.id },
      tried: false,
      retracted: false,
    });
  }

  // ── what they said back ──────────────────────────────────────────────────
  const replies = await db
    .select()
    .from(inboundMessagesTable)
    .where(
      and(
        eq(inboundMessagesTable.ownerId, input.ownerId),
        eq(inboundMessagesTable.module, input.module as never),
        eq(inboundMessagesTable.recordKey, input.recordKey),
      ),
    )
    .orderBy(desc(inboundMessagesTable.receivedAt))
    .limit(50);

  for (const r of replies) {
    entries.push({
      at: iso(r.receivedAt)!,
      clock: "THE_CUSTOMER",
      clockNote: CLOCK_NOTE.THE_CUSTOMER,
      kind: "REPLY",
      who: r.fromName ?? r.fromAddress,
      headline: r.readAt ? "They replied" : "They replied — nobody has opened it",
      /*
       * Verbatim. Nothing reads it, nothing summarises it, and no rule fires on
       * its contents - a model deciding what a customer meant is the judgement
       * R-49 reserves for a person, and the failure is silent.
       */
      detail: r.body,
      source: { table: "inbound_messages", id: r.id },
      tried: false,
      retracted: false,
    });
  }

  entries.sort((a, b) => b.at.localeCompare(a.at));

  const newestEvent = events[0];
  if (!knownSince) {
    limits.push(
      "This record is not in the mirror, so there is no telling how far back its history should go.",
    );
  } else {
    limits.push(
      `Nothing before ${knownSince.slice(0, 10)} is here. That is when this record first arrived in a sync, ` +
        "not when it began — the rest is in the dealer's own system and was never pulled.",
    );
  }
  if (entries.filter((e) => e.tried).length === 0) {
    limits.push(
      "Nothing has been recorded as an attempt to move this along. That may mean nobody has tried, " +
        "or that somebody tried and did not record it — those are different, and this cannot tell them apart.",
    );
  }

  const owner = await ownerOfRecord({
    module: input.module,
    recordKey: input.recordKey,
    showroomId,
  });

  return {
    module: input.module,
    recordKey: input.recordKey,
    showroomId,
    entries,
    tried: entries.filter((e) => e.tried),
    owner,
    knownSince,
    inCurrentStateSince: newestEvent ? iso(newestEvent.detectedAt) : null,
    currentState: newestEvent?.toState ?? null,
    limits,
  };
}
