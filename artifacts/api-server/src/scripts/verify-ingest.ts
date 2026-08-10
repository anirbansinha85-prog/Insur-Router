/**
 * OBJ-24's done-when, onboarded three ways.
 *
 * > *The same dealership can be onboarded three ways, every field carries its
 * > source and confidence, a second file of the same report type needs no model
 * > call, and nothing downstream can tell which path a value arrived by.*
 *
 * The fourth claim is the one worth being strict about, so it is proved the
 * strict way: the export below is generated **from the mirror itself**, which
 * is exactly what a dealer's own system would produce, and after the report
 * path has rewritten every row the projected columns are compared against what
 * the API left there. Not *similar*. Identical, field by field, or the check
 * fails and names the field.
 *
 * The dealership is put back on the API path at the end, so this is safe to run
 * against the working showroom and leaves it as it found it.
 *
 * `pnpm run verify:ingest`.
 */

import {
  ownerDb,
  withWorkerScope,
  dmsDealsTable,
  ingestSourcesTable,
  ingestMappingsTable,
  ingestBatchesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  dropReport,
  confirmMapping,
  describeSources,
  setPath,
  pathFor,
  matchByName,
  mappingFor,
  parseTable,
  fingerprintOf,
  toDate,
  toAmount,
  rememberDocumentRecord,
  listBatches,
  FRESHNESS,
  type DealRecord,
} from "../lib/dms/ingest";
import { syncShowroom } from "../lib/dms/sync";

const OWNER = 1;
const SHOWROOM = 1;
const DEALER = "HMC-DL-0417";
/** Anirban, who is the person doing the confirming. */
const CONFIRMER = { id: 1, name: "Anirban Sinha" };

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

