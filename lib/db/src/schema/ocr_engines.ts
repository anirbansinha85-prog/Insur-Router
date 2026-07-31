import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Per-engine OCR configuration, editable at runtime from the VeloDocs settings
 * panel. This table holds ONLY operator preferences — which engines are on and
 * in what order. The engines themselves are defined in code
 * (api-server/src/lib/ocr-engines.ts); whether one is usable also depends on its
 * API key being present, which is read from the environment, never stored here.
 *
 * Rows are optional. Any engine without a row falls back to the registry's
 * defaults, so the system works on a database that has never been configured.
 */
export const ocrEnginesTable = pgTable("ocr_engines", {
  id: serial("id").primaryKey(),
  engineId: text("engine_id", {
    enum: [
      "paddleocr",
      "qwen-vl",
      "olmocr",
      "gpt-vision",
      "gemini",
      "openrouter",
      "stub",
    ],
  })
    .notNull()
    .unique(),
  /** Lower is tried first in the automatic fallback chain. */
  priority: integer("priority").notNull().default(100),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}).enableRLS();

export const insertOcrEngineSchema = createInsertSchema(ocrEnginesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOcrEngine = z.infer<typeof insertOcrEngineSchema>;
export type OcrEngineSetting = typeof ocrEnginesTable.$inferSelect;
