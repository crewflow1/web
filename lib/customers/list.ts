/**
 * Pure helpers for the Customers list page.
 *
 * Extracted so the pagination window + search-filter construction are unit
 * testable without standing up Supabase.
 *
 * The bug these guard against: the list page used `.limit(200)` and printed
 * `rows.length` as the headline total, so an org with 598 imported customers
 * showed "200 customers" and rows 201–598 were unreachable. The page now
 * fetches an EXACT count and paginates with `.range()`, and search runs
 * server-side across the whole table (name/email/phone) rather than filtering
 * only the rows already on screen.
 */

import { sanitizeSearchTerm } from "@/lib/search/sanitize";

export const PAGE_SIZE = 200;

/** Parse a 1-based page number from a query param; never below 1. */
export function parsePage(raw: string | undefined | null): number {
  const n = parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Zero-based offset into the result set for a given 1-based page. */
export function offsetForPage(page: number): number {
  return (Math.max(page, 1) - 1) * PAGE_SIZE;
}

/**
 * Display window for the current page given the EXACT total row count.
 * `rowsOnPage` is how many rows actually came back (the last page is short),
 * so "Showing {from}–{to} of {total}" reads correctly on every page.
 */
export function pageWindow(
  total: number,
  offset: number,
  rowsOnPage: number,
): { totalPages: number; from: number; to: number } {
  return {
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    from: total === 0 ? 0 : offset + 1,
    to: offset + rowsOnPage,
  };
}

/**
 * Build the PostgREST `.or()` filter for a server-side customer search across
 * name/email/phone. Returns null when there's nothing to search (→ full list).
 *
 * The term is run through the shared {@link sanitizeSearchTerm} first, which
 * strips control characters and PostgREST structural/wildcard characters
 * (`% _ , ( ) *`) so a crafted term can't broaden the match or break the
 * `.or()` grammar; the cleaned term still matches literally via `ilike`.
 * Because the filter is applied to the query BEFORE `.range()`, the search
 * spans every customer — a hit on row 550 of 598 is found from page 1, not
 * just within the first 200.
 */
export function customerSearchOr(
  term: string | undefined | null,
): string | null {
  const safe = sanitizeSearchTerm(term);
  if (safe.length === 0) return null;
  const like = `%${safe}%`;
  return `name.ilike.${like},email.ilike.${like},phone.ilike.${like}`;
}
