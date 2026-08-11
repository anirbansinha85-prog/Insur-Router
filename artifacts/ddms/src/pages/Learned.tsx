import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListAutonomy,
  useListAutonomyProposals,
  useGrantAutonomyConsent,
  useRevokeAutonomyConsent,
  type AutonomyPattern,
} from "@workspace/api-client-react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Hand,
  Loader2,
  Lock,
  PlayCircle,
  Sparkles,
  Undo2,
} from "lucide-react"

/**
 * What the product has learned, and how far that has earned it (OBJ-26).
 *
 * Everyone builds autonomy as a dial somebody sets — a guess made on the first
 * afternoon, by whoever happened to be configuring the product, about work they
 * have not yet watched it do. This screen is the alternative: a count, per
 * pattern, that goes up when the dealership agrees and comes back down when it
 * stops.
 *
 * ## Why it needs a screen at all
 *
 * The same argument that put the rule set on one. **An automation layer nobody
 * can see is where an automation layer nobody can predict begins**, and a
 * ladder is worse than a dial if nobody can find out which rung anything is on.
 * So every rung shows its evidence, every claim shows its count and its date,
 * and the reason a pattern stands where it does is a sentence somebody can
 * argue with rather than a score.
 *
 * ## The two things this screen refuses to do
 *
 * It never promotes anything. At the threshold it **asks**, and the ask is a
 * button with a person's name going on the row. And it will not offer that
 * button at all for an action that asserts a person did something — those stop
 * at *fills the answer in*, whatever the count says, and the row explains why
 * in the sentence the permission table already had written.
 */

const RUNG_ORDER = ["WATCHING", "RECALL", "PREFILLED", "AUTOMATIC"] as const
type Rung = (typeof RUNG_ORDER)[number]

const RUNG_ICON: Record<Rung, typeof Eye> = {
  WATCHING: Eye,
  RECALL: Sparkles,
  PREFILLED: Hand,
  AUTOMATIC: PlayCircle,
}

const RUNG_TONE: Record<Rung, string> = {
  WATCHING: "text-slate-400 bg-slate-50 border-slate-200",
  RECALL: "text-sky-700 bg-sky-50 border-sky-200",
  PREFILLED: "text-indigo-700 bg-indigo-50 border-indigo-200",
  AUTOMATIC: "text-emerald-700 bg-emerald-50 border-emerald-200",
}

const OUTCOME_TONE: Record<string, string> = {
  ACCEPTED: "text-emerald-700",
  ACTED: "text-emerald-700",
  OVERRIDDEN: "text-amber-700",
  EXPIRED: "text-slate-400",
  OFFERED: "text-slate-500",
}

const OUTCOME_LABEL: Record<string, string> = {
  ACCEPTED: "you agreed",
  ACTED: "done on its own",
  OVERRIDDEN: "you chose differently",
  EXPIRED: "nobody got to it",
  OFFERED: "waiting",
}

function human(s: string): string {
  return s.replace(/_/g, " ").toLowerCase()
}

/** The four rungs, drawn as a track so a rung means something before you read it. */
function Ladder({ at, ceiling }: { at: Rung; ceiling: Rung }) {
  const here = RUNG_ORDER.indexOf(at)
  const top = RUNG_ORDER.indexOf(ceiling)
  return (
    <div className="flex items-center gap-1" aria-label={`Rung ${here} of 3`}>
      {RUNG_ORDER.map((r, n) => (
        <span
          key={r}
          title={n > top ? "This one can never go this far" : r}
          className={`h-1.5 w-6 rounded-full ${
            n <= here
              ? at === "AUTOMATIC"
                ? "bg-emerald-500"
                : "bg-indigo-400"
              : n > top
                ? // Not merely unreached — unreachable. Drawn differently
                  // because "not yet" and "never" are different facts, and the
                  // whole of R-80 is that the second one exists.
                  "bg-slate-100 border border-dashed border-slate-300"
                : "bg-slate-200"
          }`}
        />
      ))}
    </div>
  )
}

