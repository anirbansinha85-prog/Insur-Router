/**
 * DDMS — the owner's worklist.
 *
 * Two systems hold an opinion about every deal, and until now the difference
 * between them was invisible. This screen puts them side by side and leads with
 * the difference, because the difference is the work.
 *
 * The integration is read-only, so `AHEAD` — we issued a policy, the dealer's
 * system has not been told — is the *expected* state, not a fault. It is
 * rendered as a task carrying the exact number to key in, since typing it back
 * is the one thing the software cannot do.
 */

import { useMemo, useState } from "react"
import {
  getGetShowroomPanelQueryKey,
  getGetShowroomWorklistQueryKey,
  useGetShowroomPanel,
  useGetShowroomWorklist,
  useStartApplicationFromDeal,
  useSyncShowroomDms,
  type ReconcileState,
  type WorklistRow,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  Play,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  Store,
} from "lucide-react"
import { FindBox, rowText, useFind } from "@/lib/find"

/**
 * How each reconcile state should read at a glance.
 *
 * CONFLICT is the only destructive one: two policy numbers on one vehicle is a
 * real problem with money attached. AHEAD is amber rather than red — it means
 * the work is *done*, just not written down in their system yet.
 */
const RECONCILE: Record<
  ReconcileState,
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft"; blurb: string }
> = {
  IN_SYNC: { label: "In sync", variant: "success", blurb: "Both systems agree" },
  AHEAD: { label: "Ahead", variant: "warning", blurb: "We issued it; the DMS has not been told" },
  BEHIND: { label: "Behind", variant: "info", blurb: "The DMS has a policy we did not issue" },
  CONFLICT: { label: "Conflict", variant: "destructive", blurb: "Two different policies on one vehicle" },
  NOT_STARTED: { label: "Not started", variant: "draft", blurb: "No insurance either side" },
}

const RECONCILE_ORDER: ReconcileState[] = [
  "CONFLICT",
  "AHEAD",
  "BEHIND",
  "NOT_STARTED",
  "IN_SYNC",
]

