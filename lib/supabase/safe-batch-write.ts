/**
 * Safe batch write — the ONE chunked, per-row-fallback upsert helper that every
 * mapped external-feed writer routes through, so a single uninsertable row can
 * never strand an org's whole batch. This is the containment for the
 * BATCH-POISONING class (telematics_readings, bank_statement_lines,
 * weather_readings — and structurally any future sync adapter writing a mapped
 * vendor feed).
 *
 * ── THE DEFECT CLASS THIS CLOSES ────────────────────────────────────────────
 * A mapped vendor batch used to be written in ONE `.upsert(allRows)` that throws
 * on the first error. If ONE row violated a DB constraint the mapper did not
 * mirror (a CHECK / NOT NULL / datetime / numeric-overflow), the whole statement
 * aborted → ZERO rows written. Because these feeds re-deliver the same window
 * every tick (a provider snapshot), the same poison re-aborted forever: the org's
 * feed was permanently stranded at zero while the UI still read "connected" /
 * "fresh". The C61 telematics fix contained this for one writer; this generalises
 * that exact posture so the class cannot recur in any of the sibling writers.
 *
 * ── THE POSTURE (mirrors the C61 telematics fix exactly) ────────────────────
 *   1. CHUNK the write into <= chunkSize batches — bounds the blast radius.
 *   2. On a CONSTRAINT error (a bad-row SQLSTATE — 23514 / 23502 / 22007 / 22003
 *      / …), fall back to per-row upserts for that chunk: the good rows land, the
 *      offending row(s) are dropped, and `constraintError` is surfaced so the
 *      caller can go TERMINAL (stop silently retrying the same poison forever).
 *   3. On any OTHER error (transient / network / 5xx / infra), BAIL immediately
 *      with `transientError` set — a blip is not a bad row, so the caller keeps
 *      the feed live and a later tick self-heals (terminal-vs-transient doctrine,
 *      C47 / C49).
 *
 * ── IDEMPOTENCY IS THE CALLER'S ────────────────────────────────────────────
 * `onConflict` / `ignoreDuplicates` / `count` semantics live ENTIRELY inside the
 * caller-supplied `upsert` closure, so chunking preserves each feed's idempotency
 * contract byte-for-byte: per-chunk dedupe, and the summed count equals one big
 * statement's count. This helper never touches conflict semantics.
 */

/** Default max rows per upsert statement — the blast-radius bound. */
export const BATCH_WRITE_CHUNK = 500;

/**
 * Postgres SQLSTATE codes that mean "this specific row is uninsertable" — a bad
 * row the mapper should have caught, never a transient blip. These trigger the
 * per-row fallback (land the good, drop the bad, surface TERMINAL). Every other
 * code is treated as transient (bail, keep the feed live so it self-heals).
 */
export const CONSTRAINT_VIOLATION_CODES: ReadonlySet<string> = new Set([
  "23514", // check_violation — a CHECK the mapper did not mirror
  "23502", // not_null_violation — a NOT NULL column the mapper left empty/null
  "22007", // invalid_datetime_format — e.g. "" into a `date`/`timestamp` column
  "22008", // datetime_field_overflow
  "22003", // numeric_value_out_of_range — exceeds a numeric(p,s) precision
  "22P02", // invalid_text_representation — e.g. a non-date string into `date`
]);

export type BatchUpsertResult = {
  error: { message: string; code?: string } | null;
  count?: number | null;
};

/**
 * A caller-supplied upsert of ONE chunk — owns onConflict/ignoreDuplicates/count.
 * `PromiseLike` (not `Promise`) so a supabase-js thenable builder can be returned
 * directly without an extra `await`/wrap at every call site.
 */
export type BatchUpsert<T> = (rows: readonly T[]) => PromiseLike<BatchUpsertResult>;

export type SafeBatchWriteResult<T> = {
  /** Rows the DB reported inserted (or, when the closure returns no count, that landed). */
  written: number;
  /** Rows that landed OR were idempotent duplicates — i.e. NOT rejected by a constraint. */
  landedRows: T[];
  /** A constraint violation was seen and contained via per-row fallback — TERMINAL for the caller. */
  constraintError: string | null;
  /** A non-constraint (network/5xx/infra) error — caller keeps the feed live to self-heal. */
  transientError: string | null;
};

/** True when a SQLSTATE marks the ROW uninsertable (a bad row), not a transient blip. */
export function isConstraintViolation(code: string | undefined | null): boolean {
  return typeof code === "string" && CONSTRAINT_VIOLATION_CODES.has(code);
}

/**
 * Write `rows` through `upsert` in chunks, isolating a constraint-violating row
 * via a per-row fallback and bailing on a transient error. See the file header
 * for the full doctrine. Pure orchestration — no DB or client knowledge lives
 * here; the caller's closure is the only thing that touches Supabase.
 */
export async function safeBatchWrite<T>(
  rows: readonly T[],
  upsert: BatchUpsert<T>,
  options: { chunkSize?: number } = {},
): Promise<SafeBatchWriteResult<T>> {
  const chunkSize = Math.max(1, options.chunkSize ?? BATCH_WRITE_CHUNK);
  let written = 0;
  const landedRows: T[] = [];
  let constraintError: string | null = null;

  const land = (chunk: readonly T[], count: number | null | undefined): void => {
    written += count ?? chunk.length;
    landedRows.push(...chunk);
  };

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error, count } = await upsert(chunk);
    if (!error) {
      land(chunk, count);
      continue;
    }
    // A non-constraint error is a transient/infra failure, not a bad row — bail so
    // the caller keeps the feed live and a later tick retries the same window.
    if (!isConstraintViolation(error.code)) {
      return { written, landedRows, constraintError, transientError: error.message };
    }
    // A constraint error: at least one row in this chunk is uninsertable. Isolate
    // it row-by-row so the rest of the batch still lands.
    constraintError = error.message;
    for (const row of chunk) {
      const single: readonly T[] = [row];
      const { error: rowErr, count: rowCount } = await upsert(single);
      if (!rowErr) {
        land(single, rowCount);
        continue;
      }
      // A transient failure on the single-row retry — bail as transient.
      if (!isConstraintViolation(rowErr.code)) {
        return { written, landedRows, constraintError, transientError: rowErr.message };
      }
      // else: this single row violates a constraint — DROP it (do not land it).
      // constraintError is already set for the caller to go TERMINAL.
    }
  }

  return { written, landedRows, constraintError, transientError: null };
}
