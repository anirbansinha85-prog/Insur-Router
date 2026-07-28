import { useState, useEffect, useRef } from "react"
import {
  useGetApplication,
  useValidateApplication,
  useExecuteApplication,
  useUpdateApplication,
  useGetApplicationLogs,
  useListProviders,
  getGetApplicationQueryKey,
  getGetApplicationLogsQueryKey,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/select"
import { useParams, Link } from "wouter"
import {
  ArrowLeft, Play, ShieldAlert, ShieldCheck, CheckCircle2, FileDown,
  Activity, AlertCircle, Info, Clock, Cpu, Server, Globe, Zap, MousePointerClick,
} from "lucide-react"
import { formatDate } from "@/lib/utils"

type ExecutionMode = "API" | "BROWSER" | "AUTO"

function getModeIcon(mode: string, size = "w-4 h-4") {
  if (mode === "API") return <Server className={size} />
  if (mode === "BROWSER") return <MousePointerClick className={size} />
  return <Cpu className={size} />
}

function getStatusColor(status: string) {
  if (status === "success") return "bg-green-100 text-green-600 border-green-200"
  if (status === "error") return "bg-red-100 text-red-600 border-red-200"
  if (status === "warning") return "bg-amber-100 text-amber-600 border-amber-200"
  return "bg-blue-100 text-blue-600 border-blue-200"
}

function getStatusIcon(status: string) {
  if (status === "success") return <CheckCircle2 className="w-4 h-4" />
  if (status === "error") return <AlertCircle className="w-4 h-4" />
  if (status === "warning") return <AlertCircle className="w-4 h-4" />
  return <Info className="w-4 h-4" />
}

// ── Execution Confirmation Dialog ──────────────────────────────────────────
interface ExecuteDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (mode: ExecutionMode) => void
  defaultMode: ExecutionMode
  providerName: string | null
  hasApiEndpoint: boolean
  isSubmitting: boolean
}

