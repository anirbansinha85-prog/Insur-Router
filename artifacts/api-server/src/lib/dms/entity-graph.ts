/**
 * Resolving one person, one vehicle and one member of staff across five mirrors.
 *
 * Everything built so far reads one module at a time, which is how the dealer's
 * own system works and therefore how its blind spots are shaped. Mrs Kavita
 * Sharma is a job card waiting on a brake shoe. Whether she is also an enquiry
 * nobody rang, or owns the vehicle whose certificate has been in the drawer for
 * three weeks, is a question no screen in the dealership can put.
 *
 * ## Why this is not GraphRAG
 *
 * The obvious reach here is a retrieval-augmented graph over the records. It
 * would be the wrong tool. GraphRAG exists to impose structure on *unstructured*
 * text — it infers entities and relationships from prose because there is no
 * schema to read. We already have the schema. Every relationship this file
 * needs is a foreign key or a normalised string, and indexing exact data
 * probabilistically converts a certain answer into a likely one.
 *
 * So the graph is built by rules and stored as rows, and the result is
 * queryable with `where`. Where retrieval genuinely earns its place is the free
 * text these mirrors already carry and nothing reads — complaint descriptions,
 * RTO objections, lost-enquiry reasons. That is a real corpus and a real
 * retrieval problem, and it belongs on top of this rather than instead of it.
 *
 * ## The matching, in full
 *
 * There is no fuzzy name matching, deliberately. A dealership has four
 * customers called Sharma and merging them would be worse than not merging
 * anyone.
 *
 *   CUSTOMER  last ten digits of the mobile number
 *   VEHICLE   chassis number, uppercased, punctuation stripped
 *   EMPLOYEE  dealerCode:empCode
 *
 * A mobile number is a **probable** identity, not a certain one: families share
 * a handset, numbers get reassigned, and a bored salesperson types the
 * showroom's own switchboard number into a walk-in record. Customer entities
 * therefore carry a confidence below 1 and a warning travels with them. Nothing
 * irreversible may be driven by this alone.
 */

import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  dmsDealsTable,
  dmsEmployeesTable,
  dmsEnquiriesTable,
  dmsJobCardsTable,
  dmsRegistrationsTable,
  entitiesTable,
  entityLinksTable,
  showroomsTable,
} from "@workspace/db";
import { logger } from "../logger";

export type EntityKind = "CUSTOMER" | "VEHICLE" | "EMPLOYEE";
export type EntityModule = "DEAL" | "JOB_CARD" | "ENQUIRY" | "REGISTRATION";
export type EntityRole = "SUBJECT" | "VEHICLE" | "ADVISOR" | "ASSIGNEE" | "AGENT";

/**
 * Confidence in a mobile-number identity.
 *
 * Not a guess dressed as a number — it is a flag with a value, and the value's
 * only job is to be below 1 so that anything reading it has to decide what to
 * do about that.
 */
const CUSTOMER_CONFIDENCE = 0.8;

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * Last ten digits. Indian mobile numbers are ten digits and arrive with every
 * possible decoration — `+91 98110-44219`, `091-9811044219`, `9811044219`.
 * Taking the tail handles the country code without having to detect it.
 *
 * Returns null for anything that cannot be a mobile number, which is the right
 * answer: an unmatchable record stays unmatched rather than joining a bucket.
 */
export function normaliseMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const tail = digits.slice(-10);
  // Indian mobile numbers start 6–9. A ten-digit tail beginning 0–5 is a
  // landline, an internal extension, or somebody's idea of a placeholder.
  return /^[6-9]\d{9}$/.test(tail) ? tail : null;
}

export function normaliseChassis(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // A VIN is 17 characters; older two-wheeler chassis numbers are shorter but
  // never trivially short. Anything under 8 is a data-entry artefact.
  return key.length >= 8 ? key : null;
}

export function employeeKey(dealerCode: string, empCode: string | null | undefined): string | null {
  if (!empCode) return null;
  return `${dealerCode}:${empCode.trim().toUpperCase()}`;
}

// ── Building ────────────────────────────────────────────────────────────────

interface Draft {
  kind: EntityKind;
  naturalKey: string;
  displayName: string | null;
  links: Array<{
    showroomId: number;
    module: EntityModule;
    recordKey: string;
    role: EntityRole;
  }>;
}

