/**
 * Keep the mirror fresh without anyone pressing a button.
 *
 * The console reads only the mirror, so its usefulness is bounded by how
 * recently something pulled. On-demand sync alone means the numbers are only
 * ever as good as the last person who remembered — and "nobody has time to
 * check" is the problem this product exists to solve, so relying on a human to
 * refresh it reintroduces exactly that.
 *
 * Deliberately modest: a periodic timer in the API process, no queue, no
 * external scheduler. One process, one dealership group, a handful of
 * showrooms. When there are several API instances this needs a lock so they do
 * not all sync the same showroom at once — noted here rather than pre-built.
 */

import { and, eq } from "drizzle-orm";
import { db, showroomDmsAccountsTable, showroomsTable, withWorkerScope } from "@workspace/db";
import { rebuildEntityGraph } from "./entity-graph";
import { logger } from "../logger";
import { isDmsConfigured } from "./client";
import { syncShowroomEnquiries } from "./lead-worklist";
import { syncShowroomRegistrations } from "./registration-worklist";
import { syncShowroomParts } from "./spares-worklist";
import { syncShowroomJobCards } from "./service-worklist";
import { syncShowroom } from "./sync";
import { syncShowroomReceivables } from "./receivables-worklist";
import { syncShowroomInventory } from "./inventory-worklist";
import { detectStateChanges, showroomIdsForOwner } from "./events";
import { recordStandDown, shouldStandDown, step, withRun } from "./trace";
import { runRules } from "./rules";
import { advanceJourneys } from "./journeys";
import { runAgentForShowroom } from "./agent";
import { runStockAgentForShowroom } from "./stock-agent";
import { standingFor, AUTONOMY_KEYS } from "./autonomy";
import { expireStale, resolveProposals } from "./proposals";
import { buildQueue } from "./queue";
import { loadPolicy } from "./policy";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of milliseconds, got "${raw}"`);
  }
  return value;
}

/**
 * Showrooms worth syncing: active, and holding at least one active DMS account.
 *
 * Reached through `db` inside `withWorkerScope`, which is what makes this the
 * scheduler's own credential rather than the table owner's. It runs on a timer
 * with nobody signed in and is cross-tenant by definition — it syncs every
 * owner's showrooms, the one thing a tenant-scoped connection must never do.
 *
 * That used to be a reason to reach for the handle that bypasses RLS. It is
 * not: "cross-tenant" is a reason to name a role, and `ddms_worker` is that
 * role. It holds the mirror and the graph for every dealership, and cannot
 * read a user, a session, an application or anything a person decided.
 */
async function syncableShowrooms(): Promise<Array<{ id: number; ownerId: number }>> {
  const rows = await db
    .selectDistinct({ id: showroomsTable.id, ownerId: showroomsTable.ownerId })
    .from(showroomsTable)
    .innerJoin(
      showroomDmsAccountsTable,
      eq(showroomDmsAccountsTable.showroomId, showroomsTable.id),
    )
    .where(
      and(
        eq(showroomsTable.isActive, true),
        eq(showroomDmsAccountsTable.isActive, true),
      ),
    );
  return rows;
}

/**
 * One pass over every syncable showroom.
 *
 * Sequential on purpose. A dealer DMS is a shared ERP that already returns 503
 * under load — the client retries for that reason — and firing every showroom
 * at it in parallel would be us causing the outage we then retry around.
 */
async function runOnce(): Promise<void> {
  // One decision, in one place. Everything below — the seven syncs, the graph
  // rebuild, the state detection — reaches for `db` and should not have to know
  // whether a person or a timer started it. What differs is the credential
  // underneath, and this is where that is chosen.
  return withWorkerScope(runPass);
}

async function runPass(): Promise<void> {
  const showrooms = await syncableShowrooms();
  const showroomIds = showrooms.map((s) => s.id);
  if (showroomIds.length === 0) {
    logger.debug("Scheduled DMS sync: no showrooms have an active DMS account");
    return;
  }

  const startedAt = Date.now();
  let succeeded = 0;

  for (const showroomId of showroomIds) {
    try {
      // Every module, sequentially, for the same reason showrooms are
      // sequential — this is one shared ERP and we are one of its tenants.
      await syncShowroom(showroomId);
      await syncShowroomJobCards(showroomId);
      await syncShowroomEnquiries(showroomId);
      await syncShowroomRegistrations(showroomId);
      await syncShowroomParts(showroomId);
      await syncShowroomReceivables(showroomId);
      await syncShowroomInventory(showroomId);
      succeeded++;
    } catch (err) {
      // One unreachable dealership must not stop the others. The mirror keeps
      // its previous rows and `lastSyncedAt` stops advancing, which is what
      // tells the console the data is going stale.
      logger.error(
        { err: err instanceof Error ? err.message : String(err), showroomId },
        "Scheduled DMS sync failed for one showroom",
      );
    }
  }

  // Once per owner, after every showroom of theirs has been pulled. The graph
  // spans outlets, so rebuilding it inside the loop would repeatedly build it
  // from a half-synced picture.
  for (const ownerId of new Set(showrooms.map((s) => s.ownerId))) {
    try {
      await rebuildEntityGraph(ownerId);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), ownerId },
        "Entity graph rebuild failed",
      );
    }

    // And then: what moved. This is the pass that makes the product capable of
    // noticing anything on its own — a file that lapsed overnight, a lead that
    // breached because time passed. It runs here, with nobody signed in, which
    // is the whole point of it running here.
    //
    // After the graph, because a state may depend on it, and per owner rather
    // than per showroom because three of the seven projections read across
    // outlets and would classify half a group differently mid-loop.
    try {
      const owned = await showroomIdsForOwner(ownerId);
      for (const showroomId of owned) {
        if (!showroomIds.includes(showroomId)) continue;
        await detectStateChanges(ownerId, showroomId, owned);
      }

      /*
       * And then the journeys, before the rules and before the queue is built
       * from anything.
       *
       * Here rather than beside detection because the two answer different
       * questions and the order between them does not matter — a journey's
       * position comes from the mirror, not from `record_events`. Here rather
       * than *after* the rules because a stalled step is a queue row, the agent
       * pass at the bottom of this function reads the queue, and a runtime that
       * ran last would hand out work on the picture from fifteen minutes ago.
       *
       * This is where a six-week process actually moves. Nothing about a live
       * journey survives between two of these passes — the position is two rows
       * in Postgres — so a restart is indistinguishable from the next pass, and
       * an RTO that answers on a Sunday is noticed on Monday morning without
       * anybody opening a screen.
       *
       * Its own try, for the same reason the rules have one: journeys failing
       * must not lose the detection that preceded them.
       */
      try {
        const moved = await advanceJourneys({
          ownerId,
          showroomIds: owned.filter((id) => showroomIds.includes(id)),
          policy: await loadPolicy(ownerId),
        });
        if (moved.started || moved.advanced || moved.looped || moved.finished) {
          logger.info({ ownerId, ...moved }, "Journeys moved with nobody signed in");
        }
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), ownerId },
          "Journey pass failed",
        );
      }

      // And then the rules, over the states that pass just worked out.
      //
      // After detection and never beside it: a rule fires on the state a record
      // is in, so running the two in the other order would have every rule
      // acting on the picture from fifteen minutes ago. This is the point at
      // which the product stops only reporting — a certificate that has sat in
      // a drawer since March produces a draft here, with nobody signed in.
      //
      // Its own try, because a rule failing must not lose the detection that
      // preceded it. The events are the more valuable of the two: a draft can
      // be raised on the next pass, and a transition nobody recorded is gone.
      try {
        let drafted = 0;
        let waiting = 0;
        let held = 0;
        let withdrawn = 0;
        for (const showroomId of owned) {
          if (!showroomIds.includes(showroomId)) continue;
          const r = await runRules(ownerId, showroomId, owned);
          drafted += r.drafted;
          waiting += r.awaitingPerson;
          held += r.held;
          withdrawn += r.withdrawn;
        }
        if (drafted > 0 || withdrawn > 0) {
          logger.info(
            { ownerId, drafted, awaitingApproval: waiting, heldNoTransport: held, withdrawn },
            "Rules ran with nobody signed in",
          );
        }
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), ownerId },
          "Rule pass failed",
        );
      }

      // And last, the agent — offering always, acting only where earned.
      //
      // Last because it reads the queue, the queue is built from derived state,
      // and building it before detection would hand out work on the picture
      // from fifteen minutes ago. Its own try for the same reason the rules
      // have one: the agent failing must not lose the detection and the drafts
      // that preceded it.
      //
      // Default off, and since OBJ-26 the switch is only half the gate: a
      // dealership that has set `AGENT.ASSIGN_ORPHANS` still gets nothing
      // unattended on a pattern that has not reached rung 3. What runs
      // regardless is the **offering** — that is what earns the rung, and
      // recording only what the agent acts on would mean the only way to earn
      // autonomy was to already have it.
      try {
        await runAgentPass(ownerId, owned, showroomIds);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), ownerId },
          "Agent pass failed",
        );
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), ownerId },
        "Derived-state detection failed",
      );
    }
  }

  logger.info(
    { showrooms: showroomIds.length, succeeded, durationMs: Date.now() - startedAt },
    "Scheduled DMS sync pass complete",
  );
}

/**
 * The agent's pass over one owner's outlets.
 *
 * The queue is built **once, across every outlet the owner holds**, because
 * three of the seven projections read across outlets and building it per
 * showroom would classify half a group differently mid-loop — the same reason
 * detection runs per owner.
 *
 * It is built as the owner would see it: `role: "OWNER"`, no `empCode`. That is
 * not a privilege escalation, it is the absence of a person — there is nobody
 * signed in, so there is no *mine* band, and every orphaned record at every
 * outlet has to be reachable or the agent would only tidy up after whichever
 * member of staff happened to be logged in.
 */
async function runAgentPass(
  ownerId: number,
  owned: number[],
  showroomIds: number[],
): Promise<void> {
  const visible = owned.filter((id) => showroomIds.includes(id));
  if (visible.length === 0) return;

  const policy = await loadPolicy(ownerId);
  const windowDays = policy.number(AUTONOMY_KEYS.window);

  /*
   * Settle yesterday's offers before making today's, and before reading the
   * rung they are made at.
   *
   * Order is load-bearing twice. A proposal a person accepted this morning has
   * to be `ACCEPTED` before `standingFor` counts it, or the pattern is judged
   * on a stale denominator and a dealership that has been agreeing all week
   * looks like one that has been ignoring the product. And it has to happen
   * before the offering, or a record somebody has already dealt with collects
   * another proposal.
   *
   * **No model anywhere near it.** Whether somebody accepted a suggestion is a
   * comparison between two stored objects; a model asked to judge it would be a
   * model deciding how much autonomy the agent has earned, which is R-49's
   * refusal in its purest form.
   */
  const settled = await resolveProposals({
    ownerId,
    showroomIds: visible,
    // Half the window. A suggestion nobody reached in a month is not a
    // rejection and should stop dragging on a denominator it never entered.
    expireAfterDays: Math.max(3, Math.round(windowDays / 2)),
  });
  // Anything past the window can no longer count either way, so it stops
  // occupying the unique index and blocking a fresh offer on the same record.
  await expireStale({ ownerId, beforeDays: windowDays });

  const queue = await buildQueue({
    ownerId,
    ownerShowroomIds: owned,
    visibleShowroomIds: visible,
    empCode: null,
    role: "OWNER",
    policy,
  });

  // One pass for the owner rather than one per outlet: the ladder is a property
  // of the pattern, and computing it per showroom inside the loop would ask the
  // decision log the same question three times.
  const standing = await standingFor({ ownerId, showroomIds: visible, policy });

  /*
   * Whether to run at all, and it is the agent's own decision (OBJ-28, R-94).
   *
   * Two reasons to stop, different in kind. **Money**: today's runs have
   * reached the dealership's ceiling, which is the only defence against a loop
   * that would otherwise spend all night. **Being overruled**: people here have
   * been rejecting most of what was suggested, and a product that keeps
   * proposing while a dealership keeps saying no is one they stop reading and
   * then stop trusting.
   *
   * The second is the counterpart to the ladder coming down, one level up. The
   * ladder demotes a *pattern* somebody keeps overruling; this pauses the whole
   * agent. And it recovers by itself — acceptance improves inside the window,
   * or the day turns over — because a pause that needs a person to clear it is
   * an outage rather than a safety mechanism.
   *
   * The rate is computed across every pattern rather than per pattern: one
   * pattern going badly should demote that pattern, not silence everything.
   */
  const patterns = [...standing.values()];
  const offeredTotal = patterns.reduce((n, p) => n + p.offered, 0);
  const overriddenTotal = patterns.reduce((n, p) => n + p.overridden, 0);
  const overrideRatePct =
    offeredTotal === 0 ? null : Math.round((overriddenTotal / offeredTotal) * 100);

  const standDown = await shouldStandDown({ ownerId, policy, overrideRatePct });
  if (standDown.standDown) {
    // Written down as a run, because *the agent chose not to act* and *nothing
    // was scheduled* are different facts and only one of them needs looking
    // into. It is also what the screen reads to explain a quiet afternoon.
    await recordStandDown({
      ownerId,
      trigger: "SCHEDULER",
      kind: "assign-orphans",
      reason: standDown.reason!,
    });
    return;
  }

  let proposed = 0;
  let assigned = 0;
  const held: Array<{ patternKey: string; rung: string; because: string }> = [];
  const refused: Array<{ recordKey: string; reason: string }> = [];

  /*
   * One run for the owner, spanning every outlet in the pass.
   *
   * Per-outlet runs would have split a single decision — the agent looked at
   * the group's queue once and the standing is a property of the owner — into
   * three traces that each tell a third of the story, and would have made the
   * daily cost ceiling three ceilings.
   */
  await withRun({ ownerId, trigger: "SCHEDULER", kind: "assign-orphans" }, async () => {
    for (const showroomId of visible) {
      const r = await runAgentForShowroom(ownerId, showroomId, queue.items, policy, standing);
      proposed += r.proposed;
      assigned += r.assigned;
      held.push(...r.held);
      refused.push(...r.refused);
    }
    await step({
      kind: "READ",
      detail:
        `Considered ${queue.items.length} queue items across ${visible.length} outlet(s); ` +
        `offered ${proposed}, acted on ${assigned}, refused ${refused.length}.`,
    });
  });

  /*
   * The second agent, in its own run (OBJ-29).
   *
   * Its own standing, because the ceiling is a property of the principal and a
   * dealership that has been accepting the first agent's assignments has earned
   * this one nothing. Its own trace, because *what did the stock agent do at
   * half past two* is a different question from what the other one did, and a
   * single run covering both would answer neither.
   *
   * Same stand-down decision above governs both. A dealership at its daily
   * ceiling is at its ceiling whichever agent would have spent the next paisa.
   */
  const stockStanding = await standingFor({
    ownerId,
    showroomIds: visible,
    policy,
    principal: "STOCK_AGENT",
  });

  await withRun({ ownerId, trigger: "SCHEDULER", kind: "stock-moves", actor: "STOCK_AGENT" }, async () => {
    let offered = 0;
    let acted = 0;
    let considered = 0;
    for (const showroomId of visible) {
      const r = await runStockAgentForShowroom(
        ownerId,
        showroomId,
        queue.items,
        policy,
        stockStanding,
      );
      considered += r.considered;
      offered += r.proposed;
      acted += r.acted;
      refused.push(...r.refused);
    }
    await step({
      kind: "READ",
      detail: `Looked at ${considered} part(s) a customer is waiting on; offered ${offered}, acted on ${acted}.`,
    });
  });

  const due = [...standing.values()].filter((p) => p.consentDue);
  if (due.length > 0) {
    // Logged rather than acted on, and that is the objective's whole point: at
    // the threshold the product **asks**. Nothing promotes itself.
    logger.info(
      { ownerId, patterns: due.map((p) => p.patternKey) },
      "A pattern has enough behind it to be worth asking about",
    );
  }

  if (proposed > 0 || assigned > 0 || refused.length > 0 || settled.accepted > 0) {
    logger.info(
      {
        ownerId,
        proposed,
        assigned,
        held: held.length,
        refused: refused.length,
        accepted: settled.accepted,
        overridden: settled.overridden,
        reversed: settled.reversed,
        orphaned: queue.unassigned,
      },
      "The agent worked the orphaned band with nobody signed in",
    );
  }
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Start the periodic sync. Returns a handle so a caller can stop it; call this
 * from the server entrypoint rather than from `app.ts`, so importing the app
 * (for a test, or a script) does not silently start hitting a dealer's ERP.
 *
 * Set `DMS_SYNC_INTERVAL_MS=0` to turn it off.
 */
export function startDmsSyncScheduler(): SchedulerHandle {
  const intervalMs = readMs("DMS_SYNC_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const initialDelayMs = readMs("DMS_SYNC_INITIAL_DELAY_MS", DEFAULT_INITIAL_DELAY_MS);

  if (intervalMs === 0) {
    logger.info("Scheduled DMS sync disabled (DMS_SYNC_INTERVAL_MS=0)");
    return { stop: () => {} };
  }

  if (!isDmsConfigured()) {
    // Not an error: plenty of environments have no DMS wired up. Said out loud
    // so nobody later wonders why the mirror never moves.
    logger.warn(
      "Scheduled DMS sync not started — DMS_API_URL/DMS_API_KEY are not set",
    );
    return { stop: () => {} };
  }

  // A slow pull must never let the next tick start on top of it. Overlapping
  // syncs would race on the same rows and double the load on an ERP that was
  // already slow enough to cause the overlap.
  let inFlight = false;
  const tick = () => {
    if (inFlight) {
      logger.warn("Scheduled DMS sync skipped — the previous pass is still running");
      return;
    }
    inFlight = true;
    void runOnce()
      .catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Scheduled DMS sync pass failed",
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const first = setTimeout(tick, initialDelayMs);
  const repeating = setInterval(tick, intervalMs);

  // Timers must not be the reason the process refuses to exit on shutdown.
  first.unref();
  repeating.unref();

  logger.info(
    { intervalMs, initialDelayMs },
    "Scheduled DMS sync started",
  );

  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(repeating);
    },
  };
}
