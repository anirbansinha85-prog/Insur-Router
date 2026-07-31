import { useState } from "react"
import { useIngestDmsPull } from "@workspace/api-client-react"
import { IngestResult } from "@workspace/api-client-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Database, Loader2 } from "lucide-react"

/**
 * Pull a deal from the dealer's DMS.
 *
 * Keyed on the deal ID or the chassis number, never a registration number: the
 * RTO will not register a new vehicle until a policy exists, so there is no
 * registration number to type at the moment insurance is bought.
 */
type DmsKey = "dealId" | "chassisNo"

const KEYS: Record<DmsKey, { label: string; placeholder: string; hint: string }> = {
  dealId: {
    label: "Deal ID",
    placeholder: "e.g. HMC-DL-2026-000183",
    hint: "The dealer's own booking reference. Resolves customer, vehicle and finance in one call.",
  },
  chassisNo: {
    label: "Chassis number",
    placeholder: "e.g. MBLKAR0921NK18337",
    hint: "Printed on Form 21 before any RC exists. Resolved against stock to find the deal.",
  },
}

export function DmsPull({ onResult }: { onResult: (res: IngestResult) => void }) {
  const [keyType, setKeyType] = useState<DmsKey>("dealId")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const { mutate, isPending } = useIngestDmsPull()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    setError(null)

    mutate(
      { data: keyType === "dealId" ? { dealId: trimmed } : { chassisNo: trimmed } },
      {
        onSuccess: (data) => {
          onResult(data)
        },
        onError: (err: unknown) => {
          // The DMS is an external system: it can be unconfigured, down, or
          // simply not hold this deal. Each of those is actionable and none of
          // them should look like a silent empty result.
          const message =
            (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            (err instanceof Error ? err.message : "DMS request failed")
          setError(message)
        },
      }
    )
  }

  const field = KEYS[keyType]

  return (
    <Card>
      <form onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            Dealer Management System
          </CardTitle>
          <CardDescription>
            Pull the deal, vehicle and customer straight from the dealership's own system.
            Everything it holds is authoritative and needs no review.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            {(Object.keys(KEYS) as DmsKey[]).map((k) => (
              <Button
                key={k}
                type="button"
                variant={keyType === k ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setKeyType(k)
                  setValue("")
                  setError(null)
                }}
              >
                {KEYS[k].label}
              </Button>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="dmsKey">{field.label}</Label>
            <Input
              id="dmsKey"
              placeholder={field.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value.toUpperCase())}
              className="font-mono uppercase"
            />
            <p className="text-xs text-muted-foreground">{field.hint}</p>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={!value.trim() || isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Querying DMS...
              </>
            ) : (
              "Pull Record"
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
