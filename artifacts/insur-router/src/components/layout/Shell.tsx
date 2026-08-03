import { Link, useLocation } from "wouter"
import { LayoutDashboard, FileText, Building2, Bell, Search, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()

  // InsurRouter is the insurance product and nothing else. The DDMS screens
  // that briefly lived here — enquiries, deals, workshop — now live in
  // artifacts/ddms as their own service. They were put here originally because
  // this app already had the API proxy and the components, which is a reason to
  // save a day's work, not a reason to decide an architecture.
  const nav = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/applications", label: "Applications", icon: FileText },
    { href: "/providers", label: "Providers", icon: Building2 },
  ]

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900 font-sans">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col border-r border-slate-800">
        <div className="h-16 flex items-center px-6 border-b border-slate-800 text-white font-bold tracking-wide text-lg gap-3 shrink-0">
          <div className="w-7 h-7 rounded bg-accent flex items-center justify-center shadow-sm">
            <span className="text-white text-xs font-black">IR</span>
          </div>
          InsurRouter
        </div>
        <div className="flex-1 py-6 px-4 space-y-1">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 px-2">Operations</div>
          {nav.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium group",
                isActive
                  ? "bg-accent text-white"
                  : "hover:bg-slate-800 hover:text-white"
              )}>
                <item.icon className={cn("w-4 h-4", isActive ? "text-white" : "text-slate-400 group-hover:text-slate-200")} />
                {item.label}
              </Link>
            )
          })}
        </div>
        <div className="p-4 border-t border-slate-800 shrink-0">
          <div className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-slate-800 transition-colors cursor-pointer">
            <div className="w-8 h-8 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center text-sm font-medium text-white shadow-inner">
              JD
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-white">John Doe</span>
              <span className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">Agent</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 shrink-0 z-10 shadow-sm">
          <div className="flex items-center gap-4 flex-1">
            <div className="relative w-96 max-w-md">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search applications (Reg No, Phone, Name)..." 
                className="w-full pl-9 pr-4 py-2 bg-slate-100 border-transparent rounded-md text-sm font-medium focus:bg-white focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all placeholder:text-slate-400"
              />
            </div>
          </div>
          <div className="flex items-center gap-5">
            <button className="text-slate-400 hover:text-slate-600 relative transition-colors">
              <Bell className="w-5 h-5" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
            </button>
            <div className="h-6 w-px bg-slate-200" />
            <button className="text-slate-400 hover:text-slate-600 transition-colors">
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </header>
        
        {/* Page Content */}
        <div className="flex-1 overflow-auto bg-slate-50">
          <div className="p-8 max-w-7xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  )
}
