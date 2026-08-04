/**
 * The mirror emits events.
 *
 * Sync pulls the dealer's rows. The screens classify them on read. Between
 * those two there was nothing — no record that a file had *moved*, and so
 * nothing any rule could ever be triggered by. This closes that.
 *
 * ## What an event is here
 *
 * The **classifier's answer changing**, not a column changing. That is the
 * Platform-Events reading rather than the Change-Data-Capture one, and it is
 * the decision the rest of the workflow layer rests on: a rule wants to know
 * that a file entered `RC_IN_DRAWER`, not that `rc_received_date` became
 * non-null and would it please work out what that means.
 *
 * It also catches the transitions no field diff ever could. A lead breaches its
 * manufacturer window because *time passed*. A chase goes stale because time
 * passed. A temporary registration lapses because time passed. Nothing in the
 * dealer's system changes; the answer does. Those are precisely the changes
 * nobody is watching for, which is the whole argument for the product.
 *
 * ## How it detects them
 *
 * Rebuild every projection for the showroom, read the latest event per record,
 * and write a row wherever the two disagree. Deliberately a comparison rather
 * than a hook inside each sync: the state depends on more than the row that
 * changed — on other records, on the entity graph, on the clock — and a hook
 * fired from one table's write would miss every state that moved for a reason
 * outside that table.
 *
 * ## Cost, and why it is acceptable
 *
 * This runs the same builders the screens run, once per showroom per pass. A
 * dealership has hundreds of open records, not millions, and the pass already
 * makes dozens of HTTP calls to the dealer's ERP — the classification is not
 * where the time goes. When that stops being true the answer is to store the
 * last state alongside the mirror row, and the comment on `record_events`
 * explains why that is the *second* choice rather than the first.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db, recordEventsTable, showroomsTable, type RecordEventRow } from "@workspace/db";
import { logger } from "../logger";
import { buildWorklist } from "./worklist";
import { buildServiceWorklist } from "./service-worklist";
import { buildLeadWorklist } from "./lead-worklist";
import { buildRegistrationWorklist } from "./registration-worklist";
import { buildSparesWorklist } from "./spares-worklist";
import { buildReceivablesWorklist } from "./receivables-worklist";
import { buildInventoryWorklist } from "./inventory-worklist";

export type EventModule =
  | "DEAL"
  | "JOB_CARD"
  | "ENQUIRY"
  | "REGISTRATION"
  | "PART"
  | "RECEIVABLE"
  | "VEHICLE";

export interface DetectResult {
  showroomId: number;
  /** Records classified this pass. */
  seen: number;
  /** Records classified for the first time — `fromState` null. */
  firstSeen: number;
  /** Records whose state actually moved. The number that matters. */
  changed: number;
  durationMs: number;
}

interface Observed {
  module: EventModule;
  recordKey: string;
  showroomId: number;
  state: string;
}

/**
 * A record's identity: module, outlet and its own key. See `currentStates`.
 *
 * The separator only has to be unambiguous for the first two segments, and it
 * is: `module` comes from a fixed enum and `showroomId` is an integer, so
 * neither can contain a colon however strange a dealer's record key turns out
 * to be.
 */
function stateKey(module: string, showroomId: number, recordKey: string): string {
  return `${module}:${showroomId}:${recordKey}`;
}

/**
 * Every record at this showroom, with the state its own screen would show.
 *
 * Read through the same `build…Worklist` functions the screens use, for the
 * reason `recordState` in `tools.ts` does: re-deriving here would be faster and
 * would drift the first time a rule changed in one place and not the other. An
 * event stream that disagrees with the screen it came from is worse than no
 * event stream.
 */
async function observe(showroomId: number, ownerShowroomIds: number[]): Promise<Observed[]> {
  const [deals, jobCards, leads, registrations, parts, receivables, vehicles] = await Promise.all([
    buildWorklist({ showroomId }),
    buildServiceWorklist({ showroomId }),
    buildLeadWorklist({ showroomId }),
    buildRegistrationWorklist({ showroomId }),
    buildSparesWorklist({ showroomId, ownerShowroomIds }),
    buildReceivablesWorklist({ showroomId, ownerShowroomIds }),
    buildInventoryWorklist({ showroomId, ownerShowroomIds }),
  ]);

  const out: Observed[] = [];
  // Deals carry `reconcile` rather than `state` — the column is older than the
  // convention. It is the same thing: the classifier's answer for that row.
  for (const r of deals) out.push({ module: "DEAL", recordKey: r.dealId, showroomId, state: r.reconcile });
  for (const r of jobCards) out.push({ module: "JOB_CARD", recordKey: r.jcNo, showroomId, state: r.state });
  for (const r of leads) out.push({ module: "ENQUIRY", recordKey: r.enqId, showroomId, state: r.state });
  for (const r of registrations) out.push({ module: "REGISTRATION", recordKey: r.regnFileNo, showroomId, state: r.state });
  for (const r of parts) out.push({ module: "PART", recordKey: r.partNo, showroomId, state: r.state });
  for (const r of receivables) out.push({ module: "RECEIVABLE", recordKey: r.receivableId, showroomId, state: r.state });
  for (const r of vehicles) out.push({ module: "VEHICLE", recordKey: r.chassisNo, showroomId, state: r.state });
  return out;
}

