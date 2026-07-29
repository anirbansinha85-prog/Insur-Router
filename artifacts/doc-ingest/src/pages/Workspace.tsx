import { useState } from "react"
import { IngestResult } from "@workspace/api-client-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DmsPull } from "@/components/dms-pull"
import { BrowserScrape } from "@/components/browser-scrape"
import { OcrUpload } from "@/components/ocr-upload"
import { OcrEngineSettings } from "@/components/ocr-engine-settings"
import { ReviewCorrect } from "@/components/review-correct"

export function Workspace() {
  const [ingestResult, setIngestResult] = useState<IngestResult & { previewUrl?: string; sourceName?: string } | null>(null)

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex flex-col justify-center">
            <h1 className="font-display font-bold text-2xl leading-none tracking-tight text-primary">VeloDocs</h1>
            <span className="text-xs text-muted-foreground font-medium mt-1">
              Document Ingestion Agent
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 py-8">
        {!ingestResult ? (
          <div className="max-w-2xl mx-auto space-y-8">
            <div className="space-y-2">
              <h2 className="text-3xl font-display font-semibold tracking-tight">New Ingestion</h2>
              <p className="text-muted-foreground text-lg">
                Select a data source to extract and normalize MSA payload.
              </p>
            </div>

            <Tabs defaultValue="dms" className="w-full">
              <TabsList className="grid w-full grid-cols-4 h-12 mb-6">
                <TabsTrigger value="dms" className="text-sm">DMS Pull</TabsTrigger>
                <TabsTrigger value="browser" className="text-sm">Browser Scrape</TabsTrigger>
                <TabsTrigger value="ocr" className="text-sm">OCR Upload</TabsTrigger>
                <TabsTrigger value="engines" className="text-sm">Engines</TabsTrigger>
              </TabsList>
              
              <div className="mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <TabsContent value="dms" className="m-0 focus-visible:outline-none">
                  <DmsPull onResult={(res) => setIngestResult({ ...res, sourceName: "DMS Pull" })} />
                </TabsContent>
                <TabsContent value="browser" className="m-0 focus-visible:outline-none">
                  <BrowserScrape onResult={(res) => setIngestResult({ ...res, sourceName: "Browser Scrape" })} />
                </TabsContent>
                <TabsContent value="ocr" className="m-0 focus-visible:outline-none">
                  <OcrUpload onResult={(res) => setIngestResult({ ...res, sourceName: "OCR Upload" })} />
                </TabsContent>
                <TabsContent value="engines" className="m-0 focus-visible:outline-none">
                  <OcrEngineSettings />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        ) : (
          <ReviewCorrect result={ingestResult} onReset={() => setIngestResult(null)} />
        )}
      </main>
    </div>
  )
}
