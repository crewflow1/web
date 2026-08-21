import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * cron_runs retention — real-Postgres proof (migration 20261213000000).
 *
 * The unit tier pins the POLICY (horizons, source order, schedule). This tier
 * proves the BEHAVIOUR the mocks structurally cannot:
 *
 *   • an old SUCCESS is deleted; a recent success is not;
 *   • an old FAILURE survives the success horizon — failures are the diagnostic
 *     record and must outlive the noise;
 *   • a row with a NULL outcome (what a crashed invocation leaves behind) is
 *     treated as a failure, not as noise;
 *   • the function REFUSES a success horizon under 8 days, so a caller cannot
 *     shrink retention below the 7-day window ops-snapshot reads — the unsafe
 *     configuration is unrepresentable, not merely discouraged;
 *   • p_max_rows genuinely bounds one invocation, which is what keeps this from
 *     ever becoming a long blocking DELETE against a table the per-minute crons
 *     are writing into;
 *   • anon cannot execute the SECURITY DEFINER delete through PostgREST.
 *
 * Every fixture row uses a dedicated route name so the suite never touches real
 * telemetry, and teardown removes exactly what it created.
 */

const ROUTE = "__test-retention__";
const svc = () => serviceClient();

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function seed(rows: Array<{ ok: boolean | null; days: number }>) {
  const payload = rows.map((r) => ({
    route: ROUTE,
    started_at: daysAgo(r.days),
    completed_at: daysAgo(r.days),
    ok: r.ok,
    duration_ms: 1,
  }));
  const { error } = await (svc().from("cron_runs" as never) as never as {
    insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
  }).insert(payload);
  expect(error, error?.message).toBeNull();
}

async function surviving(): Promise<Array<{ ok: boolean | null; started_at: string }>> {
  const { data, error } = await (svc().from("cron_runs" as never) as never as {
    select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: unknown; error: { message: string } | null }> };
  })
    .select("ok, started_at")
    .eq("route", ROUTE);
  expect(error, error?.message).toBeNull();
  return (data ?? []) as Array<{ ok: boolean | null; started_at: string }>;
}

async function clear() {
  await (svc().from("cron_runs" as never) as never as {
    delete: () => { eq: (k: string, v: string) => Promise<unknown> };
  })
    .delete()
    .eq("route", ROUTE);
}

describeIntegration("cron_runs retention (real Postgres)", () => {
  afterAll(clear);

  it("deletes old successes, keeps recent successes, and keeps old failures", async () => {
    await clear();
    await seed([
      { ok: true, days: 40 },   // old success        → deleted
      { ok: true, days: 20 },   // old success        → deleted
      { ok: true, days: 3 },    // recent success     → kept
      { ok: false, days: 40 },  // old failure        → kept (inside 90d)
      { ok: null, days: 40 },   // crashed run        → kept (inside 90d)
      { ok: false, days: 200 }, // ancient failure    → deleted (past 90d)
    ]);

    const { data, error } = await (svc().rpc as unknown as Rpc)("prune_cron_runs", {
      p_success_days: 14,
      p_failure_days: 90,
      p_max_rows: 50_000,
    });
    expect(error, error?.message).toBeNull();
    const row = (Array.isArray(data) ? data[0] : data) as {
      deleted_success: number;
      deleted_failure: number;
    };
    expect(Number(row.deleted_success)).toBe(2);
    expect(Number(row.deleted_failure)).toBe(1);

    const left = await surviving();
    expect(left).toHaveLength(3);
    // Exactly one recent success, and BOTH long-lived diagnostic rows.
    expect(left.filter((r) => r.ok === true)).toHaveLength(1);
    expect(left.filter((r) => r.ok === false)).toHaveLength(1);
    expect(left.filter((r) => r.ok === null)).toHaveLength(1);
  });

  it("REFUSES a success horizon under 8 days — the ops window is unrepresentably small", async () => {
    const { error } = await (svc().rpc as unknown as Rpc)("prune_cron_runs", {
      p_success_days: 7,
      p_failure_days: 90,
      p_max_rows: 10,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/p_success_days must be >= 8/i);
  });

  it("REFUSES a failure horizon shorter than the success horizon", async () => {
    const { error } = await (svc().rpc as unknown as Rpc)("prune_cron_runs", {
      p_success_days: 14,
      p_failure_days: 10,
      p_max_rows: 10,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must be >= p_success_days/i);
  });

  it("bounds one invocation to p_max_rows — catch-up is spread, never a long lock", async () => {
    await clear();
    await seed(Array.from({ length: 12 }, () => ({ ok: true as const, days: 30 })));

    const { data, error } = await (svc().rpc as unknown as Rpc)("prune_cron_runs", {
      p_success_days: 14,
      p_failure_days: 90,
      p_max_rows: 5,
    });
    expect(error, error?.message).toBeNull();
    const row = (Array.isArray(data) ? data[0] : data) as { deleted_success: number };
    expect(Number(row.deleted_success)).toBe(5);
    expect(await surviving()).toHaveLength(7);
  });

  it("anon cannot execute the SECURITY DEFINER delete", async () => {
    const { error } = await (anonClient().rpc as unknown as Rpc)("prune_cron_runs", {
      p_success_days: 14,
      p_failure_days: 90,
      p_max_rows: 1,
    });
    expect(error, "anon reached a service-role-only delete").not.toBeNull();
  });
});
