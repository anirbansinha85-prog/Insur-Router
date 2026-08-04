import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import {
  db,
  applicationsTable,
  providersTable,
  submissionLogsTable,
  policiesTable,
} from "@workspace/db";
import {
  ListApplicationsQueryParams,
  CreateApplicationBody,
  UpdateApplicationBody,
  GetApplicationParams,
  UpdateApplicationParams,
  DeleteApplicationParams,
  ValidateApplicationParams,
  ExecuteApplicationParams,
  ExecuteApplicationBody,
  GetApplicationLogsParams,
  GetPolicyParams,
  ListApplicationsResponse,
  GetApplicationResponse,
  CreateApplicationResponse,
  UpdateApplicationResponse,
  ValidateApplicationResponse,
  ExecuteApplicationResponse,
  GetApplicationLogsResponse,
  GetPolicyResponse,
} from "@workspace/api-zod";
import { executeWithApi } from "../lib/api-executor";
import { executeWithBrowser } from "../lib/browser-executor";
import { requireModule, requireUser, resolveOwningShowroom, sessionScope } from "../lib/session";

const router: IRouter = Router();

/**
 * Behind a session since OBJ-8.
 *
 * Every query below is unchanged and every one of them now returns less: they
 * carry no owner filter, and inside a scope they do not need one, because
 * `applications` is scoped by policy on the connection. Before this the list
 * endpoint returned every dealership's applications to anybody holding the
 * shared service key — the same defect DDMS closed in OBJ-3, still open here
 * because InsurRouter had no sign-in to scope by.
 */
router.use("/applications", requireUser, sessionScope, requireModule("DEAL"));

/** Convert a Date or ISO string to YYYY-MM-DD for date columns */
function toDateStr(val: Date | string): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

