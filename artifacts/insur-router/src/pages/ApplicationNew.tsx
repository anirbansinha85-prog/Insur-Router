import { useState } from "react"
import { useCreateApplication, useListProviders } from "@workspace/api-client-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/select"
import { useLocation } from "wouter"
import { Check, ChevronRight, Loader2, Server, Globe, Cpu } from "lucide-react"

const STEPS = ["Vehicle Details", "Owner KYC", "RTO Details", "Routing"]

export default function ApplicationNew() {
  const [, setLocation] = useLocation()
  const [currentStep, setCurrentStep] = useState(0)
  
  const createMutation = useCreateApplication()
  const { data: providers } = useListProviders()

  const [formData, setFormData] = useState({
    vehicleDetails: {
      make: "Honda",
      model: "Activa 6G",
      variant: "DLX",
      engineNumber: "ENG123456789",
      chassisNumber: "MBL123456789",
      exShowroomPrice: 85000,
      dateOfPurchase: new Date().toISOString().split('T')[0]
    },
    ownerKyc: {
      fullName: "Jane Smith",
      billingAddress: "123 MG Road, Indiranagar",
      pincode: 560038,
      phoneNumber: 9876543210,
      email: "jane@example.com",
      dateOfBirth: "1990-01-01",
      idProofType: "AADHAR" as any,
      idProofNumber: "1234 5678 9012"
    },
    rtoDetails: {
      registrationCity: "Bangalore",
      registrationState: "Karnataka",
      rtoCode: "KA-03"
    },
    providerId: "",
    executionMode: "AUTO" as any
  })

  const updateNestedField = (section: keyof typeof formData, field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [section]: {
        ...(prev[section] as any),
        [field]: value
      }
    }))
  }

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(s => s + 1)
    } else {
      // Submit
      const payload = {
        vehicleDetails: formData.vehicleDetails,
        ownerKyc: formData.ownerKyc,
        rtoDetails: formData.rtoDetails,
        executionMode: formData.executionMode,
        providerId: formData.providerId ? Number(formData.providerId) : null
      }
      
      createMutation.mutate({ data: payload as any }, {
        onSuccess: (data) => {
          setLocation(`/applications/${data.id}`)
        }
      })
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">New Application</h1>
        <p className="text-slate-500 text-sm mt-1">Ingest a new insurance application payload into the router.</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-between relative px-2">
        <div className="absolute left-6 right-6 top-1/2 h-0.5 bg-slate-200 -translate-y-1/2 z-0"></div>
        {STEPS.map((step, idx) => {
          const isActive = idx === currentStep
          const isPast = idx < currentStep
          return (
            <div key={step} className="relative z-10 flex flex-col items-center gap-2">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-colors ${
                isActive ? "bg-accent text-white shadow-md ring-4 ring-blue-100" :
                isPast ? "bg-slate-800 text-white" : "bg-white border-2 border-slate-200 text-slate-400"
              }`}>
                {isPast ? <Check className="w-5 h-5" /> : idx + 1}
              </div>
              <span className={`text-xs font-semibold ${isActive ? 'text-accent' : isPast ? 'text-slate-800' : 'text-slate-400'}`}>
                {step}
              </span>
            </div>
          )
        })}
      </div>

      <Card className="overflow-visible">
        <CardContent className="p-8">
          {currentStep === 0 && (
            <div className="grid grid-cols-2 gap-6 animate-in slide-in-from-right-4 fade-in">
              <div className="col-span-2 text-lg font-semibold border-b pb-2 mb-2">Vehicle Details</div>
              <div className="space-y-2">
                <Label>Make</Label>
                <Input value={formData.vehicleDetails.make} onChange={e => updateNestedField('vehicleDetails', 'make', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Model</Label>
                <Input value={formData.vehicleDetails.model} onChange={e => updateNestedField('vehicleDetails', 'model', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Variant</Label>
                <Input value={formData.vehicleDetails.variant} onChange={e => updateNestedField('vehicleDetails', 'variant', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Ex-Showroom Price (₹)</Label>
                <Input type="number" value={formData.vehicleDetails.exShowroomPrice} onChange={e => updateNestedField('vehicleDetails', 'exShowroomPrice', Number(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>Engine Number</Label>
                <Input value={formData.vehicleDetails.engineNumber} onChange={e => updateNestedField('vehicleDetails', 'engineNumber', e.target.value)} className="font-mono uppercase" />
              </div>
              <div className="space-y-2">
                <Label>Chassis Number</Label>
                <Input value={formData.vehicleDetails.chassisNumber} onChange={e => updateNestedField('vehicleDetails', 'chassisNumber', e.target.value)} className="font-mono uppercase" />
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <div className="grid grid-cols-2 gap-6 animate-in slide-in-from-right-4 fade-in">
              <div className="col-span-2 text-lg font-semibold border-b pb-2 mb-2">Owner KYC</div>
              <div className="space-y-2">
                <Label>Full Name</Label>
                <Input value={formData.ownerKyc.fullName} onChange={e => updateNestedField('ownerKyc', 'fullName', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Phone Number</Label>
                <Input type="number" value={formData.ownerKyc.phoneNumber} onChange={e => updateNestedField('ownerKyc', 'phoneNumber', Number(e.target.value))} />
              </div>
              <div className="col-span-2 space-y-2">
                <Label>Billing Address</Label>
                <Input value={formData.ownerKyc.billingAddress} onChange={e => updateNestedField('ownerKyc', 'billingAddress', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input type="email" value={formData.ownerKyc.email} onChange={e => updateNestedField('ownerKyc', 'email', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Pincode</Label>
                <Input type="number" value={formData.ownerKyc.pincode} onChange={e => updateNestedField('ownerKyc', 'pincode', Number(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>ID Proof Type</Label>
                <NativeSelect value={formData.ownerKyc.idProofType} onChange={e => updateNestedField('ownerKyc', 'idProofType', e.target.value)}>
                  <option value="AADHAR">Aadhar</option>
                  <option value="PAN">PAN</option>
                  <option value="DRIVING_LICENSE">Driving License</option>
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label>ID Proof Number</Label>
                <Input value={formData.ownerKyc.idProofNumber} onChange={e => updateNestedField('ownerKyc', 'idProofNumber', e.target.value)} className="font-mono uppercase" />
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="grid grid-cols-2 gap-6 animate-in slide-in-from-right-4 fade-in">
              <div className="col-span-2 text-lg font-semibold border-b pb-2 mb-2">RTO Details</div>
              <div className="space-y-2">
                <Label>Registration State</Label>
                <Input value={formData.rtoDetails.registrationState} onChange={e => updateNestedField('rtoDetails', 'registrationState', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Registration City</Label>
                <Input value={formData.rtoDetails.registrationCity} onChange={e => updateNestedField('rtoDetails', 'registrationCity', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>RTO Code</Label>
                <Input value={formData.rtoDetails.rtoCode} onChange={e => updateNestedField('rtoDetails', 'rtoCode', e.target.value)} className="font-mono uppercase text-lg h-12" placeholder="KA-01" />
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="grid grid-cols-1 gap-8 animate-in slide-in-from-right-4 fade-in">
              <div className="text-lg font-semibold border-b pb-2 mb-2">Routing Strategy</div>
              
              <div className="space-y-3">
                <Label className="text-base">Target Provider (Optional)</Label>
                <p className="text-sm text-slate-500 pb-2">Select a specific provider to bypass auto-selection logic.</p>
                <NativeSelect 
                  value={formData.providerId} 
                  onChange={e => setFormData(p => ({...p, providerId: e.target.value}))}
                  className="h-12 text-base"
                >
                  <option value="">-- Let Router Decide (Best Rate) --</option>
                  {providers?.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
                  ))}
                </NativeSelect>
              </div>

              <div className="space-y-4">
                <Label className="text-base">Execution Mode</Label>
                <div className="grid grid-cols-3 gap-4">
                  
                  <div 
                    className={`border-2 rounded-xl p-4 cursor-pointer transition-all ${formData.executionMode === 'AUTO' ? 'border-accent bg-blue-50 ring-2 ring-accent/20' : 'border-slate-200 hover:border-slate-300'}`}
                    onClick={() => setFormData(p => ({...p, executionMode: 'AUTO'}))}
                  >
                    <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center mb-3">
                      <Cpu className="w-5 h-5 text-accent" />
                    </div>
                    <h3 className="font-bold text-slate-900 mb-1">AUTO</h3>
                    <p className="text-xs text-slate-500 leading-relaxed">System decides between API or Browser based on provider health and capability.</p>
                  </div>

                  <div 
                    className={`border-2 rounded-xl p-4 cursor-pointer transition-all ${formData.executionMode === 'API' ? 'border-slate-800 bg-slate-50 ring-2 ring-slate-800/20' : 'border-slate-200 hover:border-slate-300'}`}
                    onClick={() => setFormData(p => ({...p, executionMode: 'API'}))}
                  >
                    <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center mb-3">
                      <Server className="w-5 h-5 text-slate-700" />
                    </div>
                    <h3 className="font-bold text-slate-900 mb-1">API Only</h3>
                    <p className="text-xs text-slate-500 leading-relaxed">Strictly use JSON REST endpoints. Fails if provider API is down.</p>
                  </div>

                  <div 
                    className={`border-2 rounded-xl p-4 cursor-pointer transition-all ${formData.executionMode === 'BROWSER' ? 'border-purple-600 bg-purple-50 ring-2 ring-purple-600/20' : 'border-slate-200 hover:border-slate-300'}`}
                    onClick={() => setFormData(p => ({...p, executionMode: 'BROWSER'}))}
                  >
                    <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center mb-3">
                      <Globe className="w-5 h-5 text-purple-600" />
                    </div>
                    <h3 className="font-bold text-slate-900 mb-1">Browser Auto</h3>
                    <p className="text-xs text-slate-500 leading-relaxed">Headless browser automation via dealer portal. Slower but works universally.</p>
                  </div>

                </div>
              </div>
            </div>
          )}

        </CardContent>
        <div className="p-6 bg-slate-50 border-t flex justify-between rounded-b-xl">
          <Button variant="ghost" onClick={() => currentStep > 0 ? setCurrentStep(s => s - 1) : setLocation('/applications')} disabled={createMutation.isPending}>
            {currentStep === 0 ? "Cancel" : "Back"}
          </Button>
          <Button variant="accent" onClick={handleNext} disabled={createMutation.isPending} className="px-8 font-bold">
            {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {currentStep === STEPS.length - 1 ? "Inject Payload" : "Next Step"}
            {currentStep < STEPS.length - 1 && <ChevronRight className="w-4 h-4 ml-1" />}
          </Button>
        </div>
      </Card>
    </div>
  )
}
