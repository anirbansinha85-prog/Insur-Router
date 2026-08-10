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
  writeActivity,
  retractActivity,
  listActivities,
  createTask,
  closeTask,
  type ActivityKind,
  type ActivityModule,
  buildInventoryWorklist,
  buildReceivablesWorklist,
  detectForShowrooms,
  listEvents,
  EVENT_MODULES,
  type EventModule,
  summariseInventory,
  summariseReceivables,
  syncShowroomInventory,
  syncShowroomReceivables,
  authoriseSend,
  cancelMessage,
  createDraft,
  editMessage,
  explainRecord,
  listMessages,
  listStaff,
  sendMessage,
  summariseOutbox,
  TEMPLATE_IDS,
  type ActionId,
  type ExplainModule,
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
import {
  assertModuleAccess,
  assertShowroomAccess,
  requireUser,
  sessionScope,
} from "../lib/session";
import {
  may,
  seesEveryOutlet,
  whyNot,
  PERMISSION_FOR_ACTION,
  type RegistryActionId,
} from "../lib/dms/permissions";
import { buildQueue } from "../lib/dms/queue";
import { describeRules, MAX_RULES } from "../lib/dms/rules";
import { describePolicy, loadPolicy, resetAllPolicy, setPolicy } from "../lib/dms/policy";
import { traceFor } from "../lib/dms/journeys";
import {
  confirmMapping,
  describeSources,
  dropReport,
  listBatches,
  releaseHeld,
  setPath,
} from "../lib/dms/ingest";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The seven a timeline or a task can point at.
 *
 * `OUTBOX` is absent: it is a module for permission purposes but not a place
 * records live, and a note about the outbox is a note about the record the
 * message is for.
 */
const ACTIVITY_MODULES = new Set<string>([
  "DEAL",
  "JOB_CARD",
  "ENQUIRY",
  "REGISTRATION",
  "PART",
  "RECEIVABLE",
  "VEHICLE",
]);

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

/**
 * Every outlet this owner holds.
 *
 * Read from the session's owner id and never from the request. Three screens
 * now depend on it — spares, receivables and the floor — and each of them is a
 * query that deliberately spans outlets, which is the one place a scope taken
 * from a caller would be worth taking.
 */
async function ownedShowroomIds(ownerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, ownerId));
  return rows.map((r) => r.id);
}

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
    const receivablesResults = await syncShowroomReceivables(showroomId);
    const inventoryResults = await syncShowroomInventory(showroomId);

    // The graph is a projection of everything above it, so it is rebuilt last
    // and for the whole owner rather than this showroom. Rebuilding one outlet
    // would be cheaper and wrong: the finding this exists for is a customer who
    // bought at one branch and services at another, and half a graph cannot see
    // them.
    const entityGraph = await rebuildEntityGraph(req.sessionUser!.ownerId);

    // What moved, after everything else has landed. On a manual sync this is
    // mostly a no-op — the scheduler will usually have got there first — and
    // that is the correct relationship between the two.
    const events = await detectForShowrooms(req.sessionUser!.ownerId, [showroomId]);

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
      receivablesResults,
      inventoryResults,
      entityGraph,
      events,
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
  if (!assertModuleAccess(req, res, "DEAL")) return;

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
  if (!assertModuleAccess(req, res, "JOB_CARD")) return;

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
  if (!assertModuleAccess(req, res, "ENQUIRY")) return;

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
  if (!assertModuleAccess(req, res, "REGISTRATION")) return;

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
  if (!assertModuleAccess(req, res, "PART")) return;

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

const EXPLAIN_MODULES = new Set<string>([
  "JOB_CARD",
  "ENQUIRY",
  "REGISTRATION",
  "PART",
  "RECEIVABLE",
  "VEHICLE",
]);

/**
 * The ledger, read across the group.
 *
 * Scoped to the outlet on screen for the rows, and to **every outlet the
 * session's owner holds** for the exposure figure attached to them. That is the
 * same arrangement as the spares worklist and for the same reason: a DMS keys
 * the ledger to a dealer code, so what one insurer owes the group is a question
 * neither branch's own ageing report can be made to answer.
 */
router.get("/dms/receivables-worklist", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }
  if (!(await assertShowroomAccess(req, res, showroomId))) return;
  if (!assertModuleAccess(req, res, "RECEIVABLE")) return;

  const owned = await ownedShowroomIds(req.sessionUser!.ownerId);
  const rows = await buildReceivablesWorklist({ showroomId, ownerShowroomIds: owned });
  res.json({ summary: summariseReceivables(rows), rows });
});

