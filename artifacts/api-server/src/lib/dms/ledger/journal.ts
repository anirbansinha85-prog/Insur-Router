/**
 * A journal voucher — the door everything on the cost side needs (OBJ-50).
 *
 * ## What was missing, stated plainly
 *
 * Seven things could reach the ledger: a sale, a purchase of stock, a receipt,
 * a payment, an opening balance, a service invoice, and a cross-registration
 * transfer. Every one of them starts from a **document DDMS itself issued**.
 *
 * So there was no way to book anything that is not a document: the month's
 * rent, a salary run, an accrual, a provision, a depreciation charge, a
 * reclassification a CA asks for in March. `JOURNAL` was already in the voucher
 * kind enum and only two things wrote it — the opening balance run and a
 * reversal — neither of which a person can raise.
 *
 * The consequence was not subtle. The chart had **three expense heads, two of
 * them cost of goods sold**, so a five-branch dealership's profit and loss was
 * a gross-margin statement with a P&L's title. Adding the heads without adding
 * this would have produced a longer chart nobody could post to.
 *
 * ## What it deliberately is not
 *
 * **Not an edit control on the books.** `/books` has none and will not get one.
 * A journal is a new voucher, numbered from the same gapless series, and a
 * mistake in one is corrected the way every other mistake is: reverse it and
 * post another. Nothing here updates a voucher that already exists.
 *
 * **Not a way around a locked period.** The database trigger refuses an insert
 * into locked books and this catches its sentence rather than restating it —
 * one refusal, in one place, whatever raised the entry.
 *
 * **Not somewhere a model goes** (R-100). Every rule below is a comparison
 * against a stored value. What the entry *means* is the person's; whether it is
 * a legal entry is arithmetic.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  ledgerAccountsTable,
  vouchersTable,
  voucherLinesTable,
  partiesTable,
  type VoucherRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { ensureChart } from "./accounts";
import { financialYearOf, nextVoucherNo } from "./post";

const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const money = (v: number): string => v.toFixed(2);

/**
 * The control accounts, and why a journal line against one needs a party.
 *
 * `1100` and `2100` are control accounts: the balance on each is meant to equal
 * the sum of the party ledgers under it, which is what `controlAccountCheck`
 * asserts and what makes a customer statement possible at all. A journal line
 * that debits Sundry Debtors with nobody's name against it balances the voucher
 * and puts money on a control account that reconciles to nothing.
 *
 * **Warned rather than refused**, because the honest exception exists: a
 * provision for doubtful debts is a real entry against the control account that
 * belongs to no single customer. So the product names the consequence and lets
 * the person decide, and the third reconciliation is where it surfaces.
 */
const CONTROL_ACCOUNTS = new Set(["1100", "2100"]);

export interface JournalLineInput {
  accountCode: string;
  debit?: number;
  credit?: number;
  narration?: string | null;
  /** Whose line it is, where the account is a control account (R-110). */
  partyId?: number | null;
}

export interface JournalResult {
  ok: boolean;
  voucher?: VoucherRow;
  error?: string;
  warnings: string[];
}

/**
 * Raise a journal voucher.
 *
 * Refuses rather than warns on anything that would produce an entry a set of
 * books cannot contain: fewer than two lines, a line that is both a debit and a
 * credit, a line that is neither, an unknown or retired account, and a total
 * that does not balance.
 *
 * Warns — and posts — on everything else, because the alternative to a warning
 * is a dealership that cannot book a real transaction because the product
 * disagreed with their accountant.
 */
