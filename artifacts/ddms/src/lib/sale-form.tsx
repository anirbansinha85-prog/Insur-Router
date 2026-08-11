import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGenerateSaleDocument,
  useListPriceLists,
  type SaleDocument,
} from "@workspace/api-client-react"
import { CheckCircle2, ChevronDown, ChevronRight, Info, Loader2, PenLine } from "lucide-react"

/**
 * An invoice for a sale nothing upstream knows about (OBJ-30, R-96).
 *
 * The rest of this screen invoices deals that arrived from a manufacturer's
 * system. This is the same generator with nothing behind it: the dealership
 * with five units a month, no DMS, no mirror and no deal row, whose invoices
 * are currently being typed into Tally or written in a book.
 *
 * It is deliberately *below* the readiness lists rather than beside them. A
 * dealership with a mirror should almost never be here — a sale typed in by
 * hand when the deal exists upstream is a second version of that sale, and two
 * versions of one sale is the failure this product exists to fix. For the
 * dealership with no mirror at all it is the only door, and it is the same
 * door: the price list, the discount split, the tax series and the *sold this
 * twice* check are the ones the deal path uses, because there is only one
 * `generateDocument`.
 *
 * ## Why the price is optional and the chassis is not
 *
 * A price list is a thing a dealership builds over its first week; a chassis
 * number is on the bike in front of the customer. So the price falls back to a
 * list where there is one and is typed where there is not — and the chassis is
 * required, because it is what makes the sale identifiable and it is what stops
 * the same frame being invoiced twice.
 */

