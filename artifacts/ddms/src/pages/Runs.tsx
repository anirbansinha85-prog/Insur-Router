import { useState } from "react"
import { useListRuns, useGetRun, type AgentRun } from "@workspace/api-client-react"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Hand,
  Loader2,
  PauseCircle,
  XCircle,
} from "lucide-react"

/**
 * What ran on its own, and what it cost (OBJ-28, R-92, R-93).
 *
 * ## Why this screen exists at all
 *
 * The decision log answers *what happened to this record*, and it is on the
 * case card where somebody looking at a record will find it. It cannot answer
 * *what did the agent do at half past two*, because a run is a narrative
 * **across** records — a hundred and forty looked at, eleven suggested, two
 * refused, one acted on — and that shape lives in no per-record table.
 *
 * > You cannot supervise what you cannot watch.
 *
 * The same argument that put the rule set on a screen and the ladder on
 * another: an automation layer nobody can see is where an automation layer
 * nobody can predict begins.
 *
 * ## The stand-down banner is the most important thing on the page
 *
 * It is also the only element here that appears conditionally, and it clears
 * itself — a stand-down stops being shown the moment a good run follows it.
 * A warning that nothing ever clears is a warning people stop reading, and
 * this one has to be read: it means the product concluded the dealership was
 * disagreeing with it, and paused.
 *
 * ## Cost is shown in rupees and called an estimate
 *
 * It is tokens times a rate table. Presenting it as a figure to reconcile
 * against a bill would be inviting somebody to find a discrepancy that is in
 * the third decimal place and means nothing.
 */

const OUTCOME: Record<
  string,
  { label: string; icon: typeof Clock; className: string }
> = {
  RUNNING: { label: "Running", icon: Loader2, className: "text-sky-700 bg-sky-50 border-sky-200" },
  COMPLETED: { label: "Completed", icon: Clock, className: "text-slate-600 bg-slate-50 border-slate-200" },
  FAILED: { label: "Failed", icon: XCircle, className: "text-rose-700 bg-rose-50 border-rose-200" },
  STOOD_DOWN: {
    label: "Stood down",
    icon: PauseCircle,
    className: "text-amber-800 bg-amber-50 border-amber-200",
  },
}

const STEP_ICON: Record<string, typeof Clock> = {
  READ: Clock,
  PROPOSE: Hand,
  ACT: ChevronRight,
  REFUSED: XCircle,
  MODEL: Cpu,
}

/** Paise to rupees, two places, Indian grouping. */
function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
}

function Steps({ runId }: { runId: number }) {
  const { data, isLoading } = useGetRun(runId, {
    query: { queryKey: ["/api/dms/runs", runId] },
  })

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-xs text-slate-400 flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Reading the trace…
      </div>
    )
  }
  if (!data || data.steps.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-slate-400">
        Nothing was recorded. A pass that found nothing to do writes no steps, which is
        the honest answer rather than a row saying it did nothing.
      </div>
    )
  }

  return (
    <ol className="divide-y divide-slate-100">
      {data.steps.map((st) => {
        const Icon = STEP_ICON[st.kind] ?? Clock
        return (
          <li key={st.seq} className="flex items-start gap-2.5 px-4 py-2">
            <Icon
              className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                st.kind === "REFUSED"
                  ? "text-rose-500"
                  : st.kind === "MODEL"
                    ? "text-violet-500"
                    : st.kind === "ACT"
                      ? "text-emerald-600"
                      : "text-slate-400"
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-slate-700">
                <span className="font-semibold">{st.kind}</span>
                {st.action && <span className="text-slate-500"> · {st.action}</span>}
                {st.recordKey && (
                  <span className="text-slate-400 tabular-nums"> · {st.recordKey}</span>
                )}
              </div>
              {st.detail && (
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{st.detail}</p>
              )}
              {st.model && (
                <p className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                  {st.model} · {rupees(st.costPaise ?? 0)} · {st.ms}ms
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Run({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false)
  const o = OUTCOME[run.outcome] ?? OUTCOME.COMPLETED!
  const Icon = o.icon

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 rounded-lg"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        )}

        <span
          className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 shrink-0 ${o.className}`}
        >
          <Icon className={`w-3 h-3 ${run.outcome === "RUNNING" ? "animate-spin" : ""}`} />
          {o.label}
        </span>

        <span className="text-sm font-medium text-slate-900 shrink-0">{run.kind}</span>

        <span className="text-xs text-slate-500 flex-1 min-w-0 truncate">
          {run.reason ??
            `${run.proposed} offered · ${run.acted} acted · ${run.refused} refused`}
        </span>

        <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
          {run.modelCalls > 0 && `${run.modelCalls} model · ${rupees(run.costPaise)} · `}
          {run.durationMs !== null && run.durationMs !== undefined && `${run.durationMs}ms · `}
          {ago(run.startedAt)}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100">
          <Steps runId={run.id} />
        </div>
      )}
    </div>
  )
}

export default function Runs() {
  const { data, isLoading } = useListRuns({ query: { queryKey: ["/api/dms/runs"] } })

  if (isLoading) {
    return (
      <div className="py-24 flex items-center justify-center text-sm text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading…
      </div>
    )
  }

  const spent = data?.spentTodayPaise ?? 0
  const cap = data?.capPaise ?? 0
  const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-16">
      <div>
        <h1 className="text-xl font-bold text-slate-900">What ran on its own</h1>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl leading-snug">
          Every unattended pass, what it looked at, what it was refused, and what
          it cost. The decision log says what happened to a record; this says what
          happened in an afternoon.
        </p>
      </div>

      {/* Conditional, and it clears itself the moment a good run follows. */}
      {data?.standingDown && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-amber-900">
              The agent has paused itself
            </div>
            <p className="text-sm text-amber-900 mt-0.5 leading-snug">{data.standingDown.reason}</p>
            <p className="text-[11px] text-amber-800/70 mt-1">
              {ago(data.standingDown.at)}. Nothing needs switching back on.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-slate-600">Spent today</span>
          <span className="text-xs text-slate-400 tabular-nums">
            {rupees(spent)} of {rupees(cap)}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className={`h-full rounded-full ${pct >= 100 ? "bg-rose-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {/* Said out loud, because a figure next to a currency symbol reads as
            a bill and somebody will try to reconcile it against one. */}
        <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">
          Estimated from the provider's own token counts and a rate table. Not an
          invoice — what it is for is noticing that today cost forty times
          yesterday. The ceiling is yours to change on{" "}
          <a href="numbers" className="underline underline-offset-2">
            your numbers
          </a>
          .
        </p>
      </div>

      {(data?.runs ?? []).length === 0 ? (
        <div className="rounded-lg border border-slate-200 px-4 py-8 text-center">
          <p className="text-sm text-slate-500">Nothing has run unattended yet.</p>
          <p className="text-xs text-slate-400 mt-1">
            The scheduler records a pass whether or not it did anything, so this
            filling up is the first sign the agent is switched on.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {data!.runs.map((r) => (
            <Run key={r.id} run={r} />
          ))}
        </div>
      )}
    </div>
  )
}
