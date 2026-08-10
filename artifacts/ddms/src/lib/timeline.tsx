import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListRecordActivities,
  useWriteRecordActivity,
  useRetractRecordActivity,
  useCreateDmsTask,
  useCloseDmsTask,
  useListShowroomStaff,
  type RecordActivity,
  type ActivityInputKind,
} from "@workspace/api-client-react"
import { Bot, Check, ClipboardList, Loader2, MessageSquare, Undo2, User } from "lucide-react"

/**
 * A record's own timeline, and the first thing on any screen that the dealer's
 * system has no field for.
 *
 * Every other panel in DDMS reads the mirror or a decision field hung off it.
 * This is the dealership's own account of what happened to a record — a note
 * somebody left, a call that was made, something the system checked — and
 * OBJ-22's argument is that it is exactly the class of record an agent can add
 * to without lying.
 *
 * ## Why the kinds are on the form
 *
 * A dropdown of NOTE / CALL / VISIT / MESSAGE looks like bureaucracy until you
 * see what it buys: **CALL and VISIT assert a person did something outside the
 * system, and only a person may write them.** The agent's whole set is OBSERVED
 * and SYSTEM. Collapsing them into one "add a note" box would make that
 * distinction unrepresentable, and it is the distinction the objective rests on.
 *
 * ## Retracted, struck through, still there
 *
 * A withdrawn entry keeps its place with its reason beside it. Somebody reading
 * a timeline three months later needs to know a claim was withdrawn; they do
 * not need it to have vanished. Same argument as a cancelled message staying a
 * row rather than being deleted.
 */

const KIND_LABEL: Record<string, string> = {
  NOTE: "Note",
  CALL: "Called",
  VISIT: "Came in",
  MESSAGE: "Messaged",
  OBSERVED: "Noticed",
  INBOUND: "They said",
  SYSTEM: "System",
}

const KIND_TONE: Record<string, string> = {
  CALL: "text-emerald-700 bg-emerald-50 border-emerald-200",
  VISIT: "text-emerald-700 bg-emerald-50 border-emerald-200",
  MESSAGE: "text-blue-700 bg-blue-50 border-blue-200",
  INBOUND: "text-blue-700 bg-blue-50 border-blue-200",
  OBSERVED: "text-slate-600 bg-slate-50 border-slate-200",
  SYSTEM: "text-slate-500 bg-slate-50 border-slate-200",
  NOTE: "text-slate-700 bg-white border-slate-200",
}

type TimelineModule =
  | "DEAL"
  | "JOB_CARD"
  | "ENQUIRY"
  | "REGISTRATION"
  | "PART"
  | "RECEIVABLE"
  | "VEHICLE"

