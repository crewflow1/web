/**
 * Pure builders for PostgREST search filters — shared by the customers list,
 * jobs list, leads kanban and the global Cmd/K search route.
 *
 * Extracted so the (fiddly) `.or()` / `.in.()` string construction is unit
 * testable without standing up Supabase, and so every search path neutralises
 * input the same way and searches the same column set.
 *
 * Address-first: the column sets below put the structured address columns
 * (added in 20260601000000_customer_job_addresses.sql) alongside name/contact,
 * so a postcode / street / town / unit number matches in SQL — never by
 * fetching a capped page and filtering in JS.
 */

import { sanitizeSearchTerm } from "@/lib/search/sanitize";

/** Canonical UUID matcher — reject anything else before it reaches `.in.()`. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Customer columns searched everywhere a customer is matched (list page +
 * global route + the customer pre-pass that powers job/quote/invoice address
 * discovery). `email` is citext and `phone` is plain text — both still match
 * via ILIKE; the rest are the structured address columns.
 */
export const CUSTOMER_SEARCH_COLUMNS = [
  "name",
  "email",
  "phone",
  "address_line1",
  "address_line2",
  "city",
  "county",
  "postcode",
] as const;

/** Job site-address override columns (a job with no site address inherits the
 * customer's address, which is reached via the customer-id chaining instead). */
export const JOB_SEARCH_COLUMNS = [
  "site_address_line1",
  "site_address_line2",
  "site_city",
  "site_county",
  "site_postcode",
] as const;

/** Lead own-column search: the service, where it came from, and the enquirer's
 * postcode / name / email. */
export const LEAD_SEARCH_COLUMNS = [
  "service",
  "source",
  "postcode",
  "contact_name",
  "contact_email",
] as const;

/** Job-document own columns: the document title + its free-text external
 * reference (e.g. an EICR certificate number). Documents also surface via the
 * matched-job id chain (job_documents.job_id is NOT NULL). */
export const JOB_DOCUMENT_SEARCH_COLUMNS = ["title", "external_reference"] as const;

/** Snag own columns: what/where/which-trade, plus the free-text description.
 * Snags also surface via the matched-job id chain (job_id is nullable). */
export const SNAG_SEARCH_COLUMNS = [
  "title",
  "description",
  "location",
  "trade",
] as const;

/** Purchase-order own columns: the PO number, the supplier's own reference, and
 * the free-text notes. POs also surface via the matched-job id chain. */
export const PURCHASE_ORDER_SEARCH_COLUMNS = [
  "number",
  "supplier_reference",
  "notes",
] as const;

/** Site-report own columns: the report number + title. Reports also surface via
 * the matched-job id chain AND the matched-customer id chain (site_reports carry
 * both job_id and customer_id). */
export const SITE_REPORT_SEARCH_COLUMNS = ["title", "report_number"] as const;

/**
 * Build the `col.ilike.%term%,col2.ilike.%term%,…` body of a PostgREST `.or()`
 * from a free-text term across `columns`.
 *
 * The term is run through {@link sanitizeSearchTerm} first (strips control
 * chars + PostgREST structural/wildcard chars `% _ , ( ) *`), so a crafted
 * term can neither inject extra OR branches nor broaden the match; the cleaned
 * term still matches literally. Returns null when nothing is searchable (empty
 * / whitespace / all-stripped term, or no columns) — callers treat null as
 * "no filter" (show the unfiltered list) rather than a match-everything filter.
 */
export function ilikeOrFilter(
  raw: string | null | undefined,
  columns: readonly string[],
): string | null {
  const safe = sanitizeSearchTerm(raw);
  if (safe.length === 0 || columns.length === 0) return null;
  const like = `%${safe}%`;
  return columns.map((c) => `${c}.ilike.${like}`).join(",");
}

/**
 * Build a `column.in.(uuid1,uuid2,…)` OR-branch from a list of ids. Only
 * well-formed UUIDs survive (deduped), so a malformed/foreign id can't widen
 * the filter or break the grammar. Returns null when no valid id remains, so
 * `combineOr` simply drops the branch (a dependent search with zero parent
 * matches contributes nothing rather than matching everything).
 */
export function inIdsBranch(
  column: string,
  ids: readonly (string | null | undefined)[],
): string | null {
  const valid = Array.from(
    new Set(ids.filter((x): x is string => !!x && UUID_RE.test(x))),
  );
  if (valid.length === 0) return null;
  return `${column}.in.(${valid.join(",")})`;
}

/**
 * Join already-built OR-branch fragments (from {@link ilikeOrFilter} /
 * {@link inIdsBranch} / literal `col.op.val`) into a single `.or()` argument,
 * dropping nulls/empties. Returns null when nothing is left, so callers can
 * skip applying a filter entirely.
 */
export function combineOr(
  ...parts: (string | null | undefined)[]
): string | null {
  const present = parts.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (present.length === 0) return null;
  return present.join(",");
}
