/**
 * A showroom's insurer panel, read from the database.
 *
 * The point of this file is that it returns `PanelEntry` — the *same* type the
 * mock dealer portal uses, from `@workspace/quoting/panel` — so quota,
 * eligibility and exclusion reasons are computed by one implementation rather
 * than two that drift. Before this, the panel existed only in the mock's
 * memory and the real server had no idea an insurer could be out of quota.
 *
 * `route` is not stored on the panel row. It is the DMS account's
 * `insuranceChannel`, and reading it from there is what keeps a broker
 * arrangement from being described one way on the account and another way on
 * every insurer hanging off it.
 */

import { and, asc, eq } from "drizzle-orm";
import {
  db,
  insurerPanelEntriesTable,
  providersTable,
  showroomDmsAccountsTable,
  showroomsTable,
} from "@workspace/db";
import { eligibility, quotaState, type PanelEntry } from "@workspace/quoting/panel";

export interface PanelEntryWithState extends PanelEntry {
  /** The `providers` row this maps to, so a caller can execute against it. */
  providerId: number;
  /** Which DMS account's arrangement this is. */
  dealerCode: string;
  quota: ReturnType<typeof quotaState>;
  /** Whether this insurer can take the next deal, and if not, why not. */
  eligible: boolean;
  reasons: string[];
}

/**
 * Every insurer this showroom can actually place business with.
 *
 * Returns entries for all active DMS accounts on the showroom. A showroom with
 * two brands has two arrangements and both appear, tagged by dealer code —
 * collapsing them would hide that a deal from one brand cannot be placed on the
 * other brand's panel.
 */
export async function panelForShowroom(
  showroomId: number,
): Promise<PanelEntryWithState[]> {
  const rows = await db
    .select({
      dealerCode: showroomDmsAccountsTable.dealerCode,
      insuranceChannel: showroomDmsAccountsTable.insuranceChannel,
      providerId: providersTable.id,
      providerCode: providersTable.code,
      providerName: providersTable.name,
      integration: insurerPanelEntriesTable.integration,
      odBaseRate: insurerPanelEntriesTable.odBaseRate,
      quotaPolicies: insurerPanelEntriesTable.quotaPolicies,
      quotaConsumed: insurerPanelEntriesTable.quotaConsumed,
      payoutRate: insurerPanelEntriesTable.payoutRate,
      slaMinutes: insurerPanelEntriesTable.slaMinutes,
      isEnabled: insurerPanelEntriesTable.isEnabled,
      providerActive: providersTable.isActive,
    })
    .from(insurerPanelEntriesTable)
    .innerJoin(
      showroomDmsAccountsTable,
      eq(showroomDmsAccountsTable.id, insurerPanelEntriesTable.dmsAccountId),
    )
    .innerJoin(
      showroomsTable,
      eq(showroomsTable.id, showroomDmsAccountsTable.showroomId),
    )
    .innerJoin(
      providersTable,
      eq(providersTable.id, insurerPanelEntriesTable.providerId),
    )
    .where(
      and(
        eq(showroomsTable.id, showroomId),
        eq(showroomDmsAccountsTable.isActive, true),
      ),
    )
    .orderBy(asc(showroomDmsAccountsTable.dealerCode), asc(providersTable.code));

  return rows.map((r) => {
    const entry: PanelEntry = {
      insurerCode: r.providerCode,
      insurerName: r.providerName,
      shortName: r.providerName.replace(/ General Insurance.*$/i, ""),
      // An account with no channel recorded is a configuration gap. Treated as
      // a direct agency because that is the narrower claim — asserting BROKER
      // would imply reach the dealer may not have.
      route: r.insuranceChannel === "BROKER" ? "BROKER" : "DIRECT_AGENT",
      integration: r.integration,
      odBaseRate: r.odBaseRate,
      quotaPolicies: r.quotaPolicies,
      quotaConsumed: r.quotaConsumed,
      payoutRate: r.payoutRate,
      // An insurer switched off globally cannot be placed through any panel,
      // however the dealer's own arrangement is set.
      isEnabled: r.isEnabled && r.providerActive,
      slaMinutes: r.slaMinutes,
    };

    const { eligible, reasons } = eligibility(entry);
    return {
      ...entry,
      providerId: r.providerId,
      dealerCode: r.dealerCode,
      quota: quotaState(entry),
      eligible,
      reasons,
    };
  });
}
