/**
 * Customer portal — bulk (zip) download PLAN (pure).
 *
 * Given the customer's OWN, already-scoped document descriptors, decide which
 * ones go into a bulk zip and under what filename. Deliberately pure — no IO,
 * no clocks, no Supabase — so the two things that MUST be right regardless of
 * rendering can be unit-tested in isolation:
 *
 *   1. BOUNDS  — a customer with a runaway number of documents can never make
 *      the route render an unbounded pile of PDFs into memory. The plan caps the
 *      count and reports whether it truncated (`capped`), so the route/UI can
 *      say "first N of M".
 *   2. FILENAMES — every entry gets a filename-safe, COLLISION-FREE name that
 *      leaks no internal ids or metadata. A numeric prefix guarantees uniqueness
 *      even when two documents sanitise to the same label, and the sanitiser
 *      strips anything that could inject a path or a zip-header. No raw ids ever
 *      reach the filename.
 *
 * The caller derives the input list SERVER-SIDE from the token-resolved customer
 * (never from a client-supplied id list); this module only orders, filters,
 * bounds, and names it.
 */

import type { PortalDocType } from "./portal-documents";

/** Hard ceiling on how many documents a single bulk download may contain. A
 *  customer with more is served the newest MAX_BULK_DOCS and told it truncated,
 *  so the route never renders an unbounded set into memory. */
export const MAX_BULK_DOCS = 50;

/** A customer-owned document eligible for the bulk zip. `label` is a
 *  human-facing base name (e.g. "Invoice INV-0001"); `id`/`type` identify the
 *  source row for rendering but NEVER appear in the output filename. `date` is
 *  the ISO date used for newest-first ordering (matches the library page). */
export type BulkPlanItem = {
  type: PortalDocType;
  id: string;
  label: string;
  date: string;
};

/** One entry selected for the zip: the source identity plus its safe,
 *  unique in-archive filename. */
export type BulkPlanEntry = {
  type: PortalDocType;
  id: string;
  filename: string;
};

export type BulkPlan = {
  /** Ordered (newest-first) entries to render, at most `maxDocs`. */
  entries: BulkPlanEntry[];
  /** True when `total` exceeded the cap and the plan was truncated. */
  capped: boolean;
  /** How many of the customer's documents matched the filter BEFORE capping. */
  total: number;
};

/**
 * Sanitise one path segment for use inside a zip: keep only filename-safe
 * characters, collapse runs, trim, bound the length. Never returns an empty
 * string, a path separator, `..`, or a control character — so it can neither
 * traverse a path nor inject a zip/header field. Mirrors `safeReportFilename`
 * (site-reports) but works for any label.
 */
export function safeZipSegment(label: string | null | undefined): string {
  const cleaned = (label ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return cleaned || "document";
}

/** Outer zip filename — carries no customer/org identity or internal id, just a
 *  neutral, dated label. Safe to appear in Content-Disposition. */
export function bulkZipFilename(): string {
  return "documents.zip";
}

/**
 * Plan the bulk download: apply an optional category filter, order newest-first
 * (stable tie-break by label, matching the documents page), cap at `maxDocs`,
 * and assign each survivor a unique, safe filename.
 */
export function buildBulkPlan(
  items: BulkPlanItem[],
  opts: { filter?: PortalDocType | null; maxDocs?: number } = {},
): BulkPlan {
  const filter = opts.filter ?? null;
  const maxDocs = opts.maxDocs ?? MAX_BULK_DOCS;

  const matched = (filter ? items.filter((i) => i.type === filter) : items)
    .slice()
    .sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.label.localeCompare(b.label),
    );

  const total = matched.length;
  const chosen = matched.slice(0, Math.max(0, maxDocs));

  // Numeric prefix (zero-padded to the chosen count) guarantees uniqueness even
  // when two labels sanitise identically, and keeps the archive ordered.
  const width = String(chosen.length).length;
  const entries: BulkPlanEntry[] = chosen.map((item, i) => {
    const prefix = String(i + 1).padStart(width, "0");
    return {
      type: item.type,
      id: item.id,
      filename: `${prefix}-${safeZipSegment(item.label)}.pdf`,
    };
  });

  return { entries, capped: total > chosen.length, total };
}