/** The five a person may write. The other two are not theirs to claim. */
const PERSON_KINDS: ActivityInputKind[] = ["NOTE", "CALL", "VISIT", "MESSAGE", "OBSERVED"]

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function Entry({ a, onRetract }: { a: RecordActivity; onRetract: (id: number) => void }) {
  const gone = Boolean(a.retractedAt)
  return (
    <div className="flex items-start gap-2.5 py-2">
      <div className="mt-0.5 shrink-0">
        {a.authoredBy === "AGENT" ? (
          <Bot className="w-3.5 h-3.5 text-slate-400" />
        ) : (
          <User className="w-3.5 h-3.5 text-slate-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 ${
              KIND_TONE[a.kind] ?? KIND_TONE["NOTE"]
            }`}
          >
            {KIND_LABEL[a.kind] ?? a.kind}
          </span>
          <span className="text-[11px] text-slate-500">
            {/* The agent is named as the agent. R-60: the system acting has to
                be distinguishable from having lost track of who acted. */}
            {a.authoredBy === "AGENT" ? "the agent" : (a.authorName ?? "somebody")}
          </span>
          <span className="text-[11px] text-slate-400">{when(a.createdAt)}</span>
        </div>
        <p
          className={`text-xs mt-0.5 ${
            gone ? "text-slate-400 line-through" : "text-slate-700"
          }`}
        >
          {a.body}
        </p>
        {gone && (
          <p className="text-[11px] text-slate-400 mt-0.5">
            Withdrawn{a.retractedReason ? ` — ${a.retractedReason}` : ""}
          </p>
        )}
      </div>
      {!gone && (
        <button
          onClick={() => onRetract(a.id)}
          title="Withdraw — the entry stays, struck through, with your reason"
          className="shrink-0 text-slate-300 hover:text-slate-600"
        >
          <Undo2 className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

export function Timeline({
  module,
  recordKey,
  showroomId,
}: {
  module: string
  recordKey: string
  showroomId: number
}) {
  const qc = useQueryClient()
  // The generated client takes the module as an inline union rather than a
  // named type, so it is narrowed here. The seven are the ones a record can
  // live under; OUTBOX is a permission module and not a place records live.
  const mod = module as TimelineModule
  const { data, isLoading } = useListRecordActivities(mod, recordKey, {
    query: { queryKey: ["/api/dms/records", module, recordKey] },
  })
  const write = useWriteRecordActivity()
  const retract = useRetractRecordActivity()
  const task = useCreateDmsTask()
  const staff = useListShowroomStaff(
    { showroomId },
    { query: { queryKey: ["/api/dms/staff", { showroomId }] } },
  )

  const [kind, setKind] = useState<ActivityInputKind>("NOTE")
  const [body, setBody] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [taskOpen, setTaskOpen] = useState(false)
  const [taskTitle, setTaskTitle] = useState("")
  const [taskWho, setTaskWho] = useState("")
  const [taskDue, setTaskDue] = useState("")

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["/api/dms/records", module, recordKey] })
    // The queue holds open tasks now, so raising one changes it. It is left
    // alone while somebody is working it — see Queue.tsx — so this is deliberate
    // and narrow rather than the blanket invalidation the other screens use.
    void qc.invalidateQueries({ queryKey: ["/api/dms/queue"] })
  }
  const onError = (e: unknown) => {
    const b = (e as { response?: { data?: { error?: string } } })?.response?.data
    setError(b?.error ?? "That did not save.")
  }

  const activities = data?.activities ?? []

  return (
    <div className="border border-slate-200 rounded-md bg-white">
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
        <MessageSquare className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
          What has happened
        </span>
        <span className="text-[11px] text-slate-400">
          {activities.length === 0 ? "nothing recorded yet" : `${activities.length} entries`}
        </span>
        <button
          onClick={() => setTaskOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500
                     hover:text-slate-800 border border-slate-200 rounded px-2 py-1 bg-white"
        >
          <ClipboardList className="w-3 h-3" />
          Add a task
        </button>
      </div>

      {taskOpen && (
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60 space-y-2">
          <input
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            placeholder="What needs doing?"
            className="w-full h-8 rounded-md border border-slate-300 px-2.5 text-xs"
          />
          <div className="flex items-center gap-2">
            {/* Only people who still work here. A task on a departed
                employee's list is the failure the queue exists to surface. */}
            <select
              value={taskWho}
              onChange={(e) => setTaskWho(e.target.value)}
              className="h-8 rounded-md border border-slate-300 px-2 text-xs bg-white"
            >
              <option value="">Nobody yet</option>
              {(staff.data?.staff ?? []).map((s) => (
                <option key={s.empCode} value={s.empCode}>
                  {s.empName} · {s.carrying} open
                </option>
              ))}
            </select>
            <input
              type="date"
              value={taskDue}
              onChange={(e) => setTaskDue(e.target.value)}
              className="h-8 rounded-md border border-slate-300 px-2 text-xs"
            />
            <button
              onClick={() =>
                task.mutate(
                  {
                    data: {
                      showroomId,
                      title: taskTitle,
                      module: module as never,
                      recordKey,
                      ...(taskWho ? { assignedEmpCode: taskWho } : {}),
                      ...(taskDue ? { dueOn: taskDue } : {}),
                    },
                  },
                  {
                    onSuccess: () => {
                      setTaskTitle("")
                      setTaskWho("")
                      setTaskDue("")
                      setTaskOpen(false)
                      setError(null)
                      refresh()
                    },
                    onError,
                  },
                )
              }
              disabled={!taskTitle.trim() || task.isPending}
              className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3
                         rounded-md border border-emerald-200 text-emerald-700 bg-white
                         hover:bg-emerald-50 disabled:opacity-50"
            >
              {task.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Raise it
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            It appears on the queue with everything else — there is no separate task list.
          </p>
        </div>
      )}

      <div className="px-4 divide-y divide-slate-100 max-h-72 overflow-y-auto">
        {isLoading ? (
          <p className="py-3 text-xs text-slate-400">Loading…</p>
        ) : activities.length === 0 ? (
          <p className="py-3 text-xs text-slate-400">
            Nothing yet. What gets written here is the dealership's own record — the
            manufacturer's system has no field for it.
          </p>
        ) : (
          activities.map((a) => (
            <Entry
              key={a.id}
              a={a}
              onRetract={(id) =>
                retract.mutate(
                  { id, data: { reason: "Withdrawn from the record panel" } },
                  { onSuccess: () => { setError(null); refresh() }, onError },
                )
              }
            />
          ))
        )}
      </div>

      <div className="px-4 py-3 border-t border-slate-100 flex items-start gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ActivityInputKind)}
          className="h-8 shrink-0 rounded-md border border-slate-300 px-2 text-xs bg-white"
        >
          {PERSON_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What happened?"
          className="flex-1 h-8 rounded-md border border-slate-300 px-2.5 text-xs"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !body.trim()) return
            write.mutate(
              { module: mod, recordKey, data: { showroomId, kind, body } },
              { onSuccess: () => { setBody(""); setError(null); refresh() }, onError },
            )
          }}
        />
        <button
          onClick={() =>
            write.mutate(
              { module: mod, recordKey, data: { showroomId, kind, body } },
              { onSuccess: () => { setBody(""); setError(null); refresh() }, onError },
            )
          }
          disabled={!body.trim() || write.isPending}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md
                     border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50"
        >
          {write.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          Record
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-[11px] text-red-600">{error}</p>}
    </div>
  )
}
