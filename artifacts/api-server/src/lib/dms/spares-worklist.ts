/**
 * The parts counter, read across the whole group.
 *
 * Fifth instance of the mirror pattern, and the first one that answers a
 * question a single branch **cannot** answer however carefully it looks.
 *
 * The other four modules each read something one outlet could in principle have
 * noticed and did not: a policy nobody keyed in, a customer nobody rang, a lead
 * nobody opened, a certificate nobody handed over. This one is different in
 * kind. A DMS keeps the stock ledger against a dealer code, because a dealer
 * code is what it thinks a business is. An owner with three outlets gets three
 * ledgers and no way to ask:
 *
 * > **Does anybody in this company already have the part a customer has been
 * > waiting three days for?**
 *
 * Neither branch is being careless. Neither branch can see the other's shelf.
 * That is the argument for an owner-level product in one query, and it is why
 * `buildSparesWorklist` deliberately reads across every showroom the session's
 * owner holds rather than only the one on screen.
 *
 * The job-card join is the other half. A part is not short because a number is
 * low — it is short because somebody is waiting for it, and the workshop mirror
 * already knows who.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  db,
  dmsJobCardsTable,
  dmsPartStockTable,
  showroomsTable,
  showroomDmsAccountsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { policyForShowroom, type ResolvedPolicy } from "./policy";
import { partSourceFor } from "./ingest";
import { toIsoDate, toAmount } from "./hero-adapter";
import type { DmsPartStock } from "./types";

export interface SparesSyncResult {
  showroomId: number;
  dealerCode: string;
  seen: number;
  added: number;
  changed: number;
  unchanged: number;
  disappeared: number;
  durationMs: number;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function project(p: DmsPartStock) {
  return {
    partDesc: p.partDesc,
    binLocation: p.binLocation,
    qtyOnHand: p.qtyOnHand,
    qtyReserved: p.qtyReserved,
    reorderLevel: p.reorderLevel,
    mrpAmount: toAmount(p.mrpAmt),
    costAmount: toAmount(p.costAmt),
    lastReceivedDate: toIsoDate(p.lastReceivedDt) || null,
    lastIssuedDate: toIsoDate(p.lastIssuedDt) || null,
    onOrderQty: p.onOrderQty,
    onOrderEtaDate: toIsoDate(p.onOrderEtaDt) || null,
  };
}

export async function syncShowroomParts(showroomId: number): Promise<SparesSyncResult[]> {
  const accounts = await db
    .select({ dealerCode: showroomDmsAccountsTable.dealerCode })
    .from(showroomDmsAccountsTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, showroomDmsAccountsTable.showroomId))
    .where(
      and(
        eq(showroomDmsAccountsTable.showroomId, showroomId),
        eq(showroomDmsAccountsTable.isActive, true),
        eq(showroomsTable.isActive, true),
      ),
    );

  const results: SparesSyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncDealerParts(showroomId, account.dealerCode));
  }
  return results;
}

async function syncDealerParts(showroomId: number, dealerCode: string): Promise<SparesSyncResult> {
  const startedAt = Date.now();
  /*
   * The one line that makes three paths possible.
   *
   * Everything below is written against a `Source<T>` and cannot tell the OEM's
   * API from a register somebody exported this morning. A dealership nobody has
   * configured resolves to `API` and behaves exactly as it did before.
   */
  const source = await partSourceFor(showroomId, dealerCode);
  const listed = await source.list();
  /*
   * Loaded in one go, and that is not a lost optimisation.
   *
   * This source's `load` filters an array it has already fetched — a
   * parts ledger has no detail view worth a round trip — so listing and
   * loading cost the same call. The unchanged check below still spares
   * the writes, which is where the cost actually was.
   */
  const lines = (await source.load(listed.map((l) => l.key))).map((s) => s.record);


  const existing = await db
    .select({ partNo: dmsPartStockTable.partNo, rawHash: dmsPartStockTable.rawHash })
    .from(dmsPartStockTable)
    .where(eq(dmsPartStockTable.showroomId, showroomId));

  const known = new Map(existing.map((r) => [r.partNo, r]));

  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const line of lines) {
    // No second fetch here, unlike the other four syncs. The list endpoint
    // already returns the whole row — a parts ledger has no detail view worth
    // a round trip and no personal data to withhold from the list.
    const lineHash = hashOf(line);
    const prior = known.get(line.partNo);
    const now = new Date();

    if (prior && prior.rawHash === lineHash) {
      await db
        .update(dmsPartStockTable)
        .set({ lastSyncedAt: now, disappearedAt: null })
        .where(
          and(
            eq(dmsPartStockTable.showroomId, showroomId),
            eq(dmsPartStockTable.partNo, line.partNo),
          ),
        );
      unchanged++;
      continue;
    }

    const projected = project(line);

    if (!prior) {
      await db.insert(dmsPartStockTable).values({
        showroomId,
        dealerCode,
        partNo: line.partNo,
        ...projected,
        raw: line as unknown as Record<string, unknown>,
        rawHash: lineHash,
        firstSeenAt: now,
        lastSyncedAt: now,
        lastChangedAt: null,
      });
      added++;
      continue;
    }

    // No status clock on this table, unlike the other four. A stock line has no
    // status — it has a quantity, and "how long has it been at this quantity"
    // is not a question anybody asks. What matters is how long since it moved,
    // and the DMS already records that as `lastIssuedDt`.
    await db
      .update(dmsPartStockTable)
      .set({
        dealerCode,
        ...projected,
        raw: line as unknown as Record<string, unknown>,
        rawHash: lineHash,
        lastSyncedAt: now,
        lastChangedAt: now,
        disappearedAt: null,
      })
      .where(
        and(
          eq(dmsPartStockTable.showroomId, showroomId),
          eq(dmsPartStockTable.partNo, line.partNo),
        ),
      );
    changed++;
  }

  /*
   * Disappearance, and only where the source is entitled to claim it.
   *
   * An API lists the outlet's whole book every time, so a row that stops
   * appearing has genuinely gone. A report covering one month says nothing
   * about the other eleven — marking everything outside the export as vanished
   * because somebody dropped July's file is the mistake a path-blind sync makes
   * unless it asks.
   */
  const seenParts = lines.map((l) => l.partNo);
  const gone = source.listIsComplete
    ? await db
        .update(dmsPartStockTable)
        .set({ disappearedAt: new Date() })
        .where(
          and(
            eq(dmsPartStockTable.showroomId, showroomId),
            isNull(dmsPartStockTable.disappearedAt),
            // An empty ledger is a fault, not a branch with no parts.
            ...(seenParts.length > 0 ? [notInArray(dmsPartStockTable.partNo, seenParts)] : []),
          ),
        )
        .returning({ partNo: dmsPartStockTable.partNo })
    : [];

  if (seenParts.length === 0) {
    logger.warn({ dealerCode }, "DMS returned zero parts — treating as a fault, not an empty store");
  }

  const result: SparesSyncResult = {
    showroomId,
    dealerCode,
    seen: lines.length,
    added,
    changed,
    unchanged,
    disappeared: gone.length,
    durationMs: Date.now() - startedAt,
  };
  logger.info(result, "DMS parts sync complete");
  return result;
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * What this part line needs from a human.
 *
 * `AVAILABLE_ELSEWHERE` is the one that justifies the module. Everything else
 * here a good storeman would eventually catch on their own screen.
 */
