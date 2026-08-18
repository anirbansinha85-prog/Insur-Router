import { ExternalLink } from "lucide-react"

/**
 * Open one record's case, in a new tab.
 *
 * ## Why a plain anchor and not wouter's `Link`
 *
 * `target="_blank"` on a client-side router is a link that mostly works and
 * occasionally swallows the click, which is the worst kind of control on a
 * screen somebody is working through quickly. A real href with the base path in
 * front of it opens a real second tab, every time, and middle-click and
 * ⌘-click behave the way the browser promises rather than the way a router
 * remembered to.
 *
 * ## Why a new tab at all
 *
 * The queue's order is deliberately frozen while it is being worked — acting on
 * an item removes it from the server's answer, so refetching would shift
 * everything below up and move the next row out from under whoever is reading
 * it. Opening the case in the same tab and coming back would rebuild the list.
 * A second tab leaves the first exactly as it was, which is what the freezing
 * was for.
 *
 * And a manager working a handover has six of these open at once, compares
 * them, and pastes one into a message when they hand it back to somebody. None
 * of that is possible from a panel.
 */
export function OpenCase({
  module,
  recordKey,
  label = "Open the case",
  className = "",
}: {
  module: string
  recordKey: string
  label?: string
  className?: string
}) {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "")
  const href = `${base}/case/${encodeURIComponent(module)}/${encodeURIComponent(recordKey)}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Everything that has happened to this record — opens in a new tab"
      className={`inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-700 ${className}`}
    >
      {label} <ExternalLink className="w-3 h-3" />
    </a>
  )
}
