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
 */

import { logger } from "./logger";
import type { MsaPayload } from "./browser-executor";

export interface ApiExecutionResult {
  success: boolean;
  policyNumber?: string;
  pdfUrl?: string;
  errorMessage?: string;
  httpStatus?: number;
  rawResponse?: unknown;
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
    message: `POST ${apiEndpoint}/policy/create`,
    status: "info",
  });

  // Simulate network latency
  await new Promise((r) => setTimeout(r, 500));

  // Generate a mock policy number (replace with real API response parsing)
  const policyNumber = `${providerCode}-API-${Date.now().toString(36).toUpperCase()}`;

  logs.push({
    step: "execution_api",
    message: `API responded 200 OK`,
    status: "info",
  });

  logs.push({
    step: "finalization",
    message: `Policy issued via API: ${policyNumber} for ${payload.ownerKyc.fullName}`,
    status: "success",
  });

  return {
    success: true,
    policyNumber,
    httpStatus: 200,
    rawResponse: { policyNumber, vehicleMake: payload.vehicleDetails.make },
    logs,
  };
}
