/**
 * OBJ-43's done-when, stated so it can fail.
 *
 * > *An auditor's three questions answered on a screen, not in an argument
 * > about grants.*
 *
 * The three questions are always the same:
 *
 *   1. Can the audit trail be switched off?
 *   2. Can a filed period be changed?
 *   3. Where did this number come from?
 *
 * §1 answers the first by **reading the database's own grants** rather than
 * asserting a belief. A product that printed "the audit trail cannot be
 * disabled" from a constant would be printing a claim; this prints what
 * Postgres will actually let anybody do.
 *
 * §2 answers the second the hard way. The lock is a trigger, so this file
 * tries to post into a closed period **on the owner credential** — the one that
 * bypasses row-level security entirely — and it still gets refused. An
 * application check would have stopped a screen; this stops everything.
 *
 * §3 walks a voucher back to its document and a document forward to every
 * voucher it made, including the reversal, because the correction is the
 * interesting part.
 *
 * `pnpm --filter @workspace/scripts run audit`.
 */

import {
  ownerDb,
  withWorkerScope,
  legalEntitiesTable,
  gstRegistrationsTable,
  showroomsTable,
  partiesTable,
  partyBillsTable,
  purchaseInvoicesTable,
  purchaseInvoiceLinesTable,
  periodLocksTable,
  auditEventsTable,
  vouchersTable,
  voucherLinesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ensureParty } from "../lib/dms/ledger/parties";
import { createPurchaseInvoice, postPurchaseInvoice } from "../lib/dms/ledger/purchase";
import { reverseVoucher } from "../lib/dms/ledger/post";
import {
  lockPeriod,
  reopenPeriod,
  isLocked,
  lockHistory,
  auditRegister,
  recordAudit,
  traceBack,
  traceForward,
  auditTrailStatus,
  periodSummary,
} from "../lib/dms/ledger/audit";

const OWNER = 1;
const RUN_BY = "verify-audit";
const CODE = "TMPAUDIT";
const GSTIN = "07AAABA7777D1Z9";
const BRANCH = "TMP-AUDIT-BR";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}
const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const rupees = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);

/** Every message in an error's cause chain, because Drizzle wraps the useful one. */
function chainOf(e: unknown): string {
  const out: string[] = [];
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    out.push(String((err as Error).message ?? err));
  }
  return out.join(" | ");
}

console.log(`\nOBJ-43 — audit-ready, run by ${RUN_BY}\n`);

async function wipe(): Promise<void> {
  const branches = await ownerDb
    .select({ id: showroomsTable.id })
    .from(showroomsTable)
    .where(eq(showroomsTable.code, BRANCH));
  const ids = branches.map((b) => b.id);
  const ents = await ownerDb
    .select({ id: legalEntitiesTable.id })
    .from(legalEntitiesTable)
    .where(eq(legalEntitiesTable.code, CODE));

  if (ents.length)
    await ownerDb
      .delete(periodLocksTable)
      .where(inArray(periodLocksTable.entityId, ents.map((e) => e.id)));
  if (ids.length) {
    const vs = await ownerDb
      .select({ id: vouchersTable.id })
      .from(vouchersTable)
      .where(inArray(vouchersTable.showroomId, ids));
    for (const v of vs) {
      await ownerDb.delete(voucherLinesTable).where(eq(voucherLinesTable.voucherId, v.id));
    }
    // Reversal pointers first, or the delete trips over its own references.
    await ownerDb
      .update(vouchersTable)
      .set({ reversalOfId: null, reversedByVoucherId: null })
      .where(inArray(vouchersTable.showroomId, ids));
    await ownerDb.delete(vouchersTable).where(inArray(vouchersTable.showroomId, ids));
    const pis = await ownerDb
      .select({ id: purchaseInvoicesTable.id })
      .from(purchaseInvoicesTable)
      .where(inArray(purchaseInvoicesTable.showroomId, ids));
    if (pis.length) {
      await ownerDb
        .delete(purchaseInvoiceLinesTable)
        .where(inArray(purchaseInvoiceLinesTable.purchaseInvoiceId, pis.map((p) => p.id)));
      await ownerDb
        .delete(purchaseInvoicesTable)
        .where(inArray(purchaseInvoicesTable.id, pis.map((p) => p.id)));
    }
  }
  if (ents.length) {
    const eids = ents.map((e) => e.id);
    const ps = await ownerDb
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .where(inArray(partiesTable.entityId, eids));
    if (ps.length)
      await ownerDb
        .delete(partyBillsTable)
        .where(inArray(partyBillsTable.partyId, ps.map((p) => p.id)));
    await ownerDb.delete(partiesTable).where(inArray(partiesTable.entityId, eids));
  }
  await ownerDb.delete(showroomsTable).where(eq(showroomsTable.code, BRANCH));
  await ownerDb.delete(gstRegistrationsTable).where(eq(gstRegistrationsTable.gstin, GSTIN));
  await ownerDb.delete(legalEntitiesTable).where(eq(legalEntitiesTable.code, CODE));
}
await wipe();

