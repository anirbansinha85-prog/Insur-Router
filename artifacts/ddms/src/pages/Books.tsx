import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListVouchers,
  useGetGstr1,
  useGetTallyFeed,
  useReverseVoucher,
  useMarkTallyHandedOver,
  type Voucher,
} from "@workspace/api-client-react"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Undo2,
} from "lucide-react"

/**
 * The books, the return and the feeder (OBJ-31 to OBJ-33).
 *
 * ## The warnings are the feature, not the exception state
 *
 * A voucher that posted cleanly needs almost no screen. The ones worth a
 * dealership's attention are the ones carrying a warning — a charge nobody
 * recognised sitting in suspense, a sale whose vehicle was not in stock so the
 * whole selling price currently reads as margin, a manufacturer's scheme
 * claimable and not posted. Those are surfaced on the row rather than folded
 * inside it, because the failure R-102 and R-103 describe is silent by nature:
 * the books balance either way.
 *
 * ## Nothing on this page edits an entry
 *
 * There is no edit control and there will not be one. A posted voucher is
 * reversed by a second voucher carrying its mirror, and the reversal asks for a
 * reason it keeps. A set of books whose entries can be changed after the fact
 * is not evidence of anything, and the month it was closed on is already inside
 * somebody's return.
 *
 * ## The feeder says it is a feeder
 *
 * R-98's posture, in the copy: this produces vouchers for whatever the
 * dealership already keeps, and becomes the record only once the two have
 * reconciled for a while. Nothing here claims to *be* their accounts, because a
 * product that claims that on day one is one their CA will not use on day two.
 */

