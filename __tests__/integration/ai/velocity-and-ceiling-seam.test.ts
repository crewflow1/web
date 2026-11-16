import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { durableKey } from "@/lib/security/rate-limit";
import { describeIntegration, serviceClient, ukTodayIso } from "../_harness";

/**
 * THE GOVERNOR SEAM ON REAL POSTGRES — velocity limit + ceiling, under
 * genuine concurrency, driven through `invokeWithGovernor` itself.
 *
 * `budget-reservation.test.ts` proves the SQL (`ai_reserve_invocation`) directly.
 * This file proves the two things that only exist ABOVE the SQL:
 *
 *   1. THE VELOCITY LIMITER'S DURABLE PATH. In production `consume()` counts in
 *      Postgres (`rate_limit_hit`, one atomic upsert). The unit tier can only
 *      exercise the in-process counter; here NODE_ENV is production-stubbed so
 *      the limiter takes the durable path against the live function, and N
 *      concurrent callers must be admitted EXACTLY up to the limit — no
 *      over-admission from racing upserts.
 *
 *   2. THE TYPESCRIPT SEAM FAILS CLOSED AT THE CEILING, with the claim the
 *      build actually computes for the mid tier. An org with headroom for
 *      exactly two claims, hit by twelve simultaneous calls from twelve
 *      different users: exactly two reach the "provider", ten are refused, and
 *      committed spend never crosses the ceiling.
 *
 * SIMULATED-ONLY PROVIDER. No vendor key exists in this environment and nothing
 * here opens a socket to a model: the governed function is a vi.fn returning a
 * usage report. `ANTHROPIC_API_KEY` is stubbed with an inert value purely so the
 * readiness check sees binding + credential and the seam reaches the
 * reservation path instead of the dark short-circuit.
 *
 * Fixtures are namespaced `sec-secrets-…` and removed in afterAll.
 */

