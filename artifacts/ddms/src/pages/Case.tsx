/**
 * One record, on its own page, for somebody who has never seen it before.
 *
 * ## Why this is not the panel that already existed
 *
 * The queue has carried a case panel and a timeline for a while, and both were
 * built for the person who has been working the record: collapsed by default,
 * beneath the controls, for the moment you want to *check* rather than act.
 *
 * This page is for the opposite person. The advisor is not in, the customer's
 * bike is in the workshop, and the manager picking it up has no idea what has
 * already happened. **Handover is a different design goal from inspection**, and
 * the difference shows in what comes first: not the field list, but the story —
 * how long it has been stuck, whose it is, whether that person is even here, and
 * what anybody has already tried.
 *
 * ## The question it exists to answer
 *
 * > *Has anyone already rung her?*
 *
 * Ringing a customer whose bike is fifteen days late, when a colleague spoke to
 * her yesterday and she said she would come on Saturday, is the dealership
 * looking disorganised to exactly the customer who can least afford another
 * disappointment. The answer was in `decision_log` all along and on no screen.
 *
 * ## Its own URL, and that is load-bearing
 *
 * A manager works a handover with six of these open. They compare them, they
 * come back to one, and they paste one into a message when they hand it back to
 * somebody. A modal can do none of that. It also means acting here leaves the
 * queue's own order untouched — that order is deliberately frozen while it is
 * being worked, so a second tab is the natural place to do the reading.
 */

import { Link, useRoute } from "wouter"
import {
  useGetCaseRecord,
  useGetRecordHistory,
  type HistoryEntry,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Building2,
  CheckCircle2,
  Clock,
  Database,
  MessageSquare,
  PenLine,
  User,
  Users,
  UserX,
} from "lucide-react"
import { AssignPicker } from "@/lib/actions"
import { CasePanel } from "@/lib/case"
import { JourneyPanel } from "@/lib/journey"
import { Timeline } from "@/lib/timeline"
import { ExplainButton } from "@/lib/explain"

const MODULE_LABEL: Record<string, string> = {
  DEAL: "Deal",
  JOB_CARD: "Job card",
  ENQUIRY: "Enquiry",
  REGISTRATION: "Registration file",
  PART: "Part",
  RECEIVABLE: "Receivable",
  VEHICLE: "Vehicle",
}

/**
 * The clock each entry is on, in the reader's words rather than the enum's.
 *
 * Shown on **every** row and not only where it is surprising. A column that
 * appears sometimes reads as an exception; a column that always appears is a
 * fact about the data, which is what this one is.
 */
const CLOCK: Record<string, { label: string; icon: typeof User; tone: string }> = {
  THEIRS: { label: "their system", icon: Database, tone: "text-slate-500" },
  WE_NOTICED: { label: "we noticed", icon: Clock, tone: "text-slate-400" },
  SOMEBODY_HERE: { label: "somebody here", icon: User, tone: "text-emerald-700" },
  THE_AGENT: { label: "the agent", icon: Bot, tone: "text-slate-500" },
  THE_CUSTOMER: { label: "the customer", icon: MessageSquare, tone: "text-blue-700" },
}

/**
 * Which modules can be handed over, and to which role.
 *
 * Three of the seven. The other four name no person at all — a part on a shelf
 * and an unpaid invoice belong to a branch rather than to somebody — and
 * offering a picker there would be a control that writes a field nothing reads.
 */
const HANDOVER: Record<string, { action: string; role: string }> = {
  JOB_CARD: { action: "JOB_CARD_REASSIGN", role: "SERVICE_ADVISOR" },
  ENQUIRY: { action: "ENQUIRY_REASSIGN", role: "SALES_EXEC" },
  REGISTRATION: { action: "REGISTRATION_ASSIGN_AGENT", role: "RTO_AGENT" },
}

/** Where the module's own worklist lives, for the walk-out link. */
const SCREEN_OF: Record<string, string> = {
  JOB_CARD: "/service",
  ENQUIRY: "/enquiries",
  REGISTRATION: "/registrations",
  PART: "/spares",
  RECEIVABLE: "/receivables",
  VEHICLE: "/inventory",
  DEAL: "/worklist",
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
}