/**
 * The floor, aged — and matched against the people asking for what is on it.
 *
 * The enquiry match reads across every outlet, because a customer who walked
 * into one showroom asking for a model standing on another's floor is exactly
 * the case neither branch can see.
 */
router.get("/dms/inventory-worklist", async (req, res): Promise<void> => {
  const showroomId = parseShowroomId(String(req.query.showroomId ?? ""));
  if (showroomId === null) {
    res.status(400).json({ error: "showroomId query parameter is required and must be a positive integer" });
    return;
  }
  if (!(await assertShowroomAccess(req, res, showroomId))) return;
  if (!assertModuleAccess(req, res, "VEHICLE")) return;

  const owned = await ownedShowroomIds(req.sessionUser!.ownerId);
  const rows = await buildInventoryWorklist({ showroomId, ownerShowroomIds: owned });
  res.json({ summary: summariseInventory(rows), rows });
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
  "RECEIVABLE_LOG_CHASE",
  "RECEIVABLE_MARK_DISPUTED",
  "VEHICLE_MARK_OFFERED",
  "VEHICLE_PROPOSE_TRANSFER",
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

  /*
   * Who may call this one.
   *
   * **This route checked nothing until OBJ-21**, and it was not the hole it
   * looks like: `app.can_read(module)` sits in the `using` and `with check` of
   * every mirror table's row policy, so a technician marking a receivable
   * disputed was already refused — by Postgres.
   *
   * What was wrong was the sentence. `applyAction` reads the row before it
   * writes, row-level security makes that read return nothing, and the caller
   * got **404 "No receivable REC-0417-5504"** — which is false. The receivable
   * exists. They may not see it.
   *
   * A 404 is the right answer across dealerships, where confirming a record
   * exists is itself a leak. Inside your own dealership with the wrong role it
   * is unhelpful, and the table already holds the sentence that helps.
   */
  const permission = PERMISSION_FOR_ACTION[action as RegistryActionId];
  if (!may(req.sessionUser!.role, permission)) {
    res.status(403).json({ error: whyNot(req.sessionUser!.role, permission) });
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
    enqId: typeof body.enqId === "string" ? body.enqId : undefined,
    toShowroomId: typeof body.toShowroomId === "number" ? body.toShowroomId : undefined,
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
    ownerShowroomIds: await ownedShowroomIds(req.sessionUser!.ownerId),
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

/**
 * A person writes their own sentence into a draft.
 *
 * The interesting part is what it does to the gate rather than what it does to
 * the text: an edited message can never take the rule path again (R-72), so an
 * internal notification a rule would have sent unattended now waits for the
 * person who edited it to approve it. That is not a restriction bolted on — it
 * is the gate routing the message down the path that matches who wrote it.
 *
 * 409 on anything that is not a `DRAFT`. Approval means somebody read it as it
 * stood, and text that changes afterwards has not been read by the person whose
 * name is on the approval.
 */
router.post("/dms/messages/:id/edit", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  if (typeof body?.body !== "string") {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const subject =
    body.subject === undefined
      ? undefined
      : body.subject === null
        ? null
        : String(body.subject);

  const result = await editMessage(
    req.sessionUser!.ownerId,
    req.sessionUser!.userId,
    req.sessionUser!.name,
    id,
    { subject, body: body.body },
  );
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
 * A record's own timeline — the first thing DDMS holds that no DMS has.
 *
 * Everything else on a record is either the dealer's data or a decision field
 * hung off it. This is the dealership's own account of what happened, and
 * OBJ-22's whole argument is that an agent can write here without lying: an
 * activity it wrote asserts that it wrote it, and nothing more.
 *
 * Gated twice, on purpose. The permission table says whether this principal may
 * write at all; the row policy says which records they may write about, using
 * the same `app.can_read(module)` that gates the mirror row itself. A service
 * advisor is refused a note on a receivable by Postgres, not by this handler.
 */
/**
 * How this outlet is connected, per kind of data (OBJ-24).
 *
 * The screen a dealership sees during onboarding, and the honest answer to
 * *how fresh is this*. An outlet on the API path is live; one on a report is
 * only as current as the last export, and the row says so rather than showing a
 * sync timestamp that means nothing.
 */
router.get("/dms/ingest/sources", async (req, res): Promise<void> => {
  const showroomId = Number(req.query.showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }
  res.json({ sources: await describeSources(showroomId) });
});

/**
 * Change how a kind of data arrives.
 *
 * `policy.set` rather than a new permission: this is the same class of decision
 * as the dealership's own thresholds — it changes what the product does with
 * this outlet's data and belongs to whoever runs the business, not to whoever
 * happens to be doing the onboarding call.
 */
router.put("/dms/ingest/sources", async (req, res): Promise<void> => {
  const user = req.sessionUser!;
  if (!may(user.role, "policy.set")) {
    res.status(403).json({ error: whyNot(user.role, "policy.set") });
    return;
  }

  const body = req.body as { showroomId?: unknown; dataType?: unknown; path?: unknown; enabled?: unknown };
  const showroomId = Number(body.showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }
  const dataType = String(body.dataType).toUpperCase();
  const path = String(body.path).toUpperCase();
  if (!ACTIVITY_MODULES.has(dataType)) {
    res.status(400).json({ error: `Unknown data type ${body.dataType}` });
    return;
  }
  if (!["API", "REPORT", "DOCUMENT"].includes(path)) {
    res.status(400).json({ error: "path must be API, REPORT or DOCUMENT" });
    return;
  }

  await setPath({
    ownerId: user.ownerId,
    showroomId,
    dataType: dataType as never,
    path: path as never,
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
  });
  res.json({ sources: await describeSources(showroomId) });
});

/**
 * Take in a file the dealer exported from their own system.
 *
 * The whole commercial argument in one endpoint. If this export's shape has
 * been confirmed before the file is read by column position and **no model is
 * called** — the response says so in `usedModel`, which is the number OBJ-24 is
 * measured on. If it has not, the file is held with a proposed mapping and a
 * person is asked what the headings mean, once.
 *
 * The body is the file as text rather than multipart, because every DMS export
 * worth taking is CSV or tab-separated and a parser is not an upload service.
 */
router.post("/dms/ingest/report", async (req, res): Promise<void> => {
  const user = req.sessionUser!;
  const body = req.body as {
    showroomId?: unknown;
    dataType?: unknown;
    filename?: unknown;
    text?: unknown;
  };

  const showroomId = Number(body.showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }
  const dataType = String(body.dataType ?? "DEAL").toUpperCase();
  if (!ACTIVITY_MODULES.has(dataType)) {
    res.status(400).json({ error: `Unknown data type ${body.dataType}` });
    return;
  }
  if (!(await assertModuleAccess(req, res, dataType as never))) return;
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    res.status(400).json({ error: "Send the exported file as text." });
    return;
  }

  const result = await dropReport({
    ownerId: user.ownerId,
    showroomId,
    dataType: dataType as never,
    filename: typeof body.filename === "string" ? body.filename : null,
    text: body.text,
    userId: user.userId,
    userName: user.name,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  const r = result.result;
  res.status(201).json({
    batchId: r.batch.id,
    status: r.batch.status,
    mappingId: r.mapping.id,
    mappingStatus: r.mapping.status,
    headings: r.mapping.headings,
    mapping: r.mapping.mapping,
    wasKnown: r.wasKnown,
    usedModel: r.usedModel,
    gaps: r.gaps,
    rowsSeen: r.rowsSeen,
    rowsAccepted: r.rowsAccepted,
    rowsRejected: r.rowsRejected,
    rejections: r.rejections,
  });
});

/**
 * A person says what the columns mean, once.
 *
 * The step that makes a mapping usable, and the only thing that can. A model
 * proposed it; nothing is extracted until somebody here agrees — R-49 applied
 * to onboarding. Held batches on this mapping are released rather than the
 * dealer being told to find the file again.
 */
router.post("/dms/ingest/mappings/:id/confirm", async (req, res): Promise<void> => {
  const user = req.sessionUser!;
  if (!may(user.role, "policy.set")) {
    res.status(403).json({ error: whyNot(user.role, "policy.set") });
    return;
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }

  const body = req.body as { mapping?: unknown; text?: unknown };
  const row = await confirmMapping({
    id,
    userId: user.userId,
    userName: user.name,
    mapping: body.mapping as never,
  });
  if (!row) {
    res.status(404).json({ error: "No such mapping." });
    return;
  }

  const released =
    typeof body.text === "string" && body.text.length > 0
      ? await releaseHeld({ mappingId: id, text: body.text })
      : [];

  res.json({
    mapping: {
      id: row.id,
      status: row.status,
      mapping: row.mapping,
      confirmedByName: row.confirmedByName,
      usedCount: row.usedCount,
    },
    released: released.map((b) => ({ id: b.id, rowsAccepted: b.rowsAccepted })),
  });
});

/** What has been taken in, newest first. The audit trail for a disputed figure. */
router.get("/dms/ingest/batches", async (req, res): Promise<void> => {
  const showroomId = Number(req.query.showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }
  res.json({ batches: await listBatches(showroomId) });
});

/**
 * Where this record's journey has got to (OBJ-23).
 *
 * Read-only, and there is no companion write route on purpose. A journey is
 * moved by the world changing — the RTO answers, the tax clears — not by
 * somebody pressing a button on it, and an endpoint that let a person set a
 * position would be a second way for the record to become untrue. Where a
 * person acts they act on the *record*, through `POST /dms/actions`, and the
 * runtime notices on its next pass. That is the one door (R-81) applied to the
 * thing most likely to want a second one.
 *
 * The position and the wait in the response are **derived on read**, exactly as
 * reconciliation is: a stored *waiting on the RTO* goes stale the moment the
 * RTO answers. What comes out of the database is the arrivals, because those
 * are history and history does not go stale.
 *
 * 404 when the record has no journey, which is an answer rather than a failure:
 * only registration files have a definition today.
 */
router.get("/dms/records/:module/:recordKey/journey", async (req, res): Promise<void> => {
  const module = String(req.params.module).toUpperCase() as ActivityModule;
  if (!ACTIVITY_MODULES.has(module)) {
    res.status(400).json({ error: `Unknown module ${req.params.module}` });
    return;
  }
  if (!(await assertModuleAccess(req, res, module as never))) return;

  const trace = await traceFor(
    module,
    String(req.params.recordKey),
    await loadPolicy(req.sessionUser!.ownerId),
  );
  if (!trace) {
    res.status(404).json({ error: "This record is not being tracked as a journey." });
    return;
  }
  res.json(trace);
});

router.get("/dms/records/:module/:recordKey/activities", async (req, res): Promise<void> => {
  const module = String(req.params.module).toUpperCase() as ActivityModule;
  if (!ACTIVITY_MODULES.has(module)) {
    res.status(400).json({ error: `Unknown module ${req.params.module}` });
    return;
  }
  if (!(await assertModuleAccess(req, res, module as never))) return;

  res.json({
    activities: await listActivities(req.sessionUser!.ownerId, module, String(req.params.recordKey)),
  });
});

router.post("/dms/records/:module/:recordKey/activities", async (req, res): Promise<void> => {
  const module = String(req.params.module).toUpperCase() as ActivityModule;
  if (!ACTIVITY_MODULES.has(module)) {
    res.status(400).json({ error: `Unknown module ${req.params.module}` });
    return;
  }
  if (!(await assertModuleAccess(req, res, module as never))) return;

  const body = req.body as { kind?: unknown; body?: unknown; showroomId?: unknown };
  const showroomId = Number(body.showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }

  const user = req.sessionUser!;
  const result = await writeActivity({
    ownerId: user.ownerId,
    showroomId,
    module,
    recordKey: String(req.params.recordKey),
    kind: (typeof body.kind === "string" ? body.kind : "NOTE") as ActivityKind,
    body: typeof body.body === "string" ? body.body : "",
    userId: user.userId,
    authorName: user.name,
    principal: user.role,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json({ activity: result.row });
});

/** Withdrawn, not deleted. The row stays and says who withdrew it and why. */
router.post("/dms/activities/:id/retract", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const reason = String((req.body as { reason?: unknown })?.reason ?? "");
  const user = req.sessionUser!;
  const result = await retractActivity(user.ownerId, user.userId, user.role, id, reason);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ activity: result.row });
});

/**
 * Work somebody decided needs doing.
 *
 * There is deliberately **no list endpoint**. Open tasks arrive on
 * `GET /dms/queue` alongside everything else, because a second list is the
 * problem OBJ-15 was built to remove — seven places to look and no answer to
 * *what do I do next*.
 */
router.post("/dms/tasks", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const showroomId = Number(body.showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }

  const module = typeof body.module === "string" ? (body.module.toUpperCase() as ActivityModule) : null;
  if (module && !ACTIVITY_MODULES.has(module)) {
    res.status(400).json({ error: `Unknown module ${String(body.module)}` });
    return;
  }
  if (module && !(await assertModuleAccess(req, res, module as never))) return;

  const user = req.sessionUser!;
  const result = await createTask({
    ownerId: user.ownerId,
    showroomId,
    title: typeof body.title === "string" ? body.title : "",
    detail: typeof body.detail === "string" ? body.detail : null,
    module,
    recordKey: typeof body.recordKey === "string" ? body.recordKey : null,
    assignedEmpCode: typeof body.assignedEmpCode === "string" ? body.assignedEmpCode : null,
    dueOn: typeof body.dueOn === "string" ? body.dueOn : null,
    source: "PERSON",
    userId: user.userId,
    userName: user.name,
    principal: user.role,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json({ task: result.row });
});

router.post("/dms/tasks/:id/close", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const body = req.body as { status?: unknown; outcome?: unknown };
  const status = body.status === "CANCELLED" ? "CANCELLED" : "DONE";
  const user = req.sessionUser!;
  const result = await closeTask(
    user.ownerId,
    user.userId,
    user.role,
    id,
    status,
    typeof body.outcome === "string" ? body.outcome : undefined,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ task: result.row });
});

/**
 * What has moved, and what it moved from.
 *
 * The log of derived-state transitions. Everything else in DDMS answers *what
 * is true now*; this is the only thing that answers *what changed and when*,
 * which is a different question and the one a rule is triggered by.
 *
 * Filterable by record, because that is what a timeline on a row reads — and
 * because the newest row for a record is, by construction, its current state.
 */
router.get("/dms/events", async (req, res): Promise<void> => {
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

  const moduleRaw = typeof req.query.module === "string" ? req.query.module : undefined;
  if (moduleRaw && !EVENT_MODULES.has(moduleRaw)) {
    res.status(400).json({ error: `Unknown module ${moduleRaw}` });
    return;
  }

  const limitRaw = Number(req.query.limit);
  const rows = await listEvents(req.sessionUser!.ownerId, {
    showroomId,
    module: moduleRaw as EventModule | undefined,
    recordKey: typeof req.query.recordKey === "string" ? req.query.recordKey : undefined,
    limit: Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
  });

  res.json({ rows });
});

/**
 * One queue, worked one at a time.
 *
 * Every screen above answers *what is wrong with these records*. This answers
 * the question a short-staffed dealership actually has to answer every
 * morning — *what should I do next* — and it is the only screen in the product
 * that spans all seven modules at once.
 *
 * Three bands: mine, then nobody's, then my outlet's. The middle one is the
 * point; orphaned work is what a dealership loses, and until now it was
 * visible only as a row on a list somebody had to think to open.
 *
 * Scoped twice, like everything else. `visibleShowroomIds` narrows to the
 * outlet a member of staff works at, and `canRead` decides which modules are
 * built at all — a service advisor's queue holds job cards and parts and does
 * not silently contain an empty ledger section.
 */
router.get("/dms/queue", async (req, res): Promise<void> => {
  const user = req.sessionUser!;
  const owned = await ownedShowroomIds(user.ownerId);

  // The outlets this person may act in. An owner or a manager gets the group;
  // anybody else gets the one on their login. Always a subset of `owned`,
  // which is the property every other scope in this product rests on.
  const visible =
    user.showroomId !== null && !seesEveryOutlet(user.role) ? [user.showroomId] : owned;

  const result = await buildQueue({
    ownerId: user.ownerId,
    ownerShowroomIds: owned,
    visibleShowroomIds: visible,
    empCode: user.empCode,
    role: user.role,
  });

  res.json(result);
});

/**
 * The dealership's own numbers.
 *
 * What comes first on the queue, and when a classifier decides something has
 * gone wrong. Both were ours until OBJ-18 and neither is a product question —
 * whether a stuck registration outranks a broken payment promise depends on
 * this group's RTO agent and this group's cash position.
 *
 * Read by anybody signed in, because the numbers explain what they are looking
 * at. Written only by an owner or a showroom manager: the roles that hold every
 * module already, and the only two whose judgement covers the whole dealership.
 */
router.get("/dms/policy", async (req, res): Promise<void> => {
  res.json({ settings: await describePolicy(req.sessionUser!.ownerId) });
});

router.put("/dms/policy", async (req, res): Promise<void> => {
  const user = req.sessionUser!;
  /*
   * `policy.set`, not `seesEveryOutlet`.
   *
   * The two have the same holders today and they are not the same question.
   * One asks whether you can see across branches; the other whether you may
   * decide what the whole dealership does first. Asking the visibility question
   * to answer the authority one is the drift OBJ-21 exists to remove — and the
   * day a dealership wants a branch manager who sets numbers for one outlet,
   * this line already says which of the two it means.
   */
  if (!may(user.role, "policy.set")) {
    res.status(403).json({ error: whyNot(user.role, "policy.set") });
    return;
  }

  const body = req.body as { key?: unknown; value?: unknown; showroomId?: unknown };
  const key = typeof body.key === "string" ? body.key : "";
  // Null is the reset, and it is a different thing from "no value given".
  const value = body.value === null ? null : Number(body.value);
  if (value !== null && !Number.isFinite(value)) {
    res.status(400).json({ error: "A value must be a whole number, or null to reset it." });
    return;
  }

  const showroomId = Number(body.showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }

  const result = await setPolicy(user.ownerId, showroomId, user.userId, key, value);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});

router.post("/dms/policy/reset", async (req, res): Promise<void> => {
  const user = req.sessionUser!;
  if (!may(user.role, "policy.set")) {
    res.status(403).json({ error: whyNot(user.role, "policy.set") });
    return;
  }
  const showroomId = Number((req.body as { showroomId?: unknown }).showroomId);
  if (!Number.isInteger(showroomId) || !(await assertShowroomAccess(req, res, showroomId))) {
    if (!res.headersSent) res.status(400).json({ error: "showroomId must be a positive integer" });
    return;
  }
  const cleared = await resetAllPolicy(user.ownerId, showroomId, user.userId);
  res.json({ cleared });
});

/**
 * What runs itself.
 *
 * The whole rule set, in the order it is evaluated, with what stops each one.
 * A screen for it exists because *"the rule set is one ordered list short
 * enough to read in a sitting"* is only true if somebody can actually read it —
 * and the failure this product is designed against is an automation layer
 * nobody can predict, which begins with an automation layer nobody can see.
 *
 * Read-only, and there is nothing behind it to write to. The rules live in
 * `lib/dms/rules.ts` and changing them is a deployment, which is the R-52 line:
 * no rule builder, no per-dealership flows.
 */
router.get("/dms/rules", (_req, res): void => {
  res.json({ rules: describeRules(), max: MAX_RULES });
});

/**
 * Why is this stuck, who else is affected, what happens if it waits.
 *
 * The three questions every worklist row raises and none of them can answer,
 * because each reaches across a boundary the dealer\'s own system keys
 * everything by — another module, another outlet, another person\'s workload.
 *
 * **The answer arrives with its evidence attached.** `findings` is one sentence
 * per claim, each assembled by a rule from one of the `evidence` rows, and
 * `summary` is a model\'s reading of those findings — present only when one
 * passed a check that every figure in it appears in the evidence. The findings
 * are returned either way, because the traceable form of an answer is not the
 * part to drop when a nicer-sounding one exists.
 *
 * Nothing here classifies. The state on the row comes from the module\'s own
 * `classify()` and travels through untouched (R-49).
 */
router.post("/dms/explain", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const module = String(body.module ?? "");
  if (!EXPLAIN_MODULES.has(module)) {
    res.status(400).json({ error: `Unknown module ${module || "(none)"}` });
    return;
  }

  const showroomId = Number(body.showroomId);
  const recordKey = String(body.recordKey ?? "");
  if (!Number.isInteger(showroomId) || showroomId <= 0 || !recordKey) {
    res.status(400).json({ error: "showroomId and recordKey are required" });
    return;
  }
  if (!(await assertShowroomAccess(req, res, showroomId))) return;

  // The cross-outlet lookups read every showroom the *session\'s* owner holds,
  // never a list from the request. Same rule as the spares worklist, and for
  // the same reason: the one query that spans outlets is the one worth being
  // certain about.
  const owned = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, req.sessionUser!.ownerId));

  const explanation = await explainRecord({
    ownerId: req.sessionUser!.ownerId,
    showroomId,
    ownerShowroomIds: owned.map((o) => o.id),
    module: module as ExplainModule,
    recordKey,
  });

  if (!explanation) {
    res.status(404).json({ error: `No ${module.toLowerCase()} ${recordKey} at this showroom` });
    return;
  }

  res.json(explanation);
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
