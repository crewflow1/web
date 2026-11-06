/**
 * Tenant Semantic Search — source mappers (the column ALLOWLIST).
 *
 * The one place that decides WHICH source columns become embeddable corpus
 * text. Two hard rules this module enforces structurally, not by convention:
 *
 *   1. MONEY/SECRET SAFETY. A mapper's allowlist is rejected (at module load
 *      AND in the test) if it names any column matching a money/secret pattern
 *      — amount, total, price, cost, vat, tax, salary, pay, rate, secret,
 *      token, password, key, iban, account_number, card, ssn. The corpus can
 *      therefore never carry a monetary figure or a credential, whatever a
 *      future mapper edit tries to add.
 *
 *   2. ALLOWLIST-ONLY COMPOSITION. `composeContent` reads ONLY the allowlisted
 *      columns of a row; any other property on the row object (a `total`, a
 *      `portal_token`, a join artefact) is ignored, so content cannot leak a
 *      column the mapper did not explicitly opt into.
 *
 * Pure functions — no SDK, no DB, no `server-only` — so the whole allowlist is
 * unit-tested in isolation (ranking/chunking/column-allowlist suite).
 */

import type { TenantSearchDocument, TenantSearchVisibility } from "./types";

/** A source row, as read from the admin client (loose shape). */
export type SourceRow = Record<string, unknown>;

/**
 * Column-name fragments that must NEVER appear in a corpus allowlist. Matched
 * case-insensitively as substrings against each allowlisted column name. This
 * is the money/secret backstop: it does not inspect VALUES (a free-text `notes`
 * can mention anything) — it forbids structured money/secret COLUMNS from ever
 * being an embedding source, which is the realistic leak vector.
 */
// Substring patterns (case-insensitive). Deliberately NOT word-anchored: a
// column name like "vat_number" or "api_key" joins the fragment to other tokens
// with an underscore, which `\b` does not treat as a boundary — substring
// matching catches those. Verified not to false-positive on any registered
// mapper's actual allowlist columns (the validateAllMappers() load-time check +
// the unit suite enforce that).
export const FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [
  /amount/i,
  /total/i,
  /price/i,
  /cost/i,
  /vat/i,
  /tax/i,
  /salary/i,
  /payroll/i,
  /payment/i,
  /wage/i,
  /pay/i,
  /rate/i,
  /balance/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /api_key/i,
  /key/i,
  /iban/i,
  /sort_code/i,
  /account_number/i,
  /card/i,
  /ssn/i,
  /national_insurance/i,
  /ni_number/i,
];

/** Throws when an allowlist names a money/secret column. */
export function assertMoneySafeAllowlist(
  sourceTable: string,
  allowlist: readonly string[],
): void {
  for (const col of allowlist) {
    for (const pat of FORBIDDEN_COLUMN_PATTERNS) {
      if (pat.test(col)) {
        throw new Error(
          `tenant-search mapper "${sourceTable}": column "${col}" matches the ` +
            `forbidden money/secret pattern ${pat} — it must never be embedded`,
        );
      }
    }
  }
}

/**
 * Compose embeddable content from ONLY the allowlisted columns of a row.
 * Non-string/number values and empty strings are skipped; the rest are trimmed
 * and newline-joined. A column absent from the row contributes nothing. Nothing
 * outside the allowlist is ever read.
 */
export function composeContent(row: SourceRow, allowlist: readonly string[]): string {
  const parts: string[] = [];
  for (const col of allowlist) {
    const v = row[col];
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0) parts.push(t);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      parts.push(String(v));
    }
  }
  return parts.join("\n");
}

/**
 * A source mapper: how one table's rows become corpus documents. `visibility`
 * is either fixed or derived per-row (job_documents carry their own). `jobIdFrom`
 * names the column holding the owning job id (the staff gate), or null for
 * org-level records (customers). `sourceIdFrom` is the row's own primary key.
 */