export type SparesState =
  | "AVAILABLE_ELSEWHERE"
  | "STOCKOUT_BLOCKING"
  | "ORDER_OVERDUE"
  | "BELOW_REORDER"
  | "FULLY_RESERVED"
  | "DEAD_STOCK"
  | "OK";

/** The dealership's, since OBJ-18. Default and range in `lib/dms/policy.ts`. */
const DEAD_STOCK_DAYS = "THRESHOLD.DEAD_STOCK_DAYS";

export interface SparesWorklistRow {
  partNo: string;
  partDesc: string | null;
  showroomId: number;
  showroomCode: string | null;
  dealerCode: string;
  binLocation: string | null;
  dms: {
    qtyOnHand: number;
    qtyReserved: number;
    /** On hand minus reserved. What the counter can actually issue today. */
    qtyFree: number;
    reorderLevel: number;
    mrpAmount: number | null;
    costAmount: number | null;
    lastReceivedDate: string | null;
    lastIssuedDate: string | null;
    onOrderQty: number;
    onOrderEtaDate: string | null;
  };
  ddms: {
    transferRequestedAt: string | null;
    transferFromShowroomId: number | null;
    reorderRaisedAt: string | null;
  };
  /** Open job cards at this showroom waiting on this exact part. */
  waitingJobCards: Array<{ jcNo: string; customerName: string | null; daysWaiting: number }>;
  /**
   * The same part, free, at another outlet this owner holds. The whole point.
   */
  availableAt: Array<{ showroomId: number; showroomCode: string | null; qtyFree: number; binLocation: string | null }>;
  /**
   * The same part, *short*, at another outlet — the inverse finding, and the one
   * that turns dead stock from a write-off into a transfer. Eight brake pads
   * nobody here has ever issued are not a loss if the branch that sells the
   * model is below its reorder level on them.
   */
  shortAt: Array<{ showroomId: number; showroomCode: string | null; qtyFree: number; reorderLevel: number; onOrderQty: number }>;
  state: SparesState;
  note: string | null;
  actionRequired: string | null;
  /** Days since it last moved. Null when it has never been issued. */
  daysSinceIssued: number | null;
  /** Cost of stock sitting still. The number that makes dead stock a decision. */
  idleCapital: number | null;
  lastSyncedAt: string;
}

function wholeDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export interface SparesWorklistOptions {
  /** The dealership's numbers. Resolved from the outlet when absent — see
   *  `policyForShowroom`, and note that it is never silently defaulted. */
  policy?: ResolvedPolicy;
  showroomId: number;
  /** Every showroom this owner holds — the cross-branch lookup reads all of them. */
  ownerShowroomIds: number[];
}

export async function buildSparesWorklist(
  opts: SparesWorklistOptions,
): Promise<SparesWorklistRow[]> {
  const policy = opts.policy ?? (await policyForShowroom(opts.showroomId));
  const scope = opts.ownerShowroomIds.length > 0 ? opts.ownerShowroomIds : [opts.showroomId];

  // Every outlet's shelf, not just the one on screen. This is the query the
  // dealer's own system cannot express, and it is one `inArray`.
  const all = await db
    .select({ p: dmsPartStockTable, showroomCode: showroomsTable.code })
    .from(dmsPartStockTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, dmsPartStockTable.showroomId))
    .where(and(inArray(dmsPartStockTable.showroomId, scope), isNull(dmsPartStockTable.disappearedAt)));

  // Job cards at *this* showroom that are held up, and which part each is on.
  // The part number lives in the raw payload's line items rather than a column,
  // because "which cards want part X" only became a question when this module
  // existed — and one jsonb path is cheaper than a migration nothing else uses.
  const blocked = await db
    .select({
      jcNo: dmsJobCardsTable.jcNo,
      customerName: dmsJobCardsTable.customerName,
      /**
       * The customer's wait is measured from when the workshop opened the job
       * card, not from `statusSince`.
       *
       * `statusSince` is *our* clock — when this mirror first saw the status —
       * and on a mirror built yesterday it says one day for a vehicle that has
       * been in the bay since last week. That is a number about us, presented
       * as a number about them. `jcDate` is the dealer's own record of when the
       * vehicle came in, which is what the customer is counting.
       */
      jcDate: dmsJobCardsTable.jcDate,
      statusSince: dmsJobCardsTable.statusSince,
      partNos: sql<string[]>`(
        select coalesce(array_agg(elem->>'partNo'), '{}')
        from jsonb_array_elements(${dmsJobCardsTable.raw} -> 'parts') as elem
        where elem->>'issuedFlg' = 'N'
      )`,
    })
    .from(dmsJobCardsTable)
    .where(
      and(
        eq(dmsJobCardsTable.showroomId, opts.showroomId),
        // The projected flag, not a scan of the payload. It exists precisely so
        // "held up by a part" is a column test on a busy day.
        eq(dmsJobCardsTable.hasUnissuedPart, "Y"),
        isNull(dmsJobCardsTable.disappearedAt),
      ),
    );

  const now = new Date();

  const waitingByPart = new Map<string, SparesWorklistRow["waitingJobCards"]>();
  for (const jc of blocked) {
    for (const partNo of jc.partNos ?? []) {
      const list = waitingByPart.get(partNo) ?? [];
      list.push({
        jcNo: jc.jcNo,
        customerName: jc.customerName,
        // Falls back to our clock only when the DMS gave no date at all.
        daysWaiting: wholeDaysBetween(jc.jcDate ? new Date(jc.jcDate) : jc.statusSince, now),
      });
      waitingByPart.set(partNo, list);
    }
  }

  const mine = all.filter((r) => r.p.showroomId === opts.showroomId);

  return mine.map(({ p, showroomCode }) => {
    const qtyFree = p.qtyOnHand - p.qtyReserved;
    const waiting = waitingByPart.get(p.partNo) ?? [];

    const others = all.filter(
      (o) => o.p.showroomId !== opts.showroomId && o.p.partNo === p.partNo,
    );

    const availableAt = others
      .filter((o) => o.p.qtyOnHand - o.p.qtyReserved > 0)
      .map((o) => ({
        showroomId: o.p.showroomId,
        showroomCode: o.showroomCode,
        qtyFree: o.p.qtyOnHand - o.p.qtyReserved,
        binLocation: o.p.binLocation,
      }));

    // Both directions from one query. A branch can simultaneously be somewhere
    // to pull from on one part and somewhere to push to on another, and a screen
    // that only computed the first would keep recommending a write-off for
    // stock the company is about to reorder somewhere else.
    const shortAt = others
      .filter((o) => o.p.qtyOnHand - o.p.qtyReserved <= o.p.reorderLevel)
      .map((o) => ({
        showroomId: o.p.showroomId,
        showroomCode: o.showroomCode,
        qtyFree: o.p.qtyOnHand - o.p.qtyReserved,
        reorderLevel: o.p.reorderLevel,
        onOrderQty: o.p.onOrderQty,
      }));

    const daysSinceIssued =
      p.lastIssuedDate === null ? null : wholeDaysBetween(new Date(p.lastIssuedDate), now);
    const neverIssued = p.lastIssuedDate === null && p.qtyOnHand > 0;

    const { state, note, action } = classify({
      qtyFree,
      reorderLevel: p.reorderLevel,
      qtyOnHand: p.qtyOnHand,
      qtyReserved: p.qtyReserved,
      onOrderQty: p.onOrderQty,
      onOrderEtaDate: p.onOrderEtaDate,
      waiting,
      availableAt,
      shortAt,
      daysSinceIssued,
      neverIssued,
      transferRequestedAt: p.transferRequestedAt,
      reorderRaisedAt: p.reorderRaisedAt,
      now,
    }, policy);

    const idle =
      (state === "DEAD_STOCK" && p.costAmount !== null) ? p.costAmount * p.qtyOnHand : null;

    return {
      partNo: p.partNo,
      partDesc: p.partDesc,
      showroomId: p.showroomId,
      showroomCode,
      dealerCode: p.dealerCode,
      binLocation: p.binLocation,
      dms: {
        qtyOnHand: p.qtyOnHand,
        qtyReserved: p.qtyReserved,
        qtyFree,
        reorderLevel: p.reorderLevel,
        mrpAmount: p.mrpAmount,
        costAmount: p.costAmount,
        lastReceivedDate: p.lastReceivedDate,
        lastIssuedDate: p.lastIssuedDate,
        onOrderQty: p.onOrderQty,
        onOrderEtaDate: p.onOrderEtaDate,
      },
      ddms: {
        transferRequestedAt: p.transferRequestedAt?.toISOString() ?? null,
        transferFromShowroomId: p.transferFromShowroomId,
        reorderRaisedAt: p.reorderRaisedAt?.toISOString() ?? null,
      },
      waitingJobCards: waiting,
      availableAt,
      shortAt,
      state,
      note,
      actionRequired: action,
      daysSinceIssued,
      idleCapital: idle,
      lastSyncedAt: p.lastSyncedAt.toISOString(),
    };
  });
}

