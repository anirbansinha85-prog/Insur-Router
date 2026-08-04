/**
 * DDMS — the outbox, which is really the gate with a face on it.
 *
 * Every other screen in this product reads the dealership's own data back to
 * them. This one is the only place DDMS proposes to say something on their
 * behalf, so it is built to be read rather than skimmed: the whole message is
 * on screen, who it is addressed to is on screen, and the gate's verdict is on
 * screen beside it in plain words.
 *
 * The leading number is **drafts nobody has approved**, and that is the honest
 * headline for a product at this stage of trust. Not "messages sent" — nothing
 * has been sent, because there is no transport configured and the screen says
 * so on every row rather than implying delivery it cannot perform.
 *
 * Two things are deliberately *not* here:
 *
 * - **No "approve all".** The point of an approval is that somebody read it.
 *   A button that approves nine messages at once is a button that approves
 *   nothing, and it would make the gate ceremonial.
 * - **No editing.** A message is what a rule composed and, where the model was
 *   allowed to rephrase it, what a check confirmed asserts nothing the facts do
 *   not support. Free-text editing would put a claim in the dealership's name
 *   that nothing verified. Cancel it and fix the record instead.
 */

import { useState } from "react"
import {
  getListDmsMessagesQueryKey,
  useApproveDmsMessage,
  useCancelDmsMessage,
  useListDmsMessages,
  useSendDmsMessage,
  useListDmsRules,
  type OutboxRow,
  type OutboundMessage,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useShowroom } from "@/lib/showroom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Ban,
  Bot,
  CheckCircle2,
  Loader2,
  Lock,
  Mail,
  MessageCircle,
  Send,
  ShieldCheck,
  UserCheck,
} from "lucide-react"

const STATUS: Record<
  OutboundMessage["status"],
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft" }
> = {
  DRAFT: { label: "Draft", variant: "warning" },
  APPROVED: { label: "Approved", variant: "info" },
  SENT: { label: "Sent", variant: "success" },
  HELD_NO_TRANSPORT: { label: "Held — nothing was delivered", variant: "draft" },
  FAILED: { label: "Failed", variant: "destructive" },
  CANCELLED: { label: "Cancelled", variant: "draft" },
}

const TEMPLATE_LABEL: Record<string, string> = {
  SERVICE_VEHICLE_READY: "Vehicle ready for collection",
  REGISTRATION_RC_READY: "Registration certificate ready",
  REGISTRATION_AGENT_ASSIGNED: "Registration file assigned",
  LEAD_HANDOVER: "Enquiry handed over",
}