export type SourceMapper = {
  readonly sourceTable: string;
  /** True for Sales/Money/Operations admin surfaces (stored visibility='management'). */
  readonly managementOnly: boolean;
  readonly allowedColumns: readonly string[];
  readonly sourceIdFrom: string;
  readonly jobIdFrom: string | null;
  readonly visibility:
    | TenantSearchVisibility
    | ((row: SourceRow) => TenantSearchVisibility);
};

function resolveVisibility(m: SourceMapper, row: SourceRow): TenantSearchVisibility {
  return typeof m.visibility === "function" ? m.visibility(row) : m.visibility;
}

function asId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Turn a source row into a corpus document, or null when there is nothing worth
 * embedding (no id, or empty content after allowlist composition).
 */
export function toDocument(mapper: SourceMapper, row: SourceRow): TenantSearchDocument | null {
  const sourceId = asId(row[mapper.sourceIdFrom]);
  if (!sourceId) return null;
  const content = composeContent(row, mapper.allowedColumns);
  if (content.length === 0) return null;
  return {
    sourceTable: mapper.sourceTable,
    sourceId,
    jobId: mapper.jobIdFrom ? asId(row[mapper.jobIdFrom]) : null,
    visibility: resolveVisibility(mapper, row),
    content,
  };
}

// ---------------------------------------------------------------------------
// The registry. Member-visible, money-free, high-value registers only. Money
// registers (invoices, finances, quotes, purchase-order totals, payments) are
// DELIBERATELY ABSENT — they never enter the semantic corpus. Customers are the
// one management-only register included, so admins get semantic customer recall
// while staff never can (visibility='management' → RPC denies non-admins).
// ---------------------------------------------------------------------------
export const SOURCE_MAPPERS: readonly SourceMapper[] = [
  {
    sourceTable: "jobs",
    managementOnly: false,
    // Free-text + address. No money column (retention_percent is a %, not an
    // amount, but excluded anyway — only descriptive text belongs here).
    allowedColumns: [
      "notes",
      "ai_summary",
      "site_address_line1",
      "site_address_line2",
      "site_city",
      "site_county",
      "site_postcode",
    ],
    sourceIdFrom: "id",
    jobIdFrom: "id",
    visibility: "member",
  },
  {
    sourceTable: "job_documents",
    managementOnly: false,
    allowedColumns: ["title", "doc_type", "external_reference"],
    sourceIdFrom: "id",
    jobIdFrom: "job_id",
    // Job documents carry their OWN visibility: a 'private' doc is admin-only.
    visibility: (row) => (row.visibility === "private" ? "private" : "staff"),
  },
  {
    sourceTable: "site_reports",
    managementOnly: false,
    // title + number only — the report body may carry figures a column-name
    // check cannot catch, so it is excluded; the identifiers are the safe hook.
    allowedColumns: ["title", "report_number"],
    sourceIdFrom: "id",
    jobIdFrom: "job_id",
    visibility: "member",
  },
  {
    sourceTable: "snags",
    managementOnly: false,
    allowedColumns: ["title", "description", "location", "trade"],
    sourceIdFrom: "id",
    jobIdFrom: "job_id",
    visibility: "member",
  },
  {
    sourceTable: "customers",
    managementOnly: true,
    // name + free-text notes + structured address. NO email/phone (contact PII,
    // already keyword-searchable), NO vat_number/company_number (sensitive ids).
    allowedColumns: [
      "name",
      "notes",
      "address_line1",
      "address_line2",
      "city",
      "county",
      "postcode",
    ],
    sourceIdFrom: "id",
    jobIdFrom: null,
    visibility: "management",
  },
] as const;

/** Validate every registered mapper's allowlist. Throws on the first offender. */
export function validateAllMappers(): void {
  for (const m of SOURCE_MAPPERS) {
    assertMoneySafeAllowlist(m.sourceTable, m.allowedColumns);
  }
}

// Fail fast at module load: a money/secret column in any allowlist is a build
// error, not a runtime surprise.
validateAllMappers();
