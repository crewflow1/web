import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F-8 — activity_log retention MECHANISM (no autonomous deletion).
 *
 * public.activity_log is an append-only audit/feed table written only by the
 * SECURITY DEFINER `_tg_*_activity` triggers; nothing prunes it, so it is the
 * fastest-growing relation in the schema. Migration 20260710000000 adds the
 * MECHANISM to trim it — a supporting (created_at) index, a batched
 * purge_activity_log() function locked to the service role, and a COMMENTED
 * pg_cron schedule block — but it must delete NOTHING when applied.
 *
 * CI has no database, so (exactly like the M-5 tenant-attachments suite) we
 * pin the migration's contract against its source text. The load-bearing
 * assertions are the NEGATIVE ones run over `sqlOnly()` (comments stripped):
 * the executable SQL must NOT schedule a cron job and must NOT invoke the
 * purge function — proving that applying the migration trims zero rows.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// Strip SQL line comments (-- ... EOL) so negative assertions test the
// EXECUTABLE statements, not the documentation that quotes the opt-in
// schedule / manual-run examples.
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const MIG_REL =
  "supabase/migrations/20260710000000_activity_log_retention.sql";
const mig = read(MIG_REL);
const exec = sqlOnly(mig);

// The single dollar-quoted function body ($$ ... $$). Anything inside it is a
// FUNCTION DEFINITION, not executed on apply — only when the function is later
// invoked by an operator/cron.
function functionBody(src: string): string {
  const open = src.indexOf("$$");
  const close = src.indexOf("$$", open + 2);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return src.slice(open + 2, close);
}

// =====================================================================
// File exists
// =====================================================================

describe("F-8 retention — migration ships", () => {
  it("the retention migration is present", () => {
    const found = readdirSync(resolve(ROOT, "supabase/migrations")).includes(
      "20260710000000_activity_log_retention.sql",
    );
    expect(found).toBe(true);
  });
});

// =====================================================================
// Supporting index
// =====================================================================

describe("F-8 retention — supporting (created_at) index", () => {
  it("creates activity_log_created_at_idx idempotently", () => {
    expect(exec).toMatch(
      /create index if not exists activity_log_created_at_idx\s+on public\.activity_log \(created_at\)/i,
    );
  });
});

// =====================================================================
// The purge function — shape + hardening
// =====================================================================

describe("F-8 retention — purge_activity_log() mechanism", () => {
  it("is CREATE OR REPLACE, SECURITY DEFINER, pinned search_path", () => {
    expect(exec).toMatch(
      /create or replace function public\.purge_activity_log\(/i,
    );
    expect(exec).toMatch(/security definer/i);
    expect(exec).toMatch(/set search_path = public/i);
  });

  it("defaults to a generous retention window and a bounded batch", () => {
    expect(exec).toMatch(/p_retention\s+interval\s+default\s+interval '24 months'/i);
    expect(exec).toMatch(/p_batch\s+integer\s+default\s+5000/i);
  });

  it("validates its arguments (positive batch, non-negative interval)", () => {
    const body = functionBody(exec);
    expect(body).toMatch(/p_batch is null or p_batch <= 0/i);
    expect(body).toMatch(/p_retention is null or p_retention < interval '0'/i);
    // Both validation failures raise with the invalid-parameter SQLSTATE.
    expect(body).toMatch(/errcode = '22023'/);
  });

  it("deletes in bounded batches off the cutoff and stops on an empty pass", () => {
    const body = functionBody(exec);
    expect(body).toMatch(/v_cutoff\s+timestamptz := now\(\) - p_retention/i);
    expect(body).toMatch(/limit p_batch/i);
    expect(body).toMatch(/get diagnostics v_chunk = row_count/i);
    expect(body).toMatch(/exit when v_chunk = 0/i);
    // Returns the count removed (0 when nothing is past the cutoff).
    expect(body).toMatch(/return v_deleted/i);
  });

  it("the ONLY delete lives inside the function body, never at top level", () => {
    // The function body contains the delete...
    expect(functionBody(exec)).toMatch(/delete from public\.activity_log/i);
    // ...and removing the body leaves NO executable delete behind. This is the
    // proof that applying the migration is define-only: the delete is dormant
    // until the function is explicitly called.
    const open = exec.indexOf("$$");
    const close = exec.indexOf("$$", open + 2);
    const outsideBody = exec.slice(0, open) + exec.slice(close + 2);
    expect(outsideBody).not.toMatch(/delete from public\.activity_log/i);
  });
});

// =====================================================================
// Privilege lockdown — tenants can never erase audit history
// =====================================================================

describe("F-8 retention — locked to the service role", () => {
  it("revokes EXECUTE from public, anon and authenticated", () => {
    expect(exec).toMatch(
      /revoke execute on function public\.purge_activity_log\(interval, integer\)\s+from public, anon, authenticated/i,
    );
  });

  it("never re-grants EXECUTE to anon or authenticated", () => {
    expect(exec).not.toMatch(/grant execute[\s\S]*?\b(anon|authenticated)\b/i);
  });
});

// =====================================================================
// SAFETY (load-bearing) — applying the migration deletes NOTHING
// =====================================================================

describe("F-8 retention — apply is define-only (no autonomous deletion)", () => {
  it("schedules NO cron job in executable SQL", () => {
    // The pg_cron example is documentation only; it must stay commented out so
    // no recurring purge is created behind the operator's back.
    expect(exec).not.toMatch(/cron\.schedule/i);
  });

  it("INVOKES the purge function nowhere in executable SQL", () => {
    // A top-level `select public.purge_activity_log(...)` would run the delete
    // on apply. The only such lines are commented usage examples.
    expect(exec).not.toMatch(/select\s+public\.purge_activity_log\s*\(/i);
    // Defensive: no perform-style call either.
    expect(exec).not.toMatch(/perform\s+public\.purge_activity_log\s*\(/i);
  });

  it("documents the opt-in schedule, but only as comments", () => {
    // The guidance IS present (so operators can find it) — just not executable.
    expect(mig).toMatch(/cron\.schedule/i);
    expect(mig).toMatch(/select public\.purge_activity_log/i);
  });
});
