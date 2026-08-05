import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetDmsPolicy,
  useSetDmsPolicy,
  useResetDmsPolicy,
  type PolicySetting,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { NativeSelect } from "@/components/ui/select"
import { Loader2, RotateCcw, SlidersHorizontal } from "lucide-react"

/**
 * The dealership's own numbers.
 *
 * Two things decided how a short-staffed dealership spent its day and both were
 * ours: the order of the queue, and the point at which a classifier decides
 * something has gone wrong. Neither is a product question — whether a stuck
 * registration outranks a broken payment promise depends on this group's RTO
 * agent and this group's cash position, and we know neither.
 *
 * ## Why this screen is a list of numbers and not a settings page
 *
 * Every setting here comes from a closed registry in `lib/dms/policy.ts` with a
 * default, a range and a sentence saying what it does. There is nothing to
 * compose and nothing to add. A dealership may change **what the numbers are**
 * and can never change **what the product does with them**, which is the whole
 * difference between configuration and a rule builder — and the failure this
 * product is designed against is an automation layer nobody can predict, in a
 * customer that has no administrator to untangle one.
 *
 * Every row shows the product's default beside the value, so *"what did this
 * used to be"* never needs somebody to remember. Resetting deletes the override
 * rather than writing today's default down, which is why a dealership that
 * resets keeps following our default when we improve it.
 */

const RANK_WORD: Record<number, string> = {
  3: "Today",
  2: "This week",
  1: "When there is time",
}

/** The product's value, said the way the control beside it says values. */
function defaultWord(s: PolicySetting): string | number {
  if (s.unit === "switch") return s.default === 1 ? "Yes" : "No"
  if (s.unit === "rank") return RANK_WORD[s.default] ?? s.default
  return s.default
}

function Row({
  s,
  showroomId,
  editable,
}: {
  s: PolicySetting
  showroomId: number
  editable: boolean
}) {
  const qc = useQueryClient()
  const set = useSetDmsPolicy()
  const [error, setError] = useState<string | null>(null)

  const save = (value: number | null) => {
    setError(null)
    set.mutate(
      { data: { key: s.key, value, showroomId } },
      {
        onSuccess: () => {
          // Every screen that classifies reads these, so everything is stale —
          // including the queue, which is normally left alone while somebody
          // works it. A change to the numbers is exactly the case where it
          // should rebuild, because its order is what just changed.
          void qc.invalidateQueries({
            predicate: (q) => String(q.queryKey?.[0] ?? "").startsWith("/api/dms/"),
          })
        },
        onError: (e: unknown) => {
          const body = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(body?.error ?? "That did not save.")
        },
      },
    )
  }

  return (
    <div className="px-4 py-3 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-900">{s.label}</span>
          {!s.isDefault && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
              yours
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 mt-0.5">{s.help}</p>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {s.unit === "switch" ? (
          // Yes and no rather than a toggle. A toggle that writes on the way
          // past is the wrong control for the one setting on this screen that
          // decides whether something writes to the dealership's records
          // without anybody watching.
          <NativeSelect
            value={String(s.value)}
            disabled={!editable || set.isPending}
            onChange={(e) => save(Number(e.target.value))}
            className="h-8 text-xs w-44"
          >
            <option value="0">No — suggest only</option>
            <option value="1">Yes — let it act</option>
          </NativeSelect>
        ) : s.unit === "rank" ? (
          <NativeSelect
            value={String(s.value)}
            disabled={!editable || set.isPending}
            onChange={(e) => save(Number(e.target.value))}
            className="h-8 text-xs w-44"
          >
            {[3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {RANK_WORD[n]}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={s.min}
              max={s.max}
              defaultValue={s.value}
              disabled={!editable || set.isPending}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (v !== s.value) save(v)
              }}
              className="h-8 w-20 rounded-md border border-slate-300 px-2 text-xs text-right
                         tabular-nums disabled:bg-slate-50 disabled:text-slate-400"
            />
            <span className="text-xs text-slate-400 w-8">days</span>
          </div>
        )}

        {/* The product's number, always in view. Somebody changing a threshold
            three months from now should not have to find out what it was. */}
        <div className="w-28 text-right">
          {s.isDefault ? (
            <span className="text-[11px] text-slate-400">ours: {defaultWord(s)}</span>
          ) : (
            <button
              onClick={() => save(null)}
              disabled={!editable || set.isPending}
              className="text-[11px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
              title={`Back to ${defaultWord(s)}`}
            >
              <RotateCcw className="w-3 h-3" />
              back to {String(defaultWord(s)).toLowerCase()}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Numbers({ role }: { role: string }) {
  const { selected } = useShowroom()
  const qc = useQueryClient()
  const { data, isLoading } = useGetDmsPolicy({ query: { queryKey: ["/api/dms/policy"] } })
  const reset = useResetDmsPolicy()

  // The same pair the route and the row policies name. Everybody may read
  // these — the numbers explain what is on their screen, and hiding them would
  // make the queue's order look arbitrary.
  const editable = role === "OWNER" || role === "MANAGER"

  const settings = data?.settings ?? []
  const changed = settings.filter((s) => !s.isDefault).length

  const sections = [...new Set(settings.map((s) => s.section))]

  if (isLoading) {
    return (
      <div className="py-24 text-center text-sm text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading your numbers…
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Your numbers</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            What comes first on the queue, and when we decide something has gone wrong. These
            started as our opinion; they are yours. Nothing here changes what the product does —
            only the numbers it does it with.
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {changed === 0
              ? "Everything is on our defaults."
              : `${changed} of ${settings.length} changed from our defaults.`}
            {!editable && " Only an owner or a showroom manager can change them."}
          </p>
        </div>
        {editable && changed > 0 && (
          <button
            onClick={() =>
              reset.mutate(
                { data: { showroomId: selected?.id ?? 0 } },
                {
                  onSuccess: () =>
                    void qc.invalidateQueries({
                      predicate: (q) => String(q.queryKey?.[0] ?? "").startsWith("/api/dms/"),
                    }),
                },
              )
            }
            className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500
                       hover:text-slate-800 border border-slate-200 rounded-md px-3 h-8 bg-white"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Back to our defaults
          </button>
        )}
      </div>

      {sections.map((section) => {
        const rows = settings.filter((s) => s.section === section)
        const priorities = rows.filter((s) => s.group === "SEVERITY")
        const thresholds = rows.filter((s) => s.group === "THRESHOLD")
        const switches = rows.filter((s) => s.group === "SWITCH")
        return (
          <div key={section}>
            <div className="flex items-center gap-2 mb-2">
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
              <h2 className="text-sm font-bold text-slate-800">{section}</h2>
            </div>
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
              {switches.length > 0 && (
                <>
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    What it may do on its own
                  </div>
                  <div className="divide-y divide-slate-100">
                    {switches.map((s) => (
                      <Row key={s.key} s={s} showroomId={selected?.id ?? 0} editable={editable} />
                    ))}
                  </div>
                </>
              )}
              {thresholds.length > 0 && (
                <>
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    When it has gone wrong
                  </div>
                  <div className="divide-y divide-slate-100">
                    {thresholds.map((s) => (
                      <Row key={s.key} s={s} showroomId={selected?.id ?? 0} editable={editable} />
                    ))}
                  </div>
                </>
              )}
              {priorities.length > 0 && (
                <>
                  <div className="px-4 py-2 bg-slate-50 border-y border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    What comes first
                  </div>
                  <div className="divide-y divide-slate-100">
                    {priorities.map((s) => (
                      <Row key={s.key} s={s} showroomId={selected?.id ?? 0} editable={editable} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
