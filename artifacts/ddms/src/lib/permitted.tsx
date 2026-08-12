/**
 * Which screens this person may open, and what they see when they may not.
 *
 * Two jobs, and the second one is the point.
 *
 * The row policies in `lib/db/sql/rls.sql` are what actually refuse: a service
 * advisor's connection reads zero rows from the ledger whatever the console
 * does. But a screen that renders zeros is indistinguishable from a dealership
 * with no debts, and the first version of this shipped exactly that — an RTO
 * agent landed on Enquiries, saw four zeroes and the words *"No enquiries
 * mirrored yet"*, and had no way to know the answer was really *"not yours"*.
 *
 * A refusal has to look different from an absence. That is the same rule the
 * product applies to its own data everywhere else: an empty state is a claim,
 * and a wrong claim about somebody's own dealership is worse than a blunt one.
 */

import { Redirect } from "wouter"
import { Lock } from "lucide-react"
import type { SessionUser } from "@workspace/api-client-react"

/** Path → the module the server will gate it on. Kept beside the routes. */
export const ROUTE_MODULE: Record<string, string> = {
  // "/" is the queue and is deliberately absent: it spans every module and
  // scopes itself, so there is no one module to gate it on.
  "/enquiries": "ENQUIRY",
  "/worklist": "DEAL",
  "/registrations": "REGISTRATION",
  "/service": "JOB_CARD",
  "/spares": "PART",
  "/receivables": "RECEIVABLE",
  "/inventory": "VEHICLE",
  "/outbox": "OUTBOX",
  // The books hang off RECEIVABLE rather than a module of their own: that is
  // what a role needs to see money in this product, and the accounts are where
  // that money ends up. A second answer to one question is how two answers
  // come to disagree.
  "/books": "RECEIVABLE",
  "/invoices": "DEAL",
}

/** Where each module lives, for sending somebody somewhere they can work. */
const MODULE_ROUTE: Array<[string, string]> = [
  ["ENQUIRY", "/enquiries"],
  ["DEAL", "/worklist"],
  ["REGISTRATION", "/registrations"],
  ["JOB_CARD", "/service"],
  ["PART", "/spares"],
  ["RECEIVABLE", "/receivables"],
  ["VEHICLE", "/inventory"],
  ["OUTBOX", "/outbox"],
]

export function mayOpen(user: SessionUser, path: string): boolean {
  const module = ROUTE_MODULE[path]
  if (!module) return true
  const modules = user.modules ?? []
  // An older session with no module list is treated as unrestricted; the server
  // is still the thing that refuses, so this cannot open anything real.
  return modules.length === 0 || modules.includes(module)
}

/**
 * The first screen this person can actually work on.
 *
 * An RTO agent has no business landing on Enquiries. Sending them to a screen
 * they may not read and letting the API 403 behind it is how a product teaches
 * people that it is broken.
 */
export function landingFor(user: SessionUser): string {
  // The queue, since OBJ-15. It spans every module and scopes itself by what
  // this role may read, so it is the one screen that is never the wrong door —
  // and for somebody who works a list rather than browses one, it is the right
  // door. The module walk below is kept as the fallback for a session with no
  // module list at all.
  const modules = user.modules ?? []
  if (modules.length > 0) return "/"
  const first = MODULE_ROUTE.find(([m]) => modules.includes(m) && m !== "OUTBOX")
  return first?.[1] ?? "/"
}

export function Landing({ user }: { user: SessionUser }) {
  return <Redirect to={landingFor(user)} replace />
}

/**
 * Shown in place of a screen this role does not hold.
 *
 * Says which role you have, because the commonest cause of seeing this is
 * somebody being given the wrong one on their first day — and that is a
 * sentence their manager can act on, where "access denied" is not.
 */
export function NotYours({ user, module }: { user: SessionUser; module: string }) {
  const nice = module.replace(/_/g, " ").toLowerCase()
  return (
    <div className="max-w-lg mx-auto py-24 text-center">
      <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center mx-auto">
        <Lock className="w-4 h-4 text-slate-400" />
      </div>
      <h1 className="text-base font-bold text-slate-900 mt-4">This is not yours to see</h1>
      <p className="text-sm text-slate-500 mt-2">
        You are signed in as a{" "}
        <span className="font-medium text-slate-700">
          {user.role.replace(/_/g, " ").toLowerCase()}
        </span>
        , and that role does not cover {nice} records.
      </p>
      <p className="text-xs text-slate-400 mt-3">
        Nothing is hidden from you here that the database would have shown you anyway — it refuses
        this too. If it should be yours, the owner can change your role.
      </p>
    </div>
  )
}