function add(
  drafts: Map<string, Draft>,
  kind: EntityKind,
  naturalKey: string | null,
  displayName: string | null,
  link: Draft["links"][number],
): void {
  if (!naturalKey) return;
  const id = `${kind}:${naturalKey}`;
  const existing = drafts.get(id);
  if (existing) {
    // Latest non-empty name wins. Records are appended in mirror order and a
    // later record is generally a later spelling of the same person.
    if (displayName) existing.displayName = displayName;
    existing.links.push(link);
    return;
  }
  drafts.set(id, { kind, naturalKey, displayName, links: [link] });
}

export interface EntityGraphResult {
  ownerId: number;
  entities: number;
  links: number;
  customers: number;
  vehicles: number;
  employees: number;
  durationMs: number;
}

/**
 * Rebuild the whole graph for one owner.
 *
 * Wholesale rather than incremental, and that is a deliberate trade. The graph
 * is a projection of five tables that are themselves projections; an
 * incremental update would have to work out which links a changed row *used* to
 * imply, which is exactly the kind of bookkeeping that drifts silently. A few
 * thousand rows rebuild in well under a second, and when that stops being true
 * the fix is to rebuild per showroom rather than to start tracking deltas.
 */
export async function rebuildEntityGraph(ownerId: number): Promise<EntityGraphResult> {
  const startedAt = Date.now();

  const showrooms = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.ownerId, ownerId));

  const showroomIds = showrooms.map((s) => s.id);
  if (showroomIds.length === 0) {
    return { ownerId, entities: 0, links: 0, customers: 0, vehicles: 0, employees: 0, durationMs: 0 };
  }

  const drafts = new Map<string, Draft>();

  // ── Deals ────────────────────────────────────────────────────────────────
  const deals = await db
    .select({
      showroomId: dmsDealsTable.showroomId,
      dealId: dmsDealsTable.dealId,
      customerName: dmsDealsTable.customerName,
      customerMobile: dmsDealsTable.customerMobile,
      chassisNo: dmsDealsTable.chassisNo,
    })
    .from(dmsDealsTable)
    .where(inArray(dmsDealsTable.showroomId, showroomIds));

  /**
   * Deal id → the customer key that deal resolved to.
   *
   * A registration file *names* the deal it belongs to. That is an explicit
   * reference the dealer's own system maintains, and it is certain in a way a
   * matching phone number never is — so where one exists it wins, and the
   * mobile number is only the fallback.
   *
   * Getting this the wrong way round is not academic: the fixtures gave one
   * customer a different number in the sales record and the registration file,
   * which is exactly what happens in a real dealership when two people key the
   * same customer on two different days. Matching on the number alone produced
   * Devender Singh Rathee twice.
   */
  const dealCustomerKey = new Map<string, string>();

  for (const d of deals) {
    const link = { showroomId: d.showroomId, module: "DEAL" as const, recordKey: d.dealId };
    const customerKey = normaliseMobile(d.customerMobile);
    if (customerKey) dealCustomerKey.set(d.dealId, customerKey);
    add(drafts, "CUSTOMER", customerKey, d.customerName, { ...link, role: "SUBJECT" });
    add(drafts, "VEHICLE", normaliseChassis(d.chassisNo), d.chassisNo, { ...link, role: "VEHICLE" });
  }

  // ── Job cards ────────────────────────────────────────────────────────────
  const jobCards = await db
    .select({
      showroomId: dmsJobCardsTable.showroomId,
      dealerCode: dmsJobCardsTable.dealerCode,
      jcNo: dmsJobCardsTable.jcNo,
      customerName: dmsJobCardsTable.customerName,
      customerMobile: dmsJobCardsTable.customerMobile,
      chassisNo: dmsJobCardsTable.chassisNo,
      advisorEmpCode: dmsJobCardsTable.advisorEmpCode,
    })
    .from(dmsJobCardsTable)
    .where(inArray(dmsJobCardsTable.showroomId, showroomIds));

  for (const j of jobCards) {
    const link = { showroomId: j.showroomId, module: "JOB_CARD" as const, recordKey: j.jcNo };
    add(drafts, "CUSTOMER", normaliseMobile(j.customerMobile), j.customerName, { ...link, role: "SUBJECT" });
    add(drafts, "VEHICLE", normaliseChassis(j.chassisNo), j.chassisNo, { ...link, role: "VEHICLE" });
    add(drafts, "EMPLOYEE", employeeKey(j.dealerCode, j.advisorEmpCode), j.advisorEmpCode, { ...link, role: "ADVISOR" });
  }

  // ── Enquiries ────────────────────────────────────────────────────────────
  const enquiries = await db
    .select({
      showroomId: dmsEnquiriesTable.showroomId,
      dealerCode: dmsEnquiriesTable.dealerCode,
      enqId: dmsEnquiriesTable.enqId,
      customerName: dmsEnquiriesTable.customerName,
      customerMobile: dmsEnquiriesTable.customerMobile,
      assignedEmpCode: dmsEnquiriesTable.assignedEmpCode,
    })
    .from(dmsEnquiriesTable)
    .where(inArray(dmsEnquiriesTable.showroomId, showroomIds));

  for (const e of enquiries) {
    const link = { showroomId: e.showroomId, module: "ENQUIRY" as const, recordKey: e.enqId };
    add(drafts, "CUSTOMER", normaliseMobile(e.customerMobile), e.customerName, { ...link, role: "SUBJECT" });
    add(drafts, "EMPLOYEE", employeeKey(e.dealerCode, e.assignedEmpCode), e.assignedEmpCode, { ...link, role: "ASSIGNEE" });
  }

  // ── Registration files ───────────────────────────────────────────────────
  const registrations = await db
    .select({
      showroomId: dmsRegistrationsTable.showroomId,
      dealerCode: dmsRegistrationsTable.dealerCode,
      regnFileNo: dmsRegistrationsTable.regnFileNo,
      dealId: dmsRegistrationsTable.dealId,
      customerName: dmsRegistrationsTable.customerName,
      customerMobile: dmsRegistrationsTable.customerMobile,
      chassisNo: dmsRegistrationsTable.chassisNo,
      agentEmpCode: dmsRegistrationsTable.agentEmpCode,
    })
    .from(dmsRegistrationsTable)
    .where(inArray(dmsRegistrationsTable.showroomId, showroomIds));

  for (const r of registrations) {
    const link = { showroomId: r.showroomId, module: "REGISTRATION" as const, recordKey: r.regnFileNo };
    // The named deal first, the phone number second. See `dealCustomerKey`.
    //
    // Not extended to job cards, deliberately: a job card names a chassis, and
    // going chassis → deal → customer would attribute a service visit to
    // whoever bought the vehicle. Second-hand vehicles are most of a workshop's
    // book, and that inference would confidently name the wrong person.
    const customerKey =
      dealCustomerKey.get(r.dealId) ?? normaliseMobile(r.customerMobile);
    add(drafts, "CUSTOMER", customerKey, r.customerName, { ...link, role: "SUBJECT" });
    add(drafts, "VEHICLE", normaliseChassis(r.chassisNo), r.chassisNo, { ...link, role: "VEHICLE" });
    add(drafts, "EMPLOYEE", employeeKey(r.dealerCode, r.agentEmpCode), r.agentEmpCode, { ...link, role: "AGENT" });
  }

  // Names for the employee entities, which the mirrors reference by code only.
  const employees = await db
    .select({
      dealerCode: dmsEmployeesTable.dealerCode,
      empCode: dmsEmployeesTable.empCode,
      empName: dmsEmployeesTable.empName,
    })
    .from(dmsEmployeesTable)
    .where(inArray(dmsEmployeesTable.showroomId, showroomIds));

  for (const emp of employees) {
    const draft = drafts.get(`EMPLOYEE:${employeeKey(emp.dealerCode, emp.empCode)}`);
    if (draft) draft.displayName = emp.empName;
  }

  // ── Write ────────────────────────────────────────────────────────────────
  //
  // **Entities are upserted; links are replaced.** The two halves of this table
  // pair have different requirements and treating them the same way was wrong.
  //
  // An entity id is *addressable* — it is in a URL, and somebody may have a
  // dossier open. The first version of this deleted and re-inserted everything,
  // which meant the scheduler silently reassigned every id fifteen minutes
  // after anyone opened a page. It also reset `firstSeenAt` on every pass,
  // making "we have known about this customer since June" a lie that refreshed
  // itself. Both were found by opening a dossier that had been valid a minute
  // earlier and getting a 404.
  //
  // A link has no identity worth preserving and no external reference, so it
  // stays wholesale — which keeps the property that matters: a link cannot
  // outlive the mirror row that implied it.
  await db.delete(entityLinksTable).where(eq(entityLinksTable.ownerId, ownerId));

  const counts = { CUSTOMER: 0, VEHICLE: 0, EMPLOYEE: 0 };
  const all = [...drafts.values()];
  for (const d of all) counts[d.kind]++;

  const now = new Date();

  // Batched rather than one statement per entity. The first version took five
  // seconds for sixty-six entities — not because Postgres is slow but because a
  // hundred and sixty round trips to a pooler in another region are.
  const inserted =
    all.length === 0
      ? []
      : await db
          .insert(entitiesTable)
          .values(
            all.map((d) => ({
              ownerId,
              kind: d.kind,
              naturalKey: d.naturalKey,
              displayName: d.displayName,
              confidence: d.kind === "CUSTOMER" ? CUSTOMER_CONFIDENCE : 1,
              lastSeenAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [entitiesTable.ownerId, entitiesTable.kind, entitiesTable.naturalKey],
            set: {
              displayName: sql`excluded.display_name`,
              lastSeenAt: now,
            },
          })
          .returning({
            id: entitiesTable.id,
            kind: entitiesTable.kind,
            naturalKey: entitiesTable.naturalKey,
          });

  // Anything that used to exist and no longer appears in any mirror. Deleted
  // rather than left behind, so a search cannot return a customer whose every
  // record has gone.
  const liveKeys = new Set(all.map((d) => `${d.kind}:${d.naturalKey}`));
  const stale = await db
    .select({ id: entitiesTable.id, kind: entitiesTable.kind, naturalKey: entitiesTable.naturalKey })
    .from(entitiesTable)
    .where(eq(entitiesTable.ownerId, ownerId));

  const staleIds = stale
    .filter((e) => !liveKeys.has(`${e.kind}:${e.naturalKey}`))
    .map((e) => e.id);

  if (staleIds.length > 0) {
    await db.delete(entitiesTable).where(inArray(entitiesTable.id, staleIds));
  }

  // Keyed on (kind, naturalKey) rather than relying on `returning` preserving
  // input order. Postgres does in practice; depending on it is the kind of
  // assumption that holds until somebody adds a trigger.
  const idOf = new Map(inserted.map((r) => [`${r.kind}:${r.naturalKey}`, r.id]));

  const seen = new Set<string>();
  const linkValues: Array<typeof entityLinksTable.$inferInsert> = [];

  for (const draft of all) {
    const entityId = idOf.get(`${draft.kind}:${draft.naturalKey}`);
    if (entityId === undefined) continue;

    for (const l of draft.links) {
      // One record can attach the same entity twice — a registration file whose
      // RTO agent is also its advisor — and the unique constraint would reject
      // the whole batch rather than the duplicate.
      const k = `${entityId}:${l.module}:${l.recordKey}:${l.role}`;
      if (seen.has(k)) continue;
      seen.add(k);
      linkValues.push({
        entityId,
        ownerId,
        showroomId: l.showroomId,
        module: l.module,
        recordKey: l.recordKey,
        role: l.role,
      });
    }
  }

  // Chunked so a large dealership does not build a single statement with tens
  // of thousands of parameters and hit the protocol's 65535 limit.
  const CHUNK = 500;
  for (let i = 0; i < linkValues.length; i += CHUNK) {
    await db.insert(entityLinksTable).values(linkValues.slice(i, i + CHUNK));
  }
  const linkCount = linkValues.length;

  const result: EntityGraphResult = {
    ownerId,
    entities: drafts.size,
    links: linkCount,
    customers: counts.CUSTOMER,
    vehicles: counts.VEHICLE,
    employees: counts.EMPLOYEE,
    durationMs: Date.now() - startedAt,
  };
  logger.info(result, "Entity graph rebuilt");
  return result;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface EntitySearchRow {
  id: number;
  kind: EntityKind;
  naturalKey: string;
  displayName: string | null;
  confidence: number;
  /** How many mirror rows touch this entity. The reason to open it. */
  linkCount: number;
  modules: EntityModule[];
}

/**
 * Search by anything a person would actually have to hand: a phone number, a
 * chassis, a registration number, or a name.
 *
 * The first three are exact after normalisation. The name is a prefix match and
 * is for *finding* an entity, never for merging two — see the note at the top.
 */
export async function searchEntities(
  ownerId: number,
  query: string,
  kind?: EntityKind,
): Promise<EntitySearchRow[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const asMobile = normaliseMobile(trimmed);
  const asChassis = normaliseChassis(trimmed);
  const like = `%${trimmed.toLowerCase()}%`;

  // Exact matches on the normalised keys, plus a substring match for names and
  // for a partly-typed number. Built as a list so an absent normalisation drops
  // out rather than contributing a `false` nobody can read.
  const matchers = [
    sql`lower(${entitiesTable.displayName}) like ${like}`,
    sql`lower(${entitiesTable.naturalKey}) like ${like}`,
  ];
  if (asMobile) matchers.push(sql`${entitiesTable.naturalKey} = ${asMobile}`);
  if (asChassis) matchers.push(sql`${entitiesTable.naturalKey} = ${asChassis}`);

  const rows = await db
    .select({
      id: entitiesTable.id,
      kind: entitiesTable.kind,
      naturalKey: entitiesTable.naturalKey,
      displayName: entitiesTable.displayName,
      confidence: entitiesTable.confidence,
      linkCount: sql<number>`count(${entityLinksTable.id})::int`,
      modules: sql<string[]>`coalesce(array_agg(distinct ${entityLinksTable.module}), '{}')`,
    })
    .from(entitiesTable)
    .leftJoin(entityLinksTable, eq(entityLinksTable.entityId, entitiesTable.id))
    .where(
      and(
        eq(entitiesTable.ownerId, ownerId),
        kind ? eq(entitiesTable.kind, kind) : undefined,
        or(...matchers),
      ),
    )
    .groupBy(entitiesTable.id)
    .orderBy(sql`count(${entityLinksTable.id}) desc`)
    .limit(25);

  return rows.map((r) => ({
    ...r,
    kind: r.kind as EntityKind,
    modules: (r.modules ?? []) as EntityModule[],
  }));
}

// ── The dossier ─────────────────────────────────────────────────────────────

export interface DossierRecord {
  module: EntityModule;
  recordKey: string;
  role: EntityRole;
  showroomId: number;
  showroomCode: string | null;
  /** What this record is, in the words the module's own screen uses. */
  title: string;
  /** The derived state, taken from the module's own classifier — never redone. */
  state: string;
  note: string | null;
  actionRequired: string | null;
  /** Days this has been open, by whatever each module counts. */
  ageDays: number | null;
  /** Where to go in DDMS to act on it. */
  href: string;
}

export interface EntityDossier {
  entity: {
    id: number;
    kind: EntityKind;
    naturalKey: string;
    displayName: string | null;
    confidence: number;
  };
  /** Present when identity is probable rather than certain. See R-47. */
  identityNote: string | null;
  showrooms: Array<{ id: number; code: string | null }>;
  records: DossierRecord[];
  summary: {
    total: number;
    needsAction: number;
    modules: EntityModule[];
    /** Outlets this one person or vehicle appears at. Two is the finding. */
    showroomCount: number;
  };
}

const HREF: Record<EntityModule, string> = {
  DEAL: "/worklist",
  JOB_CARD: "/service",
  ENQUIRY: "/",
  REGISTRATION: "/registrations",
};

/**
 * Everything the five mirrors know about one person, vehicle or member of staff.
 *
 * The derived state on each row comes from **the module's own builder**, not
 * from a second implementation here. That costs a handful of extra queries —
 * one builder call per showroom-and-module the entity touches, so eight in the
 * worst case against this data — and it buys the only property that matters: a
 * customer's dossier can never disagree with the screen the row came from.
 *
 * Reimplementing the classification here to save those queries is the obvious
 * optimisation and the one that guarantees the two drift apart, quietly, the
 * first time a rule changes in one place.
 */
export async function buildDossier(
  ownerId: number,
  entityId: number,
): Promise<EntityDossier | null> {
  const [entity] = await db
    .select()
    .from(entitiesTable)
    .where(and(eq(entitiesTable.id, entityId), eq(entitiesTable.ownerId, ownerId)));

  if (!entity) return null;

  const links = await db
    .select({
      module: entityLinksTable.module,
      recordKey: entityLinksTable.recordKey,
      role: entityLinksTable.role,
      showroomId: entityLinksTable.showroomId,
      showroomCode: showroomsTable.code,
    })
    .from(entityLinksTable)
    .innerJoin(showroomsTable, eq(showroomsTable.id, entityLinksTable.showroomId))
    .where(eq(entityLinksTable.entityId, entityId));

  // Which builders to run, and for which outlets. Only what this entity
  // actually touches — a customer with one job card does not need the deal,
  // enquiry and registration worklists built for them.
  const needed = new Map<number, Set<EntityModule>>();
  for (const l of links) {
    const set = needed.get(l.showroomId) ?? new Set<EntityModule>();
    set.add(l.module as EntityModule);
    needed.set(l.showroomId, set);
  }

  // Imported here rather than at the top: these modules import `client.ts`,
  // which reads DMS configuration, and pulling that into the entity graph's
  // import chain would make a purely local query depend on the DMS being
  // configured.
  const [{ buildWorklist }, { buildServiceWorklist }, { buildLeadWorklist }, { buildRegistrationWorklist }] =
    await Promise.all([
      import("./worklist"),
      import("./service-worklist"),
      import("./lead-worklist"),
      import("./registration-worklist"),
    ]);

  type Projected = { state: string; note: string | null; action: string | null; title: string; age: number | null };
  const projected = new Map<string, Projected>();
  const key = (m: EntityModule, k: string) => `${m}:${k}`;

  for (const [showroomId, modules] of needed) {
    if (modules.has("DEAL")) {
      for (const r of await buildWorklist({ showroomId })) {
        projected.set(key("DEAL", r.dealId), {
          state: r.reconcile,
          note: r.reconcileNote,
          action: r.actionRequired,
          title: `${r.modelDescription ?? "Vehicle"} — ${r.dms.status.replace(/_/g, " ").toLowerCase()}`,
          age: r.daysInStatus,
        });
      }
    }
    if (modules.has("JOB_CARD")) {
      for (const r of await buildServiceWorklist({ showroomId })) {
        projected.set(key("JOB_CARD", r.jcNo), {
          state: r.state,
          note: r.note,
          action: r.actionRequired,
          title: `${r.modelDescription ?? "Vehicle"} — ${r.jcType.replace(/_/g, " ").toLowerCase()} service`,
          age: r.daysInStatus,
        });
      }
    }
    if (modules.has("ENQUIRY")) {
      for (const r of await buildLeadWorklist({ showroomId })) {
        projected.set(key("ENQUIRY", r.enqId), {
          state: r.state,
          note: r.note,
          action: r.actionRequired,
          title: `Enquiry — ${r.dms.source.replace(/_/g, " ").toLowerCase()}, ${r.dms.stage.toLowerCase()}`,
          age: null,
        });
      }
    }
    if (modules.has("REGISTRATION")) {
      for (const r of await buildRegistrationWorklist({ showroomId })) {
        projected.set(key("REGISTRATION", r.regnFileNo), {
          state: r.state,
          note: r.note,
          action: r.actionRequired,
          title: `Registration — ${r.dms.status.replace(/_/g, " ").toLowerCase()}`,
          age: r.ageDays,
        });
      }
    }
  }

  const records: DossierRecord[] = links.map((l) => {
    const p = projected.get(key(l.module as EntityModule, l.recordKey));
    return {
      module: l.module as EntityModule,
      recordKey: l.recordKey,
      role: l.role as EntityRole,
      showroomId: l.showroomId,
      showroomCode: l.showroomCode,
      title: p?.title ?? l.recordKey,
      // A link with no projection means the mirror row has disappeared from the
      // DMS since the graph was built. Said plainly rather than left blank.
      state: p?.state ?? "GONE_FROM_DMS",
      note: p?.note ?? null,
      actionRequired: p?.action ?? null,
      ageDays: p?.age ?? null,
      href: HREF[l.module as EntityModule],
    };
  });

  const showroomSeen = new Map<number, string | null>();
  for (const l of links) showroomSeen.set(l.showroomId, l.showroomCode);

  return {
    entity: {
      id: entity.id,
      kind: entity.kind as EntityKind,
      naturalKey: entity.naturalKey,
      displayName: entity.displayName,
      confidence: entity.confidence,
    },
    // R-47, said on the record rather than buried in a schema comment: a
    // reader deciding whether to act on this needs to know how it was matched.
    identityNote:
      entity.kind === "CUSTOMER"
        ? "Matched on mobile number. Families share a handset and numbers get reassigned, so treat this as probably one person rather than certainly one."
        : null,
    showrooms: [...showroomSeen].map(([id, code]) => ({ id, code })),
    records,
    summary: {
      total: records.length,
      needsAction: records.filter((r) => r.actionRequired).length,
      modules: [...new Set(records.map((r) => r.module))],
      showroomCount: showroomSeen.size,
    },
  };
}
