import { useState } from "react"
import { useIngestDmsPull } from "@workspace/api-client-react"
import { IngestResult } from "@workspace/api-client-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Database, Loader2 } from "lucide-react"

export function DmsPull({ onResult }: { onResult: (res: IngestResult) => void }) {
  const [regNo, setRegNo] = useState("")
  const { mutate, isPending } = useIngestDmsPull()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!regNo) return

    mutate(
      { data: { regNo } },
      {
        onSuccess: (data) => {
          onResult(data)
        }
      }
    )
  }

  return (
    <Card>
      <form onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            Dealer Management System
          </CardTitle>
          <CardDescription>
            Pull registered vehicle and owner records directly from connected DMS APIs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="regNo">Vehicle Registration Number</Label>
            <Input
              id="regNo"
              placeholder="e.g. DL01AB1234"
              value={regNo}
              onChange={(e) => setRegNo(e.target.value.toUpperCase())}
              className="font-mono uppercase"
            />
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={!regNo || isPending}>
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