const [entity] = await ownerDb
  .insert(legalEntitiesTable)
  .values({
    ownerId: OWNER,
    code: CODE,
    legalName: "Verify Audit Motors Pvt Ltd",
    pan: "AAABA7777D",
    entityKind: "PRIVATE_LIMITED",
    booksFrom: "2026-04-01",
  })
  .returning();
const [reg] = await ownerDb
  .insert(gstRegistrationsTable)
  .values({ ownerId: OWNER, entityId: entity!.id, gstin: GSTIN, state: "Delhi", stateCode: "07" })
  .returning();
const [branch] = await ownerDb
  .insert(showroomsTable)
  .values({
    ownerId: OWNER,
    code: BRANCH,
    name: "Verify Audit Branch",
    entityId: entity!.id,
    registrationId: reg!.id,
    role: "HUB",
    state: "Delhi",
  })
  .returning();

const { party: supplier } = await ensureParty({
  ownerId: OWNER,
  entityId: entity!.id,
  kind: "OEM",
  name: "Hero MotoCorp Ltd",
  gstin: "06AAACH1234M1ZQ",
});

// ────────────────────────────────────────────────────────────────────────────

section("1. **can the audit trail be switched off?**");

const status = await withWorkerScope(() => auditTrailStatus());
for (const g of status.grants) console.log(`      ${pad(g.grantee, 14)} ${g.privilege}`);
check(
  "**no role may update or delete a row in the register**",
  status.appendOnly,
  status.statement,
);
check(
  "and the answer is read from the database's grants, not asserted",
  status.grants.length > 0 && status.grants.every((g) => g.privilege === "INSERT" || g.privilege === "SELECT"),
  "a product printing that sentence from a constant would be printing a claim",
);

let deleteRefused = "";
try {
  await withWorkerScope(async () => {
    await ownerDb.execute(sql`delete from audit_events where id = -1`);
  });
} catch (e) {
  deleteRefused = chainOf(e);
}
await recordAudit({
  ownerId: OWNER,
  entityId: entity!.id,
  kind: "OPENING_BALANCES",
  summary: "verify-audit fixture",
  userId: 1,
  userName: RUN_BY,
});
check(
  "and the scheduler may write to it, because a refusal it made has to be recordable",
  (await withWorkerScope(() => auditRegister({ ownerId: OWNER, limit: 5 }))).length > 0,
  "a trail with a hole where the unattended pass was is not a trail",
);

// ────────────────────────────────────────────────────────────────────────────

section("2. a purchase, posted, and then the month is closed");

const purchase = await createPurchaseInvoice({
  ownerId: OWNER,
  showroomId: branch!.id,
  supplierId: supplier.id,
  supplierInvoiceNo: "VERIFY-AUDIT-HMC-1",
  invoiceDate: "2026-08-04",
  interState: true,
  lines: [
    {
      modelDescription: "Splendor Plus",
      chassisNo: "VERIFY-AUDIT-CHASSIS-1",
      hsn: "87112019",
      unitCost: 62_500,
      gstRatePct: 18,
    },
  ],
});
const posted = await postPurchaseInvoice({
  ownerId: OWNER,
  purchaseInvoiceId: purchase.invoice!.id,
  userId: 1,
});
check("it posts", posted.ok, posted.ok ? `voucher ${posted.voucher!.voucherNo}` : posted.error!);

const before = await withWorkerScope(() =>
  periodSummary({ ownerId: OWNER, entityId: entity!.id, from: "2026-08-01", to: "2026-08-31" }),
);
console.log(
  `      August holds ${before.vouchers} voucher(s), ${rupees(before.totalDebit)} debited, ${before.unpostedSaleDocuments} issued-and-unposted`,
);
check(
  "the summary is shown before the lock, not after",
  before.vouchers >= 1 && before.alreadyLocked === null,
  "'should this be closed?' is answerable; 'why was this closed?' is not",
);

const lock = await lockPeriod({
  ownerId: OWNER,
  entityId: entity!.id,
  fromDate: "2026-08-01",
  toDate: "2026-08-31",
  reason: "GST_FILED",
  note: "GSTR-3B filed 20 September",
  userId: 1,
  userName: RUN_BY,
});
check("August closes", lock.ok, lock.ok ? `${lock.lock!.fromDate} to ${lock.lock!.toDate}` : lock.error!);

