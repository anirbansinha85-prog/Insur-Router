/**
 * DDMS — the floor, aged, and matched against the people asking for it.
 *
 * Every dealership knows its stock is ageing. What no screen in the building
 * says is the pair of things this one leads with:
 *
 * 1. **What the standing stock is costing.** Cost × floor-plan rate × days.
 *    Nobody disputes the arithmetic; nobody has ever seen it attached to a
 *    specific chassis, so it stays an abstraction in a monthly P&L.
 * 2. **Which of those bikes somebody is already asking for.** The stock screen
 *    cannot see the CRM and the CRM cannot see the floor, so a unit stands for
 *    four months while a quoted customer waits for a call. Both systems are
 *    working correctly. The customer buys elsewhere.
 *
 * The second is the leading number, because it is the one with a name attached
 * and the one a salesperson can act on before lunch. Discounting aged stock is
 * a decision; ringing somebody who already asked for it is not.
 */

import { useMemo, useState } from "react"
import {
  getGetInventoryWorklistQueryKey,
  useGetInventoryWorklist,
  type InventoryState,
  type InventoryWorklistRow,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { ActionButton } from "@/lib/actions"
import { ExplainButton } from "@/lib/explain"
import { Banknote, Bike, PhoneCall, TrendingDown, Warehouse } from "lucide-react"

const STATE: Record<
  InventoryState,
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft"; blurb: string }
> = {
  WANTED_NOW: { label: "Somebody wants it", variant: "destructive", blurb: "Standing, and an open enquiry asks for this model" },
  STUCK_ALLOCATION: { label: "Stuck allocation", variant: "destructive", blurb: "Held for a deal that never closed" },
  AGEING_SEVERE: { label: "Ageing badly", variant: "warning", blurb: "Long on the floor and nobody asking" },
  AGEING: { label: "Ageing", variant: "info", blurb: "Past two months" },
  OFFERED: { label: "Offered", variant: "info", blurb: "Already put to a customer" },
  FRESH: { label: "Fresh", variant: "success", blurb: "Recently arrived" },
  SOLD: { label: "Invoiced", variant: "draft", blurb: "Gone" },
}

const STATE_ORDER: InventoryState[] = [
  "WANTED_NOW",
  "STUCK_ALLOCATION",
  "AGEING_SEVERE",
  "AGEING",
  "OFFERED",
  "FRESH",
  "SOLD",
]

function rupees(n: number | null | undefined): string {
  if (!n) return "—"
  return `₹${Math.round(n).toLocaleString("en-IN")}`
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d)
}

