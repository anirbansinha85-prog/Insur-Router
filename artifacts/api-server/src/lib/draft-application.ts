/**
 * Turning a pulled deal into a draft application.
 *
 * Extracted from `routes/ingest.ts` when DDMS grew an action button. Two
 * callers now create applications — VeloDocs pushing reviewed fields, and DDMS
 * starting one straight from a worklist row — and a forty-column insert written
 * twice is a forty-column insert that drifts.
 *
 * Lives in lib rather than routes so the dependency runs one way: routes import
 * this, this imports nothing from routes.
 */

import { and, eq } from "drizzle-orm";
import { db, applicationsTable, submissionLogsTable } from "@workspace/db";
import { logger } from "./logger";
import type { DmsDealContext } from "./dms";
import type { MsaFields } from "./ocr-engines";

/** Convert a Date or ISO string to YYYY-MM-DD for Drizzle date columns (mode:"string") */
export function toDateStr(val: Date | string): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

export interface MsaValidationResult {
  errors: string[];
  invalidFields: string[];
}

/**
 * Validates required MSA fields before inserting a draft application.
 * Mirrors the rules used by /applications/:id/validate (excluding providerId
 * which is not required at ingest time).
 */
export function validateMsaFields(fields: MsaFields): MsaValidationResult {
  const errors: string[] = [];
  const invalidFields: string[] = [];

  const requireStr = (field: keyof MsaFields, msg: string) => {
    if (!fields[field]) {
      errors.push(msg);
      invalidFields.push(field);
    }
  };

  // Vehicle
  requireStr("vehicleMake", "Vehicle make is required");
  requireStr("vehicleModel", "Vehicle model is required");
  requireStr("vehicleVariant", "Vehicle variant is required");
  requireStr("vehicleEngineNumber", "Engine number is required");
  requireStr("vehicleChassisNumber", "Chassis number / VIN is required");
  if ((fields.vehicleExShowroomPrice as number) <= 0) {
    errors.push("Ex-showroom price must be greater than zero");
    invalidFields.push("vehicleExShowroomPrice");
  }
  if (!fields.vehicleDateOfPurchase) {
    errors.push("Date of purchase is required");
    invalidFields.push("vehicleDateOfPurchase");
  }

  // Owner KYC
  requireStr("ownerFullName", "Owner full name is required");
  requireStr("ownerBillingAddress", "Billing address is required");
  if (!fields.ownerPincode || String(fields.ownerPincode).length !== 6) {
    errors.push("Pincode must be a 6-digit number");
    invalidFields.push("ownerPincode");
  }
  if (!fields.ownerPhoneNumber || !/^\d{10}$/.test(String(fields.ownerPhoneNumber))) {
    errors.push("Phone number must be exactly 10 digits");
    invalidFields.push("ownerPhoneNumber");
  }
  if (!fields.ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.ownerEmail)) {
    errors.push("Email address is invalid");
    invalidFields.push("ownerEmail");
  }
  requireStr("ownerDateOfBirth", "Date of birth is required");
  requireStr("ownerIdProofType", "ID proof type is required");
  requireStr("ownerIdProofNumber", "ID proof number is required");

  // RTO
  requireStr("rtoRegistrationCity", "Registration city is required");
  requireStr("rtoRegistrationState", "Registration state is required");

  return { errors, invalidFields };
}

/**
 * DMS relationship description → the `nominee_relationship` enum.
 *
 * The mock already emits enum-shaped values, but a real dealer system holds
 * whatever the salesperson typed — "Wife", "S/o", "Husband", "Mother-in-law".
 * Unrecognised input maps to OTHER rather than being dropped: the enum is a
 * storage convenience, and losing the fact that a nominee exists because the
 * word was unfamiliar would be a far worse outcome than a coarse label.
 *
 * The original text is not lost either — it stays in the deal record on the
 * DMS side, which remains the system of record for it.
 */
