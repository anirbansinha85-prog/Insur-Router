import { useMemo, useState } from "react"
import { Link } from "wouter"
import {
  useGetDmsQueue,
  type QueueItem,
  type DmsActionInputAction,
} from "@workspace/api-client-react"
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Inbox,
  Loader2,
  PhoneCall,
  RotateCw,
  SkipForward,
  UserX,
} from "lucide-react"
import { ActionButton, AgentSuggestionCard, AssignPicker, ContactButtons } from "@/lib/actions"
import { ExplainButton } from "@/lib/explain"
import { Timeline } from "@/lib/timeline"

/**
 * One queue, worked one at a time.
 *
 * Every other screen in DDMS is a list of what is wrong with one module. This
 * is the only one that answers the question a short-staffed dealership
 * actually has each morning — *what should I do next* — and the capacity
 * argument the product is sold on stands or falls here. Seven screens each
 * holding a list is a reporting product.
 *
 * ## Why the order is frozen once it loads
 *
 * The obvious build refetches after every action, and it is wrong. Acting on an
 * item removes it from the server's answer, everything below shifts up, and the
 * person working the queue loses their place — twice, and they stop trusting
 * it. So the list is snapshotted on load and worked through by index: the
 * position never moves under somebody. Rebuilding is a thing they choose, and
 * the header says how old the list is so that choosing is informed.
 *
 * ## Three bands, and the middle one is the point
 *
 * Mine, then nobody's, then my outlet's. Orphaned work is what a dealership
 * loses: an enquiry assigned to a salesman who left in February is on nobody's
 * list and is not late by any measure the DMS holds. Here it is second from the
 * top, with the reason printed on it.
 */

const BAND_LABEL: Record<string, string> = {
  MINE: "Yours",
  UNASSIGNED: "Nobody's",
  OUTLET: "Your outlet's",
}

const BAND_BLURB: Record<string, string> = {
  MINE: "Carrying your employee code.",
  UNASSIGNED: "Carrying nobody's, or somebody who has left. This is the work a dealership loses.",
  OUTLET: "Somebody else is carrying these. Here so they can be covered, not so they can be taken.",
}

const MODULE_LABEL: Record<string, string> = {
  DEAL: "Deal",
  JOB_CARD: "Job card",
  ENQUIRY: "Enquiry",
  REGISTRATION: "Registration",
  PART: "Part",
  RECEIVABLE: "Receivable",
  VEHICLE: "Vehicle",
}

/** Modules the explain panel can answer for. The rest have no entity link. */
const EXPLAINABLE = new Set(["JOB_CARD", "ENQUIRY", "REGISTRATION", "PART", "RECEIVABLE", "VEHICLE"])

function severityTone(severity: number): string {
  if (severity >= 3) return "bg-red-50 text-red-700 border-red-200"
  if (severity === 2) return "bg-amber-50 text-amber-700 border-amber-200"
  return "bg-slate-50 text-slate-600 border-slate-200"
}

function severityWord(severity: number): string {
  return severity >= 3 ? "Today" : severity === 2 ? "This week" : "When there is time"
}

