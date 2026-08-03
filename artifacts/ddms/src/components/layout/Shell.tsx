import { Link, useLocation } from "wouter"
import { Users, ListChecks, Wrench, Building2, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * DDMS's own shell.
 *
 * Deliberately not InsurRouter's. The person here is an owner looking across
 * several showrooms, not an agent working one application, and the two screens
 * answering to the same chrome was the visible symptom of DDMS having been
 * built inside the wrong product.
 *
 * The nav follows the customer through the business — enquiry, then sale, then
 * service — because that is the order in which work is lost.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()

  const nav = [
    { href: "/", label: "Enquiries", icon: Users, hint: "Leads and the response clock" },
    { href: "/worklist", label: "Sales", icon: ListChecks, hint: "Deals and insurance" },
    { href: "/service", label: "Workshop", icon: Wrench, hint: "Job cards" },
  ]

  // The other two products, reachable from here but not owned by here. They run
  // as their own services; DDMS links out rather than embedding them.
  const services = [
    { href: "http://localhost:24791/", label: "InsurRouter", hint: "Insurance issuance" },
    { href: "http://localhost:18815/doc-ingest/", label: "VeloDocs", hint: "Document ingestion" },
  ]

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900 font-sans">
      <aside className="w-64 bg-[#0d1b2a] text-slate-300 flex flex-col border-r border-slate-800">
        <div className="h-16 flex items-center px-6 border-b border-slate-800 text-white font-bold tracking-wide text-lg gap-3 shrink-0">
          <div className="w-7 h-7 rounded bg-emerald-500 flex items-center justify-center shadow-sm">
            <span className="text-white text-[10px] font-black">DD</span>
          </div>
          DDMS
        </div>

        <div className="flex-1 py-6 px-4 space-y-1 overflow-y-auto">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 px-2">
            Across the group
          </div>
          {nav.map((item) => {
            const isActive =
              location === item.href || (item.href !== "/" && location.startsWith(item.href))
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-start gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium group",
                  isActive ? "bg-emerald-600 text-white" : "hover:bg-slate-800 hover:text-white",
                )}
              >
                <item.icon
                  className={cn(
                    "w-4 h-4 mt-0.5 shrink-0",
                    isActive ? "text-white" : "text-slate-400 group-hover:text-slate-200",
                  )}
                />
                <span className="flex flex-col">
                  {item.label}
                  <span
                    className={cn(
                      "text-[10px] font-normal",
                      isActive ? "text-emerald-100" : "text-slate-500",
                    )}
                  >
                    {item.hint}
                  </span>
                </span>
              </Link>
            )
          })}

          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 mt-8 px-2">
            Services
          </div>
          {services.map((s) => (
            <a
              key={s.href}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-start gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium hover:bg-slate-800 hover:text-white group"
            >
              <ExternalLink className="w-4 h-4 mt-0.5 shrink-0 text-slate-500 group-hover:text-slate-300" />
              <span className="flex flex-col">
                {s.label}
                <span className="text-[10px] font-normal text-slate-500">{s.hint}</span>
              </span>
            </a>
          ))}
        </div>

        <div className="p-4 border-t border-slate-800 shrink-0">
          <div className="flex items-center gap-3 px-2 py-2 rounded-md">
            <div className="w-8 h-8 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center shrink-0">
              <Building2 className="w-4 h-4 text-slate-300" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold text-white truncate">
                Saraswati–Deccan Group
              </span>
              {/* Says what it is. There is no login yet, and a fake user name
                  in the corner would imply otherwise. */}
              <span className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
                Owner · no auth yet
              </span>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-auto bg-slate-50">
          <div className="p-8 max-w-[1600px] mx-auto">{children}</div>
        </div>
      </main>
    </div>
  )
}