// ── List Applications ──────────────────────────────────────────────────────
router.get("/applications", async (req, res): Promise<void> => {
  const query = ListApplicationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = [];
  if (query.data.status) {
    conditions.push(eq(applicationsTable.status, query.data.status));
  }
  if (query.data.providerId != null) {
    conditions.push(eq(applicationsTable.providerId, query.data.providerId));
  }

  const apps = await db
    .select({
      id: applicationsTable.id,
      status: applicationsTable.status,
      executionMode: applicationsTable.executionMode,
      resolvedExecutionMode: applicationsTable.resolvedExecutionMode,
      providerId: applicationsTable.providerId,
      providerName: providersTable.name,
      vehicleMake: applicationsTable.vehicleMake,
      vehicleModel: applicationsTable.vehicleModel,
      ownerName: applicationsTable.ownerFullName,
      createdAt: applicationsTable.createdAt,
      updatedAt: applicationsTable.updatedAt,
    })
    .from(applicationsTable)
    .leftJoin(
      providersTable,
      eq(applicationsTable.providerId, providersTable.id),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(applicationsTable.createdAt);

  res.json(ListApplicationsResponse.parse(apps));
});

// ── Create Application ─────────────────────────────────────────────────────
router.post("/applications", async (req, res): Promise<void> => {
  const parsed = CreateApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { vehicleDetails, ownerKyc, rtoDetails, executionMode, providerId } =
    parsed.data;

  // Which outlet this belongs to, before anything is written. A row with no
  // showroom is a row nobody can see afterwards, so an owner working across
  // several outlets is asked rather than guessed for.
  const owning = await resolveOwningShowroom(req, res, parsed.data.showroomId);
  if (!owning.ok) return;
  if (owning.showroomId === null) {
    res.status(400).json({
      error:
        "Which outlet is this application for? You hold more than one, and an " +
        "application that names none belongs to none.",
    });
    return;
  }

  const [app] = await db
    .insert(applicationsTable)
    .values({
      showroomId: owning.showroomId,
      executionMode,
      providerId: providerId ?? null,
      vehicleMake: vehicleDetails.make,
      vehicleModel: vehicleDetails.model,
      vehicleVariant: vehicleDetails.variant,
      vehicleEngineNumber: vehicleDetails.engineNumber,
      vehicleChassisNumber: vehicleDetails.chassisNumber,
      vehicleExShowroomPrice: vehicleDetails.exShowroomPrice,
      vehicleDateOfPurchase: toDateStr(vehicleDetails.dateOfPurchase),
      ownerFullName: ownerKyc.fullName,
      ownerBillingAddress: ownerKyc.billingAddress,
      ownerPincode: ownerKyc.pincode,
      ownerPhoneNumber: String(ownerKyc.phoneNumber),
      ownerEmail: ownerKyc.email,
      ownerDateOfBirth: toDateStr(ownerKyc.dateOfBirth),
      ownerIdProofType: ownerKyc.idProofType,
      ownerIdProofNumber: ownerKyc.idProofNumber,
      rtoRegistrationCity: rtoDetails.registrationCity,
      rtoRegistrationState: rtoDetails.registrationState,
      rtoCode: rtoDetails.rtoCode,
    })
    .returning();

  // Log ingestion step
  await db.insert(submissionLogsTable).values({
    applicationId: app.id,
    step: "data_ingestion",
    status: "success",
    message: `Application created for ${vehicleDetails.make} ${vehicleDetails.model} (${ownerKyc.fullName})`,
  });

  const [providerRow] = app.providerId
    ? await db
        .select({ name: providersTable.name })
        .from(providersTable)
        .where(eq(providersTable.id, app.providerId))
    : [];

  res.status(201).json(
    CreateApplicationResponse.parse({
      ...app,
      providerName: providerRow?.name ?? null,
      ownerName: app.ownerFullName,
    }),
  );
});

// ── Get Application Detail ─────────────────────────────────────────────────
router.get("/applications/:id", async (req, res): Promise<void> => {
  const params = GetApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id));

  if (!app) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const [providerRow] = app.providerId
    ? await db
        .select({ name: providersTable.name })
        .from(providersTable)
        .where(eq(providersTable.id, app.providerId))
    : [];

  const logs = await db
    .select()
    .from(submissionLogsTable)
    .where(eq(submissionLogsTable.applicationId, app.id))
    .orderBy(submissionLogsTable.createdAt);

  const [policyRow] = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.applicationId, app.id));

  res.json(
    GetApplicationResponse.parse({
      id: app.id,
      status: app.status,
      executionMode: app.executionMode,
      resolvedExecutionMode: app.resolvedExecutionMode,
      providerId: app.providerId,
      providerName: providerRow?.name ?? null,
      vehicleDetails: {
        make: app.vehicleMake,
        model: app.vehicleModel,
        variant: app.vehicleVariant,
        engineNumber: app.vehicleEngineNumber,
        chassisNumber: app.vehicleChassisNumber,
        exShowroomPrice: app.vehicleExShowroomPrice,
        dateOfPurchase: app.vehicleDateOfPurchase,
      },
      ownerKyc: {
        fullName: app.ownerFullName,
        billingAddress: app.ownerBillingAddress,
        pincode: app.ownerPincode,
        phoneNumber: Number(app.ownerPhoneNumber),
        email: app.ownerEmail,
        dateOfBirth: app.ownerDateOfBirth,
        idProofType: app.ownerIdProofType,
        idProofNumber: app.ownerIdProofNumber,
      },
      rtoDetails: {
        registrationCity: app.rtoRegistrationCity,
        registrationState: app.rtoRegistrationState,
        rtoCode: app.rtoCode,
      },
      validationErrors: app.validationErrors ?? [],
      logs: logs.map((l) => ({
        ...l,
        metadata: l.metadata ?? null,
      })),
      policy: policyRow ?? null,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    }),
  );
});

