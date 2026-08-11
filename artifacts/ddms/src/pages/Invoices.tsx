import { useState } from "react"
import {
  useListInvoiceReadiness,
  useListSaleDocuments,
  useListOemClaims,
  useListPriceLists,
} from "@workspace/api-client-react"
import { InvoiceButton } from "../lib/invoice"
import { FindBox, useFind } from "../lib/find"
import { AlertTriangle, FileText, IndianRupee, Loader2, ReceiptText, ScrollText } from "lucide-react"

/**
 * Invoicing, on a screen of its own.
 *
 * The generator shipped inside a queue row and nowhere else — which meant that
 * to reach it you scrolled past seventy problems first. That is right for the
 * *notification* (a deal became ready, and the queue is where the dealership
 * finds out) and wrong for the *task*: somebody sitting down to do the
 * invoicing needs a list, not a conveyor belt.
 *
 * So both. The queue still raises the opportunity as it arises; this is where
 * you come when raising invoices is the job you sat down to do.
 *
 * ## Three questions, in the order a dealership asks them
 *
 * *What can I raise now* — with the figures and a button.
 * *What is stopping the rest* — named, per deal, so it is a job somebody can do.
 * *What have we issued* — and what the manufacturer still owes us on it.
 */

const rupees = (n: number | string) =>
  `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`

const KIND_LABEL: Record<string, string> = {
  TAX_INVOICE: "Tax invoice",
  SALE_CONFIRMATION: "Sale confirmation",
  QUOTATION: "Quotation",
  PROFORMA: "Proforma",
}

