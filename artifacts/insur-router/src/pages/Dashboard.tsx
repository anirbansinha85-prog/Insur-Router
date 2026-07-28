import { useGetDashboardStats, useGetRecentApplications } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { Activity, CheckCircle2, AlertCircle, Clock, FileText } from "lucide-react"
import { formatDate } from "@/lib/utils"
import { Link } from "wouter"

function StatCard({ title, value, icon: Icon, colorClass, isLoading }: { title: string, value?: number, icon: any, colorClass: string, isLoading: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-semibold text-slate-500">{title}</CardTitle>
        <Icon className={`w-4 h-4 ${colorClass}`} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16 mt-1" />
        ) : (
          <div className="text-3xl font-bold text-slate-900">{value ?? 0}</div>
        )}
      </CardContent>
    </Card>
  )
}

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats()
  const { data: recent, isLoading: recentLoading } = useGetRecentApplications()

  const providerData = stats?.providerBreakdown?.map(p => ({
    name: p.providerName,
    Total: p.count,
    Completed: p.completed
  })) || []

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">System Status</h1>
          <p className="text-slate-500 text-sm mt-1">Real-time overview of application routing and execution.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard title="Total Apps" value={stats?.total} icon={FileText} colorClass="text-blue-500" isLoading={statsLoading} />
        <StatCard title="Draft" value={stats?.draft} icon={Activity} colorClass="text-slate-400" isLoading={statsLoading} />
        <StatCard title="Submitting" value={stats?.submitting} icon={Clock} colorClass="text-amber-500" isLoading={statsLoading} />
        <StatCard title="Completed" value={stats?.completed} icon={CheckCircle2} colorClass="text-green-500" isLoading={statsLoading} />
        <StatCard title="Failed" value={stats?.failed} icon={AlertCircle} colorClass="text-red-500" isLoading={statsLoading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <Card className="col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Provider Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : providerData.length > 0 ? (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={providerData} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                    <Tooltip 
                      cursor={{fill: '#f8fafc'}}
                      contentStyle={{borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}}
                    />
                    <Bar dataKey="Total" fill="#94a3b8" radius={[4, 4, 0, 0]} maxBarSize={40} />
                    <Bar dataKey="Completed" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-slate-400">
                No provider data available
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1 flex flex-col">
          <CardHeader className="pb-3 border-b border-slate-100">
            <CardTitle className="text-lg flex justify-between items-center">
              Recent Activity
              <Link href="/applications" className="text-sm font-medium text-accent hover:underline">View All</Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-y-auto">
            {recentLoading ? (
              <div className="p-6 space-y-4">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : recent?.length ? (
              <div className="divide-y divide-slate-100">
                {recent.map(app => (
                  <Link key={app.id} href={`/applications/${app.id}`} className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors group">
                    <div className="space-y-1">
                      <div className="font-semibold text-sm group-hover:text-accent transition-colors">{app.ownerName}</div>
                      <div className="text-xs text-slate-500">{app.vehicleMake} {app.vehicleModel}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant={
                        app.status === 'completed' ? 'success' : 
                        app.status === 'failed' ? 'destructive' : 
                        app.status === 'draft' ? 'draft' : 'warning'
                      }>
                        {app.status}
                      </Badge>
                      <div className="text-[10px] text-slate-400 font-mono">{formatDate(app.createdAt)}</div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center text-slate-500">No recent applications</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
