import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGenerateSaleDocument,
  useListPriceLists,
  type SaleDocument,
} from "@workspace/api-client-react"
import { CheckCircle2, FileText, Info, Loader2, ReceiptText } from "lucide-react"

/**
 * The button on an opportunity, with the figures already on it.
 *
 * > **Invoices are not late because typing is hard. They are late because
 * > nobody noticed the deal became ready.**
 *
 * So this is deliberately not a form somebody fills in. The price is already
 * chosen, the discount fields start at zero, and pressing *Issue it* with
 * nothing touched produces the correct document. Everything below the fold is
 * for the dealership that wants to do something other than the obvious — which
 * is the whole objective, and is still one screen away from the default rather
 * than in front of it.
 *
 * ## The three fields that are not defaults
 *
 * **Which list.** A dealer may price from an older one: a customer who booked
 * before the rise, ageing stock, a promise somebody made. Lawful, his decision,
 * and the document prints which list it used.
 *
 * **The discount, split by who pays for it.** The dealer's own margin is one
 * number and the manufacturer's scheme is another, and collapsing them loses
 * money — **the claim is owed on the full scheme whatever the customer was
 * told**, so a dealer who keeps it is still owed it.
 */

const rupees = (n: number | string) =>
  `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

export function InvoiceButton({
  dealerCode,
  dealId,
  showroomId,
  onIssued,
}: {
  dealerCode: string
  dealId: string
  showroomId: number
  onIssued?: (d: SaleDocument) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [listId, setListId] = useState<string>("")
  const [dealerDiscount, setDealerDiscount] = useState("0")
  const [scheme, setScheme] = useState("0")
  const [passedOn, setPassedOn] = useState("0")
  const [issued, setIssued] = useState<SaleDocument | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const generate = useGenerateSaleDocument()
  const lists = useListPriceLists(
    { showroomId },
    { query: { queryKey: ["/api/dms/invoice/price-lists", showroomId] } },
  )

  const issue = () => {
    setError(null)
    generate.mutate(
      {
        data: {
          showroomId,
          dealerCode,
          dealId,
          intent: "SALE",
          ...(listId ? { priceListId: Number(listId) } : {}),
          dealerDiscount: Number(dealerDiscount) || 0,
          oemSchemeAmount: Number(scheme) || 0,
          oemSchemePassedOn: Number(passedOn) || 0,
        },
      },
      {
        onSuccess: (r) => {
          setIssued(r.document)
          setWarnings(r.warnings)
          onIssued?.(r.document)
          // The deal has moved on, so the queue has too.
          void qc.invalidateQueries({ queryKey: ["/api/dms/queue"] })
        },
        onError: (e) => {
          const b = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(b?.error ?? "That could not be issued.")
        },
      },
    )
  }

  if (issued) {
    return (
      <div className="border border-emerald-200 bg-emerald-50/60 rounded-md px-4 py-3 space-y-1">
        <p className="text-sm font-semibold text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          {issued.reference} issued — {rupees(issued.totalAmount)}
        </p>
        {/* R-89: the document says what it is, and so does the screen. A sale
            confirmation that read like a tax invoice would have somebody
            claiming input credit against it. */}
        <p className="text-xs text-emerald-800">
          {issued.kind === "TAX_INVOICE"
            ? `Tax invoice ${issued.taxInvoiceNo}.`
            : "Sale confirmation — not a tax invoice. Your own system holds the tax series."}
        </p>
        {warnings.map((w, i) => (
          <p key={i} className="text-xs text-amber-800 flex items-start gap-1.5">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            {w}
          </p>
        ))}
      </div>
    )
  }

  return (
    <div className="border border-emerald-200 rounded-md bg-emerald-50/40">
      <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
        <ReceiptText className="w-4 h-4 text-emerald-700" />
        <span className="text-sm font-semibold text-emerald-900">
          This can be invoiced now
        </span>
        <button
          onClick={issue}
          disabled={generate.isPending}
          className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md
                     bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {generate.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
          Issue it
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-emerald-800 hover:text-emerald-950 underline underline-offset-2"
        >
          {open ? "Hide" : "Price it differently"}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-3 space-y-2 border-t border-emerald-200/70 pt-3">
          <label className="block text-[11px] font-medium text-slate-600">
            Price from
            <select
              value={listId}
              onChange={(e) => setListId(e.target.value)}
              className="mt-0.5 w-full h-8 rounded-md border border-slate-300 px-2 text-xs bg-white"
            >
              <option value="">The current list</option>
              {(lists.data?.lists ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} — effective {l.effectiveFrom}
                </option>
              ))}
            </select>
          </label>
          {/* Not hidden behind a warning: selling at an older rate is lawful and
              his decision, and the document will say which list it used. */}
          <p className="text-[11px] text-slate-500">
            An older list is perfectly proper — the document prints which one was used.
          </p>

          <div className="grid grid-cols-3 gap-2">
            <label className="block text-[11px] font-medium text-slate-600">
              Your discount
              <input
                value={dealerDiscount}
                onChange={(e) => setDealerDiscount(e.target.value)}
                inputMode="numeric"
                className="mt-0.5 w-full h-8 rounded-md border border-slate-300 px-2 text-xs"
              />
            </label>
            <label className="block text-[11px] font-medium text-slate-600">
              OEM scheme
              <input
                value={scheme}
                onChange={(e) => setScheme(e.target.value)}
                inputMode="numeric"
                className="mt-0.5 w-full h-8 rounded-md border border-slate-300 px-2 text-xs"
              />
            </label>
            <label className="block text-[11px] font-medium text-slate-600">
              Passed to customer
              <input
                value={passedOn}
                onChange={(e) => setPassedOn(e.target.value)}
                inputMode="numeric"
                className="mt-0.5 w-full h-8 rounded-md border border-slate-300 px-2 text-xs"
              />
            </label>
          </div>
          {/* The sentence that is the whole of R-88, on the screen where the
              decision is actually made. */}
          {Number(scheme) > Number(passedOn) && (
            <p className="text-[11px] text-slate-600">
              You are keeping {rupees(Number(scheme) - Number(passedOn))} of the scheme.
              You are still owed the full {rupees(scheme)} from the manufacturer, and it
              will show under what you can claim.
            </p>
          )}
        </div>
      )}

      {error && <p className="px-4 pb-3 text-[11px] text-red-600">{error}</p>}
    </div>
  )
}
