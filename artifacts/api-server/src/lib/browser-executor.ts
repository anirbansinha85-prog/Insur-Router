/**
 * Browser Automation Executor (Playwright)
 *
 * This module handles headless browser-based insurance application submission.
 * Each provider's browser flow is implemented in its own handler function.
 *
 * To add a new provider's browser flow:
 *   1. Add a case to the `executeWithBrowser` switch statement.
 *   2. Implement the handler function below, using the providerCode to identify
 *      the portal URL and DOM selectors.
 *
 * NOTE: This is a stub implementation. Replace the mock logic in each provider
 * handler with real Playwright selectors for the provider's dealer portal.
 */

import { logger } from "./logger";

export interface MsaPayload {
  vehicleDetails: {
    make: string;
    model: string;
    variant: string;
    engineNumber: string;
    chassisNumber: string;
    exShowroomPrice: number;
    dateOfPurchase: string;
  };
  ownerKyc: {
    fullName: string;
    billingAddress: string;
    pincode: number;
    phoneNumber: string;
    email: string;
    dateOfBirth: string;
    idProofType: string;
    idProofNumber: string;
  };
  rtoDetails: {
    registrationCity: string;
    registrationState: string;
    rtoCode: string;
  };
}

export interface BrowserExecutionResult {
  success: boolean;
  policyNumber?: string;
  pdfUrl?: string;
  errorMessage?: string;
  logs: Array<{ step: string; message: string; status: "info" | "success" | "warning" | "error" }>;
}

/**
 * Execute an insurance application via headless browser automation.
 *
 * @param providerCode - Short provider code (e.g. "HDFC", "BAJAJ")
 * @param portalUrl - The dealer portal URL to navigate to
 * @param payload - The validated MSA payload
 * @param applicationId - For logging context
 */
export async function executeWithBrowser(
  providerCode: string,
  portalUrl: string,
  payload: MsaPayload,
  applicationId: number,
): Promise<BrowserExecutionResult> {
  logger.info({ applicationId, providerCode }, "Starting browser automation");

  const executionLogs: BrowserExecutionResult["logs"] = [];

  try {
    // Dynamically import Playwright to avoid startup cost when not needed
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    executionLogs.push({
      step: "execution_browser",
      message: `Browser launched. Navigating to ${portalUrl}`,
      status: "info",
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    try {
      await page.goto(portalUrl, { waitUntil: "networkidle", timeout: 30000 });

      executionLogs.push({
        step: "execution_browser",
        message: `Portal loaded: ${portalUrl}`,
        status: "info",
      });

      // Route to provider-specific handler
      let result: BrowserExecutionResult;
      switch (providerCode.toUpperCase()) {
        // ── Add real provider browser handlers here ──────────────────────────
        // case "HDFC":
        //   result = await executeHdfc(page, payload, executionLogs);
        //   break;
        // case "BAJAJ":
        //   result = await executeBajaj(page, payload, executionLogs);
        //   break;
        // ─────────────────────────────────────────────────────────────────────

        default:
          // Generic stub — replace with real selectors for each provider
          result = await executeGenericStub(page, payload, providerCode, executionLogs);
          break;
      }

      return result;
    } finally {
      await context.close();
      await browser.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ applicationId, providerCode, err }, "Browser automation failed");
    executionLogs.push({
      step: "execution_browser",
      message: `Browser automation error: ${message}`,
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
 * Generic stub handler — simulates a successful submission.
 * Replace this with real Playwright DOM interactions per provider portal.
 */
async function executeGenericStub(
  _page: import("playwright").Page,
  payload: MsaPayload,
  providerCode: string,
  logs: BrowserExecutionResult["logs"],
): Promise<BrowserExecutionResult> {
  logs.push({
    step: "execution_browser",
    message: `Filling vehicle details for ${payload.vehicleDetails.make} ${payload.vehicleDetails.model}`,
    status: "info",
  });

  // Simulate portal interaction time
  await new Promise((r) => setTimeout(r, 800));

  logs.push({
    step: "execution_browser",
    message: `Owner KYC entered for ${payload.ownerKyc.fullName}`,
    status: "info",
  });

  await new Promise((r) => setTimeout(r, 600));

  logs.push({
    step: "execution_browser",
    message: `RTO details filled: ${payload.rtoDetails.rtoCode}`,
    status: "info",
  });

  await new Promise((r) => setTimeout(r, 400));

  // Generate a mock policy number (replace with actual page scraping)
  const policyNumber = `${providerCode}-BROWSER-${Date.now().toString(36).toUpperCase()}`;

  logs.push({
    step: "finalization",
    message: `Policy issued via browser automation: ${policyNumber}`,
    status: "success",
  });

  return {
    success: true,
    policyNumber,
    pdfUrl: undefined,
    logs,
  };
}
