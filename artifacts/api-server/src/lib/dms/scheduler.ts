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
import { ownerDb, showroomDmsAccountsTable, showroomsTable } from "@workspace/db";
import { logger } from "../logger";
import { isDmsConfigured } from "./client";
import { syncShowroomEnquiries } from "./lead-worklist";
import { syncShowroomRegistrations } from "./registration-worklist";
import { syncShowroomJobCards } from "./service-worklist";
import { syncShowroom } from "./sync";

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
 * `ownerDb` rather than `db`, spelled out rather than inherited. This runs on a
 * timer with nobody signed in, and it is cross-tenant by definition — it syncs
 * every owner's showrooms, which is the one thing a tenant-scoped connection
 * must never do. Naming the unrestricted handle here makes that a decision
 * somebody took rather than a scope somebody forgot to open.
 */
async function syncableShowroomIds(): Promise<number[]> {
  const rows = await ownerDb
    .selectDistinct({ id: showroomsTable.id })
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
  return rows.map((r) => r.id);
}

/**
 * One pass over every syncable showroom.
 *
 * Sequential on purpose. A dealer DMS is a shared ERP that already returns 503
 * under load — the client retries for that reason — and firing every showroom
 * at it in parallel would be us causing the outage we then retry around.
 */
async function runOnce(): Promise<void> {
  const showroomIds = await syncableShowroomIds();
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