function Entry({ e }: { e: HistoryEntry }) {
  const clock = CLOCK[e.clock] ?? CLOCK["WE_NOTICED"]!
  const Icon = clock.icon
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0">
      <Icon className={`w-3.5 h-3.5 mt-1 shrink-0 ${clock.tone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-sm ${e.retracted ? "text-slate-400 line-through" : "text-slate-800"} font-medium`}
          >
            {e.headline}
          </span>
          {e.tried && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
              an attempt
            </span>
          )}
        </div>
        {e.detail && (
          <p
            className={`text-xs mt-0.5 whitespace-pre-wrap ${
              e.retracted ? "text-slate-400 line-through" : "text-slate-600"
            }`}
          >
            {e.detail}
          </p>
        )}
        <div className="text-[11px] text-slate-400 mt-1">
          {when(e.at)} · {e.who ?? clock.label}
          {/* The clock, always. Two entries a minute apart can mean their
              system changed something and we noticed it, which is one event
              and not two — and a reader who cannot see which is which will
              read the gap as time nobody spent. */}
          <span className="text-slate-300"> · {e.clockNote}</span>
        </div>
      </div>
    </div>
  )
}

export default function Case() {
  const [, params] = useRoute("/case/:module/:recordKey")
  const module = params?.module?.toUpperCase() ?? ""
  const recordKey = decodeURIComponent(params?.recordKey ?? "")

  const record = useGetCaseRecord(module as never, recordKey, {
    query: { queryKey: ["/api/dms/records", module, recordKey, "case"], retry: false },
  })
  const history = useGetRecordHistory(module as never, recordKey, {
    query: { queryKey: ["/api/dms/records", module, recordKey, "history"], retry: false },
  })

  if (record.isLoading || history.isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (record.error || !record.data) {
    return (
      <div className="p-6">
        <p className="text-sm text-slate-600">
          No {MODULE_LABEL[module]?.toLowerCase() ?? "record"} <span className="font-mono">{recordKey}</span> —
          or not one this login may read.
        </p>
        <Link href="/" className="text-xs text-slate-500 hover:text-slate-800 mt-2 inline-block">
          Back to the queue
        </Link>
      </div>
    )
  }

  const h = history.data
  const owner = h?.owner
  const showroomId = h?.showroomId ?? 0
  const stuck = daysSince(h?.inCurrentStateSince)
  const tried = h?.tried ?? []

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      <Link
        href="/"
        className="text-xs text-slate-400 hover:text-slate-700 inline-flex items-center gap-1"
      >
        <ArrowLeft className="w-3 h-3" /> the queue
      </Link>

      {/* ── who and what, and how long it has been like this ──────────────── */}
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-xl font-semibold text-slate-900">{record.data.title}</h1>
          <span className="font-mono text-xs text-slate-400">{recordKey}</span>
          <Badge variant="draft">{MODULE_LABEL[module] ?? module}</Badge>
        </div>
        {record.data.subtitle && (
          <p className="text-sm text-slate-500 mt-0.5">{record.data.subtitle}</p>
        )}

        <div className="flex items-center gap-x-5 gap-y-1 flex-wrap mt-2 text-xs">
          {h?.currentState && (
            <span className="text-slate-600">
              <span className="font-semibold uppercase tracking-wide">
                {h.currentState.replace(/_/g, " ").toLowerCase()}
              </span>
              {stuck !== null && (
                <span className="text-slate-400">
                  {" "}
                  for {stuck} day{stuck === 1 ? "" : "s"}
                </span>
              )}
            </span>
          )}

          {/* Whose it is, and whether they are here.

              The single most useful line on the page for somebody picking work
              up cold, and the one the dealer's own system already answers — a
              leaving date on the staff master is what puts orphaned work in the
              queue's Nobody's band. It cannot say whether they came in this
              morning; no DMS carries attendance, and guessing would be wrong
              twice a week. */}
          {owner?.empCode && (
            <span
              className={`inline-flex items-center gap-1.5 ${
                owner.stillHere === false ? "text-red-700 font-medium" : "text-slate-600"
              }`}
            >
              {owner.stillHere === false ? (
                <UserX className="w-3.5 h-3.5" />
              ) : (
                <User className="w-3.5 h-3.5" />
              )}
              {owner.note}
            </span>
          )}
          {owner && !owner.empCode && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <UserX className="w-3.5 h-3.5" /> {owner.note}
            </span>
          )}

          {record.data.disappearedFromDms && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <AlertTriangle className="w-3.5 h-3.5" /> gone from the dealer's system
            </span>
          )}
        </div>
      </div>

      {/* ── what has been tried ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-slate-400" />
            What has been tried
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {tried.length === 0 ? (
            <div className="text-sm text-slate-600">
              <p className="font-medium text-slate-800">Nothing has been recorded.</p>
              {/* The distinction is the whole point of the section. */}
              <p className="text-xs text-slate-500 mt-1">
                That may mean nobody has tried, or that somebody tried and did not record it. Those
                are different and this cannot tell them apart — so before you ring, it is worth
                asking whoever was on.
              </p>
            </div>
          ) : (
            <div className="-my-1">
              {tried.map((e, i) => (
                <Entry key={`${e.source.table}-${e.source.id}-${i}`} e={e} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── hand it over ──────────────────────────────────────────────────── */}
      {HANDOVER[module] && showroomId > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="w-4 h-4 text-slate-400" />
              Hand this over
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {/* On the case rather than on the queue row, and that is the
                design rather than a shortcut.

                The queue offers its picker only in the Nobody's band, which is
                right: work assigned to nobody has to be routable from the list
                that shows it. A handover is the opposite situation — somebody
                *is* named, they are simply not in today — so it belongs where a
                manager has just read what has happened and can see who is
                holding it. */}
            <AssignPicker
              action={HANDOVER[module]!.action as never}
              target={{ showroomId, recordKey }}
              role={HANDOVER[module]!.role}
              currentEmpCode={owner?.empCode ?? null}
              currentLabel={owner?.name ?? owner?.empCode ?? null}
              placeholder="Hand over to…"
            />
            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
              The dealer's own system keeps naming{" "}
              {owner?.name ?? owner?.empCode ?? "whoever opened this"} — it has no column for a
              handover, which is why this one is recorded here and shows above.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── the same door every screen uses ───────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <ExplainButton module={module as never} showroomId={showroomId} recordKey={recordKey} />
        <Link
          href={SCREEN_OF[module] ?? "/"}
          className="text-xs text-slate-400 hover:text-slate-700"
        >
          Act on this from its own screen →
        </Link>
      </div>

      {/* ── where the thing itself has got to ─────────────────────────────── */}
      <JourneyPanel module={module} recordKey={recordKey} />

      {/* ── the whole history ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            Everything that has happened
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {(h?.entries.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-500">Nothing has been recorded against this yet.</p>
          ) : (
            <div className="-my-1">
              {h!.entries.map((e, i) => (
                <Entry key={`${e.source.table}-${e.source.id}-${i}`} e={e} />
              ))}
            </div>
          )}

          {/* What this page cannot see, on the page rather than in a comment.

              A history that opened in the middle and looked complete would be
              worse than one that says where it starts. */}
          {(h?.limits.length ?? 0) > 0 && (
            <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
              {h!.limits.map((l, i) => (
                <p key={i} className="text-[11px] text-slate-400 leading-relaxed">
                  {l}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── add to it, and only what you did yourself ─────────────────────── */}
      {owner && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <PenLine className="w-4 h-4 text-slate-400" />
              Record what you did
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {/* Deliberately *what you did*, never what somebody else did.

                Handover pressure makes "Sunil rang her on Tuesday" the tempting
                feature, and it would turn this page into hearsay — which is
                worthless for the one job it exists to do. What Sunil did is
                whatever Sunil logged. */}
            <Timeline module={module as never} recordKey={recordKey} showroomId={showroomId} />
          </CardContent>
        </Card>
      )}

      {/* ── and finally the record itself, complete and uncurated ─────────── */}
      <div className="flex items-center gap-2 text-xs text-slate-400 pt-2">
        <Building2 className="w-3.5 h-3.5" /> The record as it is held
      </div>
      <CasePanel module={module} recordKey={recordKey} />
    </div>
  )
}
