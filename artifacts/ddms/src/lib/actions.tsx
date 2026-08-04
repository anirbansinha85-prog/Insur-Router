/**
 * The controls that turn "what to do" into something you can press.
 *
 * Every screen had a column of sentences — *call the customer*, *reassign to
 * someone still here*, *chase the part* — and no way to do any of it. This is
 * the shared half of the fix: one mutation, one set of primitives, so a row on
 * the workshop screen and a row on the registration screen behave the same way
 * and neither reimplements the plumbing.
 *
 * Three things every control does, and they are the reason it is worth having a
 * shared component rather than a button per page:
 *
 * - **It records who.** The server writes a decision-log row against the
 *   session's user, because "we told the customer" is a claim somebody may
 *   later dispute and a bare timestamp cannot say who made it.
 * - **It is reversible.** These marks *remove work from a screen*, so a
 *   mis-click would otherwise quietly delete a phone call somebody still needs
 *   to make. Anything already marked shows an undo.
 * - **It refetches.** The whole point is that the row changes state under you —
 *   pressing "customer told" should move the count on the card above.
 */

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useApplyDmsAction,
  useListShowroomStaff,
  type DmsActionInputAction,
  type StaffMember,
} from "@workspace/api-client-react"
import { Check, Loader2, Phone, RotateCcw, MessageCircle } from "lucide-react"

/** Every worklist query key starts `/api/dms/`, so one predicate covers them all. */
function invalidateWorklists(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({
    predicate: (q) => {
      const key = q.queryKey?.[0]
      if (typeof key !== "string" || !key.startsWith("/api/dms/")) return false
      // Every screen but one. The queue is worked by position, and acting on an
      // item removes it from the server's answer — so refreshing it here would
      // shift everything below up and move the next item out from under the
      // person who was about to read it. It builds fresh on arrival and
      // rebuilds when somebody asks; see the note at the top of Queue.tsx.
      return key !== "/api/dms/queue"
    },
  })
}

export interface ActionTarget {
  showroomId: number
  recordKey: string
}

/**
 * A control that writes one decision field.
 *
 * `done` decides which of the two faces it wears: an invitation, or a quiet
 * confirmation with an undo beside it. Both are the same button underneath,
 * which is why the undo can never drift out of step with the action.
 */
export function ActionButton({
  action,
  target,
  label,
  doneLabel,
  done,
  icon,
  tone = "amber",
  extra,
}: {
  action: DmsActionInputAction
  target: ActionTarget
  label: string
  doneLabel: string
  done: boolean
  icon?: React.ReactNode
  tone?: "amber" | "red" | "slate"
  extra?: Record<string, unknown>
}) {
  const qc = useQueryClient()
  const mutation = useApplyDmsAction()
  const [error, setError] = useState<string | null>(null)

  const run = (clear: boolean) => {
    setError(null)
    mutation.mutate(
      { data: { action, showroomId: target.showroomId, recordKey: target.recordKey, clear, ...extra } },
      {
        onSuccess: () => invalidateWorklists(qc),
        onError: (e: unknown) => {
          // The server refuses some of these on purpose — assigning work to
          // somebody who has left, most often — and the reason is the useful
          // part, so it is shown rather than swallowed into a toast.
          const body = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(body?.error ?? "That did not work.")
        },
      },
    )
  }

  const busy = mutation.isPending
  const toneClass =
    tone === "red"
      ? "border-red-200 text-red-700 hover:bg-red-50"
      : tone === "slate"
        ? "border-slate-200 text-slate-600 hover:bg-slate-50"
        : "border-amber-200 text-amber-700 hover:bg-amber-50"

  if (done) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700">
          <Check className="w-3 h-3" /> {doneLabel}
        </span>
        <button
          onClick={() => run(true)}
          disabled={busy}
          title="Undo — this puts the row back on the worklist"
          className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          undo
        </button>
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={() => run(false)}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border bg-white transition-colors disabled:opacity-50 ${toneClass}`}
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : icon}
        {label}
      </button>
      {error && <div className="text-[11px] text-red-600 mt-1 max-w-xs">{error}</div>}
    </div>
  )
}

/**
 * Ring them, and record that you did.
 *
 * The number was already on the row and doing nothing. Two separate things
 * happen here and the order matters: the `tel:` or `wa.me` link opens *first*,
 * because the point is to make the call — logging it is the bookkeeping that
 * follows, not a substitute for it.
 */
export function ContactButtons({
  target,
  mobile,
  contactedAt,
  customerName,
}: {
  target: ActionTarget
  mobile: string | null | undefined
  contactedAt: string | null | undefined
  customerName?: string | null
}) {
  const qc = useQueryClient()
  const mutation = useApplyDmsAction()

  const log = (channel: "CALL" | "WHATSAPP") =>
    mutation.mutate(
      {
        data: {
          action: "ENQUIRY_LOG_CONTACT",
          showroomId: target.showroomId,
          recordKey: target.recordKey,
          channel,
        },
      },
      { onSuccess: () => invalidateWorklists(qc) },
    )

  if (contactedAt) {
    return (
      <ActionButton
        action="ENQUIRY_LOG_CONTACT"
        target={target}
        label=""
        doneLabel={`contacted ${new Date(contactedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
        done
      />
    )
  }

  if (!mobile) {
    return <span className="text-[11px] text-slate-400">no number on the record</span>
  }

  const wa = `https://wa.me/91${mobile.replace(/\D/g, "").slice(-10)}`
  const greeting = customerName ? `?text=${encodeURIComponent(`Hello ${customerName}, `)}` : ""

  return (
    <div className="flex items-center gap-1.5">
      <a
        href={`tel:${mobile}`}
        onClick={() => log("CALL")}
        className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border
                   border-amber-200 text-amber-700 bg-white hover:bg-amber-50 transition-colors"
      >
        <Phone className="w-3 h-3" />
        {mobile}
      </a>
      <a
        href={`${wa}${greeting}`}
        target="_blank"
        rel="noreferrer"
        onClick={() => log("WHATSAPP")}
        title="Open WhatsApp and record the contact"
        className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-slate-200
                   text-green-600 bg-white hover:bg-green-50 transition-colors"
      >
        <MessageCircle className="w-3.5 h-3.5" />
      </a>
    </div>
  )
}