function section(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

/** The projected columns, which are the only thing anything downstream reads. */
const COLUMNS = [
  "status",
  "bookingDate",
  "plannedDeliveryDate",
  "actualDeliveryDate",
  "customerName",
  "customerMobile",
  "modelDescription",
  "chassisNo",
  "engineNo",
  "exShowroomAmount",
  "dmsPolicyNo",
  "dmsInsurerCode",
  "dmsRegNo",
  "invoiceNo",
  "invoiceDate",
] as const;

async function mirror(): Promise<Map<string, Record<string, unknown>>> {
  const rows = await ownerDb
    .select()
    .from(dmsDealsTable)
    .where(eq(dmsDealsTable.dealerCode, DEALER));
  return new Map(rows.map((r) => [r.dealId, r as unknown as Record<string, unknown>]));
}

/** Tidy on the CLI credential, exactly as OBJ-22 and OBJ-23 do. */
async function reset(): Promise<void> {
  await ownerDb.delete(ingestBatchesTable).where(eq(ingestBatchesTable.showroomId, SHOWROOM));
  await ownerDb.delete(ingestMappingsTable).where(eq(ingestMappingsTable.showroomId, SHOWROOM));
  await ownerDb.delete(ingestSourcesTable).where(eq(ingestSourcesTable.showroomId, SHOWROOM));
}

await reset();

/*
 * Put the outlet back on the API before starting, not only after finishing.
 *
 * A run that dies half way — the mock DMS down, a dropped connection — leaves
 * the dealership fed by report, and the next run's very first assertion would
 * then fail for a reason that has nothing to do with the code. A verifier that
 * only tidies up on the happy path is a verifier that starts lying the first
 * time something goes wrong.
 */
await withWorkerScope(async () => {
  await syncShowroom(SHOWROOM);
});

/*
 * Two credentials, because two different things are happening.
 *
 * **A person drops a file.** That is a request, on `ddms_app`, and in a script
 * it runs unscoped on the CLI credential — somebody who already has the
 * password. **The scheduler syncs.** That is `ddms_worker`, with nobody signed
 * in, and it is where the report actually reaches the mirror.
 *
 * The first version of this ran the whole thing as the worker and was refused
 * at the first insert. That refusal was right and is now check 3b: a mapping is
 * what a *person* said the columns mean, and an unattended process able to
 * propose and then use its own mapping would be the model deciding, which is
 * exactly what the confirmation step exists to prevent.
 */
await (async () => {
  section("1. the dealership as it stands: the API path");

  const path0 = await pathFor(SHOWROOM, "DEAL");
  check(
    "an outlet nobody has configured is on the API",
    path0 === "API",
    "which is what makes changing the sync safe — the default is what it always did",
  );

  const viaApi = await mirror();
  check("the mirror holds the dealership's book", viaApi.size > 0, `${viaApi.size} deals`);
  const allApi = [...viaApi.values()].every((r) => r["ingestPath"] === "API");
  check("and every row says the API put it there", allApi);

  /*
   * The export a dealer would actually send.
   *
   * Generated from the mirror, with the headings and formats an Indian DMS
   * writes — `dd/mm/yyyy`, `₹ 1,24,500.00`, a title row above the headings, and
   * a total line at the bottom. Generating it from the mirror is what makes the
   * comparison at the end strict: any difference in the result is the report
   * path's doing, not a difference in the underlying data.
   */
  const dmy = (iso: unknown): string => {
    if (typeof iso !== "string") return "";
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  };
  const rupees = (n: unknown): string =>
    typeof n === "number" ? `₹ ${n.toLocaleString("en-IN")}` : "";

  const HEADINGS = [
    "Deal No",
    "Deal Status",
    "Booking Date",
    "Promised Date",
    "Delivery Date",
    "Customer Name",
    "Mobile No",
    "Model",
    "Chassis No",
    "Engine No",
    "Ex Showroom",
    "Policy No",
    "Insurance Co",
    "Registration No",
    "Invoice No",
    "Invoice Date",
  ];

  const q = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function exportOf(deals: Array<Record<string, unknown>>, title: string): string {
    const lines = [
      `Deal Register — ${title}`,
      "",
      HEADINGS.join(","),
      ...deals.map((r) =>
        [
          q(r["dealId"]),
          q(r["status"]),
          dmy(r["bookingDate"]),
          dmy(r["plannedDeliveryDate"]),
          dmy(r["actualDeliveryDate"]),
          q(r["customerName"]),
          q(r["customerMobile"]),
          q(r["modelDescription"]),
          q(r["chassisNo"]),
          q(r["engineNo"]),
          q(rupees(r["exShowroomAmount"])),
          q(r["dmsPolicyNo"]),
          q(r["dmsInsurerCode"]),
          q(r["dmsRegNo"]),
          q(r["invoiceNo"]),
          dmy(r["invoiceDate"]),
        ].join(","),
      ),
      // The total line every export ends with, and the row that has no deal
      // number. It must be rejected with a reason rather than skipped.
      `Total,,,,,,,,,,${deals.length} deals,,,,,`,
    ];
    return lines.join("\r\n");
  }

  const file1 = exportOf([...viaApi.values()], "01/07/2026 to 31/07/2026");

  section("2. the file is read, and its shape has never been seen");

  const table = parseTable(file1);
  check(
    "the title row above the headings did not become the headings",
    table.headings.length === 16,
    `${table.headings.length} columns: ${table.headings.slice(0, 4).join(" · ")}…`,
  );
  check("and the rows beneath were found", table.rows.length === viaApi.size + 1, `${table.rows.length} rows including the total line`);

  const byName = matchByName(table.headings);
  console.log(`      matched by name without a model: ${Object.keys(byName).length} of 16`);
  for (const [field, m] of Object.entries(byName).slice(0, 3)) {
    console.log(`        ${field.padEnd(20)} ← ${m.column}`);
  }

  const first = await dropReport({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    dataType: "DEAL",
    filename: "deal-register-jul-2026.csv",
    text: file1,
    userId: CONFIRMER.id,
    userName: CONFIRMER.name,
  });
  if (!first.ok) throw new Error(`first drop refused: ${first.error}`);

  check(
    "an unknown shape is HELD, not partly imported",
    first.result.batch.status === "PENDING_MAPPING",
    "an import that quietly did nothing is the worst of the three outcomes",
  );
  check("nothing was extracted from an unconfirmed mapping", first.result.rowsAccepted === 0);
  check("no required field is unplaced", first.result.gaps.length === 0, first.result.gaps.join(", ") || "dealId and status both found");

  section("3. a person says what the columns mean, once");

  const confirmed = await confirmMapping({
    id: first.result.mapping.id,
    userId: CONFIRMER.id,
    userName: CONFIRMER.name,
  });
  check("confirmed, and it is a person's name on it", confirmed?.confirmedByName === CONFIRMER.name);

  const second = await dropReport({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    dataType: "DEAL",
    filename: "deal-register-aug-2026.csv",
    // The same book with a different heading line above it, so the bytes differ
    // and this is a genuinely new file of the same *shape*. Dropping a deal
    // instead would have been a smaller file and a correct disappearance, which
    // is a different thing to test.
    text: exportOf([...viaApi.values()], "01/08/2026 to 10/08/2026"),
    userId: CONFIRMER.id,
    userName: CONFIRMER.name,
  });
  if (!second.ok) throw new Error(`second drop refused: ${second.error}`);

  check(
    "a second file of the same shape needed NO model call",
    second.result.usedModel === false && second.result.wasKnown === true,
    "model cost is per report type per dealer, not per row",
  );
  check("and it extracted straight away", second.result.rowsAccepted === viaApi.size, `${second.result.rowsAccepted} of ${second.result.rowsSeen} rows`);
  check(
    "the total line was rejected with a reason, not silently skipped",
    second.result.rowsRejected === 1 && second.result.rejections[0]!.includes("not a deal"),
    second.result.rejections[0] ?? "nothing rejected — the footer became a deal",
  );

  const dup = await dropReport({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    dataType: "DEAL",
    filename: "deal-register-jul-2026.csv",
    text: file1,
    userId: CONFIRMER.id,
    userName: CONFIRMER.name,
  });
  check("the same file dropped twice is the same drop", !dup.ok && dup.status === 409);

  section("3a. a shape the name matches cannot read is proposed once, then reused");

  /*
   * The tidy export above was matched 16 of 16 by name and never needed a
   * model at all — which is worth knowing and is not the claim. This is the
   * claim: an export whose headings mean nothing to a string match is worked
   * out **once**, and the second encounter with the same shape reuses it
   * whatever happened the first time.
   *
   * Asserted on the mechanism rather than on the model succeeding, because a
   * missing key, a rate limit and a refusal must all end the same way — a
   * person maps it by hand, once, and it is fixed thereafter.
   */
  const OPAQUE = ["ORD_REF", "STG_CD", "PTY_NM", "VEH_DESC", "CHS", "AMT_EXSH", "DT_BKG"];
  const placedByName = Object.keys(matchByName(OPAQUE)).length;
  console.log(`      name matching places ${placedByName} of these 7 headings`);

  const firstLook = await mappingFor({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    dataType: "DEAL",
    headings: OPAQUE,
  });
  console.log(
    `      first encounter: proposed by ${firstLook.row.proposedBy}` +
      `${firstLook.row.proposedByModel ? ` (${firstLook.row.proposedByModel})` : ""}, ` +
      `${Object.keys(firstLook.row.mapping).length} fields placed`,
  );
  check("the first encounter created a proposal", firstLook.wasKnown === false);

  const secondLook = await mappingFor({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    dataType: "DEAL",
    headings: OPAQUE,
  });
  check(
    "the second encounter called no model at all",
    secondLook.usedModel === false && secondLook.row.id === firstLook.row.id,
    "one call per report type per dealer, whatever the first one cost",
  );
  check(
    "and it is still unusable until a person confirms it",
    secondLook.row.status === "PROPOSED" && secondLook.wasKnown === false,
    "a model reads headings; a person decides what they mean",
  );

  section("3b. the scheduler may read a mapping and may never make one");

  /*
   * The refusal that broke the first version of this script, kept as a check
   * because it is a guarantee rather than an obstacle.
   *
   * `ddms_worker` holds select and update on `ingest_mappings` and **not
   * insert**. A model proposes and a person confirms; an unattended process
   * that could do both would have quietly removed the person from the only step
   * where R-49 applies to onboarding.
   */
  let workerProposed = false;
  await withWorkerScope(async () => {
    try {
      await mappingFor({
        ownerId: OWNER,
        showroomId: SHOWROOM,
        dataType: "DEAL",
        headings: ["Some", "Shape", "Nobody", "Has", "Seen"],
      });
      workerProposed = true;
    } catch {
      workerProposed = false;
    }
  });
  check(
    "refused",
    !workerProposed,
    "select and update, never insert — a mapping is what a person said the columns mean",
  );

  section("4. a different shape is a different mapping");

  const widened = file1.replace("Invoice Date", "Invoice Date,Dealer Discount");
  check(
    "adding a column produces a new fingerprint",
    fingerprintOf(parseTable(widened).headings) !== fingerprintOf(table.headings),
    "a changed export is a changed export — reusing the old mapping is how a column shifts one place",
  );

  section("5. the report path fills the mirror, and nothing downstream can tell");

  await setPath({ ownerId: OWNER, showroomId: SHOWROOM, dataType: "DEAL", path: "REPORT" });
  check("the outlet is now fed by report", (await pathFor(SHOWROOM, "DEAL")) === "REPORT");
  console.log(`      freshness is "${FRESHNESS.REPORT}", and the screen says so rather than showing a sync time`);

  // The sync is the scheduler's, with nobody signed in — which is the whole
  // point of the report path: the dealer drops a file on Friday and the mirror
  // fills itself thereafter.
  await withWorkerScope(async () => {
    await syncShowroom(SHOWROOM);
  });
  const viaReport = await mirror();

  check("the same deals are there", viaReport.size === viaApi.size, `${viaReport.size} vs ${viaApi.size}`);
  check(
    "and none of them disappeared",
    [...viaReport.values()].every((r) => r["disappearedAt"] === null),
  );

  /*
   * The strict comparison. Every projected column, every deal.
   *
   * This is R-84 as an assertion rather than an intention: the seven
   * classifiers, the queue, the journey runtime and the invoice that is coming
   * all read these columns and nothing else, so if they match, nothing
   * downstream can tell which path filled them.
   */
  const differences: string[] = [];
  for (const [dealId, apiRow] of viaApi) {
    const reportRow = viaReport.get(dealId);
    if (!reportRow) {
      differences.push(`${dealId}: missing from the report path`);
      continue;
    }
    for (const col of COLUMNS) {
      const a = apiRow[col] ?? null;
      const b = reportRow[col] ?? null;
      if (a !== b) differences.push(`${dealId}.${col}: API ${JSON.stringify(a)} vs report ${JSON.stringify(b)}`);
    }
  }
  check(
    `every projected column of all ${viaApi.size} deals is identical`,
    differences.length === 0,
    differences.slice(0, 5).join("\n      "),
  );

  section("6. every field says where it came from, and how sure");

  const sample = [...viaReport.values()][0]!;
  check("the row records the path", sample["ingestPath"] === "REPORT");
  check("and the drop it came from", typeof sample["ingestBatchId"] === "number");

  const conf = sample["fieldConfidence"] as Record<string, number> | null;
  check(
    "and carries a confidence per field, below certainty",
    Boolean(conf) && Object.values(conf!).every((c) => c > 0 && c < 1),
    conf ? Object.entries(conf).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(" · ") : "none",
  );
  check(
    "the API rows carried none, because an API field is not in doubt",
    ([...viaApi.values()][0]!["fieldConfidence"] ?? null) === null,
    "sparse on purpose — a megabyte of 1.0s asserts nothing",
  );

  section("7. a scanned invoice is partial, and must not erase what it omits");

  const target = [...viaReport.values()].find(
    (r) => r["dmsPolicyNo"] && r["dmsRegNo"] && r["invoiceNo"],
  )!;
  const dealId = String(target["dealId"]);
  const policyBefore = target["dmsPolicyNo"];
  const regBefore = target["dmsRegNo"];

  /*
   * What an invoice PDF actually carries: the deal, the customer, the model,
   * the chassis and the price. It says nothing at all about the policy or the
   * registration, and the whole test is that the two survive.
   */
  const scanned: DealRecord = {
    dealId,
    status: String(target["status"]),
    bookingDate: null,
    plannedDeliveryDate: null,
    actualDeliveryDate: null,
    customerName: String(target["customerName"] ?? ""),
    customerMobile: null,
    modelDescription: String(target["modelDescription"] ?? ""),
    chassisNo: String(target["chassisNo"] ?? ""),
    engineNo: null,
    exShowroomAmount: toAmount(String(target["exShowroomAmount"] ?? "")),
    dmsPolicyNo: null,
    dmsInsurerCode: null,
    dmsRegNo: null,
    invoiceNo: String(target["invoiceNo"]),
    invoiceDate: toDate(String(target["invoiceDate"] ?? "")),
    raw: { source: "scanned invoice" },
  };

  const contentHash = `verify-scan-${dealId}`;
  rememberDocumentRecord(contentHash, scanned, {
    customerName: 0.82,
    chassisNo: 0.74,
    exShowroomAmount: 0.91,
  });
  await ownerDb.insert(ingestBatchesTable).values({
    ownerId: OWNER,
    showroomId: SHOWROOM,
    dataType: "DEAL",
    path: "DOCUMENT",
    filename: `invoice-${dealId}.pdf`,
    contentHash,
    rowsSeen: 1,
    rowsAccepted: 1,
    status: "ACCEPTED",
    uploadedByUserId: CONFIRMER.id,
    uploadedByName: CONFIRMER.name,
  });

  await setPath({ ownerId: OWNER, showroomId: SHOWROOM, dataType: "DEAL", path: "DOCUMENT" });
  await withWorkerScope(async () => {
    await syncShowroom(SHOWROOM);
  });
  const viaDocument = await mirror();

  check(
    "the whole book did NOT disappear because one sheet of paper was scanned",
    [...viaDocument.values()].every((r) => r["disappearedAt"] === null),
    "listIsComplete is false for documents, and that is the check that saves it",
  );
  check("every deal is still there", viaDocument.size === viaApi.size, `${viaDocument.size}`);

  const after = viaDocument.get(dealId)!;
  check("the invoice reached the row", after["ingestPath"] === "DOCUMENT");
  check(
    "and the policy it never mentioned survived",
    after["dmsPolicyNo"] === policyBefore,
    `${policyBefore} → ${after["dmsPolicyNo"]}`,
  );
  check(
    "as did the registration number",
    after["dmsRegNo"] === regBefore,
    `${regBefore} → ${after["dmsRegNo"]}`,
  );
  const scanConf = after["fieldConfidence"] as Record<string, number> | null;
  check(
    "and the scan's own confidence is on the row",
    scanConf?.["chassisNo"] === 0.74,
    scanConf ? JSON.stringify(scanConf) : "none",
  );

  section("8. the audit trail, and the way back");

  const batches = await listBatches(SHOWROOM);
  console.log(`      ${batches.length} drops recorded:`);
  for (const b of batches.slice(0, 4)) {
    console.log(
      `        ${b.path.padEnd(9)} ${(b.filename ?? "").padEnd(34)} ${b.status.padEnd(16)} ` +
        `${b.rowsAccepted}/${b.rowsSeen} rows · ${b.uploadedByName}`,
    );
  }
  check("every drop is answerable for", batches.length >= 3);

  const sources = await describeSources(SHOWROOM);
  console.log(`      the outlet, per kind of data:`);
  for (const s of sources) {
    console.log(`        ${s.dataType.padEnd(13)} ${s.path.padEnd(9)} ${FRESHNESS[s.path]}`);
  }
  check(
    "the six kinds nobody configured are still on the API",
    sources.filter((s) => s.dataType !== "DEAL").every((s) => s.path === "API"),
    "enabled per data type per dealer, not per dealer",
  );
})();

// ── Put the dealership back ─────────────────────────────────────────────────

section("9. back on the API, and the mirror is as it was");

await setPath({ ownerId: OWNER, showroomId: SHOWROOM, dataType: "DEAL", path: "API" });
await withWorkerScope(async () => {
  await syncShowroom(SHOWROOM);
});

await (async () => {
  const restored = await mirror();
  const allApi = [...restored.values()].every((r) => r["ingestPath"] === "API");
  check("every row says the API again", allApi, `${restored.size} deals`);
  check(
    "and the confidence maps are gone with it",
    [...restored.values()].every((r) => (r["fieldConfidence"] ?? null) === null),
  );
})();

await reset();
console.log("  (the drops, mappings and source setting removed, on the CLI credential)");

console.log(
  failures === 0
    ? "\nAll checks passed. Three ways in, one record, and nothing downstream can tell.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
