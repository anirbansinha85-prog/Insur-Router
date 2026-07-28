import { useState } from "react"
import { useListApplications } from "@workspace/api-client-react"
import type { ApplicationStatus } from "@workspace/api-client-react"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { Link, useLocation } from "wouter"
import { Plus, Search, ChevronRight } from "lucide-react"

export default function ApplicationsList() {
  const [, setLocation] = useLocation()
  const [statusFilter, setStatusFilter] = useState<string>("all")
  
  // Convert "all" to undefined for the API call
  const apiStatusFilter = statusFilter === "all" ? undefined : (statusFilter as ApplicationStatus)
  const { data: applications, isLoading } = useListApplications({ status: apiStatusFilter })

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Applications</h1>
          <p className="text-slate-500 text-sm mt-1">Manage and track all insurance routing requests.</p>
        </div>
        <Button variant="accent" onClick={() => setLocation("/applications/new")} className="gap-2">
          <Plus className="w-4 h-4" /> New Application
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <Tabs value={statusFilter} onValueChange={setStatusFilter} className="w-full sm:w-auto">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="draft">Draft</TabsTrigger>
            <TabsTrigger value="validating">Validating</TabsTrigger>
            <TabsTrigger value="submitting">Submitting</TabsTrigger>
            <TabsTrigger value="completed">Completed</TabsTrigger>
            <TabsTrigger value="failed">Failed</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">ID</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Vehicle</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : applications?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <Search className="w-8 h-8 text-slate-300" />
                    <span>No applications found for this filter.</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              applications?.map((app) => (
                <TableRow 
                  key={app.id} 
                  className="cursor-pointer group"
                  onClick={() => setLocation(`/applications/${app.id}`)}
                >
                  <TableCell className="font-mono text-xs text-slate-500">#{app.id}</TableCell>
                  <TableCell className="font-semibold text-slate-900">{app.ownerName}</TableCell>
                  <TableCell className="text-slate-600">{app.vehicleMake} {app.vehicleModel}</TableCell>
                  <TableCell>
                    {app.providerName ? (
                      <span className="font-medium text-slate-700">{app.providerName}</span>
                    ) : (
                      <span className="text-slate-400 italic text-xs">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[10px] tracking-wider uppercase bg-slate-50">
                      {app.executionMode}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={
                      app.status === 'completed' ? 'success' : 
                      app.status === 'failed' ? 'destructive' : 
                      app.status === 'draft' ? 'draft' : 'warning'
                    }>
                      {app.status.replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs text-slate-500 whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      {formatDate(app.createdAt)}
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-accent transition-colors" />
                    </div>
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
