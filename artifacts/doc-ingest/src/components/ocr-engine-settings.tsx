import { useEffect, useState } from "react"
import {
  useListOcrEngines,
  useUpdateOcrEngines,
  type OcrEngineStatus,
} from "@workspace/api-client-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Settings2, ArrowUp, ArrowDown, Loader2, CheckCircle2, XCircle, AlertTriangle, RotateCw } from "lucide-react"

/**
 * Runtime OCR engine configuration.
 *
 * Order and on/off are operator preferences stored in the database and take
 * effect on the next extraction — no restart. Whether an engine can actually
 * run additionally depends on its API key being present in the server's
 * environment, which is reported here but cannot be edited from the browser.
 */
export function OcrEngineSettings() {
  const { data, isLoading, refetch, isRefetching } = useListOcrEngines()
  const { mutate: save, isPending } = useUpdateOcrEngines()
  const { toast } = useToast()

  const [engines, setEngines] = useState<OcrEngineStatus[]>([])
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    if (data && !isDirty) setEngines(data)
  }, [data, isDirty])

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= engines.length) return
    const next = [...engines]
    ;[next[index], next[target]] = [next[target], next[index]]
    setEngines(next)
    setIsDirty(true)
  }

  const toggle = (engineId: string) => {
    setEngines((prev) =>
      prev.map((e) => (e.engineId === engineId ? { ...e, isEnabled: !e.isEnabled } : e)),
    )
    setIsDirty(true)
  }

  const handleSave = () => {
    save(
      {
        // Position in the list becomes priority; lower is tried first.
        data: {
          engines: engines.map((e, i) => ({
            engineId: e.engineId,
            priority: (i + 1) * 10,
            isEnabled: e.isEnabled,
          })),
        },
      },
      {
        onSuccess: (updated) => {
          setEngines(updated)
          setIsDirty(false)
          toast({
            title: "Engine order saved",
            description: "Takes effect on the next extraction — no restart needed.",
          })
        },
        onError: (err) => {
          toast({
            title: "Could not save",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          })
        },
      },
    )
  }

  const handleReset = () => {
    setIsDirty(false)
    refetch()
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading engine status…
        </CardContent>
      </Card>
    )
  }

  const autoChain = engines.filter((e) => e.isAvailable && e.autoEligible)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          OCR Engine Priority
        </CardTitle>
        <CardDescription>
          Automatic mode tries these top-to-bottom and uses the first that succeeds.
          If one is rate-limited, times out, or has no key, the next takes over.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {autoChain.length === 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-amber/40 bg-amber/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber" />
            <div>
              <p className="font-medium">No engine is available for automatic mode.</p>
              <p className="text-muted-foreground mt-1">
                Add <code className="text-xs">OPENAI_API_KEY</code> or{" "}
                <code className="text-xs">DASHSCOPE_API_KEY</code> to <code className="text-xs">.env</code>{" "}
                and restart the API server. Until then, only the stub engine works,
                and it must be chosen by name.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Automatic chain:{" "}
            <span className="font-medium text-foreground">
              {autoChain.map((e) => e.label).join(" → ")}
            </span>
          </p>
        )}

        <div className="space-y-2">
          {engines.map((engine, index) => (
            <div
              key={engine.engineId}
              className={`flex items-center gap-3 rounded-lg border p-3 ${
                engine.isAvailable ? "border-border" : "border-border/60 bg-muted/30"
              }`}
            >
              <div className="flex flex-col gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`Move ${engine.label} up`}
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  disabled={index === engines.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`Move ${engine.label} down`}
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
              </div>

              <span className="w-5 text-center text-xs font-mono text-muted-foreground">
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{engine.label}</span>
                  {engine.isAvailable ? (
                    <Badge variant="outline" className="gap-1 text-xs">
                      <CheckCircle2 className="h-3 w-3" /> Ready
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1 text-xs">
                      <XCircle className="h-3 w-3" /> Unavailable
                    </Badge>
                  )}
                  {!engine.autoEligible && (
                    <Badge variant="secondary" className="text-xs">
                      Manual only
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {engine.statusReason}
                </p>
              </div>

              <Switch
                checked={engine.isEnabled}
                onCheckedChange={() => toggle(engine.engineId)}
                aria-label={`Enable ${engine.label}`}
              />
            </div>
          ))}
        </div>
      </CardContent>

      <CardFooter className="gap-2">
        <Button type="button" onClick={handleSave} disabled={!isDirty || isPending}>
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save order"
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleReset}
          disabled={isPending || isRefetching}
        >
          <RotateCw className={`mr-2 h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
          {isDirty ? "Discard changes" : "Re-check keys"}
        </Button>
      </CardFooter>
    </Card>
  )
}
