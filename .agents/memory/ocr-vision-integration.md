---
name: OCR vision integration
description: How the VeloDocs OCR engine is wired to real vision-LLM APIs
---

# OCR Vision Integration

## The rule
Real OCR uses vision-language models (qwen-vl, gpt-vision) that return structured JSON. Raw OCR text engines (PaddleOCR) cannot share the same JSON parser — they need a separate text-to-fields extractor before being wired.

**Why:** `parseVisionLLMResponseToMsaFields()` expects the model to return a JSON blob with field values AND per-field confidence scores. Passing raw OCR text lines into it will always JSON-parse-fail and silently return empty fields — a worse outcome than an explicit error.

**How to apply:** Only pipe model output into `parseVisionLLMResponseToMsaFields()` if the model was prompted with `OCR_EXTRACTION_PROMPT` (which instructs JSON output). For raw-text OCR engines, implement a dedicated regex/heuristic extractor first.
