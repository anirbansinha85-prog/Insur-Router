/**
 * Where a branch sits, and therefore which books it lands in (OBJ-37, R-119).
 *
 * Every figure in the Finance module is drawn at one of three levels, and this
 * file is how anything finds out which:
 *
 *   entity        the trial balance, the P&L, the balance sheet
 *   registration  GSTR-1, GSTR-3B, the invoice series, e-invoicing
 *   branch        the day close, the branch P&L, stock, the cash book
 *
 * R-120 says a report states the level it was drawn at. That is only possible
 * if the level is a thing the code can name, which is what `Placement` is.
 *
 * **Nothing here re-derives.** A branch's entity is the column on the branch,
 * not a guess from its GSTIN or its address, for the same reason the overall
 * view calls the same builders the module screens do: two paths to one answer
 * is two answers waiting to disagree.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  showroomsTable,
  legalEntitiesTable,
  gstRegistrationsTable,
  type LegalEntityRow,
  type GstRegistrationRow,
} from "@workspace/db";

export type BranchRole = "HUB" | "SALES" | "SERVICE" | "PREMIUM";

/** A branch, and the two things above it. Everything Finance needs to post. */
export interface Placement {
  branchId: number;
  branchCode: string;
  branchName: string;
  role: BranchRole;
  entity: LegalEntityRow;
  registration: GstRegistrationRow;
}

/**
 * The refusal, and it is deliberately loud.
 *
 * A branch with no entity cannot be invoiced from, because the invoice would
 * carry no legal name and no GSTIN and would not be a tax invoice. Guessing —
 * taking the owner's only entity, say — is exactly the kind of helpfulness that
 * produces a document nobody can defend, so this throws rather than defaults.
 * The migration is what makes it never happen; this is what proves the
 * migration ran.
 */
export class UnplacedBranchError extends Error {
  constructor(public readonly showroomId: number, what: string) {
    super(
      `Outlet ${showroomId} has no ${what}. Every branch belongs to a legal entity and ` +
        `invoices under a GST registration; until it does, nothing may be issued from it.`,
    );
    this.name = "UnplacedBranchError";
  }
}

/** Where one branch sits. Throws rather than guessing. */
export async function placementOf(showroomId: number): Promise<Placement> {
  const [row] = await db
    .select({
      branchId: showroomsTable.id,
      branchCode: showroomsTable.code,
      branchName: showroomsTable.name,
      role: showroomsTable.role,
      entityId: showroomsTable.entityId,
      registrationId: showroomsTable.registrationId,
    })
    .from(showroomsTable)
    .where(eq(showroomsTable.id, showroomId))
    .limit(1);

  if (!row) throw new UnplacedBranchError(showroomId, "record at all");
  if (!row.entityId) throw new UnplacedBranchError(showroomId, "legal entity");
  if (!row.registrationId) throw new UnplacedBranchError(showroomId, "GST registration");

  const [entity] = await db
    .select()
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.id, row.entityId))
    .limit(1);
  const [registration] = await db
    .select()
    .from(gstRegistrationsTable)
    .where(eq(gstRegistrationsTable.id, row.registrationId))
    .limit(1);

  if (!entity) throw new UnplacedBranchError(showroomId, "legal entity that exists");
  if (!registration) throw new UnplacedBranchError(showroomId, "GST registration that exists");

  return {
    branchId: row.branchId,
    branchCode: row.branchCode,
    branchName: row.branchName,
    role: row.role as BranchRole,
    entity,
    registration,
  };
}

/**
 * Every branch under one entity, which is the scope of a trial balance.
 *
 * A caller asking for the books of a company gets the branches, not the other
 * way round. Sorting is by code so two runs of the same report list them the
 * same way — a report whose rows move between runs is one nobody trusts.
 */
export async function branchesOfEntity(entityId: number): Promise<number[]> {
  const rows = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.entityId, entityId))
    .orderBy(showroomsTable.code);
  return rows.map((r) => r.id);
}

/** Every branch under one registration, which is the scope of a return. */
export async function branchesOfRegistration(registrationId: number): Promise<number[]> {
  const rows = await db
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.registrationId, registrationId))
    .orderBy(showroomsTable.code);
  return rows.map((r) => r.id);
}

/** Every legal entity an owner holds. Two means two sets of books. */
export async function entitiesOf(ownerId: number): Promise<LegalEntityRow[]> {
  return db
    .select()
    .from(legalEntitiesTable)
    .where(and(eq(legalEntitiesTable.ownerId, ownerId), eq(legalEntitiesTable.isActive, "Y")))
    .orderBy(legalEntitiesTable.code);
}

