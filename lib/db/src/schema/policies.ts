import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { applicationsTable } from "./applications";

export const policiesTable = pgTable("policies", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id")
    .notNull()
    .unique()
    .references(() => applicationsTable.id, { onDelete: "cascade" }),
  policyNumber: text("policy_number").notNull(),
  pdfUrl: text("pdf_url"),
  providerName: text("provider_name").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const insertPolicySchema = createInsertSchema(policiesTable).omit({
  id: true,
});
export type InsertPolicy = z.infer<typeof insertPolicySchema>;
export type Policy = typeof policiesTable.$inferSelect;
