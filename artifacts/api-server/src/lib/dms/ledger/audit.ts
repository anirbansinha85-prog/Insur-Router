/**
 * Audit-ready, which means answerable on a screen (OBJ-43, R-112, R-113).
 *
 * An auditor asks three questions of any accounting system and this file exists
 * to make all three a page rather than a conversation:
 *
 *   1. *Can the audit trail be switched off?*  — the register, and the grant
 *      that makes it append-only for every role including ours.
 *   2. *Can a filed period be changed?*        — the lock, enforced by a
 *      database trigger rather than by application code being careful.
 *   3. *Where did this number come from?*      — the two-way trace, from a
 *      figure on a return back to the deal, and from a deal forward to the
 *      return it landed in.
 *
 * DDMS is already stronger than the Companies (Accounts) Rules require: there
 * is no edit path in the ledger at all, only reversal. **Stronger is not
 * demonstrable**, and an auditor asking whether something can be disabled wants
 * to be shown, not assured.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  periodLocksTable,
  auditEventsTable,
  vouchersTable,
  voucherLinesTable,
  saleDocumentsTable,
  purchaseInvoicesTable,
  serviceInvoicesTable,
  moneyDocumentsTable,
  legalEntitiesTable,
  type PeriodLockRow,
  type AuditEventRow,
} from "@workspace/db";

import { logger } from "../../logger";
import { branchesOfEntity } from "../org";

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** Write one line into the register. Never updated, never deleted. */
export async function recordAudit(input: {
  ownerId: number;
  entityId?: number | null;
  kind: AuditEventRow["kind"];
  summary: string;
  subjectKind?: string | null;
  subjectId?: number | null;
  subjectRef?: string | null;
  userId?: number | null;
  userName?: string | null;
}): Promise<void> {
  await db.insert(auditEventsTable).values({
    ownerId: input.ownerId,
    entityId: input.entityId ?? null,
    kind: input.kind,
    summary: input.summary,
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
    subjectRef: input.subjectRef ?? null,
    actedByUserId: input.userId ?? null,
    actedByName: input.userName ?? null,
  });
}

/**
 * Close a period.
 *
 * The lock covers an **entity**, because a set of books is what gets filed. It
 * refuses to lock a period that already has a live lock over any part of it,
 * rather than silently layering two — overlapping locks are how a reopening
 * quietly fails to open anything.
 */
export async function lockPeriod(input: {
  ownerId: number;
  entityId: number;
  fromDate: string;
  toDate: string;
  reason?: PeriodLockRow["reason"];
  note?: string | null;
  userId?: number | null;
  userName?: string | null;
}): Promise<{ ok: boolean; lock?: PeriodLockRow; error?: string }> {
  if (input.toDate < input.fromDate) {
    return { ok: false, error: "A period cannot end before it starts." };
  }

  const overlapping = await db
    .select({ id: periodLocksTable.id, from: periodLocksTable.fromDate, to: periodLocksTable.toDate })
    .from(periodLocksTable)
    .where(
      and(
        eq(periodLocksTable.entityId, input.entityId),
        eq(periodLocksTable.status, "LOCKED"),
        sql`${periodLocksTable.fromDate}::text <= ${input.toDate}`,
        sql`${periodLocksTable.toDate}::text >= ${input.fromDate}`,
      ),
    );
  if (overlapping.length > 0) {
    return {
      ok: false,
      error:
        `${overlapping[0]!.from} to ${overlapping[0]!.to} is already locked and overlaps this period. ` +
        "Two locks over one month is how a reopening quietly fails to open anything.",
    };
  }

  const [lock] = await db
    .insert(periodLocksTable)
    .values({
      ownerId: input.ownerId,
      entityId: input.entityId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      reason: input.reason ?? "PERIOD_CLOSED",
      note: input.note ?? null,
      lockedByUserId: input.userId ?? null,
    })
    .returning();

  await recordAudit({
    ownerId: input.ownerId,
    entityId: input.entityId,
    kind: "PERIOD_LOCKED",
    summary: `${input.fromDate} to ${input.toDate} closed — ${(input.reason ?? "PERIOD_CLOSED").toLowerCase().replace(/_/g, " ")}`,
    subjectKind: "PERIOD_LOCK",
    subjectId: lock!.id,
    userId: input.userId,
    userName: input.userName,
  });

  logger.info(
    { ownerId: input.ownerId, entityId: input.entityId, from: input.fromDate, to: input.toDate },
    "Period locked",
  );
  return { ok: true, lock: lock! };
}

