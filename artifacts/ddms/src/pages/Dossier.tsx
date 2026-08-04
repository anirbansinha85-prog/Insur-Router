/**
 * DDMS — everything about one person, vehicle or member of staff.
 *
 * Every other screen reads one module. This one reads across all of them, which
 * is the only view in the product that the dealer's own system cannot produce
 * at all — a DMS keys everything by module and by dealer code, so the same
 * customer is a sales record, a different workshop record, and a name somebody
 * typed into the CRM.
 *
 * What that buys is the sentence nobody in the dealership can currently say:
 * *"she is waiting on a part we have in Pune, and her registration certificate
 * has been in the drawer for three weeks."*
 *
 * The state on each row comes from the module's own builder, so this page can
 * never disagree with the screen the row came from. It reads them; it does not
 * re-derive them.
 */

import { useState } from "react"
import { Link, useRoute } from "wouter"
import {
  getGetEntityDossierQueryKey,
  getSearchEntitiesQueryKey,
  useGetEntityDossier,
  useSearchEntities,
  type DossierRecord,
  type EntityModule,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertTriangle, Bike, Building2, Search, User, Users } from "lucide-react"

const MODULE: Record<EntityModule, { label: string; icon: typeof User }> = {
  DEAL: { label: "Deal", icon: Building2 },
  JOB_CARD: { label: "Job card", icon: Bike },
  ENQUIRY: { label: "Enquiry", icon: Users },
  REGISTRATION: { label: "Registration", icon: Building2 },
}

/** States that mean "nothing outstanding", across every module's vocabulary. */
const SETTLED = new Set(["IN_SYNC", "ON_TRACK", "CLOSED", "CONVERTED", "OK"])

function stateVariant(state: string): "success" | "warning" | "destructive" | "draft" {
  if (SETTLED.has(state)) return state === "CLOSED" || state === "CONVERTED" ? "draft" : "success"
  if (
    state === "CONFLICT" ||
    state === "SLA_BREACHED" ||
    state === "OBJECTION" ||
    state === "BLOCKED_NO_INSURANCE" ||
    state === "NO_OWNER" ||
    state === "GONE_FROM_DMS"
  ) {
    return "destructive"
  }
  return "warning"
}

function humanise(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())
}

// ── Search ──────────────────────────────────────────────────────────────────

