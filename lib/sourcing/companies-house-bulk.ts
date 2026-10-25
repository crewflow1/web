/**
 * Companies House FREE Company Data Product — bulk parse / filter / normalize.
 *
 * PURE + DETERMINISTIC + NOT server-only. No I/O, no DB, no network, no LLM —
 * every function here is a total transform over strings/records so the whole
 * eligibility rubric is unit-testable and identical in the Node importer and in
 * tests. The streaming download/decompress + DB upsert live in the importer
 * script (scripts/sourcing/companies-house-bulk-import.ts); this module is the
 * logic it calls per row.
 *
 * Official source (verified Oct 2026):
 *   Product : "Free Company Data Product" (basic data for LIVE companies)
 *   Files   : BasicCompanyDataAsOneFile-YYYY-MM-01.zip  (~470 MB zip, one CSV)
 *             BasicCompanyData-YYYY-MM-01-part{1..7}_7.zip (split variant)
 *   Host    : http://download.companieshouse.gov.uk/<filename>
 *   Cadence : monthly, published within 5 working days of the prior month end;
 *             the filename date is the 1st of the month.
 *   Format  : ZIP → a single UTF-8 CSV with a header row.
 *
 * Column names are mapped BY HEADER at runtime (mapHeader) and REQUIRED columns
 * are asserted present — so correctness binds to the live file, never to a
 * hardcoded column order or a remembered schema.
 */

// Relative (not "@/") so the bulk importer resolves it under a bare `tsx` run
// in GitHub Actions, where the "@/" tsconfig path alias may not be configured.
import { CONSTRUCTION_SIC_SET } from "./construction-sic";

// ---------------------------------------------------------------------------
// CSV — a bounded, streaming-friendly line parser.
// ---------------------------------------------------------------------------

/**
 * Parse ONE CSV record line into fields, honouring double-quoted fields,
 * commas inside quotes, and escaped quotes (`""`). The Basic Company Data CSV
 * never embeds newlines inside a field (addresses are single-line), so a
 * line-at-a-time parse is safe and memory-bounded; callers feed it one
 * `readline` line at a time. Returns trimmed-of-surrounding-quotes fields.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

// ---------------------------------------------------------------------------
// Header mapping — locate the columns we need BY NAME, fail loud if absent.
// ---------------------------------------------------------------------------

/** The columns the pipeline consumes. SIC is up to 4 columns in this product. */
export const SIC_COLUMNS = [
  "SICCode.SicText_1",
  "SICCode.SicText_2",
  "SICCode.SicText_3",
  "SICCode.SicText_4",
] as const;

export const REQUIRED_COLUMNS = [
  "CompanyName",
  "CompanyNumber",
  "CompanyStatus",
  "RegAddress.PostCode",
  "SICCode.SicText_1",
] as const;

/** Optional columns we use when present (never required). */
export const OPTIONAL_COLUMNS = [
  "CompanyCategory",
  "RegAddress.Country",
  "IncorporationDate",
  "SICCode.SicText_2",
  "SICCode.SicText_3",
  "SICCode.SicText_4",
] as const;

export type ColumnIndex = Record<string, number>;

/**
 * Build a header→index map from the CSV header line and ASSERT every required
 * column is present. Throws (loud) on a missing required column so a changed
 * upstream schema aborts the import rather than silently sourcing nothing.
 */
export function mapHeader(headerLine: string): ColumnIndex {
  const cols = parseCsvLine(headerLine);
  const index: ColumnIndex = {};
  cols.forEach((name, i) => {
    // first occurrence wins; CH headers are unique
    if (!(name in index)) index[name] = i;
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in index));
  if (missing.length) {
    throw new Error(
      `Companies House bulk CSV missing required column(s): ${missing.join(", ")}. ` +
        `Header had ${cols.length} columns; the upstream schema may have changed.`,
    );
  }
  return index;
}

function cell(fields: string[], index: ColumnIndex, name: string): string {
  const i = index[name];
  return i === undefined ? "" : (fields[i] ?? "").trim();
}

// ---------------------------------------------------------------------------
// Field logic — SIC, geography, status.
// ---------------------------------------------------------------------------

/**
 * Extract the 5-digit SIC code prefix from a `SICCode.SicText_n` value, which
 * is formatted "41100 - Development of building projects". Returns null when
 * the cell is blank or carries no leading 5-digit code.
 */
export function extractSicCode(sicText: string): string | null {
  const m = sicText.match(/^\s*(\d{5})\b/);
  return m?.[1] ?? null;
}

/** All SIC codes present across the (up to 4) SIC columns of a record. */
export function sicCodesOf(fields: string[], index: ColumnIndex): string[] {
  const out: string[] = [];
  for (const col of SIC_COLUMNS) {
    const code = extractSicCode(cell(fields, index, col));
    if (code) out.push(code);
  }
  return out;
}

/** Construction SIC codes (⊆ allowlist) present on a record. */
export function matchedConstructionSic(sicCodes: string[]): string[] {
  return sicCodes.filter((c) => CONSTRUCTION_SIC_SET.has(c));
}

