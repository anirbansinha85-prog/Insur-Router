import { useState } from "react"
import { useIngestBrowserScrape } from "@workspace/api-client-react"
import { IngestResult } from "@workspace/api-client-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Globe, Loader2 } from "lucide-react"

export function BrowserScrape({ onResult }: { onResult: (res: IngestResult) => void }) {
  const [url, setUrl] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  
  const { mutate, isPending } = useIngestBrowserScrape()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!url) return

    mutate(
      { data: { url, username: username || undefined, password: password || undefined } },
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
            <Globe className="h-5 w-5 text-primary" />
            Browser Automation
          </CardTitle>
          <CardDescription>
            Scrape application payloads from dealer portals via Playwright.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="url">Portal URL</Label>
            <Input
              id="url"
              type="url"
              placeholder="https://dealer.bajajallianz.com/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username (Optional)</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password (Optional)</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Button type="submit" disabled={!url || isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Scraping...
              </>
            ) : (
              "Extract Payload"
            )}
          </Button>
          {isPending && (
            <p className="text-sm text-muted-foreground animate-pulse">
              Playwright is navigating the portal...
            </p>
          )}
        </CardFooter>
      </form>
    </Card>
  )
}
