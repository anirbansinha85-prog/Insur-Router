/**
 * DDMS — the ledger, read across the group.
 *
 * The spares screen showed a part standing on a shelf four hundred kilometres
 * away. This one shows the same shape of finding in money: **one insurer owes
 * two of your outlets, and neither branch's ageing report can add them up.**
 * Each branch sees a bill worth chasing. Only the owner sees a party holding a
 * six-figure sum of the group's money, and those are different conversations.
 *
 * So the leading number is not total outstanding — every DMS prints that. It is
 * what one party owes across the whole group, and it is present only when a
 * party actually owes at more than one outlet. A group figure that is really a
 * branch figure would be worse than no figure at all.
 *
 * The states name **causes**, not ageing: nobody chased it, they broke a
 * promise, we are disputing it. `daysOverdue` carries the severity on the row.
 * Ranking by age alone would put a disputed bill next to an unchased one and
 * send somebody to have an argument they cannot win.
 */

import { useMemo, useState } from "react"
import {
  getGetReceivablesWorklistQueryKey,
  useGetReceivablesWorklist,
  type ReceivableState,
  type ReceivablesWorklistRow,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { ActionButton } from "@/lib/actions"
import { ExplainButton } from "@/lib/explain"
import { OpenCase } from "@/lib/open-case"
import { DraftButton } from "@/lib/messages"
import { AlertTriangle, Building2, Clock, HandCoins, Wallet } from "lucide-react"
import { FindBox, rowText, useFind } from "@/lib/find"

const STATE: Record<
  ReceivableState,
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft"; blurb: string }
> = {
  DISPUTED: { label: "Disputed", variant: "destructive", blurb: "Blocked, not slow — chasing it will not help" },
  PROMISE_BROKEN: { label: "Promise broken", variant: "destructive", blurb: "They gave a date and it passed" },
  UNCHASED: { label: "Nobody chasing", variant: "warning", blurb: "Past due and no chase on record" },
  BEING_CHASED: { label: "Being chased", variant: "info", blurb: "Past due, but somebody is on it" },
  DUE_SOON: { label: "Due soon", variant: "info", blurb: "Not late yet" },
  CURRENT: { label: "Current", variant: "success", blurb: "Inside its credit period" },
  SETTLED: { label: "Settled", variant: "draft", blurb: "Paid in full" },
}

/** The order a finance manager would work them in. */
const STATE_ORDER: ReceivableState[] = [
  "DISPUTED",
  "PROMISE_BROKEN",
  "UNCHASED",
  "BEING_CHASED",
  "DUE_SOON",
  "CURRENT",
  "SETTLED",
]

const PARTY_LABEL: Record<string, string> = {
  CUSTOMER: "Customer",
  INSURER: "Insurer",
  OEM: "Manufacturer",
  FINANCIER: "Financier",
}

function rupees(n: number | null | undefined): string {
  if (!n) return "—"
  return `₹${Math.round(n).toLocaleString("en-IN")}`
}

/** `2026-08-04` → `4 Aug`. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d)
}

function StatCard({
  title, value, icon: Icon, colorClass, hint, isLoading,
}: {
  title: string
  value?: string | number
  icon: typeof Wallet
  colorClass: string
  hint?: string
  isLoading: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-semibold text-slate-500">{title}</CardTitle>
        <Icon className={`w-4 h-4 ${colorClass}`} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24 mt-1" />
        ) : (
          <>
            <div className="text-3xl font-bold text-slate-900 tabular-nums">{value ?? "—"}</div>
            {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * How overdue, said as a number that stands out at a glance.
 *
 * Bracketed rather than continuous, because a finance manager does not chase in
 * order of days — they chase 90+ first, then 60, then the rest, and the colour
 * is doing the work the eye actually needs.
 */
function Overdue({ days }: { days: number }) {
  if (days <= 0) {
    return (
      <span className="text-[11px] text-slate-400 tabular-nums">
        due in {Math.abs(days)}d
      </span>
    )
  }
  const tone =
    days >= 90 ? "text-red-600" : days >= 60 ? "text-red-500" : days >= 30 ? "text-amber-600" : "text-slate-600"
  return <span className={`text-sm font-semibold tabular-nums ${tone}`}>{days}d late</span>
}

export default function Receivables() {
  const [filter, setFilter] = useState<ReceivableState | "all">("all")
  const { selected } = useShowroom()

  const params = { showroomId: selected?.id ?? 0 }
  const { data, isLoading } = useGetReceivablesWorklist(params, {
    query: { queryKey: getGetReceivablesWorklistQueryKey(params), enabled: Boolean(selected) },
  })

  const rows: ReceivablesWorklistRow[] = data?.rows ?? []
  const summary = data?.summary

  const visible = useMemo(() => {
    const filtered = filter === "all" ? rows : rows.filter((r) => r.state === filter)
    return [...filtered].sort((a, b) => {
      const byState = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
      return byState !== 0 ? byState : b.daysOverdue - a.daysOverdue
    })
  }, [rows, filter])

  // Searched *after* the state filter rather than instead of it: the chips
  // narrow to a kind of problem and the box finds one record, and somebody who
  // has picked a chip and then typed a name means both.
  const { query, setQuery, found } = useFind(visible, rowText)

  const exposure = summary?.largestGroupExposure

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Receivables</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          What this outlet is owed, and what each party owes the group.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Owed to the group"
          value={exposure ? rupees(exposure.totalBalance) : undefined}
          icon={Building2}
          colorClass="text-red-500"
          hint={
            exposure
              ? `${exposure.partyName} · across ${exposure.outletCount} outlets`
              : "No party owes at more than one outlet"
          }
          isLoading={isLoading}
        />
        <StatCard
          title="Past due"
          value={rupees(summary?.overdue)}
          icon={AlertTriangle}
          colorClass="text-amber-500"
          hint="Outstanding beyond its credit period"
          isLoading={isLoading}
        />
        <StatCard
          title="Nobody chasing"
          value={summary?.needsAction}
          icon={HandCoins}
          colorClass="text-amber-500"
          hint="Bills waiting on a person"
          isLoading={isLoading}
        />
        <StatCard
          title="Oldest"
          value={summary ? `${summary.worstDaysOverdue}d` : undefined}
          icon={Clock}
          colorClass="text-slate-400"
          hint="Past its due date"
          isLoading={isLoading}
        />
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFilter("all")}
            className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
              filter === "all"
                ? "bg-slate-900 text-white"
                : "bg-white border border-slate-200 text-slate-600 hover:border-slate-300"
            }`}
          >
            All {rows.length > 0 && `(${rows.length})`}
          </button>
          {STATE_ORDER.map((state) => {
            const count = summary?.byState?.[state] ?? 0
            return (
              <button
                key={state}
                onClick={() => setFilter(state)}
                disabled={count === 0}
                title={STATE[state].blurb}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  filter === state
                    ? "bg-slate-900 text-white"
                    : "bg-white border border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                {STATE[state].label} ({count})
              </button>
            )
          })}
        </div>
        <FindBox query={query} setQuery={setQuery} found={found.length} total={visible.length} />

        <div className="text-xs text-slate-400">
          {summary?.lastSyncedAt ? `Mirror last updated ${formatDate(summary.lastSyncedAt)}` : "Never synced"}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[26%]">Party</TableHead>
              <TableHead className="w-[16%]">Invoice</TableHead>
              <TableHead className="w-[12%] text-right">Balance</TableHead>
              <TableHead className="w-[10%] text-right">Overdue</TableHead>
              <TableHead className="w-[14%]">State</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-9" />
                  </TableCell>
                </TableRow>
              ))
            ) : found.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-sm text-slate-400">
                  Nothing outstanding here.
                </TableCell>
              </TableRow>
            ) : (
              found.map((row) => (
                <TableRow key={row.receivableId}>
                  <TableCell className="align-top">
                    <div className="text-sm font-medium text-slate-800">{row.partyName}</div>
                    <div className="text-[11px] text-slate-400">
                      {PARTY_LABEL[row.partyType] ?? row.partyType}
                    </div>
                    {/* The reason this module reads across outlets. Shown only
                        where it is a group finding rather than a restatement of
                        the balance already in the next column. */}
                    {row.groupExposure && (
                      <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-red-700">
                        <Building2 className="w-3 h-3" />
                        {rupees(row.groupExposure.totalBalance)} owed to the group
                        <span className="text-slate-400 font-normal">
                          ({row.groupExposure.outlets
                            .map((o) => `${o.showroomCode} ${rupees(o.balance)}`)
                            .join(" · ")})
                        </span>
                      </div>
                    )}
                  </TableCell>

                  <TableCell className="align-top">
                    <div className="text-xs font-mono text-slate-600">{row.dms.invoiceNo}</div>
                    <div className="text-[11px] text-slate-400">
                      {shortDate(row.dms.invoiceDate)} · due {shortDate(row.dms.dueDate)}
                    </div>
                    {row.dms.againstKey && (
                      <div className="text-[11px] text-slate-400 font-mono">{row.dms.againstKey}</div>
                    )}
                  </TableCell>

                  <TableCell className="align-top text-right">
                    <div className="text-sm font-semibold text-slate-900 tabular-nums">
                      {rupees(row.balance)}
                    </div>
                    {row.dms.receivedAmount ? (
                      <div className="text-[11px] text-slate-400 tabular-nums">
                        {rupees(row.dms.receivedAmount)} received
                      </div>
                    ) : null}
                  </TableCell>

                  <TableCell className="align-top text-right">
                    <Overdue days={row.daysOverdue} />
                  </TableCell>

                  <TableCell className="align-top">
                    <Badge variant={STATE[row.state].variant}>{STATE[row.state].label}</Badge>
                  </TableCell>

                  <TableCell className="align-top">
                    {row.actionRequired ? (
                      <div className="text-sm text-slate-800">{row.actionRequired}</div>
                    ) : (
                      <span className="text-xs text-slate-400">{row.note ?? "Nothing to do"}</span>
                    )}
                    {row.actionRequired && row.note && (
                      <div className="text-[11px] text-slate-400 mt-0.5">{row.note}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-3 mt-1.5">
                      {row.state !== "SETTLED" && row.state !== "DISPUTED" && (
                        <ActionButton
                          action="RECEIVABLE_LOG_CHASE"
                          target={{ showroomId: row.showroomId, recordKey: row.receivableId }}
                          label="Log a chase"
                          doneLabel="chased"
                          done={false}
                          tone="amber"
                        />
                      )}
                      {row.state !== "SETTLED" && (
                        <ActionButton
                          action="RECEIVABLE_MARK_DISPUTED"
                          target={{ showroomId: row.showroomId, recordKey: row.receivableId }}
                          label="Mark disputed"
                          doneLabel="disputed"
                          done={Boolean(row.ddms.disputedAt)}
                          tone="slate"
                        />
                      )}
                      {/* The statement is a customer-facing message, so no
                          rule can send it and the outbox will hold it for
                          somebody to read. That is the correct amount of
                          friction for a letter asking a party for money. */}
                      {row.state !== "SETTLED" && row.state !== "DISPUTED" && (
                        <DraftButton
                          template="RECEIVABLE_STATEMENT"
                          showroomId={row.showroomId}
                          recordKey={row.receivableId}
                          label="Draft a statement"
                        />
                      )}
                      <ExplainButton
                        module="RECEIVABLE"
                        showroomId={row.showroomId}
                        recordKey={row.receivableId}
                      />
                      <OpenCase module="RECEIVABLE" recordKey={row.receivableId} />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
