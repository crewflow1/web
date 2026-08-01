import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { describeIntegration, serviceClient, ukTodayIso } from "../_harness";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ATOMIC AI BUDGET RESERVATION, PARAMETERISED FOR `task_class = 'embedding'`
 * — against REAL Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Migration 20261080 widened the `task_class` CHECKs on `ai_invocations` and
 * `ai_cost_reservations` to admit 'embedding' — the change that made embeddings
 * governable at all. The sibling suite (./budget-reservation.test.ts) proves
 * the reserve→settle→release machinery for the generative classes; this file
 * proves the SAME guarantees hold verbatim for the new class, because "the
 * CHECK now admits the value" is a necessary condition, not a sufficient one:
 * the advisory lock, the dedupe window, tenant isolation and settlement all
 * carry `task_class` through, and each is re-driven here under the new value
 * with genuine concurrency (separate PostgREST requests, one transaction per
 * connection).
 *
 * The embedding tier is DARK in this build (TIER_MODEL.embedding === null), so
 * — exactly as the sibling suite does — these tests call the SQL directly
 * rather than through `invokeWithGovernor`. The SQL is where the guarantee
 * lives, and it must hold for the day the tier is bound.
 */

type Rpc = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
  from(t: string): {
    select(cols: string): {
      eq(col: string, val: unknown): PromiseLike<{
        data: Row[] | null;
        error: { message: string } | null;
      }>;
    };
    insert(rows: Row | Row[]): PromiseLike<{ error: { message: string } | null }> & {
      select(cols: string): {
        single(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
      };
    };
    delete(): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};
type Row = Record<string, unknown>;
const db = (c: unknown) => c as unknown as Rpc;

const TOKEN = `it-aiemb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CEILING = 10_000;
/** The registered worker feature — embeddings bill to HQ's own org in prod. */
const FEATURE = "memory.embedding_write";
const CLASS = "embedding";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

describeIntegration("AI budget reservation · task_class 'embedding' on real Postgres", () => {
  let orgA = "";
  let orgB = "";

  /** Reserve through the LIVE RPC, always under the 'embedding' class. */
  async function reserve(
    orgId: string,
    claimPence: number,
    opts: { hash?: string | null; ttlSeconds?: number; ceiling?: number } = {},
  ) {
    const res = await db(serviceClient()).rpc("ai_reserve_invocation", {
      p_org_id: orgId,
      p_feature: FEATURE,
      p_task_class: CLASS,
      p_estimate_pence: claimPence,
      p_user_id: null,
      p_content_hash: opts.hash ?? null,
      p_ceiling_pence: opts.ceiling ?? CEILING,
      p_ttl_seconds: opts.ttlSeconds ?? 600,
      p_dedupe_window_seconds: 900,
    });
    const row = (Array.isArray(res.data) ? (res.data[0] as Row | undefined) : undefined) ?? {};
    return { error: res.error, row };
  }

  async function settle(
    reservationId: string,
    success: boolean,
    costPence: number,
    opts: { errorCode?: string; inputTokens?: number } = {},
  ) {
    const res = await db(serviceClient()).rpc("ai_settle_reservation", {
      p_reservation_id: reservationId,
      p_success: success,
      p_cost_pence: costPence,
      p_provider: "openai",
      p_model: "embedding-reservation-probe",
      p_input_tokens: opts.inputTokens ?? 0,
      // Embeddings have no output tokens; the ledger records what the vendor
      // bills, which is input only.
      p_output_tokens: 0,
      p_latency_ms: 25,
      p_error_code: opts.errorCode ?? null,
    });
    const row = (Array.isArray(res.data) ? (res.data[0] as Row | undefined) : undefined) ?? {};
    return { error: res.error, row };
  }

  /** COMMITTED spend for an org this UK month, straight from the ledger. */
  async function committed(orgId: string): Promise<number> {
    const res = await db(serviceClient()).rpc("ai_invocations_month_totals", {
      p_org_id: orgId,
      p_month: ukTodayIso(),
    });
    expect(res.error, res.error?.message).toBeNull();
    const rows = (Array.isArray(res.data) ? (res.data as Row[]) : []) ?? [];
    return n(rows[0]?.total_cost_pence);
  }

  /** The reservation rollup — live claims and the state breakdown. */
  async function claims(orgId: string) {
    const res = await db(serviceClient()).rpc("ai_reservations_month_totals", {
      p_org_id: orgId,
      p_month: ukTodayIso(),
    });
    expect(res.error, res.error?.message).toBeNull();
    const rows = (Array.isArray(res.data) ? (res.data as Row[]) : []) ?? [];
    const row = rows[0] ?? {};
    return {
      livePence: n(row.live_pence),
      liveCount: n(row.live_count),
      settled: n(row.settled_count),
      released: n(row.released_count),
    };
  }

  /** Pre-commit spend so a test starts from a known position. */
  async function seedSpend(orgId: string, pence: number) {
    const res = await db(serviceClient())
      .from("ai_invocations")
      .insert({
        org_id: orgId,
        feature: FEATURE,
        task_class: CLASS,
        provider: "openai",
        model: "embedding-reservation-probe",
        input_tokens: 0,
        output_tokens: 0,
        estimated_cost_pence: pence,
        latency_ms: 1,
        success: true,
      });
    expect(res.error, res.error?.message).toBeNull();
  }

  /** Wipe both tables for an org, so each test starts from zero. */
  async function resetOrg(orgId: string) {
    // Reservations first: `invocation_id` FKs the ledger.
    const r = await db(serviceClient()).from("ai_cost_reservations").delete().eq("org_id", orgId);
    expect(r.error, r.error?.message).toBeNull();
    const i = await db(serviceClient()).from("ai_invocations").delete().eq("org_id", orgId);
    expect(i.error, i.error?.message).toBeNull();
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc
      .from("organizations")
      .insert({ name: "AI Embedding Reservation Org A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    orgA = String(a.data?.id ?? "");
    const b = await svc
      .from("organizations")
      .insert({ name: "AI Embedding Reservation Org B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");
  }, 60_000);

  afterAll(async () => {
    const svc = db(serviceClient());
    for (const org of [orgA, orgB]) {
      if (org) await svc.from("organizations").delete().eq("id", org);
    }
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════
  // (a) The widened CHECK is live — an embedding claim is representable.
  // ═══════════════════════════════════════════════════════════════════════

  describe("'embedding' is admitted by BOTH widened CHECKs (migration 20261080)", () => {
    it("a reservation under task_class 'embedding' is accepted, stored and readable", async () => {
      await resetOrg(orgA);
      const { error, row } = await reserve(orgA, 100);
      expect(error, error?.message).toBeNull();
      expect(row.outcome).toBe("reserved");
      const stored = await db(serviceClient())
        .from("ai_cost_reservations")
        .select("task_class, feature")
        .eq("org_id", orgA);
      expect(stored.error, stored.error?.message).toBeNull();
      expect(stored.data).toHaveLength(1);
      expect(stored.data?.[0]?.task_class).toBe(CLASS);
      expect(stored.data?.[0]?.feature).toBe(FEATURE);
    });

    it("'deterministic' is still refused at the CHECK — widening admitted nothing else", async () => {
      await resetOrg(orgA);
      const res = await db(serviceClient()).rpc("ai_reserve_invocation", {
        p_org_id: orgA,
        p_feature: FEATURE,
        p_task_class: "deterministic",
        p_estimate_pence: 100,
        p_user_id: null,
        p_content_hash: null,
        p_ceiling_pence: CEILING,
        p_ttl_seconds: 600,
        p_dedupe_window_seconds: 900,
      });
      expect(res.error).not.toBeNull();
      expect(res.error?.message ?? "").toMatch(/task_class/i);
      expect((await claims(orgA)).liveCount).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (b) The ceiling holds exactly under genuine concurrency — 20 at once.
  // ═══════════════════════════════════════════════════════════════════════

  describe("the ceiling holds exactly for concurrent embedding claims", () => {
    it("20 SIMULTANEOUS embedding claims: only those that FIT are admitted, total exact", async () => {
      await resetOrg(orgA);
      await seedSpend(orgA, 6_000); // £40 of headroom
      const CLAIM = 500; // 50p per batch ⇒ exactly eight fit

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          reserve(orgA, CLAIM, { hash: null, ttlSeconds: 600 }).then((r) => ({ i, ...r })),
        ),
      );
      for (const r of results) expect(r.error, r.error?.message).toBeNull();

      const reserved = results.filter((r) => r.row.outcome === "reserved");
      const blocked = results.filter((r) => r.row.outcome === "blocked");
      expect(reserved).toHaveLength(8);
      expect(blocked).toHaveLength(12);

      const after = await claims(orgA);
      expect(after.livePence).toBe(4_000);
      // THE INVARIANT, unchanged by the new class: exactly AT the ceiling.
      expect((await committed(orgA)) + after.livePence).toBe(CEILING);
    });

    it("an embedding claim that would breach is refused, not admitted and reconciled later", async () => {
      await resetOrg(orgA);
      await seedSpend(orgA, 9_800); // £2 of headroom
      const { row } = await reserve(orgA, 300);
      expect(row.outcome).toBe("blocked");
      expect(n(row.committed_pence)).toBe(9_800);
      expect((await claims(orgA)).liveCount).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (c) Duplicate content-hash dedupe — one paid batch per identity.
  // ═══════════════════════════════════════════════════════════════════════

  describe("dedupe holds for the embedding class — identical batches pay once", () => {
    it("ten SIMULTANEOUS identical embedding submits ⇒ exactly ONE claim", async () => {
      await resetOrg(orgA);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => reserve(orgA, 100, { hash: HASH_A })),
      );
      for (const r of results) expect(r.error, r.error?.message).toBeNull();
      expect(results.filter((r) => r.row.outcome === "reserved")).toHaveLength(1);
      const dupes = results.filter((r) => r.row.outcome === "duplicate");
      expect(dupes).toHaveLength(9);
      for (const d of dupes) expect(d.row.duplicate_reason).toBe("in_flight");
      expect((await claims(orgA)).liveCount).toBe(1);
    });

    it("after a settled success, the same batch is a RECENT SUCCESS — charged once", async () => {
      await resetOrg(orgA);
      const first = await reserve(orgA, 100, { hash: HASH_A });
      expect(first.row.outcome).toBe("reserved");
      await settle(String(first.row.reservation_id), true, 100, { inputTokens: 50_000 });

      const repeat = await reserve(orgA, 100, { hash: HASH_A });
      expect(repeat.row.outcome).toBe("duplicate");
      expect(repeat.row.duplicate_reason).toBe("recent_success");
      expect(await committed(orgA)).toBe(100);
    });

    it("a DIFFERENT batch is never suppressed by a recent one", async () => {
      await resetOrg(orgA);
      const a = await reserve(orgA, 100, { hash: HASH_A });
      expect(a.row.outcome).toBe("reserved");
      const b = await reserve(orgA, 100, { hash: HASH_B });
      expect(b.row.outcome).toBe("reserved");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (d) Tenant isolation — embedding spend is still per-org spend.
  // ═══════════════════════════════════════════════════════════════════════

  describe("one org cannot consume another's embedding budget", () => {
    it("org A at its ceiling leaves org B entirely unaffected", async () => {
      await resetOrg(orgA);
      await resetOrg(orgB);
      await seedSpend(orgA, CEILING);
      const a = await reserve(orgA, 100);
      const b = await reserve(orgB, 100);
      expect(a.row.outcome).toBe("blocked");
      expect(b.row.outcome).toBe("reserved");
      expect(n(b.row.committed_pence)).toBe(0);
    });

    it("an identical embedding batch in org B is NOT a duplicate of org A's", async () => {
      await resetOrg(orgA);
      await resetOrg(orgB);
      const a = await reserve(orgA, 100, { hash: HASH_A });
      expect(a.row.outcome).toBe("reserved");
      const b = await reserve(orgB, 100, { hash: HASH_A });
      expect(b.row.outcome).toBe("reserved");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (e) Settlement and release — the claim's lifecycle under the new class.
  // ═══════════════════════════════════════════════════════════════════════

  describe("settlement and release carry the embedding class into the ledger", () => {
    it("a success commits the real cost and the ledger row IS an 'embedding' row", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      expect((await claims(orgA)).livePence).toBe(1_000);

      const s = await settle(String(held.row.reservation_id), true, 40, { inputTokens: 2_000_000 });
      expect(s.error, s.error?.message).toBeNull();
      expect(s.row.outcome).toBe("settled");
      expect(await committed(orgA)).toBe(40);
      expect((await claims(orgA)).livePence).toBe(0);

      // The widened ai_invocations CHECK is what lets this row exist at all.
      const led = await db(serviceClient())
        .from("ai_invocations")
        .select("task_class, feature, input_tokens, output_tokens, success")
        .eq("org_id", orgA);
      expect(led.error, led.error?.message).toBeNull();
      const rows = led.data ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.task_class).toBe(CLASS);
      expect(rows[0]!.feature).toBe(FEATURE);
      expect(n(rows[0]!.input_tokens)).toBe(2_000_000);
      expect(n(rows[0]!.output_tokens)).toBe(0);
      expect(rows[0]!.success).toBe(true);
    });

    it("a FAILED embedding call settles — with a code, and a cost the ceiling can see", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      const s = await settle(String(held.row.reservation_id), false, 1, {
        errorCode: "provider_timeout",
      });
      expect(s.error, s.error?.message).toBeNull();
      expect(s.row.outcome).toBe("settled");
      expect(await committed(orgA)).toBe(1);
      expect((await claims(orgA)).livePence).toBe(0);

      const led = await db(serviceClient())
        .from("ai_invocations")
        .select("task_class, success, error_code, estimated_cost_pence")
        .eq("org_id", orgA);
      expect(led.error, led.error?.message).toBeNull();
      const rows = led.data ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.task_class).toBe(CLASS);
      expect(rows[0]!.success).toBe(false);
      expect(rows[0]!.error_code).toBe("provider_timeout");
      expect(n(rows[0]!.estimated_cost_pence)).toBe(1);
    });

    it("the RELEASE path frees the claim, writes NO ledger row, and unblocks the retry", async () => {
      // The worker's budget-refusal contract depends on this: a claim taken
      // and released (no provider call made) must cost nothing and must not
      // suppress the identical batch's retry.
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000, { hash: HASH_A });
      expect(held.row.outcome).toBe("reserved");
      expect((await claims(orgA)).livePence).toBe(1_000);

      const rel = await db(serviceClient()).rpc("ai_release_reservation", {
        p_reservation_id: held.row.reservation_id,
        p_reason: "no_provider_call",
      });
      expect(rel.error, rel.error?.message).toBeNull();

      const after = await claims(orgA);
      expect(after.livePence).toBe(0);
      expect(after.released).toBe(1);
      expect(await committed(orgA)).toBe(0);
      const led = await db(serviceClient())
        .from("ai_invocations")
        .select("id")
        .eq("org_id", orgA);
      expect(led.data ?? []).toEqual([]);

      const retry = await reserve(orgA, 1_000, { hash: HASH_A });
      expect(retry.row.outcome).toBe("reserved");
    });
  });
});