const today = new Date()
const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`

function rupees(v: string | number): string {
  const n = Number(v)
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function VoucherRow({ voucher }: { voucher: Voucher }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const reverse = useReverseVoucher()
  const [error, setError] = useState<string | null>(null)

  const reversed = voucher.status === "REVERSED"

  return (
    <div
      className={`rounded-lg border bg-white ${
        voucher.warnings.length > 0 ? "border-amber-200" : "border-slate-200"
      } ${reversed ? "opacity-60" : ""}`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 rounded-lg"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        )}
        <span className="text-xs font-mono text-slate-500 shrink-0 w-20 tabular-nums">
          {voucher.kind === "SALES" ? "S" : voucher.kind === "CREDIT_NOTE" ? "C" : "J"}
          {voucher.voucherNo}
        </span>
        <span className="text-xs text-slate-400 shrink-0 tabular-nums w-24">
          {voucher.voucherDate}
        </span>
        <span className="text-sm text-slate-800 flex-1 min-w-0 truncate">
          {voucher.narration ?? "—"}
        </span>
        {reversed && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 shrink-0">
            Reversed
          </span>
        )}
        {voucher.warnings.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">
            <AlertTriangle className="w-3 h-3" />
            {voucher.warnings.length}
          </span>
        )}
        <span className="text-sm font-semibold text-slate-900 tabular-nums shrink-0">
          {rupees(voucher.totalDebit)}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 text-left">
                <th className="font-medium px-4 py-1.5">Account</th>
                <th className="font-medium px-2 py-1.5">Particulars</th>
                <th className="font-medium px-2 py-1.5 text-right w-28">Debit</th>
                <th className="font-medium px-4 py-1.5 text-right w-28">Credit</th>
              </tr>
            </thead>
            <tbody>
              {voucher.lines.map((l) => (
                <tr key={l.seq} className="border-t border-slate-50">
                  <td className="px-4 py-1.5">
                    <span className="font-mono text-slate-400 mr-1.5">{l.accountCode}</span>
                    <span className="text-slate-800">{l.accountName}</span>
                  </td>
                  <td className="px-2 py-1.5 text-slate-500 truncate max-w-xs">
                    {l.partyName ?? l.narration ?? ""}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-800">
                    {Number(l.debit) > 0 ? rupees(l.debit) : ""}
                  </td>
                  <td className="px-4 py-1.5 text-right tabular-nums text-slate-800">
                    {Number(l.credit) > 0 ? rupees(l.credit) : ""}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 font-semibold">
                <td className="px-4 py-1.5" colSpan={2}>
                  {/* Shown on every voucher, not only when it is wrong. A total
                      that only appears on failure is one nobody checks. */}
                  Balanced
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {rupees(voucher.totalDebit)}
                </td>
                <td className="px-4 py-1.5 text-right tabular-nums">
                  {rupees(voucher.totalCredit)}
                </td>
              </tr>
            </tbody>
          </table>

          {voucher.warnings.length > 0 && (
            <ul className="px-4 py-2 space-y-1 bg-amber-50/50 border-t border-amber-100">
              {voucher.warnings.map((w) => (
                <li key={w} className="text-[11px] text-amber-900 leading-snug">
                  {w}
                </li>
              ))}
            </ul>
          )}

          {!reversed && (
            <div className="px-4 py-2 border-t border-slate-100 flex items-center gap-2">
              <button
                onClick={() => {
                  const reason = window.prompt(
                    "Why is this being reversed? The reason goes on the voucher and stays there.",
                  )
                  if (!reason?.trim()) return
                  setError(null)
                  reverse.mutate(
                    { id: voucher.id, data: { reason: reason.trim() } },
                    {
                      onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/dms/ledger/vouchers"] }),
                      onError: (e: unknown) =>
                        setError(
                          (e as { response?: { data?: { error?: string } } })?.response?.data
                            ?.error ?? "That did not work.",
                        ),
                    },
                  )
                }}
                disabled={reverse.isPending}
                className="inline-flex items-center gap-1.5 text-xs font-medium h-7 px-2.5 rounded-md
                           border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Undo2 className="w-3 h-3" />
                Reverse
              </button>
              <span className="text-[11px] text-slate-400">
                Never an edit. A second voucher carries the mirror of this one.
              </span>
              {error && <span className="text-[11px] text-rose-600">{error}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Books() {
  const qc = useQueryClient()
  const [period, setPeriod] = useState(thisMonth)
  const [showReturn, setShowReturn] = useState(false)

  const vouchers = useListVouchers({ query: { queryKey: ["/api/dms/ledger/vouchers"] } })
  const gstr1 = useGetGstr1(
    { period },
    { query: { queryKey: ["/api/dms/ledger/gstr1", period], enabled: showReturn } },
  )
  const feed = useGetTallyFeed(
    { from: `${period}-01`, to: `${period}-31` },
    { query: { queryKey: ["/api/dms/ledger/tally", period] } },
  )
  const handedOver = useMarkTallyHandedOver()

  const rows = vouchers.data?.vouchers ?? []
  const withWarnings = rows.filter((v) => v.warnings.length > 0).length

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-16">
      <div>
        <h1 className="text-xl font-bold text-slate-900">The books</h1>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl leading-snug">
          Double entry from the documents DDMS issues. This is a{" "}
          <strong className="font-semibold text-slate-700">feeder</strong>, not your
          book of record — it produces vouchers for whatever you already keep, and
          becomes the record only once the two have reconciled for a while.
        </p>
      </div>

      {withWarnings > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-amber-900">
              {withWarnings} {withWarnings === 1 ? "entry needs" : "entries need"} your
              accountant
            </div>
            <p className="text-sm text-amber-900 mt-0.5 leading-snug">
              Each one posted and balanced. What they could not do is on the row — a
              charge nobody recognised sitting in suspense rather than income, or a
              sale whose vehicle was not in stock, which leaves the whole selling
              price reading as margin until it is.
            </p>
          </div>
        </div>
      )}

      {/* ── The return and the feed ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-bold text-slate-900">GSTR-1</h2>
          </div>
          <p className="text-xs text-slate-500 mt-1 leading-snug">
            Invoice-wise for a buyer with a GST number, aggregated for everybody
            else. Nothing here recomputes tax — it reads what was printed on the
            document your customer holds.
          </p>
          <div className="flex items-center gap-2 mt-2.5">
            <input
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              placeholder="YYYY-MM"
              className="flex h-8 w-28 rounded-md border border-input bg-background px-2 text-xs tabular-nums"
            />
            <button
              onClick={() => setShowReturn(true)}
              className="text-xs font-semibold h-8 px-3 rounded-md bg-slate-900 text-white hover:bg-slate-800"
            >
              Build it
            </button>
            <a
              href={`/api/dms/ledger/gstr1?period=${period}&format=csv`}
              className="inline-flex items-center gap-1.5 text-xs font-medium h-8 px-3 rounded-md
                         border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
          </div>

          {showReturn && gstr1.isLoading && (
            <div className="mt-2 text-xs text-slate-400 flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Reading the books…
            </div>
          )}
          {showReturn && gstr1.data && (
            <div className="mt-2.5 text-xs space-y-1">
              <div className="tabular-nums text-slate-700">
                {gstr1.data.totals.invoices} invoice
                {gstr1.data.totals.invoices === 1 ? "" : "s"} ·{" "}
                {rupees(gstr1.data.totals.taxableValue)} taxable ·{" "}
                {rupees(gstr1.data.totals.tax)} tax
              </div>
              <div className="text-slate-400">
                {gstr1.data.b2b.length} B2B rows · {gstr1.data.b2cs.length} B2C
                summaries · {gstr1.data.hsn.length} HSN rows
              </div>
              {/* Shown with the result rather than instead of it. A return with
                  three rows missing a place of supply is still worth having in
                  front of somebody. */}
              {gstr1.data.problems.length > 0 && (
                <ul className="space-y-1 mt-1.5">
                  {gstr1.data.problems.map((p) => (
                    <li key={p} className="text-amber-800 leading-snug">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-bold text-slate-900">Into Tally</h2>
          </div>
          <p className="text-xs text-slate-500 mt-1 leading-snug">
            Vouchers in the shape Tally imports, using whatever names your own
            chart uses. Bring them in beside what you already keep and reconcile
            the two — that is the point of a feeder.
          </p>
          <div className="flex items-center gap-2 mt-2.5">
            <a
              href={`/api/dms/ledger/tally?from=${period}-01&to=${period}-31&format=xml`}
              className="inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md
                         bg-slate-900 text-white hover:bg-slate-800"
            >
              <Download className="w-3.5 h-3.5" />
              Download XML
            </a>
            <button
              onClick={() =>
                handedOver.mutate(
                  { data: { voucherIds: feed.data?.voucherIds ?? [], batch: new Date().toISOString() } },
                  {
                    onSuccess: () => {
                      void qc.invalidateQueries({ queryKey: ["/api/dms/ledger/tally", period] })
                      void qc.invalidateQueries({ queryKey: ["/api/dms/ledger/vouchers"] })
                    },
                  },
                )
              }
              disabled={!feed.data?.vouchers || handedOver.isPending}
              className="text-xs font-medium h-8 px-3 rounded-md border border-slate-200
                         bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Mark taken in
            </button>
          </div>
          <p className="text-[11px] text-slate-400 mt-2 leading-snug">
            {feed.data?.vouchers ?? 0} voucher
            {feed.data?.vouchers === 1 ? "" : "s"} not yet handed over. Marking is a
            separate step on purpose — a download that failed halfway must not make
            a month disappear from the next feed.
          </p>
        </div>
      </div>

      {/* ── The entries ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-bold text-slate-900 mb-2">Entries</h2>
        {vouchers.isLoading ? (
          <div className="py-12 flex items-center justify-center text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-slate-200 px-4 py-8 text-center">
            <p className="text-sm text-slate-500">Nothing posted yet.</p>
            <p className="text-xs text-slate-400 mt-1">
              An issued tax invoice or sale confirmation can be posted from the
              invoicing screen. A quotation cannot — nothing is owed on it.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {rows.map((v) => (
              <VoucherRow key={v.id} voucher={v} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
