import {
  pgTable,
  text,
  serial,
  integer,
  real,
  boolean,
  timestamp,
  date,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { providersTable } from "./providers";
import { showroomsTable } from "./showrooms";

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
  /**
   * Rating attributes. All nullable: every column above this block predates
   * them, and an application created by hand or by OCR may legitimately not
   * know them yet. They are required to *price*, not to exist — the validation
   * gate decides that, not the column definition.
   *
   * `PETROL` and `ELECTRIC` only, matching `RatedVehicle` in
   * `@workspace/quoting/premium`. The IRDAI tables cover exactly these two for
   * two-wheelers, and widening the enum here without widening the rate tables
   * would let a deal reach the pricer with no band to land in.
   */
  vehicleFuelType: text("vehicle_fuel_type", {
    enum: ["PETROL", "ELECTRIC"],
  }),
  /**
   * Engine displacement. Null on electric — TP is rated on kW there instead.
   *
   * `real`, not `integer`: actual displacement is fractional. A Hero Xpulse is
   * 199.6cc, a Splendor 97.2cc, a Destini 124.6cc — those are the figures the
   * DMS holds and the numbers printed on Form 21. Rounding them would be
   * storing something the source never said, and 149.6 rounding to 150 would
   * cross an IRDAI band boundary in the wrong direction.
   */
  vehicleCubicCapacity: real("vehicle_cubic_capacity"),
  /** Continuous motor rating. Null on petrol. */
  vehicleMotorKw: real("vehicle_motor_kw"),
  vehicleSeatingCapacity: integer("vehicle_seating_capacity"),
  /** 1-12. Held apart from the year because IDV depreciation steps by month. */
  vehicleManufactureMonth: integer("vehicle_manufacture_month"),
  vehicleManufactureYear: integer("vehicle_manufacture_year"),
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
  /**
   * A company has no owner-driver, so the compulsory ₹15L personal accident
   * cover does not apply and no nominee is required. Nothing else in the
   * schema could express that, which is why a corporate buyer previously had
   * to be treated as an individual with missing data.
   */
  ownerEntityType: text("owner_entity_type", {
    enum: ["INDIVIDUAL", "CORPORATE"],
  }).default("INDIVIDUAL"),
  /**
   * Nominee for the compulsory owner-driver personal accident cover.
   *
   * The one mandatory group that **no document carries** — not the RC, not
   * Form 21, not Aadhaar. It is always asked, never extracted, and that single
   * fact is why "scan a document, get a policy" cannot work. Nullable because
   * an application legitimately exists before the question is put to the
   * customer; required at the validation gate for an individual owner.
   */
  nomineeFullName: text("nominee_full_name"),
  nomineeDateOfBirth: date("nominee_date_of_birth", { mode: "string" }),
  nomineeRelationship: text("nominee_relationship", {
    enum: [
      "SPOUSE",
      "FATHER",
      "MOTHER",
      "SON",
      "DAUGHTER",
      "BROTHER",
      "SISTER",
      "OTHER",
    ],
  }),
  /**
   * Required only when the nominee is a minor — the payout is made to the
   * appointee on their behalf. Asked conditionally, from the nominee's DOB.
   */
  nomineeAppointeeName: text("nominee_appointee_name"),
  nomineeAppointeeRelationship: text("nominee_appointee_relationship"),
  /**
   * Hypothecation. A financed vehicle is endorsed in the financier's favour,
   * and the insurer needs the financier on the policy — getting this wrong
   * means reissuing the document.
   */
  isHypothecated: boolean("is_hypothecated").default(false),
  hypothecationFinancierName: text("hypothecation_financier_name"),
  hypothecationLoanAccountNumber: text("hypothecation_loan_account_number"),
  /**
   * What is actually being bought. The system previously routed and submitted
   * an application without recording this anywhere.
   *
   * `BUNDLED_1OD_5TP` is the new two-wheeler default: since September 2018 the
   * five-year third-party cover is compulsory at first sale, and own damage is
   * written annually alongside it.
   */
  coverageType: text("coverage_type", {
    enum: ["TP_ONLY_5Y", "BUNDLED_1OD_5TP", "COMPREHENSIVE_1Y"],
  }),
  coverageTpTermYears: integer("coverage_tp_term_years"),
  coverageOdTermYears: integer("coverage_od_term_years"),
  /** Insured declared value — the basis for the own-damage premium. */
  coverageIdv: real("coverage_idv"),
  coverageVoluntaryDeductible: real("coverage_voluntary_deductible"),
  /** Selected add-ons, as `[{ code, label }]`. Priced at quote time, not here. */
  coverageAddOns: jsonb("coverage_add_ons").$type<
    Array<{ code: string; label: string }>
  >(),
  /**
   * PA cover can be declined only for a specific, documented reason — the
   * customer already holds ₹15L of PA cover elsewhere, or has no valid driving
   * licence, which makes them ineligible rather than unwilling.
   */
  cpaOptedOut: boolean("cpa_opted_out").default(false),
  cpaOptOutReason: text("cpa_opt_out_reason"),
  /**
   * Which showroom this application belongs to, and through it which owner.
   *
   * This is the tenant scope. Nullable only because rows created before the
   * owner tier existed have no answer — every new application should carry it,
   * and once auth is in place a query without it is a bug rather than a
   * broad search.
   */
  showroomId: integer("showroom_id").references(() => showroomsTable.id, {
    onDelete: "set null",
  }),
  /**
   * Where this application came from in the dealer's own system.
   *
   * The natural key is the deal, not the registration number — a new vehicle
   * has no registration at the moment insurance is bought, because the RTO
   * will not register it without live cover. Chassis is kept alongside so a
   * pull can be re-driven from stock, and so OCR output can be matched against
   * a known finite set rather than establishing identity on its own.
   *
   * `dmsDealerCode` is the OEM's code and resolves to a showroom via
   * `showroom_dms_accounts`; `showroomId` above is the resolved answer, kept
   * denormalised so scoping a query never needs the join.
   */
  dmsDealerCode: text("dms_dealer_code"),
  dmsDealId: text("dms_deal_id"),
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
