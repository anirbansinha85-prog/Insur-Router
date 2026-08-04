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
 * Four modules now mirror the same way — deals, job cards, enquiries,
 * registration files. Each is a table and a projection rather than a fresh
 * integration, which is the return on having built the pattern once:
 *
 *   service-worklist.ts       the workshop, and who has not been told
 *   lead-worklist.ts          the manufacturer's clock, and leads with no owner
 *   registration-worklist.ts  the RTO file, and the certificates in the drawer
 */

export {
  DmsError,
  dmsEmployees,
  dmsEnquiries,
  dmsJobCards,
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
