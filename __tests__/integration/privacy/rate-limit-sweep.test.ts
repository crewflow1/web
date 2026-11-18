import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * rate_limit_counters retention — real-Postgres proof (M-3 / RETENTION-PROCEDURES.md).
 * The unit tier mocks the RPC; this proves `rate_limit_sweep()` really deletes
 * windows closed for more than a day and keeps open / recently-closed ones.
 * Synthetic keys are tagged and removed afterwards.
 */
const TAG = `pdtest:${Date.now()}`;
const k = (n: string) => `${TAG}:${n}`;

async function clear() {
  const sb = serviceClient();
  await sb.from("rate_limit_counters").delete().like("key", `${TAG}:%`);
}

describeIntegration("rate_limit_sweep (real Postgres)", () => {
  afterAll(clear);

  it("deletes windows closed > 1 day ago, keeps open and recently closed ones", async () => {
    const sb = serviceClient();
    await clear();
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    const rows = [
      { key: k("old"), count: 3, window_start: iso(-3 * 864e5), reset_at: iso(-2 * 864e5) },
      { key: k("recent"), count: 3, window_start: iso(-3600e3), reset_at: iso(-1800e3) },
      { key: k("open"), count: 1, window_start: iso(-60e3), reset_at: iso(60e3) },
    ];
    const ins = await sb.from("rate_limit_counters").insert(rows);
    expect(ins.error).toBeNull();

    const rpc = await (sb.rpc as unknown as (f: string) => Promise<{ error: { message: string } | null }>)("rate_limit_sweep");
    expect(rpc.error).toBeNull();

    const { data } = await sb.from("rate_limit_counters").select("key").like("key", `${TAG}:%`);
    const keys = (data ?? []).map((r) => r.key).sort();
    expect(keys).toEqual([k("open"), k("recent")].sort());
  });
});