type Row = Record<string, unknown>;
type Db = {
  rpc(fn: string, args: Row): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(t: string): {
    insert(row: Row): PromiseLike<{ error: { message: string } | null }> & {
      select(cols: string): {
        single(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
      };
    };
    delete(): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message: string } | null }>;
      like(col: string, val: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown) => c as unknown as Db;
const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

const TOKEN = `sec-secrets-vel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** A random uuid — used as a limiter subject, and as a user id the database has no row for. */
const uuid = () => crypto.randomUUID();

describeIntegration("AI governor seam · velocity + ceiling on real Postgres", () => {
  let orgId = "";
  let orgB = "";

  async function committed(org: string): Promise<number> {
    const res = await db(serviceClient()).rpc("ai_invocations_month_totals", {
      p_org_id: org,
      p_month: ukTodayIso(),
    });
    expect(res.error, res.error?.message).toBeNull();
    const rows = Array.isArray(res.data) ? (res.data as Row[]) : [];
    return n(rows[0]?.total_cost_pence);
  }

  async function seedSpend(org: string, pence: number) {
    const res = await db(serviceClient()).from("ai_invocations").insert({
      org_id: org,
      feature: "quote.writer_draft",
      task_class: "drafting",
      provider: "anthropic",
      model: "seam-probe",
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_pence: pence,
      latency_ms: 1,
      success: true,
    });
    expect(res.error, res.error?.message).toBeNull();
  }

  async function resetOrg(org: string) {
    const r = await db(serviceClient()).from("ai_cost_reservations").delete().eq("org_id", org);
    expect(r.error, r.error?.message).toBeNull();
    const i = await db(serviceClient()).from("ai_invocations").delete().eq("org_id", org);
    expect(i.error, i.error?.message).toBeNull();
  }

  /** Remove every limiter counter this file created (keys embed the org id). */
  async function clearCounters() {
    for (const org of [orgId, orgB]) {
      if (!org) continue;
      // Keys are `${route}:h1_<digest(identifier)>`; the digest does not depend on the route.
      const digest = durableKey("probe", org).split(":h1_")[1];
      const res = await db(serviceClient())
        .from("rate_limit_counters")
        .delete()
        .like("key", `ai_velocity_%:h1_${digest}`);
      expect(res.error, res.error?.message).toBeNull();
    }
  }

  beforeAll(async () => {
    const a = await db(serviceClient())
      .from("organizations")
      .insert({ name: "sec-secrets velocity org A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    orgId = String(a.data?.id ?? "");
    const b = await db(serviceClient())
      .from("organizations")
      .insert({ name: "sec-secrets velocity org B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    orgB = String(b.data?.id ?? "");
  });

  afterAll(async () => {
    await clearCounters();
    for (const org of [orgId, orgB]) {
      if (!org) continue;
      await resetOrg(org);
      const d = await db(serviceClient()).from("organizations").delete().eq("id", org);
      expect(d.error, d.error?.message).toBeNull();
    }
  });

  beforeEach(async () => {
    // The admin client (lib/supabase/admin.ts) reads NEXT_PUBLIC_SUPABASE_URL;
    // the integration env may only carry the bare SUPABASE_URL.
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
    );
    // Inert credential: binding + credential ⇒ the seam reaches the reservation
    // path. The governed function below is a mock; no provider is contacted.
    vi.stubEnv("ANTHROPIC_API_KEY", "integration-inert-not-a-real-key");
    // The DURABLE limiter path (Postgres rate_limit_hit) is production-only.
    vi.stubEnv("NODE_ENV", "production");
    await resetOrg(orgId);
    await resetOrg(orgB);
    await clearCounters();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the durable limiter admits EXACTLY the limit under 40-way concurrency (no racing over-admission)", async () => {
    const { consumeAiVelocity, velocityLimitsFor } = await import("@/lib/ai/governor/velocity");
    // A 600p claim derives the floors: 10 per user, 20 per org.
    const claimPence = 600;
    const limits = velocityLimitsFor(claimPence);
    expect(limits).toEqual({ orgCallsPerWindow: 20, userCallsPerWindow: 10 });

    const userId = uuid();
    const decisions = await Promise.all(
      Array.from({ length: 40 }, () =>
        consumeAiVelocity({ orgId, userId, feature: "quote.writer_draft", claimPence }),
      ),
    );
    const admitted = decisions.filter((d) => d.allowed).length;
    expect(admitted, "one user, 40 simultaneous calls ⇒ exactly the user limit").toBe(
      limits.userCallsPerWindow,
    );
    for (const d of decisions) if (!d.allowed) expect(d.scope).toBe("user");
  });

  it("the ORG window bounds system work (no user) under concurrency, and does not bleed across orgs", async () => {
    const { consumeAiVelocity } = await import("@/lib/ai/governor/velocity");
    const claimPence = 600; // org limit 20
    const storm = (org: string) =>
      Promise.all(
        Array.from({ length: 35 }, () =>
          consumeAiVelocity({ orgId: org, userId: null, feature: "chat.auto_reply", claimPence }),
        ),
      );
    const [a, b] = await Promise.all([storm(orgId), storm(orgB)]);
    expect(a.filter((d) => d.allowed).length).toBe(20);
    expect(b.filter((d) => d.allowed).length, "org B has its own window").toBe(20);
  });

  it("a rate-limited call takes NO budget claim and writes NO ledger row", async () => {
    const { invokeWithGovernor } = await import("@/lib/ai/governor");
    const { velocityLimitsFor } = await import("@/lib/ai/governor/velocity");
    const { reservationClaimPence } = await import("@/lib/ai/governor/policy");
    const { TIER_MODEL } = await import("@/lib/ai/governor/registry");
    const mid = TIER_MODEL.mid!;
    const claim = reservationClaimPence(mid, {
      inputTokens: mid.reserveInputTokens,
      outputTokens: mid.reserveOutputTokens,
    });
    const userLimit = velocityLimitsFor(claim).userCallsPerWindow;

    // Fill this user's window directly in the durable store (same key the limiter uses).
    const userId = uuid();
    // The limiter stores a keyed digest of the identifier (lib/security/rate-limit durableKey).
    const key = durableKey("ai_velocity_user:insights.question", `${orgId}:${userId}`);
    for (let i = 0; i < userLimit; i++) {
      const hit = await db(serviceClient()).rpc("rate_limit_hit", {
        p_key: key,
        p_limit: userLimit,
        p_window_seconds: 3600,
      });
      expect(hit.error, hit.error?.message).toBeNull();
    }

    const fn = vi.fn(async () => ({
      value: "answer",
      usage: { provider: "anthropic", model: "seam-probe", inputTokens: 100, outputTokens: 50 },
    }));
    const out = await invokeWithGovernor("insights.question", "drafting", fn, { orgId, userId });

    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("rate_limited");
    expect(fn).not.toHaveBeenCalled();
    expect(await committed(orgId), "nothing was spent").toBe(0);
    const live = await db(serviceClient()).rpc("ai_reservations_month_totals", {
      p_org_id: orgId,
      p_month: ukTodayIso(),
    });
    const row = (Array.isArray(live.data) ? (live.data[0] as Row | undefined) : undefined) ?? {};
    expect(n(row.live_count), "no claim was taken").toBe(0);
  });

  it("THE CEILING FAILS CLOSED THROUGH THE SEAM: 12 simultaneous calls, headroom for 2 ⇒ exactly 2 reach the provider", async () => {
    const { invokeWithGovernor, AI_MONTHLY_CEILING_PENCE } = await import("@/lib/ai/governor");
    const { reservationClaimPence } = await import("@/lib/ai/governor/policy");
    const { TIER_MODEL } = await import("@/lib/ai/governor/registry");
    const mid = TIER_MODEL.mid!;
    const claim = reservationClaimPence(mid, {
      inputTokens: mid.reserveInputTokens,
      outputTokens: mid.reserveOutputTokens,
    });
    // 8,000 in × $2 + 4,000 out × $10 = $0.056 → 4.48p → 5p. The corrected envelope.
    expect(claim).toBe(5);

    // Leave headroom for exactly two claims.
    await seedSpend(orgId, AI_MONTHLY_CEILING_PENCE - 2 * claim);

    // Each "provider" call reports the WORST CASE the envelope was sized for, so
    // the settled cost equals the claim and the org lands exactly on the ceiling.
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 150)); // hold the claims in flight together
      return {
        value: "draft",
        usage: {
          provider: "anthropic",
          model: "seam-probe",
          inputTokens: mid.reserveInputTokens,
          outputTokens: mid.reserveOutputTokens,
        },
      };
    });

    // Twelve calls with DIFFERENT content and no per-user subject (userId null —
    // `ai_cost_reservations.user_id` FKs public.users, so a synthetic user id
    // would be refused by the database itself). Twelve is far inside the org
    // velocity window (500/h at this claim) and dedupe cannot match, so the
    // only thing that can refuse here is the ceiling.
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        invokeWithGovernor("quote.writer_draft", "drafting", fn, {
          orgId,
          userId: null,
          dedupeContent: `${TOKEN} request ${i}`,
        }),
      ),
    );

    const ran = outcomes.filter((o) => o.status === "ran");
    const blocked = outcomes.filter((o) => o.status === "blocked");
    expect(ran.length, "exactly the calls that fit").toBe(2);
    expect(blocked.length).toBe(10);
    for (const b of blocked) if (b.status === "blocked") expect(b.reason).toBe("ceiling");
    expect(fn, "a refused call never reaches the provider").toHaveBeenCalledTimes(2);
    expect(await committed(orgId), "committed spend lands ON the ceiling, never over").toBe(
      AI_MONTHLY_CEILING_PENCE,
    );

    // …and the org is now closed: one more call is refused without running.
    const after = vi.fn(async () => ({ value: "x", usage: null }));
    const next = await invokeWithGovernor("quote.writer_draft", "drafting", after, {
      orgId,
      userId: null,
      dedupeContent: `${TOKEN} one more`,
    });
    expect(next.status).toBe("blocked");
    expect(after).not.toHaveBeenCalled();
  });

  it("an exhausted org does not close a DIFFERENT org (tenant isolation of the budget)", async () => {
    const { invokeWithGovernor, AI_MONTHLY_CEILING_PENCE } = await import("@/lib/ai/governor");
    await seedSpend(orgId, AI_MONTHLY_CEILING_PENCE);
    const fn = vi.fn(async () => ({ value: "ok", usage: null }));
    const a = await invokeWithGovernor("quote.writer_draft", "drafting", fn, {
      orgId,
      userId: null,
    });
    const b = await invokeWithGovernor("quote.writer_draft", "drafting", fn, {
      orgId: orgB,
      userId: null,
    });
    expect(a.status).toBe("blocked");
    if (a.status === "blocked") expect(a.reason).toBe("ceiling");
    expect(b.status).toBe("ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a user id the database does not know FAILS CLOSED (reservation refused, provider never reached)", async () => {
    // `ai_cost_reservations.user_id` references public.users. An id with no row
    // makes the claim insert fail, and the seam must treat that as a refusal —
    // never as "no limit applies, go ahead".
    const { invokeWithGovernor } = await import("@/lib/ai/governor");
    const fn = vi.fn(async () => ({ value: "ok", usage: null }));
    const out = await invokeWithGovernor("quote.writer_draft", "drafting", fn, {
      orgId,
      userId: uuid(),
    });
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("reservation_unavailable");
    expect(fn).not.toHaveBeenCalled();
  });
});
