/**
 * DDMS — the registration desk.
 *
 * The deal worklist compares two systems and shows the difference. The service
 * worklist reads an absence — nothing records whether the customer was told.
 * This screen does something the other two do not: it puts a **cause** and a
 * **consequence** in the same row.
 *
 * The cause is why the file is not moving, and it has an owner — the RTO, the
 * insurance desk, the customer, accounts, the agent. The consequence is a
 * temporary registration running out, which does not care what the cause is and
 * makes every one of them more urgent. A screen that could only say one of the
 * two would keep hiding whichever it decided was less important, which is
 * exactly what the first draft of the derivation did.
 *
 * The leading number is registration certificates in the drawer. Not a backlog,
 * not a queue — a specific plastic card, in this building, that its owner has
 * never seen.
 */

import { useMemo, useState } from "react"
import { Link } from "wouter"
import {
  getGetRegistrationWorklistQueryKey,
  useGetRegistrationWorklist,
  type RegistrationState,
  type RegistrationWorklistRow,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { ActionButton, AssignPicker } from "@/lib/actions"
import { DraftButton } from "@/lib/messages"
import { AlertTriangle, FileText, IdCard, ShieldAlert, Wallet } from "lucide-react"

const STATE: Record<
  RegistrationState,
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft"; blurb: string }
> = {
  OBJECTION: { label: "RTO objection", variant: "destructive", blurb: "Sent back by the RTO and not reworked" },
  BLOCKED_NO_INSURANCE: { label: "No policy", variant: "destructive", blurb: "The RTO will not take the file without one" },
  AWAITING_DOCS: { label: "Waiting on customer", variant: "warning", blurb: "A document is still outstanding" },
  TAX_HELD: { label: "Road tax unpaid", variant: "warning", blurb: "Collected from the customer, not remitted" },
  RC_IN_DRAWER: { label: "Certificate here", variant: "warning", blurb: "The card is in the office, the customer is not" },
  RTO_SILENT: { label: "No word from RTO", variant: "info", blurb: "Lodged and nothing back" },
  HSRP_PENDING: { label: "Plate not fitted", variant: "info", blurb: "Registered, no high-security plate" },
  ON_TRACK: { label: "On track", variant: "success", blurb: "Moving, nothing outstanding" },
  CLOSED: { label: "Closed", variant: "draft", blurb: "Certificate handed over" },
}

/** The order a registration clerk would work them in. */
const STATE_ORDER: RegistrationState[] = [
  "OBJECTION",
  "BLOCKED_NO_INSURANCE",
  "AWAITING_DOCS",
  "TAX_HELD",
  "RC_IN_DRAWER",
  "RTO_SILENT",
  "HSRP_PENDING",
  "ON_TRACK",
  "CLOSED",
]

const INSUR_ROUTER_URL =
  import.meta.env.VITE_INSUR_ROUTER_URL ?? "http://localhost:24791"

/** `2026-08-04` → `4 Aug`. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d)
}

function rupees(n: number | null | undefined): string {
  if (!n) return "—"
  return `₹${Math.round(n).toLocaleString("en-IN")}`
}

function StatCard({
  title, value, icon: Icon, colorClass, hint, isLoading,
}: {
  title: string
  value?: string | number
  icon: typeof FileText
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

/**
 * The temporary registration, as a countdown rather than a date.
 *
 * A date tells you nothing without doing the arithmetic, and the arithmetic is
 * the whole point: below zero the customer is riding a vehicle with no valid
 * registration, and that is the dealership's exposure before it is theirs.
 */
function TempReg({
  daysLeft,
  regNo,
}: {
  // Optional as well as nullable: the generated types mark anything outside the
  // spec's `required` list as possibly undefined, and conflating the two here
  // would only push the null check into every call site.
  daysLeft: number | null | undefined
  regNo: string | null | undefined
}) {
  if (regNo) {
    return <span className="text-xs text-slate-400 font-mono whitespace-nowrap">{regNo}</span>
  }
  if (daysLeft === null || daysLeft === undefined) {
    return <span className="text-xs text-slate-300">no temp reg</span>
  }
  if (daysLeft < 0) {
    return (
      <span className="text-sm font-semibold text-red-600 tabular-nums whitespace-nowrap">
        lapsed {-daysLeft}d
      </span>
    )
  }
  return (
    <span
      className={`text-sm font-semibold tabular-nums whitespace-nowrap ${
        daysLeft <= 7 ? "text-amber-600" : "text-slate-400"
      }`}
    >
      {daysLeft}d left
    </span>
  )
}

export default function Registrations() {
  const [filter, setFilter] = useState<RegistrationState | "all">("all")
  const { selected } = useShowroom()

  const params = { showroomId: selected?.id ?? 0 }
  const { data, isLoading } = useGetRegistrationWorklist(params, {
    query: { queryKey: getGetRegistrationWorklistQueryKey(params), enabled: Boolean(selected) },
  })

  const rows: RegistrationWorklistRow[] = data?.rows ?? []
  const summary = data?.summary

  const visible = useMemo(() => {
    const filtered = filter === "all" ? rows : rows.filter((r) => r.state === filter)
    // Cause first, then age — on this screen nothing is urgent because it is new.
    return [...filtered].sort((a, b) => {
      const byState = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
      return byState !== 0 ? byState : b.ageDays - a.ageDays
    })
  }, [rows, filter])

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Registration &amp; RC</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Every open RTO file, why it stopped, and whose desk it is on.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Certificates in the drawer"
          value={summary?.rcInDrawer}
          icon={IdCard}
          colorClass="text-red-500"
          hint="Here, and the customer does not have it"
          isLoading={isLoading}
        />
        <StatCard
          title="Riding unregistered"
          value={summary?.tempRegLapsed}
          icon={AlertTriangle}
          colorClass="text-red-500"
          hint={
            summary && summary.tempRegAtRisk > 0
              ? `${summary.tempRegAtRisk} more expiring this week`
              : "Temporary registration lapsed"
          }
          isLoading={isLoading}
        />
        <StatCard
          title="Blocked on insurance"
          value={summary?.blockedOnInsurance}
          icon={ShieldAlert}
          colorClass="text-amber-500"
          hint="Nothing else on the file can move"
          isLoading={isLoading}
        />
        <StatCard
          title="Road tax held"
          value={summary ? rupees(summary.taxHeldAmount) : undefined}
          icon={Wallet}
          colorClass="text-amber-500"
          hint="Customers' money, not yet paid to the RTO"
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
              <TableHead className="w-[26%]">File</TableHead>
              <TableHead className="w-[16%]">RTO status</TableHead>
              <TableHead className="w-24 text-right">Temp reg</TableHead>
              <TableHead className="w-[15%]">Stuck on</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-9 w-44" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-56" /></TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <FileText className="w-8 h-8 text-slate-300" />
                    <span>
                      {rows.length === 0
                        ? "No registration files mirrored yet. Run a sync from the Deals screen."
                        : "Nothing in this state."}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => {
                const tone = STATE[row.state]
                const severe =
                  row.state === "OBJECTION" ||
                  row.state === "BLOCKED_NO_INSURANCE" ||
                  (row.tempRegDaysLeft != null && row.tempRegDaysLeft < 0)

                return (
                  <TableRow key={`${row.dealerCode}:${row.regnFileNo}`}>
                    <TableCell className="align-top">
                      <div className="font-mono text-[11px] text-slate-500">{row.regnFileNo}</div>
                      <div className="font-semibold text-slate-900 text-sm mt-0.5">
                        {row.customerName ?? "—"}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.modelDescription ?? "—"}
                        <span className="text-slate-300 ml-1.5">· {row.ageDays}d open</span>
                      </div>
                    </TableCell>

                    <TableCell className="align-top bg-slate-50/60">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        {row.dms.status.replace(/_/g, " ").toLowerCase()}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {row.dms.rtoCode ?? "—"}
                        {row.dms.submittedDate && (
                          <span> · lodged {shortDate(row.dms.submittedDate)}</span>
                        )}
                      </div>
                      {row.agentEmpCode ? (
                        <div className="text-[11px] text-slate-400 font-mono">{row.agentEmpCode}</div>
                      ) : (
                        <div className="text-[11px] text-amber-600">no agent assigned</div>
                      )}
                      {/* Their agentEmpCode is read-only. Ours says who is
                          working it today, which is a decision a dealership
                          with one RTO agent and forty open files has nowhere
                          else to put. */}
                      <div className="mt-1.5">
                        <AssignPicker
                          action="REGISTRATION_ASSIGN_AGENT"
                          target={{ showroomId: row.showroomId, recordKey: row.regnFileNo }}
                          role="RTO_AGENT"
                          currentEmpCode={row.ddms.assignedAgentEmpCode}
                          currentLabel={row.ddms.assignedAgentEmpCode}
                          placeholder="Assign…"
                        />
                      </div>
                      {/* Assigning a file changes who owns it; this is what
                          tells them. It appears only once somebody is assigned,
                          which is what keeps it a notification rather than a
                          broadcast — and it is the one message a rule will send
                          without anybody reading it first. */}
                      {row.ddms.assignedAgentEmpCode && (
                        <div className="mt-1.5">
                          <DraftButton
                            template="REGISTRATION_AGENT_ASSIGNED"
                            showroomId={row.showroomId}
                            recordKey={row.regnFileNo}
                            label="Email the agent"
                          />
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="align-top text-right">
                      <TempReg daysLeft={row.tempRegDaysLeft} regNo={row.dms.regNo} />
                    </TableCell>

                    <TableCell className="align-top">
                      <Badge variant={tone.variant}>{tone.label}</Badge>
                      {row.ddms.rtoChasedAt && (
                        <div className="text-[11px] text-green-700 mt-1">chased</div>
                      )}
                    </TableCell>

                    <TableCell className="align-top">
                      {row.actionRequired ? (
                        <div className="flex items-start gap-2">
                          <AlertTriangle
                            className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                              severe ? "text-red-500" : "text-amber-500"
                            }`}
                          />
                          <div>
                            <div className="text-sm text-slate-800">{row.actionRequired}</div>
                            {row.note && (
                              <div className="text-[11px] text-slate-400 mt-0.5">{row.note}</div>
                            )}
                            {/* The one blockage on this screen that is ours to
                                clear, so it gets a way out rather than advice. */}
                            {row.state === "BLOCKED_NO_INSURANCE" && (
                              <Link
                                href="/worklist"
                                className="inline-block text-[11px] font-semibold text-blue-600 hover:text-blue-700 mt-1"
                              >
                                Open {row.dealId} on the insurance queue →
                              </Link>
                            )}
                            {row.state === "TAX_HELD" && row.taxHeldAmount && (
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                {rupees(row.taxHeldAmount)} collected{" "}
                                {shortDate(row.dms.roadTaxCollectedDate)}
                              </div>
                            )}
                            {row.customerMobile && row.state === "RC_IN_DRAWER" && (
                              <a
                                href={`tel:${row.customerMobile}`}
                                className="block text-[11px] font-mono text-blue-600 hover:text-blue-700 mt-0.5"
                              >
                                {row.customerMobile}
                              </a>
                            )}

                            <div className="flex flex-wrap items-center gap-3 mt-1.5">
                              {row.state === "RC_IN_DRAWER" && (
                                <ActionButton
                                  action="REGISTRATION_MARK_NOTIFIED"
                                  target={{ showroomId: row.showroomId, recordKey: row.regnFileNo }}
                                  label="Mark customer told"
                                  doneLabel="customer told"
                                  done={Boolean(row.ddms.customerNotifiedAt)}
                                />
                              )}
                              {row.state === "RC_IN_DRAWER" && !row.ddms.customerNotifiedAt && (
                                <DraftButton
                                  template="REGISTRATION_RC_READY"
                                  showroomId={row.showroomId}
                                  recordKey={row.regnFileNo}
                                  label="Draft a message"
                                />
                              )}
                              {/* Recency, not presence — the derived state asks
                                  when it was last chased, so this is worth
                                  pressing again on a file chased a fortnight
                                  ago. */}
                              {(row.state === "RTO_SILENT" || row.dms.submittedDate) && (
                                <ActionButton
                                  action="REGISTRATION_LOG_CHASE"
                                  target={{ showroomId: row.showroomId, recordKey: row.regnFileNo }}
                                  label="Log a chase"
                                  doneLabel="chased"
                                  done={false}
                                  tone="slate"
                                />
                              )}
                            </div>
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
        The dealer's system treats a vehicle as finished when the RTO allots a
        number, because that is when the sale can be reported. Whether the
        customer ever received the certificate is two fields further down the
        same record, and no screen in the building puts them next to each other.
        Road tax is the same shape: collected on one date, remitted on another,
        and nothing anywhere subtracts the two. Both numbers above are the
        dealership's own data, read a way nobody had reason to read it.{" "}
        <a
          href={INSUR_ROUTER_URL}
          className="text-blue-600 hover:text-blue-700 font-medium"
          target="_blank"
          rel="noreferrer"
        >
          InsurRouter
        </a>{" "}
        clears the insurance blockage; the rest need a person.
      </p>
    </div>
  )
}