/**
 * The current state of every record this owner holds, from the log itself.
 *
 * `distinct on` is Postgres-specific and is the reason there is no companion
 * table: the newest row per record *is* the state, so the two can never
 * disagree. The index on `(module, showroom_id, record_key, id)` is what makes
 * it one scan rather than a sort of everything.
 *
 * **The showroom is part of the identity**, and leaving it out was a real bug
 * rather than a tidiness point. `dms_part_stock` is keyed on
 * `(showroomId, partNo)` unlike every other mirror — stock is at an outlet, not
 * at a dealer code — so `HR-BRK-SHOE-R` exists at both branches and is
 * `AVAILABLE_ELSEWHERE` at one and `OK` at the other. Keyed on the part number
 * alone, the two outlets overwrote each other on every pass and the log flapped
 * between the two states forever. A key on the record has to be the key the
 * record actually has.
 */
export async function currentStates(
  ownerId: number,
): Promise<Map<string, { state: string; since: Date }>> {
  const rows = await db.execute<{
    module: string;
    showroom_id: number;
    record_key: string;
    to_state: string;
    detected_at: Date;
  }>(sql`
    select distinct on (module, showroom_id, record_key)
           module, showroom_id, record_key, to_state, detected_at
      from record_events
     where owner_id = ${ownerId}
     order by module, showroom_id, record_key, id desc
  `);

  const map = new Map<string, { state: string; since: Date }>();
  for (const r of rows.rows ?? []) {
    map.set(stateKey(r.module, r.showroom_id, r.record_key), {
      state: r.to_state,
      since: new Date(r.detected_at),
    });
  }
  return map;
}

/**
 * Compare what the screens would show against what the log last recorded, and
 * write the difference.
 *
 * Returns counts rather than the events themselves: on a first pass this
 * produces one row per record and a caller logging them all would drown the
 * thing it was trying to make visible.
 */
export async function detectStateChanges(
  ownerId: number,
  showroomId: number,
  ownerShowroomIds: number[],
): Promise<DetectResult> {
  const startedAt = Date.now();

  const [observed, known] = await Promise.all([
    observe(showroomId, ownerShowroomIds),
    currentStates(ownerId),
  ]);

  const pending: Array<typeof recordEventsTable.$inferInsert> = [];
  let firstSeen = 0;
  let changed = 0;

  for (const o of observed) {
    const prior = known.get(stateKey(o.module, o.showroomId, o.recordKey));
    if (prior && prior.state === o.state) continue;

    if (prior) changed++;
    else firstSeen++;

    pending.push({
      ownerId,
      showroomId: o.showroomId,
      module: o.module,
      recordKey: o.recordKey,
      fromState: prior?.state ?? null,
      toState: o.state,
    });
  }

  // One insert rather than one per event. The first pass over a showroom
  // produces fifty of these and OBJ-9 already paid for learning that the cost
  // is round trips to a pooler in another region, not Postgres.
  if (pending.length > 0) await db.insert(recordEventsTable).values(pending);

  const result: DetectResult = {
    showroomId,
    seen: observed.length,
    firstSeen,
    changed,
    durationMs: Date.now() - startedAt,
  };

  // Only worth a line when something moved. A quiet pass is the normal case and
  // logging it every fifteen minutes would bury the passes that matter.
  if (changed > 0 || firstSeen > 0) logger.info(result, "Derived-state changes detected");
  return result;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface EventQuery {
  showroomId?: number;
  module?: EventModule;
  recordKey?: string;
  limit?: number;
}

/**
 * The log, newest first.
 *
 * Owner-scoped from the session like everything else, and the record filter is
 * what the timeline on a record will read. Kept deliberately plain: this is the
 * substrate three later objectives sit on, and giving it opinions now would
 * mean unpicking them.
 */
export async function listEvents(
  ownerId: number,
  q: EventQuery = {},
): Promise<RecordEventRow[]> {
  return db
    .select()
    .from(recordEventsTable)
    .where(
      and(
        eq(recordEventsTable.ownerId, ownerId),
        q.showroomId ? eq(recordEventsTable.showroomId, q.showroomId) : undefined,
        q.module ? eq(recordEventsTable.module, q.module) : undefined,
        q.recordKey ? eq(recordEventsTable.recordKey, q.recordKey) : undefined,
      ),
    )
    .orderBy(desc(recordEventsTable.id))
    .limit(Math.min(q.limit ?? 100, 500));
}

/**
 * Every outlet an owner holds.
 *
 * Duplicated from the route layer on purpose: the scheduler calls the detector
 * with nobody signed in, so it cannot reach a session to ask. `db` here is the
 * request-scoped proxy, which resolves to `ownerDb` outside a scope — and the
 * scheduler is outside one by design.
 */
export async function showroomIdsForOwner(ownerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, ownerId));
  return rows.map((r) => r.id);
}

export async function detectForShowrooms(
  ownerId: number,
  showroomIds: number[],
): Promise<DetectResult[]> {
  const owned = await showroomIdsForOwner(ownerId);
  const scope = showroomIds.filter((id) => owned.includes(id));
  const results: DetectResult[] = [];
  for (const showroomId of scope) {
    results.push(await detectStateChanges(ownerId, showroomId, owned));
  }
  return results;
}

export const EVENT_MODULES: ReadonlySet<string> = new Set<EventModule>([
  "DEAL",
  "JOB_CARD",
  "ENQUIRY",
  "REGISTRATION",
  "PART",
  "RECEIVABLE",
  "VEHICLE",
]);

export type { RecordEventRow };
