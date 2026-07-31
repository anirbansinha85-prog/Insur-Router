/**
 * Pincode → RTO derivation.
 *
 * For a new vehicle the RTO is **not a fact to read** — it is derived from
 * where the owner lives, because that is where the vehicle gets registered.
 * There is no registration certificate to copy it off: the RTO will not issue
 * one until a policy exists. So the DMS supplies an address and this table
 * turns it into the `rtoCode` the proposal asks for.
 *
 * SCOPE — read this before trusting an answer.
 *
 * India has roughly 1,400 RTO codes and about 19,000 pincodes, and the mapping
 * is genuinely many-to-one and occasionally ambiguous: a large city has several
 * RTOs, and which one a vehicle lands at can depend on the dealer's jurisdiction
 * rather than the buyer's street. This table is a **starter set** covering the
 * seeded dealers' regions and the major metros, keyed on the first three digits
 * of the pincode (the sorting-district prefix, which is the level at which the
 * mapping is stable).
 *
 * It is deliberately incomplete, and a miss is reported as a miss. Returning a
 * plausible guess would put an unverifiable RTO code onto an insurance
 * proposal, which is the same defect as the fabricated DMS record this module
 * replaced. When the prefix is unknown the caller gets `null` and must ask.
 *
 * Replacing this with a full dataset is a data task, not a code change — the
 * lookup below does not care how many rows it holds.
 */

export interface RtoLookup {
  rtoCode: string;
  city: string;
  state: string;
}

/**
 * Keyed on the first three digits of the pincode. Where a district spans
 * several RTOs, the entry is the one that serves the bulk of it — good enough
 * to pre-fill, and the field stays editable for exactly that reason.
 */
const RTO_BY_PIN_PREFIX: Record<string, RtoLookup> = {
  // ── Delhi ────────────────────────────────────────────────────────────────
  "110": { rtoCode: "DL01", city: "New Delhi", state: "Delhi" },

  // ── Haryana (NCR belt the Delhi dealer sells into) ───────────────────────
  "121": { rtoCode: "HR51", city: "Faridabad", state: "Haryana" },
  "122": { rtoCode: "HR26", city: "Gurugram", state: "Haryana" },
  "124": { rtoCode: "HR12", city: "Rohtak", state: "Haryana" },
  "132": { rtoCode: "HR06", city: "Karnal", state: "Haryana" },
  "133": { rtoCode: "HR07", city: "Ambala", state: "Haryana" },
  "134": { rtoCode: "HR03", city: "Panchkula", state: "Haryana" },

  // ── Uttar Pradesh (NCR) ──────────────────────────────────────────────────
  "201": { rtoCode: "UP14", city: "Ghaziabad", state: "Uttar Pradesh" },
  "203": { rtoCode: "UP16", city: "Noida", state: "Uttar Pradesh" },
  "226": { rtoCode: "UP32", city: "Lucknow", state: "Uttar Pradesh" },

  // ── Maharashtra ──────────────────────────────────────────────────────────
  "400": { rtoCode: "MH01", city: "Mumbai", state: "Maharashtra" },
  "410": { rtoCode: "MH46", city: "Panvel", state: "Maharashtra" },
  "411": { rtoCode: "MH12", city: "Pune", state: "Maharashtra" },
  "412": { rtoCode: "MH14", city: "Pimpri-Chinchwad", state: "Maharashtra" },
  "413": { rtoCode: "MH13", city: "Solapur", state: "Maharashtra" },
  "422": { rtoCode: "MH15", city: "Nashik", state: "Maharashtra" },
  "440": { rtoCode: "MH31", city: "Nagpur", state: "Maharashtra" },

  // ── Karnataka ────────────────────────────────────────────────────────────
  "560": { rtoCode: "KA01", city: "Bengaluru", state: "Karnataka" },
  "570": { rtoCode: "KA09", city: "Mysuru", state: "Karnataka" },

  // ── Tamil Nadu ───────────────────────────────────────────────────────────
  "600": { rtoCode: "TN01", city: "Chennai", state: "Tamil Nadu" },
  "641": { rtoCode: "TN37", city: "Coimbatore", state: "Tamil Nadu" },

  // ── Telangana ────────────────────────────────────────────────────────────
  "500": { rtoCode: "TS09", city: "Hyderabad", state: "Telangana" },

  // ── West Bengal ──────────────────────────────────────────────────────────
  "700": { rtoCode: "WB02", city: "Kolkata", state: "West Bengal" },

  // ── Gujarat ──────────────────────────────────────────────────────────────
  "380": { rtoCode: "GJ01", city: "Ahmedabad", state: "Gujarat" },
  "395": { rtoCode: "GJ05", city: "Surat", state: "Gujarat" },

  // ── Rajasthan ────────────────────────────────────────────────────────────
  "302": { rtoCode: "RJ14", city: "Jaipur", state: "Rajasthan" },
};

/**
 * Derive the RTO from a pincode. Returns null when the prefix is not in the
 * table — the honest answer, and the one that makes the UI ask.
 */
export function rtoForPincode(pincode: string | number | null | undefined): RtoLookup | null {
  if (pincode === null || pincode === undefined) return null;
  const digits = String(pincode).replace(/\D/g, "");
  if (digits.length !== 6) return null;
  return RTO_BY_PIN_PREFIX[digits.slice(0, 3)] ?? null;
}

/** Number of prefixes covered — surfaced in logs so the gap stays visible. */
export const RTO_TABLE_SIZE = Object.keys(RTO_BY_PIN_PREFIX).length;