const RELATIONSHIP_SYNONYMS: Record<string, string> = {
  WIFE: "SPOUSE",
  HUSBAND: "SPOUSE",
  SPOUSE: "SPOUSE",
  FATHER: "FATHER",
  DAD: "FATHER",
  MOTHER: "MOTHER",
  MOM: "MOTHER",
  SON: "SON",
  DAUGHTER: "DAUGHTER",
  BROTHER: "BROTHER",
  SISTER: "SISTER",
};

type NomineeRelationship = typeof applicationsTable.$inferInsert["nomineeRelationship"];

export function normaliseRelationship(
  desc: string | null | undefined,
): NomineeRelationship {
  if (!desc) return null;
  const key = desc.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return (RELATIONSHIP_SYNONYMS[key] ?? "OTHER") as NomineeRelationship;
}

/**
 * Postgres `unique_violation` from the one-application-per-deal constraint.
 *
 * The lookup before the insert catches every ordinary duplicate; this catches
 * the one it cannot — two requests for the same deal arriving close enough
 * together that both lookups miss.
 */
function isDuplicateDealError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && e.constraint === "applications_dms_deal_unique";
}

export type DraftResult =
  | { kind: "created"; applicationId: number }
  | { kind: "duplicate"; applicationId: number | null; status: string | null }
  | { kind: "invalid"; errors: string[]; invalidFields: string[] };

export interface DraftInput {
  fields: MsaFields;
  /**
   * Only the showroom is needed, so only the showroom is asked for. Taking the
   * whole `DmsTenant` would couple this to a shape the HTTP layer receives with
   * optional fields, and coercing that at the call site is how a null becomes
   * an undefined becomes a row attributed to nobody.
   */
  tenant: { showroomId: number } | null;
  ctx: DmsDealContext | null;
  /** OCR audit trail. Null for a DMS-sourced draft — no document was read. */
  document?: Record<string, unknown> | null;
  /** What to write on the audit log line. */
  sourceDesc: string;
}

/**
 * Create the draft, or explain why not.
 *
 * Returns a result rather than throwing or writing a response, because the two
 * callers present the same three outcomes differently: VeloDocs shows the
 * invalid fields inline for correction, DDMS sends the user to VeloDocs to fix
 * them.
 */