const rupees = (n: number | string) =>
  `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

const FIELD =
  "mt-0.5 w-full h-8 rounded-md border border-slate-300 px-2 text-xs focus:outline-none " +
  "focus:ring-2 focus:ring-slate-300"

function Field({
  label,
  value,
  onChange,
  hint,
  placeholder,
  required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
  placeholder?: string
  required?: boolean
}) {
  return (
    <label className="block text-[11px] font-medium text-slate-600">
      {label}
      {required && <span className="text-red-500"> *</span>}
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={FIELD}
      />
      {hint && <span className="block text-[10px] font-normal text-slate-400 mt-0.5">{hint}</span>}
    </label>
  )
}

export function SaleForm({
  showroomId,
  onIssued,
}: {
  showroomId: number
  onIssued?: (d: SaleDocument) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  const [customerName, setCustomerName] = useState("")
  const [customerMobile, setCustomerMobile] = useState("")
  const [customerAddress, setCustomerAddress] = useState("")
  const [customerGstin, setCustomerGstin] = useState("")
  const [modelDescription, setModelDescription] = useState("")
  const [chassisNo, setChassisNo] = useState("")
  const [engineNo, setEngineNo] = useState("")
  const [placeOfSupply, setPlaceOfSupply] = useState("")

  const [price, setPrice] = useState("")
  const [hsn, setHsn] = useState("8711")
  const [gst, setGst] = useState("28")
  const [cess, setCess] = useState("0")

  const [dealerDiscount, setDealerDiscount] = useState("0")
  const [insurance, setInsurance] = useState("")
  const [registration, setRegistration] = useState("")

  const [issued, setIssued] = useState<SaleDocument | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const generate = useGenerateSaleDocument()
  const lists = useListPriceLists(
    { showroomId },
    { query: { queryKey: ["/api/dms/invoice/price-lists", showroomId] } },
  )
  const hasLists = (lists.data?.lists?.length ?? 0) > 0

  const reset = () => {
    setCustomerName("")
    setCustomerMobile("")
    setCustomerAddress("")
    setCustomerGstin("")
    setModelDescription("")
    setChassisNo("")
    setEngineNo("")
    setPrice("")
    setDealerDiscount("0")
    setInsurance("")
    setRegistration("")
    setIssued(null)
    setWarnings([])
    setError(null)
  }

  const issue = () => {
    setError(null)

    /*
     * Everything the customer is charged that is not the vehicle.
     *
     * Insurance and road tax are money collected on somebody else's behalf
     * (R-103) — they belong on the invoice, and they are not part of the
     * taxable value of the bike. The generator already treats `otherCharges`
     * that way; naming the two ordinary ones here means nobody has to know
     * that to get it right.
     */
    const otherCharges = [
      { label: "Insurance", amount: Number(insurance) || 0 },
      { label: "Registration and road tax", amount: Number(registration) || 0 },
    ].filter((c) => c.amount > 0)

    const stated = Number(price)

    generate.mutate(
      {
        data: {
          showroomId,
          intent: "SALE",
          sale: {
            customerName: customerName.trim() || null,
            customerMobile: customerMobile.trim() || null,
            customerAddress: customerAddress.trim() || null,
            customerGstin: customerGstin.trim() || null,
            modelDescription: modelDescription.trim(),
            chassisNo: chassisNo.trim(),
            engineNo: engineNo.trim() || null,
          },
          ...(stated > 0
            ? {
                statedPrice: {
                  exShowroomAmount: stated,
                  hsn: hsn.trim() || null,
                  gstRatePct: Number(gst) || 0,
                  cessRatePct: Number(cess) || 0,
                },
              }
            : {}),
          dealerDiscount: Number(dealerDiscount) || 0,
          ...(otherCharges.length ? { otherCharges } : {}),
          ...(placeOfSupply.trim() ? { placeOfSupply: placeOfSupply.trim() } : {}),
        },
      },
      {
        onSuccess: (r) => {
          setIssued(r.document)
          setWarnings(r.warnings)
          onIssued?.(r.document)
          void qc.invalidateQueries({ queryKey: ["/api/dms/invoice/documents", showroomId] })
        },
        onError: (e) => {
          const b = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(b?.error ?? "That could not be issued.")
        },
      },
    )
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-slate-50 rounded-lg
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-400" />
        )}
        <PenLine className="w-4 h-4 text-slate-400" />
        <span className="text-sm font-semibold text-slate-800">Invoice a sale that is not in the list</span>
        <span className="text-xs text-slate-500">
          for a sale nothing upstream knows about
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 border-t border-slate-100 space-y-4">
          {issued ? (
            <div className="border border-emerald-200 bg-emerald-50/60 rounded-md px-4 py-3 space-y-1">
              <p className="text-sm font-semibold text-emerald-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                {issued.reference} issued — {rupees(issued.totalAmount)}
              </p>
              {/* R-89 again, and it matters more here: this dealership has no
                  other system issuing a tax invoice, so if this document is a
                  sale confirmation the sale has no tax invoice at all. */}
              <p className="text-xs text-emerald-800">
                {issued.kind === "TAX_INVOICE"
                  ? `Tax invoice ${issued.taxInvoiceNo}.`
                  : "Sale confirmation — not a tax invoice."}
              </p>
              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-800 flex items-start gap-1.5">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  {w}
                </p>
              ))}
              <button
                onClick={reset}
                className="mt-1 text-xs font-semibold text-emerald-800 underline underline-offset-2"
              >
                Invoice another
              </button>
            </div>
          ) : (
            <>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                  The customer
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Field label="Name" value={customerName} onChange={setCustomerName} />
                  <Field label="Mobile" value={customerMobile} onChange={setCustomerMobile} />
                  <Field label="Address" value={customerAddress} onChange={setCustomerAddress} />
                  <Field
                    label="GST number"
                    value={customerGstin}
                    onChange={setCustomerGstin}
                    hint="Only if the buyer is a business — it changes how the sale is reported."
                  />
                </div>
              </div>

              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                  The vehicle
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Field
                    label="Model"
                    required
                    value={modelDescription}
                    onChange={setModelDescription}
                    placeholder="TVS Jupiter 110"
                  />
                  <Field
                    label="Chassis number"
                    required
                    value={chassisNo}
                    onChange={setChassisNo}
                    hint="Identifies the sale. Stops the same bike being invoiced twice."
                  />
                  <Field label="Engine number" value={engineNo} onChange={setEngineNo} />
                </div>
              </div>

              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                  The price
                </p>
                {/* The honest sentence about which half of the product they are
                    using. A dealership with lists should leave this blank; one
                    without has nowhere else to put the number. */}
                <p className="text-[11px] text-slate-500 mb-1.5">
                  {hasLists
                    ? "Leave the price blank to use the current list. Type one to override it for this document — the invoice will say you did."
                    : "No price list covers this outlet yet, so enter the price here. Building a list later means never typing it again."}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Field
                    label="Ex-showroom"
                    value={price}
                    onChange={setPrice}
                    placeholder={hasLists ? "from the list" : "79500"}
                  />
                  <Field label="HSN" value={hsn} onChange={setHsn} />
                  <Field label="GST %" value={gst} onChange={setGst} />
                  <Field
                    label="Cess %"
                    value={cess}
                    onChange={setCess}
                    hint="3% above 350cc."
                  />
                </div>
              </div>

              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                  What else the customer pays
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <Field label="Your discount" value={dealerDiscount} onChange={setDealerDiscount} />
                  <Field label="Insurance" value={insurance} onChange={setInsurance} />
                  <Field
                    label="Registration and road tax"
                    value={registration}
                    onChange={setRegistration}
                  />
                  <Field
                    label="Delivered in"
                    value={placeOfSupply}
                    onChange={setPlaceOfSupply}
                    placeholder="this outlet's state"
                    hint="Only if it is another state."
                  />
                </div>
                {/* Not a tax point and not the dealership's income (R-103).
                    Said on the screen where the number is entered, because
                    that is where somebody would otherwise assume otherwise. */}
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Insurance and road tax are collected on somebody else's behalf. They go on the
                  invoice and no GST is charged on them.
                </p>
              </div>

              {error && (
                <p className="text-xs text-red-600 border border-red-200 bg-red-50 rounded-md px-3 py-2">
                  {error}
                </p>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={issue}
                  disabled={generate.isPending || !modelDescription.trim() || !chassisNo.trim()}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold h-9 px-4 rounded-md
                             bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
                >
                  {generate.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                  Issue the invoice
                </button>
                <span className="text-[11px] text-slate-400">
                  Same price lists, same tax split, same series as every other invoice here.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