// ── Update Application ─────────────────────────────────────────────────────
router.patch("/applications/:id", async (req, res): Promise<void> => {
  const params = UpdateApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id));
  if (!existing[0]) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const { vehicleDetails, ownerKyc, rtoDetails, executionMode, providerId } =
    parsed.data;

  const updateValues: Partial<typeof applicationsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (executionMode != null) updateValues.executionMode = executionMode;
  if (providerId !== undefined) updateValues.providerId = providerId;
  if (vehicleDetails) {
    updateValues.vehicleMake = vehicleDetails.make;
    updateValues.vehicleModel = vehicleDetails.model;
    updateValues.vehicleVariant = vehicleDetails.variant;
    updateValues.vehicleEngineNumber = vehicleDetails.engineNumber;
    updateValues.vehicleChassisNumber = vehicleDetails.chassisNumber;
    updateValues.vehicleExShowroomPrice = vehicleDetails.exShowroomPrice;
    updateValues.vehicleDateOfPurchase = toDateStr(vehicleDetails.dateOfPurchase);
  }
  if (ownerKyc) {
    updateValues.ownerFullName = ownerKyc.fullName;
    updateValues.ownerBillingAddress = ownerKyc.billingAddress;
    updateValues.ownerPincode = ownerKyc.pincode;
    updateValues.ownerPhoneNumber = String(ownerKyc.phoneNumber);
    updateValues.ownerEmail = ownerKyc.email;
    updateValues.ownerDateOfBirth = toDateStr(ownerKyc.dateOfBirth);
    updateValues.ownerIdProofType = ownerKyc.idProofType;
    updateValues.ownerIdProofNumber = ownerKyc.idProofNumber;
  }
  if (rtoDetails) {
    updateValues.rtoRegistrationCity = rtoDetails.registrationCity;
    updateValues.rtoRegistrationState = rtoDetails.registrationState;
    updateValues.rtoCode = rtoDetails.rtoCode;
  }

  const [app] = await db
    .update(applicationsTable)
    .set(updateValues)
    .where(eq(applicationsTable.id, params.data.id))
    .returning();

  const [providerRow] = app.providerId
    ? await db
        .select({ name: providersTable.name })
        .from(providersTable)
        .where(eq(providersTable.id, app.providerId))
    : [];

  res.json(
    UpdateApplicationResponse.parse({
      ...app,
      providerName: providerRow?.name ?? null,
      ownerName: app.ownerFullName,
    }),
  );
});

// ── Delete Application ─────────────────────────────────────────────────────
router.delete("/applications/:id", async (req, res): Promise<void> => {
  const params = DeleteApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [app] = await db
    .delete(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id))
    .returning();
  if (!app) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  res.sendStatus(204);
});

// ── Validate Application ───────────────────────────────────────────────────
router.post("/applications/:id/validate", async (req, res): Promise<void> => {
  const params = ValidateApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id));

  if (!app) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Strict MSA payload validation ────────────────────────────────────────
  if (!app.vehicleMake) errors.push("Vehicle make is required");
  if (!app.vehicleModel) errors.push("Vehicle model is required");
  if (!app.vehicleVariant) errors.push("Vehicle variant is required");
  if (!app.vehicleEngineNumber) errors.push("Engine number is required");
  if (!app.vehicleChassisNumber) errors.push("Chassis number / VIN is required");
  if (app.vehicleExShowroomPrice <= 0)
    errors.push("Ex-showroom price must be greater than zero");
  if (!app.vehicleDateOfPurchase)
    errors.push("Date of purchase is required");

  if (!app.ownerFullName) errors.push("Owner full name is required");
  if (!app.ownerBillingAddress) errors.push("Billing address is required");
  if (!app.ownerPincode || String(app.ownerPincode).length !== 6)
    errors.push("Pincode must be a 6-digit number");
  if (!app.ownerPhoneNumber || !/^\d{10}$/.test(app.ownerPhoneNumber))
    errors.push("Phone number must be exactly 10 digits");
  if (!app.ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(app.ownerEmail))
    errors.push("Email address is invalid");
  if (!app.ownerDateOfBirth) errors.push("Date of birth is required");
  if (!app.ownerIdProofType) errors.push("ID proof type is required");
  if (!app.ownerIdProofNumber) errors.push("ID proof number is required");

  if (!app.rtoRegistrationCity)
    errors.push("Registration city is required");
  if (!app.rtoRegistrationState)
    errors.push("Registration state is required");
  if (!app.rtoCode || !/^[A-Z]{2}\d{2}$/.test(app.rtoCode.toUpperCase()))
    warnings.push("RTO code format should be like MH01, DL02 etc.");

  if (!app.providerId)
    errors.push("Insurance provider must be selected before validation");

  const valid = errors.length === 0;

  // Update application status and store validation errors
  await db
    .update(applicationsTable)
    .set({
      status: valid ? "pending_confirmation" : "draft",
      validationErrors: errors,
      updatedAt: new Date(),
    })
    .where(eq(applicationsTable.id, app.id));

  await db.insert(submissionLogsTable).values({
    applicationId: app.id,
    step: "validation",
    status: valid ? "success" : "error",
    message: valid
      ? "All MSA payload fields validated successfully"
      : `Validation failed: ${errors.join("; ")}`,
    metadata: { errors, warnings },
  });

  res.json(ValidateApplicationResponse.parse({ valid, errors, warnings }));
});

