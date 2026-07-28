import { useListProviders } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, Edit2, Globe, FileCode2, Check, X } from "lucide-react"
import { Link, useLocation } from "wouter"

export default function ProvidersList() {
  const [, setLocation] = useLocation()
  const { data: providers, isLoading } = useListProviders()

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Providers</h1>
          <p className="text-slate-500 text-sm mt-1">Manage insurance provider configurations and endpoints.</p>
        </div>
        <Button variant="accent" onClick={() => setLocation("/providers/new")} className="gap-2">
          <Plus className="w-4 h-4" /> Add Provider
        </Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Brand</TableHead>
              <TableHead>Provider Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Default Mode</TableHead>
              <TableHead>Endpoints</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="w-8 h-8 rounded-md" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : providers?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-slate-500">
                  No providers configured. Add one to start routing applications.
                </TableCell>
              </TableRow>
            ) : (
              providers?.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell>
                    <div 
                      className="w-8 h-8 rounded-md shadow-sm border border-slate-200"
                      style={{ backgroundColor: provider.logoColor || '#e2e8f0' }}
                    />
                  </TableCell>
                  <TableCell className="font-semibold text-slate-900">{provider.name}</TableCell>
                  <TableCell>
                    <span className="font-mono text-xs bg-slate-100 px-2 py-1 rounded text-slate-600">
                      {provider.code}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[10px] tracking-wider uppercase">
                      {provider.defaultExecutionMode}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 text-xs text-slate-500">
                      <div className="flex items-center gap-1.5">
                        <FileCode2 className="w-3.5 h-3.5" /> 
                        {provider.apiEndpoint ? <span className="truncate max-w-[150px]">{provider.apiEndpoint}</span> : <span className="text-slate-300 italic">No API</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Globe className="w-3.5 h-3.5" />
                        {provider.portalUrl ? <span className="truncate max-w-[150px]">{provider.portalUrl}</span> : <span className="text-slate-300 italic">No Portal</span>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {provider.isActive ? (
                      <Badge variant="success" className="gap-1 pl-1.5"><Check className="w-3 h-3"/> Active</Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 pl-1.5"><X className="w-3 h-3"/> Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setLocation(`/providers/${provider.id}/edit`)}>
                      <Edit2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
