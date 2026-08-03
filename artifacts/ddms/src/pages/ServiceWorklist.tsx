/**
 * DDMS — the workshop worklist.
 *
 * The deal worklist compares two systems and shows the difference. This one has
 * nothing to compare against: the workshop's system records where the vehicle
 * is, and nothing anywhere records whether the customer was told. That absence
 * is what this screen reads.
 *
 * So the leading number is not a count of work — it is a count of unmade phone
 * calls, which is the same thing said honestly.
 */

import { useMemo, useState } from "react"
import {
  getGetServiceWorklistQueryKey,
  useGetServiceWorklist,
  type ServiceState,
  type ServiceWorklistRow,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { AlertTriangle, Clock, PhoneCall, Wrench } from "lucide-react"

const STATE: Record<
  ServiceState,
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft"; blurb: string }
> = {
  AWAITING_APPROVAL: { label: "Needs approval", variant: "destructive", blurb: "Work stopped until the customer approves" },
  AWAITING_PART: { label: "Waiting on a part", variant: "destructive", blurb: "Vehicle cannot move" },
  READY_UNCOLLECTED: { label: "Ready", variant: "warning", blurb: "Finished — has the customer been told?" },
  OVERDUE: { label: "Overdue", variant: "warning", blurb: "Past the promised date and still open" },
  FOLLOW_UP_DUE: { label: "Follow-up due", variant: "info", blurb: "Delivered, no follow-up call recorded" },
  ON_TRACK: { label: "On track", variant: "success", blurb: "Moving, promise not yet due" },
  CLOSED: { label: "Closed", variant: "draft", blurb: "Delivered and followed up" },
}

/** `2026-08-04` → `4 Aug`. The year is noise in a column about this week. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d)
}

/** The order a service manager would work them in. */
const STATE_ORDER: ServiceState[] = [
  "AWAITING_APPROVAL",
  "AWAITING_PART",
  "READY_UNCOLLECTED",
  "OVERDUE",
  "FOLLOW_UP_DUE",
  "ON_TRACK",
  "CLOSED",
]

function StatCard({
  title, value, icon: Icon, colorClass, hint, isLoading,
}: {
  title: string
  value?: string | number
  icon: typeof Wrench
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
          <Skeleton className="h-8 w-16 mt-1" />
        ) : (
          <>
            <div className="text-3xl font-bold text-slate-900 tabular-nums">{value ?? 0}</div>
            {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default function ServiceWorklist() {
  const [filter, setFilter] = useState<ServiceState | "all">("all")
  const { selected } = useShowroom()

  const params = { showroomId: selected?.id ?? 0 }
  const { data, isLoading } = useGetServiceWorklist(params, {
    query: { queryKey: getGetServiceWorklistQueryKey(params), enabled: Boolean(selected) },
  })

  const rows: ServiceWorklistRow[] = data?.rows ?? []
  const summary = data?.summary

  const visible = useMemo(() => {
    const filtered = filter === "all" ? rows : rows.filter((r) => r.state === filter)
    return [...filtered].sort((a, b) => {
      const byState = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
      return byState !== 0 ? byState : b.daysLate - a.daysLate
    })
  }, [rows, filter])

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Service &amp; warranty</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Every open job card, and what it needs from a person. Almost all of it
          is a phone call nobody has made.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Open job cards"
          value={summary ? summary.total - (summary.byState.CLOSED ?? 0) : undefined}
          icon={Wrench}
          colorClass="text-blue-500"
          isLoading={isLoading}
        />
        <StatCard
          title="Calls to make"
          value={summary?.needsAction}
          icon={PhoneCall}
          colorClass="text-amber-500"
          hint="Job cards waiting on a person"
          isLoading={isLoading}
        />
        <StatCard
          title="Ready, not collected"
          value={summary?.readyUncollected}
          icon={AlertTriangle}
          colorClass="text-red-500"
          hint="Finished work, occupied bays"
          isLoading={isLoading}
        />
        <StatCard
          title="Worst overrun"
          value={summary ? `${summary.worstDaysLate}d` : undefined}
          icon={Clock}
          colorClass="text-slate-400"
          hint="Past the promised date"
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
            const count = summary?.byState[state] ?? 0
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
        <div className="text-xs text-slate-400">
          {summary?.lastSyncedAt
            ? `Mirror last updated ${formatDate(summary.lastSyncedAt)}`
            : "Never synced"}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[26%]">Job card</TableHead>
              <TableHead className="w-[16%]">Workshop status</TableHead>
              <TableHead className="w-20 text-right">Promised</TableHead>
              <TableHead className="w-[14%]">State</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-9 w-44" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-10 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-56" /></TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <Wrench className="w-8 h-8 text-slate-300" />
                    <span>
                      {rows.length === 0
                        ? "No job cards mirrored yet. Run a sync from the Worklist screen."
                        : "Nothing in this state."}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => {
                const tone = STATE[row.state]
                return (
                  <TableRow key={`${row.dealerCode}:${row.jcNo}`}>
                    <TableCell className="align-top">
                      <div className="font-mono text-[11px] text-slate-500">{row.jcNo}</div>
                      <div className="font-semibold text-slate-900 text-sm mt-0.5">
                        {row.customerName ?? "—"}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.modelDescription ?? "—"}
                        {row.regNo && <span className="font-mono ml-1.5">{row.regNo}</span>}
                      </div>
                    </TableCell>

                    <TableCell className="align-top bg-slate-50/60">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        {row.dms.status.replace(/_/g, " ").toLowerCase()}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {row.jcType.replace(/_/g, " ").toLowerCase()}
                        {row.dms.hasUnissuedPart && (
                          <span className="text-red-600 font-medium"> · part not issued</span>
                        )}
                      </div>
                      {row.advisorEmpCode && (
                        <div className="text-[11px] text-slate-400 font-mono">{row.advisorEmpCode}</div>
                      )}
                    </TableCell>

                    {/* The promise is what the workshop is judged on, so the
                        overrun gets the emphasis rather than the date. */}
                    <TableCell className="align-top text-right">
                      {row.daysLate > 0 ? (
                        <span
                          className={`text-sm font-semibold tabular-nums ${
                            row.daysLate >= 5 ? "text-red-600" : "text-amber-600"
                          }`}
                        >
                          +{row.daysLate}d
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400 whitespace-nowrap">
                          {shortDate(row.dms.promisedDate)}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className="align-top">
                      <Badge variant={tone.variant}>{tone.label}</Badge>
                      {row.ddms.customerInformedAt && (
                        <div className="text-[11px] text-green-700 mt-1">customer told</div>
                      )}
                    </TableCell>

                    <TableCell className="align-top">
                      {row.actionRequired ? (
                        <div className="flex items-start gap-2">
                          <PhoneCall
                            className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                              row.state === "AWAITING_APPROVAL" || row.state === "AWAITING_PART"
                                ? "text-red-500"
                                : "text-amber-500"
                            }`}
                          />
                          <div>
                            <div className="text-sm text-slate-800">{row.actionRequired}</div>
                            {row.note && (
                              <div className="text-[11px] text-slate-400 mt-0.5">{row.note}</div>
                            )}
                            {row.customerMobile && (
                              <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                                {row.customerMobile}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">{row.note ?? "Nothing to do"}</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <p className="text-xs text-slate-400 max-w-3xl">
        The workshop's system records where a vehicle is. Nothing in it records
        whether anyone told the customer — that is not a workshop event, which is
        why a finished bike can sit finished for four days. The
        &ldquo;customer told&rdquo; mark is ours, and it is the only reason this
        screen can tell waiting-on-them from waiting-on-us.
      </p>
    </div>
  )
}