export async function createDraftApplication(input: DraftInput): Promise<DraftResult> {
  const { fields, tenant, ctx, document = null, sourceDesc } = input;

  // One application per deal. Checked before validation on purpose: telling
  // someone to go and find a missing email for a deal that was already ingested
  // is work that was never needed, on a draft they should have been sent to.
  if (ctx?.dealerCode && ctx?.dealId) {
    const [existing] = await db
      .select({ id: applicationsTable.id, status: applicationsTable.status })
      .from(applicationsTable)
      .where(
        and(
          eq(applicationsTable.dmsDealerCode, ctx.dealerCode),
          eq(applicationsTable.dmsDealId, ctx.dealId),
        ),
      );

    if (existing) {
      logger.info(
        { dealId: ctx.dealId, applicationId: existing.id },
        "Draft not created — this deal already has an application",
      );
      return { kind: "duplicate", applicationId: existing.id, status: existing.status };
    }
  }

  const validation = validateMsaFields(fields);
  if (validation.errors.length > 0) {
    logger.info({ errors: validation.errors }, "Draft rejected — validation failed");
    return { kind: "invalid", ...validation };
  }

  // Zod coerces date-formatted strings to Date objects; Drizzle date columns use mode:"string"
  const dateOfPurchase = toDateStr(fields.vehicleDateOfPurchase as unknown as Date | string);
  const dateOfBirth = toDateStr(fields.ownerDateOfBirth as unknown as Date | string);

  const inserted = await db
    .insert(applicationsTable)
    .values({
      vehicleMake: fields.vehicleMake,
      vehicleModel: fields.vehicleModel,
      vehicleVariant: fields.vehicleVariant,
      vehicleEngineNumber: fields.vehicleEngineNumber,
      vehicleChassisNumber: fields.vehicleChassisNumber,
      vehicleExShowroomPrice: fields.vehicleExShowroomPrice,
      vehicleDateOfPurchase: dateOfPurchase,
      ownerFullName: fields.ownerFullName,
      ownerBillingAddress: fields.ownerBillingAddress,
      ownerPincode: fields.ownerPincode,
      ownerPhoneNumber: String(fields.ownerPhoneNumber),
      ownerEmail: fields.ownerEmail,
      ownerDateOfBirth: dateOfBirth,
      ownerIdProofType: fields.ownerIdProofType,
      ownerIdProofNumber: fields.ownerIdProofNumber,
      rtoRegistrationCity: fields.rtoRegistrationCity,
      rtoRegistrationState: fields.rtoRegistrationState,
      rtoCode: fields.rtoCode,

      // Tenant scope — which showroom, and through it which owner, owns this.
      showroomId: tenant?.showroomId ?? null,
      dmsDealerCode: ctx?.dealerCode ?? null,
      dmsDealId: ctx?.dealId ?? null,

      // Rating attributes. Without these the premium engine has nothing to band
      // on: third-party premium is slabbed by cc on petrol and by kW on
      // electric, and a deal reaching the pricer with neither has no price.
      vehicleFuelType: ctx?.vehicle.fuelType ?? null,
      vehicleCubicCapacity: ctx?.vehicle.cubicCapacity ?? null,
      vehicleMotorKw: ctx?.vehicle.motorKw ?? null,
      vehicleSeatingCapacity: ctx?.vehicle.seatingCapacity ?? null,
      vehicleManufactureMonth: ctx?.vehicle.manufactureMonth ?? null,
      vehicleManufactureYear: ctx?.vehicle.manufactureYear ?? null,

      // A company has no owner-driver, so compulsory PA cover does not apply.
      ownerEntityType: ctx?.owner.entityType ?? "INDIVIDUAL",

      nomineeFullName: ctx?.nominee.fullName ?? null,
      nomineeDateOfBirth: ctx?.nominee.dateOfBirth ?? null,
      nomineeRelationship: normaliseRelationship(ctx?.nominee.relationship),
      nomineeAppointeeName: ctx?.nominee.appointeeName ?? null,
      nomineeAppointeeRelationship: ctx?.nominee.appointeeRelationship ?? null,

      isHypothecated: ctx?.hypothecation.isHypothecated ?? false,
      hypothecationFinancierName: ctx?.hypothecation.financierName ?? null,
      hypothecationLoanAccountNumber: ctx?.hypothecation.loanAccountNumber ?? null,

      sourceDocument: document,
    })
    .returning()
    .catch(async (err: unknown) => {
      if (!isDuplicateDealError(err)) throw err;
      // Lost the race: two requests for the same deal, both lookups missed.
      const [winner] = await db
        .select({ id: applicationsTable.id })
        .from(applicationsTable)
        .where(
          and(
            eq(applicationsTable.dmsDealerCode, ctx!.dealerCode),
            eq(applicationsTable.dmsDealId, ctx!.dealId),
          ),
        );
      return { conflictWith: winner?.id ?? null } as const;
    });

  if ("conflictWith" in inserted) {
    logger.warn(
      { dealId: ctx?.dealId, applicationId: inserted.conflictWith },
      "Draft lost a race — the same deal was started twice at once",
    );
    return { kind: "duplicate", applicationId: inserted.conflictWith, status: null };
  }

  const [app] = inserted;

  await db.insert(submissionLogsTable).values({
    applicationId: app.id,
    step: "data_ingestion",
    status: "success",
    message: sourceDesc,
    metadata: document
      ? {
          documentType: (document as { documentType?: string }).documentType ?? null,
          issuer: (document as { issuer?: string }).issuer ?? null,
        }
      : null,
  });

  return { kind: "created", applicationId: app.id };
}