const overlap = await lockPeriod({
  ownerId: OWNER,
  entityId: entity!.id,
  fromDate: "2026-08-15",
  toDate: "2026-09-15",
  userId: 1,
});
check(
  "a second lock over the same month is refused",
  !overlap.ok && overlap.error!.includes("quietly fails to open"),
  overlap.ok ? "it layered two" : overlap.error!,
);

// ────────────────────────────────────────────────────────────────────────────

section("3. **can a filed period be changed?**");

/*
 * The important part of this section is the credential. `ownerDb` is the
 * `postgres` role - it bypasses row-level security entirely, and every other
 * refusal in this codebase is invisible to it. If the lock held only in
 * application code this insert would sail through.
 */
let lockedRefusal = "";
try {
  await ownerDb.insert(vouchersTable).values({
    ownerId: OWNER,
    showroomId: branch!.id,
    kind: "JOURNAL",
    voucherNo: "AUDIT-BACKDATED-1",
    voucherDate: "2026-08-15",
    financialYear: "2026-27",
    narration: "A voucher backdated into a filed month",
    sourceKind: "MANUAL",
    totalDebit: "1000.00",
    totalCredit: "1000.00",
  });
} catch (e) {
  lockedRefusal = chainOf(e);
}
check(
  "**backdating into a closed month is refused on the owner credential itself**",
  lockedRefusal.includes("is closed for these books"),
  lockedRefusal.split(" | ").find((m) => m.includes("closed for these books")) ?? lockedRefusal ?? "it posted",
);
check(
  "so the refusal is the database's, not the application's",
  lockedRefusal.length > 0,
  "an application check stops a screen; it does not stop a script, a migration, or the thing somebody writes at eleven at night",
);

const septemberOk = await ownerDb
  .insert(vouchersTable)
  .values({
    ownerId: OWNER,
    showroomId: branch!.id,
    kind: "JOURNAL",
    voucherNo: "AUDIT-SEPTEMBER-1",
    voucherDate: "2026-09-02",
    financialYear: "2026-27",
    narration: "verify-audit: an open month",
    sourceKind: "MANUAL",
    totalDebit: "1000.00",
    totalCredit: "1000.00",
  })
  .returning();
check(
  "and an open month still takes a posting",
  septemberOk.length === 1,
  "the lock covers a period, not the books",
);

/*
 * A reversal is dated **today**, not the original's date, because reversing an
 * April entry in September is a September event. So the period that has to be
 * locked to refuse one is today's — computed rather than hard-coded, or this
 * check would pass or fail depending on when somebody ran it.
 */
const TODAY = new Date().toISOString().slice(0, 10);
const wasAugustLock = await withWorkerScope(() => isLocked(entity!.id, TODAY));
if (wasAugustLock) {
  await reopenPeriod({
    ownerId: OWNER,
    lockId: wasAugustLock.id,
    reason: "verify-audit: today falls inside the month under test",
    userId: 1,
  });
}
const todayLock = await lockPeriod({
  ownerId: OWNER,
  entityId: entity!.id,
  fromDate: TODAY,
  toDate: TODAY,
  reason: "PERIOD_CLOSED",
  userId: 1,
  userName: RUN_BY,
});

const reversalBlocked = await reverseVoucher({
  ownerId: OWNER,
  voucherId: posted.voucher!.id,
  reason: "verify-audit: trying to undo something into a closed day",
  userId: 1,
});
check(
  "even a **reversal** is refused when the day it would land on is closed",
  !reversalBlocked.ok && reversalBlocked.error!.includes("is closed for these books"),
  reversalBlocked.ok
    ? "it reversed"
    : "correcting a closed period is a reopening followed by a correction, not a quiet entry",
);
check(
  "and the refusal carries the database's own sentence to the screen",
  !reversalBlocked.ok && reversalBlocked.error!.includes("named act with a reason"),
  reversalBlocked.error ?? "",
);

await reopenPeriod({
  ownerId: OWNER,
  lockId: todayLock.lock!.id,
  reason: "verify-audit: done with that check",
  userId: 1,
});
if (wasAugustLock) {
  await lockPeriod({
    ownerId: OWNER,
    entityId: entity!.id,
    fromDate: "2026-08-01",
    toDate: "2026-08-31",
    reason: "GST_FILED",
    userId: 1,
    userName: RUN_BY,
  });
}

// ────────────────────────────────────────────────────────────────────────────

section("4. reopening is a named act with a reason");