/**
 * Reopen a period, which is a named act and needs a reason.
 *
 * The lock row **stays**, marked reopened. Deleting it would make the most
 * interesting fact in the file invisible: that a filed month was reopened, by
 * whom, and why. That is precisely the thing an auditor is looking for, and a
 * product that tidied it away would be tidying away its own evidence.
 */
export async function reopenPeriod(input: {
  ownerId: number;
  lockId: number;
  reason: string;
  userId?: number | null;
  userName?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.reason?.trim()) {
    return {
      ok: false,
      error:
        "Reopening a closed period needs a reason. A month that was filed and then changed is the " +
        "first thing an auditor asks about, and 'no reason given' is the worst possible answer.",
    };
  }

  const [lock] = await db
    .select()
    .from(periodLocksTable)
    .where(
      and(eq(periodLocksTable.ownerId, input.ownerId), eq(periodLocksTable.id, input.lockId)),
    );
  if (!lock) return { ok: false, error: `No lock ${input.lockId}` };
  if (lock.status === "REOPENED") return { ok: false, error: "That period is already reopened." };

  await db
    .update(periodLocksTable)
    .set({
      status: "REOPENED",
      reopenedByUserId: input.userId ?? null,
      reopenedAt: new Date(),
      reopenReason: input.reason.trim(),
    })
    .where(eq(periodLocksTable.id, lock.id));

  await recordAudit({
    ownerId: input.ownerId,
    entityId: lock.entityId,
    kind: "PERIOD_REOPENED",
    summary: `${lock.fromDate} to ${lock.toDate} reopened — ${input.reason.trim()}`,
    subjectKind: "PERIOD_LOCK",
    subjectId: lock.id,
    userId: input.userId,
    userName: input.userName,
  });

  logger.warn(
    { ownerId: input.ownerId, lockId: lock.id, reason: input.reason },
    "Period reopened",
  );
  return { ok: true };
}

/** Whether a date falls inside a live lock for this entity. */
export async function isLocked(
  entityId: number,
  onDate: string,
): Promise<PeriodLockRow | null> {
  const [lock] = await db
    .select()
    .from(periodLocksTable)
    .where(
      and(
        eq(periodLocksTable.entityId, entityId),
        eq(periodLocksTable.status, "LOCKED"),
        sql`${periodLocksTable.fromDate}::text <= ${onDate}`,
        sql`${periodLocksTable.toDate}::text >= ${onDate}`,
      ),
    )
    .limit(1);
  return lock ?? null;
}

/** Every lock this entity has ever had, including the reopened ones. */
export async function lockHistory(input: {
  ownerId: number;
  entityId: number;
}): Promise<PeriodLockRow[]> {
  return db
    .select()
    .from(periodLocksTable)
    .where(
      and(eq(periodLocksTable.ownerId, input.ownerId), eq(periodLocksTable.entityId, input.entityId)),
    )
    .orderBy(asc(periodLocksTable.fromDate));
}

/** The register, newest first. The page an auditor is shown. */
export async function auditRegister(input: {
  ownerId: number;
  from?: string | null;
  to?: string | null;
  kind?: AuditEventRow["kind"];
  limit?: number;
}): Promise<AuditEventRow[]> {
  const where = [eq(auditEventsTable.ownerId, input.ownerId)];
  if (input.from) where.push(sql`${auditEventsTable.actedAt} >= ${input.from}::timestamptz`);
  if (input.to) where.push(sql`${auditEventsTable.actedAt} < (${input.to}::date + 1)`);
  if (input.kind) where.push(eq(auditEventsTable.kind, input.kind));

  return db
    .select()
    .from(auditEventsTable)
    .where(and(...where))
    .orderBy(desc(auditEventsTable.actedAt), desc(auditEventsTable.id))
    .limit(input.limit ?? 200);
}

export interface TraceNode {
  kind: string;
  ref: string;
  date: string;
  amount: number | null;
  detail: string;
}

/**
 * From a voucher, backwards to the document it came off.
 *
 * The first half of the two-way trace. An auditor picking a line out of a
 * trial balance wants to reach the piece of paper behind it in one step, not to
 * be told which table to look in.
 */
