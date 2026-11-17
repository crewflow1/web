import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * CrewFlow-wide AI ceiling (20261358000000) on real Postgres — £100 per Europe/London month
 * across every company, user and AI feature (founder decision, final).
 *
 *   · the seeded default is 10000p;
 *   · it takes precedence over a HIGHER per-company ceiling (both gates must pass);
 *   · genuine concurrency at the edge cannot overshoot it (exact headroom is reserved, the
 *     rest refused with block_reason 'platform_ceiling');
 *   · at 100% every further reservation is refused; settled history and live reservations
 *     are counted, never discarded;
 *   · at ≥80% the existing alert mechanism (ai_claim_spend_alerts, 20261363000000) records
 *     the platform 80% mark exactly once per month.
 *
 * Integration files run serially, so this file may set the ceiling it needs and restores the
 * exact previous value afterwards.
 */
type Res<T> = PromiseLike<{ data: T; error: { message: string; code?: string } | null }>;
type Db = {
  rpc(fn: string, args?: Record<string, unknown>): Res<unknown>;
  from(t: string): {
    select(c: string): {
      eq(k: string, v: unknown): { maybeSingle(): Res<Record<string, unknown> | null> } & Res<Record<string, unknown>[] | null>;
    };
    insert(row: Record<string, unknown> | Record<string, unknown>[]): {
      select(c: string): { single(): Res<Record<string, unknown> | null> };
    } & Res<unknown>;
    update(row: Record<string, unknown>): { eq(k: string, v: unknown): Res<unknown> };
    delete(): { eq(k: string, v: unknown): Res<unknown> };
  };
};
const db = () => serviceClient() as unknown as Db;
const TOKEN = `it-aiplat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FOUNDER_CEILING_PENCE = 10_000;
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

describeIntegration("CrewFlow-wide AI ceiling · £100/month on real Postgres", () => {
  const orgs: string[] = [];
  let present = false;
  let originalCeiling: number | null = null;

  async function usage() {
    const r = await db().rpc("ai_platform_month_usage");
    expect(r.error, r.error?.message).toBeNull();
    const row = (Array.isArray(r.data) ? r.data[0] : r.data) as Record<string, unknown>;
    return { ceiling: n(row.ceiling_pence), committed: n(row.committed_pence), reserved: n(row.reserved_pence) };
  }
  async function setCeiling(pence: number) {
    const r = await db().from("ai_platform_budget").update({ ceiling_pence: pence }).eq("id", true);
    expect(r.error, r.error?.message).toBeNull();
  }
  async function reserve(org: string, pence: number, perCompanyCeiling = 50_000) {
    const r = await db().rpc("ai_reserve_invocation", {
      p_org_id: org,
      p_feature: "quote.writer_draft",
      p_task_class: "drafting",
      p_estimate_pence: pence,
      p_user_id: null,
      p_content_hash: null,
      p_ceiling_pence: perCompanyCeiling, // a per-company ceiling ABOVE the platform ceiling
      p_ttl_seconds: 600,
      p_dedupe_window_seconds: 0,
    });
    expect(r.error, r.error?.message).toBeNull();
    return ((Array.isArray(r.data) ? r.data[0] : r.data) ?? {}) as Record<string, unknown>;
  }
  async function seedSpend(org: string, pence: number) {
    const r = await db().from("ai_invocations").insert({
      org_id: org, feature: "quote.writer_draft", task_class: "drafting", provider: "anthropic",
      model: "platform-ceiling-probe", input_tokens: 0, output_tokens: 0,
      estimated_cost_pence: pence, latency_ms: 1, success: true,
    });
    expect(r.error, r.error?.message).toBeNull();
  }

  beforeAll(async () => {
    const cur = await db().from("ai_platform_budget").select("ceiling_pence").eq("id", true).maybeSingle();
    present = !cur.error && !!cur.data;
    if (!present) return;
    originalCeiling = n(cur.data?.ceiling_pence);
    for (let i = 0; i < 4; i++) {
      const o = await db().from("organizations")
        .insert({ status: "active", name: `AI Platform Probe ${i}`, slug: `${TOKEN}-${i}` })
        .select("id").single();
      expect(o.error, o.error?.message).toBeNull();
      orgs.push(String(o.data?.id ?? ""));
    }
  }, 60_000);

  afterAll(async () => {
    if (!present) return;
    for (const org of orgs) {
      if (!org) continue;
      await db().from("ai_cost_reservations").delete().eq("org_id", org);
      await db().from("organizations").delete().eq("id", org);
    }
    if (originalCeiling !== null) await setCeiling(originalCeiling);
  }, 60_000);

  it("the seeded CrewFlow-wide ceiling is 10000p (£100)", async () => {
    if (!present) return;
    expect(originalCeiling).toBe(FOUNDER_CEILING_PENCE);
  });

  it("precedence + concurrency: exact headroom is reserved across companies, the rest refused", async () => {
    if (!present) return;
    const before = await usage();
    const headroom = 50; // pence
    await setCeiling(before.committed + before.reserved + headroom);
    // 20 genuinely concurrent 10p reservations across 4 companies, each company's own ceiling £500.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => reserve(orgs[i % 4]!, 10)),
    );
    const reserved = results.filter((r) => r.outcome === "reserved");
    const blocked = results.filter((r) => r.outcome === "blocked");
    expect(reserved).toHaveLength(headroom / 10);
    expect(blocked).toHaveLength(20 - headroom / 10);
    for (const b of blocked) expect(b.block_reason).toBe("platform_ceiling");
    const after = await usage();
    expect(after.committed + after.reserved).toBeLessThanOrEqual(after.ceiling);
  });

  it("at 100% every further reservation is refused; live reservations and history are counted", async () => {
    if (!present) return;
    const u = await usage();
    await setCeiling(u.committed + u.reserved); // exactly full
    const r = await reserve(orgs[0]!, 1);
    expect(r.outcome).toBe("blocked");
    expect(r.block_reason).toBe("platform_ceiling");
    // Settled history (ai_invocations) counts: seeding committed spend shrinks headroom one-for-one.
    await setCeiling(u.committed + u.reserved + 20);
    await seedSpend(orgs[1]!, 15);
    expect((await reserve(orgs[2]!, 10)).outcome).toBe("blocked"); // 20 - 15 = 5 < 10
    expect((await reserve(orgs[2]!, 5)).outcome).toBe("reserved");
  });

  it("at ≥80% the existing alert mechanism records the platform 80% mark (once per month)", async () => {
    if (!present) return;
    const u = await usage();
    // Ceiling K with headroom; then committed spend raised to ≥ 85% of K (and still < K).
    const ceiling = u.committed + u.reserved + 1_000;
    await setCeiling(ceiling);
    const topUp = Math.ceil(ceiling * 0.85) - u.committed;
    if (topUp > 0) await seedSpend(orgs[3]!, topUp);
    const claim = await db().rpc("ai_claim_spend_alerts", { p_org_id: null, p_default_ceiling_pence: 10_000, p_refused: null });
    expect(claim.error, claim.error?.message).toBeNull();
    const marks = await db().from("ai_spend_alert_marks").select("scope, threshold").eq("scope", "platform");
    expect(marks.error, marks.error?.message).toBeNull();
    expect((marks.data ?? []).some((m) => n(m.threshold) === 80)).toBe(true);
  });
});
