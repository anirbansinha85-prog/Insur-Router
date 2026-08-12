import { Link, useLocation } from "wouter"
import {
  Users, ListChecks, Wrench, LayoutDashboard, ShieldCheck, Bell,
  ExternalLink, LogOut, IdCard, Boxes, Send, Wallet, Bike, ListTodo, SlidersHorizontal,
  ReceiptText, Sparkles, Gauge, Radio,
} from "lucide-react"
import type { SessionUser } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"
import { financialYear, useShowroom } from "@/lib/showroom"
import { NativeSelect } from "@/components/ui/select"
import { EntitySearch } from "@/pages/Dossier"

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
  items: Array<{ href: string; label: string; icon: typeof Users; module?: string }>
}

const GROUPS: NavGroup[] = [
  {
    // Its own group and first, because it is not one more list of records —
    // it is the answer to what to do next, assembled from all of them.
    label: "Today",
    items: [
      { href: "/overview", label: "Overall view", icon: Gauge },
      { href: "/", label: "My queue", icon: ListTodo },
    ],
  },
  {
    label: "Showroom",
    items: [
      { href: "/enquiries", label: "Enquiries", icon: Users, module: "ENQUIRY" },
      { href: "/worklist", label: "Deals", icon: ListChecks, module: "DEAL" },
      // Under Showroom rather than a compliance group of its own: the file is
      // opened by the sale and closed by handing a card to the same customer,
      // and separating it is part of how it stops being anybody's job.
      { href: "/registrations", label: "Registration & RC", icon: IdCard, module: "REGISTRATION" },
      // The floor sits under Showroom rather than beside spares: a bike
      // standing unsold is a sales problem, and the finding on that screen is
      // an enquiry nobody connected to it.
      { href: "/inventory", label: "Vehicle stock", icon: Bike, module: "VEHICLE" },
    ],
  },
  {
    label: "Insurance",
    items: [{ href: "/worklist", label: "Issuance queue", icon: ShieldCheck, module: "DEAL" }],
  },
  {
    label: "After sales",
    items: [
      { href: "/service", label: "Service & warranty", icon: Wrench, module: "JOB_CARD" },
      // Under After sales rather than beside stock reports: a part matters here
      // because somebody's vehicle is waiting for it, and the two screens read
      // the same job cards from opposite ends.
      { href: "/spares", label: "Spares", icon: Boxes, module: "PART" },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/receivables", label: "Receivables", icon: Wallet, module: "RECEIVABLE" },
      // Gated on DEAL, which is what an invoice is about. A technician reading
      // job cards has no business seeing what a customer paid.
      { href: "/invoices", label: "Invoicing", icon: ReceiptText, module: "DEAL" },
    ],
  },
  {
    // Its own group, and last. Everything above reads the dealership's data
    // back to them; this is the one place the product proposes to say something
    // on their behalf, and that difference is worth a heading rather than a row
    // tucked under After sales.
    label: "Outbound",
    items: [
      { href: "/outbox", label: "Outbox", icon: Send, module: "OUTBOX" },
      { href: "/channels", label: "How it speaks", icon: Radio },
    ],
  },
  {
    // No module gate: the numbers explain every other screen, so everybody may
    // read them. Whether they may be *changed* is the row policies' answer.
    label: "The dealership",
    items: [
      { href: "/numbers", label: "Your numbers", icon: SlidersHorizontal },
      // Beside the numbers rather than under Outbound, and deliberately. This
      // is not the product speaking for the dealership — it is the dealership
      // reading what the product has picked up from watching them, and the
      // thresholds that decide it live on the screen next door.
      { href: "/learned", label: "What it has learned", icon: Sparkles },
    ],
  },
]

interface ShellProps {
  children: React.ReactNode
  user: SessionUser
  onSignOut: () => void
}

export function Shell({ children, user, onSignOut }: ShellProps) {
  const [location] = useLocation()
  const { showrooms, selected, setShowroomId, isLoading } = useShowroom()

  const owner = selected?.ownerName ?? "—"

  /**
   * Only what this role may read.
   *
   * The server sends the list rather than the console deriving it, so the
   * sidebar and the row policies cannot disagree — and an empty group vanishes
   * rather than leaving a heading over nothing.
   *
   * This is cosmetic, and deliberately so: it is the database that refuses, and
   * an advisor who typed /receivables into the address bar would still get
   * nothing. Hiding a menu item is a courtesy, not a control.
   */
  const allowed = new Set(user.modules ?? [])
  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.module || allowed.size === 0 || allowed.has(i.module)),
  })).filter((g) => g.items.length > 0)

  return (
    /* `print:block` and `print:h-auto` because a flex row of fixed height is a
       one-page printer: the browser prints the viewport rather than the
       document, and an invoice with a long address quietly loses its footer. */
    <div className="flex h-screen w-full bg-slate-100 text-slate-900 font-sans print:block print:h-auto print:bg-white">
      <aside className="w-60 bg-[#111a2b] text-slate-300 flex flex-col shrink-0 print:hidden">
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
          {visibleGroups.map((group) => (
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

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden print:overflow-visible print:block">
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between gap-4 shrink-0 print:hidden">
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
            {/* Owner-scoped, so it reaches across outlets rather than searching
                whichever one the picker happens to be showing. */}
            <EntitySearch />
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
            <div className="flex items-center gap-2 pl-3 border-l border-slate-200">
              <div className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                <span className="text-[10px] font-bold text-emerald-700">
                  {user.name
                    .split(" ")
                    .map((p) => p[0])
                    .slice(0, 2)
                    .join("")}
                </span>
              </div>
              <div className="leading-tight">
                <div className="text-xs font-semibold text-slate-800">{user.name}</div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                  {user.role.replace(/_/g, " ").toLowerCase()}
                  {user.empCode ? ` · ${user.empCode}` : ""}
                </div>
              </div>
              <button
                onClick={onSignOut}
                title="Sign out"
                className="ml-1 text-slate-400 hover:text-slate-700 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
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
