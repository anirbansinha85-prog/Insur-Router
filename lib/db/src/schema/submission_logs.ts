import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { applicationsTable } from "./applications";

export const submissionLogsTable = pgTable("submission_logs", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id")
    .notNull()
    .references(() => applicationsTable.id, { onDelete: "cascade" }),
  step: text("step", {
    enum: [
      "data_ingestion",
      "validation",
      "routing",
      "execution_api",
      "execution_browser",
      "finalization",
      "error",
    ],
  }).notNull(),
  status: text("status", {
    enum: ["info", "success", "warning", "error"],
  }).notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSubmissionLogSchema = createInsertSchema(
  submissionLogsTable,
).omit({ id: true, createdAt: true });
export type InsertSubmissionLog = z.infer<typeof insertSubmissionLogSchema>;
export type SubmissionLog = typeof submissionLogsTable.$inferSelect;
