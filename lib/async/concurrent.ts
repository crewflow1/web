/**
 * Bounded-concurrency async map.
 *
 * Runs `mapper` over `items` with at most `limit` promises in flight at
 * once, preserving the input→output index mapping. A fixed pool of
 * `limit` workers each pull the next un-started index until the list is
 * exhausted, so memory and fan-out stay bounded regardless of input size.
 *
 * Why this exists: the daily email crons (invoice-reminders,
 * quote-followup) used to send strictly serially — one network round-trip
 * to Resend per row, awaited end to end. At a few hundred candidates per
 * run that risks the Vercel function timeout. A *bounded* fan-out overlaps
 * the network/DB latency without (a) hammering the Resend rate limit or
 * (b) opening an unbounded number of Postgres connections — both of which
 * an unbounded `Promise.all(items.map(...))` would do.
 *
 * The mapper is expected NOT to throw (the cron mappers return a result
 * and handle their own errors). If it does throw, the rejection
 * propagates out of the returned promise like a normal `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i] as T, i);
    }
  }

  const poolSize = Math.min(limit, items.length);
  const pool: Promise<void>[] = [];
  for (let w = 0; w < poolSize; w++) pool.push(worker());
  await Promise.all(pool);

  return results;
}
