import { describe, it, expect } from "vitest";
import {
  safeBatchWrite,
  isConstraintViolation,
  BATCH_WRITE_CHUNK,
  CONSTRAINT_VIOLATION_CODES,
  type BatchUpsertResult,
} from "@/lib/supabase/safe-batch-write";

/**
 * Safe batch write — the ONE helper every mapped external-feed writer routes
 * through to contain the BATCH-POISONING class. These prove its doctrine directly:
 *
 *   1. chunks a large batch into <= chunkSize statements (blast-radius bound);
 *   2. on a CONSTRAINT error, falls back per-row — good rows land, the bad row is
 *      dropped, constraintError surfaced (TERMINAL for the caller);
 *   3. on any OTHER error, BAILS with transientError (caller keeps the feed live);
 *   4. sums counts across chunks/rows, preserving the caller's count semantics;
 *   5. a single-row transient failure inside the per-row fallback still bails.
 */

type Row = { id: number };

/** A recording upsert whose per-chunk behaviour is scripted by `handler`. */
function recordingUpsert(
  handler: (rows: readonly Row[]) => BatchUpsertResult,
) {
  const calls: Row[][] = [];
  const fn = (rows: readonly Row[]): Promise<BatchUpsertResult> => {
    calls.push([...rows]);
    return Promise.resolve(handler(rows));
  };
  return { fn, calls };
}

const ok = (count: number): BatchUpsertResult => ({ error: null, count });
const err = (code: string, message = code): BatchUpsertResult => ({ error: { message, code } });

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i }));

describe("safeBatchWrite — chunking", () => {
  it("splits a batch into <= chunkSize statements and sums the counts", async () => {
    const { fn, calls } = recordingUpsert((r) => ok(r.length));
    const res = await safeBatchWrite(rows(1050), fn, { chunkSize: 500 });
    expect(calls.map((c) => c.length)).toEqual([500, 500, 50]);
    expect(res.written).toBe(1050);
    expect(res.landedRows).toHaveLength(1050);
    expect(res.constraintError).toBeNull();
    expect(res.transientError).toBeNull();
  });

  it("defaults to BATCH_WRITE_CHUNK (500) when no chunkSize is given", async () => {
    const { fn, calls } = recordingUpsert((r) => ok(r.length));
    await safeBatchWrite(rows(600), fn);
    expect(BATCH_WRITE_CHUNK).toBe(500);
    expect(calls.map((c) => c.length)).toEqual([500, 100]);
  });

  it("an empty batch performs no upsert", async () => {
    const { fn, calls } = recordingUpsert((r) => ok(r.length));
    const res = await safeBatchWrite([], fn);
    expect(calls).toHaveLength(0);
    expect(res.written).toBe(0);
  });

  it("falls back to rows.length when the closure returns no count", async () => {
    const { fn } = recordingUpsert(() => ({ error: null }));
    const res = await safeBatchWrite(rows(3), fn, { chunkSize: 2 });
    expect(res.written).toBe(3);
  });
});

describe("safeBatchWrite — per-row fallback on a constraint error", () => {
  it("isolates the ONE bad row: good rows land, the bad row is dropped, TERMINAL surfaced", async () => {
    const poison = 2;
    const { fn, calls } = recordingUpsert((r) => {
      if (r.length > 1) return err("23514", "chunk has a bad row"); // whole chunk 23514s
      return r[0]!.id === poison ? err("23514", "row is poison") : ok(1);
    });

    const res = await safeBatchWrite(rows(4), fn, { chunkSize: 4 });

    // 1 chunk attempt (4 rows) + 4 per-row attempts.
    expect(calls[0]!.length).toBe(4);
    expect(calls.slice(1).map((c) => c.length)).toEqual([1, 1, 1, 1]);
    // Three good rows landed; the poison row was dropped.
    expect(res.written).toBe(3);
    expect(res.landedRows.map((r) => r.id)).toEqual([0, 1, 3]);
    // TERMINAL: the constraint error is surfaced; no transient error.
    expect(res.constraintError).toBe("chunk has a bad row");
    expect(res.transientError).toBeNull();
  });

  it("each recognised constraint SQLSTATE triggers the per-row fallback", async () => {
    for (const code of CONSTRAINT_VIOLATION_CODES) {
      const { fn, calls } = recordingUpsert((r) => (r.length > 1 ? err(code) : ok(1)));
      const res = await safeBatchWrite(rows(2), fn, { chunkSize: 2 });
      // chunk (2) failed with a constraint code → 2 per-row retries, both land.
      expect(calls.map((c) => c.length)).toEqual([2, 1, 1]);
      expect(res.written).toBe(2);
      expect(res.constraintError).toBe(code);
    }
  });
});

describe("safeBatchWrite — transient errors bail (feed stays live)", () => {
  it("a non-constraint chunk error bails immediately with transientError", async () => {
    const { fn, calls } = recordingUpsert(() => err("08006", "server closed the connection"));
    const res = await safeBatchWrite(rows(3), fn, { chunkSize: 3 });
    // One chunk attempt, then bail — NO per-row fallback for a transient error.
    expect(calls).toHaveLength(1);
    expect(res.written).toBe(0);
    expect(res.transientError).toBe("server closed the connection");
    expect(res.constraintError).toBeNull();
  });

  it("a transient failure DURING the per-row fallback also bails", async () => {
    let single = 0;
    const { fn } = recordingUpsert((r) => {
      if (r.length > 1) return err("23514"); // chunk 23514s → per-row fallback
      single += 1;
      if (single === 1) return ok(1); // first row lands
      return err("08006", "blip mid-fallback"); // second row hits a transient blip
    });
    const res = await safeBatchWrite(rows(3), fn, { chunkSize: 3 });
    expect(res.written).toBe(1); // only the first per-row landed before the bail
    expect(res.transientError).toBe("blip mid-fallback");
    // constraintError was already set by the chunk 23514 before the transient bail.
    expect(res.constraintError).toBe("23514");
  });
});

describe("isConstraintViolation", () => {
  it("classifies bad-row SQLSTATEs vs everything else", () => {
    expect(isConstraintViolation("23514")).toBe(true); // check_violation
    expect(isConstraintViolation("23502")).toBe(true); // not_null_violation
    expect(isConstraintViolation("22007")).toBe(true); // invalid_datetime_format
    expect(isConstraintViolation("22003")).toBe(true); // numeric_value_out_of_range
    expect(isConstraintViolation("08006")).toBe(false); // connection failure — transient
    expect(isConstraintViolation("57014")).toBe(false); // query canceled — transient
    expect(isConstraintViolation(undefined)).toBe(false);
    expect(isConstraintViolation(null)).toBe(false);
  });
});