export async function traceBack(input: {
  ownerId: number;
  voucherId: number;
}): Promise<{ voucher: TraceNode | null; source: TraceNode | null; lines: TraceNode[] }> {
  const [v] = await db
    .select()
    .from(vouchersTable)
    .where(and(eq(vouchersTable.ownerId, input.ownerId), eq(vouchersTable.id, input.voucherId)));
  if (!v) return { voucher: null, source: null, lines: [] };

  const lines = await db
    .select()
    .from(voucherLinesTable)
    .where(eq(voucherLinesTable.voucherId, v.id))
    .orderBy(asc(voucherLinesTable.seq));

  let source: TraceNode | null = null;

  if (v.sourceKind === "SALE_DOCUMENT" && v.sourceId) {
    const [d] = await db
      .select()
      .from(saleDocumentsTable)
      .where(eq(saleDocumentsTable.id, v.sourceId));
    if (d)
      source = {
        kind: d.kind,
        ref: d.taxInvoiceNo ?? d.reference,
        date: d.documentDate,
        amount: n(d.totalAmount),
        detail: `${d.customerName ?? "Customer"} — ${d.modelDescription ?? "vehicle"}${d.chassisNo ? ` — ${d.chassisNo}` : ""}`,
      };
  } else if (v.sourceKind === "PURCHASE_INVOICE" && v.sourceId) {
    const [p] = await db
      .select()
      .from(purchaseInvoicesTable)
      .where(eq(purchaseInvoicesTable.id, v.sourceId));
    if (p)
      source = {
        kind: "PURCHASE_INVOICE",
        ref: p.supplierInvoiceNo,
        date: p.invoiceDate,
        amount: n(p.totalAmount),
        detail: "Supplier invoice",
      };
  } else if (v.sourceKind === "OPENING_BALANCE" && v.sourceId) {
    const [e] = await db
      .select()
      .from(legalEntitiesTable)
      .where(eq(legalEntitiesTable.id, v.sourceId));
    if (e)
      source = {
        kind: "OPENING_BALANCE",
        ref: e.code,
        date: e.booksFrom ?? v.voucherDate,
        amount: null,
        detail: `Balances brought in for ${e.legalName}`,
      };
  } else {
    /*
     * `MANUAL` covers the documents that post directly rather than through a
     * source id - a receipt, a service invoice, a branch transfer. They are
     * found by their narration carrying the document number, which is the one
     * place in this file that reads a string rather than a key, and it is why
     * every one of those paths puts its number in the narration.
     */
    const [m] = await db
      .select()
      .from(moneyDocumentsTable)
      .where(
        and(eq(moneyDocumentsTable.ownerId, input.ownerId), eq(moneyDocumentsTable.voucherId, v.id)),
      );
    if (m)
      source = {
        kind: m.direction,
        ref: m.documentNo,
        date: m.documentDate,
        amount: n(m.amount),
        detail: `${m.mode}${m.instrumentRef ? ` — ${m.instrumentRef}` : ""}`,
      };
    else {
      const [s] = await db
        .select()
        .from(serviceInvoicesTable)
        .where(
          and(
            eq(serviceInvoicesTable.ownerId, input.ownerId),
            eq(serviceInvoicesTable.voucherId, v.id),
          ),
        );
      if (s)
        source = {
          kind: "SERVICE_INVOICE",
          ref: s.invoiceNo,
          date: s.invoiceDate,
          amount: n(s.totalAmount),
          detail: `${s.registrationNo ?? "vehicle"}${s.jobCardRef ? ` — ${s.jobCardRef}` : ""}`,
        };
    }
  }

  return {
    voucher: {
      kind: v.kind,
      ref: v.voucherNo,
      date: v.voucherDate,
      amount: n(v.totalDebit),
      detail: v.narration ?? "",
    },
    source,
    lines: lines.map((l) => ({
      kind: l.accountCode,
      ref: l.accountName,
      date: v.voucherDate,
      amount: n(l.debit) > 0 ? n(l.debit) : -n(l.credit),
      detail: l.narration ?? l.partyName ?? "",
    })),
  };
}

/**
 * From a document, forwards to every voucher it produced.
 *
 * The other half. A sale that was posted, reversed and re-posted has three
 * vouchers, and an auditor asking what became of it should see all three rather
 * than the surviving one — the correction is the interesting part.
 */
export async function traceForward(input: {
  ownerId: number;
  sourceKind: "SALE_DOCUMENT" | "PURCHASE_INVOICE" | "OPENING_BALANCE";
  sourceId: number;
}): Promise<TraceNode[]> {
  const vouchers = await db
    .select()
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        eq(vouchersTable.sourceKind, input.sourceKind),
        eq(vouchersTable.sourceId, input.sourceId),
      ),
    )
    .orderBy(asc(vouchersTable.id));

  const reversals = vouchers.length
    ? await db
        .select()
        .from(vouchersTable)
        .where(
          and(
            eq(vouchersTable.ownerId, input.ownerId),
            inArray(
              vouchersTable.reversalOfId,
              vouchers.map((v) => v.id),
            ),
          ),
        )
    : [];

  return [...vouchers, ...reversals]
    .sort((a, b) => a.id - b.id)
    .map((v) => ({
      kind: `${v.kind}${v.status === "REVERSED" ? " (reversed)" : ""}${v.reversalOfId ? " — the reversal" : ""}`,
      ref: v.voucherNo,
      date: v.voucherDate,
      amount: n(v.totalDebit),
      detail: v.narration ?? "",
    }));
}