/**
 * Hand the work to somebody who still works here.
 *
 * The list excludes anybody who has left — they are the reason this control
 * exists, and offering their name would reproduce the bug. Each option carries
 * what that person is already holding, because handing an orphaned lead to
 * whoever is busiest is a decision this product would have made worse.
 */
export function AssignPicker({
  action,
  target,
  role,
  currentEmpCode,
  currentLabel,
  placeholder = "Reassign to…",
}: {
  action: DmsActionInputAction
  target: ActionTarget
  role?: string
  currentEmpCode?: string | null
  currentLabel?: string | null
  placeholder?: string
}) {
  const qc = useQueryClient()
  const mutation = useApplyDmsAction()
  const [error, setError] = useState<string | null>(null)

  const params = { showroomId: target.showroomId, ...(role ? { role } : {}) }
  const { data } = useListShowroomStaff(params, {
    query: { queryKey: ["/api/dms/staff", params] },
  })
  const staff: StaffMember[] = data?.staff ?? []

  const assign = (empCode: string) => {
    setError(null)
    mutation.mutate(
      {
        data: {
          action,
          showroomId: target.showroomId,
          recordKey: target.recordKey,
          empCode,
          clear: empCode === "",
        },
      },
      {
        onSuccess: () => invalidateWorklists(qc),
        onError: (e: unknown) => {
          const body = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(body?.error ?? "That did not work.")
        },
      },
    )
  }

  if (currentEmpCode) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700">
          <Check className="w-3 h-3" /> {currentLabel ?? currentEmpCode}
        </span>
        <button
          onClick={() => assign("")}
          className="text-[11px] text-slate-400 hover:text-slate-600"
          title="Undo — this puts the row back on the worklist"
        >
          undo
        </button>
      </div>
    )
  }

  return (
    <div>
      <select
        defaultValue=""
        onChange={(e) => e.target.value && assign(e.target.value)}
        disabled={mutation.isPending}
        className="text-xs h-7 px-2 rounded-md border border-amber-200 text-amber-700 bg-white
                   hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-500/30 disabled:opacity-50"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {staff.length === 0 ? (
          <option disabled>nobody active at this outlet</option>
        ) : (
          staff.map((s) => (
            <option key={s.empCode} value={s.empCode}>
              {s.empName} · {s.carrying} open
            </option>
          ))
        )}
      </select>
      {error && <div className="text-[11px] text-red-600 mt-1 max-w-xs">{error}</div>}
    </div>
  )
}
