/**
 * Volume-safe full-table reads for server-side aggregation.
 *
 * The bug this guards against (F-1): Supabase/PostgREST caps every response
 * at the project-level "Max rows" setting (1000 by default). A bare
 * `.select()` with no `.range()` is therefore SILENTLY TRUNCATED the moment
 * an org crosses that many rows — so a page that fetches the whole table and
 * computes KPIs in TypeScript (counts, money sums, profitability, pipeline)
 * would aggregate over only the first page and under-report, with no error.
 * The dashboard hit exactly this: every tile was derived from unbounded
 * `.select()` fetches.
 *
 * `fetchAllRows` pages through the entire result set in chunks STRICTLY BELOW
 * the default cap and concatenates them, so no single response is ever
 * truncated. The caller's downstream aggregation is unchanged — it just
 * receives the complete row set instead of a silently-clipped first page.
 *
 * Contract for `buildPage`:
 *   - Apply a STABLE, total ordering (e.g. `created_at desc` PLUS a unique
 *     `id` tiebreaker) so rows can't shift across page boundaries. Without a
 *     unique tiebreaker, rows that share the primary sort key can be dropped
 *     or repeated at a page edge.
 *   - Apply the passed-in `.range(from, to)` and nothing that re-caps the
 *     page below `pageSize` (no competing `.limit()`).
 *
 * This is the correct fix for the launch horizon (hundreds-to-low-thousands
 * of rows per org per entity): it removes the correctness bug entirely with
 * zero change to the aggregation arithmetic. For the much-later era where a
 * single org carries tens of thousands of rows, the per-entity reads should
 * move to DB-side SQL aggregates / RPC views — but that is well beyond the
 * 200-company target and is a deliberate, separate piece of work.
 */

/** Page size — safely below the 1000-row PostgREST default cap. */
export const PAGE_SIZE = 500;

/**
 * Defensive ceiling so a mis-specified (non-unique) ordering can never spin
 * forever. 1000 pages × 500 = 500k rows — orders of magnitude past any
 * single-org volume at the launch horizon. Hitting it is logged, not silent.
 */
const MAX_PAGES = 1000;

export type PageResult<T> = { data: T[] | null; error: unknown };

/**
 * Read every row a query would return, paging under the PostgREST cap.
 *
 * Pages are fetched sequentially (each depends on the previous page being a
 * full page). On error it returns the rows gathered so far together with the
 * error, matching the dashboard's existing best-effort "use whatever came
 * back" posture rather than throwing and blanking the whole page.
 */
export async function fetchAllRows<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = PAGE_SIZE,
): Promise<{ data: T[]; error: unknown }> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`fetchAllRows: pageSize must be a positive integer, got ${pageSize}`);
  }

  const out: T[] = [];
  let from = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) {
      // Best-effort: hand back the partial set + the error. Callers that
      // ignore the error (the dashboard does) then aggregate over what we
      // managed to read instead of crashing the render.
      return { data: out, error };
    }
    const batch = data ?? [];
    out.push(...batch);
    // A short page means we've reached the end of the result set.
    if (batch.length < pageSize) {
      return { data: out, error: null };
    }
    from += pageSize;
  }

  console.warn(
    `[fetchAllRows] hit MAX_PAGES (${MAX_PAGES}) — result set exceeds ${MAX_PAGES * pageSize} rows; ` +
      `aggregation may be incomplete. This entity should move to a DB-side SQL aggregate.`,
  );
  return { data: out, error: null };
}
