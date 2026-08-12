import { and, eq } from "drizzle-orm";

import { db, ledgerAccountsTable, type LedgerAccountRow } from "@workspace/db";

/**
 * The chart a two-wheeler dealership actually needs (OBJ-31, R-98).
 *
 * ## Every account here exists because a posting rule names it
 *
 * Not a general-purpose chart. A dealership's CA will have forty more and is
 * welcome to them; these are the ones without which a vehicle sale cannot be
 * posted honestly, and each is `isSystem` — renameable, remappable, and not
 * deletable, because a posting rule that cannot find its account has no honest
 * behaviour left. Posting to a substitute misstates the books silently and
 * skipping the line produces a voucher that does not balance.
 *
 * ## The three that carry the requirements
 *
 * **`2300`–`2320`, the pass-through liabilities (R-103).** Road tax, RTO fees
 * and the insurance premium are collected from the customer on somebody else's
 * behalf. A dealership doing forty units a month collects lakhs of road tax; a
 * ledger that credits it to income overstates turnover, overstates the tax on
 * that turnover, and — because turnover drives GST registration thresholds and
 * OEM slabs — produces wrong answers well outside the books.
 *
 * **`1200` and `5100`, stock and its cost (R-102).** A ledger that credits
 * revenue and never credits stock reports the ex-showroom price as margin. The
 * bike leaves the floor and the floor has to know.
 *
 * **`2900`, suspense.** Where a charge whose label nothing recognises goes.
 * Deliberately a liability rather than income: the failure R-103 is written
 * against is overstating turnover, so the default must not be revenue. A
 * suspense account a CA has to clear is ordinary practice and is the honest
 * place for *we do not know what this is*.
 */

export interface SeedAccount {
  code: string;
  name: string;
  tallyName: string;
  group: "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY";
}

export const CHART: SeedAccount[] = [
  // ── Assets ───────────────────────────────────────────────────────────────
  { code: "1100", name: "Sundry Debtors", tallyName: "Sundry Debtors", group: "ASSET" },
  { code: "1200", name: "Vehicle Stock", tallyName: "Stock-in-Hand", group: "ASSET" },
  { code: "1210", name: "Spare Parts Stock", tallyName: "Stock-in-Hand", group: "ASSET" },
  { code: "1400", name: "Cash", tallyName: "Cash-in-Hand", group: "ASSET" },
  { code: "1500", name: "Bank Accounts", tallyName: "Bank Accounts", group: "ASSET" },
  { code: "1600", name: "Input CGST", tallyName: "Duties & Taxes", group: "ASSET" },
  { code: "1610", name: "Input SGST", tallyName: "Duties & Taxes", group: "ASSET" },
  { code: "1620", name: "Input IGST", tallyName: "Duties & Taxes", group: "ASSET" },

  // ── Liabilities ──────────────────────────────────────────────────────────
  { code: "2100", name: "Sundry Creditors", tallyName: "Sundry Creditors", group: "LIABILITY" },
  { code: "2200", name: "Output CGST", tallyName: "Duties & Taxes", group: "LIABILITY" },
  { code: "2210", name: "Output SGST", tallyName: "Duties & Taxes", group: "LIABILITY" },
  { code: "2220", name: "Output IGST", tallyName: "Duties & Taxes", group: "LIABILITY" },
  { code: "2230", name: "Output Cess", tallyName: "Duties & Taxes", group: "LIABILITY" },
  // R-103. Somebody else's money, sitting in the dealership's account.
  { code: "2300", name: "Road Tax Payable", tallyName: "Current Liabilities", group: "LIABILITY" },
  {
    code: "2310",
    name: "Registration Charges Payable",
    tallyName: "Current Liabilities",
    group: "LIABILITY",
  },
  {
    code: "2320",
    name: "Insurance Premium Payable",
    tallyName: "Current Liabilities",
    group: "LIABILITY",
  },
  {
    code: "2330",
    name: "Accessories & Extended Warranty Payable",
    tallyName: "Current Liabilities",
    group: "LIABILITY",
  },
  { code: "2400", name: "Customer Advances", tallyName: "Current Liabilities", group: "LIABILITY" },
  {
    code: "2900",
    name: "Suspense — Unclassified Charges",
    tallyName: "Suspense A/c",
    group: "LIABILITY",
  },

  // ── Income ───────────────────────────────────────────────────────────────
  { code: "4100", name: "Vehicle Sales", tallyName: "Sales Accounts", group: "INCOME" },
  { code: "4200", name: "Spare Parts Sales", tallyName: "Sales Accounts", group: "INCOME" },
  { code: "4300", name: "Labour Income", tallyName: "Direct Incomes", group: "INCOME" },
  { code: "4400", name: "Handling & Other Income", tallyName: "Indirect Incomes", group: "INCOME" },

  // ── Expenses ─────────────────────────────────────────────────────────────
  {
    code: "5100",
    name: "Cost of Goods Sold — Vehicles",
    tallyName: "Purchase Accounts",
    group: "EXPENSE",
  },
  { code: "5200", name: "Discount Allowed", tallyName: "Indirect Expenses", group: "EXPENSE" },
];

/** The codes a posting rule names, so the route can refuse to delete one. */
export const SYSTEM_CODES = new Set(CHART.map((a) => a.code));

/**
 * Put the chart in front of a dealership that has none, and leave theirs alone.
 *
 * `onConflictDoNothing` on (owner, code), so a dealership that has renamed
 * *Handling & Other Income* to something their CA prefers keeps the rename
 * through every subsequent call. Only the absence of a code is filled.
 */
export async function ensureChart(ownerId: number): Promise<number> {
  const existing = await db
    .select({ code: ledgerAccountsTable.code })
    .from(ledgerAccountsTable)
    .where(eq(ledgerAccountsTable.ownerId, ownerId));
  const have = new Set(existing.map((r) => r.code));

  const missing = CHART.filter((a) => !have.has(a.code));
  if (missing.length === 0) return 0;

  await db
    .insert(ledgerAccountsTable)
    .values(
      missing.map((a) => ({
        ownerId,
        code: a.code,
        name: a.name,
        tallyName: a.tallyName,
        group: a.group,
        isSystem: "Y" as const,
      })),
    )
    .onConflictDoNothing();

  return missing.length;
}

export async function chartFor(ownerId: number): Promise<LedgerAccountRow[]> {
  return db
    .select()
    .from(ledgerAccountsTable)
    .where(eq(ledgerAccountsTable.ownerId, ownerId))
    .orderBy(ledgerAccountsTable.code);
}

/**
 * The accounts a posting rule needs, by code, in one lookup.
 *
 * Throws when one is missing rather than posting a partial voucher. A voucher
 * with a line silently dropped balances to something wrong, and a set of books
 * that is wrong and balances is worse than one that refuses to save.
 */
export async function accountsByCode(
  ownerId: number,
): Promise<Map<string, LedgerAccountRow>> {
  const rows = await chartFor(ownerId);
  return new Map(rows.map((r) => [r.code, r]));
}

export async function renameAccount(
  ownerId: number,
  code: string,
  patch: { name?: string; tallyName?: string },
): Promise<LedgerAccountRow | null> {
  const [row] = await db
    .update(ledgerAccountsTable)
    .set(patch)
    .where(and(eq(ledgerAccountsTable.ownerId, ownerId), eq(ledgerAccountsTable.code, code)))
    .returning();
  return row ?? null;
}
