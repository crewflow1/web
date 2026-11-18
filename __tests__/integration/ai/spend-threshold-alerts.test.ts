import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * 80% / 100% HQ spend alerts on REAL Postgres (20261363000000).
 *
 * Proves, against the actual SQL and the actual governor seam:
 *   • ai_claim_spend_alerts returns a threshold to EXACTLY ONE caller per
 *     (month, scope, org, threshold) — sequentially and under 30-way concurrency;
 *   • 80% fires on committed spend, 100% on a refusal, and 100 also claims 80;
 *   • an org whose ceiling is 0 (AI switched off) raises nothing;
 *   • end to end: a governed call refused by the org ceiling writes ONE HQ
 *     notification, however many refusals follow.
 *
 * Scoped to two synthetic orgs (tagged slugs) plus the platform marks of the
 * current month, all removed afterwards. Platform SPEND is never seeded — the
 * CrewFlow-wide ceiling is shared by every worktree on this database — so the
 * platform scope is exercised through the refusal path only.
 */

type Row = Record<string, unknown>;
type Res<T = unknown> = PromiseLike<{ data: T; error: { message: string } | null }>;
type Db = {
  rpc(fn: string, args: Row): Res;
  from(t: string): {
    insert(row: Row): Res & { select(cols: string): { single(): Res<Row | null> } };
    upsert(row: Row): Res;
    select(cols: string): { eq(c: string, v: unknown): Res<Row[] | null> & { eq(c: string, v: unknown): Res<Row[] | null> } };
    delete(): {
      eq(col: string, val: unknown): Res & { eq(col: string, val: unknown): Res };
    };
  };
};
const db = (c: unknown) => c as unknown as Db;
const TOKEN = `ai-spend-alerts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("AI spend threshold alerts · real Postgres", () => {
  let orgA = "";
  let orgB = "";

  const claim = async (org: string, refused: "org" | "platform" | null = null): Promise<Row[]> => {
    const r = await db(serviceClient()).rpc("ai_claim_spend_alerts", {
      p_org_id: org,
      p_default_ceiling_pence: 10_000,
      p_refused: refused,
    });
    expect(r.error, r.error?.message).toBeNull();
    return Array.isArray(r.data) ? (r.data as Row[]) : [];
  };
  const orgRows = (rows: Row[], org: string) => rows.filter((r) => r.scope === "org" && r.org_id === org);

  async function seedSpend(org: string, pence: number) {
    const r = await db(serviceClient()).from("ai_invocations").insert({
      org_id: org,
      feature: "quote.writer_draft",
      task_class: "drafting",
      provider: "anthropic",
      model: "spend-alert-probe",
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_pence: pence,
      latency_ms: 1,
      success: true,
    });
    expect(r.error, r.error?.message).toBeNull();
  }

  async function resetOrg(org: string) {
    if (!org) return;
    const c = db(serviceClient());
    for (const t of ["ai_spend_alert_marks", "ai_cost_reservations", "ai_invocations", "ai_org_budget_ceilings", "notifications"]) {
      const r = await c.from(t).delete().eq("org_id", org);
      expect(r.error, `${t}: ${r.error?.message}`).toBeNull();
    }
  }

  async function clearPlatformMarks() {
    const r = await db(serviceClient()).from("ai_spend_alert_marks").delete().eq("scope", "platform");
    expect(r.error, r.error?.message).toBeNull();
  }

  beforeAll(async () => {
    for (const suffix of ["a", "b"]) {
      const r = await db(serviceClient())
        .from("organizations")
        .insert({ name: `ai-agent spend-alert org ${suffix}`, slug: `${TOKEN}-${suffix}` })
        .select("id")
        .single();
      expect(r.error, r.error?.message).toBeNull();
      if (suffix === "a") orgA = String(r.data?.id ?? "");
      else orgB = String(r.data?.id ?? "");
    }
  });

  afterAll(async () => {
    await clearPlatformMarks();
    for (const org of [orgA, orgB]) {
      await resetOrg(org);
      if (org) await db(serviceClient()).from("organizations").delete().eq("id", org);
    }
  });

  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "");
    await resetOrg(orgA);
    await resetOrg(orgB);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("below 80%: nothing; at 80% committed: the 80 mark once; repeats return nothing", async () => {
    await seedSpend(orgA, 7_999);
    expect(orgRows(await claim(orgA), orgA)).toEqual([]);
    await seedSpend(orgA, 1); // 8,000 / 10,000 = 80%
    const first = orgRows(await claim(orgA), orgA);
    expect(first.map((r) => Number(r.threshold))).toEqual([80]);
    expect(Number(first[0]!.spent_pence)).toBe(8_000);
    expect(Number(first[0]!.ceiling_pence)).toBe(10_000);
    expect(orgRows(await claim(orgA), orgA)).toEqual([]);
  });

  it("30 concurrent refusals: exactly ONE caller receives the 100 mark (and 80 with it)", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => claim(orgA, "org")));
    const winners = results.filter((rows) => orgRows(rows, orgA).length > 0);
    expect(winners).toHaveLength(1);
    expect(orgRows(winners[0]!, orgA).map((r) => Number(r.threshold)).sort((x, y) => x - y)).toEqual([80, 100]);
    const { data } = await db(serviceClient()).from("ai_spend_alert_marks").select("threshold").eq("org_id", orgA);
    expect((data ?? []).map((r) => Number(r.threshold)).sort((x, y) => x - y)).toEqual([80, 100]);
  });

  it("an org with its ceiling set to 0 (AI off) raises nothing, even on a refusal", async () => {
    const up = await db(serviceClient()).from("ai_org_budget_ceilings").upsert({ org_id: orgB, ceiling_pence: 0 });
    expect(up.error, up.error?.message).toBeNull();
    expect(orgRows(await claim(orgB, "org"), orgB)).toEqual([]);
  });

  it("the org override ceiling is honoured (2,000p override ⇒ 80% at 1,600p)", async () => {
    const up = await db(serviceClient()).from("ai_org_budget_ceilings").upsert({ org_id: orgB, ceiling_pence: 2_000 });
    expect(up.error, up.error?.message).toBeNull();
    await seedSpend(orgB, 1_600);
    const rows = orgRows(await claim(orgB), orgB);
    expect(rows.map((r) => [Number(r.threshold), Number(r.ceiling_pence)])).toEqual([[80, 2_000]]);
  });

  it("platform refusal: one winner among 20 concurrent callers gets platform 80 + 100", async () => {
    await clearPlatformMarks();
    const results = await Promise.all(Array.from({ length: 20 }, () => claim(orgA, "platform")));
    const plat = results.map((rows) => rows.filter((r) => r.scope === "platform"));
    const winners = plat.filter((rows) => rows.length > 0);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.map((r) => Number(r.threshold)).sort((x, y) => x - y)).toEqual([80, 100]);
    expect(winners[0]!.every((r) => r.org_id === null)).toBe(true);
    await clearPlatformMarks();
  });

  it("rejects an unknown p_refused value", async () => {
    const r = await db(serviceClient()).rpc("ai_claim_spend_alerts", {
      p_org_id: orgA,
      p_default_ceiling_pence: 10_000,
      p_refused: "everything",
    });
    expect(r.error?.message).toMatch(/p_refused/);
  });

  it("end to end: a governed call refused by the org ceiling writes ONE HQ notification across repeated refusals", async () => {
    // Arm the drafting tier with an inert credential; the governed fn is a mock
    // and is never reached (the reservation refuses first). No provider call.
    vi.stubEnv("ANTHROPIC_API_KEY", "integration-inert-not-a-real-key");
    const up = await db(serviceClient()).from("ai_org_budget_ceilings").upsert({ org_id: orgB, ceiling_pence: 1 });
    expect(up.error, up.error?.message).toBeNull();
    await seedSpend(orgB, 1);

    const { invokeWithGovernor } = await import("@/lib/ai/governor");
    const { __resetSpendAlertMemoForTests } = await import("@/lib/ai/governor/spend-alerts");
    const { TIER_MODEL } = await import("@/lib/ai/governor/registry");
    const fn = vi.fn(async () => ({ value: "never", usage: null }));
    const taskClass = TIER_MODEL.mid ? "drafting" : null;
    if (!taskClass) {
      // The registry ships the mid tier bound; if a future change unbinds it the
      // seam short-circuits dark and there is nothing to refuse. Fail loudly.
      throw new Error("mid tier unbound — update this test to a bound tier");
    }

    for (let i = 0; i < 3; i++) {
      __resetSpendAlertMemoForTests(); // simulate three different server instances
      const out = await invokeWithGovernor("quote.writer_draft", "drafting", fn, { orgId: orgB, userId: null });
      expect(out.status).toBe("blocked");
      if (out.status === "blocked") expect(out.reason).toBe("ceiling");
    }
    expect(fn).not.toHaveBeenCalled();

    const { data } = await db(serviceClient())
      .from("notifications")
      .select("type, audience, priority, action_url")
      .eq("org_id", orgB)
      .eq("source_module", "ai_budget");
    const rows = (data ?? []) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "ai.budget.reached", audience: "hq", priority: "urgent", action_url: "/admin/ai-costs" });
  });
});
