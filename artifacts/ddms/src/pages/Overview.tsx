import { Link } from "wouter"
import { useGetDmsOverview } from "@workspace/api-client-react"
import { AlertTriangle, ArrowUpRight, Loader2, Printer, RefreshCw } from "lucide-react"

/**
 * How the business is doing, on one screen (OBJ-35, R-107 and R-108).
 *
 * The queue answers *what do I do next* for the person doing the work. This
 * answers *how is the business doing* for the person who owns it, and until now
 * the only way to ask it was to open seven screens and add up.
 *
 * ## The screen and the report are the same page
 *
 * R-108 says a prospect is shown a report about their own dealership before
 * they buy anything, and that it has to be the same artifact the owner opens
 * every morning afterwards — a diagnostic built only to sell is a brochure, and
 * it stops being true the week after it is produced.
 *
 * So there is no second route and no PDF library. The same design decision as
 * the invoice at `/invoices/:id`: browser print, and a `@media print` block
 * that removes the chrome and nothing else. One layout to be wrong rather than
 * two, and what somebody checks on screen is what comes out of the printer.
 *
 * What print *does* remove is the walk-in affordance — an arrow inviting a
 * click is noise on paper. The figures and their hints print unchanged, and so
 * do the limits, which is the part that matters most: a report handed to a
 * prospect has to carry what it cannot tell them.
 *
 * ## Every figure is a link
 *
 * R-20 says this product is a control panel and not a report, and a number you
 * cannot walk into is a report. The server decides where each one goes; this
 * screen renders `href` and knows nothing about what any figure means.
 *
 * ## Nothing here is computed
 *
 * Not one arithmetic operation on a figure, including the formatting of money,
 * which arrives rounded. If a number on this screen ever disagrees with the
 * module screen behind it, the cause is in `overview.ts` and not here — which
 * is the whole reason this file is as thin as it is.
 */

type Tone = "PLAIN" | "WATCH" | "BAD"

const TONE: Record<Tone, { value: string; card: string; label: string }> = {
  // Most of the screen. A dashboard where everything is red is one nobody
  // reads twice, so context stays quiet and the findings carry the colour.
  PLAIN: {
    value: "text-slate-900",
    card: "border-slate-200 hover:border-slate-300",
    label: "text-slate-500",
  },
  WATCH: {
    value: "text-amber-700",
    card: "border-amber-200 bg-amber-50/40 hover:border-amber-300",
    label: "text-amber-800/70",
  },
  BAD: {
    value: "text-rose-700",
    card: "border-rose-200 bg-rose-50/40 hover:border-rose-300",
    label: "text-rose-800/70",
  },
}

/** Indian grouping. Whole rupees — the paise on a dashboard is noise. */
function rupees(n: number): string {
  const whole = Math.round(n)
  const s = String(Math.abs(whole))
  const last3 = s.slice(-3)
  const rest = s.slice(0, -3)
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3
  return `${whole < 0 ? "−" : ""}₹${grouped}`
}

function display(value: number, unit: string): string {
  if (unit === "RUPEES") return rupees(value)
  if (unit === "DAYS") return `${value} day${value === 1 ? "" : "s"}`
  return String(value)
}

function Figure({
  figure,
}: {
  figure: { key: string; label: string; value: number; unit: string; tone: string; href: string | null; hint: string | null }
}) {
  const tone = TONE[(figure.tone as Tone) ?? "PLAIN"] ?? TONE.PLAIN

  const body = (
    <>
      <div className={`text-2xl font-bold tabular-nums leading-tight ${tone.value}`}>
        {display(figure.value, figure.unit)}
      </div>
      <div className={`text-xs font-medium mt-1 leading-snug ${tone.label}`}>{figure.label}</div>
      {figure.hint && (
        <div className="text-[11px] text-slate-400 mt-1 leading-snug">{figure.hint}</div>
      )}
    </>
  )

  if (!figure.href) {
    return (
      <div className={`rounded-lg border px-3 py-2.5 ${tone.card}`}>
        {body}
        <div className="text-[10px] text-slate-400 mt-1.5 print:hidden">No list behind this one.</div>
      </div>
    )
  }

  return (
    <Link
      href={figure.href}
      className={`group block rounded-lg border px-3 py-2.5 transition-colors relative ${tone.card}`}
    >
      {body}
      {/* Hidden in print: an arrow inviting a click is noise on paper. */}
      <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 absolute top-2.5 right-2.5 print:hidden" />
    </Link>
  )
}

