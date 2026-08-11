import { useParams, Link } from "wouter"
import { useGetSaleDocument } from "@workspace/api-client-react"
import { ArrowLeft, Loader2, Printer } from "lucide-react"

/**
 * The document, on a page, printable.
 *
 * > *"Where is the issued invoice? There is no link to view it, and no option
 * > to print."*
 *
 * Fair, and it was the gap that made the rest of the feature academic. The
 * generator has issued documents since OBJ-25 and there was nowhere to look at
 * one — so a dealership could raise an invoice and could not hand it to the
 * customer it was raised for, which is the only thing an invoice is for.
 *
 * ## It is a document, not a screen with an export button
 *
 * So the page **is** the printed thing. No PDF library, no server-side render,
 * no second layout that can drift from the first: browser print, A4, and a
 * `@media print` block that removes the shell and nothing else. What somebody
 * checks on screen is byte for byte what comes out of the printer, and there is
 * one layout to be wrong rather than two.
 *
 * ## R-89 is the whole design of the header
 *
 * A `SALE_CONFIRMATION` carries the same figures as a tax invoice and **is not
 * one**, because on that dealership the other system holds the series. The
 * title says which, the disclaimer sits under it, and the disclaimer prints —
 * a document that looked like a tax invoice and was not would have somebody
 * claiming input credit against it. Same instinct as `SIM-` on a simulated
 * policy number.
 */

const KIND_TITLE: Record<string, string> = {
  TAX_INVOICE: "Tax Invoice",
  SALE_CONFIRMATION: "Sale Confirmation",
  PROFORMA: "Proforma Invoice",
  QUOTATION: "Quotation",
}

/** R-89 on the page, in the largest type the disclaimer will ever be set in. */
const KIND_DISCLAIMER: Record<string, string | null> = {
  TAX_INVOICE: null,
  SALE_CONFIRMATION:
    "This is not a tax invoice. The tax invoice for this sale is issued by the dealership's own system, and its number is shown above.",
  PROFORMA:
    "This is a proforma invoice, issued for payment. It is not a tax invoice and no input credit may be claimed against it.",
  QUOTATION: "This is a quotation. It is not a tax invoice and no tax is payable on it.",
}

const n = (v: string | number | null | undefined) => Number(v ?? 0)

