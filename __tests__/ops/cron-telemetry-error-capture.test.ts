import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * withCronTelemetry must record the failure reason for a route that fails
 * WITHOUT throwing — e.g. an RPC that returns `{ ok: false, error }`.
 *
 * Regression for the prod defect found 2026-10-31: cron-runs-prune timed out
 * (8s role limit), its service returned `{ ok:false, error:"…timeout…" }`
 * instead of throwing, and the wrapper wrote `ok=false` with a NULL
 * error_message — so every failure was invisible on /admin/ops. The error
 * must now land in the telemetry row.
 */

let inserted: Record<string, unknown> | null = null;
const createAdminClient = vi.fn(() => ({
  from: (_t: string) => ({
    insert: async (row: Record<string, unknown>) => {
      inserted = row;
      return { error: null };
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

const { withCronTelemetry } = await import("@/lib/ops/cron-telemetry");

describe("withCronTelemetry — non-throwing failure capture", () => {
  beforeEach(() => {
    inserted = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records a top-level error from a non-throwing ok:false result", async () => {
    const { status } = await withCronTelemetry("__t-top__", async () => ({
      ok: false,
      error: "prune timed out: canceling statement due to statement timeout",
    }));
    expect(status).toBe(200); // non-throwing failure is still a 200 ops record
    expect(inserted?.ok).toBe(false);
    expect(inserted?.error_message).toMatch(/statement timeout/i);
  });

  it("records a nested summary.error when the route wraps its summary", async () => {
    const { status } = await withCronTelemetry("__t-nested__", async () => ({
      ok: false,
      summary: { ok: false, error: "rpc failed: 57014" },
    }));
    expect(status).toBe(200);
    expect(inserted?.error_message).toMatch(/57014/);
  });

  it("never leaves a NULL error_message on an ok:false row", async () => {
    await withCronTelemetry("__t-bare__", async () => ({ ok: false }));
    expect(inserted?.ok).toBe(false);
    expect(inserted?.error_message).toBeTypeOf("string");
    expect((inserted?.error_message as string).length).toBeGreaterThan(0);
  });

  it("leaves error_message null on a healthy ok:true run", async () => {
    await withCronTelemetry("__t-ok__", async () => ({ ok: true, summary: { done: 1 } }));
    expect(inserted?.ok).toBe(true);
    expect(inserted?.error_message).toBeNull();
  });
});