function ExecuteDialog({
  open, onClose, onConfirm, defaultMode, providerName, hasApiEndpoint, isSubmitting,
}: ExecuteDialogProps) {
  const [selected, setSelected] = useState<ExecutionMode>(defaultMode)

  useEffect(() => {
    if (open) setSelected(defaultMode)
  }, [open, defaultMode])

  const resolvedLabel =
    selected === "AUTO"
      ? hasApiEndpoint ? "API (auto-resolved)" : "Browser Automation (auto-resolved)"
      : selected === "API"
      ? "API (direct REST)"
      : "Browser Automation (Playwright)"

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-blue-600" />
            Confirm Execution
          </DialogTitle>
          <DialogDescription>
            Choose how to submit this application to{" "}
            <span className="font-semibold text-slate-700">{providerName ?? "the provider"}</span>.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={selected}
          onValueChange={(v) => setSelected(v as ExecutionMode)}
          className="space-y-3 my-2"
        >
          {/* API Mode */}
          <label
            htmlFor="mode-api"
            className={`flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
              selected === "API"
                ? "border-blue-500 bg-blue-50"
                : "border-slate-200 hover:border-slate-300 bg-white"
            }`}
          >
            <RadioGroupItem value="API" id="mode-api" className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Server className="w-4 h-4 text-blue-600" />
                <span className="font-semibold text-slate-900 text-sm">Direct API</span>
                {hasApiEndpoint && (
                  <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">
                    AVAILABLE
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Maps the MSA payload to the provider's JSON schema and fires a POST request directly to their REST endpoint. Fast and reliable.
              </p>
              {!hasApiEndpoint && (
                <p className="text-xs text-amber-600 mt-1 font-medium">No API endpoint configured for this provider.</p>
              )}
            </div>
          </label>

          {/* Browser Mode */}
          <label
            htmlFor="mode-browser"
            className={`flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
              selected === "BROWSER"
                ? "border-indigo-500 bg-indigo-50"
                : "border-slate-200 hover:border-slate-300 bg-white"
            }`}
          >
            <RadioGroupItem value="BROWSER" id="mode-browser" className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <MousePointerClick className="w-4 h-4 text-indigo-600" />
                <span className="font-semibold text-slate-900 text-sm">Browser Automation</span>
                <span className="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-medium">
                  PLAYWRIGHT
                </span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Launches a headless Chromium browser, navigates to the provider's dealer portal, and fills the form fields step-by-step — just like a human agent would. Useful when no API is available.
              </p>
            </div>
          </label>

          {/* AUTO Mode */}
          <label
            htmlFor="mode-auto"
            className={`flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
              selected === "AUTO"
                ? "border-slate-600 bg-slate-50"
                : "border-slate-200 hover:border-slate-300 bg-white"
            }`}
          >
            <RadioGroupItem value="AUTO" id="mode-auto" className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Cpu className="w-4 h-4 text-slate-600" />
                <span className="font-semibold text-slate-900 text-sm">Auto-Select</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                InsurRouter decides: uses API if an endpoint is configured, falls back to Browser Automation otherwise.
              </p>
            </div>
          </label>
        </RadioGroup>

        <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm text-slate-700 flex items-center gap-2">
          <Zap className="w-4 h-4 text-slate-500 shrink-0" />
          <span>Will execute via: <strong>{resolvedLabel}</strong></span>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(selected)}
            disabled={isSubmitting}
            className="gap-2"
          >
            {isSubmitting ? (
              <><Activity className="w-4 h-4 animate-spin" /> Submitting…</>
            ) : (
              <><Play className="w-4 h-4" /> Execute Now</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function ApplicationDetail() {
  const params = useParams()
  const id = Number(params.id)
  const queryClient = useQueryClient()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingProviderId, setPendingProviderId] = useState<string>("")
  const [pendingMode, setPendingMode] = useState<ExecutionMode>("AUTO")

  // Live-poll logs while submitting
  const [polling, setPolling] = useState(false)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: app, isLoading, refetch } = useGetApplication(id, {
    query: { enabled: !!id, queryKey: getGetApplicationQueryKey(id) },
  })

  const { data: liveLogs } = useGetApplicationLogs(id, {
    query: {
      enabled: !!id,
      queryKey: getGetApplicationLogsQueryKey(id),
      refetchInterval: polling ? 1500 : false,
    },
  })

  const { data: providers } = useListProviders()

  const validateMutation = useValidateApplication()
  const executeMutation = useExecuteApplication()
  const updateMutation = useUpdateApplication()

  // Stop polling once no longer submitting
  useEffect(() => {
    if (!app) return
    if (app.status !== "submitting" && polling) {
      setPolling(false)
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    }
  }, [app?.status, polling])

  const handleValidate = () => {
    validateMutation.mutate({ id }, {
      onSuccess: () => {
        refetch()
        queryClient.invalidateQueries({ queryKey: getGetApplicationLogsQueryKey(id) })
      },
    })
  }

  const handleAssignProvider = () => {
    if (!pendingProviderId) return
    updateMutation.mutate(
      { id, data: { providerId: Number(pendingProviderId), executionMode: pendingMode } },
      {
        onSuccess: () => {
          refetch()
          queryClient.invalidateQueries({ queryKey: getGetApplicationLogsQueryKey(id) })
        },
      },
    )
  }

  const handleExecute = (mode: ExecutionMode) => {
    setPolling(true)
    executeMutation.mutate(
      { id, data: { executionMode: mode, confirmedByUser: true } },
      {
        onSuccess: () => {
          setDialogOpen(false)
          refetch()
          queryClient.invalidateQueries({ queryKey: getGetApplicationLogsQueryKey(id) })
          // Let polling stop naturally when status changes
          setTimeout(() => {
            refetch()
            queryClient.invalidateQueries({ queryKey: getGetApplicationLogsQueryKey(id) })
          }, 2000)
        },
        onError: () => {
          setPolling(false)
          setDialogOpen(false)
          refetch()
        },
      },
    )
  }

  if (isLoading || !app) {
    return <div className="p-8 text-center text-slate-500">Loading application payload…</div>
  }

  const isDraft = app.status === "draft"
  const isPendingConf = app.status === "pending_confirmation"
  const isSubmitting = app.status === "submitting" || executeMutation.isPending
  const isCompleted = app.status === "completed"
  const isFailed = app.status === "failed"
  const hasValidationErrors = (app.validationErrors?.length ?? 0) > 0

  // Find the selected provider to check if it has an API endpoint
  const selectedProvider = providers?.find((p) => p.id === app.providerId)
  const hasApiEndpoint = !!(selectedProvider?.apiEndpoint)

  // Use live-polled logs if available, else fall back to embedded logs
  const displayLogs = liveLogs ?? app.logs ?? []

  return (
    <>
      <ExecuteDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirm={handleExecute}
        defaultMode={app.executionMode as ExecutionMode}
        providerName={app.providerName}
        hasApiEndpoint={hasApiEndpoint}
        isSubmitting={isSubmitting}
      />

      <div className="space-y-6 max-w-6xl mx-auto animate-in fade-in duration-300 pb-20">
        {/* ── Header ── */}
        <div className="flex items-start justify-between bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-4">
            <Link href="/applications">
              <Button variant="outline" size="icon" className="h-10 w-10 shrink-0">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-3 mb-1 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">App #{app.id}</h1>

                <Badge variant={
                  isCompleted ? "success" :
                  isFailed ? "destructive" :
                  isDraft ? "secondary" : "default"
                } className="text-sm px-3 py-0.5 capitalize">
                  {app.status.replace(/_/g, " ")}
                </Badge>

                {/* Requested mode */}
                <Badge variant="outline" className="font-mono text-xs gap-1.5 bg-slate-50">
                  {getModeIcon(app.executionMode, "w-3 h-3")}
                  {app.executionMode}
                </Badge>

                {/* Resolved mode (shown after execution starts) */}
                {app.resolvedExecutionMode && (
                  <Badge
                    className={`font-mono text-xs gap-1.5 border ${
                      app.resolvedExecutionMode === "BROWSER"
                        ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                        : "bg-blue-50 text-blue-700 border-blue-200"
                    }`}
                  >
                    {getModeIcon(app.resolvedExecutionMode, "w-3 h-3")}
                    {app.resolvedExecutionMode} resolved
                  </Badge>
                )}
              </div>
              <p className="text-slate-500 text-sm">
                Created {formatDate(app.createdAt)} •{" "}
                Owner: <span className="font-medium text-slate-700">{app.ownerKyc.fullName}</span>
                {app.providerName && (
                  <> • Provider: <span className="font-medium text-slate-700">{app.providerName}</span></>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {(isDraft || hasValidationErrors) && !isSubmitting && (
              <Button
                variant="outline"
                onClick={handleValidate}
                disabled={validateMutation.isPending}
                className="gap-2"
              >
                {validateMutation.isPending
                  ? <Activity className="w-4 h-4 animate-pulse" />
                  : <ShieldCheck className="w-4 h-4" />}
                Validate Payload
              </Button>
            )}

            {isPendingConf && !hasValidationErrors && !isSubmitting && (
              <Button
                onClick={() => setDialogOpen(true)}
                className="gap-2 shadow-lg ring-4 ring-blue-100"
              >
                <Play className="w-4 h-4" />
                Execute Routing
              </Button>
            )}

            {isSubmitting && (
              <div className="flex items-center gap-2 px-4 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-700 text-sm font-medium">
                <Activity className="w-4 h-4 animate-spin" />
                {app.resolvedExecutionMode === "BROWSER"
                  ? "Playwright running…"
                  : app.resolvedExecutionMode === "API"
                  ? "API call in progress…"
                  : "Routing…"}
              </div>
            )}
          </div>
        </div>

        {/* ── No provider assigned — show inline picker ── */}
        {(isDraft || isPendingConf) && !app.providerId && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-5">
            <div className="flex items-start gap-3 mb-4">
              <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-bold text-amber-900">Provider not assigned</h4>
                <p className="text-sm text-amber-700 mt-0.5">
                  Select a provider and execution mode to continue with validation and routing.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-sm font-semibold text-slate-700">Insurance Provider</Label>
                <NativeSelect
                  value={pendingProviderId}
                  onChange={e => setPendingProviderId(e.target.value)}
                  className="h-10"
                >
                  <option value="">-- Select a Provider --</option>
                  {providers?.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-semibold text-slate-700">Execution Mode</Label>
                <NativeSelect
                  value={pendingMode}
                  onChange={e => setPendingMode(e.target.value as ExecutionMode)}
                  className="h-10"
                >
                  <option value="AUTO">AUTO — let router decide</option>
                  <option value="API">API — direct REST call</option>
                  <option value="BROWSER">BROWSER — Playwright automation</option>
                </NativeSelect>
              </div>
            </div>
            <Button
              className="mt-4 gap-2"
              disabled={!pendingProviderId || updateMutation.isPending}
              onClick={handleAssignProvider}
            >
              {updateMutation.isPending ? <Activity className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Assign Provider & Save
            </Button>
          </div>
        )}

        {/* ── Validation errors ── */}
        {hasValidationErrors && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3 text-red-800">
            <ShieldAlert className="w-5 h-5 shrink-0 text-red-600 mt-0.5" />
            <div>
              <h4 className="font-bold mb-1 text-red-900">Validation Failed</h4>
              <ul className="list-disc list-inside text-sm space-y-1 ml-1 text-red-700">
                {app.validationErrors?.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </div>
          </div>
        )}

        {/* ── Policy result ── */}
        {app.policy && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-6 flex items-center justify-between shadow-sm">
            <div className="flex gap-4 items-center text-green-900">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center shrink-0 text-green-600">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h4 className="font-bold text-lg">Policy Issued Successfully</h4>
                <p className="text-sm text-green-800 mt-0.5">
                  Provider: <span className="font-semibold">{app.policy.providerName}</span> •
                  Number:{" "}
                  <span className="font-mono bg-white px-1.5 py-0.5 rounded ml-1 border border-green-200">
                    {app.policy.policyNumber}
                  </span>
                </p>
                {app.resolvedExecutionMode && (
                  <p className="text-xs text-green-700 mt-1 flex items-center gap-1">
                    {getModeIcon(app.resolvedExecutionMode, "w-3 h-3")}
                    Submitted via {app.resolvedExecutionMode === "BROWSER" ? "Playwright browser automation" : "direct API"}
                  </p>
                )}
              </div>
            </div>
            {app.policy.pdfUrl && (
              <Button variant="outline" className="gap-2 bg-white hover:bg-green-50 text-green-700 border-green-200">
                <FileDown className="w-4 h-4" /> Download PDF
              </Button>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-6">
          {/* ── Left: MSA Payload ── */}
          <div className="col-span-2 space-y-6">
            <Card>
              <CardHeader className="pb-3 border-b border-slate-100">
                <CardTitle className="text-lg">MSA Payload</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="grid grid-cols-2 divide-x divide-slate-100">
                  <div className="p-5 space-y-4">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Vehicle</h4>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Make / Model</dt>
                        <dd className="font-medium text-slate-900 text-right">
                          {app.vehicleDetails.make} {app.vehicleDetails.model} {app.vehicleDetails.variant}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Engine No</dt>
                        <dd className="font-mono text-slate-900">{app.vehicleDetails.engineNumber}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Chassis No</dt>
                        <dd className="font-mono text-slate-900">{app.vehicleDetails.chassisNumber}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Ex-Showroom</dt>
                        <dd className="font-mono text-slate-900">
                          ₹{app.vehicleDetails.exShowroomPrice.toLocaleString("en-IN")}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Date of Purchase</dt>
                        <dd className="text-slate-900">{app.vehicleDetails.dateOfPurchase}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="p-5 space-y-4">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Owner KYC</h4>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Name</dt>
                        <dd className="font-medium text-slate-900 text-right">{app.ownerKyc.fullName}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Phone</dt>
                        <dd className="font-mono text-slate-900">{app.ownerKyc.phoneNumber}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Email</dt>
                        <dd className="text-slate-900 truncate max-w-[160px]" title={app.ownerKyc.email}>
                          {app.ownerKyc.email}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">DOB</dt>
                        <dd className="text-slate-900">{app.ownerKyc.dateOfBirth}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">ID Proof</dt>
                        <dd className="font-mono text-slate-900 text-right">
                          {app.ownerKyc.idProofType}: {app.ownerKyc.idProofNumber}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-xl flex items-center justify-between">
                  <div className="space-y-1 text-sm">
                    <span className="text-slate-500 block text-xs font-bold uppercase tracking-wider">RTO</span>
                    <span className="font-medium text-slate-900">
                      {app.rtoDetails.registrationCity}, {app.rtoDetails.registrationState}
                    </span>
                  </div>
                  <div className="bg-white border-2 border-slate-300 px-4 py-2 rounded-md font-mono font-bold text-lg tracking-widest text-slate-800 shadow-sm">
                    {app.rtoDetails.rtoCode}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Right: Execution Logs timeline ── */}
          <div className="col-span-1">
            <Card className="h-full max-h-[600px] flex flex-col">
              <CardHeader className="pb-3 border-b border-slate-100 shrink-0 flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Execution Logs</CardTitle>
                {polling && (
                  <span className="flex items-center gap-1 text-xs text-indigo-600 font-medium animate-pulse">
                    <Activity className="w-3 h-3" /> Live
                  </span>
                )}
              </CardHeader>

              <CardContent className="p-5 overflow-y-auto flex-1">
                {displayLogs.length === 0 ? (
                  <div className="text-center text-sm text-slate-400 py-8">
                    No logs yet. Validate and execute to see step-by-step progress.
                  </div>
                ) : (
                  <div className="space-y-5 relative">
                    {/* Timeline spine */}
                    <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-gradient-to-b from-transparent via-slate-200 to-transparent" />

                    {displayLogs.map((log) => {
                      const screenshot = (log.metadata as any)?.screenshot as string | undefined
                      return (
                        <div key={log.id} className="relative flex items-start gap-4">
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 z-10 border-2 border-white shadow-sm ${getStatusColor(log.status)}`}
                          >
                            {getStatusIcon(log.status)}
                          </div>
                          <div className="pt-1 flex-1 min-w-0">
                            <div className="flex items-baseline justify-between mb-0.5 gap-2">
                              <span className="font-semibold text-sm text-slate-900 capitalize truncate">
                                {log.step.replace(/_/g, " ")}
                              </span>
                              <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1 shrink-0">
                                <Clock className="w-3 h-3" />
                                {new Date(log.createdAt).toLocaleTimeString()}
                              </span>
                            </div>
                            <p className="text-xs text-slate-600 leading-relaxed">{log.message}</p>
                            {screenshot && (
                              <a
                                href={`data:image/jpeg;base64,${screenshot}`}
                                target="_blank"
                                rel="noreferrer"
                                className="block mt-2"
                              >
                                <img
                                  src={`data:image/jpeg;base64,${screenshot}`}
                                  alt={`Browser screenshot — ${log.step}`}
                                  className="rounded-lg border border-slate-200 shadow-sm w-full object-cover hover:opacity-90 transition-opacity cursor-zoom-in"
                                  style={{ maxHeight: 140 }}
                                />
                                <span className="text-[10px] text-slate-400 mt-0.5 block">
                                  Click to view full size
                                </span>
                              </a>
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {/* Animated pending dot while submitting */}
                    {isSubmitting && (
                      <div className="relative flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 z-10 border-2 border-white shadow-sm bg-indigo-100 text-indigo-600">
                          <Activity className="w-4 h-4 animate-spin" />
                        </div>
                        <p className="text-xs text-indigo-600 font-medium animate-pulse">
                          {app.resolvedExecutionMode === "BROWSER"
                            ? "Playwright navigating portal…"
                            : "Waiting for provider response…"}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}