function StatCard({
  title,
  value,
  icon: Icon,
  colorClass,
  hint,
  isLoading,
}: {
  title: string
  value?: string | number
  icon: typeof ListChecks
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

/** One system's opinion, rendered identically on both sides so they compare. */
function SystemView({
  status,
  policy,
  detail,
  simulated,
}: {
  status: string | null | undefined
  policy: string | null | undefined
  detail?: string | null
  simulated?: boolean
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        {status ? status.replace(/_/g, " ").toLowerCase() : <span className="text-slate-300 normal-case">nothing</span>}
      </div>
      {policy ? (
        <div className="font-mono text-[11px] text-slate-900 break-all">
          {policy}
          {simulated && (
            <span className="ml-1.5 text-amber-700 font-sans font-semibold not-italic">simulated</span>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-slate-400 italic">no policy</div>
      )}
      {detail && <div className="text-[11px] text-slate-400">{detail}</div>}
    </div>
  )
}

/**
 * Where InsurRouter lives.
 *
 * DDMS links *out* to it rather than routing to it, because they are separate
 * services now. Hardcoded to the local dev origin until there is a real service
 * registry — and hardcoded visibly here rather than buried, so it is one edit
 * when that arrives.
 */
const INSUR_ROUTER_ORIGIN = "http://localhost:24791"

/** What went wrong starting one application, kept against the row that failed. */
interface StartFailure {
  dealId: string
  message: string
  missing: string[]
}

export default function Worklist() {
  const queryClient = useQueryClient()
  const [pendingDeal, setPendingDeal] = useState<string | null>(null)
  const [startError, setStartError] = useState<StartFailure | null>(null)
  const [filter, setFilter] = useState<ReconcileState | "all">("all")
  const { selected } = useShowroom()

  const worklistParams = { showroomId: selected?.id ?? 0 }
  const { data, isLoading, isFetching } = useGetShowroomWorklist(worklistParams, {
    query: {
      queryKey: getGetShowroomWorklistQueryKey(worklistParams),
      enabled: Boolean(selected),
    },
  })

  const { data: panel } = useGetShowroomPanel(selected?.id ?? 0, {
    query: {
      queryKey: getGetShowroomPanelQueryKey(selected?.id ?? 0),
      enabled: Boolean(selected),
    },
  })

  const sync = useSyncShowroomDms()
  const start = useStartApplicationFromDeal()

  /**
   * Create the application, then take the user to it.
   *
   * The worklist is refreshed first so the row has already changed state behind
   * them — coming back to a list that still says "not started" would read as
   * the button not having worked.
   */
  const startApplication = (dealId: string) => {
    setPendingDeal(dealId)
    setStartError(null)
    start.mutate(
      { dealId },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: ["/api/dms/worklist"] })
          window.open(`${INSUR_ROUTER_ORIGIN}/applications/${res.applicationId}`, "_blank")
        },
        onError: (err) => {
          const data = (err as { data?: unknown }).data as
            | { error?: string; errors?: string[]; applicationId?: number }
            | undefined
          // 409 is not really a failure — the work exists, just not from this
          // click. Send them to it rather than showing them an error.
          if (data?.applicationId) {
            queryClient.invalidateQueries({ queryKey: ["/api/dms/worklist"] })
            window.open(`${INSUR_ROUTER_ORIGIN}/applications/${data.applicationId}`, "_blank")
            return
          }
          setStartError({
            dealId,
            message: data?.error ?? "Could not start the application.",
            missing: data?.errors ?? [],
          })
        },
        onSettled: () => setPendingDeal(null),
      },
    )
  }

  const rows: WorklistRow[] = data?.rows ?? []
  const summary = data?.summary

  // Sorted so the console leads with what needs a human: conflicts, then work
  // we have done that their system does not know about, then everything else —
  // and within a group, whatever has been sitting longest.
  const visible = useMemo(() => {
    const filtered = filter === "all" ? rows : rows.filter((r) => r.reconcile === filter)
    return [...filtered].sort((a, b) => {
      const byState = RECONCILE_ORDER.indexOf(a.reconcile) - RECONCILE_ORDER.indexOf(b.reconcile)
      return byState !== 0 ? byState : b.daysInStatus - a.daysInStatus
    })
  }, [rows, filter])

  // Searched *after* the state filter rather than instead of it: the chips
  // narrow to a kind of problem and the box finds one record, and somebody who
  // has picked a chip and then typed a name means both.
  const { query, setQuery, found } = useFind(visible, rowText)

  const handleSync = () => {
    if (!selected) return
    sync.mutate(
      { showroomId: selected.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/dms/worklist"] })
        },
      },
    )
  }

  const syncError = sync.error as { data?: { error?: string } } | null

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Deals &amp; issuance</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Every deal in the dealer's system, next to what we know about it. The
            difference between the two columns is the work.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="accent"
            className="gap-2"
            onClick={handleSync}
            disabled={!selected || sync.isPending || selected.dmsAccounts.length === 0}
          >
            <RefreshCw className={`w-4 h-4 ${sync.isPending ? "animate-spin" : ""}`} />
            {sync.isPending ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      </div>

      {/* A showroom with no dealer code cannot be synced. Say so rather than
          leaving an empty table to be read as "nothing to do today". */}
      {selected && selected.dmsAccounts.length === 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <span className="font-semibold">{selected.name} is not wired to a DMS.</span>{" "}
          There is no dealer code linked to it, so there is nothing to pull. This is a
          setup gap, not an empty yard.
        </div>
      )}

      {syncError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <span className="font-semibold">Sync failed.</span>{" "}
          {syncError.data?.error ?? "The dealer's system did not answer."} The table
          below still shows the last successful pull.
        </div>
      )}

      {sync.isSuccess && !sync.isPending && (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          {sync.data.results
            .map(
              (r) =>
                `${r.dealerCode}: ${r.seen} deals seen — ${r.added} new, ${r.changed} changed, ` +
                `${r.unchanged} unchanged, ${r.disappeared} gone (${r.durationMs}ms)`,
            )
            .join(" · ")}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard
          title="Deals"
          value={summary?.total}
          icon={ListChecks}
          colorClass="text-blue-500"
          isLoading={isLoading}
        />
        <StatCard
          title="Need action"
          value={summary?.needsAction}
          icon={ArrowRight}
          colorClass="text-amber-500"
          hint="Rows with something to do"
          isLoading={isLoading}
        />
        <StatCard
          title="Conflicts"
          value={summary?.byReconcile.CONFLICT ?? 0}
          icon={ShieldAlert}
          colorClass="text-red-500"
          hint="Two policies, one vehicle"
          isLoading={isLoading}
        />
        <StatCard
          title="Oldest"
          value={summary ? `${summary.oldestDaysInStatus}d` : undefined}
          icon={Clock}
          colorClass="text-slate-400"
          hint="Longest a deal has sat still"
          isLoading={isLoading}
        />
        <StatCard
          title="In sync"
          value={summary?.byReconcile.IN_SYNC ?? 0}
          icon={CheckCircle2}
          colorClass="text-green-500"
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
          {RECONCILE_ORDER.map((state) => {
            const count = summary?.byReconcile[state] ?? 0
            return (
              <button
                key={state}
                onClick={() => setFilter(state)}
                disabled={count === 0}
                title={RECONCILE[state].blurb}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  filter === state
                    ? "bg-slate-900 text-white"
                    : "bg-white border border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                {RECONCILE[state].label} ({count})
              </button>
            )
          })}
        </div>

        <FindBox query={query} setQuery={setQuery} found={found.length} total={visible.length} />

        {/* Staleness stated plainly. A mirror that hides its age is worse than
            no mirror, because it gets trusted anyway. */}
        <div className="text-xs text-slate-400 flex items-center gap-1.5">
          {isFetching && <RefreshCw className="w-3 h-3 animate-spin" />}
          {summary?.lastSyncedAt
            ? `Mirror last updated ${formatDate(summary.lastSyncedAt)}`
            : "Never synced"}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[22%]">Deal</TableHead>
              <TableHead className="w-16 text-right">Days</TableHead>
              <TableHead className="w-[19%]">Dealer's DMS</TableHead>
              <TableHead className="w-[19%]">DDMS</TableHead>
              <TableHead className="w-[12%]">Reconcile</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-9 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-8 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-9 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-9 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                </TableRow>
              ))
            ) : found.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <ListChecks className="w-8 h-8 text-slate-300" />
                    <span>
                      {rows.length === 0
                        ? "Nothing mirrored yet. Run a sync to pull this showroom's deals."
                        : "No deals in this state."}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              found.map((row) => {
                const tone = RECONCILE[row.reconcile]
                return (
                  <TableRow
                    key={`${row.dealerCode}:${row.dealId}`}
                    className={row.disappearedFromDms ? "opacity-50" : undefined}
                  >
                    <TableCell className="align-top">
                      <div className="font-mono text-[11px] text-slate-500">{row.dealId}</div>
                      <div className="font-semibold text-slate-900 text-sm mt-0.5">
                        {row.customerName ?? "—"}
                      </div>
                      <div className="text-xs text-slate-500">{row.modelDescription ?? "—"}</div>
                      {row.disappearedFromDms && (
                        <Badge variant="draft" className="mt-1">
                          gone from the DMS
                        </Badge>
                      )}
                    </TableCell>

                    {/* Aging is the number nobody has time to work out by hand,
                        and the reason the mirror exists. */}
                    <TableCell className="align-top text-right">
                      <span
                        className={`text-sm font-semibold tabular-nums ${
                          row.daysInStatus >= 7
                            ? "text-red-600"
                            : row.daysInStatus >= 3
                            ? "text-amber-600"
                            : "text-slate-400"
                        }`}
                      >
                        {row.daysInStatus}
                      </span>
                    </TableCell>

                    <TableCell className="align-top bg-slate-50/60">
                      <SystemView
                        status={row.dms.status}
                        policy={row.dms.policyNo}
                        detail={row.dms.insurerCode ?? row.dms.regNo}
                      />
                    </TableCell>

                    <TableCell className="align-top">
                      <SystemView
                        status={row.ddms.applicationStatus}
                        policy={row.ddms.policyNumber}
                        detail={row.ddms.providerName}
                        simulated={row.ddms.policySimulated}
                      />
                      {row.ddms.applicationId && (
                        <a
                          href={`${INSUR_ROUTER_ORIGIN}/applications/${row.ddms.applicationId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 text-[11px] text-emerald-700 hover:underline inline-flex items-center gap-0.5 font-medium"
                        >
                          #{row.ddms.applicationId} in InsurRouter
                          <ChevronRight className="w-3 h-3" />
                        </a>
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
                              row.reconcile === "CONFLICT" ? "text-red-500" : "text-amber-500"
                            }`}
                          />
                          <div className="min-w-0">
                            {/* NOT_STARTED is the one state the software can
                                resolve on its own — everything the proposal
                                needs is already in the dealer's record. The
                                rest still need a person, so they stay as
                                instructions rather than pretending otherwise. */}
                            {row.reconcile === "NOT_STARTED" ? (
                              <Button
                                variant="accent"
                                size="sm"
                                className="gap-1.5"
                                disabled={start.isPending}
                                onClick={() => startApplication(row.dealId)}
                              >
                                {start.isPending && pendingDeal === row.dealId ? (
                                  <>
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                    Starting…
                                  </>
                                ) : (
                                  <>
                                    <Play className="w-3.5 h-3.5" />
                                    Start the application
                                  </>
                                )}
                              </Button>
                            ) : (
                              <div className="text-sm text-slate-800">{row.actionRequired}</div>
                            )}
                            {row.reconcileNote && (
                              <div className="text-[11px] text-slate-400 mt-1">{row.reconcileNote}</div>
                            )}
                            {startError?.dealId === row.dealId && (
                              <div className="mt-1.5 text-[11px] rounded border border-red-200 bg-red-50 p-2 text-red-800">
                                <div className="font-semibold">{startError.message}</div>
                                {startError.missing.length > 0 && (
                                  <ul className="mt-1 list-disc list-inside space-y-0.5">
                                    {startError.missing.map((m) => (
                                      <li key={m}>{m}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">
                          {row.reconcileNote ?? "Nothing to do"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Where the work can actually be placed. Quota is normally invisible —
          it sits in a spreadsheet or a manager's head — so the person choosing
          an insurer at the counter cannot see they are about to overshoot a
          commitment. Showing it next to the worklist is the point. */}
      {panel && panel.entries.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Insurer panel</CardTitle>
            <p className="text-xs text-slate-500">
              Who this showroom can place business with, and how much of each
              commitment is already used.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
              {panel.entries.map((p) => (
                <div
                  key={`${p.dealerCode}:${p.insurerCode}`}
                  className={`rounded-md border p-3 ${
                    p.eligible ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold text-sm text-slate-900 leading-tight">
                      {p.shortName}
                    </div>
                    <Badge variant={p.integration === "API" ? "info" : "draft"}>
                      {p.integration}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {p.route === "BROKER" ? "via broker" : "direct agency"} · {p.slaMinutes}m
                  </div>

                  <div className="mt-2.5">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="font-semibold tabular-nums text-slate-700">
                        {p.quotaConsumed}/{p.quotaPolicies}
                      </span>
                      <span className="text-slate-400 tabular-nums">
                        {Math.round(p.quota.utilisation * 100)}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          p.quota.exhausted
                            ? "bg-red-500"
                            : p.quota.tight
                            ? "bg-amber-500"
                            : "bg-green-500"
                        }`}
                        style={{ width: `${Math.min(100, p.quota.utilisation * 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* Exclusions are explained, never just applied. An
                      unexplained recommendation is worse than none. */}
                  {p.reasons.length > 0 && (
                    <div className="text-[11px] text-red-600 mt-2">{p.reasons.join("; ")}</div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-slate-400 max-w-3xl">
        The dealer's DMS is read-only — nothing here writes back to it. That is why
        &ldquo;Ahead&rdquo; is a task rather than an error: the policy exists, and the
        number still has to be keyed into their system by hand. Tracking that is the
        difference between a closed loop and a policy nobody recorded.
      </p>
    </div>
  )
}