export default function Queue() {
  // Fresh on arrival, frozen while it is being worked. Actions elsewhere
  // deliberately do not invalidate this query — `invalidateWorklists` in
  // lib/actions.tsx excludes it by name, and says why.
  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useGetDmsQueue({
    query: { queryKey: ["/api/dms/queue"] },
  })

  const [cursor, setCursor] = useState(0)
  /** Keys dealt with in this sitting. Local, so the order never moves. */
  const [cleared, setCleared] = useState<Set<string>>(new Set())

  const items = useMemo(() => data?.items ?? [], [data])
  const keyOf = (i: QueueItem) => `${i.module}:${i.showroomId}:${i.recordKey}`

  const current = items[cursor]
  const remaining = items.length - cleared.size

  const advance = () => setCursor((c) => Math.min(c + 1, items.length))
  const clearAndAdvance = () => {
    if (current) setCleared((s) => new Set(s).add(keyOf(current)))
    advance()
  }

  if (isLoading) {
    return (
      <div className="py-24 text-center text-sm text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Working out what is waiting…
      </div>
    )
  }

  if (isError) {
    return (
      <div className="py-24 text-center">
        <p className="text-sm text-slate-500">The queue could not be built.</p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* The leading number. Everything waiting on a person, across every
          module this role may read — which is the whole done-when. */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-bold text-slate-900 tabular-nums">{data?.total ?? 0}</span>
            <h1 className="text-base font-bold text-slate-900">
              waiting on a person
            </h1>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Across every module you can read. Worked from the top: yours first, then the work
            nobody is carrying, then your outlet's.
          </p>
          {dataUpdatedAt > 0 && (
            // The list is deliberately not live — see the note at the top of
            // this file — so saying when it was built is the difference between
            // a stale screen and a screen that admits it.
            <p className="text-[11px] text-slate-400 mt-1">
              Built at{" "}
              {new Date(dataUpdatedAt).toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
              . Anything that has happened since is not on it.
            </p>
          )}
        </div>
        <button
          onClick={() => {
            void refetch()
            setCursor(0)
            setCleared(new Set())
          }}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500
                     hover:text-slate-800 border border-slate-200 rounded-md px-3 h-8 bg-white"
        >
          {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
          Rebuild the list
        </button>
      </div>

      {/* Band counts, then the module spread. Two different questions: whose is
          it, and what kind of work is it. */}
      <div className="grid grid-cols-3 gap-3">
        {(["MINE", "UNASSIGNED", "OUTLET"] as const).map((band) => {
          const n = band === "MINE" ? data?.mine : band === "UNASSIGNED" ? data?.unassigned : data?.outlet
          return (
            <div
              key={band}
              className={`rounded-lg border p-3 ${
                band === "UNASSIGNED" && (n ?? 0) > 0
                  ? "border-amber-200 bg-amber-50"
                  : "border-slate-200 bg-white"
              }`}
            >
              <div className="text-xl font-bold text-slate-900 tabular-nums">{n ?? 0}</div>
              <div className="text-xs font-semibold text-slate-700">{BAND_LABEL[band]}</div>
              <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">{BAND_BLURB[band]}</div>
            </div>
          )
        })}
      </div>

      {(data?.byModule.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data!.byModule.map((m) => (
            <span
              key={m.module}
              className="text-[11px] font-medium text-slate-600 bg-slate-100 rounded px-2 py-1"
            >
              {MODULE_LABEL[m.module] ?? m.module} · {m.count}
            </span>
          ))}
        </div>
      )}

      {/* The one item. */}
      {current ? (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2 flex-wrap">
            <span className={`text-[11px] font-bold uppercase tracking-wider border rounded px-1.5 py-0.5 ${severityTone(current.severity)}`}>
              {severityWord(current.severity)}
            </span>
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              {MODULE_LABEL[current.module] ?? current.module}
            </span>
            <span className="text-[11px] text-slate-400">·</span>
            <span className="text-[11px] font-medium text-slate-500">{BAND_LABEL[current.band]}</span>
            {current.showroomCode && (
              <>
                <span className="text-[11px] text-slate-400">·</span>
                <span className="text-[11px] font-medium text-slate-500">{current.showroomCode}</span>
              </>
            )}
            <span className="ml-auto text-[11px] text-slate-400 tabular-nums">
              {cursor + 1} of {items.length}
            </span>
          </div>

          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{current.title}</h2>
              {current.subtitle && (
                <p className="text-sm text-slate-500 mt-0.5">{current.subtitle}</p>
              )}
            </div>

            {/* Whose it is, said plainly. A departed assignee is the reason this
                item is in the second band and not the third, so it is printed
                rather than implied. */}
            {current.assigneeGone ? (
              <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                <UserX className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                <span className="text-amber-900">
                  Was {current.assignedEmpName ?? current.assignedEmpCode}, who has left. Nobody is
                  carrying this.
                </span>
              </div>
            ) : current.assignedEmpCode && current.band !== "MINE" ? (
              // Only when it is somebody else's. Telling a person their own
              // work is carried by their own employee code is noise on the one
              // screen that exists to remove noise.
              <div className="text-xs text-slate-500">
                Carried by{" "}
                <span className="font-medium text-slate-700">
                  {current.assignedEmpName ?? current.assignedEmpCode}
                </span>
              </div>
            ) : null}

            {current.note && <p className="text-sm text-slate-600">{current.note}</p>}

            <div className="bg-slate-50 border border-slate-200 rounded-md px-4 py-3">
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                What to do
              </div>
              <p className="text-sm font-medium text-slate-900">{current.actionRequired}</p>
              {current.waitingDays > 0 && (
                <p className="text-xs text-slate-500 mt-1 tabular-nums">
                  Waiting {current.waitingDays} day{current.waitingDays === 1 ? "" : "s"}.
                </p>
              )}
            </div>

            {/* Above the controls rather than among them, because it is not one
                more thing you may do — it is the one thing on this screen
                somebody other than you has already worked out. Only present
                while the dealership has the agent switched off; with it on the
                record was assigned before this list was built. */}
            {current.agentSuggestion && current.band === "UNASSIGNED" && (
              <AgentSuggestionCard
                suggestion={current.agentSuggestion}
                target={{ showroomId: current.showroomId, recordKey: current.recordKey }}
              />
            )}

            {/* The controls. Which ones apply was decided by the rules that own
                the module, not by this screen — it renders whatever came back. */}
            <div className="flex items-center gap-2 flex-wrap">
              {current.module === "ENQUIRY" && current.contactMobile ? (
                <ContactButtons
                  target={{ showroomId: current.showroomId, recordKey: current.recordKey }}
                  mobile={current.contactMobile}
                  contactedAt={current.actions.find((a) => a.action === "ENQUIRY_LOG_CONTACT")?.done ? "done" : null}
                  customerName={current.contactName}
                />
              ) : current.contactMobile ? (
                <a
                  href={`tel:${current.contactMobile}`}
                  className="inline-flex items-center gap-1.5 text-xs font-medium h-8 px-3 rounded-md
                             border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  Call {current.contactName ?? current.contactMobile}
                </a>
              ) : null}

              {current.actions
                .filter((a) => !(current.module === "ENQUIRY" && a.action === "ENQUIRY_LOG_CONTACT" && current.contactMobile))
                .map((a) => (
                  <ActionButton
                    key={a.action}
                    action={a.action as DmsActionInputAction}
                    target={{ showroomId: current.showroomId, recordKey: current.recordKey }}
                    label={a.label}
                    doneLabel={a.doneLabel}
                    done={a.done}
                    tone={a.tone}
                    extra={a.extra ?? undefined}
                  />
                ))}

              {/* Handing the work on, where the module has somebody to hand it
                  to. Only when nobody is carrying it: this queue exists to
                  surface orphaned work, not to be a way of moving somebody
                  else's off your own plate. */}
              {current.assignAction && current.band === "UNASSIGNED" && (
                <AssignPicker
                  action={current.assignAction as DmsActionInputAction}
                  target={{ showroomId: current.showroomId, recordKey: current.recordKey }}
                  role={current.assignRole ?? undefined}
                  // Deliberately not `assignedEmpCode`. In this band the code on
                  // the row belongs to nobody or to somebody who has left, and
                  // passing it made the picker render a tick beside a departed
                  // salesman's code with an undo next to it — a confirmation
                  // that the work was assigned, on the one screen that exists
                  // because it is not. There is nothing to undo here.
                  currentEmpCode={null}
                  placeholder="Hand it to…"
                />
              )}

              {EXPLAINABLE.has(current.module) && (
                <ExplainButton
                  module={current.module as never}
                  showroomId={current.showroomId}
                  recordKey={current.recordKey}
                />
              )}

              <Link
                href={current.href}
                className="text-[11px] font-medium text-slate-400 hover:text-slate-700 inline-flex items-center gap-1"
              >
                Open the full screen <ChevronRight className="w-3 h-3" />
              </Link>
            </div>

            {/* The dealership's own account of this record.
                
                Below the controls rather than above: the controls are what you
                came here to do, and the history is what you read when the
                controls are not obviously enough. A task row has no timeline of
                its own — it *is* the thing somebody wrote down. */}
            {current.source !== "TASK" && (
              <Timeline
                module={current.module}
                recordKey={current.recordKey}
                showroomId={current.showroomId}
              />
            )}
          </div>

          {/* Move on. Two doors, and they mean different things: one says this
              is dealt with, the other says not by me and not now. Neither
              writes anything the module does not already own — clearing an item
              here is a fact about this sitting, not about the record. */}
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 flex items-center gap-2">
            <button
              onClick={clearAndAdvance}
              className="inline-flex items-center gap-1.5 text-xs font-semibold h-9 px-4 rounded-md
                         bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <CheckCircle2 className="w-4 h-4" />
              Dealt with — next
            </button>
            <button
              onClick={advance}
              className="inline-flex items-center gap-1.5 text-xs font-medium h-9 px-3 rounded-md
                         border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            >
              <SkipForward className="w-3.5 h-3.5" />
              Skip
            </button>
            <span className="ml-auto text-[11px] text-slate-400 tabular-nums">
              {remaining} left
            </span>
          </div>
        </div>
      ) : items.length > 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
          <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
          <h2 className="text-base font-bold text-slate-900 mt-3">That is the list</h2>
          <p className="text-sm text-slate-500 mt-1">
            You went through all {items.length}. Rebuild it to pick up anything that has arrived
            since.
          </p>
          <button
            onClick={() => {
              void refetch()
              setCursor(0)
              setCleared(new Set())
            }}
            className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold h-9 px-4 rounded-md
                       bg-slate-900 text-white hover:bg-slate-800"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Rebuild the list
          </button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
          <Inbox className="w-8 h-8 text-slate-300 mx-auto" />
          <h2 className="text-base font-bold text-slate-900 mt-3">Nothing is waiting on you</h2>
          <p className="text-sm text-slate-500 mt-1">
            No record in any module you can read is asking for a person right now.
          </p>
        </div>
      )}

      {/* What is coming, so the queue is not a black box. Deliberately not
          clickable into: jumping around is how a queue becomes a list again. */}
      {items.length > 1 && (
        <div>
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
            After this
          </div>
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 bg-white overflow-hidden">
            {items.slice(cursor + 1, cursor + 8).map((i) => (
              <div key={keyOf(i)} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <span className={`text-[10px] font-bold uppercase tracking-wider border rounded px-1 ${severityTone(i.severity)}`}>
                  {i.severity >= 3 ? "now" : i.severity === 2 ? "wk" : "…"}
                </span>
                <span className="text-[11px] font-medium text-slate-400 w-24 shrink-0">
                  {MODULE_LABEL[i.module] ?? i.module}
                </span>
                <span className="font-medium text-slate-800 truncate">{i.title}</span>
                <span className="text-xs text-slate-400 truncate hidden sm:block">
                  {i.actionRequired}
                </span>
                {i.assigneeGone && <UserX className="w-3.5 h-3.5 text-amber-500 shrink-0 ml-auto" />}
              </div>
            ))}
            {items.length > cursor + 8 && (
              <div className="px-4 py-2 text-[11px] text-slate-400 flex items-center gap-1">
                <ArrowRight className="w-3 h-3" />
                and {items.length - cursor - 8} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
