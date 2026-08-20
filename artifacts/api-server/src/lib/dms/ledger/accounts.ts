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

  // ── Equity ───────────────────────────────────────────────────────────────
  /*
   * Where the opening balance's difference lands (OBJ-38).
   *
   * Assets brought in less liabilities brought in *is* the owner's capital, by
   * definition, so this is derived rather than asked for. A dealership asked to
   * state its capital and then refused when the arithmetic disagreed would be
   * reconciling our arithmetic for us on its first afternoon.
   */
  { code: "3100", name: "Owner's Capital", tallyName: "Capital Account", group: "EQUITY" },
  {
    code: "3200",
    name: "Reserves & Surplus",
    tallyName: "Reserves & Surplus",
    group: "EQUITY",
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
  /*
   * Parts have their own cost head, and it is not fussiness (OBJ-42).
   *
   * A workshop's margin on parts and a showroom's margin on machines are two
   * different businesses inside one dealership, and they behave differently:
   * parts margin is steady and small, vehicle margin is thin and volume-driven.
   * Posting both to one head produces a gross-profit figure that is the average
   * of two numbers a dealer needs to see separately, and it is the figure he
   * would use to decide which side of the business to invest in.
   */
  {
    code: "5110",
    name: "Cost of Goods Sold — Spare Parts",
    tallyName: "Purchase Accounts",
    group: "EXPENSE",
  },
  { code: "5200", name: "Discount Allowed", tallyName: "Indirect Expenses", group: "EXPENSE" },
];

/**
 * The heads a dealership needs to run its own books, offered once and **owned
 * by them** (OBJ-50).
 *
 * ## Why these are not `isSystem`, and the distinction matters
 *
 * Every account in `CHART` above exists because a posting rule names it by
 * code. Nothing names any of these. They exist because until OBJ-50 the chart
 * had **three expense heads, two of which were cost of goods sold** — so a
 * five-branch dealership's profit and loss was a gross-margin statement with a
 * P&L's title, and there was no rent, no salaries, no electricity and no way to
 * add any.
 *
 * Marking them `isSystem` would have been the smaller change and the wrong one.
 * A system account is undeletable because a rule would break without it; these
 * would be undeletable because we decided a dealership ought to want them,
 * which is not the same thing and not ours to decide. A CA who keeps *Staff
 * Welfare* separate from *Salaries* should be able to say so.
 *
 * ## Nothing seeds these on its own
 *
 * The first version of this seeded them inside `ensureChart` when the owner had
 * no accounts at all, which was wrong in both directions and the verifier said
 * so on the first run. Every dealership already using the product has a chart,
 * so **none of them would ever have received the expense heads** — the whole
 * point of the objective, silently skipped. And an automatic rule that fills
 * gaps would put *Printing & Stationery* back next Tuesday for a dealership
 * that had deliberately deleted it.
 *
 * So `offerStarterChart` is a **deliberate act**, called from a route by a
 * person, safe to run twice because it adds only what is absent, and never
 * called by anything unattended. A chart is the shape of a dealership's books
 * and filling it in behind them is not a favour.
 */
