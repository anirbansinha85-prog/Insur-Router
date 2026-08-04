/**
 * The control that drafts a message, and nothing more than that.
 *
 * It deliberately does not approve and does not send. Approving is reading
 * something and deciding it may go out under the dealership's name, and that is
 * not a thing to do from a list of forty rows with one hand on the scroll
 * wheel. So this button composes, says what the gate made of it, and points at
 * the outbox — where the message is on screen in full and the decision has the
 * person's attention.
 *
 * The two verdicts it can report are the whole product in one line:
 *
 * - *needs approval* — a customer message. No rule permits one, ever.
 * - *a rule allows this* — internal email to the person the record is
 *   assigned to, and the only thing DDMS will send without being asked twice.
 */

import { useState } from "react"
import { Link } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useDraftDmsMessage,
  type MessageTemplate,
} from "@workspace/api-client-react"
import { Loader2, PenLine, ShieldCheck, UserCheck } from "lucide-react"

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({
    predicate: (q) => {
      const key = q.queryKey?.[0]
      return typeof key === "string" && key.startsWith("/api/dms/")
    },
  })
}

export function DraftButton({
  template,
  showroomId,
  recordKey,
  label,
}: {
  template: MessageTemplate
  showroomId: number
  recordKey: string
  label: string
}) {
  const qc = useQueryClient()
  const mutation = useDraftDmsMessage()
  const [done, setDone] = useState<{ gateOk: boolean; basis?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setError(null)
    mutation.mutate(
      { data: { template, showroomId, recordKey } },
      {
        onSuccess: (res) => {
          setDone({ gateOk: res.gate.ok, basis: res.gate.basis })
          invalidate(qc)
        },
        onError: (e: unknown) => {
          // The server refuses these on purpose — a message whose premise is
          // false, a file nobody is assigned to — and the reason is the useful
          // part, so it is shown rather than swallowed.
          const body = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(body?.error ?? "That did not work.")
        },
      },
    )
  }

  if (done) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        {done.gateOk ? (
          <span className="inline-flex items-center gap-1 font-medium text-green-700">
            <ShieldCheck className="w-3 h-3" />
            drafted · {done.basis === "RULE" ? "a rule allows this" : "approved"}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-amber-700">
            <UserCheck className="w-3 h-3" /> drafted · needs approval
          </span>
        )}
        <Link href="/outbox" className="text-slate-400 hover:text-slate-700 underline">
          open the outbox
        </Link>
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={mutation.isPending}
        className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border
                   bg-white border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors
                   disabled:opacity-50"
      >
        {mutation.isPending ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <PenLine className="w-3 h-3" />
        )}
        {label}
      </button>
      {error && <div className="text-[11px] text-red-600 mt-1 max-w-xs">{error}</div>}
    </div>
  )
}