// ── Execute Application ────────────────────────────────────────────────────
router.post("/applications/:id/execute", async (req, res): Promise<void> => {
  const params = ExecuteApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = ExecuteApplicationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  if (!body.data.confirmedByUser) {
    res.status(400).json({
      error: "User confirmation is required before submission",
    });
    return;
  }

  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id));

  if (!app) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  if (!app.providerId) {
    res.status(400).json({ error: "Provider must be selected before execution" });
    return;
  }

  if (app.status === "completed") {
    res.status(400).json({ error: "Application has already been submitted" });
    return;
  }

  const [provider] = await db
    .select()
    .from(providersTable)
    .where(eq(providersTable.id, app.providerId));

  if (!provider) {
    res.status(400).json({ error: "Selected provider not found" });
    return;
  }

  // Determine execution mode
  const requestedMode =
    body.data.executionMode ?? app.executionMode;
  let resolvedMode: "API" | "BROWSER";

  if (requestedMode === "API") {
    resolvedMode = "API";
  } else if (requestedMode === "BROWSER") {
    resolvedMode = "BROWSER";
  } else {
    // AUTO: prefer API if endpoint exists, else fall back to BROWSER
    resolvedMode =
      provider.apiEndpoint && provider.defaultExecutionMode !== "BROWSER"
        ? "API"
        : "BROWSER";
  }

  // Mark as submitting
  await db
    .update(applicationsTable)
    .set({
      status: "submitting",
      resolvedExecutionMode: resolvedMode,
      updatedAt: new Date(),
    })
    .where(eq(applicationsTable.id, app.id));

  await db.insert(submissionLogsTable).values({
    applicationId: app.id,
    step: "routing",
    status: "info",
    message: `Routing to ${provider.name} via ${resolvedMode} mode`,
    metadata: { providerCode: provider.code, resolvedMode },
  });

  const msaPayload = {
    vehicleDetails: {
      make: app.vehicleMake,
      model: app.vehicleModel,
      variant: app.vehicleVariant,
      engineNumber: app.vehicleEngineNumber,
      chassisNumber: app.vehicleChassisNumber,
      exShowroomPrice: app.vehicleExShowroomPrice,
      dateOfPurchase: app.vehicleDateOfPurchase,
    },
    ownerKyc: {
      fullName: app.ownerFullName,
      billingAddress: app.ownerBillingAddress,
      pincode: app.ownerPincode,
      phoneNumber: app.ownerPhoneNumber,
      email: app.ownerEmail,
      dateOfBirth: app.ownerDateOfBirth,
      idProofType: app.ownerIdProofType,
      idProofNumber: app.ownerIdProofNumber,
    },
    rtoDetails: {
      registrationCity: app.rtoRegistrationCity,
      registrationState: app.rtoRegistrationState,
      rtoCode: app.rtoCode,
    },
  };

  // Execute
  let success = false;
  let policyNumber: string | undefined;
  let pdfUrl: string | undefined;
  let errorMessage: string | undefined;
  // True when no insurer was contacted. Both executors are still stubs, so
  // this is currently always true on success — it is carried through to the
  // response and the log metadata rather than assumed by the caller.
  let simulated = false;

  if (resolvedMode === "API" && provider.apiEndpoint) {
    const result = await executeWithApi(
      provider.code,
      provider.apiEndpoint,
      msaPayload,
      app.id,
    );
    success = result.success;
    policyNumber = result.policyNumber;
    pdfUrl = result.pdfUrl;
    errorMessage = result.errorMessage;
    simulated = result.simulated ?? false;

    for (const log of result.logs) {
      await db.insert(submissionLogsTable).values({
        applicationId: app.id,
        step: log.step as typeof submissionLogsTable.$inferInsert["step"],
        status: log.status,
        message: log.message,
        metadata: result.simulated ? { simulated: true } : null,
      });
    }
  } else {
    const portalUrl =
      provider.portalUrl ?? `https://portal.${provider.code.toLowerCase()}.com`;
    const result = await executeWithBrowser(
      provider.code,
      portalUrl,
      msaPayload,
      app.id,
    );
    success = result.success;
    policyNumber = result.policyNumber;
    pdfUrl = result.pdfUrl;
    errorMessage = result.errorMessage;
    simulated = result.simulated ?? false;

    for (const log of result.logs) {
      const metadata: Record<string, unknown> = {};
      if (log.screenshot) metadata.screenshot = log.screenshot;
      if (result.simulated) metadata.simulated = true;

      await db.insert(submissionLogsTable).values({
        applicationId: app.id,
        step: log.step as typeof submissionLogsTable.$inferInsert["step"],
        status: log.status,
        message: log.message,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      });
    }
  }

  let policy = null;

  if (success && policyNumber) {
    const [newPolicy] = await db
      .insert(policiesTable)
      .values({
        applicationId: app.id,
        policyNumber,
        pdfUrl: pdfUrl ?? null,
        providerName: provider.name,
        issuedAt: new Date(),
      })
      .returning();

    await db
      .update(applicationsTable)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(applicationsTable.id, app.id));

    policy = newPolicy;
  } else {
    await db
      .update(applicationsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(applicationsTable.id, app.id));

    await db.insert(submissionLogsTable).values({
      applicationId: app.id,
      step: "error",
      status: "error",
      message: errorMessage ?? "Submission failed for unknown reason",
    });
  }

  res.json(
    ExecuteApplicationResponse.parse({
      applicationId: app.id,
      status: success ? "completed" : "failed",
      resolvedExecutionMode: resolvedMode,
      message: success
        ? simulated
          ? `SIMULATED policy ${policyNumber} — no insurer was contacted and no policy exists`
          : `Policy issued: ${policyNumber}`
        : `Submission failed: ${errorMessage}`,
      policy: policy ?? null,
    }),
  );
});

// ── Application Logs ───────────────────────────────────────────────────────
router.get("/applications/:id/logs", async (req, res): Promise<void> => {
  const params = GetApplicationLogsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [app] = await db
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id));

  if (!app) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const logs = await db
    .select()
    .from(submissionLogsTable)
    .where(eq(submissionLogsTable.applicationId, params.data.id))
    .orderBy(submissionLogsTable.createdAt);

  res.json(
    GetApplicationLogsResponse.parse(
      logs.map((l) => ({ ...l, metadata: l.metadata ?? null })),
    ),
  );
});

// ── Get Policy ─────────────────────────────────────────────────────────────
router.get("/applications/:id/policy", async (req, res): Promise<void> => {
  const params = GetPolicyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [policy] = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.applicationId, params.data.id));

  if (!policy) {
    res.status(404).json({ error: "Policy not found for this application" });
    return;
  }

  res.json(GetPolicyResponse.parse(policy));
});

export default router;