function StatCard({
  title,
  value,
  icon: Icon,
  colorClass,
  hint,
  isLoading,
}: {
  title: string
  value?: number
  icon: typeof Mail
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
 * The gate's verdict, said the way somebody deciding would want to hear it.
 *
 * A refusal is not an error state and is not styled as one. "This needs your
 * approval" is the system working, and colouring it red would train people to
 * click past the one screen that is supposed to make them stop.
 */
function Gate({ row }: { row: OutboxRow }) {
  if (row.gate.ok) {
    return (
      <div className="flex items-start gap-1.5 text-[11px] text-green-700">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span>
          {row.gate.basis === "RULE" ? (
            <>
              A rule allows this to go — <code className="text-[10px]">{row.gate.rule}</code>. It is
              internal, and it tells somebody about work already assigned to them.
            </>
          ) : (
            <>Approved by a person. It may be sent.</>
          )}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-amber-700">
      <Lock className="w-3.5 h-3.5 shrink-0 mt-px" />
      <span>{row.gate.reason}</span>
    </div>
  )
}

function MessageCard({ row }: { row: OutboxRow }) {
  const qc = useQueryClient()
  const m = row.message
  const approve = useApproveDmsMessage()
  const send = useSendDmsMessage()
  const cancel = useCancelDmsMessage()
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    void qc.invalidateQueries({
      predicate: (q) => {
        const key = q.queryKey?.[0]
        return typeof key === "string" && key.startsWith("/api/dms/")
      },
    })

  const onError = (e: unknown) => {
    const body = (e as { response?: { data?: { error?: string } } })?.response?.data
    setError(body?.error ?? "That did not work.")
  }
  const opts = { onSuccess: () => { setError(null); refresh() }, onError }

  const busy = approve.isPending || send.isPending || cancel.isPending
  const open = m.status === "DRAFT" || m.status === "APPROVED"
  const status = STATUS[m.status]

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {m.audience === "CUSTOMER" ? (
                <Badge variant="destructive">To a customer</Badge>
              ) : (
                <Badge variant="info">Internal</Badge>
              )}
              <Badge variant={status.variant}>{status.label}</Badge>
              <span className="text-xs font-semibold text-slate-700">
                {TEMPLATE_LABEL[m.template] ?? m.template}
              </span>
              <span className="text-[11px] text-slate-400">
                {m.module.replace(/_/g, " ").toLowerCase()} {m.recordKey}
              </span>
            </div>

            <div className="flex items-center gap-1.5 mt-1.5 text-xs text-slate-500">
              {m.channel === "EMAIL" ? (
                <Mail className="w-3.5 h-3.5" />
              ) : (
                <MessageCircle className="w-3.5 h-3.5 text-green-600" />
              )}
              <span className="font-medium text-slate-700">{m.toName ?? "—"}</span>
              <span className="text-slate-400">{m.toAddress ?? "no address on the record"}</span>
              {m.draftedBy === "AGENT" && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] text-slate-400 ml-1"
                  title="A model rephrased the rule's draft, and a check confirmed it asserts no figure the facts do not support"
                >
                  <Bot className="w-3 h-3" /> worded by the agent
                </span>
              )}
            </div>
          </div>

          <div className="text-[11px] text-slate-400 whitespace-nowrap">
            {new Date(m.createdAt).toLocaleString("en-GB", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>

        {m.subject && (
          <div className="mt-3 text-xs font-semibold text-slate-800">{m.subject}</div>
        )}
        <pre className="mt-1.5 whitespace-pre-wrap font-sans text-xs leading-relaxed text-slate-700
                        bg-slate-50 border border-slate-200 rounded-md p-3 overflow-x-auto">
          {m.body}
        </pre>

        <div className="mt-3 flex items-end justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <Gate row={row} />
            {/* What happened when send was last attempted, and only when it
                says something the verdict above does not.
                
                They used to differ by construction: `failureReason` was
                written when somebody pressed send, and most drafts had never
                been pressed. Since OBJ-16 a rule presses send on every draft it
                raises, so the two are usually the same sentence — and printing
                a refusal twice makes the screen look like it is insisting. */}
            {m.failureReason && m.failureReason !== (row.gate.ok ? null : row.gate.reason) && (
              <div className="flex items-start gap-1.5 text-[11px] text-slate-500 mt-1">
                <Ban className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{m.failureReason}</span>
              </div>
            )}
            {error && <div className="text-[11px] text-red-600 mt-1">{error}</div>}
          </div>

          {open && (
            <div className="flex items-center gap-2 shrink-0">
              {m.status === "DRAFT" && !row.gate.ok && (
                <button
                  onClick={() => approve.mutate({ id: m.id, data: {} }, opts)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md
                             border border-amber-200 text-amber-700 bg-white hover:bg-amber-50
                             transition-colors disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCheck className="w-3 h-3" />}
                  Approve — I have read this
                </button>
              )}
              <button
                onClick={() => send.mutate({ id: m.id }, opts)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md
                           border border-slate-200 text-slate-600 bg-white hover:bg-slate-50
                           transition-colors disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                Send
              </button>
              <button
                onClick={() => cancel.mutate({ id: m.id, data: {} }, opts)}
                disabled={busy}
                className="text-[11px] text-slate-400 hover:text-slate-600 disabled:opacity-40"
              >
                cancel
              </button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * What runs itself, in the order it is evaluated.
 *
 * Here rather than on a settings screen, because this is where the drafts these
 * rules produce arrive: somebody reading an unexpected message wants to know
 * what raised it without leaving the page. The list is short by construction
 * and shown whole — an automation layer nobody can predict begins with an
 * automation layer nobody can see.
 *
 * Nothing here is editable. Changing the set is a deployment (R-52).
 */
function RulesPanel() {
  const [open, setOpen] = useState(false)
  const { data } = useListDmsRules({ query: { queryKey: ["/api/dms/rules"] } })
  const rules = data?.rules ?? []
  if (rules.length === 0) return null

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-2 text-left"
      >
        <span className="text-sm font-semibold text-slate-800">What runs itself</span>
        <span className="text-[11px] text-slate-400">
          {rules.length} rules, ceiling {data?.max}
        </span>
        <span className="ml-auto text-[11px] font-medium text-slate-400">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="border-t border-slate-100 divide-y divide-slate-100">
          {rules.map((r, i) => (
            <div key={r.id} className="px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-bold text-slate-400 tabular-nums">{i + 1}</span>
                <span className="text-sm font-medium text-slate-900">{r.title}</span>
                {r.conditional && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    conditional
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-1 pl-5 space-y-0.5">
                <div>
                  <span className="font-medium text-slate-600">When</span> a{" "}
                  {r.module.replace(/_/g, " ").toLowerCase()} is{" "}
                  <span className="font-mono text-[11px]">{r.on}</span>, at most every{" "}
                  {r.cadenceDays} day{r.cadenceDays === 1 ? "" : "s"}
                </div>
                <div>
                  <span className="font-medium text-slate-600">Stops when</span> {r.goal}
                </div>
              </div>
            </div>
          ))}
          <div className="px-4 py-2.5 text-[11px] text-slate-400">
            A rule drafts and presses send. What may actually leave is the gate's decision, and
            every customer-facing message waits for a person.
          </div>
        </div>
      )}
    </div>
  )
}

export default function Outbox() {
  const { selected } = useShowroom()
  const params = { showroomId: selected?.id ?? 0 }
  const { data, isLoading } = useListDmsMessages(params, {
    query: {
      queryKey: getListDmsMessagesQueryKey(params),
      enabled: Boolean(selected?.id),
    },
  })

  const rows = data?.rows ?? []
  const s = data?.summary

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Outbox</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Everything DDMS has drafted, and whether it may go. Nothing leaves without either a rule
          permitting it or somebody approving it.
        </p>
      </div>

      <RulesPanel />

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          title="Waiting on somebody"
          value={s?.awaitingApproval}
          icon={UserCheck}
          colorClass="text-amber-500"
          hint="Drafts no rule permits — every one is to a customer"
          isLoading={isLoading}
        />
        <StatCard
          title="A rule would send"
          value={s?.ruleWouldSend}
          icon={ShieldCheck}
          colorClass="text-green-600"
          hint="Internal, to the person the record is assigned to"
          isLoading={isLoading}
        />
        <StatCard
          title="Authorised, undelivered"
          value={s?.held}
          icon={Lock}
          colorClass="text-slate-400"
          hint="No transport configured, so nobody received these"
          isLoading={isLoading}
        />
        <StatCard
          title="Actually sent"
          value={s?.sent}
          icon={CheckCircle2}
          colorClass="text-slate-400"
          hint="Zero until an email or WhatsApp account is connected"
          isLoading={isLoading}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center">
            <Mail className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-sm text-slate-500 mt-3">Nothing drafted.</p>
            <p className="text-xs text-slate-400 mt-1">
              Messages are composed from the worklists — a vehicle ready for collection, a
              certificate in the drawer, a file somebody has just been given.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <MessageCard key={row.message.id} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}