export default function Overview() {
  const { data, isLoading, isError, refetch, isFetching } = useGetDmsOverview({
    query: { queryKey: ["/api/dms/overview"] },
  })

  if (isLoading) {
    return (
      <div className="py-24 flex items-center justify-center text-sm text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Reading every outlet…
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="py-24 text-center">
        <p className="text-sm text-slate-500">The overall view could not be built.</p>
        <button
          onClick={() => void refetch()}
          className="mt-3 text-xs font-medium text-slate-700 underline underline-offset-2"
        >
          Try again
        </button>
      </div>
    )
  }

  const asAt = new Date(data.generatedAt)

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-16">
      {/* ── Who this is about, and when ─────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{data.scope.ownerName}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {data.scope.outlets.map((o) => o.name).join(" · ")}
          </p>
          <p className="text-[11px] text-slate-400 mt-1 tabular-nums">
            As at {asAt.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })},{" "}
            {asAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            {data.mirror.staleHours !== null && data.mirror.staleHours !== undefined && (
              <>
                {" · "}
                mirror {data.mirror.staleHours === 0 ? "current" : `${data.mirror.staleHours}h old`}
              </>
            )}
          </p>

          {/*
            Print only, and it is R-89's instinct applied to a report rather
            than to an invoice: a document must say what it is. On screen the
            chrome says it — the sidebar, the sign-in, the outlet picker. On
            paper this page could be anything, and the one thing a prospect
            most needs to know about it is that it was read out of their own
            system and that nothing was written back.
          */}
          <p className="hidden print:block text-[11px] text-slate-500 mt-1 max-w-2xl">
            Read from this dealership's own DMS. DDMS mirrors that system and
            never writes to it — every figure below is the dealership's own
            data, and none of it was changed to produce this report.
          </p>
        </div>

        <div className="flex items-center gap-2 print:hidden">
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 text-xs font-medium h-8 px-3 rounded-md
                       border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Rebuild
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md
                       bg-slate-900 text-white hover:bg-slate-800"
          >
            <Printer className="w-3.5 h-3.5" />
            Print this report
          </button>
        </div>
      </div>

      {/* ── The three things that matter most today ─────────────────────── */}
      {data.headline.length > 0 && (
        <div className="rounded-lg border border-slate-300 bg-slate-50 print:bg-white px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            What needs attention
          </div>
          <ul className="mt-1.5 space-y-1">
            {data.headline.map((h) => (
              <li key={h} className="text-sm text-slate-900 leading-snug">
                {h}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── The figures ─────────────────────────────────────────────────── */}
      {data.sections.map((section) => (
        <section key={section.id} className="break-inside-avoid">
          <h2 className="text-sm font-bold text-slate-900">{section.title}</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl leading-snug">{section.blurb}</p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 mt-3">
            {section.figures.map((f) => (
              <Figure key={f.key} figure={f} />
            ))}
          </div>
        </section>
      ))}

      {/* ── Named, not zeroed ───────────────────────────────────────────── */}
      {data.scope.withheld.length > 0 && (
        <section className="break-inside-avoid">
          <h2 className="text-sm font-bold text-slate-900">Not in this view</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl leading-snug">
            Outside your role, so left out of the arithmetic rather than counted as zero.
          </p>
          <ul className="mt-2 space-y-1">
            {data.scope.withheld.map((w) => (
              <li key={w.module} className="text-xs text-slate-600">
                <span className="font-semibold">{w.module}</span> — {w.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── What this cannot tell you ───────────────────────────────────── */}
      {/*
        Prints. This is the part a report handed to somebody who has not bought
        anything most needs to carry — every figure above is as true as the last
        sync, nothing has reached a customer, and the honest statement of that
        is what makes the rest worth believing.
      */}
      <section className="break-inside-avoid rounded-lg border border-slate-300 px-4 py-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <AlertTriangle className="w-3 h-3" />
          What this view cannot tell you
        </div>
        <ul className="mt-2 space-y-1.5">
          {data.limits.map((l) => (
            <li key={l} className="text-xs text-slate-600 leading-snug">
              {l}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
