/**
 * What the dealership already had on the day it started with us (OBJ-38).
 *
 * A set of books that begins at zero on a Tuesday in October says the
 * dealership owns no stock, is owed nothing and owes nobody — which is false
 * about every business that has ever existed. The opening balance is how a real
 * one starts, and getting it wrong makes every report afterwards wrong by a
 * constant nobody can find later.
 *
 * ## One voucher, dated the day before the books open
 *
 * Dated `booksFrom - 1 day` rather than `booksFrom`, so that a trial balance
 * drawn *for* the first period shows the opening as brought forward rather than
 * as a transaction inside the period. A CA reading a P&L that included the
 * opening stock as a purchase would be reading a fiction.
 *
 * ## It has to balance, and the plug is named
 *
 * Assets brought in less liabilities brought in is the owner's capital, by
 * definition. Rather than ask a dealership to state its capital and then refuse
 * when the arithmetic disagrees, this **derives** it and says so — which is
 * both what an accountant would do on a fresh set of books and the only version
 * where the entry cannot fail to balance. The narration says the figure was
 * derived, because a capital account nobody typed should not look like one
 * somebody did.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  vouchersTable,
  voucherLinesTable,
  partiesTable,
  partyBillsTable,
  legalEntitiesTable,
  type LegalEntityRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { accountsByCode, ensureChart } from "./accounts";
import { financialYearOf, nextVoucherNo, type Line, type PostResult } from "./post";
import { branchesOfEntity } from "../org";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const money = (v: number): string => v.toFixed(2);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** The day before the books open, which is where an opening balance is dated. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface OpeningInput {
  /** Stock on the floor at cost, and cash and bank as counted. */
  vehicleStock?: number;
  sparePartsStock?: number;
  cash?: number;
  bank?: number;
  /** Tax already paid and not yet set off, which is a real asset. */
  inputCreditCarried?: number;
}

/**
 * Bring in one entity's opening position.
 *
 * Party balances are read from the party rows themselves rather than passed in,
 * because a debtor with an opening balance and no ledger row is a number nobody
 * can chase. The onboarding that types those balances creates the parties, and
 * this totals what it finds.
 *
 * Idempotent on `(OPENING_BALANCE, entityId)` through the same partial unique
 * index every other posting uses.
 */
