import { useState, useRef } from "react"
import { useIngestOcr } from "@workspace/api-client-react"
import { IngestResult, OcrInputModel } from "@workspace/api-client-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { UploadCloud, Loader2, FileImage, X } from "lucide-react"

export function OcrUpload({ onResult }: { onResult: (res: IngestResult & { previewUrl?: string }) => void }) {
  const [model, setModel] = useState<OcrInputModel>("gpt-vision")
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { mutate, isPending } = useIngestOcr()

  const handleFileSelect = (selectedFile: File | null) => {
    if (!selectedFile) return
    setFile(selectedFile)
    
    // Create preview URL
    const url = URL.createObjectURL(selectedFile)
    setPreviewUrl(url)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0])
    }
  }

  const clearFile = () => {
    setFile(null)
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const base64String = (event.target?.result as string).split(",")[1]
      
      mutate(
        { 
          data: { 
            imageBase64: base64String, 
            mimeType: file.type, 
            model 
          } 
        },
        {
          onSuccess: (data) => {
            onResult({ ...data, previewUrl: previewUrl || undefined })
          }
        }
      )
    }
    reader.readAsDataURL(file)
  }

  return (
    <Card>
      <form onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" />
            Computer Vision
          </CardTitle>
          <CardDescription>
            Extract structured data from KYC documents or registration certificates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Engine</Label>
            <Select value={model} onValueChange={(val) => setModel(val as OcrInputModel)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gpt-vision">GPT-4 Vision (requires OPENAI_API_KEY)</SelectItem>
                <SelectItem value="qwen-vl">Qwen-VL (requires DASHSCOPE_API_KEY)</SelectItem>
                <SelectItem value="paddleocr">PaddleOCR (requires PADDLEOCR_API_URL)</SelectItem>
                <SelectItem value="stub">Stub (Demo Data)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Document File</Label>
            
            {!file ? (
              <div 
                className={`border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center gap-3 transition-colors cursor-pointer ${isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30 hover:bg-muted/50'}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadCloud className="h-10 w-10 text-muted-foreground" />
                <div className="text-center">
                  <p className="text-sm font-medium">Drag & drop or click to upload</p>
                  <p className="text-xs text-muted-foreground mt-1">Accepts JPEG, PNG, or PDF up to 10MB</p>
                </div>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden" 
                  accept="image/jpeg,image/png,application/pdf"
                  onChange={(e) => handleFileSelect(e.target.files ? e.target.files[0] : null)}
                />
              </div>
            ) : (
              <div className="border border-border rounded-lg p-4 flex items-center justify-between bg-muted/30">
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className="h-10 w-10 rounded bg-primary/10 flex flex-shrink-0 items-center justify-center">
                    <FileImage className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                </div>
                <Button type="button" variant="ghost" size="icon" onClick={clearFile} disabled={isPending}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={!file || isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              "Extract Structured Data"
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
