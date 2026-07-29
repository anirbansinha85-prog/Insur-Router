import { useState } from "react"
import type { DocumentExtraction, DocumentFieldGroup } from "@workspace/api-client-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileText, ChevronDown, ChevronRight, Download, AlertTriangle } from "lucide-react"

/** Human labels for the document types stage 1 can identify. */
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  RC_BOOK: "Registration Certificate (RC Book)",
  DEALER_INVOICE: "Dealer / Tax Invoice",
  AADHAAR: "Aadhaar Card",
  PAN: "PAN Card",
  DRIVING_LICENCE: "Driving Licence",
  INSURANCE_POLICY: "Insurance Policy",
  OTHER: "Unrecognised document",
}

const GROUP_LABELS: Record<DocumentFieldGroup | string, string> = {
  vehicle: "Vehicle",
  owner: "Owner / KYC",
  rto: "Registering authority",
  policy: "Policy",
  other: "Other",
}

/**
 * Stage 1 output — what the model decided the document IS, and everything it
 * read off it under the document's own labels. Shown before the MSA mapping so
 * a reviewer can see the source rather than only the interpretation.
 */
export function DocumentPanel({
  document: doc,
  mappingMethod,
}: {
  document: DocumentExtraction
  mappingMethod?: string | null
}) {
  const [open, setOpen] = useState(true)
  const [showRaw, setShowRaw] = useState(false)

  const typeLabel = DOCUMENT_TYPE_LABELS[doc.documentType] ?? doc.documentType
  const typeUncertain = doc.documentTypeConfidence < 0.7
  const unrecognised = doc.documentType === "OTHER"

  const groups = doc.fields.reduce<Record<string, typeof doc.fields>>((acc, f) => {
    ;(acc[f.group] ??= []).push(f)
    return acc
  }, {})

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement("a")
    a.href = url
    a.download = `document-${doc.documentType.toLowerCase()}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-primary" />
              {typeLabel}
              <Badge
                variant={typeUncertain ? "secondary" : "outline"}
                className="text-[10px] font-mono"
              >
                {(doc.documentTypeConfidence * 100).toFixed(0)}%
              </Badge>
            </CardTitle>
            <CardDescription className="mt-1">
              {doc.summary}
              {doc.issuer && (
                <>
                  {" — "}
                  <span className="font-medium">{doc.issuer}</span>
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex flex-shrink-0 gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={downloadJson}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              JSON
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Collapse document" : "Expand document"}
            >
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {(typeUncertain || unrecognised) && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-amber/40 bg-amber/5 p-2.5 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber" />
            <span>
              {unrecognised
                ? "The document type was not recognised, so fields were read without assuming a layout. Check the mapping below carefully."
                : "Low confidence in the document type — the mapping below may have used the wrong assumptions."}
            </span>
          </div>
        )}
      </CardHeader>

      {open && (
        <CardContent className="space-y-4 pt-0">
          <p className="text-xs text-muted-foreground">
            {doc.fields.length} field{doc.fields.length === 1 ? "" : "s"} read from the
            document, using its own labels.
            {mappingMethod === "rules" && " Mapped to MSA by rules (model mapping unavailable)."}
          </p>

          {Object.entries(groups).map(([group, fields]) => (
            <div key={group}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {GROUP_LABELS[group] ?? group}
              </p>
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <tbody>
                    {fields.map((f, i) => (
                      <tr key={`${f.label}-${i}`} className="border-b last:border-0">
                        <td className="w-2/5 bg-muted/30 px-3 py-1.5 align-top text-xs text-muted-foreground">
                          {f.label}
                        </td>
                        <td className="px-3 py-1.5 align-top font-medium">{f.value}</td>
                        <td className="w-14 px-2 py-1.5 text-right align-top">
                          <span
                            className={`font-mono text-[10px] ${
                              f.confidence < 0.7 ? "text-amber-foreground" : "text-muted-foreground"
                            }`}
                          >
                            {(f.confidence * 100).toFixed(0)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {doc.rawText && (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? <ChevronDown className="mr-1 h-3 w-3" /> : <ChevronRight className="mr-1 h-3 w-3" />}
                Raw text
              </Button>
              {showRaw && (
                <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
                  {doc.rawText}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
