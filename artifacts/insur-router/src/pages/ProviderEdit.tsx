import { useState, useEffect } from "react"
import { useGetProvider, useCreateProvider, useUpdateProvider } from "@workspace/api-client-react"
import type { ProviderInput } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/select"
import { useLocation, useParams } from "wouter"
import { ArrowLeft, Save, Loader2 } from "lucide-react"

export default function ProviderEdit() {
  const [, setLocation] = useLocation()
  const params = useParams()
  const isNew = !params.id || params.id === "new"
  const providerId = isNew ? null : Number(params.id)

  const { data: provider, isLoading } = useGetProvider(providerId as number, { 
    query: { enabled: !!providerId, queryKey: ['provider', providerId] } 
  })
  
  const createMutation = useCreateProvider()
  const updateMutation = useUpdateProvider()

  const [formData, setFormData] = useState<ProviderInput>({
    name: "",
    code: "",
    defaultExecutionMode: "API",
    apiEndpoint: "",
    portalUrl: "",
    isActive: true,
    logoColor: "#3b82f6"
  })

  useEffect(() => {
    if (provider && !isNew) {
      setFormData({
        name: provider.name,
        code: provider.code,
        defaultExecutionMode: provider.defaultExecutionMode,
        apiEndpoint: provider.apiEndpoint || "",
        portalUrl: provider.portalUrl || "",
        isActive: provider.isActive,
        logoColor: provider.logoColor || "#e2e8f0"
      })
    }
  }, [provider, isNew])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target
    const val = type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    setFormData((prev: ProviderInput) => ({ ...prev, [name]: val }))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    
    // Normalize empty strings to null for API
    const payload = {
      ...formData,
      apiEndpoint: formData.apiEndpoint || null,
      portalUrl: formData.portalUrl || null,
    }

    if (isNew) {
      createMutation.mutate({ data: payload }, {
        onSuccess: () => setLocation('/providers')
      })
    } else {
      updateMutation.mutate({ id: providerId as number, data: payload }, {
        onSuccess: () => setLocation('/providers')
      })
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending

  if (!isNew && isLoading) {
    return <div className="p-8 text-center text-slate-500">Loading provider...</div>
  }

  return (
    <div className="space-y-6 max-w-3xl animate-in fade-in duration-300">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation('/providers')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{isNew ? 'Add Provider' : 'Edit Provider'}</h1>
          <p className="text-slate-500 text-sm">Configure routing details and integration endpoints.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="name">Provider Name</Label>
                <Input id="name" name="name" required value={formData.name} onChange={handleChange} placeholder="e.g. HDFC Ergo" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="code">Code (Unique)</Label>
                <Input id="code" name="code" required value={formData.code} onChange={handleChange} placeholder="e.g. HDFC" className="uppercase font-mono" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="defaultExecutionMode">Default Execution Mode</Label>
                <NativeSelect id="defaultExecutionMode" name="defaultExecutionMode" value={formData.defaultExecutionMode} onChange={handleChange}>
                  <option value="API">API Integration</option>
                  <option value="BROWSER">Browser Automation</option>
                  <option value="AUTO">Auto (Smart Routing)</option>
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="logoColor">Brand Color</Label>
                <div className="flex gap-2">
                  <Input type="color" id="logoColor" name="logoColor" value={formData.logoColor || "#ffffff"} onChange={handleChange} className="w-14 p-1 h-10 cursor-pointer" />
                  <Input type="text" value={formData.logoColor || ""} onChange={handleChange} name="logoColor" className="flex-1 font-mono uppercase" placeholder="#HEXCODE" />
                </div>
              </div>
            </div>
            
            <div className="space-y-4 pt-4 border-t">
              <h3 className="text-sm font-semibold text-slate-900">Integration Endpoints</h3>
              <div className="space-y-2">
                <Label htmlFor="apiEndpoint">REST API Endpoint URL</Label>
                <Input id="apiEndpoint" name="apiEndpoint" type="url" value={formData.apiEndpoint || ""} onChange={handleChange} placeholder="https://api.provider.com/v1/..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="portalUrl">Dealer Portal URL (for Browser mode)</Label>
                <Input id="portalUrl" name="portalUrl" type="url" value={formData.portalUrl || ""} onChange={handleChange} placeholder="https://dealer.provider.com/login" />
              </div>
            </div>

            <div className="pt-4 border-t flex items-center gap-3">
              <input 
                type="checkbox" 
                id="isActive" 
                name="isActive" 
                checked={formData.isActive} 
                onChange={handleChange} 
                className="w-4 h-4 text-accent border-slate-300 rounded focus:ring-accent"
              />
              <Label htmlFor="isActive" className="cursor-pointer">Active and available for routing</Label>
            </div>

          </CardContent>
          <div className="p-6 bg-slate-50 border-t flex justify-end gap-3 rounded-b-xl">
            <Button type="button" variant="outline" onClick={() => setLocation('/providers')}>Cancel</Button>
            <Button type="submit" variant="accent" disabled={isSaving} className="min-w-[120px]">
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Save className="w-4 h-4 mr-2" /> Save Provider</>}
            </Button>
          </div>
        </Card>
      </form>
    </div>
  )
}
