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
import { runRules } from "./rules";

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