interface ClassifyInput {
  qtyFree: number;
  qtyOnHand: number;
  qtyReserved: number;
  reorderLevel: number;
  onOrderQty: number;
  onOrderEtaDate: string | null;
  waiting: SparesWorklistRow["waitingJobCards"];
  availableAt: SparesWorklistRow["availableAt"];
  shortAt: SparesWorklistRow["shortAt"];
  daysSinceIssued: number | null;
  neverIssued: boolean;
  transferRequestedAt: Date | null;
  reorderRaisedAt: Date | null;
  now: Date;
}

function classify(
  i: ClassifyInput,
  policy: ResolvedPolicy,
): { state: SparesState; note: string | null; action: string | null } {
  const worstWait = i.waiting.reduce((m, w) => Math.max(m, w.daysWaiting), 0);
  const who = i.waiting.length === 1 ? i.waiting[0].customerName ?? i.waiting[0].jcNo : null;

  // The finding, and the one no branch system can produce.
  if (i.qtyFree <= 0 && i.waiting.length > 0 && i.availableAt.length > 0) {
    const source = i.availableAt[0];
    const where = source.showroomCode ?? `showroom ${source.showroomId}`;
    const held = `${who ? `${who} has` : `${plural(i.waiting.length, "job card")} have`} been waiting ${plural(worstWait, "day")}`;

    return i.transferRequestedAt
      ? {
          state: "AVAILABLE_ELSEWHERE",
          note: `${held}. Requested from ${where}.`,
          action: null,
        }
      : {
          state: "AVAILABLE_ELSEWHERE",
          note:
            `${held}, and ${where} has ${source.qtyFree} free` +
            `${source.binLocation ? ` in ${source.binLocation}` : ""}. ` +
            `Neither branch's system can see the other's shelf.`,
          action: `Move one from ${where} instead of ordering`,
        };
  }

  // Nobody in the group has it and somebody is waiting. A genuine stockout, and
  // it has to look different from the one above or the screen is just noise.
  if (i.qtyFree <= 0 && i.waiting.length > 0) {
    const eta = i.onOrderQty > 0 && i.onOrderEtaDate ? ` ${i.onOrderQty} on order.` : "";
    return {
      state: "STOCKOUT_BLOCKING",
      note:
        `${who ? `${who} has` : `${plural(i.waiting.length, "job card")} have`} been waiting ` +
        `${plural(worstWait, "day")} and nobody in the group has one.${eta}`,
      action: i.onOrderQty > 0 ? "Chase the order and tell the customer a date" : "Order it, and tell the customer a date",
    };
  }

  if (i.onOrderQty > 0 && i.onOrderEtaDate !== null) {
    const late = wholeDaysBetween(new Date(i.onOrderEtaDate), i.now);
    if (late > 0) {
      return {
        state: "ORDER_OVERDUE",
        note: `${i.onOrderQty} ordered, due ${plural(late, "day")} ago and not received.`,
        action: "Chase the order with the manufacturer",
      };
    }
  }

  // Capital, not inventory. Named by what it costs rather than by how long it
  // has sat, because the second is a fact and the first is a decision.
  if (
    i.qtyOnHand > 0 &&
    (i.neverIssued ||
      (i.daysSinceIssued !== null && i.daysSinceIssued >= policy.days(DEAD_STOCK_DAYS)))
  ) {
    const since = i.neverIssued
      ? "never been issued since it arrived"
      : `not moved in ${plural(i.daysSinceIssued!, "day")}`;

    // The inverse of the headline finding, and the one that turns a write-off
    // into a transfer. Checked against the other branch's *reorder level*, not
    // against whether it has any — a branch with two left and a reorder level of
    // four is about to buy what is sitting dead here.
    const wanted = i.shortAt[0];
    if (wanted) {
      const where = wanted.showroomCode ?? `showroom ${wanted.showroomId}`;
      // The sharpest version: they have not merely run low, they have already
      // raised a purchase order. The group is about to pay for what it owns.
      if (wanted.onOrderQty > 0) {
        return {
          state: "DEAD_STOCK",
          note:
            `${i.qtyOnHand} on the shelf, ${since} — and ${where} has ` +
            `${wanted.onOrderQty} on order for the same part.`,
          action: i.transferRequestedAt ? null : `Send ${where} theirs and cancel the order`,
        };
      }

      return {
        state: "DEAD_STOCK",
        note:
          `${i.qtyOnHand} on the shelf, ${since} — and ${where} is down to ` +
          `${wanted.qtyFree} against a reorder level of ${wanted.reorderLevel}.`,
        action: i.transferRequestedAt ? null : `Send some to ${where} before they order more`,
      };
    }

    return {
      state: "DEAD_STOCK",
      note: `${i.qtyOnHand} on the shelf, ${since}.`,
      action: "Move it to a branch that sells the model, or return it",
    };
  }

  if (i.qtyFree <= i.reorderLevel && i.onOrderQty === 0) {
    // Reserved-to-nothing is worth saying out loud: the shelf shows stock and
    // the counter can issue none, and only the first number is on their screen.
    if (i.qtyOnHand > 0 && i.qtyFree <= 0) {
      return {
        state: "FULLY_RESERVED",
        note: `${i.qtyOnHand} on the shelf and every one promised to an open job card. The counter screen shows ${i.qtyOnHand}.`,
        action: i.reorderRaisedAt ? null : "Order more — the shelf figure is misleading",
      };
    }

    return {
      state: "BELOW_REORDER",
      note: `${i.qtyFree} free against a reorder level of ${i.reorderLevel}, nothing on order.`,
      action: i.reorderRaisedAt ? null : "Raise a purchase order",
    };
  }

  return { state: "OK", note: null, action: null };
}

