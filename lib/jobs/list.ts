/**
 * Pure helpers for the Jobs list page.
 *
 * Extracted so the pagination window is unit-testable without standing up
 * Supabase — the same shape as {@link file://./../customers/list.ts}.
 *
 * The bug these guard against: /jobs used `.limit(200)` and printed
 * `rows.length` as the headline total, so an org with 640 jobs showed
 * "200 jobs" and rows 201–640 were unreachable. Worse, "Today's jobs" was
 * derived by filtering that same 200-row slice — under `scheduled_date ASC`
 * the upcoming/today rows sort LAST, so once an org passed 200 historical
 * jobs, today's work could fall off the slice entirely and field staff would
 * see "No jobs scheduled for today" while standing on site. The page now
 * fetches an EXACT count and paginates with `.range()`, and loads today's
 * jobs with their own bounded `scheduled_date = today` query.
 */

export const PAGE_SIZE = 100;

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
