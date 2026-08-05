/**
 * DDMS — the parts counter, read across the group.
 *
 * The other four screens each show something one outlet could in principle have
 * noticed and did not. This one shows something an outlet **cannot** notice,
 * however carefully it looks: the part a customer has been waiting three days
 * for is on a shelf four hundred kilometres away, in a branch the same person
 * owns, and neither branch's system has any way to say so.
 *
 * That is the entire argument for an owner-level product, on one screen. So the
 * leading number is not a stock count — it is the number of customers waiting
 * for something the company already has.
 */

import { useMemo, useState } from "react"
import {
  getGetSparesWorklistQueryKey,
  useGetSparesWorklist,
  type SparesState,
  type SparesWorklistRow,
} from "@workspace/api-client-react"
import { useShowroom } from "@/lib/showroom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { ActionButton } from "@/lib/actions"
import { ExplainButton } from "@/lib/explain"
import { ArrowLeftRight, Boxes, PackageX, Wallet } from "lucide-react"
import { FindBox, rowText, useFind } from "@/lib/find"

const STATE: Record<
  SparesState,
  { label: string; variant: "success" | "warning" | "destructive" | "info" | "draft"; blurb: string }
> = {
  AVAILABLE_ELSEWHERE: { label: "In the other branch", variant: "destructive", blurb: "Somebody is waiting for a part the company owns" },
  STOCKOUT_BLOCKING: { label: "Nobody has it", variant: "destructive", blurb: "A genuine stockout, with a customer waiting" },
  ORDER_OVERDUE: { label: "Order overdue", variant: "warning", blurb: "Ordered, past its promised date, not chased" },
  FULLY_RESERVED: { label: "All reserved", variant: "warning", blurb: "The shelf shows stock the counter cannot issue" },
  BELOW_REORDER: { label: "Below reorder", variant: "info", blurb: "Under the reorder level with nothing on order" },
  DEAD_STOCK: { label: "Not moving", variant: "info", blurb: "Capital on a shelf" },
  OK: { label: "Fine", variant: "success", blurb: "Nothing to do" },
}

const STATE_ORDER: SparesState[] = [
  "AVAILABLE_ELSEWHERE",
  "STOCKOUT_BLOCKING",
  "ORDER_OVERDUE",
  "FULLY_RESERVED",
  "BELOW_REORDER",
  "DEAD_STOCK",
  "OK",
]

function rupees(n: number | null | undefined): string {
  if (!n) return "—"
  return `₹${Math.round(n).toLocaleString("en-IN")}`
}

