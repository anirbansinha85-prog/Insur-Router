import {
  useGetRecordJourney,
  type JourneyTrace,
  type JourneyTraceStep,
} from "@workspace/api-client-react"
import {
  AlertTriangle,
  Bot,
  Building2,
  Check,
  Clock,
  CornerUpLeft,
  Route,
  User,
  Users,
} from "lucide-react"

/**
 * Where this sale has got to — the first thing in DDMS that shows a **journey**
 * rather than a record.
 *
 * Every other panel answers *what is wrong with this row*. This one answers the
 * question a customer actually asks on the telephone: *where has my bike got
 * to?* — which today needs four screens and somebody holding the answer in
 * their head, because the invoice is on the deal, the policy is in InsurRouter,
 * the tax is in the ledger and the certificate is on the registration file.
 *
 * ## Why the whole map is drawn, not just the current step
 *
 * A progress bar would fit in a third of the space and answer nothing. What
 * makes this worth a panel is seeing *what is still to come* and *who does each
 * of them* — three of the nine steps belong to people who do not work here, and
 * a manager reading the map can tell at a glance whether the delay is theirs.
 *
 * ## The backwards arrivals are the point
 *
 * A file the RTO rejected shows the return with the objection beside it. Drawn
 * as an event in the list rather than folded into the step, because *this went
 * back twice* and *this is at documents* are different facts and a dealership
 * chasing a difficult file needs the first one.
 */

const ACTOR_ICON: Record<string, typeof User> = {
  PERSON: User,
  AGENT: Bot,
  OUTSIDE: Users,
  DMS: Building2,
  RULE: Check,
}

/** What each kind of waiting means, said out loud rather than colour-coded. */
const WAIT_TONE: Record<string, { label: string; className: string }> = {
  PERSON: {
    label: "Waiting on somebody here",
    className: "text-amber-800 bg-amber-50 border-amber-200",
  },
  OUTSIDE: {
    label: "Waiting on somebody outside",
    className: "text-slate-700 bg-slate-50 border-slate-200",
  },
  JOURNEY: {
    label: "Waiting on another process",
    className: "text-blue-800 bg-blue-50 border-blue-200",
  },
  TIME: {
    label: "Nothing to do yet",
    className: "text-slate-500 bg-slate-50 border-slate-200",
  },
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  })
}

function StepRow({ s }: { s: JourneyTraceStep }) {
  const Icon = ACTOR_ICON[s.actor] ?? User
  const here = s.state === "HERE"
  return (
    <li className="flex items-center gap-2.5 py-1">
      <span
        className={`w-4 h-4 shrink-0 rounded-full border flex items-center justify-center ${
          s.state === "DONE"
            ? "bg-emerald-500 border-emerald-500"
            : here
              ? "border-amber-500 bg-amber-50"
              : "border-slate-200 bg-white"
        }`}
      >
        {s.state === "DONE" ? (
          <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
        ) : here ? (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        ) : null}
      </span>
      <span
        className={`text-xs ${
          s.state === "DONE"
            ? "text-slate-400"
            : here
              ? "text-slate-900 font-semibold"
              : "text-slate-400"
        }`}
      >
        {s.title}
      </span>
      {/* Who does it, on every step rather than only the current one. Three of
          the nine belong to people the dealership does not employ, and that is
          the thing a manager wants to see without clicking. */}
      <Icon className="w-3 h-3 text-slate-300 shrink-0" />
      {here && (
        <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">
          here
        </span>
      )}
    </li>
  )
}

export function JourneyPanel({
  module,
  recordKey,
}: {
  module: string
  recordKey: string
}) {
  const { data, isLoading, isError } = useGetRecordJourney(
    module as never,
    recordKey,
    {
      query: {
        queryKey: ["/api/dms/records", module, recordKey, "journey"],
        // A record with no journey is a 404 and a real answer — only
        // registration files have a definition today. Retrying it would be
        // three requests to be told the same thing.
        retry: false,
      },
    },
  )

  // Nothing at all rather than an empty box: most records have no journey yet,
  // and a panel saying so on every screen would be noise on all of them.
  if (isLoading || isError || !data) return null

  const trace = data as JourneyTrace
  const wait = trace.wait
  const tone = wait ? WAIT_TONE[wait.kind] : null
  const backs = trace.arrivals.filter((a) => a.direction === "BACKWARD")

  return (
    <div className="border border-slate-200 rounded-md bg-white">
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 flex-wrap">
        <Route className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
          {trace.title}
        </span>
        <span className="text-[11px] text-slate-400">
          {trace.status === "DONE"
            ? `finished ${trace.completedAt ? when(trace.completedAt) : ""}`
            : trace.status === "ABANDONED"
              ? "abandoned"
              : `step ${trace.steps.filter((s) => s.state === "DONE").length} of ${trace.steps.length}`}
        </span>
        {trace.loops > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider
                           text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
            <CornerUpLeft className="w-3 h-3" />
            sent back {trace.loops === 1 ? "once" : `${trace.loops} times`}
          </span>
        )}
      </div>

      {wait && tone && (
        <div className={`px-4 py-2.5 border-b text-xs ${tone.className}`}>
          <div className="flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-wider">
            {wait.kind === "TIME" ? (
              <Clock className="w-3 h-3" />
            ) : (
              <AlertTriangle className="w-3 h-3" />
            )}
            {tone.label} — {wait.who}
          </div>
          <p className="mt-1">{wait.why}</p>
          <p className="mt-0.5 font-medium">{wait.todo}</p>
          {wait.notBefore && wait.kind === "TIME" && (
            <p className="mt-0.5 opacity-70">Worth asking about after {when(wait.notBefore)}.</p>
          )}
        </div>
      )}

      <ul className="px-4 py-2">
        {trace.steps.map((s) => (
          <StepRow key={s.stepId} s={s} />
        ))}
      </ul>

      {backs.length > 0 && (
        <div className="px-4 py-2.5 border-t border-slate-100 bg-red-50/40">
          {backs.map((a, i) => (
            <p key={i} className="text-[11px] text-red-800">
              <span className="font-semibold">{when(a.occurredAt)}</span> — sent back from{" "}
              {a.fromStepId?.toLowerCase().replace(/_/g, " ")}
              {a.reason ? `: ${a.reason}` : "."}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
