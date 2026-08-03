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
  adapterForDealer,
  fetchDeal,
  resolveTenantByDealerCode,
  buildLeadWorklist,
  buildServiceWorklist,
  buildWorklist,
  isDmsConfigured,
  panelForShowroom,
  summarise,
  summariseLeads,
  summariseService,
  syncShowroom,
  syncShowroomEnquiries,
  syncShowroomJobCards,
} from "../lib/dms";
import { createDraftApplication } from "../lib/draft-application";
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
    // Both modules in one pass. A sync that refreshed sales and left the
    // workshop stale would produce a console where half the numbers are from
    // this minute and half from yesterday, with nothing on screen saying which.
    const results = await syncShowroom(showroomId);
    const jobCardResults = await syncShowroomJobCards(showroomId);
    const enquiryResults = await syncShowroomEnquiries(showroomId);

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

    res.json({ results, jobCardResults, enquiryResults });
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

/**
 * The workshop's worklist.
 *
 * Same query-parameter shape as the deal worklist, for the same orval reason
 * documented at the top of this file.
 */
router.get("/dms/service-worklist", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }

  if (!(await showroomExists(showroomId))) {
    res.status(404).json({ error: `No showroom ${showroomId}` });
    return;
  }

  const rows = await buildServiceWorklist({
    showroomId,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    includeDisappeared: req.query.includeDisappeared === "true",
  });

  res.json({ summary: summariseService(rows), rows });
});

/**
 * The lead worklist.
 *
 * Two things here exist nowhere in the dealer's own screens: how many minutes
 * are left on a manufacturer lead's response window, and which live leads are
 * assigned to somebody who has left. The second needs the enquiry mirror and
 * the staff mirror joined, and their CRM and HR screens each hold only one
 * side.
 */
router.get("/dms/lead-worklist", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }

  if (!(await showroomExists(showroomId))) {
    res.status(404).json({ error: `No showroom ${showroomId}` });
    return;
  }

  const rows = await buildLeadWorklist({
    showroomId,
    stage: typeof req.query.stage === "string" ? req.query.stage : undefined,
  });

  res.json({ summary: summariseLeads(rows), rows });
});

/**
 * Start an insurance application from a worklist row.
 *
 * The first action button in DDMS, and the point at which it stops being a
 * report. Everything the pipeline needs is already in the dealer's system, so
 * the whole sequence — pull the deal, translate it, resolve the owner, create
 * the draft — happens here rather than making the browser orchestrate two calls
 * and hold a customer's KYC in between.
 *
 * Three outcomes, all of them useful:
 *   201  created, with the application id to open
 *   409  the deal already has one, with its id — go there instead
 *   422  the DMS record is missing fields insurance requires, listed. Not a
 *        failure of ours: the dealership never captured them, and the fix is a
 *        human in VeloDocs, not a retry.
 */
router.post("/dms/deals/:dealId/start-application", async (req, res): Promise<void> => {
  const dealId = req.params.dealId;

  if (!isDmsConfigured()) {
    res.status(503).json({
      error:
        "DMS is not configured. Set DMS_API_URL and DMS_API_KEY " +
        "(http://localhost:9090 and dev-dms-key for the local mock).",
    });
    return;
  }

  try {
    const deal = await fetchDeal(dealId);
    if (!deal) {
      res.status(404).json({ error: `No deal ${dealId}` });
      return;
    }

    const adapter = adapterForDealer(deal.dealerCode);
    const adapted = adapter.adaptDeal(deal);
    const tenant = await resolveTenantByDealerCode(deal.dealerCode);

    const result = await createDraftApplication({
      fields: adapted.fields,
      tenant,
      ctx: adapted.dealContext,
      // No document was read — this came from the dealer's own record, which is
      // authoritative for every vehicle fact. Writing a document reference here
      // would claim a scan that never happened.
      document: null,
      sourceDesc:
        `Application started from DDMS worklist — deal ${deal.dealId} ` +
        `(${adapted.fields.vehicleMake} ${adapted.fields.vehicleModel}, ${adapted.fields.ownerFullName})`,
    });

    if (result.kind === "duplicate") {
      res.status(409).json({
        error: `Deal ${dealId} already has application #${result.applicationId}.`,
        applicationId: result.applicationId,
      });
      return;
    }

    if (result.kind === "invalid") {
      // 422 rather than 400: the request was well formed, the dealer's record
      // is simply incomplete. The caller needs the field list to route the user
      // somewhere useful.
      res.status(422).json({
        error: `Deal ${dealId} is missing details the proposal requires.`,
        errors: result.errors,
        invalidFields: result.invalidFields,
        gaps: adapted.dealContext.gaps,
      });
      return;
    }

    logger.info(
      { dealId, applicationId: result.applicationId, showroom: tenant?.showroomCode ?? null },
      "Application started from DDMS",
    );
    res.status(201).json({ applicationId: result.applicationId });
  } catch (err) {
    if (err instanceof DmsError) {
      const status = err.kind === "not_found" ? 404 : err.kind === "bad_response" ? 502 : 503;
      logger.error({ err: err.message, kind: err.kind }, "Starting an application failed");
      res.status(status).json({ error: err.message, kind: err.kind });
      return;
    }
    throw err;
  }
});

export default router;