/** Every registration under one entity. Two means two states. */
export async function registrationsOf(entityId: number): Promise<GstRegistrationRow[]> {
  return db
    .select()
    .from(gstRegistrationsTable)
    .where(
      and(eq(gstRegistrationsTable.entityId, entityId), eq(gstRegistrationsTable.isActive, "Y")),
    )
    .orderBy(gstRegistrationsTable.gstin);
}

/**
 * Whether moving stock between two branches is a supply (R-117).
 *
 * **The structure decides, and nothing asks a person.** Same registration is
 * the ordinary hub-to-satellite move: same legal person, same GSTIN, so no tax
 * invoice and no GST — a delivery challan under Rule 55 with a stock transfer
 * note, and the chassis simply changes branch. A different registration is a
 * taxable supply even between two branches of the same company, because GST
 * treats distinct registrations as distinct persons.
 *
 * Getting this backwards is expensive in both directions: charging tax on an
 * internal move inflates output tax and the return, and *not* charging it on a
 * cross-state move is tax short-paid. So it is derived from the two placements
 * and never from a checkbox.
 */
export function transferIsSupply(from: Placement, to: Placement): {
  isSupply: boolean;
  interState: boolean;
  why: string;
} {
  if (from.registration.id === to.registration.id) {
    return {
      isSupply: false,
      interState: false,
      why:
        `Both branches invoice under ${from.registration.gstin}, so this is one legal person ` +
        `moving its own stock. A delivery challan and a stock transfer note, no tax invoice ` +
        `and no GST.`,
    };
  }
  const interState = from.registration.state !== to.registration.state;
  return {
    isSupply: true,
    interState,
    why:
      `${from.registration.gstin} and ${to.registration.gstin} are distinct registrations, which ` +
      `GST treats as distinct persons. This is a taxable supply` +
      (interState
        ? ` between ${from.registration.state} and ${to.registration.state}, so IGST.`
        : ` within ${from.registration.state}, so CGST and SGST.`),
  };
}

/**
 * Whether this entity has to register a B2B invoice on the IRP (R-118).
 *
 * Above five crore aggregate turnover a B2B invoice must carry an IRN and a QR
 * code or it is not a valid tax invoice. Most of a dealership's sales are B2C
 * and need none, which is the relief — this gates a path rather than every
 * document. Above ten crore there is a thirty-day reporting window from the
 * invoice date, which is a different thing and is returned separately.
 */
export function eInvoicing(entity: LegalEntityRow): {
  required: boolean;
  reportingWindowDays: number | null;
} {
  const aato = entity.aatoCrore === null ? null : Number(entity.aatoCrore);
  if (aato === null || !Number.isFinite(aato)) {
    return { required: false, reportingWindowDays: null };
  }
  return {
    required: aato > 5,
    reportingWindowDays: aato > 10 ? 30 : null,
  };
}

/** Placements for several branches at once, keyed by branch id. */
export async function placementsFor(showroomIds: number[]): Promise<Map<number, Placement>> {
  const out = new Map<number, Placement>();
  if (showroomIds.length === 0) return out;

  const branches = await db
    .select({
      branchId: showroomsTable.id,
      branchCode: showroomsTable.code,
      branchName: showroomsTable.name,
      role: showroomsTable.role,
      entityId: showroomsTable.entityId,
      registrationId: showroomsTable.registrationId,
    })
    .from(showroomsTable)
    .where(inArray(showroomsTable.id, showroomIds));

  const entityIds = [...new Set(branches.map((b) => b.entityId).filter((n): n is number => !!n))];
  const regIds = [
    ...new Set(branches.map((b) => b.registrationId).filter((n): n is number => !!n)),
  ];

  const entities = entityIds.length
    ? await db.select().from(legalEntitiesTable).where(inArray(legalEntitiesTable.id, entityIds))
    : [];
  const regs = regIds.length
    ? await db
        .select()
        .from(gstRegistrationsTable)
        .where(inArray(gstRegistrationsTable.id, regIds))
    : [];

  const byEntity = new Map(entities.map((e) => [e.id, e]));
  const byReg = new Map(regs.map((r) => [r.id, r]));

  for (const b of branches) {
    const entity = b.entityId ? byEntity.get(b.entityId) : undefined;
    const registration = b.registrationId ? byReg.get(b.registrationId) : undefined;
    // Silently skipped rather than thrown: a caller asking for many branches is
    // drawing a report, and one unplaced outlet should not blank the page. The
    // single-branch resolver is where issuing a document goes through, and that
    // one refuses.
    if (!entity || !registration) continue;
    out.set(b.branchId, {
      branchId: b.branchId,
      branchCode: b.branchCode,
      branchName: b.branchName,
      role: b.role as BranchRole,
      entity,
      registration,
    });
  }
  return out;
}
