/**
 * Dealer code → showroom → owner.
 *
 * The OEM's dealer code is *their* identifier for an outlet. Ours is a
 * showroom, and a showroom is not the same thing: one owner may sell two
 * brands from one address (two dealer codes, one showroom), or one brand from
 * three outlets (one code family, three showrooms), and a service centre has
 * no dealer code at all. So the mapping lives in its own table and this is the
 * one place that walks it.
 *
 * Kept out of the adapter on purpose. An adapter translates a wire format and
 * should not touch the database; who a deal belongs to is a fact about our
 * tenancy, not about Hero's data model. Keeping the split means a second OEM
 * adapter inherits tenant resolution for free.
 *
 * This is also the seam a future auth layer plugs into: today a caller says
 * which deal it wants and we work out the owner; tomorrow the caller's identity
 * says which owner, and the deal has to fall inside it.
 */

import { eq } from "drizzle-orm";
import { db, showroomsTable, showroomDmsAccountsTable, ownersTable } from "@workspace/db";

export interface DmsTenant {
  showroomId: number;
  showroomCode: string;
  showroomName: string;
  ownerId: number;
  ownerCode: string;
  ownerName: string;
  /** How this showroom reaches insurers for deals from this DMS account. */
  insuranceChannel: "BROKER" | "DIRECT_AGENT" | null;
}

/**
 * Resolve an OEM dealer code to the showroom and owner it belongs to.
 *
 * Returns null when the code is not mapped. That is a **configuration gap, not
 * an error** — a deal legitimately exists in a DMS the operator has not linked
 * to a showroom yet — so the caller reports it and carries on rather than
 * failing the pull or inventing an owner.
 */
export async function resolveTenantByDealerCode(
  dealerCode: string,
): Promise<DmsTenant | null> {
  const [row] = await db
    .select({
      showroomId: showroomsTable.id,
      showroomCode: showroomsTable.code,
      showroomName: showroomsTable.name,
      showroomActive: showroomsTable.isActive,
      ownerId: ownersTable.id,
      ownerCode: ownersTable.code,
      ownerName: ownersTable.name,
      ownerActive: ownersTable.isActive,
      insuranceChannel: showroomDmsAccountsTable.insuranceChannel,
      accountActive: showroomDmsAccountsTable.isActive,
    })
    .from(showroomDmsAccountsTable)
    .innerJoin(
      showroomsTable,
      eq(showroomsTable.id, showroomDmsAccountsTable.showroomId),
    )
    .innerJoin(ownersTable, eq(ownersTable.id, showroomsTable.ownerId))
    .where(eq(showroomDmsAccountsTable.dealerCode, dealerCode));

  if (!row) return null;

  // A deactivated link, showroom or owner is treated the same as an unmapped
  // code. Returning the tenant anyway would let a disabled outlet keep writing
  // applications, which is exactly what deactivating it was meant to stop.
  if (!row.accountActive || !row.showroomActive || !row.ownerActive) return null;

  return {
    showroomId: row.showroomId,
    showroomCode: row.showroomCode,
    showroomName: row.showroomName,
    ownerId: row.ownerId,
    ownerCode: row.ownerCode,
    ownerName: row.ownerName,
    insuranceChannel: row.insuranceChannel,
  };
}