export async function postJournal(input: {
  ownerId: number;
  /**
   * Which branch this happened at.
   *
   * Required, and not because the ledger needs it: the entity's books are the
   * sum of its branches either way. It is required because **a branch is a
   * profit centre** (R-119), and rent booked with no branch against it is rent
   * that appears in the consolidated P&L and in none of the five branch
   * columns — which is precisely the figure an owner is trying to compare.
   */
  showroomId: number;
  voucherDate: string;
  narration: string;
  lines: JournalLineInput[];
  userId?: number | null;
}): Promise<JournalResult> {
  const warnings: string[] = [];

  if (!input.narration?.trim()) {
    return {
      ok: false,
      error:
        "A journal needs a narration. Every other voucher in these books says what it is because a " +
        "document says so; this one has only what the person raising it writes down.",
      warnings,
    };
  }
  if (input.lines.length < 2) {
    return {
      ok: false,
      error: "A journal needs at least two lines — something debited and something credited.",
      warnings,
    };
  }

  // ── each line has to be one thing or the other ──────────────────────────
  const lines = input.lines.map((l, i) => ({
    seq: i + 1,
    accountCode: l.accountCode.trim(),
    debit: round2(l.debit ?? 0),
    credit: round2(l.credit ?? 0),
    narration: l.narration?.trim() || null,
    partyId: l.partyId ?? null,
  }));

  for (const l of lines) {
    if (l.debit > 0 && l.credit > 0) {
      return {
        ok: false,
        error: `Line ${l.seq} (${l.accountCode}) is both a debit and a credit. Split it into two lines.`,
        warnings,
      };
    }
    /*
     * Negative **before** empty, and the order is the whole point of writing it
     * down. A negative debit also satisfies `debit <= 0`, so with the checks the
     * other way round a line for minus a hundred was refused with *has no
     * amount on it* - true enough to pass a test and useless to the person
     * reading it, who typed an amount and was told they had not.
     *
     * A negative debit is a credit written the wrong way round. Two columns
     * exist so that a sign never has to, and accepting one would make every
     * report that sums a column silently wrong.
     */
    if (l.debit < 0 || l.credit < 0) {
      return {
        ok: false,
        error: `Line ${l.seq} (${l.accountCode}) carries a negative amount. Put it in the other column instead.`,
        warnings,
      };
    }
    if (l.debit === 0 && l.credit === 0) {
      return {
        ok: false,
        error: `Line ${l.seq} (${l.accountCode}) has no amount on it.`,
        warnings,
      };
    }
  }

  // ── the accounts have to exist, and still be in use ─────────────────────
  await ensureChart(input.ownerId);
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accounts = await db
    .select()
    .from(ledgerAccountsTable)
    .where(
      and(eq(ledgerAccountsTable.ownerId, input.ownerId), inArray(ledgerAccountsTable.code, codes)),
    );
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  const unknown = codes.filter((c) => !byCode.has(c));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `No account ${unknown.join(", ")} in this dealership's chart.`,
      warnings,
    };
  }
  const retired = codes.filter((c) => byCode.get(c)!.isActive === "N");
  if (retired.length > 0) {
    return {
      ok: false,
      error:
        `${retired.map((c) => `${c} ${byCode.get(c)!.name}`).join("; ")} — retired. Bring the account ` +
        "back if it is still in use, rather than posting into something the chart says is closed.",
      warnings,
    };
  }

  // ── and it has to balance ───────────────────────────────────────────────
  const totalDebit = round2(lines.reduce((a, l) => a + l.debit, 0));
  const totalCredit = round2(lines.reduce((a, l) => a + l.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    return {
      ok: false,
      error:
        `This does not balance: ₹${totalDebit.toFixed(2)} debited against ₹${totalCredit.toFixed(2)} credited, ` +
        `a difference of ₹${Math.abs(totalDebit - totalCredit).toFixed(2)}.`,
      warnings,
    };
  }

  // ── the party on a control account ──────────────────────────────────────
  const partyIds = [...new Set(lines.map((l) => l.partyId).filter((p): p is number => p !== null))];
  const parties = partyIds.length
    ? await db
        .select({ id: partiesTable.id, name: partiesTable.name, gstin: partiesTable.gstin })
        .from(partiesTable)
        .where(
          and(eq(partiesTable.ownerId, input.ownerId), inArray(partiesTable.id, partyIds)),
        )
    : [];
  const partyById = new Map(parties.map((p) => [p.id, p]));

  const missingParty = partyIds.filter((id) => !partyById.has(id));
  if (missingParty.length > 0) {
    return {
      ok: false,
      error: `No party ${missingParty.join(", ")} in this dealership's ledgers.`,
      warnings,
    };
  }

  for (const l of lines) {
    if (CONTROL_ACCOUNTS.has(l.accountCode) && l.partyId === null) {
      warnings.push(
        `Line ${l.seq} posts to ${byCode.get(l.accountCode)!.name} with nobody's name against it. ` +
          "That balances and leaves money on a control account that reconciles to no party ledger — " +
          "the debtors reconciliation will name this voucher. Deliberate for a provision; a mistake otherwise.",
      );
    }
  }

  // ── post it ─────────────────────────────────────────────────────────────
  const fy = financialYearOf(input.voucherDate);
  const voucherNo = await nextVoucherNo(input.ownerId, "JOURNAL", fy);

  try {
    const [voucher] = await db
      .insert(vouchersTable)
      .values({
        ownerId: input.ownerId,
        showroomId: input.showroomId,
        kind: "JOURNAL",
        voucherNo,
        voucherDate: input.voucherDate,
        financialYear: fy,
        narration: input.narration.trim(),
        /*
         * `MANUAL`, and it is the honest value. Every other source kind names a
         * document that can be opened; a journal's source is a person and a
         * sentence, which is what the narration is for.
         */
        sourceKind: "MANUAL",
        sourceId: null,
        totalDebit: money(totalDebit),
        totalCredit: money(totalCredit),
        warnings,
        postedByUserId: input.userId ?? null,
      })
      .returning();

    await db.insert(voucherLinesTable).values(
      lines.map((l) => {
        const a = byCode.get(l.accountCode)!;
        const party = l.partyId === null ? null : partyById.get(l.partyId)!;
        return {
          voucherId: voucher!.id,
          seq: l.seq,
          accountId: a.id,
          accountCode: a.code,
          /*
           * The account's name **as it is now**, copied onto the line. A voucher
           * is a statement about a moment, and a rename in March must not
           * restate what a February entry said (the same argument that keeps
           * `tallyName` off the line).
           */
          accountName: a.name,
          debit: money(l.debit),
          credit: money(l.credit),
          narration: l.narration,
          partyId: l.partyId,
          partyName: party?.name ?? null,
          partyGstin: party?.gstin ?? null,
        };
      }),
    );

    logger.info(
      {
        ownerId: input.ownerId,
        showroomId: input.showroomId,
        voucherNo,
        lines: lines.length,
        total: totalDebit,
      },
      "Journal posted",
    );
    return { ok: true, voucher: voucher!, warnings };
  } catch (err) {
    /*
     * The locked-period trigger, caught and passed on in the database's own
     * words (OBJ-43). Restating it here would make two sentences for one rule,
     * and the one somebody reads would not be the one that refused.
     */
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "23514") {
      return { ok: false, error: cause.message ?? "These books are closed for that period.", warnings };
    }
    throw err;
  }
}
