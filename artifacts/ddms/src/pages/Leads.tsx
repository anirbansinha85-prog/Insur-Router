/**
 * DDMS — enquiries.
 *
 * Two numbers on this screen do not exist anywhere in the dealership:
 *
 *   the manufacturer response clock — a lead the OEM generated and pushed down
 *   is timed, and future allocation depends on hitting the window. Their CRM
 *   records when contact happened; nothing counts minutes on a lead nobody has
 *   opened, because no screen watches an empty field.
 *
 *   leads with no owner — the CRM keeps showing the executive's name after they
 *   leave. Their CRM knows the assignment, their HR records know the leaving
 *   date, and neither knows both.
 *
 * The second is the staff-shortage argument in its concrete form: not "we are
 * stretched" but "these customers have nobody looking at them".
 */

import { useMemo, useState } from "react"
import {
  getGetLeadWorklistQueryKey,
  useGetLeadWorklist,
  type LeadState,
  type LeadWorklistRow,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { AssignPicker, ContactButtons } from "@/lib/actions"
import { DraftButton } from "@/lib/messages"
import { ExplainButton } from "@/lib/explain"
import { AlertTriangle, PhoneCall, Timer, UserX, Users } from "lucide-react"

const STATE: Record<
  LeadState,
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft"; blurb: string }
> = {
  SLA_BREACHED: { label: "Window missed", variant: "destructive", blurb: "The manufacturer's response window closed" },
  CLOCK_RUNNING: { label: "Clock running", variant: "warning", blurb: "Manufacturer lead, window still open" },
  NO_OWNER: { label: "No owner", variant: "destructive", blurb: "Assigned to someone who left" },
  UNCONTACTED: { label: "Uncontacted", variant: "warning", blurb: "Nobody has made contact" },
  FOLLOW_UP_OVERDUE: { label: "Follow-up overdue", variant: "warning", blurb: "The follow-up date has passed" },
  ON_TRACK: { label: "On track", variant: "success", blurb: "Being worked" },
  CONVERTED: { label: "Booked", variant: "success", blurb: "Converted to a deal" },
  LOST: { label: "Lost", variant: "draft", blurb: "Closed" },
}

const STATE_ORDER: LeadState[] = [
  "CLOCK_RUNNING",
  "SLA_BREACHED",
  "NO_OWNER",
  "UNCONTACTED",
  "FOLLOW_UP_OVERDUE",
  "ON_TRACK",
  "CONVERTED",
  "LOST",
]

function StatCard({
  title, value, icon: Icon, colorClass, hint, isLoading, alarming,
}: {
  title: string
  value?: string | number
  icon: typeof Users
  colorClass: string
  hint?: string
  isLoading: boolean
  alarming?: boolean
}) {
  return (
    <Card className={alarming ? "border-red-200 bg-red-50/40" : undefined}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-semibold text-slate-500">{title}</CardTitle>
        <Icon className={`w-4 h-4 ${colorClass}`} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16 mt-1" />
        ) : (
          <>
            <div className={`text-3xl font-bold tabular-nums ${alarming ? "text-red-700" : "text-slate-900"}`}>
              {value ?? 0}
            </div>
            {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Minutes as something a person reads: 244 → "4h 4m". */
function humanMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—"
  const abs = Math.abs(m)
  if (abs < 60) return `${abs}m`
  const h = Math.floor(abs / 60)
  const rem = abs % 60
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}

export default function Leads() {
  const [filter, setFilter] = useState<LeadState | "all">("all")
  const { selected } = useShowroom()

  const params = { showroomId: selected?.id ?? 0 }
  const { data, isLoading } = useGetLeadWorklist(params, {
    query: { queryKey: getGetLeadWorklistQueryKey(params), enabled: Boolean(selected) },
  })

  const rows: LeadWorklistRow[] = data?.rows ?? []
  const summary = data?.summary

  const visible = useMemo(() => {
    const filtered = filter === "all" ? rows : rows.filter((r) => r.state === filter)
    return [...filtered].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state))
  }, [rows, filter])

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Enquiries</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Every live lead, how long the manufacturer's clock has left, and which
          ones have nobody on them.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Window missed"
          value={summary?.slaBreached}
          icon={Timer}
          colorClass="text-red-500"
          hint={summary ? `Against a ${summary.slaMinutes}-minute mandate` : undefined}
          isLoading={isLoading}
          alarming={Boolean(summary && summary.slaBreached > 0)}
        />
        <StatCard
          title="Leads with no owner"
          value={summary?.orphaned}
          icon={UserX}
          colorClass="text-red-500"
          hint="Assigned to someone who left"
          isLoading={isLoading}
          alarming={Boolean(summary && summary.orphaned > 0)}
        />
        <StatCard
          title="Calls to make"
          value={summary?.needsAction}
          icon={PhoneCall}
          colorClass="text-amber-500"
          isLoading={isLoading}
        />
        <StatCard
          title="Live enquiries"
          value={
            summary
              ? summary.total - (summary.byState.CONVERTED ?? 0) - (summary.byState.LOST ?? 0)
              : undefined
          }
          icon={Users}
          colorClass="text-blue-500"
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
          {summary?.lastSyncedAt ? `Mirror last updated ${formatDate(summary.lastSyncedAt)}` : "Never synced"}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[24%]">Enquiry</TableHead>
              <TableHead className="w-[15%]">Source &amp; stage</TableHead>
              <TableHead className="w-[16%]">Owner</TableHead>
              <TableHead className="w-24 text-right">Response</TableHead>
              <TableHead className="w-[14%]">State</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-9 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-52" /></TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <Users className="w-8 h-8 text-slate-300" />
                    <span>
                      {rows.length === 0
                        ? "No enquiries mirrored yet. Run a sync from the Worklist screen."
                        : "Nothing in this state."}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => {
                const tone = STATE[row.state]
                const oem = row.dms.source === "OEM_PORTAL"
                // The spec allows null *or* absent; collapse both so the
                // rendering below has one thing to test.
                const toSla = row.minutesToSla ?? null
                return (
                  <TableRow key={`${row.dealerCode}:${row.enqId}`}>
                    <TableCell className="align-top">
                      <div className="font-mono text-[11px] text-slate-500">{row.enqId}</div>
                      <div className="font-semibold text-slate-900 text-sm mt-0.5">
                        {row.customerName ?? "—"}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.modelInterest ?? "—"}
                        {row.customerMobile && (
                          <span className="font-mono ml-1.5">{row.customerMobile}</span>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="align-top bg-slate-50/60">
                      <div
                        className={`text-xs font-semibold uppercase tracking-wide ${
                          oem ? "text-blue-700" : "text-slate-600"
                        }`}
                      >
                        {row.dms.source.replace(/_/g, " ").toLowerCase()}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {row.dms.stage.replace(/_/g, " ").toLowerCase()}
                        {row.dms.grade && <span className="ml-1.5">· {row.dms.grade.toLowerCase()}</span>}
                      </div>
                    </TableCell>

                    <TableCell className="align-top">
                      <div
                        className={`text-xs ${
                          row.dms.assignedEmpActive ? "text-slate-700" : "text-red-700 font-semibold"
                        }`}
                      >
                        {row.dms.assignedEmpName ?? row.dms.assignedEmpCode ?? "—"}
                      </div>
                      {!row.dms.assignedEmpActive && row.dms.assignedEmpLeftOn && (
                        <div className="text-[11px] text-red-600">left {row.dms.assignedEmpLeftOn}</div>
                      )}
                      {row.ddms.reassignedToEmpCode && (
                        <div className="text-[11px] text-green-700 font-mono">
                          → {row.ddms.reassignedToEmpCode}
                        </div>
                      )}
                    </TableCell>

                    {/* The manufacturer's clock. Only meaningful on OEM leads,
                        so everything else stays blank rather than inventing a
                        number that reads like a target. */}
                    <TableCell className="align-top text-right">
                      {oem ? (
                        <>
                          <div
                            className={`text-sm font-semibold tabular-nums ${
                              toSla !== null && toSla <= 0 ? "text-red-600" : "text-amber-600"
                            }`}
                          >
                            {humanMinutes(row.responseMinutes)}
                          </div>
                          {toSla !== null && (
                            <div className="text-[11px] text-slate-400">
                              {toSla > 0 ? `${toSla}m left` : `${Math.abs(toSla)}m over`}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </TableCell>

                    <TableCell className="align-top">
                      <Badge variant={tone.variant}>{tone.label}</Badge>
                    </TableCell>

                    <TableCell className="align-top">
                      {row.actionRequired ? (
                        <div className="flex items-start gap-2">
                          <AlertTriangle
                            className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                              row.state === "SLA_BREACHED" || row.state === "NO_OWNER"
                                ? "text-red-500"
                                : "text-amber-500"
                            }`}
                          />
                          <div className="min-w-0">
                            <div className="text-sm text-slate-800">{row.actionRequired}</div>
                            {row.note && (
                              <div className="text-[11px] text-slate-400 mt-0.5">{row.note}</div>
                            )}

                            {/* The honest limit, and only when it is true: we
                                have a contact logged and their CRM does not.
                                The integration is read-only, so the OEM's clock
                                is still running however diligent we have been —
                                and a screen that implied otherwise would tell
                                an owner they were compliant while the
                                manufacturer's report said they were not. */}
                            {row.slaNote && (
                              <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                                {row.slaNote}
                              </div>
                            )}

                            <div className="flex flex-wrap items-center gap-3 mt-1.5">
                              <ContactButtons
                                target={{ showroomId: row.showroomId, recordKey: row.enqId }}
                                mobile={row.customerMobile}
                                contactedAt={row.ddms.contactedAt}
                                customerName={row.customerName}
                              />
                              {/* Offered whenever the assigned executive has
                                  left, not only in the NO_OWNER state — a lead
                                  can be both orphaned and breaching, and the
                                  state can only name one of those. */}
                              {!row.dms.assignedEmpActive && (
                                <AssignPicker
                                  action="ENQUIRY_REASSIGN"
                                  target={{ showroomId: row.showroomId, recordKey: row.enqId }}
                                  role="SALES_EXEC"
                                  currentEmpCode={row.ddms.reassignedToEmpCode}
                                  currentLabel={row.ddms.reassignedToEmpCode ? `reassigned` : null}
                                />
                              )}
                              {/* Reassigning an orphaned lead is only half of
                                  it — the person it landed on has to find out,
                                  and on a screen about leads nobody is working
                                  that is the half that was missing. */}
                              {row.ddms.reassignedToEmpCode && (
                                <DraftButton
                                  template="LEAD_HANDOVER"
                                  showroomId={row.showroomId}
                                  recordKey={row.enqId}
                                  label="Email them"
                                />
                              )}
                              <ExplainButton
                                module="ENQUIRY"
                                showroomId={row.showroomId}
                                recordKey={row.enqId}
                              />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <span className="text-xs text-slate-400">{row.note ?? "Nothing to do"}</span>
                          {row.ddms.contactedAt && (
                            <div className="mt-1.5">
                              <ContactButtons
                                target={{ showroomId: row.showroomId, recordKey: row.enqId }}
                                mobile={row.customerMobile}
                                contactedAt={row.ddms.contactedAt}
                              />
                            </div>
                          )}
                        </div>
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
        A manufacturer-generated lead is timed, and how fast the dealership answers
        decides how many it gets next quarter. Nobody sits watching a thirty-minute
        clock on a Tuesday afternoon — which is why this is a screen and not a
        habit.
      </p>
    </div>
  )
}
