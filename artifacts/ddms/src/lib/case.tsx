import { useState } from "react"
import { useGetCaseRecord, type CaseField } from "@workspace/api-client-react"
import { ChevronDown, ChevronRight, Database, FileSearch, Loader2, PenLine } from "lucide-react"

/**
 * The whole record, every field, behind one click.
 *
 * The queue's job is to say *what to do next*, and for a long time that was the
 * only thing it could say: a row read *"mark customer told"* and offered a
 * button, with no way to see the record the instruction came from. Acting on a
 * conclusion you cannot inspect is a thing people do twice and then stop doing.
 *
 * ## Complete, not curated
 *
 * Every column appears. A field nobody has written a label for is humanised and
 * shown anyway, because the failure worth designing against is a value that
 * exists and is invisible — and a tidy, curated view is exactly how that happens
 * quietly, six months after somebody adds a column.
 *
 * ## Two groups, and the split is the argument
 *
 * **From the manufacturer's system** — pulled, never written back. **Concluded
 * here** — ours, and the thing the dealer's system has no room for. Somebody
 * reading a stuck file needs to know which half a value is in, because only one
 * of them is theirs to change on this screen.
 *
 * Collapsed by default. The point of the queue is still the next action; this
 * is for the moment somebody wants to check rather than act.
 */

const ORIGIN: Record<string, { label: string; icon: typeof Database; tone: string }> = {
  MIRROR: {
    label: "From the manufacturer's system",
    icon: Database,
    tone: "text-slate-600",
  },
  DDMS: {
    label: "Concluded here",
    icon: PenLine,
    tone: "text-emerald-700",
  },
  META: {
    label: "Sync record",
    icon: FileSearch,
    tone: "text-slate-400",
  },
}

function Group({
  origin,
  fields,
  confidence,
}: {
  origin: string
  fields: CaseField[]
  confidence: Record<string, number> | null
}) {
  if (fields.length === 0) return null
  const meta = ORIGIN[origin]!
  const Icon = meta.icon

  return (
    <div className="py-2">
      <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${meta.tone}`}>
        <Icon className="w-3 h-3" />
        {meta.label}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        {fields.map((f) => (
          <div key={f.key} className="flex items-baseline gap-2 text-xs border-b border-slate-50 py-0.5">
            <dt className="text-slate-500 w-44 shrink-0">{f.label}</dt>
            <dd
              className={`font-medium tabular-nums ${
                f.value === null ? "text-slate-300 italic" : "text-slate-800"
              }`}
            >
              {f.value ?? "not set"}
            </dd>
            {/* Where a value arrived by report or scan rather than an API, the
                row says how sure it is (OBJ-24, R-85). An API field carries
                nothing, because there is no reason to doubt it. */}
            {confidence?.[f.key] !== undefined && (
              <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">
                {Math.round(confidence[f.key]! * 100)}% sure
              </span>
            )}
          </div>
        ))}
      </dl>
    </div>
  )
}

export function CasePanel({ module, recordKey }: { module: string; recordKey: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, isError } = useGetCaseRecord(module as never, recordKey, {
    query: { queryKey: ["/api/dms/records", module, recordKey, "case"], enabled: open, retry: false },
  })

  return (
    <div className="border border-slate-200 rounded-md bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-slate-50
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
        )}
        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
          Open the case
        </span>
        <span className="text-[11px] text-slate-400">
          every field on {recordKey}
        </span>
        {data?.disappearedFromDms && (
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
            no longer in their system
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-3 border-t border-slate-100">
          {isLoading ? (
            <p className="py-3 text-xs text-slate-400 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Reading the record…
            </p>
          ) : isError || !data ? (
            <p className="py-3 text-xs text-slate-400">
              This record could not be read. It may have been removed upstream.
            </p>
          ) : (
            <>
              <div className="pt-2 pb-1">
                <p className="text-sm font-semibold text-slate-900">{data.title}</p>
                {data.subtitle && <p className="text-xs text-slate-500">{data.subtitle}</p>}
                {data.provenance?.path && data.provenance.path !== "API" && (
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    This record arrived by{" "}
                    {data.provenance?.path === "REPORT" ? "an exported report" : "a scanned document"},
                    so it is only as current as that.
                  </p>
                )}
              </div>
              <div className="divide-y divide-slate-100">
                {(["DDMS", "MIRROR", "META"] as const).map((origin) => (
                  <Group
                    key={origin}
                    origin={origin}
                    fields={data.fields.filter((f) => f.origin === origin)}
                    confidence={data.provenance?.confidence ?? null}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
