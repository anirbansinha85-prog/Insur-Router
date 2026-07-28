import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const providersTable = pgTable("providers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  defaultExecutionMode: text("default_execution_mode", {
    enum: ["API", "BROWSER", "AUTO"],
  })
    .notNull()
    .default("AUTO"),
  apiEndpoint: text("api_endpoint"),
  portalUrl: text("portal_url"),
  isActive: boolean("is_active").notNull().default(true),
  logoColor: text("logo_color"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertProviderSchema = createInsertSchema(providersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProvider = z.infer<typeof insertProviderSchema>;
export type Provider = typeof providersTable.$inferSelect;
