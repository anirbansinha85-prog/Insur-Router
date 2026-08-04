/**
 * The panel that explains, and the evidence it shows underneath.
 *
 * Every worklist row already says what is wrong. This answers the three things
 * it cannot: **why is this stuck**, **who else is affected**, and **what
 * happens if it waits** — each of which reaches across a boundary the dealer's
 * own system keys everything by, another module, another outlet, another
 * person's workload.
 *
 * ## The evidence is on screen, not behind a promise
 *
 * `findings` is one sentence per claim, each assembled by a rule from a row a
 * query returned, and every one of those rows is here under *What was looked
 * at* — collapsed, but present. `summary` is a model's reading of the findings
 * and appears above them, labelled, only when it passed a check that every
 * figure in it appears in the evidence.
 *
 * The findings are shown even when a summary exists. A panel that replaced them
 * with the nicer-sounding paragraph would be dropping the only part of the
 * answer somebody can check, which is the part that makes it worth trusting.
 */

import { useState } from "react"
import { useExplainDmsRecord, type Explanation, type ExplainModule } from "@workspace/api-client-react"
import { Bot, ChevronDown, HelpCircle, Loader2, Ruler, X } from "lucide-react"

export function ExplainButton({
  module,
  showroomId,
  recordKey,
}: {
  module: ExplainModule
  showroomId: number
  recordKey: string
}) {
  const [open, setOpen] = useState(false)
  const mutation = useExplainDmsRecord()
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setError(null)
    setOpen(true)
    mutation.mutate(
      { data: { module, showroomId, recordKey } },
      {
        onError: (e: unknown) => {
          const body = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(body?.error ?? "That did not work.")
        },
      },
    )
  }

  return (
    <>
      <button
        onClick={run}
        title="Why is this stuck, who else is affected, what happens if it waits"
        className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400
                   hover:text-slate-700 transition-colors"
      >
        <HelpCircle className="w-3.5 h-3.5" />
        Explain
      </button>
      {open && (
        <ExplainPanel
          recordKey={recordKey}
          onClose={() => setOpen(false)}
          loading={mutation.isPending}
          error={error}
          data={mutation.data as Explanation | undefined}
        />
      )}
    </>
  )
}

function EvidenceBlock({ tool, looked, rows }: { tool: string; looked: string; rows: unknown[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-slate-200 rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left
                   bg-slate-50 hover:bg-slate-100 transition-colors"
      >
        <span className="text-[11px] text-slate-600">
          <code className="text-[10px] text-slate-500">{tool}</code> — {looked}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] text-slate-400 tabular-nums">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open && (
        <pre className="text-[10px] leading-relaxed text-slate-600 p-3 overflow-x-auto bg-white">
          {JSON.stringify(rows, null, 2)}
        </pre>
      )}
    </div>
  )
}

function ExplainPanel({
  recordKey,
  onClose,
  loading,
  error,
  data,
}: {
  recordKey: string
  onClose: () => void
  loading: boolean
  error: string | null
  data: Explanation | undefined
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} />
      <aside className="relative w-full max-w-xl h-full bg-white shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-slate-900">{recordKey}</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Why it is stuck, who else it touches, what happens if it waits.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Reading the records…
            </div>
          )}
          {error && <div className="text-xs text-red-600">{error}</div>}

          {data && (
            <>
              {data.summary && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                    <Bot className="w-3 h-3" /> Worded by the agent, from the findings below
                  </div>
                  <p className="text-xs leading-relaxed text-slate-700">{data.summary}</p>
                </div>
              )}

              {data.narrationRejected && (
                <div className="text-[11px] text-slate-400">
                  A written summary was refused — {data.narrationRejected}. The findings below are
                  unaffected.
                </div>
              )}

              <div>
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  <Ruler className="w-3 h-3" /> Findings — each one from a row below
                </div>
                <ul className="space-y-1.5">
                  {data.findings.map((f, i) => (
                    <li key={i} className="text-xs leading-relaxed text-slate-700 flex gap-2">
                      <span className="text-slate-300 select-none">·</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  What was looked at
                </div>
                <div className="space-y-1.5">
                  {data.evidence.map((e) => (
                    <EvidenceBlock key={e.tool} tool={e.tool} looked={e.looked} rows={e.rows} />
                  ))}
                </div>
              </div>

              <p className="text-[10px] text-slate-400 pt-1">
                Nothing here decides whether the record is in breach — that is the screen&rsquo;s own
                rule, and it arrives here already made.
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