export function EntitySearch() {
  const [q, setQ] = useState("")
  const enabled = q.trim().length >= 3

  const params = { q: q.trim() }
  const { data, isFetching } = useSearchEntities(params, {
    query: { queryKey: getSearchEntitiesQueryKey(params), enabled },
  })

  const rows = data?.rows ?? []

  return (
    <div className="relative">
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Phone, chassis, reg no or name"
          className="w-64 h-9 pl-8 pr-3 text-sm rounded-md border border-slate-200 bg-white
                     placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
        />
      </div>

      {enabled && (
        <div className="absolute z-20 mt-1 w-96 right-0 bg-white border border-slate-200 rounded-md shadow-lg overflow-hidden">
          {isFetching && rows.length === 0 ? (
            <div className="px-3 py-3 text-xs text-slate-400">Searching…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-xs text-slate-400">
              Nothing matches. Sync first if the mirror is empty.
            </div>
          ) : (
            rows.map((r) => (
              <Link
                key={r.id}
                href={`/who/${r.id}`}
                onClick={() => setQ("")}
                className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 transition-colors"
              >
                <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                  {r.kind === "CUSTOMER" ? (
                    <User className="w-3 h-3 text-slate-500" />
                  ) : r.kind === "VEHICLE" ? (
                    <Bike className="w-3 h-3 text-slate-500" />
                  ) : (
                    <Users className="w-3 h-3 text-slate-500" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 truncate">
                    {r.displayName ?? r.naturalKey}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono truncate">{r.naturalKey}</div>
                </div>
                <div className="text-[11px] text-slate-500 shrink-0 tabular-nums">
                  {r.linkCount} record{r.linkCount === 1 ? "" : "s"}
                </div>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Dossier ─────────────────────────────────────────────────────────────────

function StatCard({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-slate-500">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-slate-900 tabular-nums">{value}</div>
        {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
      </CardContent>
    </Card>
  )
}

export default function Dossier() {
  const [, params] = useRoute("/who/:entityId")
  const entityId = Number(params?.entityId ?? 0)

  const { data, isLoading, isError } = useGetEntityDossier(entityId, {
    query: { queryKey: getGetEntityDossierQueryKey(entityId), enabled: entityId > 0 },
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="py-24 text-center">
        <h1 className="text-xl font-bold text-slate-900">Not found</h1>
        <p className="text-slate-500 text-sm mt-2">No such record for this dealership.</p>
      </div>
    )
  }

  const records: DossierRecord[] = data.records ?? []
  const outstanding = records.filter((r) => r.actionRequired)

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div>
        <div className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">
          {data.entity.kind.toLowerCase()}
        </div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">
          {data.entity.displayName ?? data.entity.naturalKey}
        </h1>
        <p className="text-slate-500 text-sm mt-0.5 font-mono">{data.entity.naturalKey}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Open items" value={records.length} hint="Across every module" />
        <StatCard
          title="Needing action"
          value={data.summary.needsAction}
          hint={data.summary.needsAction > 0 ? "Somebody has to do something" : "Nothing outstanding"}
        />
        <StatCard
          title="Modules"
          value={data.summary.modules.length}
          hint={data.summary.modules.map((m) => MODULE[m].label).join(", ")}
        />
        <StatCard
          title="Outlets"
          value={data.summary.showroomCount}
          hint={
            data.summary.showroomCount > 1
              ? "Appears at more than one — no branch can see this"
              : data.showrooms[0]?.code ?? ""
          }
        />
      </div>

      {/* The sentence nobody in the dealership can currently say, assembled. */}
      {outstanding.length > 1 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="py-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm text-slate-700">
              <span className="font-semibold">
                {outstanding.length} separate things are outstanding
              </span>{" "}
              for this {data.entity.kind.toLowerCase()}
              {data.summary.showroomCount > 1 && ", across two outlets"} — and each one sits on a
              different screen, in a different module, owned by a different person.
            </div>
          </CardContent>
        </Card>
      )}

      {data.identityNote && (
        <p className="text-[11px] text-slate-400 max-w-3xl">{data.identityNote}</p>
      )}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[16%]">Module</TableHead>
              <TableHead className="w-[30%]">Record</TableHead>
              <TableHead className="w-[16%]">State</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-slate-500">
                  Nothing mirrored against this record.
                </TableCell>
              </TableRow>
            ) : (
              records.map((r) => {
                const Icon = MODULE[r.module].icon
                return (
                  <TableRow key={`${r.module}:${r.recordKey}:${r.role}`}>
                    <TableCell className="align-top">
                      <div className="flex items-center gap-2 text-sm text-slate-700">
                        <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        {MODULE[r.module].label}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {r.showroomCode ?? `#${r.showroomId}`}
                        {r.role !== "SUBJECT" && r.role !== "VEHICLE" && (
                          <span className="ml-1">· as {r.role.toLowerCase()}</span>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="align-top">
                      <div className="font-mono text-[11px] text-slate-500">{r.recordKey}</div>
                      <div className="text-sm text-slate-900">{r.title}</div>
                      {r.ageDays !== null && r.ageDays !== undefined && (
                        <div className="text-[11px] text-slate-400">{r.ageDays}d</div>
                      )}
                    </TableCell>

                    <TableCell className="align-top">
                      <Badge variant={stateVariant(r.state)}>{humanise(r.state)}</Badge>
                    </TableCell>

                    <TableCell className="align-top">
                      {r.actionRequired ? (
                        <div>
                          <div className="text-sm text-slate-800">{r.actionRequired}</div>
                          {r.note && (
                            <div className="text-[11px] text-slate-400 mt-0.5">{r.note}</div>
                          )}
                          <Link
                            href={r.href}
                            className="inline-block text-[11px] font-semibold text-blue-600 hover:text-blue-700 mt-1"
                          >
                            Open the {MODULE[r.module].label.toLowerCase()} screen →
                          </Link>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">{r.note ?? "Nothing to do"}</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <p className="text-xs text-slate-400 max-w-3xl">
        A dealer management system keys everything by module and by dealer code,
        so the same customer is a sales record, a separate workshop record and a
        name somebody typed into the CRM. Nothing in it joins them, which is why
        no screen in the dealership can say that one person is waiting on a part
        and has a certificate in a drawer at the same time. This page reads the
        states the other screens derive rather than deriving its own, so the two
        can never disagree.
      </p>
    </div>
  )
}
