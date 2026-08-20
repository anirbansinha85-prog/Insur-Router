/**
 * Raising a journal, and the chart it posts into (OBJ-50).
 *
 * ## Why this is a page and not a control on `/books`
 *
 * `/books` has no edit control and will not get one — a set of books whose
 * entries can be changed after the fact is not evidence of anything. This is not
 * an edit: it is a **new voucher**, numbered from the same series, and a mistake
 * in one is corrected the way every other mistake is, by reversing it and
 * posting another. Two different acts, so two different screens.
 *
 * ## What the running total is for
 *
 * The server refuses an unbalanced journal and says by how much. That refusal is
 * the guarantee; this is the courtesy — somebody entering six lines should not
 * have to press a button to find out they are ninety rupees out. **The screen
 * never decides whether it balances**, it only shows the two totals and their
 * difference, and the post button stays live either way: a screen that disabled
 * itself would be a second implementation of a rule that already exists on the
 * server, and the two would drift.
 *
 * ## The branch is a required field, and reads like one
 *
 * A branch is a profit centre. Rent booked with no branch against it appears in
 * the consolidated profit and loss and in none of the five branch columns —
 * which is exactly the comparison an owner opens the P&L to make.
 */

import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListLedgerAccounts,
  useListLedgerParties,
  useListShowrooms,
  usePostJournalVoucher,
  useCreateLedgerAccount,
  useSetLedgerAccountActive,
  useOfferStarterChart,
  type LedgerAccount,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { NativeSelect } from "@/components/ui/select"
