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
 * server-side across the whole table — name/email/phone AND the structured
 * address columns (line1/2, city, county, postcode), so a tradesperson can
 * find a customer by address/postcode — rather than filtering only the rows
 * already on screen.
 */

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

// Customer SEARCH (as opposed to this file's pagination math) now lives in the
// ONE shared capability — lib/customers/search.ts → the search_customers RPC —
// used by the customers list, the Cmd/K palette, the jobs-list customer axis and
// every form picker. The old single-term `.or()` builder that used to live here
// (customerSearchOr) was removed when the list page adopted the RPC, so there is
// no second, weaker customer-search implementation to drift.
