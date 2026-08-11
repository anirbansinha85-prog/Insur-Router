import { useState } from "react"
import {
  useDropIngestReport,
  useConfirmIngestMapping,
  useListIngestBatches,
  useListIngestSources,
  useListShowrooms,
  type ReportDropResult,
  type MappedColumn,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  History,
  Loader2,
  Paperclip,
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
 *
 * ## The words on it are the trade's, not ours
 *
 * This screen read *What the file is*, *Take it in* and *What has been taken
 * in* — plain enough, and not what anybody in a dealership calls these things.
 * A person onboarding a dealer is a dealership's own administrator or an
 * implementation consultant, and both of them already have words: **data type**,
 * **import**, **import history**, **column mapping**. Inventing friendlier ones
 * makes the product read as though it were built by people who have not done
 * the job.
 *
 * The rule, worth keeping: **where the trade has a word, use the trade's word.**
 * Write plainly everywhere it does not.
 */

/**
 * What each canonical field is called on the confirmation screen.
 *
 * One flat table across data types rather than one per type, and deliberately:
 * the names are unique enough not to collide, and a person confirming an
 * enquiry export should not have to care which module's dictionary a label came
 * from. A field with no entry falls back to its own name, which is ugly and
 * visible — the right failure for a vocabulary somebody forgot to label.
 */
const NAMES: Record<string, string> = {
  // Leads
  enqId: "Enquiry number",
  stage: "Stage",
  enqDt: "Enquiry date",
  source: "Source",
  grade: "Grade",
  custName: "Customer",
  mobileNo: "Mobile",
  modelCodeInterest: "Model interested",
  assignedEmpCode: "Salesman",
  firstContactAt: "First contact",
  lastContactDt: "Last contact",
  nextFollowUpDt: "Next follow-up",
  lostReasonDesc: "Lost reason",
  convertedDealId: "Converted deal",
  // Deals
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
      {strong ? "matched by name" : "interpreted"}
    </span>
  )
}

const TYPE_LABEL: Record<string, string> = {
  DEAL: "Deal register",
  ENQUIRY: "Enquiry register",
  JOB_CARD: "Job cards",
  REGISTRATION: "RTO files",
  PART: "Spare parts",
  RECEIVABLE: "Receivables",
  VEHICLE: "Vehicle stock",
}

