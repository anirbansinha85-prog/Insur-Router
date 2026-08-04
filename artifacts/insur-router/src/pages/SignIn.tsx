import { useState } from "react"
import { useLogin } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"

/**
 * The sign-in screen.
 *
 * InsurRouter ran without one until OBJ-8, which is why its application list
 * used to return every dealership's applications to anybody holding the shared
 * service key. The key says a request came from one of our own processes; it
 * cannot say whose data is being asked for, and no amount of care in the route
 * layer can make it.
 *
 * Deliberately says nothing about which part was wrong. "No such account" and
 * "wrong password" are the same message here and on the server, because the
 * difference is exactly what somebody probing for valid addresses wants, and a
 * real user already knows which one they got wrong.
 */
export default function SignIn() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [failed, setFailed] = useState<string | null>(null)

  const login = useLogin()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setFailed(null)
    login.mutate(
      { data: { email, password } },
      {
        onSuccess: () => {
          // Reload rather than patch the cache. Identity has changed, and
          // nothing fetched as somebody else should survive that — including
          // the /auth/me error the gate is currently holding from the 401 that
          // put this form on screen.
          queryClient.clear()
          window.location.reload()
        },
        onError: (err) => {
          const data = (err as { data?: { error?: string } }).data
          setFailed(data?.error ?? "Could not sign in.")
        },
      },
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded bg-accent flex items-center justify-center shadow-sm">
            <span className="text-white text-xs font-black">IR</span>
          </div>
          <div>
            <div className="font-bold text-slate-900 leading-tight">InsurRouter</div>
            <div className="text-[11px] text-slate-500 leading-tight">
              Motor insurance issuance
            </div>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm space-y-4"
        >
          <div>
            <label htmlFor="email" className="block text-xs font-semibold text-slate-600 mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-semibold text-slate-600 mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>

          {failed && (
            <div className="text-xs rounded border border-red-200 bg-red-50 px-3 py-2 text-red-800">
              {failed}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="text-[11px] text-slate-400 mt-4 text-center">
          The same login as DDMS. You see your own dealership's applications.
        </p>
      </div>
    </div>
  )
}
