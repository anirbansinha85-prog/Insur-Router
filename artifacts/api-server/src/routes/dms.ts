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
  applyAction,
  approveMessage,
  authoriseSend,
  cancelMessage,
  createDraft,
  listMessages,
  listStaff,
  sendMessage,
  summariseOutbox,
  TEMPLATE_IDS,
  type ActionId,
  type TemplateId,
  adapterForDealer,
  fetchDeal,
  resolveTenantByDealerCode,
  buildLeadWorklist,
  buildDossier,
  buildRegistrationWorklist,
  buildServiceWorklist,
  buildSparesWorklist,
  buildWorklist,
  rebuildEntityGraph,
  searchEntities,
  type EntityKind,
  isDmsConfigured,
  panelForShowroom,
  summarise,
  summariseLeads,
  summariseRegistrations,
  summariseService,
  summariseSpares,
  syncShowroom,
  syncShowroomEnquiries,
  syncShowroomJobCards,
  syncShowroomParts,
  syncShowroomRegistrations,
} from "../lib/dms";
import { createDraftApplication } from "../lib/draft-application";
import { assertShowroomAccess, requireUser, sessionScope } from "../lib/session";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Two gates, on every route in this file and on nothing else.
 *
 * `requireUser` decides whether there is an owner at all. `sessionScope` puts
 * the rest of the request on the restricted database role, where the policies
 * in `lib/db/sql/rls.sql` apply — so a handler that forgets its tenant filter
 * comes back empty rather than coming back with everybody. The unscoped
 * `showroom_dms_accounts` read further down this file is the case in point: it
 * has no `where` clause at all, and until `sessionScope` existed it pulled
 * every dealer code in the database into this process.
 *
 * Mounted **on the `/dms` prefix**, and that is not cosmetic. A path-less
 * `router.use(requireUser)` runs for every request that reaches this router,
 * including ones meant for a router mounted after it — which is exactly what
 * happened when this gate first went in, and it answered 401 to all of
 * VeloDocs's ingest routes for as long as nobody tested them.
 *
 * Gated at the router rather than per route on purpose: a route added to this
 * file later is protected by default instead of by whoever remembers.
 */
router.use("/dms", requireUser, sessionScope);

function parseShowroomId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get("/dms/showrooms", async (req, res): Promise<void> => {
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
    // Scoped to the signed-in owner. This is the picker that decides what the
    // whole console shows, so an unscoped list here would put another owner's
    // outlets one click away.
    .where(eq(showroomsTable.ownerId, req.sessionUser!.ownerId))
    .orderBy(asc(showroomsTable.code));

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

  if (!(await assertShowroomAccess(req, res, showroomId))) return;

  if (!isDmsConfigured()) {
    res.status(503).json({
      error:
        "DMS is not configured. Set DMS_API_URL and DMS_API_KEY " +
        "(http://localhost:9090 and dev-dms-key for the local mock).",
    });
    return;
  }

  try {
    // Every module in one pass. A sync that refreshed sales and left the
    // workshop stale would produce a console where half the numbers are from
    // this minute and half from yesterday, with nothing on screen saying which.
    const results = await syncShowroom(showroomId);
    const jobCardResults = await syncShowroomJobCards(showroomId);
    const enquiryResults = await syncShowroomEnquiries(showroomId);
    const registrationResults = await syncShowroomRegistrations(showroomId);
    const partsResults = await syncShowroomParts(showroomId);

    // The graph is a projection of everything above it, so it is rebuilt last
    // and for the whole owner rather than this showroom. Rebuilding one outlet
    // would be cheaper and wrong: the finding this exists for is a customer who
    // bought at one branch and services at another, and half a graph cannot see
    // them.
    const entityGraph = await rebuildEntityGraph(req.sessionUser!.ownerId);

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

    res.json({
      results,
      jobCardResults,
      enquiryResults,
      registrationResults,
      partsResults,
      entityGraph,
    });
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

  if (!(await assertShowroomAccess(req, res, showroomId))) return;

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

  if (!(await assertShowroomAccess(req, res, showroomId))) return;

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

  if (!(await assertShowroomAccess(req, res, showroomId))) return;

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

  if (!(await assertShowroomAccess(req, res, showroomId))) return;

  const rows = await buildLeadWorklist({
    showroomId,
    stage: typeof req.query.stage === "string" ? req.query.stage : undefined,
  });

  res.json({ summary: summariseLeads(rows), rows });
});

/**
 * The registration worklist.
 *
 * Two numbers here exist nowhere in the dealership. **Certificates in the
 * drawer**: the DMS calls a vehicle finished when the RTO allots a number, and
 * whether the customer ever received the card is two fields further down a
 * record no screen puts side by side. **Road tax held**: collected from the
 * customer at invoice, remitted to the state afterwards, and nothing anywhere
 * subtracts the two dates.
 *
 * It also produces the first cross-module action in the product — a file
 * blocked because there is no policy is a row on this screen and a deal on the
 * insurance one, and the fix for it is InsurRouter.
 */
router.get("/dms/registration-worklist", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }

  if (!(await assertShowroomAccess(req, res, showroomId))) return;

  const rows = await buildRegistrationWorklist({
    showroomId,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    includeDisappeared: req.query.includeDisappeared === "true",
  });

  res.json({ summary: summariseRegistrations(rows), rows });
});