export default function Invoices() {
  // One outlet at a time, like every other screen. The picker in the shell
  // decides which; this mirrors the convention rather than inventing one.
  const [showroomId] = useState(1)
  const [tab, setTab] = useState<"READY" | "BLOCKED" | "ISSUED">("READY")

  const readiness = useListInvoiceReadiness(
    { showroomId },
    { query: { queryKey: ["/api/dms/invoice/readiness", showroomId] } },
  )
  const documents = useListSaleDocuments(
    { showroomId },
    { query: { queryKey: ["/api/dms/invoice/documents", showroomId] } },
  )
  const claims = useListOemClaims({ query: { queryKey: ["/api/dms/invoice/claims"] } })
  const lists = useListPriceLists(
    { showroomId },
    { query: { queryKey: ["/api/dms/invoice/price-lists", showroomId] } },
  )

  const ready = readiness.data?.ready ?? []
  const blocked = readiness.data?.blocked ?? []
  const issued = documents.data?.documents ?? []

  // `useFind` takes the rows it filters, so the hook follows the tab. One
  // search box over whichever list is on screen, which is what somebody typing
  // a chassis number expects.
  const rows = tab === "READY" ? ready : tab === "BLOCKED" ? blocked : issued
  const find = useFind(rows as unknown as Array<Record<string, unknown>>)
  const shown = find.found

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <ReceiptText className="w-5 h-5 text-slate-400" />
          Invoicing
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          The manufacturer's system knows the chassis and the tax. It does not know
          what was agreed. This is where the two meet.
        </p>
      </div>

      {/* The three numbers an owner reads first. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="border border-emerald-200 bg-emerald-50/50 rounded-lg px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
            Ready to raise
          </div>
          <div className="text-2xl font-bold text-emerald-900 tabular-nums">{ready.length}</div>
        </div>
        <div className="border border-slate-200 rounded-lg px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Waiting on something
          </div>
          <div className="text-2xl font-bold text-slate-900 tabular-nums">{blocked.length}</div>
        </div>
        {/* The number that lives in two systems and is held by neither (R-88). */}
        <div className="border border-slate-200 rounded-lg px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1">
            <IndianRupee className="w-3 h-3" />
            Claimable from the manufacturer
          </div>
          <div className="text-2xl font-bold text-slate-900 tabular-nums">
            {rupees(claims.data?.totalClaimable ?? 0)}
          </div>
          {(claims.data?.totalRetained ?? 0) > 0 && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              including {rupees(claims.data!.totalRetained)} you did not pass on — still owed
            </div>
          )}
        </div>
      </div>

      {lists.data?.lists?.length ? (
        <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
          <ScrollText className="w-3 h-3" />
          Pricing from:
          {lists.data.lists.map((l, n) => (
            <span key={l.id} className={n === 0 ? "font-semibold text-slate-700" : ""}>
              {l.name} ({l.effectiveFrom}, {l.models} models){n === 0 ? " — current" : ""}
              {n < lists.data!.lists.length - 1 ? " ·" : ""}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        {(
          [
            ["READY", `Ready — ${ready.length}`],
            ["BLOCKED", `Waiting — ${blocked.length}`],
            ["ISSUED", `Issued — ${issued.length}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`text-xs font-medium h-8 px-3 rounded-md border ${
              tab === value
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="ml-auto">
          <FindBox
            query={find.query}
            setQuery={find.setQuery}
            found={shown.length}
            total={rows.length}
            placeholder="Find a customer, a deal, a chassis…"
          />
        </div>
      </div>

      {readiness.isLoading ? (
        <p className="text-sm text-slate-400 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Working out what can be raised…
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing here.</p>
      ) : (
        <div className="space-y-3">
          {tab === "READY" &&
            (shown as unknown as typeof ready).map((r) => (
              <div key={r.dealId} className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900">
                    {r.preview?.customerName ?? r.dealId}
                  </span>
                  <span className="text-sm text-slate-500">
                    {r.preview?.modelDescription} · {r.preview?.chassisNo}
                  </span>
                  <span className="ml-auto text-sm font-semibold text-slate-900 tabular-nums">
                    {r.preview?.exShowroomAmount ? rupees(r.preview.exShowroomAmount) : "—"}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">
                  {r.dealId} · priced per {r.preview?.priceListName}
                  {r.preview && !r.preview.pricedOffCurrentList && (
                    <span className="text-amber-700"> — not the current list</span>
                  )}
                </p>
                <InvoiceButton
                  dealerCode={r.dealerCode}
                  dealId={r.dealId}
                  showroomId={r.showroomId}
                  onIssued={() => {
                    void readiness.refetch()
                    void documents.refetch()
                    void claims.refetch()
                  }}
                />
              </div>
            ))}

          {/* Named blockers, because "not ready" is useless and "no price list
              covers the Xpulse" is a job somebody can do this morning. */}
          {tab === "BLOCKED" &&
            (shown as unknown as typeof blocked).map((r) => (
              <div key={r.dealId} className="border border-slate-200 rounded-lg bg-white px-4 py-3">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium text-slate-800">{r.dealId}</span>
                  {r.preview?.customerName && (
                    <span className="text-sm text-slate-500">{r.preview.customerName}</span>
                  )}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {r.conditions
                    .filter((c) => !c.met)
                    .map((c) => (
                      <li key={c.id} className="text-xs text-slate-600 flex items-start gap-1.5">
                        <AlertTriangle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                        {c.missing ?? c.what}
                      </li>
                    ))}
                </ul>
              </div>
            ))}

          {tab === "ISSUED" && (
            <div className="border border-slate-200 rounded-lg bg-white divide-y divide-slate-100">
              {(shown as unknown as typeof issued).map((d) => (
                <div key={d.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap text-sm">
                  <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="font-medium text-slate-800 w-36 shrink-0">{d.reference}</span>
                  {/* R-89 on the list as well as the document: if it is not a
                      tax invoice it must not read like one. */}
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 ${
                      d.kind === "TAX_INVOICE"
                        ? "text-slate-700 bg-slate-50 border-slate-200"
                        : "text-amber-800 bg-amber-50 border-amber-200"
                    }`}
                  >
                    {KIND_LABEL[d.kind] ?? d.kind}
                  </span>
                  {d.taxInvoiceNo && (
                    <span className="text-xs text-slate-500 tabular-nums">{d.taxInvoiceNo}</span>
                  )}
                  <span className="text-xs text-slate-500 truncate">{d.customerName}</span>
                  <span className="ml-auto text-sm font-semibold tabular-nums text-slate-900">
                    {rupees(d.totalAmount)}
                  </span>
                  {d.status === "CANCELLED" && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-red-700">
                      cancelled
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
