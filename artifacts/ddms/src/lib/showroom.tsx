import { createContext, useContext, useMemo, useState } from "react"
import { useListShowrooms, type ShowroomSummary } from "@workspace/api-client-react"

/**
 * Which showroom the whole console is looking at.
 *
 * Held here rather than per page because it is a *scope*, not a filter. Three
 * screens each owning their own copy meant switching showroom on Enquiries and
 * then opening Workshop silently showed a different outlet — the kind of bug
 * nobody reports because it looks like data.
 */
interface ShowroomContextValue {
  showrooms: ShowroomSummary[]
  selected: ShowroomSummary | null
  setShowroomId: (id: number) => void
  isLoading: boolean
}

const ShowroomContext = createContext<ShowroomContextValue | null>(null)

export function ShowroomProvider({ children }: { children: React.ReactNode }) {
  const [showroomId, setShowroomId] = useState<number | null>(null)
  const { data: showrooms, isLoading } = useListShowrooms()

  const selected = useMemo(() => {
    if (!showrooms?.length) return null
    if (showroomId !== null) return showrooms.find((s) => s.id === showroomId) ?? null
    // Default to one that can actually be synced. Opening on a showroom with no
    // dealer code shows a permanently empty table and reads as broken.
    return showrooms.find((s) => s.isActive && s.dmsAccounts.length > 0) ?? showrooms[0]
  }, [showrooms, showroomId])

  const value = useMemo(
    () => ({ showrooms: showrooms ?? [], selected, setShowroomId, isLoading }),
    [showrooms, selected, isLoading],
  )

  return <ShowroomContext.Provider value={value}>{children}</ShowroomContext.Provider>
}

export function useShowroom(): ShowroomContextValue {
  const ctx = useContext(ShowroomContext)
  if (!ctx) throw new Error("useShowroom must be used inside ShowroomProvider")
  return ctx
}

/**
 * Indian financial year, April to March. Shown in the header because every
 * number a dealership reports — quota, targets, policies placed — is scoped to
 * it, and a figure without its period is not a figure.
 */
export function financialYear(d = new Date()): string {
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `FY ${start}-${String(start + 1).slice(2)}`
}