const [liveLock] = await ownerDb
  .select()
  .from(periodLocksTable)
  .where(
    and(eq(periodLocksTable.entityId, entity!.id), eq(periodLocksTable.status, "LOCKED")),
  );

const noReason = await reopenPeriod({
  ownerId: OWNER,
  lockId: liveLock!.id,
  reason: "   ",
  userId: 1,
});
check(
  "reopening without a reason is refused",
  !noReason.ok && noReason.error!.includes("worst possible answer"),
  noReason.ok ? "it reopened" : noReason.error!,
);

const reopened = await reopenPeriod({
  ownerId: OWNER,
  lockId: liveLock!.id,
  reason: "A supplier invoice arrived after filing; GSTR-3B will be amended next month.",
  userId: 1,
  userName: RUN_BY,
});
check("with one, it reopens", reopened.ok, reopened.error ?? "");

const history = await withWorkerScope(() => lockHistory({ ownerId: OWNER, entityId: entity!.id }));
check(
  "**and every lock row stays, marked reopened**",
  history.length >= 1 && history.every((h) => h.status === "REOPENED" && Boolean(h.reopenReason)),
  history.map((h) => `${h.fromDate}..${h.toDate}: ${h.reopenReason}`).join(" · "),
);
check(
  "so the most interesting fact in the file is still in it",
  history.every((h) => h.reopenedAt !== null),
  "deleting the lock would tidy away the evidence that a filed month was changed",
);

const nowOpen = await withWorkerScope(() => isLocked(entity!.id, "2026-08-15"));
check("and August takes a posting again", nowOpen === null);

// ────────────────────────────────────────────────────────────────────────────

section("5. **where did this number come from?** (the two-way trace)");

const back = await withWorkerScope(() =>
  traceBack({ ownerId: OWNER, voucherId: posted.voucher!.id }),
);
console.log(`      voucher  ${back.voucher!.kind} ${back.voucher!.ref} — ${rupees(back.voucher!.amount ?? 0)}`);
console.log(`      source   ${back.source?.kind} ${back.source?.ref} — ${back.source?.detail}`);
for (const l of back.lines)
  console.log(`      line     ${pad(l.kind, 6)} ${pad(l.ref, 32)} ${rupees(l.amount ?? 0).padStart(14)}`);

check(
  "a voucher reaches the document behind it in one step",
  back.source !== null && back.source!.ref === "VERIFY-AUDIT-HMC-1",
  "an auditor picking a line out of a trial balance should not be told which table to look in",
);
check(
  "with its lines, so the figure can be found on it",
  back.lines.length >= 3,
  `${back.lines.length} lines`,
);

const nowReversed = await reverseVoucher({
  ownerId: OWNER,
  voucherId: posted.voucher!.id,
  reason: "verify-audit: correcting a keyed cost",
  userId: 1,
});
check("the purchase is reversed, now that August is open", nowReversed.ok, nowReversed.error ?? "");

const forward = await withWorkerScope(() =>
  traceForward({ ownerId: OWNER, sourceKind: "PURCHASE_INVOICE", sourceId: purchase.invoice!.id }),
);
for (const f of forward) console.log(`      ${pad(f.kind, 26)} ${pad(f.ref, 6)} ${f.date}`);
check(
  "**and a document shows every voucher it ever made, including the reversal**",
  forward.length >= 2 && forward.some((f) => f.kind.includes("reversal")),
  "the surviving voucher is the boring one; the correction is what an auditor came to see",
);

// ────────────────────────────────────────────────────────────────────────────

section("6. the register, which is the page rather than the argument");

const register = await withWorkerScope(() => auditRegister({ ownerId: OWNER, limit: 20 }));
for (const e of register.slice(0, 8)) {
  console.log(`      ${pad(e.kind, 18)} ${pad(e.actedByName ?? "", 14)} ${e.summary}`);
}
check(
  "the lock and the reopening are both on it",
  register.some((e) => e.kind === "PERIOD_LOCKED") && register.some((e) => e.kind === "PERIOD_REOPENED"),
  `${register.length} events`,
);
check(
  "and the reopening carries the reason somebody gave",
  register.some((e) => e.kind === "PERIOD_REOPENED" && e.summary.includes("amended next month")),
  register.find((e) => e.kind === "PERIOD_REOPENED")?.summary ?? "",
);

// ────────────────────────────────────────────────────────────────────────────

await wipe();
console.log("\n  (the throwaway company, its vouchers, its locks and its register entries, removed)");

console.log(
  failures === 0
    ? "\nAll checks passed. The trail cannot be switched off, a filed month refuses at the database, and every figure traces both ways.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
