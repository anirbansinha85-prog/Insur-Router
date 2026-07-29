import { useState } from "react"
import { MsaFields, IngestResult, MsaFieldsOwnerIdProofType, useIngestPush } from "@workspace/api-client-react"
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CheckCircle2, Download, Send, AlertTriangle, XCircle } from "lucide-react"
import { DocumentPanel } from "@/components/document-panel"

interface ReviewCorrectProps {
  result: IngestResult & { previewUrl?: string; sourceName?: string }
  onReset: () => void
}

interface ServerValidationError {
  errors: string[]
  invalidFields: string[]
}

export function ReviewCorrect({ result, onReset }: ReviewCorrectProps) {
  const [formData, setFormData] = useState<MsaFields>(result.fields)
  const [successAppId, setSuccessAppId] = useState<number | null>(null)
  const [serverErrors, setServerErrors] = useState<ServerValidationError | null>(null)
  
  const { mutate: pushToRouter, isPending: isPushing } = useIngestPush()

  // Export the whole picture, not just the MSA form: the document as read, the
  // mapped fields, and which document label fed each one.
  const handleExport = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      source: result.sourceName ?? null,
      engineUsed: result.engineUsed ?? null,
      mappingMethod: result.mappingMethod ?? null,
      document: result.document ?? null,
      msaFields: formData,
      provenance: result.provenance ?? null,
      confidence: result.confidence,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `velodocs-export-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handlePush = () => {
    setServerErrors(null)
    pushToRouter(
      // The document extraction travels with the payload so InsurRouter keeps
      // an audit trail of what the OCR actually read.
      { data: { fields: formData, document: result.document ?? null } },
      {
        onSuccess: (res) => {
          setSuccessAppId(res.applicationId)
        },
        onError: (err) => {
          // ApiError carries the parsed JSON body in .data
          const data = (err as { data?: unknown }).data
          if (
            data &&
            typeof data === 'object' &&
            'errors' in data &&
            Array.isArray((data as ServerValidationError).errors)
          ) {
            setServerErrors(data as ServerValidationError)
          }
        }
      }
    )
  }

  const handleChange = (field: keyof MsaFields, value: string | number) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // Clear server error for this field once the user edits it
    const fieldStr = field as string
    if (serverErrors?.invalidFields.includes(fieldStr)) {
      setServerErrors((prev: ServerValidationError | null) =>
        prev
          ? {
              errors: prev.errors,
              invalidFields: prev.invalidFields.filter(f => f !== fieldStr),
            }
          : null
      )
    }
  }

  const serverInvalidFields = new Set(serverErrors?.invalidFields ?? [])

  // Helper to render an MSA field input
  const renderField = (key: keyof MsaFields, label: string, type: string = "text") => {
    const isLowConfidence = result.confidence[key] !== undefined && result.confidence[key] < 0.7
    const isServerInvalid = serverInvalidFields.has(key as string)
    const isHighlighted = isLowConfidence || isServerInvalid
    const provenance = result.provenance?.[key as string] ?? null
    
    return (
      <div
        key={key as string}
        className={`p-3 rounded-md border transition-colors ${
          isServerInvalid
            ? 'bg-destructive/5 border-destructive/50 shadow-sm'
            : isLowConfidence
            ? 'bg-amber/5 border-amber/40 shadow-sm'
            : 'border-transparent hover:bg-muted/30'
        }`}
      >
        <div className="flex justify-between items-center mb-1.5">
          <Label
            htmlFor={key as string}
            className={`text-xs font-medium flex items-center gap-1.5 ${
              isServerInvalid
                ? 'text-destructive font-semibold'
                : isLowConfidence
                ? 'text-amber-foreground font-semibold'
                : 'text-muted-foreground'
            }`}
          >
            {isServerInvalid && <XCircle className="h-3 w-3 text-destructive" />}
            {!isServerInvalid && isLowConfidence && <AlertTriangle className="h-3 w-3 text-amber" />}
            {label}
          </Label>
          {result.confidence[key] !== undefined && (
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
              isServerInvalid
                ? 'bg-destructive/10 text-destructive'
                : isLowConfidence
                ? 'bg-amber/10 text-amber-foreground'
                : 'bg-muted text-muted-foreground'
            }`}>
              {(result.confidence[key] * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <Input
          id={key as string}
          type={type}
          value={formData[key] || ""}
          onChange={(e) => handleChange(key, type === 'number' ? Number(e.target.value) : e.target.value)}
          className={`h-8 text-sm ${
            isServerInvalid
              ? 'border-destructive/70 focus-visible:ring-destructive'
              : isLowConfidence
              ? 'border-amber/50 focus-visible:ring-amber'
              : ''
          }`}
        />
        {/* Provenance: which label on the document produced this value. Lets a
            reviewer verify against the source instead of trusting the mapping. */}
        {provenance && (
          <p className="mt-1 truncate text-[10px] text-muted-foreground" title={provenance}>
            from <span className="font-medium">"{provenance}"</span>
          </p>
        )}
        {!provenance && result.document && (
          <p className="mt-1 text-[10px] italic text-muted-foreground">
            not found on the document
          </p>
        )}
      </div>
    )
  }

  if (successAppId) {
    const targetUrl = `${window.location.origin}/applications/${successAppId}`
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border border-primary/20 rounded-lg bg-primary/5 shadow-sm">
        <div className="h-16 w-16 rounded-full bg-primary/20 flex items-center justify-center mb-6">
          <CheckCircle2 className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-2xl font-display font-bold text-primary mb-2">Ingestion Complete</h2>
        <p className="text-muted-foreground mb-8 text-lg">
          Draft #{successAppId} created in InsurRouter
        </p>
        
        <div className="flex gap-4">
          <Button variant="outline" onClick={onReset} className="bg-white">
            Start New Ingestion
          </Button>
          <Button onClick={() => window.open(targetUrl, '_blank')} className="gap-2">
            Open ↗
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-display font-semibold">Review & Correct</h2>
          <Button variant="outline" size="sm" onClick={onReset}>Cancel</Button>
        </div>

        {/* Stage 1 first: what the document IS and what it literally says,
            before the MSA interpretation of it below. */}
        {result.document && (
          <DocumentPanel document={result.document} mappingMethod={result.mappingMethod} />
        )}

        {serverErrors && serverErrors.errors.length > 0 && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
            <div className="flex items-start gap-3">
              <XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-destructive mb-2">
                  Push rejected — {serverErrors.errors.length} field{serverErrors.errors.length !== 1 ? 's' : ''} must be corrected before sending to InsurRouter
                </p>
                <ul className="space-y-1">
                  {serverErrors.errors.map((err, i) => (
                    <li key={i} className="text-xs text-destructive/90 flex items-center gap-1.5">
                      <span className="inline-block h-1 w-1 rounded-full bg-destructive/60 shrink-0" />
                      {err}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
        
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Vehicle Details</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-2 gap-y-1">
            {renderField("vehicleMake", "Make")}
            {renderField("vehicleModel", "Model")}
            {renderField("vehicleVariant", "Variant")}
            {renderField("vehicleDateOfPurchase", "Date of Purchase", "date")}
            {renderField("vehicleEngineNumber", "Engine Number")}
            {renderField("vehicleChassisNumber", "Chassis Number")}
            {renderField("vehicleExShowroomPrice", "Ex-Showroom Price", "number")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Owner KYC</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-2 gap-y-1">
            {renderField("ownerFullName", "Full Name")}
            {renderField("ownerDateOfBirth", "Date of Birth", "date")}
            {renderField("ownerEmail", "Email", "email")}
            {renderField("ownerPhoneNumber", "Phone Number")}
            <div className="col-span-2">
              {renderField("ownerBillingAddress", "Billing Address")}
            </div>
            {renderField("ownerPincode", "Pincode", "number")}
            
            <div className="p-3 rounded-md border border-transparent">
              <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">ID Proof Type</Label>
              <Select 
                value={formData.ownerIdProofType} 
                onValueChange={(v) => handleChange("ownerIdProofType", v as MsaFieldsOwnerIdProofType)}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AADHAR">Aadhar</SelectItem>
                  <SelectItem value="PAN">PAN</SelectItem>
                  <SelectItem value="PASSPORT">Passport</SelectItem>
                  <SelectItem value="DRIVING_LICENSE">Driving License</SelectItem>
                  <SelectItem value="VOTER_ID">Voter ID</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {renderField("ownerIdProofNumber", "ID Proof Number")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">RTO Details</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-2 gap-y-1">
            {renderField("rtoCode", "RTO Code")}
            {renderField("rtoRegistrationCity", "Registration City")}
            {renderField("rtoRegistrationState", "Registration State")}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="sticky top-6">
          <CardHeader className="bg-muted/30 border-b">
            <CardTitle className="text-base font-display">Source Artifact</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {result.previewUrl ? (
              <div className="aspect-auto max-h-[400px] overflow-hidden bg-black/5 flex items-center justify-center">
                <img src={result.previewUrl} alt="Uploaded document" className="w-full h-auto object-contain" />
              </div>
            ) : result.rawText ? (
              <div className="p-4 max-h-[400px] overflow-y-auto">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words">
                  {result.rawText}
                </pre>
              </div>
            ) : (
              <div className="p-8 text-center bg-muted/10">
                <p className="text-sm font-medium text-foreground">DMS System Query</p>
                <div className="mt-4 px-4 py-2 bg-muted rounded font-mono text-xs inline-block">
                  Reg: {formData.rtoCode ? `${formData.rtoCode}...` : 'N/A'}
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex-col gap-3 p-4 border-t bg-muted/10">
            <Button onClick={handlePush} disabled={isPushing} className="w-full gap-2">
              {isPushing ? "Pushing..." : "Push to InsurRouter"}
              {!isPushing && <Send className="h-4 w-4" />}
            </Button>
            <Button onClick={handleExport} variant="outline" className="w-full gap-2 bg-white">
              Export JSON
              <Download className="h-4 w-4" />
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