const rupees = (v: string | number | null | undefined) =>
  `₹${n(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const onDate = (d: string | null | undefined) =>
  d
    ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })
    : "—"

/**
 * The amount in words, because an Indian invoice carries one.
 *
 * Not decoration and not a nicety — it is what a bank and an auditor read when
 * the figures are disputed, and it is the reason the lakh/crore grouping has to
 * be right rather than merely present. Written out rather than pulled from a
 * library so there is nothing to go wrong at install time on a dealer's laptop.
 */
const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen",
]
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

function underHundred(x: number): string {
  if (x < 20) return ONES[x]!
  const t = TENS[Math.floor(x / 10)]!
  const o = ONES[x % 10]!
  return o ? `${t} ${o}` : t
}

function words(x: number): string {
  if (x === 0) return "Zero"
  const parts: string[] = []
  // Crore, lakh, thousand, hundred — the Indian grouping, not the Western one.
  const crore = Math.floor(x / 10_000_000)
  if (crore) parts.push(`${words(crore)} Crore`)
  x %= 10_000_000
  const lakh = Math.floor(x / 100_000)
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`)
  x %= 100_000
  const thousand = Math.floor(x / 1_000)
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`)
  x %= 1_000
  const hundred = Math.floor(x / 100)
  if (hundred) parts.push(`${ONES[hundred]} Hundred`)
  x %= 100
  if (x) parts.push(underHundred(x))
  return parts.join(" ")
}

function rupeesInWords(total: number): string {
  const whole = Math.floor(total)
  const paise = Math.round((total - whole) * 100)
  const head = `Rupees ${words(whole)}`
  return paise > 0 ? `${head} and ${underHundred(paise)} Paise only` : `${head} only`
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1">
      <span className={strong ? "font-semibold text-slate-900" : "text-slate-600"}>{label}</span>
      <span className={`tabular-nums ${strong ? "font-semibold text-slate-900" : "text-slate-800"}`}>
        {value}
      </span>
    </div>
  )
}

export default function Invoice() {
  const params = useParams<{ id: string }>()
  const id = Number(params.id)
  const { data, isLoading, isError } = useGetSaleDocument(id, {
    query: { queryKey: ["/api/dms/invoice/documents", id], retry: false },
  })

  if (isLoading) {
    return (
      <p className="text-sm text-slate-400 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Fetching the document…
      </p>
    )
  }
  if (isError || !data) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-500">That document could not be read.</p>
        <Link href="/invoices" className="text-sm text-slate-700 underline underline-offset-2">
          Back to invoicing
        </Link>
      </div>
    )
  }

  const d = data.document
  const s = data.seller
  const cancelled = d.status === "CANCELLED"
  const charges = (d.otherCharges ?? []) as Array<{ label: string; amount: number }>
  const interState = n(d.igstAmount) > 0

  return (
    <div className="space-y-4">
      {/* Everything in this block is screen furniture and none of it prints. */}
      <div className="flex items-center gap-3 flex-wrap print:hidden">
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Invoicing
        </Link>
        <button
          onClick={() => window.print()}
          className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md
                     bg-slate-900 text-white hover:bg-slate-800"
        >
          <Printer className="w-3.5 h-3.5" />
          Print
        </button>
      </div>

      {/* A4 at 96dpi is 794px. Fixing the width on screen as well as in print
          means what somebody proofreads is what comes out — a page that reflows
          at the printer is a page nobody trusts twice. */}
      <div className="mx-auto bg-white border border-slate-200 print:border-0 rounded-lg print:rounded-none
                      w-full max-w-[794px] p-8 print:p-0 text-[13px] leading-relaxed text-slate-800">
        {cancelled && (
          <div className="border-2 border-red-500 text-red-700 font-bold uppercase tracking-widest
                          text-center py-2 mb-6">
            Cancelled
            {d.cancelledReason && (
              <div className="font-normal normal-case tracking-normal text-xs mt-0.5">
                {d.cancelledReason}
              </div>
            )}
          </div>
        )}

        <div className="flex items-start justify-between gap-8 border-b-2 border-slate-900 pb-4">
          <div>
            <p className="text-lg font-bold text-slate-900">{s.legalName ?? "—"}</p>
            {s.addressLine && <p>{s.addressLine}</p>}
            <p>
              {[s.city, s.state, s.pincode].filter(Boolean).join(", ")}
            </p>
            {s.gstin && (
              <p className="mt-1">
                <span className="text-slate-500">GSTIN</span>{" "}
                <span className="font-semibold tabular-nums">{s.gstin}</span>
              </p>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl font-bold uppercase tracking-wide text-slate-900">
              {KIND_TITLE[d.kind] ?? d.kind}
            </p>
            {d.taxInvoiceNo ? (
              <p className="mt-1 tabular-nums">
                <span className="text-slate-500">No.</span>{" "}
                <span className="font-semibold">{d.taxInvoiceNo}</span>
              </p>
            ) : d.dmsInvoiceNo ? (
              <p className="mt-1 tabular-nums">
                <span className="text-slate-500">Against invoice</span>{" "}
                <span className="font-semibold">{d.dmsInvoiceNo}</span>
              </p>
            ) : null}
            <p className="tabular-nums text-slate-500">Ref {d.reference}</p>
            <p className="tabular-nums">{onDate(d.documentDate)}</p>
          </div>
        </div>

        {/* R-89. It prints, and it prints before the figures. */}
        {KIND_DISCLAIMER[d.kind] && (
          <p className="mt-3 border border-slate-400 bg-slate-50 print:bg-white px-3 py-2 text-[12px] font-medium text-slate-900">
            {KIND_DISCLAIMER[d.kind]}
          </p>
        )}

        <div className="grid grid-cols-2 gap-8 mt-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Billed to
            </p>
            <p className="font-semibold text-slate-900">{d.customerName ?? "—"}</p>
            {d.customerAddress && <p className="whitespace-pre-line">{d.customerAddress}</p>}
            {d.customerMobile && <p className="tabular-nums">{d.customerMobile}</p>}
            {d.customerGstin && (
              <p className="mt-1">
                <span className="text-slate-500">GSTIN</span>{" "}
                <span className="font-semibold tabular-nums">{d.customerGstin}</span>
              </p>
            )}
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Place of supply
            </p>
            <p>{d.placeOfSupply ?? "—"}</p>
            <p className="text-slate-500 text-[12px] mt-0.5">
              {interState ? "Inter-state — IGST" : "Intra-state — CGST and SGST"}
            </p>
          </div>
        </div>

        <table className="w-full mt-6 border-collapse">
          <thead>
            <tr className="border-y border-slate-300 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="text-left py-2 font-bold">Description</th>
              <th className="text-left py-2 font-bold w-24">HSN</th>
              <th className="text-right py-2 font-bold w-32">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-200 align-top">
              <td className="py-2.5">
                <p className="font-semibold text-slate-900">{d.modelDescription ?? "—"}</p>
                <p className="text-[12px] text-slate-600 tabular-nums">
                  {d.chassisNo && <>Chassis {d.chassisNo}</>}
                  {d.chassisNo && d.engineNo && " · "}
                  {d.engineNo && <>Engine {d.engineNo}</>}
                </p>
              </td>
              <td className="py-2.5 tabular-nums">{d.hsn ?? "—"}</td>
              <td className="py-2.5 text-right tabular-nums">{rupees(d.exShowroomAmount)}</td>
            </tr>
          </tbody>
        </table>

        <div className="flex justify-end mt-4">
          <div className="w-full max-w-sm text-[13px]">
            <Line label="Ex-showroom" value={rupees(d.exShowroomAmount)} />

            {/* R-88 on the printed page. The customer sees what he was given;
                the scheme the dealer retained is not his business and is not
                on his invoice. It is on the claims screen, which is ours. */}
            {n(d.dealerDiscount) > 0 && (
              <Line label="Discount" value={`− ${rupees(d.dealerDiscount)}`} />
            )}
            {n(d.oemSchemePassedOn) > 0 && (
              <Line label="Manufacturer's scheme" value={`− ${rupees(d.oemSchemePassedOn)}`} />
            )}

            <div className="border-t border-slate-300 mt-1 pt-1">
              <Line label="Taxable value" value={rupees(d.taxableAmount)} />
            </div>

            {interState ? (
              <Line label={`IGST @ ${n(d.gstRatePct)}%`} value={rupees(d.igstAmount)} />
            ) : (
              <>
                <Line label={`CGST @ ${n(d.gstRatePct) / 2}%`} value={rupees(d.cgstAmount)} />
                <Line label={`SGST @ ${n(d.gstRatePct) / 2}%`} value={rupees(d.sgstAmount)} />
              </>
            )}
            {n(d.cessAmount) > 0 && (
              <Line label={`Compensation cess @ ${n(d.cessRatePct)}%`} value={rupees(d.cessAmount)} />
            )}

            {/* R-103: collected on somebody else's behalf, so they sit outside
                the taxable value and no GST is charged on them. Grouped below
                the tax lines so the page reads the way the money moves. */}
            {charges.length > 0 && (
              <div className="border-t border-slate-200 mt-1 pt-1">
                {charges.map((c, i) => (
                  <Line key={i} label={c.label} value={rupees(c.amount)} />
                ))}
              </div>
            )}

            <div className="border-t-2 border-slate-900 mt-1 pt-1.5">
              <Line label="Total" value={rupees(d.totalAmount)} strong />
            </div>
          </div>
        </div>

        <p className="mt-4 text-[12px]">
          <span className="text-slate-500">Amount in words: </span>
          <span className="font-semibold text-slate-900">{rupeesInWords(n(d.totalAmount))}</span>
        </p>

        {/* Which list priced it (R-87), on the document rather than in a log.
            A dealer selling at an older rate is lawful and it is his decision —
            printing it is the product refusing to hide that from the customer
            the decision was made for. */}
        <div className="mt-6 pt-3 border-t border-slate-200 flex items-end justify-between gap-8">
          <div className="text-[11px] text-slate-500 space-y-0.5">
            {d.priceOrigin === "STATED" ? (
              <p>Priced as entered on this document.</p>
            ) : d.priceListName ? (
              <p>
                Priced per {d.priceListName}
                {d.priceListEffectiveFrom && <>, effective {onDate(d.priceListEffectiveFrom)}</>}
                {d.pricedOffCurrentList === "N" && (
                  <span className="text-amber-700"> — not the current list</span>
                )}
                .
              </p>
            ) : null}
            {d.issuedByName && <p>Issued by {d.issuedByName}.</p>}
          </div>
          <div className="text-center shrink-0">
            <div className="h-12" />
            <p className="border-t border-slate-400 pt-1 px-8 text-[11px] text-slate-600">
              For {s.legalName ?? "the dealership"}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