function StatCard({
  title, value, icon: Icon, colorClass, hint, isLoading,
}: {
  title: string
  value?: string | number
  icon: typeof Boxes
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
          <Skeleton className="h-8 w-16 mt-1" />
        ) : (
          <>
            <div className="text-3xl font-bold text-slate-900 tabular-nums">{value ?? 0}</div>
            {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * On hand, reserved, free — as three numbers rather than one.
 *
 * The counter screen in the dealership shows the first. The difference between
 * the first and the third is how a part gets promised to two customers, so the
 * free figure gets the emphasis and the shelf figure is shown next to it rather
 * than instead of it.
 */
function Quantities({ onHand, reserved, free }: { onHand: number; reserved: number; free: number }) {
  return (
    <div className="text-right">
      <div
        className={`text-sm font-semibold tabular-nums ${
          free <= 0 ? "text-red-600" : "text-slate-900"
        }`}
      >
        {free} free
      </div>
      <div className="text-[11px] text-slate-400 tabular-nums">
        {onHand} on shelf
        {reserved > 0 && <span className="text-amber-600"> · {reserved} promised</span>}
      </div>
    </div>
  )
}

export default function Spares() {
  const [filter, setFilter] = useState<SparesState | "all">("all")
  const { selected } = useShowroom()

  const params = { showroomId: selected?.id ?? 0 }
  const { data, isLoading } = useGetSparesWorklist(params, {
    query: { queryKey: getGetSparesWorklistQueryKey(params), enabled: Boolean(selected) },
  })

  const rows: SparesWorklistRow[] = data?.rows ?? []
  const summary = data?.summary

  const visible = useMemo(() => {
    const filtered = filter === "all" ? rows : rows.filter((r) => r.state === filter)
    return [...filtered].sort((a, b) => {
      const byState = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
      if (byState !== 0) return byState
      // Within a state, whoever has been waiting longest.
      const aw = a.waitingJobCards?.reduce((m, w) => Math.max(m, w.daysWaiting), 0) ?? 0
      const bw = b.waitingJobCards?.reduce((m, w) => Math.max(m, w.daysWaiting), 0) ?? 0
      return bw - aw
    })
  }, [rows, filter])

  // Searched *after* the state filter rather than instead of it: the chips
  // narrow to a kind of problem and the box finds one record, and somebody who
  // has picked a chip and then typed a name means both.
  const { query, setQuery, found } = useFind(visible, rowText)

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Spares</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          This counter&rsquo;s shelf, checked against every other outlet you own.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Waiting, and we own it"
          value={summary?.availableElsewhere}
          icon={ArrowLeftRight}
          colorClass="text-red-500"
          hint="On a shelf in another branch"
          isLoading={isLoading}
        />
        <StatCard
          title="Nobody has it"
          value={summary?.stockoutBlocking}
          icon={PackageX}
          colorClass="text-red-500"
          hint="Genuine stockout, customer waiting"
          isLoading={isLoading}
        />
        <StatCard
          title="Below reorder"
          value={summary?.belowReorder}
          icon={Boxes}
          colorClass="text-amber-500"
          hint="Nothing on order"
          isLoading={isLoading}
        />
        <StatCard
          title="Not moving"
          value={summary ? rupees(summary.idleCapital) : undefined}
          icon={Wallet}
          colorClass="text-slate-400"
          hint="Cost of stock that has not been issued"
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
            const count = summary?.byState[state] ?? 0
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
        <FindBox query={query} setQuery={setQuery} found={found.length} total={visible.length} />

        <div className="text-xs text-slate-400">
          {summary?.lastSyncedAt
            ? `Mirror last updated ${formatDate(summary.lastSyncedAt)}`
            : "Never synced"}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[26%]">Part</TableHead>
              <TableHead className="w-24 text-right">This branch</TableHead>
              <TableHead className="w-[18%]">Elsewhere in the group</TableHead>
              <TableHead className="w-[14%]">State</TableHead>
              <TableHead>What to do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-9 w-44" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-56" /></TableCell>
                </TableRow>
              ))
            ) : found.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <Boxes className="w-8 h-8 text-slate-300" />
                    <span>
                      {rows.length === 0
                        ? "No parts mirrored yet. Run a sync from the Deals screen."
                        : "Nothing in this state."}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              found.map((row) => {
                const tone = STATE[row.state]
                const waiting = row.waitingJobCards ?? []
                const elsewhere = row.availableAt ?? []
                const short = row.shortAt ?? []

                return (
                  <TableRow key={`${row.showroomId}:${row.partNo}`}>
                    <TableCell className="align-top">
                      <div className="font-mono text-[11px] text-slate-500">{row.partNo}</div>
                      <div className="font-semibold text-slate-900 text-sm mt-0.5">
                        {row.partDesc ?? "—"}
                      </div>
                      <div className="text-xs text-slate-400">
                        {row.binLocation ? `bin ${row.binLocation}` : "no bin recorded"}
                        {row.dms.onOrderQty > 0 && (
                          <span className="text-slate-500"> · {row.dms.onOrderQty} on order</span>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="align-top bg-slate-50/60">
                      <Quantities
                        onHand={row.dms.qtyOnHand}
                        reserved={row.dms.qtyReserved}
                        free={row.dms.qtyFree}
                      />
                    </TableCell>

                    {/* The column that does not exist in either branch's
                        system, and it reads both ways: somewhere to pull from,
                        and somewhere that is about to buy what is dead here. */}
                    <TableCell className="align-top">
                      {elsewhere.length === 0 && short.length === 0 ? (
                        <span className="text-xs text-slate-300">none</span>
                      ) : (
                        <>
                          {elsewhere.map((e) => (
                            <div key={`have-${e.showroomId}`} className="text-xs">
                              <span className="font-semibold text-slate-900 tabular-nums">
                                {e.qtyFree}
                              </span>{" "}
                              <span className="text-slate-600">{e.showroomCode ?? `#${e.showroomId}`}</span>
                              {e.binLocation && (
                                <span className="text-slate-400 font-mono ml-1">{e.binLocation}</span>
                              )}
                            </div>
                          ))}
                          {short.map((e) => (
                            <div key={`short-${e.showroomId}`} className="text-xs text-amber-600">
                              {e.showroomCode ?? `#${e.showroomId}`} short ({e.qtyFree}/{e.reorderLevel})
                            </div>
                          ))}
                        </>
                      )}
                    </TableCell>

                    <TableCell className="align-top">
                      <Badge variant={tone.variant}>{tone.label}</Badge>

                    </TableCell>

                    <TableCell className="align-top">
                      {row.actionRequired ? (
                        <div className="flex items-start gap-2">
                          <ArrowLeftRight
                            className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                              row.state === "AVAILABLE_ELSEWHERE" || row.state === "STOCKOUT_BLOCKING"
                                ? "text-red-500"
                                : "text-amber-500"
                            }`}
                          />
                          <div>
                            <div className="text-sm text-slate-800">{row.actionRequired}</div>
                            {row.note && (
                              <div className="text-[11px] text-slate-400 mt-0.5">{row.note}</div>
                            )}
                            <div className="flex flex-wrap items-center gap-3 mt-1.5">
                              {/* Only offered when there is somewhere to ask. A
                                  transfer button on a part nobody in the group
                                  has would be advice dressed as a control. */}
                              {elsewhere.length > 0 && (
                                <ActionButton
                                  action="PART_REQUEST_TRANSFER"
                                  target={{ showroomId: row.showroomId, recordKey: row.partNo }}
                                  label={`Ask ${elsewhere[0].showroomCode ?? "the other branch"}`}
                                  doneLabel="transfer asked"
                                  done={Boolean(row.ddms.transferRequestedAt)}
                                  extra={{ fromShowroomId: elsewhere[0].showroomId }}
                                />
                              )}
                              {(row.state === "BELOW_REORDER" ||
                                row.state === "FULLY_RESERVED" ||
                                row.state === "STOCKOUT_BLOCKING") && (
                                <ActionButton
                                  action="PART_RAISE_REORDER"
                                  target={{ showroomId: row.showroomId, recordKey: row.partNo }}
                                  label="Mark reorder raised"
                                  doneLabel="order raised"
                                  done={Boolean(row.ddms.reorderRaisedAt)}
                                  tone="slate"
                                />
                              )}
                              <ExplainButton
                                module="PART"
                                showroomId={row.showroomId}
                                recordKey={row.partNo}
                              />
                            </div>

                            {/* Who is actually waiting. A part shortage with no
                                name against it is an inventory statistic. */}
                            {waiting.length > 0 && (
                              <div className="text-[11px] text-slate-500 mt-1 space-y-0.5">
                                {waiting.map((w) => (
                                  <div key={w.jcNo}>
                                    <span className="font-mono text-slate-400">{w.jcNo}</span>{" "}
                                    {w.customerName ?? "—"} ·{" "}
                                    <span className={w.daysWaiting >= 5 ? "text-red-600 font-medium" : ""}>
                                      {w.daysWaiting}d
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">{row.note ?? "Nothing to do"}</span>
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
        A dealer management system keeps the parts ledger against a dealer code,
        because a dealer code is what it thinks a business is. Own three outlets
        and you get three ledgers, none of which can answer the only question the
        counter actually has: does anybody here already have this? Nobody at
        either branch is being careless — neither can see the other&rsquo;s
        shelf. The &ldquo;elsewhere in the group&rdquo; column is the whole
        reason this product is bought by an owner.
      </p>
    </div>
  )
}