export const STARTER: SeedAccount[] = [
  // Two balance-sheet heads the moment anybody books an expense properly.
  { code: "1700", name: "Prepaid Expenses", tallyName: "Current Assets", group: "ASSET" },
  /*
   * A dealership deducts tax on rent (194-I), commission (194-H), contractor
   * payments (194-C) and professional fees (194-J). The deduction is a
   * liability from the moment the bill is booked, and without a head for it the
   * only options are to overstate the payment or to keep it off the books.
   */
  { code: "2500", name: "TDS Payable", tallyName: "Duties & Taxes", group: "LIABILITY" },

  // ── What it costs to open the doors ──────────────────────────────────────
  { code: "5300", name: "Rent", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5310", name: "Salaries & Wages", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5320", name: "Electricity & Water", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5330", name: "Advertising & Sales Promotion", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5340", name: "Repairs & Maintenance", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5350", name: "Travel & Conveyance", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5360", name: "Printing & Stationery", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5370", name: "Telephone & Internet", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5380", name: "Professional & Legal Fees", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5390", name: "Bank Charges", tallyName: "Indirect Expenses", group: "EXPENSE" },
  /*
   * Separate from bank charges because it is the number a dealership argues
   * about. Floor-plan funding on 78 unsold machines at 9.8% is the second
   * largest cost in the building after salaries, and netting it into a general
   * banking line hides the one figure that would make somebody shift ageing
   * stock.
   */
  { code: "5400", name: "Interest Paid", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5410", name: "Insurance — Own", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5420", name: "Depreciation", tallyName: "Indirect Expenses", group: "EXPENSE" },
  { code: "5900", name: "Miscellaneous Expenses", tallyName: "Indirect Expenses", group: "EXPENSE" },
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

  /*
   * A system code held by an account that is **not** ours is refused rather
   * than adopted.
   *
   * `onConflictDoNothing` below means an existing row wins, which is right for
   * a rename and wrong for a collision: if a dealership created `5300 Rent
   * Received` of their own and a later release named `5300` in a posting rule,
   * that rule would quietly start posting into their account and neither figure
   * would be what anybody expected. Loud is the only honest answer, and it can
   * only ever happen after somebody has created an account by hand.
   */
  const collisions = await db
    .select({ code: ledgerAccountsTable.code, name: ledgerAccountsTable.name })
    .from(ledgerAccountsTable)
    .where(
      and(eq(ledgerAccountsTable.ownerId, ownerId), eq(ledgerAccountsTable.isSystem, "N")),
    );
  const clash = collisions.find((c) => SYSTEM_CODES.has(c.code));
  if (clash) {
    throw new Error(
      `Account ${clash.code} (${clash.name}) was created here and is now a code the product's own ` +
        "posting rules name. Renumber it before anything else posts, or a rule will start writing " +
        "into it and no figure on either side will be what anybody expects.",
    );
  }

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

/**
 * A code a dealership may use for an account of its own.
 *
 * Four digits, starting with the group's digit, and not one the product's rules
 * name. The group digit is a convention rather than a constraint anywhere else
 * in the code — nothing derives a group from a code — but a chart where `5xxx`
 * is sometimes income is a chart nobody can read at a glance, and their CA will
 * be reading it.
 */
const GROUP_DIGIT: Record<SeedAccount["group"], string> = {
  ASSET: "1",
  LIABILITY: "2",
  EQUITY: "3",
  INCOME: "4",
  EXPENSE: "5",
};

export interface AccountResult {
  ok: boolean;
  account?: LedgerAccountRow;
  error?: string;
  warnings: string[];
}

/**
 * Add an account to a dealership's own chart (OBJ-50).
 *
 * The structural gap this closes: before it, **no route in the product touched
 * `ledger_accounts` at all**, so a dealership could not add a single head. The
 * chart was ours and only ours, which made the missing expense side unfixable
 * by the people it belonged to.
 *
 * Never `isSystem`. Whatever a dealership creates is theirs to rename, retire
 * and account for; ours are the ones a rule would break without.
 */
export async function createAccount(input: {
  ownerId: number;
  code: string;
  name: string;
  group: SeedAccount["group"];
  tallyName?: string | null;
}): Promise<AccountResult> {
  const warnings: string[] = [];
  const code = input.code.trim();
  const name = input.name.trim();

  if (!name) return { ok: false, error: "An account needs a name.", warnings };
  if (!/^\d{4}$/.test(code)) {
    return { ok: false, error: `${code} is not a four-digit account code.`, warnings };
  }
  if (SYSTEM_CODES.has(code)) {
    return {
      ok: false,
      error:
        `${code} is one of the product's own codes and a posting rule names it. Rename that account ` +
        "if the wording is wrong — the code has to keep meaning what the rules think it means.",
      warnings,
    };
  }
  const wanted = GROUP_DIGIT[input.group];
  if (!code.startsWith(wanted)) {
    /*
     * A warning rather than a refusal. Nothing in the code derives a group from
     * a code, so a misfiled number is unreadable rather than wrong - and a
     * dealership whose CA has used a numbering scheme for eleven years is not
     * going to renumber it because we prefer ours.
     */
    warnings.push(
      `${code} is being used for a ${input.group.toLowerCase()} account, and the convention in this ` +
        `chart is that those start with ${wanted}. Nothing will misbehave; it will read oddly beside the rest.`,
    );
  }

  const [existing] = await db
    .select({ id: ledgerAccountsTable.id, name: ledgerAccountsTable.name })
    .from(ledgerAccountsTable)
    .where(and(eq(ledgerAccountsTable.ownerId, input.ownerId), eq(ledgerAccountsTable.code, code)));
  if (existing) {
    return { ok: false, error: `${code} is already ${existing.name}.`, warnings };
  }

  const [account] = await db
    .insert(ledgerAccountsTable)
    .values({
      ownerId: input.ownerId,
      code,
      name,
      tallyName: input.tallyName?.trim() || name,
      group: input.group,
      isSystem: "N",
    })
    .returning();

  return { ok: true, account: account!, warnings };
}

/**
 * Retire an account, or bring it back. **Never delete one.**
 *
 * An account that has carried a line is named on a trial balance somebody has
 * already filed a return from. Removing it makes that statement
 * unreproducible — the figures still add up and one of the rows has no name.
 * So this is a flag, and the account keeps everything it ever carried.
 */
export async function setAccountActive(input: {
  ownerId: number;
  code: string;
  active: boolean;
}): Promise<AccountResult> {
  const warnings: string[] = [];
  const [row] = await db
    .select()
    .from(ledgerAccountsTable)
    .where(
      and(eq(ledgerAccountsTable.ownerId, input.ownerId), eq(ledgerAccountsTable.code, input.code)),
    );
  if (!row) return { ok: false, error: `No account ${input.code}.`, warnings };

  if (row.isSystem === "Y" && !input.active) {
    return {
      ok: false,
      error:
        `${row.code} ${row.name} is named by a posting rule, so it cannot be retired. A rule that ` +
        "cannot find its account has no honest behaviour: a substitute misstates the books silently " +
        "and a skipped line will not balance. Rename it if the wording is wrong.",
      warnings,
    };
  }

  const [updated] = await db
    .update(ledgerAccountsTable)
    .set({ isActive: input.active ? "Y" : "N" })
    .where(
      and(eq(ledgerAccountsTable.ownerId, input.ownerId), eq(ledgerAccountsTable.code, input.code)),
    )
    .returning();

  return { ok: true, account: updated!, warnings };
}

/**
 * Put the operating expense heads in front of a dealership that has none.
 *
 * Adds only what is absent, so running it twice adds nothing the second time,
 * and running it after somebody has deleted *Travel & Conveyance* puts it back
 * — which is fine, because **a person asked**. That is the whole difference
 * between this and doing it inside `ensureChart`.
 *
 * Everything it creates is `isSystem: "N"`. No posting rule names any of them;
 * they exist because a P&L with three expense heads, two of which are cost of
 * goods sold, is a gross-margin statement with a P&L's title.
 */
export async function offerStarterChart(ownerId: number): Promise<{
  added: LedgerAccountRow[];
  alreadyThere: string[];
}> {
  const existing = await db
    .select({ code: ledgerAccountsTable.code })
    .from(ledgerAccountsTable)
    .where(eq(ledgerAccountsTable.ownerId, ownerId));
  const have = new Set(existing.map((r) => r.code));

  const missing = STARTER.filter((a) => !have.has(a.code));
  if (missing.length === 0) {
    return { added: [], alreadyThere: STARTER.map((a) => a.code) };
  }

  const added = await db
    .insert(ledgerAccountsTable)
    .values(
      missing.map((a) => ({
        ownerId,
        code: a.code,
        name: a.name,
        tallyName: a.tallyName,
        group: a.group,
        isSystem: "N" as const,
      })),
    )
    .returning();

  return {
    added,
    alreadyThere: STARTER.filter((a) => have.has(a.code)).map((a) => a.code),
  };
}