export interface SparesWorklistSummary {
  total: number;
  byState: Record<SparesState, number>;
  needsAction: number;
  /**
   * The leading number, and the one no branch system can produce: customers
   * waiting for a part the company already owns, in another outlet.
   */
  availableElsewhere: number;
  /** Genuine stockouts, with somebody waiting. */
  stockoutBlocking: number;
  /** Lines at or below reorder level with nothing on order. */
  belowReorder: number;
  /** Cost of stock that has not moved. Capital, not inventory. */
  idleCapital: number;
  lastSyncedAt: string | null;
}

export function summariseSpares(rows: SparesWorklistRow[]): SparesWorklistSummary {
  const byState = {
    AVAILABLE_ELSEWHERE: 0,
    STOCKOUT_BLOCKING: 0,
    ORDER_OVERDUE: 0,
    BELOW_REORDER: 0,
    FULLY_RESERVED: 0,
    DEAD_STOCK: 0,
    OK: 0,
  } as Record<SparesState, number>;

  let needsAction = 0;
  let idleCapital = 0;
  let lastSynced: string | null = null;

  for (const r of rows) {
    byState[r.state]++;
    if (r.actionRequired) needsAction++;
    if (r.idleCapital) idleCapital += r.idleCapital;
    if (!lastSynced || r.lastSyncedAt > lastSynced) lastSynced = r.lastSyncedAt;
  }

  return {
    total: rows.length,
    byState,
    needsAction,
    availableElsewhere: byState.AVAILABLE_ELSEWHERE,
    stockoutBlocking: byState.STOCKOUT_BLOCKING,
    belowReorder: byState.BELOW_REORDER,
    idleCapital,
    lastSyncedAt: lastSynced,
  };
}
