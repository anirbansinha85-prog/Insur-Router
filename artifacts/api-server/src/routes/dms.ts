/**
 * DDMS routes — the mirror, the worklist, and the reconciliation.
 *
 * The integration with the dealer's DMS is **read-only**. Everything here is
 * built on that: we pull their data into a mirror, compare it with our own
 * record, and surface the difference as work rather than trying to erase it by
 * writing back. What the dealer must key in by hand becomes an explicit task
 * with the exact value to copy, not a silent gap somebody discovers later.
 *
 *   GET  /api/dms/showrooms            outlets the owner holds, for the picker
 *   POST /api/dms/showrooms/:id/sync   pull the deal list into the mirror
 *   GET  /api/dms/worklist?showroomId= every deal, both views, side by side
 *
 * The worklist takes showroomId as a query parameter rather than a path
 * segment because orval emits `<Operation>Params` for both path and query
 * parameters — an operation with both generates that name twice and the
 * api-zod barrel stops compiling. See the note in openapi.yaml.
 */

import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import {
  db,
  ownersTable,
  showroomDmsAccountsTable,
  showroomsTable,
} from "@workspace/db";
import {
  DmsError,
  buildWorklist,
  isDmsConfigured,
  panelForShowroom,
  summarise,
  syncShowroom,
} from "../lib/dms";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function parseShowroomId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function showroomExists(id: number): Promise<boolean> {
  const [row] = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.id, id));
  return Boolean(row);
}

router.get("/dms/showrooms", async (_req, res): Promise<void> => {
  // Two queries and a join in memory rather than one query with an aggregate:
  // the showroom count is single digits per owner and will stay that way, and
  // the flat rows are far easier to read than a jsonb_agg.
  const showrooms = await db
    .select({
      id: showroomsTable.id,
      code: showroomsTable.code,
      name: showroomsTable.name,
      city: showroomsTable.city,
      state: showroomsTable.state,
      isActive: showroomsTable.isActive,
      ownerId: ownersTable.id,
      ownerName: ownersTable.name,
    })
    .from(showroomsTable)
    .innerJoin(ownersTable, eq(ownersTable.id, showroomsTable.ownerId))
    .orderBy(asc(showroomsTable.ownerId), asc(showroomsTable.code));

  const accounts = await db
    .select({
      showroomId: showroomDmsAccountsTable.showroomId,
      oemCode: showroomDmsAccountsTable.oemCode,
      dealerCode: showroomDmsAccountsTable.dealerCode,
      insuranceChannel: showroomDmsAccountsTable.insuranceChannel,
      isActive: showroomDmsAccountsTable.isActive,
    })
    .from(showroomDmsAccountsTable);

  const byShowroom = new Map<number, typeof accounts>();
  for (const account of accounts) {
    const list = byShowroom.get(account.showroomId) ?? [];
    list.push(account);
    byShowroom.set(account.showroomId, list);
  }

  res.json(
    showrooms.map((s) => ({
      ...s,
      dmsAccounts: (byShowroom.get(s.id) ?? []).map(
        ({ showroomId: _ignored, ...rest }) => rest,
      ),
    })),
  );
});

router.post("/dms/showrooms/:showroomId/sync", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(req.params.showroomId);
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }

  if (!(await showroomExists(showroomId))) {
    res.status(404).json({ error: `No showroom ${showroomId}` });
    return;
  }

  if (!isDmsConfigured()) {
    res.status(503).json({
      error:
        "DMS is not configured. Set DMS_API_URL and DMS_API_KEY " +
        "(http://localhost:9090 and dev-dms-key for the local mock).",
    });
    return;
  }

  try {
    const results = await syncShowroom(showroomId);

    if (results.length === 0) {
      // The showroom exists but has no active DMS account, which is a
      // configuration gap rather than a fault. Say which.
      res.status(404).json({
        error:
          `Showroom ${showroomId} has no active DMS account. ` +
          `Link a dealer code to it before syncing.`,
      });
      return;
    }

    res.json({ results });
  } catch (err) {
    if (err instanceof DmsError) {
      const status = err.kind === "bad_response" ? 502 : 503;
      logger.error({ err: err.message, kind: err.kind }, "DMS sync failed");
      res.status(status).json({ error: err.message, kind: err.kind });
      return;
    }
    throw err;
  }
});

router.get("/dms/showrooms/:showroomId/panel", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(req.params.showroomId);
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }

  if (!(await showroomExists(showroomId))) {
    res.status(404).json({ error: `No showroom ${showroomId}` });
    return;
  }

  // Quota and eligibility are computed by @workspace/quoting/panel — the same
  // module the mock dealer portal uses — so the routing rules cannot drift
  // between what the demo shows and what the server would actually do.
  res.json({ entries: await panelForShowroom(showroomId) });
});

router.get("/dms/worklist", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }

  if (!(await showroomExists(showroomId))) {
    res.status(404).json({ error: `No showroom ${showroomId}` });
    return;
  }

  const rows = await buildWorklist({
    showroomId,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    includeDisappeared: req.query.includeDisappeared === "true",
  });

  // Reads straight from the mirror and never calls the DMS, so the console
  // still renders when the dealer's ERP is busy or down. `lastSyncedAt` in the
  // summary is what keeps that honest rather than quietly stale.
  res.json({ summary: summarise(rows), rows });
});

export default router;
