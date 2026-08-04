import { useState } from "react"
import { useLogin } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"

/**
 * The sign-in screen.
 *
 * VeloDocs ran without one until OBJ-8, and of the three products it is the one
 * where that mattered most: ingest is where somebody else's data physically
 * enters this system — a deal pulled from a dealer's DMS, a scraped portal, an
 * Aadhaar card photographed on a counter. The shared service key said a request
 * came from one of our own processes and could not say whose customer it was
 * about.
 *
 * Signing in also answers a question the documents cannot: which outlet a draft
 * belongs to. A photographed ID has no dealer code on it.
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
          // Identity has changed; nothing fetched as somebody else survives it.
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
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="font-display font-bold text-2xl leading-none tracking-tight text-primary">
            VeloDocs
          </h1>
          <span className="text-xs text-muted-foreground font-medium mt-1 block">
            Document Ingestion Agent
          </span>
        </div>

        <form
          onSubmit={submit}
          className="bg-card border border-border rounded-lg p-6 shadow-sm space-y-4"
        >
          <div>
            <label htmlFor="email" className="block text-xs font-semibold text-muted-foreground mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-semibold text-muted-foreground mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {failed && (
            <div className="text-xs rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
              {failed}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="text-[11px] text-muted-foreground mt-4 text-center">
          The same login as DDMS. Drafts are created for your own outlet.
        </p>
      </div>
    </div>
  )
}
