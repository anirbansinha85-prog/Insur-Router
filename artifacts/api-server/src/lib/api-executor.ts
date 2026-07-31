/**
 * API Executor
 *
 * This module handles REST API-based insurance application submission.
 * Each provider's API integration is implemented in its own handler.
 *
 * To add a new provider's API integration:
 *   1. Add the provider's API key env variable to the execution environment.
 *   2. Add a case to the `executeWithApi` switch statement.
 *   3. Implement the handler function, mapping the MSA payload to the
 *      provider's specific JSON schema and calling their endpoint.
 *
 * NOTE: This is a stub implementation. Replace the mock HTTP calls with
 * real `fetch` requests to the provider's actual API endpoints.
 *
 * Because it is a stub, everything it produces is marked as simulated: the
 * policy number carries the SIMULATED_POLICY_PREFIX, the result sets
 * `simulated: true`, and no log line claims a request that was not sent. The
 * source has always been honest about being a stub; the audit trail must be
 * too, or a demo run is indistinguishable from a real submission after the
 * fact. Drop the marking only when a real API call replaces the sleep.
 */

import { logger } from "./logger";
import { SIMULATED_POLICY_PREFIX, type MsaPayload } from "./browser-executor";

export interface ApiExecutionResult {
  success: boolean;
  policyNumber?: string;
  pdfUrl?: string;
  errorMessage?: string;
  httpStatus?: number;
  rawResponse?: unknown;
  /** True when no insurer was contacted and the policy number was invented locally. */
  simulated?: boolean;
  logs: Array<{ step: string; message: string; status: "info" | "success" | "warning" | "error" }>;
}

/**
 * Execute an insurance application via direct REST API.
 *
 * @param providerCode - Short provider code (e.g. "HDFC", "BAJAJ")
 * @param apiEndpoint - The provider's API base endpoint
 * @param payload - The validated MSA payload
 * @param applicationId - For logging context
 */
export async function executeWithApi(
  providerCode: string,
  apiEndpoint: string,
  payload: MsaPayload,
  applicationId: number,
): Promise<ApiExecutionResult> {
  logger.info({ applicationId, providerCode, apiEndpoint }, "Starting API execution");

  const executionLogs: ApiExecutionResult["logs"] = [];

  executionLogs.push({
    step: "execution_api",
    message: `Mapping MSA payload to ${providerCode} API schema`,
    status: "info",
  });

  try {
    // Route to provider-specific API handler
    switch (providerCode.toUpperCase()) {
      // ── Add real provider API handlers here ──────────────────────────────
      // case "HDFC":
      //   return await executeHdfcApi(apiEndpoint, payload, applicationId, executionLogs);
      // case "BAJAJ":
      //   return await executeBajajApi(apiEndpoint, payload, applicationId, executionLogs);
      // ─────────────────────────────────────────────────────────────────────

      default:
        return await executeGenericApiStub(providerCode, apiEndpoint, payload, executionLogs);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ applicationId, providerCode, err }, "API execution failed");
    executionLogs.push({
      step: "execution_api",
      message: `API call error: ${message}`,
      status: "error",
    });
    return {
      success: false,
      errorMessage: message,
      logs: executionLogs,
    };
  }
}

/**
 * Generic API stub — simulates a successful API submission.
 * Replace with real provider API schema mapping and fetch calls.
 *
 * Provider API pattern template:
 *
 *   const apiKey = process.env[`${providerCode}_API_KEY`];
 *   const response = await fetch(`${apiEndpoint}/policy/create`, {
 *     method: "POST",
 *     headers: {
 *       "Content-Type": "application/json",
 *       "Authorization": `Bearer ${apiKey}`,
 *     },
 *     body: JSON.stringify(mapToProviderSchema(payload)),
 *   });
 *   const data = await response.json();
 *   if (!response.ok) {
 *     throw new Error(`Provider API error ${response.status}: ${JSON.stringify(data)}`);
 *   }
 *   return { success: true, policyNumber: data.policyId, pdfUrl: data.documentUrl, ... };
 */
async function executeGenericApiStub(
  providerCode: string,
  apiEndpoint: string,
  payload: MsaPayload,
  logs: ApiExecutionResult["logs"],
): Promise<ApiExecutionResult> {
  logs.push({
    step: "execution_api",
    message:
      `SIMULATED — no HTTP request was sent. A real integration would ` +
      `POST the mapped payload to ${apiEndpoint}/policy/create`,
    status: "warning",
  });

  // Stand-in for network latency. No request is made.
  await new Promise((r) => setTimeout(r, 500));

  // Invented locally. Prefixed so it can never be mistaken for an insurer's
  // policy number, in the database, in an export, or on screen.
  const policyNumber = `${SIMULATED_POLICY_PREFIX}-${providerCode}-API-${Date.now().toString(36).toUpperCase()}`;

  logs.push({
    step: "execution_api",
    message: `SIMULATED — no response was received; slept 500ms in place of a network round trip`,
    status: "warning",
  });

  logs.push({
    step: "finalization",
    message:
      `SIMULATED policy number ${policyNumber} generated locally for ` +
      `${payload.ownerKyc.fullName}. No insurer was contacted and no policy exists.`,
    status: "warning",
  });

  return {
    success: true,
    policyNumber,
    simulated: true,
    // No httpStatus: nothing responded. Reporting 200 here would put a
    // fabricated status code into the audit trail.
    rawResponse: {
      simulated: true,
      note: "Locally generated by executeGenericApiStub. Not an insurer response.",
      policyNumber,
      vehicleMake: payload.vehicleDetails.make,
    },
    logs,
  };
}
