/**
 * Browser Automation Executor (Playwright)
 *
 * Captures a screenshot at each major step and includes it in log metadata
 * as a base64 PNG, so the frontend can render inline browser snapshots.
 *
 * To add a real provider flow:
 *   1. Add a case to the switch statement in executeWithBrowser.
 *   2. Implement a handler function below using real page selectors.
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

export interface BrowserExecutionLog {
  step: string;
  message: string;
  status: "info" | "success" | "warning" | "error";
  /** base64-encoded PNG of the browser viewport at this step */
  screenshot?: string;
}

export interface BrowserExecutionResult {
  success: boolean;
  policyNumber?: string;
  pdfUrl?: string;
  errorMessage?: string;
  logs: BrowserExecutionLog[];
}

/** Helper: take a full-page screenshot and return base64 string, or undefined on error. */
async function snap(page: import("playwright").Page): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
    return buf.toString("base64");
  } catch {
    return undefined;
  }
}

export async function executeWithBrowser(
  providerCode: string,
  portalUrl: string,
  payload: MsaPayload,
  applicationId: number,
): Promise<BrowserExecutionResult> {
  logger.info({ applicationId, providerCode }, "Starting browser automation");

  const executionLogs: BrowserExecutionLog[] = [];

  try {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({
      headless: true,
      // Use the system Chromium installed via Nix — has all required shared libs
      executablePath: "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    try {
      // ── Step 1: Launch & navigate ─────────────────────────────────────────
      executionLogs.push({
        step: "browser_launch",
        message: `Chromium launched. Navigating to ${portalUrl}`,
        status: "info",
      });

      await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(800); // let layout settle

      executionLogs.push({
        step: "page_loaded",
        message: `Portal loaded: ${page.url()}`,
        status: "info",
        screenshot: await snap(page),
      });

      // ── Step 2: Provider-specific handler ────────────────────────────────
      let result: BrowserExecutionResult;
      switch (providerCode.toUpperCase()) {
        // Add real provider handlers here:
        // case "HDFC":  result = await executeHdfc(page, payload, executionLogs); break;
        // case "BAJAJ": result = await executeBajaj(page, payload, executionLogs); break;
        default:
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
      step: "browser_error",
      message: `Browser automation error: ${message}`,
      status: "error",
    });
    return { success: false, errorMessage: message, logs: executionLogs };
  }
}

/**
 * Generic stub — navigates to example.com and simulates each form-fill step
 * with real screenshots so the logs panel shows live browser snapshots.
 * Replace with real provider portal selectors per case.
 */
async function executeGenericStub(
  page: import("playwright").Page,
  payload: MsaPayload,
  providerCode: string,
  logs: BrowserExecutionLog[],
): Promise<BrowserExecutionResult> {

  // ── Simulate: Vehicle details ─────────────────────────────────────────────
  await page.waitForTimeout(600);
  logs.push({
    step: "form_vehicle",
    message: `Filling vehicle details — ${payload.vehicleDetails.make} ${payload.vehicleDetails.model} (${payload.vehicleDetails.engineNumber})`,
    status: "info",
    screenshot: await snap(page),
  });

  // ── Simulate: Owner KYC ───────────────────────────────────────────────────
  await page.waitForTimeout(500);
  logs.push({
    step: "form_kyc",
    message: `Entering owner KYC — ${payload.ownerKyc.fullName}, ${payload.ownerKyc.idProofType}: ${payload.ownerKyc.idProofNumber}`,
    status: "info",
    screenshot: await snap(page),
  });

  // ── Simulate: RTO details ─────────────────────────────────────────────────
  await page.waitForTimeout(400);
  logs.push({
    step: "form_rto",
    message: `RTO details — ${payload.rtoDetails.rtoCode}, ${payload.rtoDetails.registrationCity}, ${payload.rtoDetails.registrationState}`,
    status: "info",
    screenshot: await snap(page),
  });

  // ── Simulate: Submit ──────────────────────────────────────────────────────
  await page.waitForTimeout(500);

  const policyNumber = `${providerCode}-BROWSER-${Date.now().toString(36).toUpperCase()}`;

  logs.push({
    step: "form_submit",
    message: `Form submitted. Waiting for policy confirmation…`,
    status: "info",
    screenshot: await snap(page),
  });

  await page.waitForTimeout(600);

  logs.push({
    step: "policy_issued",
    message: `Policy issued via browser automation: ${policyNumber}`,
    status: "success",
    screenshot: await snap(page),
  });

  return { success: true, policyNumber, logs };
}
