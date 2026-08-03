import { Link, useLocation } from "wouter"
import {
  Users, ListChecks, Wrench, LayoutDashboard, ShieldCheck, Bell,
  ExternalLink, Building2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { financialYear, useShowroom } from "@/lib/showroom"
import { NativeSelect } from "@/components/ui/select"

/**
 * DDMS's shell, in the shape of a dealer portal rather than an admin console.
 *
 * The reference is the dealer portal the mock serves at :9090/portal — grouped
 * sidebar, identity header, dense content. That is the interface Anirban had in
 * mind all along, and the thin slate console built before this was the wrong
 * class of product: a dealership manager lives in a portal all day, and a
 * portal has to look like somewhere you work rather than somewhere you look.
 *
 * What is deliberately *not* copied is the OEM's identity. That portal is Hero
 * red and belongs to the manufacturer. This is the owner's own product, across
 * showrooms and irrespective of OEM, so it carries its own mark.
 */

interface NavGroup {
  label: string
  items: Array<{ href: string; label: string; icon: typeof Users }>
}

const GROUPS: NavGroup[] = [
  {
    label: "Showroom",
    items: [
      { href: "/", label: "Enquiries", icon: Users },
      { href: "/worklist", label: "Deals", icon: ListChecks },
    ],
  },
  {
    label: "Insurance",
    items: [{ href: "/worklist", label: "Issuance queue", icon: ShieldCheck }],
  },
  {
    label: "After sales",
    items: [{ href: "/service", label: "Service & warranty", icon: Wrench }],
  },
]

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()
  const { showrooms, selected, setShowroomId, isLoading } = useShowroom()

  const owner = selected?.ownerName ?? "—"

  return (
    <div className="flex h-screen w-full bg-slate-100 text-slate-900 font-sans">
      <aside className="w-60 bg-[#111a2b] text-slate-300 flex flex-col shrink-0">
        <div className="px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-emerald-500 flex items-center justify-center shrink-0">
              <LayoutDashboard className="w-4 h-4 text-white" />
            </div>
            <div className="min-w-0">
              <div className="text-white font-bold leading-tight truncate">{owner}</div>
              <div className="text-[10px] text-slate-400 leading-tight">
                Dealer Decision Management
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 py-4 overflow-y-auto">
          {GROUPS.map((group) => (
            <div key={group.label} className="mb-5">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-5 mb-2">
                {group.label}
              </div>
              {group.items.map((item) => {
                const isActive =
                  location === item.href || (item.href !== "/" && location.startsWith(item.href))
                return (
                  <Link
                    key={`${group.label}-${item.href}-${item.label}`}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-5 py-2 text-sm font-medium transition-colors border-l-2",
                      isActive
                        ? "bg-emerald-600/15 text-white border-emerald-500"
                        : "border-transparent hover:bg-white/5 hover:text-white",
                    )}
                  >
                    <item.icon
                      className={cn("w-4 h-4 shrink-0", isActive ? "text-emerald-400" : "text-slate-500")}
                    />
                    {item.label}
                  </Link>
                )
              })}
            </div>
          ))}

          <div className="mb-2">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-5 mb-2">
              Services
            </div>
            {/* Separate products, reachable from here, not embedded. */}
            {[
              { href: "http://localhost:24791/", label: "InsurRouter" },
              { href: "http://localhost:18815/doc-ingest/", label: "VeloDocs" },
            ].map((s) => (
              <a
                key={s.href}
                href={s.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 px-5 py-2 text-sm font-medium border-l-2 border-transparent hover:bg-white/5 hover:text-white transition-colors"
              >
                <ExternalLink className="w-4 h-4 shrink-0 text-slate-500" />
                {s.label}
              </a>
            ))}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-white/10 text-[10px] text-slate-500 leading-relaxed">
          Reads the dealer's DMS. Never writes to it.
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-900 truncate">
              {selected?.name ?? "No showroom"}
            </h2>
            <div className="text-xs text-slate-500 truncate">
              {selected?.dmsAccounts.map((a) => a.dealerCode).join(", ") || "no dealer code"}
              {selected?.city && ` · ${selected.city}`}
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            {!isLoading && showrooms.length > 0 && (
              <NativeSelect
                className="w-56 h-9 text-sm"
                value={selected ? String(selected.id) : ""}
                onChange={(e) => setShowroomId(Number(e.target.value))}
              >
                {showrooms.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}
                    {!s.isActive && " (inactive)"}
                    {s.dmsAccounts.length === 0 && " — no DMS"}
                  </option>
                ))}
              </NativeSelect>
            )}
            <span className="text-xs font-semibold text-slate-500 tabular-nums">
              {financialYear()}
            </span>
            <button className="text-slate-400 hover:text-slate-600 transition-colors">
              <Bell className="w-4 h-4" />
            </button>
            {/* No invented user. There is no login yet and pretending otherwise
                is the same defect as a simulated policy that looks issued. */}
            <div className="flex items-center gap-2 pl-3 border-l border-slate-200">
              <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center">
                <Building2 className="w-3.5 h-3.5 text-slate-500" />
              </div>
              <div className="leading-tight">
                <div className="text-xs font-semibold text-slate-800">Owner</div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                  no auth yet
                </div>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="p-6 max-w-[1700px] mx-auto">{children}</div>
        </div>
      </main>
    </div>
  )
}