function Row({
  p,
  consentAfter,
  overrideCeiling,
  canDecide,
}: {
  p: AutonomyPattern
  consentAfter: number
  overrideCeiling: number
  canDecide: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grant = useGrantAutonomyConsent()
  const revoke = useRevokeAutonomyConsent()
  const proposals = useListAutonomyProposals(
    { patternKey: p.patternKey },
    { query: { queryKey: ["/api/dms/autonomy/proposals", p.patternKey], enabled: open } },
  )

  const refresh = () => void qc.invalidateQueries({ queryKey: ["/api/dms/autonomy"] })
  const fail = (e: unknown) => {
    const b = (e as { response?: { data?: { error?: string } } })?.response?.data
    setError(b?.error ?? "That did not go through.")
  }

  const Icon = RUNG_ICON[p.rung as Rung]

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-start gap-3 flex-wrap">
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 flex items-center gap-1 shrink-0 ${
              RUNG_TONE[p.rung as Rung]
            }`}
          >
            <Icon className="w-3 h-3" />
            {p.rungLabel}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">
              {human(p.action)}
            </p>
            <p className="text-[11px] text-slate-500">
              on {human(p.module)} · {human(p.state)}
            </p>
          </div>
          <div className="ml-auto shrink-0 pt-1">
            <Ladder at={p.rung as Rung} ceiling={p.ceiling as Rung} />
          </div>
        </div>

        {/* R-68 on the screen: a count and a date, or the row says nothing. */}
        {p.sentence && (
          <p className="text-sm text-slate-700 border-l-2 border-slate-200 pl-3">{p.sentence}</p>
        )}

        <p className="text-[11px] text-slate-500">{p.because}</p>

        <div className="flex items-center gap-4 flex-wrap text-[11px] text-slate-500 tabular-nums">
          <span>
            <strong className="text-slate-700">{p.decisions}</strong> decided by people, last{" "}
            {p.windowDays} days
          </span>
          <span>
            <strong className="text-slate-700">{p.accepted}</strong> of its suggestions taken
            {p.acted > 0 && <> · {p.acted} done on its own</>}
          </span>
          {p.overrideRatePct !== null && p.overrideRatePct !== undefined && (
            <span className={p.overrideRatePct > overrideCeiling ? "text-amber-700 font-medium" : ""}>
              {p.overrideRatePct}% changed
              {p.overrideRatePct > overrideCeiling && <> — above your {overrideCeiling}%</>}
            </span>
          )}
        </div>

        {/* The floor, said out loud on the row rather than implied by an absent
            button. Somebody wondering why this one never gets faster deserves
            the sentence rather than the silence. */}
        {p.ceiling !== "AUTOMATIC" && p.ceilingReason && (
          <p className="text-[11px] text-slate-500 flex items-start gap-1.5 border border-slate-200 bg-slate-50 rounded px-2 py-1.5">
            <Lock className="w-3 h-3 mt-0.5 shrink-0 text-slate-400" />
            <span>
              This can never run on its own, however often it is right. {p.ceilingReason}
            </span>
          </p>
        )}

        {/* The ask. Not a promotion — a question, with a person's name going on
            the answer either way. */}
        {p.consentDue && canDecide && (
          <div className="border border-emerald-200 bg-emerald-50/60 rounded-md px-3 py-2.5 space-y-2">
            <p className="text-sm text-emerald-900">
              {p.accepted} out of {p.accepted} agreed with, past your {consentAfter}. Shall it just
              do this one from now on?
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setError(null)
                  grant.mutate(
                    { data: { patternKey: p.patternKey, onCount: p.accepted } },
                    { onSuccess: refresh, onError: fail },
                  )
                }}
                disabled={grant.isPending}
                className="inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md
                           bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {grant.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Yes, let it
              </button>
              <span className="text-[11px] text-emerald-800">
                You can take it back at any time, and it comes back down by itself if people start
                changing the answer.
              </span>
            </div>
          </div>
        )}

        {p.consentedBy && (
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-600">
            <span>
              {p.consentedBy} allowed this on{" "}
              {p.consentedAt
                ? new Date(p.consentedAt).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "long",
                  })
                : "—"}
              .
              {p.rung !== "AUTOMATIC" && (
                <span className="text-amber-700">
                  {" "}
                  It has come back down on its own — the consent still stands.
                </span>
              )}
            </span>
            {canDecide && (
              <button
                onClick={() => {
                  setError(null)
                  revoke.mutate(
                    { data: { patternKey: p.patternKey, reason: "Taken back from the learning screen." } },
                    { onSuccess: refresh, onError: fail },
                  )
                }}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 underline underline-offset-2"
              >
                <Undo2 className="w-3 h-3" />
                Take it back
              </button>
            )}
          </div>
        )}

        {error && <p className="text-[11px] text-red-600">{error}</p>}

        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] font-medium text-slate-500 hover:text-slate-800 flex items-center gap-1"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {open ? "Hide" : "Show"} what it offered
        </button>
      </div>

      {/* The evidence behind the count, openable. A count somebody cannot open
          is a count they have to take on trust, and trust is what this screen
          is for deciding. */}
      {open && (
        <div className="border-t border-slate-100 px-4 py-2">
          {proposals.isLoading ? (
            <p className="text-xs text-slate-400 flex items-center gap-2 py-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Reading what was offered…
            </p>
          ) : (proposals.data?.proposals ?? []).length === 0 ? (
            <p className="text-xs text-slate-400 py-2">Nothing has been offered here yet.</p>
          ) : (
            <div className="divide-y divide-slate-50">
              {(proposals.data?.proposals ?? []).map((q) => (
                <div key={q.id} className="py-1.5 flex items-baseline gap-3 text-xs flex-wrap">
                  <span className="font-medium text-slate-700 w-36 shrink-0">{q.recordKey}</span>
                  <span className={`w-40 shrink-0 ${OUTCOME_TONE[q.outcome] ?? "text-slate-500"}`}>
                    {OUTCOME_LABEL[q.outcome] ?? q.outcome}
                  </span>
                  <span className="text-slate-500 truncate flex-1 min-w-0">{q.reason}</span>
                  <span className="text-[10px] text-slate-400 tabular-nums">
                    {new Date(q.createdAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Learned({ permissions }: { permissions: string[] }) {
  const canDecide = permissions.includes("policy.set")
  const { data, isLoading } = useListAutonomy({
    query: { queryKey: ["/api/dms/autonomy"] },
  })

  const patterns = data?.patterns ?? []
  const n = data?.numbers
  const asking = patterns.filter((p) => p.consentDue)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-slate-400" />
          What this product has learned
        </h1>
        <p className="text-sm text-slate-500 mt-0.5 max-w-3xl">
          It starts by watching. Once it has seen you handle something enough times it starts
          telling you what you did last time; once you have agreed with it enough times it fills the
          answer in; and only then does it ask whether it should do it on its own. It never decides
          that for itself, and anything you start changing comes back down.
        </p>
      </div>

      {n && (
        <div className="flex items-center gap-4 flex-wrap text-[11px] text-slate-500 border border-slate-200 rounded-lg px-4 py-2.5 bg-slate-50/50">
          <span className="font-semibold uppercase tracking-wider text-slate-500">Your numbers</span>
          <span>Looks back <strong className="text-slate-700">{n.windowDays}</strong> days</span>
          <span>Speaks up after <strong className="text-slate-700">{n.recallAfter}</strong></span>
          <span>Fills in after <strong className="text-slate-700">{n.prefillAfter}</strong></span>
          <span>Asks at <strong className="text-slate-700">{n.consentAfter}</strong></span>
          <span>Steps back above <strong className="text-slate-700">{n.overrideCeilingPct}%</strong> changed</span>
          <a href="numbers" className="ml-auto text-slate-600 underline underline-offset-2 hover:text-slate-900">
            Change them
          </a>
        </div>
      )}

      {/* The master switch, said plainly. Both it and a pattern's rung have to
          hold, and somebody looking at an AUTOMATIC row with the switch off
          needs to know nothing is actually running. */}
      {data && !data.agentSwitchedOn && patterns.some((p) => p.rung === "AUTOMATIC") && (
        <p className="text-xs text-amber-800 border border-amber-200 bg-amber-50 rounded-md px-3 py-2">
          Something below has been allowed to run on its own, but the agent is switched off for this
          dealership, so nothing is running. Both have to be on.
        </p>
      )}

      {asking.length > 0 && (
        <p className="text-sm text-emerald-900 border border-emerald-200 bg-emerald-50/60 rounded-md px-3 py-2">
          {asking.length === 1 ? "One thing is" : `${asking.length} things are`} waiting on an answer
          from you.
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-slate-400 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading what has happened here…
        </p>
      ) : patterns.length === 0 ? (
        <p className="text-sm text-slate-400">
          Nothing yet. It needs to watch people work for a while before it has anything to say.
        </p>
      ) : (
        <div className="space-y-3">
          {patterns.map((p) => (
            <Row
              key={p.patternKey}
              p={p}
              consentAfter={n?.consentAfter ?? 10}
              overrideCeiling={n?.overrideCeilingPct ?? 20}
              canDecide={canDecide}
            />
          ))}
        </div>
      )}
    </div>
  )
}
