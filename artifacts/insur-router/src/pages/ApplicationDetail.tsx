import { useGetApplication, useValidateApplication, useExecuteApplication } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useParams, Link } from "wouter"
import { ArrowLeft, Play, ShieldAlert, ShieldCheck, CheckCircle2, FileDown, Activity, AlertCircle, Info, Clock, Cpu, Server, Globe } from "lucide-react"
import { formatDate } from "@/lib/utils"

export default function ApplicationDetail() {
  const params = useParams()
  const id = Number(params.id)

  const { data: app, isLoading, refetch } = useGetApplication(id, {
    query: { enabled: !!id, queryKey: ['application', id] }
  })

  const validateMutation = useValidateApplication()
  const executeMutation = useExecuteApplication()

  const handleValidate = () => {
    validateMutation.mutate({ id }, {
      onSuccess: () => refetch()
    })
  }

  const handleExecute = () => {
    executeMutation.mutate({ 
      id, 
      data: { confirmedByUser: true } 
    }, {
      onSuccess: () => refetch()
    })
  }

  if (isLoading || !app) {
    return <div className="p-8 text-center text-slate-500">Loading application payload...</div>
  }

  const isDraft = app.status === 'draft'
  const isValidating = app.status === 'validating' || validateMutation.isPending
  const isPendingConf = app.status === 'pending_confirmation'
  const isSubmitting = app.status === 'submitting' || executeMutation.isPending
  const isCompleted = app.status === 'completed'

  const hasValidationErrors = app.validationErrors && app.validationErrors.length > 0

  const getModeIcon = (mode: string) => {
    if (mode === 'API') return <Server className="w-3 h-3" />
    if (mode === 'BROWSER') return <Globe className="w-3 h-3" />
    return <Cpu className="w-3 h-3" />
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto animate-in fade-in duration-300 pb-20">
      {/* Header */}
      <div className="flex items-start justify-between bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-4">
          <Link href="/applications">
            <Button variant="outline" size="icon" className="h-10 w-10 shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">App #{app.id}</h1>
              <Badge variant={
                isCompleted ? 'success' : 
                app.status === 'failed' ? 'destructive' : 
                isDraft ? 'draft' : 'warning'
              } className="text-sm px-3 py-0.5">
                {app.status.replace('_', ' ').toUpperCase()}
              </Badge>
              {app.resolvedExecutionMode && (
                <Badge variant="outline" className="font-mono text-xs gap-1.5 bg-slate-50">
                  {getModeIcon(app.resolvedExecutionMode)}
                  {app.resolvedExecutionMode} (Resolved)
                </Badge>
              )}
            </div>
            <p className="text-slate-500 text-sm">
              Created {formatDate(app.createdAt)} • Owner: <span className="font-medium text-slate-700">{app.ownerKyc.fullName}</span>
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {(isDraft || hasValidationErrors) && (
            <Button 
              variant="outline" 
              onClick={handleValidate} 
              disabled={isValidating}
              className="gap-2"
            >
              {isValidating ? <Activity className="w-4 h-4 animate-pulse" /> : <ShieldCheck className="w-4 h-4" />}
              Validate Payload
            </Button>
          )}

          {isPendingConf && !hasValidationErrors && (
            <Button 
              variant="accent" 
              onClick={handleExecute} 
              disabled={isSubmitting}
              className="gap-2 shadow-lg ring-4 ring-blue-100"
            >
              {isSubmitting ? <Activity className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Execute Routing
            </Button>
          )}
        </div>
      </div>

      {/* Validation Banner */}
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

      {/* Policy Result Banner */}
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
                Number: <span className="font-mono bg-white px-1.5 py-0.5 rounded ml-1 border border-green-200">{app.policy.policyNumber}</span>
              </p>
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
        {/* Left Column: MSA Payload */}
        <div className="col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-3 border-b border-slate-100">
              <CardTitle className="text-lg">MSA Payload Data</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="grid grid-cols-2 divide-x divide-slate-100">
                <div className="p-5 space-y-4">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Vehicle</h4>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between"><dt className="text-slate-500">Make/Model</dt><dd className="font-medium text-slate-900 text-right">{app.vehicleDetails.make} {app.vehicleDetails.model} {app.vehicleDetails.variant}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Engine No</dt><dd className="font-mono text-slate-900">{app.vehicleDetails.engineNumber}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Chassis No</dt><dd className="font-mono text-slate-900">{app.vehicleDetails.chassisNumber}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Ex-Showroom</dt><dd className="font-mono text-slate-900">₹{app.vehicleDetails.exShowroomPrice.toLocaleString()}</dd></div>
                  </dl>
                </div>
                <div className="p-5 space-y-4">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Owner</h4>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between"><dt className="text-slate-500">Name</dt><dd className="font-medium text-slate-900 text-right">{app.ownerKyc.fullName}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Phone</dt><dd className="font-mono text-slate-900">{app.ownerKyc.phoneNumber}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Address</dt><dd className="font-medium text-slate-900 text-right truncate max-w-[150px]" title={app.ownerKyc.billingAddress}>{app.ownerKyc.billingAddress}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">ID Proof</dt><dd className="font-mono text-slate-900 text-right">{app.ownerKyc.idProofType}: {app.ownerKyc.idProofNumber}</dd></div>
                  </dl>
                </div>
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-xl flex items-center justify-between">
                <div className="space-y-1 text-sm">
                  <span className="text-slate-500 block">RTO Details</span>
                  <span className="font-medium text-slate-900">{app.rtoDetails.registrationCity}, {app.rtoDetails.registrationState}</span>
                </div>
                <div className="bg-white border-2 border-slate-300 px-4 py-2 rounded-md font-mono font-bold text-lg tracking-widest text-slate-800 shadow-sm">
                  {app.rtoDetails.rtoCode}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Execution Timeline */}
        <div className="col-span-1">
          <Card className="h-full max-h-[600px] flex flex-col">
            <CardHeader className="pb-3 border-b border-slate-100 shrink-0">
              <CardTitle className="text-lg">Execution Logs</CardTitle>
            </CardHeader>
            <CardContent className="p-5 overflow-y-auto flex-1">
              <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-200 before:to-transparent">
                {app.logs?.length === 0 && <div className="text-center text-sm text-slate-400 py-4">No logs generated yet.</div>}
                
                {app.logs?.map((log, i) => (
                  <div key={log.id} className="relative flex items-start gap-4">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 z-10 border-4 border-white ${
                      log.status === 'success' ? 'bg-green-100 text-green-600' :
                      log.status === 'error' ? 'bg-red-100 text-red-600' :
                      log.status === 'warning' ? 'bg-amber-100 text-amber-600' :
                      'bg-blue-100 text-blue-600'
                    }`}>
                      {log.status === 'success' ? <CheckCircle2 className="w-5 h-5" /> :
                       log.status === 'error' ? <AlertCircle className="w-5 h-5" /> :
                       <Info className="w-5 h-5" />}
                    </div>
                    <div className="pt-1 flex-1">
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="font-semibold text-sm text-slate-900 capitalize">{log.step.replace('_', ' ')}</span>
                        <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(log.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600 leading-relaxed">{log.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
