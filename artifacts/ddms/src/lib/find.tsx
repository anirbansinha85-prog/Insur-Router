import { useMemo, useState } from "react"
import { Search, X } from "lucide-react"

/**
 * Finding one record in a list that is now long enough to need it.
 *
 * Every worklist screen already filters by state, and a chip row is the right
 * control for *show me everything that is stuck the same way*. It is the wrong
 * control for the question somebody actually walks up with — **"the customer
 * is on the phone, what is happening with Mr Pillai's bike"** — and until
 * OBJ-6 deepened the dealership that gap was invisible, because nine enquiries
 * fit on one screen and you could read them.
 *
 * At a hundred and forty-one it is the difference between a working screen and
 * a screen people give up on, and finding that out is exactly what generating
 * a real month of trading was for.
 *
 * ## Why it filters in the browser rather than on the server
 *
 * The row is already there. Every one of these screens loads its whole
 * worklist in one request — a dealership's open records are hundreds, not
 * millions — so a server round trip per keystroke would add latency to answer
 * a question the client can already answer instantly. When a screen outgrows
 * that, the query moves; it has not, and building for the volume this product
 * does not have would be the more expensive mistake.
 *
 * ## What it matches, and what it deliberately does not
 *
 * Everything on the row, by default — name, mobile, chassis, job card number,
 * registration, the classifier's own note. Whatever a screen shows, somebody
 * can type. Substring, case-insensitive, **no fuzzy matching and no ranking**:
 * somebody typing `9873` wants every number containing it, and a clever matcher
 * that decided which of those they meant would be the one thing worse than no
 * search at all on a screen whose whole job is to be trusted.
 */

/**
 * The default haystack: the row, as text.
 *
 * Naming the searchable fields per screen was the first version, and it was
 * wrong in the way that is hardest to notice — a field somebody forgot to list
 * is a field the search silently cannot find, and nothing on screen says so.
 * Serialising the whole row means the answer to *can I search by chassis* is
 * always yes, and stays yes when a column is added.
 */
export function rowText<T>(row: T): string {
  return JSON.stringify(row);
}

export function useFind<T>(rows: T[], haystack: (row: T) => string = rowText) {
  const [query, setQuery] = useState("")

  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    // Split on spaces so "pillai splendor" narrows rather than finding nothing.
    // A person typing two words means both, which is what every search box they
    // have ever used does.
    const terms = q.split(/\s+/)
    return rows.filter((r) => {
      const text = haystack(r).toLowerCase()
      return terms.every((t) => text.includes(t))
    })
  }, [rows, query, haystack])

  return { query, setQuery, found }
}

export function FindBox({
  query,
  setQuery,
  placeholder = "Find a customer, number or record…",
  found,
  total,
}: {
  query: string
  setQuery: (v: string) => void
  placeholder?: string
  /** How many the search left, so a search that finds nothing says so. */
  found: number
  total: number
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="h-8 w-72 rounded-md border border-slate-200 bg-white pl-8 pr-7 text-xs
                     text-slate-800 placeholder:text-slate-400 focus:outline-none
                     focus:ring-2 focus:ring-emerald-500/30"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            title="Clear"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {/* Only while searching. A permanent count would compete with the state
          chips, which are the primary way these screens are read. */}
      {query.trim() !== "" && (
        <span className="text-[11px] text-slate-400 tabular-nums whitespace-nowrap">
          {found === 0 ? `nothing matches in ${total}` : `${found} of ${total}`}
        </span>
      )}
    </div>
  )
}