/**
 * The parts counter, read across every outlet the owner holds.
 *
 * The only route in this file that deliberately reads outside the showroom in
 * the query string, and the reason is the product's whole premise. A DMS keeps
 * the stock ledger against a dealer code; an owner with three outlets gets
 * three ledgers and no way to ask whether the part a customer has been waiting
 * three days for is sitting on a shelf in the next branch.
 *
 * The cross-branch scope comes from the **session**, never from the request —
 * `showroomsTable.ownerId = req.sessionUser.ownerId` — so widening the read
 * cannot widen it past the owner. Row-level security is the backstop underneath
 * that, and would return nothing for another owner's showroom even if this
 * query asked for it.
 */
router.get("/dms/spares-worklist", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }

  if (!(await assertShowroomAccess(req, res, showroomId))) return;

  const owned = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, req.sessionUser!.ownerId));

  const rows = await buildSparesWorklist({
    showroomId,
    ownerShowroomIds: owned.map((s) => s.id),
  });

  res.json({ summary: summariseSpares(rows), rows });
});

const ACTION_IDS = new Set<string>([
  "ENQUIRY_LOG_CONTACT",
  "ENQUIRY_REASSIGN",
  "JOB_CARD_MARK_INFORMED",
  "REGISTRATION_ASSIGN_AGENT",
  "REGISTRATION_MARK_NOTIFIED",
  "REGISTRATION_LOG_CHASE",
  "PART_REQUEST_TRANSFER",
  "PART_RAISE_REORDER",
]);

/**
 * Record a decision.
 *
 * One endpoint for every control on every screen, because they all do the same
 * thing: write a decision field that already changes a derived state, and log
 * who did it. Eight of them rather than eight endpoints — the shape is
 * identical and eight near-identical routes would drift.
 *
 * Nothing here writes to the dealer's DMS and nothing here calls a model. What
 * may be done is knowable, so it is a rule (R-23, R-49).
 *
 * Every action takes `clear: true` to undo it. These fields *remove work from a
 * screen* — marking a customer as told takes their row out of the calls-to-make
 * count — so an irreversible mis-click would silently delete a phone call
 * somebody still needs to make.
 */
router.post("/dms/actions", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const action = String(body.action ?? "");

  if (!ACTION_IDS.has(action)) {
    res.status(400).json({ error: `Unknown action ${action || "(none)"}` });
    return;
  }

  const showroomId = Number(body.showroomId);
  const recordKey = String(body.recordKey ?? "");
  if (!Number.isInteger(showroomId) || showroomId <= 0 || !recordKey) {
    res.status(400).json({ error: "showroomId and recordKey are required" });
    return;
  }

  const result = await applyAction({
    ownerId: req.sessionUser!.ownerId,
    userId: req.sessionUser!.userId,
    action: action as ActionId,
    recordKey,
    showroomId,
    clear: body.clear === true,
    empCode: typeof body.empCode === "string" ? body.empCode : undefined,
    channel: typeof body.channel === "string" ? (body.channel as never) : undefined,
    fromShowroomId:
      typeof body.fromShowroomId === "number" ? body.fromShowroomId : undefined,
    note: typeof body.note === "string" ? body.note : undefined,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json({ ok: true, module: result.module });
});

/**
 * Draft a message against a worklist row.
 *
 * Composing is not sending and does not imply it. What comes back is a draft
 * with a status of `DRAFT` and, alongside it, the gate's verdict on what would
 * happen if somebody pressed send — which for anything addressed to a customer
 * is always "a person has to approve this first".
 *
 * 409 when the row's state does not support the message. "Your vehicle is
 * ready" about a vehicle still in the bay is worse than saying nothing, and the
 * only thing that knows whether it is ready is the same `classify()` the screen
 * uses.
 */
router.post("/dms/messages", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const template = String(body.template ?? "");
  if (!TEMPLATE_IDS.has(template)) {
    res.status(400).json({ error: `Unknown template ${template || "(none)"}` });
    return;
  }

  const showroomId = Number(body.showroomId);
  const recordKey = String(body.recordKey ?? "");
  if (!Number.isInteger(showroomId) || showroomId <= 0 || !recordKey) {
    res.status(400).json({ error: "showroomId and recordKey are required" });
    return;
  }

  const result = await createDraft({
    ownerId: req.sessionUser!.ownerId,
    userId: req.sessionUser!.userId,
    showroomId,
    template: template as TemplateId,
    recordKey,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(result.reused ? 200 : 201).json({
    message: result.message,
    reused: result.reused,
    rationale: result.rationale,
    gate: await authoriseSend(result.message),
  });
});

/**
 * The outbox — everything drafted, and whether it may go.
 *
 * The gate's verdict is computed on read rather than stored, for the same
 * reason reconciliation is: an approval that was valid when it was written can
 * stop being valid, and a cached "may send" is precisely the stale flag that
 * would let one through after the recipient left.
 */
router.get("/dms/messages", async (req, res): Promise<void> => {
  const showroomRaw = req.query.showroomId;
  let showroomId: number | undefined;
  if (typeof showroomRaw === "string" && showroomRaw !== "") {
    const parsed = parseShowroomId(showroomRaw);
    if (parsed === null) {
      res.status(400).json({ error: "showroomId must be a positive integer" });
      return;
    }
    if (!(await assertShowroomAccess(req, res, parsed))) return;
    showroomId = parsed;
  }

  const status =
    typeof req.query.status === "string" && req.query.status !== ""
      ? req.query.status.split(",")
      : undefined;

  const rows = await listMessages(req.sessionUser!.ownerId, { showroomId, status });
  res.json({ rows, summary: summariseOutbox(rows) });
});

/**
 * A person takes responsibility for a message.
 *
 * Approving does not send it. That separation is the point: approval is a
 * judgement and sending is an act, and collapsing the two turns a mis-click
 * straight into a message somebody received.
 */
router.post("/dms/messages/:id/approve", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const note = typeof (req.body as Record<string, unknown>)?.note === "string"
    ? ((req.body as Record<string, unknown>).note as string)
    : undefined;

  const result = await approveMessage(req.sessionUser!.ownerId, req.sessionUser!.userId, id, note);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ message: result.message, gate: await authoriseSend(result.message) });
});