/**
 * Whether the audit trail can be switched off, answered.
 *
 * Reads the actual grants out of the catalogue rather than asserting a belief.
 * A product that printed "the audit trail cannot be disabled" from a constant
 * would be printing a claim; this prints what the database will let anybody do,
 * which is the only version worth showing an auditor.
 */
export async function auditTrailStatus(): Promise<{
  appendOnly: boolean;
  grants: Array<{ grantee: string; privilege: string }>;
  statement: string;
}> {
  const rows = await db.execute<{ grantee: string; privilege_type: string }>(
    sql`select grantee, privilege_type
          from information_schema.role_table_grants
         where table_name = 'audit_events'
           and grantee not in ('postgres', 'PUBLIC')
         order by grantee, privilege_type`,
  );

  /*
   * `db.execute` hands back the driver's own result object, not an array. Both
   * shapes are handled because a raw query is the one place in this file where
   * the return type is the driver's rather than Drizzle's, and getting it wrong
   * fails at run time rather than at the typechecker.
   */
  const raw = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    grantee: string;
    privilege_type: string;
  }>;
  const grants = raw.map((r) => ({ grantee: r.grantee, privilege: r.privilege_type }));

  const canChange = grants.some(
    (g) => g.privilege === "UPDATE" || g.privilege === "DELETE" || g.privilege === "TRUNCATE",
  );

  return {
    appendOnly: !canChange,
    grants,
    statement: canChange
      ? "Some role can update or delete audit rows. The trail is not append-only."
      : "No role may update or delete a row in the audit register — only insert and read. " +
        "The trail cannot be switched off or edited, and this sentence is read from the " +
        "database's own grants rather than asserted.",
  };
}

/**
 * What a period contains, for whoever is about to close it.
 *
 * Shown before a lock rather than after, because the question *should this be
 * closed?* is answerable and *why was this closed?* is not.
 */
export async function periodSummary(input: {
  ownerId: number;
  entityId: number;
  from: string;
  to: string;
}): Promise<{
  vouchers: number;
  reversed: number;
  totalDebit: number;
  unpostedSaleDocuments: number;
  alreadyLocked: PeriodLockRow | null;
}> {
  const branchIds = await branchesOfEntity(input.entityId);
  if (branchIds.length === 0)
    return { vouchers: 0, reversed: 0, totalDebit: 0, unpostedSaleDocuments: 0, alreadyLocked: null };

  const vs = await db
    .select({ status: vouchersTable.status, totalDebit: vouchersTable.totalDebit })
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.ownerId, input.ownerId),
        inArray(vouchersTable.showroomId, branchIds),
        sql`${vouchersTable.voucherDate}::text >= ${input.from}`,
        sql`${vouchersTable.voucherDate}::text <= ${input.to}`,
      ),
    );

  /*
   * Issued and never posted is the one thing worth stopping a close for: a tax
   * invoice the customer has that the books have never seen means the return
   * about to be filed is short by its value.
   */
  const unposted = await db.execute<{ c: string }>(
    sql`select count(*)::text as c
          from sale_documents d
         where d.owner_id = ${input.ownerId}
           and d.showroom_id = any(${sql.raw(`array[${branchIds.join(",")}]`)})
           and d.status = 'ISSUED'
           and d.kind in ('TAX_INVOICE','SALE_CONFIRMATION')
           and d.document_date >= ${input.from}::date
           and d.document_date <= ${input.to}::date
           and not exists (
             select 1 from vouchers v
              where v.source_kind = 'SALE_DOCUMENT'
                and v.source_id = d.id
                and v.status = 'POSTED'
           )`,
  );

  return {
    vouchers: vs.length,
    reversed: vs.filter((v) => v.status === "REVERSED").length,
    totalDebit: round2(vs.reduce((a, v) => a + n(v.totalDebit), 0)),
    unpostedSaleDocuments: Number(
      (
        (Array.isArray(unposted)
          ? unposted
          : ((unposted as { rows?: unknown[] }).rows ?? [])) as Array<{ c: string }>
      )[0]?.c ?? 0,
    ),
    alreadyLocked: await isLocked(input.entityId, input.to),
  };
}