export async function postOpeningBalances(input: {
  ownerId: number;
  entityId: number;
  amounts: OpeningInput;
  userId?: number | null;
}): Promise<PostResult & { capital?: number }> {
  const warnings: string[] = [];

  const [entity] = await db
    .select()
    .from(legalEntitiesTable)
    .where(
      and(
        eq(legalEntitiesTable.ownerId, input.ownerId),
        eq(legalEntitiesTable.id, input.entityId),
      ),
    );
  if (!entity) return { ok: false, error: `No legal entity ${input.entityId}`, warnings };
  if (!entity.booksFrom) {
    return {
      ok: false,
      error:
        `${entity.legalName} has no start date on its books, so there is no day for an opening ` +
        "balance to sit on. Set one before bringing balances in.",
      warnings,
    };
  }

  const branches = await branchesOfEntity(input.entityId);
  if (branches.length === 0) {
    return { ok: false, error: `${entity.legalName} has no branches.`, warnings };
  }

  await ensureChart(input.ownerId);
  const accounts = await accountsByCode(input.ownerId);
  const need = (code: string) => {
    const a = accounts.get(code);
    if (!a) throw new Error(`The ledger account ${code} is missing for this dealership.`);
    return a;
  };

  const openingDate = dayBefore(entity.booksFrom);
  const lines: Line[] = [];

  const a = input.amounts;
  for (const [code, amount, label] of [
    ["1200", a.vehicleStock ?? 0, "Vehicles on the floor at cost"],
    ["1210", a.sparePartsStock ?? 0, "Spare parts at cost"],
    ["1400", a.cash ?? 0, "Cash in hand"],
    ["1500", a.bank ?? 0, "Bank balances"],
    ["1620", a.inputCreditCarried ?? 0, "Input tax carried forward"],
  ] as const) {
    if (amount > 0) lines.push({ accountCode: code, debit: round2(amount), credit: 0, narration: label });
  }

  /*
   * Party balances, one line each, so the subsidiary ledger opens with them.
   *
   * A single lump on `1100` would balance and would be useless: the debtors
   * report would show one figure nobody can ring up about, and the first
   * receipt would have no bill to settle. Every opening debtor gets a bill for
   * the same reason a sale does (R-111).
   */
  const parties = await db
    .select()
    .from(partiesTable)
    .where(
      and(
        eq(partiesTable.entityId, input.entityId),
        sql`${partiesTable.openingAmount}::numeric > 0`,
      ),
    );

  for (const p of parties) {
    const amount = round2(n(p.openingAmount));
    const side = p.openingSide;
    if (!side || amount <= 0) continue;

    // A debit balance belongs on the debtors control, a credit on creditors —
    // whatever the party is called. A supplier we have paid in advance is a
    // debtor for that money, and calling it a creditor would net two real
    // positions into one that is neither.
    const code = side === "DEBIT" ? "1100" : "2100";
    lines.push({
      accountCode: code,
      debit: side === "DEBIT" ? amount : 0,
      credit: side === "CREDIT" ? amount : 0,
      narration: `Opening balance — ${p.name}`,
      partyId: p.id,
      partyName: p.name,
      partyGstin: p.gstin,
    });

    await db
      .insert(partyBillsTable)
      .values({
        ownerId: input.ownerId,
        partyId: p.id,
        showroomId: branches[0]!,
        direction: side === "DEBIT" ? "RECEIVABLE" : "PAYABLE",
        billNo: `OPENING/${p.id}`,
        billDate: openingDate,
        amount: money(amount),
        outstanding: money(amount),
        sourceKind: "OPENING",
        sourceId: p.id,
      })
      .onConflictDoNothing();
  }

  /*
   * Capital is the difference, by definition, and the narration says so.
   *
   * Asking a dealership to state its capital and then refusing when the
   * arithmetic disagrees would be asking it to reconcile our arithmetic for us.
   * Deriving it is what an accountant does on a fresh set of books, and it is
   * the only version where the opening entry cannot fail to balance.
   */
  const debits = round2(lines.reduce((s, l) => s + l.debit, 0));
  const credits = round2(lines.reduce((s, l) => s + l.credit, 0));
  const capital = round2(debits - credits);

  if (capital > 0) {
    lines.push({
      accountCode: "3100",
      debit: 0,
      credit: capital,
      narration: "Owner's capital — derived as the difference, not stated",
    });
  } else if (capital < 0) {
    // Liabilities brought in exceed assets brought in. Lawful and worth saying
    // out loud rather than burying: a business can be carrying accumulated
    // losses, and a dealership seeing this figure should recognise it.
    lines.push({
      accountCode: "3100",
      debit: -capital,
      credit: 0,
      narration: "Accumulated deficit brought forward — derived as the difference",
    });
    warnings.push(
      "The liabilities brought in exceed the assets brought in, so the capital account opens with a debit balance. That is accumulated losses carried forward, and it is worth checking the figures before it goes onto a balance sheet.",
    );
  }

  if (lines.length === 0) {
    return { ok: false, error: "Nothing to bring in — every opening figure is zero.", warnings };
  }

  const fy = financialYearOf(openingDate);
  const voucherNo = await nextVoucherNo(input.ownerId, "JOURNAL", fy);
  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));

  try {
    const [voucher] = await db
      .insert(vouchersTable)
      .values({
        ownerId: input.ownerId,
        showroomId: branches[0]!,
        kind: "JOURNAL",
        voucherNo,
        voucherDate: openingDate,
        financialYear: fy,
        narration: `Opening balances — ${entity.legalName} as at ${openingDate}`,
        sourceKind: "OPENING_BALANCE",
        sourceId: input.entityId,
        totalDebit: money(totalDebit),
        totalCredit: money(totalCredit),
        warnings,
        postedByUserId: input.userId ?? null,
      })
      .returning();

    await db.insert(voucherLinesTable).values(
      lines.map((l, i) => {
        const acc = need(l.accountCode);
        return {
          voucherId: voucher!.id,
          seq: i + 1,
          accountId: acc.id,
          accountCode: acc.code,
          accountName: acc.name,
          debit: money(l.debit),
          credit: money(l.credit),
          narration: l.narration ?? null,
          partyId: l.partyId ?? null,
          partyName: l.partyName ?? null,
          partyGstin: l.partyGstin ?? null,
        };
      }),
    );

    logger.info(
      { ownerId: input.ownerId, entityId: input.entityId, voucherNo, capital },
      "Opening balances brought in",
    );
    return { ok: true, voucher: voucher!, warnings, capital };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "23505") {
      return {
        ok: false,
        error:
          `${entity.legalName} already has its opening balances brought in. Changing them means reversing that voucher and posting again — an opening balance that can be edited is one that has quietly moved every report since.`,
        warnings,
      };
    }
    throw err;
  }
}

/** Whether this entity has had its opening balances brought in. */
export async function hasOpeningBalances(
  ownerId: number,
  entityId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: vouchersTable.id })
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, ownerId),
        eq(vouchersTable.sourceKind, "OPENING_BALANCE"),
        eq(vouchersTable.sourceId, entityId),
        eq(vouchersTable.status, "POSTED"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export type { LegalEntityRow };