export function DmsReport() {
  const [showroomId, setShowroomId] = useState("")
  const [dataType, setDataType] = useState("DEAL")
  const [filename, setFilename] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [result, setResult] = useState<ReportDropResult | null>(null)
  const [edited, setEdited] = useState<Record<string, MappedColumn>>({})
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const drop = useDropIngestReport()
  const confirm = useConfirmIngestMapping()
  /*
   * What this outlet may feed by report, asked rather than assumed.
   *
   * The screen used to send `dataType: "DEAL"` because deals were the only
   * module a report could reach. Hard-coding the *other* six here now would
   * offer a dealership six paths, five of which silently do nothing.
   */
  /*
   * The outlets this owner holds, rather than a box somebody types `1` into.
   *
   * A numeric input here was asking an administrator to know a database id, and
   * to find out by being wrong — an id they do not hold sends the file to
   * another branch of their own group, which is a silent import into the wrong
   * outlet rather than an error.
   */
  const showrooms = useListShowrooms({ query: { queryKey: ["/api/dms/showrooms"] } })
  const outlets = showrooms.data ?? []
  const outletId = showroomId || (outlets[0] ? String(outlets[0].id) : "")

  const sources = useListIngestSources(
    { showroomId: Number(outletId) || 1 },
    { query: { queryKey: ["/api/dms/ingest/sources", outletId], enabled: Boolean(outletId) } },
  )
  const reportable = sources.data?.reportable ?? ["DEAL"]

  const batches = useListIngestBatches(
    { showroomId: Number(outletId) || 1 },
    { query: { queryKey: ["/api/dms/ingest/batches", outletId], enabled: Boolean(outletId) } },
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
          showroomId: Number(outletId),
          dataType,
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
          setError(b?.error ?? "That file could not be imported.")
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
              ? `Mapping confirmed. ${rows} record${rows === 1 ? "" : "s"} imported. Files in this format will now import without review.`
              : "Mapping confirmed. Files in this format will now import without review.",
          )
          setResult({ ...result, mappingStatus: "CONFIRMED" })
          void batches.refetch()
        },
        onError: (e) => {
          const b = (e as { response?: { data?: { error?: string } } })?.response?.data
          setError(b?.error ?? "The mapping could not be confirmed.")
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
            Import from DMS export
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            For dealerships without a DMS integration. Export a register from your
            DMS as CSV or tab-delimited and upload it here. Column mapping is
            confirmed once per file format and reused for every import after
            that.
            {reportable.length < 7 && (
              <>
                {" "}
                Only the data types listed can be imported from a file; the rest
                continue to come from the API.
              </>
            )}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div>
              <Label htmlFor="showroom">Outlet</Label>
              <select
                id="showroom"
                value={outletId}
                onChange={(e) => {
                  setShowroomId(e.target.value)
                  // A mapping belongs to one outlet as well as one data type, so
                  // a result from the last outlet answers a different question.
                  setResult(null)
                  setNote(null)
                }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                {outlets.length === 0 && <option value="">Loading…</option>}
                {outlets.map((o: { id: number; name: string; isActive: boolean }) => (
                  <option key={o.id} value={String(o.id)}>
                    {o.name}
                    {o.isActive ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="dataType">Data type</Label>
              <select
                id="dataType"
                value={dataType}
                onChange={(e) => {
                  setDataType(e.target.value)
                  // A mapping belongs to one data type, so a result from the
                  // last one is about a different question entirely.
                  setResult(null)
                  setNote(null)
                }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                {reportable.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t] ?? t}
                  </option>
                ))}
              </select>
            </div>

            {/*
              The native file input is hidden behind a label rather than styled.
              `Choose file — no file chosen` is the browser's wording and the
              browser's grey, so it read as neither a control nor a field, and
              it sat at a different height from everything beside it. A label
              with `htmlFor` opens the same picker, keeps the keyboard and
              screen-reader behaviour, and lets the filename be shown where
              somebody is looking for it.
            */}
            <div className="lg:col-span-1">
              <Label htmlFor="file">Source file</Label>
              <input
                id="file"
                type="file"
                accept=".csv,.tsv,.txt"
                className="sr-only"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <label
                htmlFor="file"
                className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-input
                           bg-background px-3 text-sm hover:bg-accent focus-within:ring-2 focus-within:ring-ring"
              >
                <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                <span className={filename ? "truncate" : "truncate text-muted-foreground"}>
                  {filename ?? "Select a CSV or TSV file"}
                </span>
              </label>
            </div>

            <div>
              {/*
                One primary action on the card, and it is this one. The confirm
                button further down is the primary of *its* card; nothing else
                on the screen competes with either, which is what makes them
                tell apart at a glance.
              */}
              <Button onClick={send} disabled={!text || !outletId || drop.isPending} className="w-full">
                {drop.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                Upload
              </Button>
            </div>
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
                  New file format — mapping required
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Imported — {result.rowsAccepted} of {result.rowsSeen} records
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
                ? "Unrecognised column headings were interpreted by a model. It was given the headings only — never any values."
                : result.wasKnown
                  ? "No model was used. This format was confirmed previously and was read by column position."
                  : "No model was used. Every column heading matched a known field by name."}
            </p>

            {held && (
              <p className="text-sm">
                Nothing has been imported yet. Review the column mapping below and
                confirm it once; this file will then import automatically.
              </p>
            )}

            {result.gaps.length > 0 && (
              <p className="text-sm text-destructive">
                Required fields not yet mapped:{" "}
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
                      <option value="">Not present in this file</option>
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
                  {result.rowsRejected} row{result.rowsRejected === 1 ? "" : "s"} not imported:
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
                Confirm mapping
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="w-4 h-4" />
            Import history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Where a figure came from, which the API path never had to answer.
              A drop happened at a moment, and every row it produced inherits it. */}
          {(batches.data?.batches ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No files have been imported for this outlet.</p>
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
