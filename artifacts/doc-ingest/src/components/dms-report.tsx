import { useState } from "react"
import {
  useDropIngestReport,
  useConfirmIngestMapping,
  useListIngestBatches,
  type ReportDropResult,
  type MappedColumn,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react"

/**
 * A dealer drops the spreadsheet their own system exports, and somebody says
 * what the columns mean — once.
 *
 * VeloDocs was built for insurance: an unstructured source, a model reading it,
 * and a human gate before anything is trusted. **This is the same pipeline with
 * its second consumer**, and it is the one that decides how many dealers the
 * product can be sold to at all. A sub-dealer in Tripura doing five units a
 * month has no API, will never be given one, and has this screen instead.
 *
 * ## What the confirmation is actually for
 *
 * Not accuracy theatre. A model reads **headings only** — it is never shown a
 * cell, so it cannot invent a value — and the worst it can do is misname a
 * column. That is exactly the mistake a person can see at a glance and a machine
 * cannot, which is why the gate is here rather than on the rows.
 *
 * Confirm once and it is fixed: every file of that shape afterwards is read by
 * column position with no model anywhere near it.
 */

const NAMES: Record<string, string> = {
  dealId: "Deal number",
  status: "Status",
  bookingDate: "Booking date",
  plannedDeliveryDate: "Promised delivery",
  actualDeliveryDate: "Actual delivery",
  customerName: "Customer",
  customerMobile: "Mobile",
  modelDescription: "Model",
  chassisNo: "Chassis",
  engineNo: "Engine",
  exShowroomAmount: "Ex-showroom price",
  dmsPolicyNo: "Policy number",
  dmsInsurerCode: "Insurer",
  dmsRegNo: "Registration number",
  invoiceNo: "Invoice number",
  invoiceDate: "Invoice date",
}

/** A model's guess and a name match are different kinds of fact. Say which. */
function Confidence({ value }: { value: number }) {
  const strong = value >= 0.9
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider rounded px-1.5 py-0.5 border ${
        strong
          ? "text-emerald-700 bg-emerald-50 border-emerald-200"
          : "text-amber-800 bg-amber-50 border-amber-200"
      }`}
    >
      {strong ? "matched" : "read by a model"}
    </span>
  )
}

export function DmsReport() {
  const [showroomId, setShowroomId] = useState("1")
  const [filename, setFilename] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [result, setResult] = useState<ReportDropResult | null>(null)
  const [edited, setEdited] = useState<Record<string, MappedColumn>>({})
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const drop = useDropIngestReport()
  const confirm = useConfirmIngestMapping()
  const batches = useListIngestBatches(
    { showroomId: Number(showroomId) || 1 },
    { query: { queryKey: ["/api/dms/ingest/batches", showroomId] } },
  )

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setFilename(file.name)
    setText(await file.text())
    setResult(null)
    setError(null)
    setNote(null)
  }

  const send = () => {
    setError(null)
    setNote(null)
    drop.mutate(
      {
        data: {
          showroomId: Number(showroomId),
          dataType: "DEAL",
          filename,
          text,
        },
      },
      {
        onSuccess: (r) => {
          setResult(r)
          setEdited(r.mapping as Record<string, MappedColumn>)
          void batches.refetch()
        },
        onError: (e) => {
          const b = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(b?.error ?? "That file could not be taken in.")
        },
      },
    )
  }

  const accept = () => {
    if (!result) return
    confirm.mutate(
      { id: result.mappingId, data: { mapping: edited, text } },
      {
        onSuccess: (r) => {
          const rows = r.released.reduce((n, b) => n + b.rowsAccepted, 0)
          setNote(
            r.released.length > 0
              ? `Confirmed, and the file you dropped came in — ${rows} rows. Every export of this shape from now on is read straight through.`
              : "Confirmed. Every export of this shape from now on is read straight through.",
          )
          setResult({ ...result, mappingStatus: "CONFIRMED" })
          void batches.refetch()
        },
        onError: (e) => {
          const b = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(b?.error ?? "That could not be confirmed.")
        },
      },
    )
  }

  const held = result?.status === "PENDING_MAPPING"

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="w-4 h-4" />
            A report from the dealer's own system
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Most dealers have no API and will never be given one. Export the deal
            register from your DMS and drop it here — comma or tab separated. We
            will ask what the columns mean the first time and never again.
          </p>

          <div className="flex items-end gap-3 flex-wrap">
            <div className="w-32">
              <Label htmlFor="showroom">Outlet</Label>
              <Input
                id="showroom"
                value={showroomId}
                onChange={(e) => setShowroomId(e.target.value)}
              />
            </div>
            <div className="flex-1 min-w-64">
              <Label htmlFor="file">The exported file</Label>
              <Input
                id="file"
                type="file"
                accept=".csv,.tsv,.txt"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </div>
            <Button onClick={send} disabled={!text || drop.isPending}>
              {drop.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              Take it in
            </Button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {note && (
            <p className="text-sm text-emerald-700 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              {note}
            </p>
          )}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {held ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  We have not seen this shape of file before
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Read straight through — {result.rowsAccepted} of {result.rowsSeen} rows
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* The claim this whole objective rests on, stated on the screen so
                the person onboarding a dealer can see it is true. */}
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5" />
              {result.usedModel
                ? "A model read the headings it did not recognise. It was shown no values — only the column names."
                : result.wasKnown
                  ? "No model was called: this shape was confirmed before, so it was read by column position."
                  : "No model was needed — every heading matched by name."}
            </p>

            {held && (
              <p className="text-sm">
                Nothing has been imported yet. Check the columns below and confirm
                them once; the file you just dropped will come straight in.
              </p>
            )}

            {result.gaps.length > 0 && (
              <p className="text-sm text-destructive">
                Still unplaced and needed:{" "}
                {result.gaps.map((g) => NAMES[g] ?? g).join(", ")}.
              </p>
            )}

            <div className="border rounded-md divide-y">
              {Object.entries(NAMES).map(([field, label]) => {
                const m = edited[field]
                return (
                  <div key={field} className="flex items-center gap-3 px-3 py-2">
                    <span className="text-sm w-44 shrink-0">{label}</span>
                    <select
                      className="h-8 flex-1 rounded-md border bg-background px-2 text-sm"
                      value={m?.column ?? ""}
                      onChange={(e) => {
                        const column = e.target.value
                        setEdited((prev) => {
                          const next = { ...prev }
                          if (!column) delete next[field]
                          // A person's choice is certain in a way a proposal is
                          // not — they are looking at the file.
                          else next[field] = { column, confidence: 1 }
                          return next
                        })
                      }}
                    >
                      <option value="">— not in this file —</option>
                      {result.headings.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {m && <Confidence value={m.confidence} />}
                  </div>
                )
              })}
            </div>

            {result.rejections.length > 0 && (
              <div className="text-sm text-muted-foreground">
                <p className="font-medium">
                  {result.rowsRejected} row{result.rowsRejected === 1 ? "" : "s"} not taken in:
                </p>
                <ul className="list-disc pl-5">
                  {result.rejections.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {result.mappingStatus !== "CONFIRMED" && (
              <Button onClick={accept} disabled={confirm.isPending}>
                {confirm.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                That is right — confirm it
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What has been taken in</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Where a figure came from, which the API path never had to answer.
              A drop happened at a moment, and every row it produced inherits it. */}
          {(batches.data?.batches ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <div className="text-sm divide-y">
              {(batches.data?.batches ?? []).map((b) => (
                <div key={b.id} className="py-2 flex items-center gap-3 flex-wrap">
                  <span className="text-[10px] font-semibold uppercase tracking-wider rounded border px-1.5 py-0.5">
                    {b.path}
                  </span>
                  <span className="font-medium">{b.filename ?? "—"}</span>
                  <span className="text-muted-foreground">
                    {b.rowsAccepted} of {b.rowsSeen} rows
                  </span>
                  {b.status === "PENDING_MAPPING" && (
                    <span className="text-amber-700">held, waiting on a mapping</span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {b.uploadedByName} ·{" "}
                    {new Date(b.createdAt).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
