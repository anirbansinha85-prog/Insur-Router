import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
  date,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { providersTable } from "./providers";

export const applicationsTable = pgTable("applications", {
  id: serial("id").primaryKey(),
  status: text("status", {
    enum: [
      "draft",
      "validating",
      "pending_confirmation",
      "submitting",
      "completed",
      "failed",
    ],
  })
    .notNull()
    .default("draft"),
  executionMode: text("execution_mode", {
    enum: ["API", "BROWSER", "AUTO"],
  })
    .notNull()
    .default("AUTO"),
  resolvedExecutionMode: text("resolved_execution_mode", {
    enum: ["API", "BROWSER"],
  }),
  providerId: integer("provider_id").references(() => providersTable.id, {
    onDelete: "set null",
  }),
  // Vehicle details (denormalized for list queries)
  vehicleMake: text("vehicle_make").notNull(),
  vehicleModel: text("vehicle_model").notNull(),
  vehicleVariant: text("vehicle_variant").notNull(),
  vehicleEngineNumber: text("vehicle_engine_number").notNull(),
  vehicleChassisNumber: text("vehicle_chassis_number").notNull(),
  vehicleExShowroomPrice: real("vehicle_ex_showroom_price").notNull(),
  vehicleDateOfPurchase: date("vehicle_date_of_purchase", {
    mode: "string",
  }).notNull(),
  // Owner KYC
  ownerFullName: text("owner_full_name").notNull(),
  ownerBillingAddress: text("owner_billing_address").notNull(),
  ownerPincode: integer("owner_pincode").notNull(),
  ownerPhoneNumber: text("owner_phone_number").notNull(),
  ownerEmail: text("owner_email").notNull(),
  ownerDateOfBirth: date("owner_date_of_birth", { mode: "string" }).notNull(),
  ownerIdProofType: text("owner_id_proof_type", {
    enum: ["AADHAR", "PAN", "PASSPORT", "DRIVING_LICENSE", "VOTER_ID"],
  }).notNull(),
  ownerIdProofNumber: text("owner_id_proof_number").notNull(),
  // RTO details
  rtoRegistrationCity: text("rto_registration_city").notNull(),
  rtoRegistrationState: text("rto_registration_state").notNull(),
  rtoCode: text("rto_code").notNull(),
  // Validation
  validationErrors: jsonb("validation_errors").$type<string[]>(),
  /**
   * Stage 1 OCR extraction, kept as an audit trail of what the model actually
   * read off the document — document type, every printed label/value pair, and
   * the raw text. Null for applications created by hand or from non-OCR
   * sources. Deliberately not normalised into columns: its shape varies by
   * document type and it is evidence, not queryable business data.
   */
  sourceDocument: jsonb("source_document").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}).enableRLS();

export const insertApplicationSchema = createInsertSchema(
  applicationsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applicationsTable.$inferSelect;
