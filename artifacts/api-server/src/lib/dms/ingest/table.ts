/**
 * Reading a dealer's spreadsheet, and deciding whether we have seen its shape
 * before.
 *
 * Deliberately small and deliberately not a CSV library. What arrives here is
 * an export from an Indian dealership's DMS — comma or tab separated, quoted
 * inconsistently, occasionally with a title row above the headings — and the
 * failure modes worth handling are the ones that actually occur. A dependency
 * would handle RFC 4180 edge cases nobody has and still not handle the title
 * row.
 */

import { createHash } from "node:crypto";

export interface Table {
  headings: string[];
  rows: Array<Record<string, string>>;
  /** Which separator was found, for the message when a file reads as one column. */
  delimiter: "," | "\t" | ";";
}

/**
 * The heading line is the widest of the first few, not the first.
 *
 * Exports routinely open with a title and a blank line — *Deal Register
 * 01/07/2026 to 31/07/2026*, then nothing, then the headings. Taking line one
 * gives a single-column table and a mapping that can place nothing, which
 * reads to the dealer as *your product cannot open my file*.
 */
function findHeadingLine(lines: string[], delimiter: string): number {
  let best = 0;
  let bestCount = 0;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const count = splitLine(lines[i]!, delimiter).filter((c) => c.trim()).length;
    if (count > bestCount) {
      bestCount = count;
      best = i;
    }
  }
  return best;
}

/** One line, respecting double quotes. Nothing more clever than that. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted cell is one literal quote.
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

function pickDelimiter(sample: string): "," | "\t" | ";" {
  const counts: Array<["," | "\t" | ";", number]> = [
    [",", (sample.match(/,/g) ?? []).length],
    ["\t", (sample.match(/\t/g) ?? []).length],
    [";", (sample.match(/;/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

export function parseTable(text: string): Table {
  // A byte-order mark on the first heading makes it not match anything, and
  // Excel writes one every time.
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headings: [], rows: [], delimiter: "," };

  const delimiter = pickDelimiter(lines.slice(0, 5).join("\n"));
  const headingAt = findHeadingLine(lines, delimiter);
  const headings = splitLine(lines[headingAt]!, delimiter).filter((h) => h.length > 0);

  const rows: Array<Record<string, string>> = [];
  for (let i = headingAt + 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!, delimiter);
    // A trailing total line has fewer cells than headings and no key. Kept
    // rather than dropped here — the mapping decides, because *this row has no
    // deal number* is a rejection with a reason and a silent skip is not.
    const row: Record<string, string> = {};
    headings.forEach((h, n) => {
      row[h] = cells[n] ?? "";
    });
    rows.push(row);
  }

  return { headings, rows, delimiter };
}

/**
 * Two exports have the same shape when they have the same headings.
 *
 * Sorted and normalised, so column order and casing do not produce a second
 * mapping for a file the dealer would call the same thing. **Adding a column
 * does** produce a new fingerprint and one more confirmation, and that is
 * correct rather than annoying: a changed export is a changed export, and
 * quietly reusing yesterday's mapping across it is how a column shifts one
 * place and a month of figures lands under the wrong heading.
 */
export function fingerprintOf(headings: string[]): string {
  const normalised = headings
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort();
  return createHash("sha256").update(normalised.join("")).digest("hex").slice(0, 32);
}

export function hashOfBytes(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// ── Reading a cell into the shape the mirror wants ──────────────────────────

/**
 * Dates, as a dealership writes them.
 *
 * `dd/mm/yyyy` is what every Indian DMS exports and what `Date.parse` reads as
 * American. Getting this wrong is not a parse error — it is 3 July silently
 * becoming 7 March, on every row where the day is twelve or less, and nothing
 * downstream can tell.
 */
export function toDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;

  const dmy = v.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y!.length === 2 ? `20${y}` : y!;
    const month = m!.padStart(2, "0");
    const day = d!.padStart(2, "0");
    if (Number(month) > 12) return null;
    return `${year}-${month}-${day}`;
  }

  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "03-Jul-2026", which SAP-derived exports favour.
  const named = v.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{4})$/);
  if (named) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const m = months.indexOf(named[2]!.toLowerCase());
    if (m >= 0) return `${named[3]}-${String(m + 1).padStart(2, "0")}-${named[1]!.padStart(2, "0")}`;
  }

  return null;
}

/**
 * Money, as a dealership writes it: `₹ 1,24,500.00`, or `124500`, or
 * `1,24,500 Dr`. Indian digit grouping is not the western one, which is why
 * stripping every separator is safer than trying to read the grouping.
 */
export function toAmount(raw: string): number | null {
  const v = raw.replace(/[₹,\s]/g, "").replace(/[A-Za-z]+$/, "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toText(raw: string): string | null {
  const v = raw.trim();
  // A dash is how a spreadsheet writes "nothing", and storing it as a value
  // makes a null column look populated on every screen that reads it.
  if (!v || v === "-" || v === "--" || v.toUpperCase() === "N/A" || v.toUpperCase() === "NULL") {
    return null;
  }
  return v;
}