import {
  AlertTriangle,
  BookOpen,
  Check,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react"

/**
 * The two control accounts, named here only to prompt for a party.
 *
 * The server warns on a line against either with nobody's name on it, and this
 * shows the picker so the warning is avoidable rather than merely explained. It
 * does **not** refuse — a provision for doubtful debts is a real entry against
 * the control account that belongs to no single customer.
 */
const CONTROL = new Set(["1100", "2100"])

const GROUPS = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const

interface Line {
  accountCode: string
  debit: string
  credit: string
  narration: string
  partyId: string
}

const blank = (): Line => ({ accountCode: "", debit: "", credit: "", narration: "", partyId: "" })

const money = (x: number): string =>
  x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Empty string and a stray minus both read as nothing, never as NaN. */
const num = (s: string): number => {
  const n = Number(s.trim())
  return Number.isFinite(n) ? n : 0
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export default function Journal() {
  const qc = useQueryClient()
  const accounts = useListLedgerAccounts({ query: { queryKey: ["/api/dms/ledger/accounts"] } })
  const parties = useListLedgerParties(undefined, {
    query: { queryKey: ["/api/dms/ledger/parties"] },
  })
  const showrooms = useListShowrooms({ query: { queryKey: ["/api/dms/showrooms"] } })

  const post = usePostJournalVoucher()
  const create = useCreateLedgerAccount()
  const setActive = useSetLedgerAccountActive()
  const starter = useOfferStarterChart()

  const [showroomId, setShowroomId] = useState("")
  const [voucherDate, setVoucherDate] = useState(today)
  const [narration, setNarration] = useState("")
  const [lines, setLines] = useState<Line[]>([blank(), blank()])
  const [posted, setPosted] = useState<{ no: string; warnings: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [newAccount, setNewAccount] = useState<{ code: string; name: string; group: string } | null>(
    null,
  )
  const [chartOpen, setChartOpen] = useState(false)

  const live = useMemo(
    () => (accounts.data?.accounts ?? []).filter((a) => a.isActive !== "N"),
    [accounts.data],
  )
  const byCode = useMemo(() => new Map(live.map((a) => [a.code, a])), [live])

  const totalDebit = lines.reduce((a, l) => a + num(l.debit), 0)
  const totalCredit = lines.reduce((a, l) => a + num(l.credit), 0)
  const difference = Math.round((totalDebit - totalCredit) * 100) / 100

  function setLine(i: number, patch: Partial<Line>): void {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  async function submit(): Promise<void> {
    setError(null)
    setPosted(null)
    try {
      const result = await post.mutateAsync({
        data: {
          showroomId: Number(showroomId),
          voucherDate,
          narration,
          lines: lines
            // A row nobody filled in is not an empty line the server should
            // refuse; it is a row somebody added and did not use.
            .filter((l) => l.accountCode && (num(l.debit) !== 0 || num(l.credit) !== 0))
            .map((l) => ({
              accountCode: l.accountCode,
              ...(num(l.debit) !== 0 ? { debit: num(l.debit) } : {}),
              ...(num(l.credit) !== 0 ? { credit: num(l.credit) } : {}),
              ...(l.narration ? { narration: l.narration } : {}),
              ...(l.partyId ? { partyId: Number(l.partyId) } : {}),
            })),
        },
      })
      setPosted({
        no: result.voucher?.voucherNo ?? "(no number)",
        warnings: result.warnings ?? [],
      })
      setLines([blank(), blank()])
      setNarration("")
      void qc.invalidateQueries({ queryKey: ["/api/dms/ledger/vouchers"] })
    } catch (e) {
      const body = (e as { body?: { error?: string } }).body
      setError(body?.error ?? (e as Error).message ?? "It was refused.")
    }
  }

  if (accounts.isLoading || showrooms.isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Raise a journal</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          The month's rent, a salary run, an accrual, a depreciation charge. Everything else in
          these books repeats what a document already said — this is the one entry that does not.
        </p>
      </div>

      {/* ── the header ─────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-5 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Branch</span>
              <NativeSelect
                value={showroomId}
                onChange={(e) => setShowroomId(e.target.value)}
                className="mt-1 w-full"
              >
                <option value="">Which branch…</option>
                {(showrooms.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
              {/* Said on the screen rather than only in a comment: it is the
                  reason the field is not optional. */}
              <span className="text-[11px] text-slate-400 mt-1 block">
                A branch is a profit centre. An entry with no branch on it lands in the company
                total and in none of the branch columns.
              </span>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-600">Date</span>
              <input
                type="date"
                value={voucherDate}
                onChange={(e) => setVoucherDate(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border border-slate-200 px-2 text-sm"
              />
            </label>

            <label className="block sm:col-span-1">
              <span className="text-xs font-medium text-slate-600">Narration</span>
              <input
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="November rent, Janakpuri"
                className="mt-1 w-full h-9 rounded-md border border-slate-200 px-2 text-sm"
              />
            </label>
          </div>
        </CardContent>
      </Card>

      {/* ── the lines ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between">
          <CardTitle className="text-sm">Lines</CardTitle>
          <button
            onClick={() => setLines((p) => [...p, blank()])}
            className="text-xs text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> another line
          </button>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {lines.map((l, i) => {
            const account = byCode.get(l.accountCode)
            const wantsParty = CONTROL.has(l.accountCode)
            return (
              <div key={i} className="space-y-1">
                <div className="grid gap-2 sm:grid-cols-[1fr_7rem_7rem_1.5rem] items-start">
                  <NativeSelect
                    value={l.accountCode}
                    onChange={(e) => setLine(i, { accountCode: e.target.value })}
                    className="w-full"
                  >
                    <option value="">Account…</option>
                    {GROUPS.map((g) => (
                      <optgroup key={g} label={g.toLowerCase()}>
                        {live
                          .filter((a) => a.group === g)
                          .map((a) => (
                            <option key={a.code} value={a.code}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </NativeSelect>

                  <input
                    inputMode="decimal"
                    value={l.debit}
                    onChange={(e) => setLine(i, { debit: e.target.value, credit: "" })}
                    placeholder="Debit"
                    className="h-9 rounded-md border border-slate-200 px-2 text-sm text-right tabular-nums"
                  />
                  {/* Typing in one column clears the other. The server refuses a
                      line that is both, and this makes that refusal unreachable
                      by accident rather than merely explained afterwards. */}
                  <input
                    inputMode="decimal"
                    value={l.credit}
                    onChange={(e) => setLine(i, { credit: e.target.value, debit: "" })}
                    placeholder="Credit"
                    className="h-9 rounded-md border border-slate-200 px-2 text-sm text-right tabular-nums"
                  />

                  <button
                    onClick={() => setLines((p) => (p.length > 2 ? p.filter((_, j) => j !== i) : p))}
                    title={lines.length > 2 ? "Remove this line" : "A journal needs two lines"}
                    disabled={lines.length <= 2}
                    className="h-9 text-slate-300 hover:text-slate-600 disabled:opacity-30"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {wantsParty && (
                  <div className="pl-1">
                    <NativeSelect
                      value={l.partyId}
                      onChange={(e) => setLine(i, { partyId: e.target.value })}
                      className="w-full sm:w-2/3"
                    >
                      <option value="">Whose {account?.name}? — nobody named</option>
                      {(parties.data?.parties ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.kind.toLowerCase()}
                        </option>
                      ))}
                    </NativeSelect>
                    {!l.partyId && (
                      <p className="text-[11px] text-amber-700 mt-1">
                        Without a name this leaves money on a control account that reconciles to no
                        party ledger. Right for a provision; a mistake otherwise.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* ── the totals, and the screen decides nothing ─────────────────── */}
          <div className="flex items-center justify-end gap-6 pt-2 border-t border-slate-100 text-sm tabular-nums">
            <span className="text-slate-500">
              Debit <span className="font-semibold text-slate-800">₹{money(totalDebit)}</span>
            </span>
            <span className="text-slate-500">
              Credit <span className="font-semibold text-slate-800">₹{money(totalCredit)}</span>
            </span>
            <span className={difference === 0 ? "text-emerald-700" : "text-amber-700 font-semibold"}>
              {difference === 0 ? "balances" : `out by ₹${money(Math.abs(difference))}`}
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void submit()}
          disabled={post.isPending}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-slate-900 text-white text-sm font-semibold disabled:opacity-50"
        >
          {post.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Post the journal
        </button>
        <span className="text-[11px] text-slate-400">
          The server decides whether this is a legal entry, and says why if it is not.
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {posted && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <div className="flex gap-2 items-center font-semibold">
            <Check className="w-4 h-4" /> Posted as voucher {posted.no}
          </div>
          {posted.warnings.map((w, i) => (
            <p key={i} className="text-[12px] text-amber-800 mt-1.5">
              {w}
            </p>
          ))}
        </div>
      )}

      {/* ── the chart, underneath, because it is the rarer job ─────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <button
            onClick={() => setChartOpen((o) => !o)}
            className="flex items-center gap-2 text-sm font-semibold text-slate-800"
          >
            <BookOpen className="w-4 h-4 text-slate-400" />
            The chart of accounts
            <span className="text-xs font-normal text-slate-400">
              {live.length} in use{chartOpen ? "" : " — open"}
            </span>
          </button>
        </CardHeader>
        {chartOpen && (
          <CardContent className="pt-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() =>
                  void starter
                    .mutateAsync()
                    .then(() => qc.invalidateQueries({ queryKey: ["/api/dms/ledger/accounts"] }))
                }
                className="text-xs h-8 px-3 rounded-md border border-slate-200 hover:bg-slate-50"
              >
                Add the standard expense heads
              </button>
              <button
                onClick={() => setNewAccount({ code: "", name: "", group: "EXPENSE" })}
                className="text-xs h-8 px-3 rounded-md border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> an account of your own
              </button>
            </div>

            {newAccount && (
              <div className="rounded-md border border-slate-200 p-3 grid gap-2 sm:grid-cols-[6rem_1fr_9rem_auto]">
                <input
                  value={newAccount.code}
                  onChange={(e) => setNewAccount({ ...newAccount, code: e.target.value })}
                  placeholder="5460"
                  className="h-9 rounded-md border border-slate-200 px-2 text-sm font-mono"
                />
                <input
                  value={newAccount.name}
                  onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
                  placeholder="Workshop consumables"
                  className="h-9 rounded-md border border-slate-200 px-2 text-sm"
                />
                <NativeSelect
                  value={newAccount.group}
                  onChange={(e) => setNewAccount({ ...newAccount, group: e.target.value })}
                >
                  {GROUPS.map((g) => (
                    <option key={g} value={g}>
                      {g.toLowerCase()}
                    </option>
                  ))}
                </NativeSelect>
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      void create
                        .mutateAsync({
                          data: {
                            code: newAccount.code,
                            name: newAccount.name,
                            group: newAccount.group as never,
                          },
                        })
                        .then((r) => {
                          setNewAccount(null)
                          if (r.warnings?.length) setError(r.warnings.join(" "))
                          return qc.invalidateQueries({
                            queryKey: ["/api/dms/ledger/accounts"],
                          })
                        })
                        .catch((e) =>
                          setError(
                            (e as { body?: { error?: string } }).body?.error ?? "It was refused.",
                          ),
                        )
                    }
                    className="h-9 px-3 rounded-md bg-slate-900 text-white text-xs font-semibold"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => setNewAccount(null)}
                    className="h-9 px-2 text-xs text-slate-400 hover:text-slate-700"
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}

            <div className="divide-y divide-slate-100">
              {(accounts.data?.accounts ?? []).map((a: LedgerAccount) => (
                <div key={a.code} className="flex items-center gap-3 py-1.5 text-sm">
                  <span className="font-mono text-xs text-slate-500 w-12">{a.code}</span>
                  <span
                    className={`flex-1 ${a.isActive === "N" ? "text-slate-400 line-through" : "text-slate-800"}`}
                  >
                    {a.name}
                  </span>
                  <span className="text-[11px] text-slate-400 w-20">{a.tallyName}</span>
                  {a.isSystem === "Y" ? (
                    <Badge variant="draft" title="A posting rule names this by code">
                      ours
                    </Badge>
                  ) : (
                    <button
                      title={
                        a.isActive === "N"
                          ? "Bring it back"
                          : "Retire it — nothing is ever deleted, because last year's trial balance names it"
                      }
                      onClick={() =>
                        void setActive
                          .mutateAsync({
                            code: a.code,
                            data: { active: a.isActive === "N" },
                          })
                          .then(() =>
                            qc.invalidateQueries({ queryKey: ["/api/dms/ledger/accounts"] }),
                          )
                          .catch((e) =>
                            setError(
                              (e as { body?: { error?: string } }).body?.error ?? "It was refused.",
                            ),
                          )
                      }
                      className="text-slate-300 hover:text-slate-700"
                    >
                      {a.isActive === "N" ? (
                        <RotateCcw className="w-3.5 h-3.5" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">
              Accounts marked <em>ours</em> are named by a posting rule, so they may be renamed and
              never removed — a rule that cannot find its account has no honest behaviour.
              Everything else is yours. Nothing is ever deleted: an account that has carried a line
              is named on a statement somebody has already filed from.
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