/**
 * Northern Ireland geography rule — DOCUMENTED, not "every BT is fine":
 *   • The postcode AREA "BT" is the ONLY UK postcode area that lies wholly in
 *     Northern Ireland (BT1–BT94); Great Britain has no BT postcodes. So a
 *     REGISTERED-OFFICE postcode in the BT area ⇒ the registered office is in
 *     Northern Ireland. This is the gate.
 *   • Trade-off we accept (documented): a registered office ≠ a guarantee of
 *     where the company operates, and the (rarer) NI-incorporated company that
 *     uses a GB registered office is NOT captured by this gate. We prefer the
 *     robust registered-office-postcode signal; the company-number "NI"/"R"
 *     incorporation prefix is recorded as corroborating provenance only, never
 *     the gate (it would admit NI-incorporated companies now operating in GB).
 * Match is case/space-insensitive and requires BT followed by a digit so it
 * can't match an unrelated token.
 */
export function isNorthernIrelandPostcode(postcode: string): boolean {
  return /^BT\d/i.test(postcode.replace(/\s+/g, ""));
}

/** Companies House `CompanyStatus` live-trading value. */
export function isActiveStatus(status: string): boolean {
  return status.trim().toLowerCase() === "active";
}

// ---------------------------------------------------------------------------
// Classification + normalization.
// ---------------------------------------------------------------------------

export type EligibilityReason =
  | "active"
  | "ni_registered_office"
  | "construction_sic";

export type ClassifiedRow = {
  companyNumber: string;
  eligible: boolean;
  /** Which gates passed — deterministic reason codes (explainable). */
  reasons: EligibilityReason[];
  /** Why it was rejected, when not eligible (for row-count diagnostics). */
  rejectedBecause: string | null;
  matchedSic: string[];
};

export type NormalizedPoolRow = {
  company_number: string;
  name: string;
  status: string;
  company_category: string | null;
  postcode: string;
  country: string | null;
  incorporation_date: string | null; // ISO yyyy-mm-dd or null
  sic_codes: string[];
  matched_sic: string[];
  geography: "northern_ireland";
  reason_codes: EligibilityReason[];
};

/** Companies House dates in this product are `DD/MM/YYYY`; normalise to ISO. */
export function normaliseChDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Apply the three eligibility gates to a parsed record. Pure: no side effects.
 * A record is eligible iff it is Active AND NI-registered AND has ≥1
 * construction SIC. Returns reason codes for the eligible path and a single
 * rejection cause for diagnostics/row-counts.
 */
export function classifyRecord(fields: string[], index: ColumnIndex): ClassifiedRow {
  const companyNumber = cell(fields, index, "CompanyNumber").toUpperCase();
  const status = cell(fields, index, "CompanyStatus");
  const postcode = cell(fields, index, "RegAddress.PostCode");
  const sic = sicCodesOf(fields, index);
  const matchedSic = matchedConstructionSic(sic);

  const reasons: EligibilityReason[] = [];
  if (!companyNumber) {
    return { companyNumber, eligible: false, reasons, rejectedBecause: "no_company_number", matchedSic };
  }
  if (!isActiveStatus(status)) {
    return { companyNumber, eligible: false, reasons, rejectedBecause: "not_active", matchedSic };
  }
  reasons.push("active");
  if (!isNorthernIrelandPostcode(postcode)) {
    return { companyNumber, eligible: false, reasons, rejectedBecause: "not_northern_ireland", matchedSic };
  }
  reasons.push("ni_registered_office");
  if (matchedSic.length === 0) {
    return { companyNumber, eligible: false, reasons, rejectedBecause: "no_construction_sic", matchedSic };
  }
  reasons.push("construction_sic");
  return { companyNumber, eligible: true, reasons, rejectedBecause: null, matchedSic };
}

/** Map an ELIGIBLE record onto the sourcing-pool row shape. Only register facts. */
export function normalizeRecord(fields: string[], index: ColumnIndex): NormalizedPoolRow {
  const classified = classifyRecord(fields, index);
  return {
    company_number: classified.companyNumber,
    name: cell(fields, index, "CompanyName").slice(0, 300),
    status: cell(fields, index, "CompanyStatus"),
    company_category: cell(fields, index, "CompanyCategory") || null,
    postcode: cell(fields, index, "RegAddress.PostCode"),
    country: cell(fields, index, "RegAddress.Country") || null,
    incorporation_date: normaliseChDate(cell(fields, index, "IncorporationDate")),
    sic_codes: sicCodesOf(fields, index),
    matched_sic: classified.matchedSic,
    geography: "northern_ireland",
    reason_codes: classified.reasons,
  };
}

// ---------------------------------------------------------------------------
// Download URL derivation (no I/O — just the official filename/URL contract).
// ---------------------------------------------------------------------------

/** ISO `YYYY-MM-01` snapshot id for the month containing `now` (UTC). */
export function currentSnapshotDate(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The official one-file download URL for a `YYYY-MM-01` snapshot. */
export function bulkOneFileUrl(snapshot: string): string {
  return `http://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-${snapshot}.zip`;
}