function StatCard({
  title, value, icon: Icon, colorClass, hint, isLoading,
}: {
  title: string
  value?: string | number
  icon: typeof Bike
  colorClass: string
  hint?: string
  isLoading: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-semibold text-slate-500">{title}</CardTitle>
        <Icon className={`w-4 h-4 ${colorClass}`} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24 mt-1" />
        ) : (
          <>
            <div className="text-3xl font-bold text-slate-900 tabular-nums">{value ?? "—"}</div>
            {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Days on the floor, with what they have cost underneath.
 *
 * The two together are the whole argument. Days alone is a statistic; days with
 * a rupee figure is a decision about whether to discount.
 */
function Standing({ days, accrued }: { days: number; accrued: number | null }) {
  const tone = days >= 90 ? "text-red-600" : days >= 60 ? "text-amber-600" : "text-slate-700"
  return (
    <div className="text-right">
      <div className={`text-sm font-semibold tabular-nums ${tone}`}>{days}d</div>
      {accrued ? (
        <div className="text-[11px] text-slate-400 tabular-nums">{rupees(accrued)} interest</div>
      ) : null}
    </div>
  )
}

export default function Inventory() {
  const [filter, setFilter] = useState<InventoryState | "all">("all")
  const { selected } = useShowroom()

  const params = { showroomId: selected?.id ?? 0 }
  const { data, isLoading } = useGetInventoryWorklist(params, {
    query: { queryKey: getGetInventoryWorklistQueryKey(params), enabled: Boolean(selected) },
  })

  const rows: InventoryWorklistRow[] = data?.rows ?? []
  const summary = data?.summary

  const visible = useMemo(() => {
    const filtered = filter === "all" ? rows : rows.filter((r) => r.state === filter)
    return [...filtered].sort((a, b) => {
      const byState = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
      return byState !== 0 ? byState : b.ageDays - a.ageDays
    })
  }, [rows, filter])

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Vehicle stock</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          What is standing on the floor, what it is costing, and who has already asked for it.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Standing, and wanted"
          value={summary?.wanted}
          icon={PhoneCall}
          colorClass="text-red-500"
          hint="Aged units an open enquiry is asking for"
          isLoading={isLoading}
        />
        <StatCard
          title="Interest so far"
          value={rupees(summary?.interestAccrued)}
          icon={TrendingDown}
          colorClass="text-amber-500"
          hint={
            summary ? `${rupees(summary.interestPerDay)} a day while it stands` : undefined
          }
          isLoading={isLoading}
        />
        <StatCard
          title="Capital on the floor"
          value={rupees(summary?.capitalTiedUp)}
          icon={Banknote}
          colorClass="text-slate-400"
          hint="Cost of every unit not yet invoiced"
          isLoading={isLoading}
        />
        <StatCard
          title="Oldest"
          value={summary ? `${summary.oldestDays}d` : undefined}
          icon={Warehouse}
          colorClass="text-slate-400"
          hint="Longest on the floor"
          isLoading={isLoading}
        />
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFilter("all")}
            className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
              filter === "all"
                ? "bg-slate-900 text-white"
                : "bg-white border border-slate-200 text-slate-600 hover:border-slate-300"
            }`}
          >
            All {rows.length > 0 && `(${rows.length})`}
          </button>
          {STATE_ORDER.map((state) => {
            const count = summary?.byState?.[state] ?? 0
            return (
              <button
                key={state}
                onClick={() => setFilter(state)}
                disabled={count === 0}
                title={STATE[state].blurb}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  filter === state
                    ? "bg-slate-900 text-white"
                    : "bg-white border border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                {STATE[state].label} ({count})
              </button>
            )
          })}
        </div>
        <div className="text-xs text-slate-400">
          {summary?.lastSyncedAt ? `Mirror last updated ${formatDate(summary.lastSyncedAt)}` : "Never synced"}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[28%]">Vehicle</TableHead>
              <TableHead className="w-[10%] text-right">Standing</TableHead>
              <TableHead className="w-[14%]">State</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-9" />
                  </TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-12 text-center text-sm text-slate-400">
                  Nothing on the floor here.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => (
                <TableRow key={row.chassisNo}>
                  <TableCell className="align-top">
                    <div className="text-sm font-medium text-slate-800">
                      {row.modelDescription ?? row.modelCode}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {row.variantDescription} · {row.colourDescription}
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono">{row.chassisNo}</div>
                    <div className="text-[11px] text-slate-400">
                      in {shortDate(row.dms.receivedDate)} · {rupees(row.dms.costAmount)}
                      {row.dms.isFinanced && row.dms.interestRatePct
                        ? ` · financed at ${row.dms.interestRatePct}%`
                        : " · not financed"}
                    </div>
                  </TableCell>

                  <TableCell className="align-top text-right">
                    <Standing days={row.ageDays} accrued={row.interestAccrued ?? null} />
                  </TableCell>

                  <TableCell className="align-top">
                    <Badge variant={STATE[row.state].variant}>{STATE[row.state].label}</Badge>
                  </TableCell>

                  <TableCell className="align-top">
                    {row.actionRequired ? (
                      <div className="text-sm text-slate-800">{row.actionRequired}</div>
                    ) : (
                      <span className="text-xs text-slate-400">{row.note ?? "Nothing to do"}</span>
                    )}
                    {row.actionRequired && row.note && (
                      <div className="text-[11px] text-slate-400 mt-0.5">{row.note}</div>
                    )}

                    {/* The join the dealer's own systems cannot make. Named
                        people, because "2 matching enquiries" is a statistic
                        and "Mrs Shalini Kapoor, quoted" is a phone call. */}
                    {row.matchingEnquiries.length > 0 && row.state !== "SOLD" && (
                      <div className="text-[11px] text-slate-500 mt-1 space-y-0.5">
                        {row.matchingEnquiries.map((m) => (
                          <div key={m.enqId}>
                            <span className="font-mono text-slate-400">{m.enqId}</span>{" "}
                            {m.customerName ?? "—"} ·{" "}
                            <span className="text-slate-400">{m.stage.replace(/_/g, " ").toLowerCase()}</span>
                            {m.otherOutlet && (
                              <span className="text-amber-600"> · at {m.showroomCode}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3 mt-1.5">
                      {row.state === "WANTED_NOW" && row.matchingEnquiries[0] && (
                        <ActionButton
                          action="VEHICLE_MARK_OFFERED"
                          target={{ showroomId: row.showroomId, recordKey: row.chassisNo }}
                          label="Mark offered"
                          doneLabel="offered"
                          done={Boolean(row.ddms.offeredToEnqId)}
                          extra={{ enqId: row.matchingEnquiries[0].enqId }}
                        />
                      )}
                      {/* Only where somebody at another outlet wants it. A
                          transfer button on a unit nobody has asked for is
                          advice dressed as a control. */}
                      {row.matchingEnquiries.some((m) => m.otherOutlet) && row.state !== "SOLD" && (
                        <ActionButton
                          action="VEHICLE_PROPOSE_TRANSFER"
                          target={{ showroomId: row.showroomId, recordKey: row.chassisNo }}
                          label={`Propose transfer to ${row.matchingEnquiries.find((m) => m.otherOutlet)?.showroomCode}`}
                          doneLabel="transfer proposed"
                          done={Boolean(row.ddms.transferProposedAt)}
                          tone="slate"
                          extra={{
                            toShowroomId: row.matchingEnquiries.find((m) => m.otherOutlet)?.showroomId,
                          }}
                        />
                      )}
                      <ExplainButton
                        module="VEHICLE"
                        showroomId={row.showroomId}
                        recordKey={row.chassisNo}
                      />
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
