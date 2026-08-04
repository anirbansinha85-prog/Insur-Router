/**
 * Dealer DMS integration.
 *
 * Replaces the fabricated `callDealerDMS(regNo)` that hashed a registration
 * number into a plausible-looking record. Two things were wrong with it: a new
 * vehicle has no registration number when insurance is bought, and inventing
 * data is the same defect as the OCR stub — it looks like a successful read.
 *
 *   client.ts        HTTP, with a deadline and bounded retries
 *   types.ts         the DMS wire shapes, as untrusted input
 *   hero-adapter.ts  wire → MsaFields + DmsDealContext
 *   registry.ts      adapters keyed by OEM
 *   rto.ts           pincode → RTO, because a new vehicle has no RC to read
 *   tenant.ts        dealer code → showroom → owner
 *   sync.ts          pull a showroom's deals into the mirror
 *   worklist.ts      the mirror versus our own record, reconciled on read
 *   scheduler.ts     run the pull on a timer, so nobody has to remember
 *
 * Five modules now mirror the same way — deals, job cards, enquiries,
 * registration files, parts. Each is a table and a projection rather than a
 * fresh integration, which is the return on having built the pattern once:
 *
 *   service-worklist.ts       the workshop, and who has not been told
 *   lead-worklist.ts          the manufacturer's clock, and leads with no owner
 *   registration-worklist.ts  the RTO file, and the certificates in the drawer
 *   spares-worklist.ts        the part a customer is waiting for that the
 *                             company already owns, in the other branch
 *
 * The last of those is the only one answering a question a single outlet
 * *cannot* answer, rather than one it merely failed to. That is the difference
 * between a better screen and an owner-level product.
 *
 *   actions.ts                the controls behind every "what to do" — all
 *                             deterministic, all reversible, all logged
 *   composer.ts               what DDMS would say — templates, and a model
 *                             allowed to rephrase but not to assert
 *   outbound.ts               the approval gate: nothing leaves without either
 *                             a rule permitting it or a person approving it
 *   tools.ts                  six typed, owner-scoped, read-only lookups —
 *                             the only things the panel may reach
 *   explain.ts                why is this stuck, who else is affected, what
 *                             happens if it waits. Rules answer; a model may
 *                             narrate over the same rows and no others
 *   entity-graph.ts           one person, one vehicle, one member of staff,
 *                             resolved across all five — the join the dealer's
 *                             own system does not have, because a DMS keys
 *                             everything by module and by dealer code
 */

export {
  DmsError,
  dmsEmployees,
  dmsEnquiries,
  dmsJobCards,
  dmsPartStock,
  dmsRegistrations,
  fetchDeal,
  fetchEnquiry,
  fetchJobCard,
  fetchRegnFile,
  fetchStockByChassis,
  isDmsConfigured,
} from "./client";
export {
  syncShowroomRegistrations,
  buildRegistrationWorklist,
  summariseRegistrations,
} from "./registration-worklist";
export type {
  RegistrationSyncResult,
  RegistrationState,
  RegistrationWorklistRow,
  RegistrationWorklistSummary,
} from "./registration-worklist";
export {
  syncShowroomParts,
  buildSparesWorklist,
  summariseSpares,
} from "./spares-worklist";
export { applyAction, listStaff } from "./actions";
export {
  authoriseSend,
  approveMessage,
  cancelMessage,
  createDraft,
  listMessages,
  sendMessage,
  summariseOutbox,
  TEMPLATE_IDS,
} from "./outbound";
export type {
  Authorisation,
  DraftInput,
  DraftResult,
  MessageResult,
  OutboxRow,
  OutboxSummary,
  TemplateId,
} from "./outbound";
export { checkRewrite } from "./composer";
export { explainRecord, citationsHold } from "./explain";
export type { ExplainInput, Explanation } from "./explain";
export type { Evidence, ExplainModule, ToolContext } from "./tools";
export type {
  ComposedDraft,
  MessageAudience,
  MessageChannel,
  MessageModule,
} from "./composer";
export type {
  ActionId,
  ActionModule,
  ApplyActionInput,
  ApplyResult,
  StaffMember,
} from "./actions";
export {
  rebuildEntityGraph,
  searchEntities,
  buildDossier,
  normaliseMobile,
  normaliseChassis,
} from "./entity-graph";
export type {
  EntityKind,
  EntityModule,
  EntityRole,
  EntityGraphResult,
  EntitySearchRow,
  EntityDossier,
  DossierRecord,
} from "./entity-graph";
export type {
  SparesSyncResult,
  SparesState,
  SparesWorklistRow,
  SparesWorklistSummary,
} from "./spares-worklist";
export { syncShowroomEnquiries, buildLeadWorklist, summariseLeads } from "./lead-worklist";
export type {
  EnquirySyncResult,
  LeadState,
  LeadWorklistRow,
  LeadWorklistSummary,
} from "./lead-worklist";
export { adapterFor, adapterForDealer, listAdapters, oemForDealer, DEFAULT_OEM } from "./registry";
export type { DmsAdapter, OemCode } from "./registry";
export type { AdaptedDeal, DmsDealContext } from "./hero-adapter";
export { rtoForPincode, RTO_TABLE_SIZE } from "./rto";
export { resolveTenantByDealerCode } from "./tenant";
export { syncShowroom } from "./sync";
export type { SyncResult } from "./sync";
export { startDmsSyncScheduler } from "./scheduler";
export type { SchedulerHandle } from "./scheduler";
export { panelForShowroom } from "./panel";
export type { PanelEntryWithState } from "./panel";
export { syncShowroomJobCards, buildServiceWorklist, summariseService } from "./service-worklist";
export type {
  JobCardSyncResult,
  ServiceState,
  ServiceWorklistRow,
  ServiceWorklistSummary,
} from "./service-worklist";
export { buildWorklist, summarise } from "./worklist";
export type { WorklistRow, WorklistSummary, ReconcileState } from "./worklist";
export type { DmsTenant } from "./tenant";
export type { RtoLookup } from "./rto";
export type { DmsDeal, DmsStockLookup } from "./types";