/** Decided against. Kept as a row — "we chose not to" is a fact worth keeping. */
router.post("/dms/messages/:id/cancel", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const note = typeof (req.body as Record<string, unknown>)?.note === "string"
    ? ((req.body as Record<string, unknown>).note as string)
    : undefined;

  const result = await cancelMessage(req.sessionUser!.ownerId, req.sessionUser!.userId, id, note);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ message: result.message });
});

/**
 * Send it, if it may go.
 *
 * **409 with the reason when it may not**, and the reason is the useful part —
 * a customer message nobody approved, a recipient who has left, a file that is
 * no longer theirs. This is the endpoint R-48 is tested against: point it at a
 * draft that neither a rule permits nor a person has approved and it refuses.
 */
router.post("/dms/messages/:id/send", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }

  const result = await sendMessage(req.sessionUser!.ownerId, req.sessionUser!.userId, id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ message: result.message });
});

/**
 * Staff who still work here.
 *
 * Behind the reassignment pickers. Departed employees are excluded rather than
 * greyed out — they are the reason the reassignment field exists at all, and a
 * list containing them invites handing work back to somebody who left in
 * February. Each carries a count of what they already hold, because reassigning
 * an orphaned lead to whoever is busiest is a decision DDMS would have made
 * worse rather than better.
 */
router.get("/dms/staff", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }
  if (!(await assertShowroomAccess(req, res, showroomId))) return;

  const role = typeof req.query.role === "string" ? req.query.role : undefined;
  res.json({ staff: await listStaff(showroomId, role) });
});

/**
 * Find a person, a vehicle or a member of staff.
 *
 * Search by whatever somebody actually has to hand — a phone number, a chassis,
 * a registration number, a name. Owner-scoped rather than showroom-scoped, and
 * that is the point rather than a convenience: a customer who bought at one
 * outlet and services at another is one person, and an outlet-scoped search
 * would rebuild the islands this exists to join.
 */
router.get("/dms/entities", async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "");
  if (q.trim().length < 3) {
    res.status(400).json({ error: "q must be at least 3 characters" });
    return;
  }

  const kindRaw = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const kind =
    kindRaw === "CUSTOMER" || kindRaw === "VEHICLE" || kindRaw === "EMPLOYEE"
      ? (kindRaw as EntityKind)
      : undefined;

  res.json({ rows: await searchEntities(req.sessionUser!.ownerId, q, kind) });
});

/**
 * Everything the five mirrors know about one entity.
 *
 * Each record carries the derived state from **its own module's builder**, so
 * this can never disagree with the screen the row came from. Reimplementing the
 * classification here would be faster and would drift the first time a rule
 * changed in one place and not the other.
 */
router.get("/dms/entities/:entityId", async (req, res): Promise<void> => {
  const entityId = Number(req.params.entityId);
  if (!Number.isInteger(entityId) || entityId <= 0) {
    res.status(400).json({ error: "entityId must be a positive integer" });
    return;
  }

  const dossier = await buildDossier(req.sessionUser!.ownerId, entityId);
  if (!dossier) {
    // 404 rather than 403, for the same reason as assertShowroomAccess: a 403
    // confirms the entity exists and belongs to somebody else.
    res.status(404).json({ error: `No entity ${entityId}` });
    return;
  }

  res.json(dossier);
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

    // Whose deal is this? A deal id is guessable, and without this an owner
    // could start an application against another owner's customer — creating a
    // real row, in the wrong tenant, from a single POST.
    if (!tenant) {
      // Unmapped dealer code. A configuration gap, but from here it is also
      // "not yours" — there is no owner to check against, so nobody may act.
      res.status(404).json({ error: `No deal ${dealId}` });
      return;
    }
    if (!(await assertShowroomAccess(req, res, tenant.showroomId))) return;

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
