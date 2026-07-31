import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { anonClient, describeIntegration, serviceClient, ukTodayIso, userClient } from "../_harness";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ATOMIC AI BUDGET RESERVATION — against REAL Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS TIER EXISTS TO PROVE, AND WHY NOTHING ELSE CAN.
 *
 * The £100/org/month AI ceiling used to be a START GATE: `invokeWithGovernor`
 * read the month's total, ran the provider call, then recorded the cost. N calls
 * in the same tick all read the same pre-spend total, all found themselves under
 * the ceiling, and all spent. The duplicate probe raced identically — ten
 * simultaneous identical submits all missed and all paid.
 *
 * Both are now decided by ONE SQL statement under a per-org advisory lock
 * (migration 20261070000000). That claim is about POSTGRES, so a mocked client
 * cannot test it: a JS fake is single-threaded and would pass whether or not the
 * lock existed. Every assertion below therefore drives the LIVE RPC, with
 * genuine concurrency via `Promise.all` over separate PostgREST requests — each
 * of which Postgres runs in its own transaction on its own connection.
 *
 * THE COUNTERFACTUAL IS NOT IN THIS FILE, and that is deliberate. Proving the
 * lock is load-bearing means running the same function WITHOUT it, which is a
 * DDL change this tier has no business making against a shared database. It is
 * done with two real psql sessions and recorded, with the transcript, in
 * docs/ai-cost-governor.md — the same treatment docs/operational-stock.md gives
 * the per-(item, site) stock lock.
 *
 * The governor itself is DARK (every tier maps to no model), so these tests call
 * the SQL directly rather than through `invokeWithGovernor`. That is the honest
 * seam to test: the SQL is where the guarantee lives, and it must hold for the
 * day a model is bound rather than only for a build that binds one.
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
      }> & {
        eq(col: string, val: unknown): PromiseLike<{
          data: Row[] | null;
          error: { message: string } | null;
        }>;
        order(col: string): PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
      };
    };
    insert(rows: Row | Row[]): PromiseLike<{ error: { message: string } | null }> & {
      select(cols: string): {
        single(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
      };
    };
    update(row: Row): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
    delete(): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};
type Row = Record<string, unknown>;
const db = (c: unknown) => c as unknown as Rpc;

const TOKEN = `it-airsv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CEILING = 10_000;
const FEATURE = "quote.writer_draft";
const CLASS = "drafting";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIntegration("AI budget reservation · atomic ceiling on real Postgres", () => {
  let orgA = "";
  let orgB = "";
  /** Owner of org A — the only role permitted to READ its reservations. */
  let adminA = { id: "", token: "" };
  /** Owner of org B — the cross-tenant control. */
  let adminB = { id: "", token: "" };
  /** A STAFF member of org A — usage data is admin information, not crew. */
  let memberA = { id: "", token: "" };

  async function mintUser(label: string) {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `AI reservation ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  /** Reserve through the LIVE RPC. */
  async function reserve(
    orgId: string,
    claimPence: number,
    opts: { hash?: string | null; ttlSeconds?: number; taskClass?: string; ceiling?: number } = {},
  ) {
    const res = await db(serviceClient()).rpc("ai_reserve_invocation", {
      p_org_id: orgId,
      p_feature: FEATURE,
      p_task_class: opts.taskClass ?? CLASS,
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
    opts: { errorCode?: string; inputTokens?: number; outputTokens?: number } = {},
  ) {
    const res = await db(serviceClient()).rpc("ai_settle_reservation", {
      p_reservation_id: reservationId,
      p_success: success,
      p_cost_pence: costPence,
      p_provider: "anthropic",
      p_model: "reservation-probe",
      p_input_tokens: opts.inputTokens ?? 0,
      p_output_tokens: opts.outputTokens ?? 0,
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
      expired: n(row.expired_count),
      overruns: n(row.overrun_count),
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
        provider: "anthropic",
        model: "reservation-probe",
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
      .insert({ name: "AI Reservation Org A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    orgA = String(a.data?.id ?? "");
    const b = await svc
      .from("organizations")
      .insert({ name: "AI Reservation Org B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    adminA = await mintUser("admin-a");
    adminB = await mintUser("admin-b");
    memberA = await mintUser("member-a");
    for (const [user, org, role] of [
      [adminA.id, orgA, "owner"],
      [adminB.id, orgB, "owner"],
      [memberA.id, orgA, "staff"],
    ] as const) {
      const m = await svc.from("memberships").insert({ user_id: user, org_id: org, role });
      expect(m.error, m.error?.message).toBeNull();
    }
  }, 60_000);

  afterAll(async () => {
    const svc = db(serviceClient());
    for (const org of [orgA, orgB]) {
      if (org) await svc.from("organizations").delete().eq("id", org);
    }
    for (const u of [adminA, adminB, memberA]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════
  // (a) THE CEILING HOLDS EXACTLY UNDER GENUINE CONCURRENCY.
  // ═══════════════════════════════════════════════════════════════════════

  describe("the ceiling holds exactly under genuine concurrency", () => {
    it("N simultaneous claims: only those that FIT are admitted, and the total is exact", async () => {
      await resetOrg(orgA);
      await seedSpend(orgA, 7_000); // £30 of headroom
      const CLAIM = 1_000; // £10 per call ⇒ exactly three fit

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          reserve(orgA, CLAIM, { hash: null, ttlSeconds: 600 }).then((r) => ({ i, ...r })),
        ),
      );
      for (const r of results) expect(r.error, r.error?.message).toBeNull();

      const reserved = results.filter((r) => r.row.outcome === "reserved");
      const blocked = results.filter((r) => r.row.outcome === "blocked");
      expect(reserved).toHaveLength(3);
      expect(blocked).toHaveLength(9);

      const after = await claims(orgA);
      expect(after.livePence).toBe(3_000);
      // THE INVARIANT. Not "within N x cost of the ceiling" — exactly at it.
      expect((await committed(orgA)) + after.livePence).toBe(CEILING);
      expect((await committed(orgA)) + after.livePence).toBeLessThanOrEqual(CEILING);
    });

    it("the caller that WOULD breach is refused, not admitted and reconciled later", async () => {
      await resetOrg(orgA);
      await seedSpend(orgA, 9_500); // £5 of headroom
      // A £10 claim cannot fit in £5, even though spend is below the ceiling —
      // this is the behaviour change from a start gate to a reserve.
      const { row } = await reserve(orgA, 1_000);
      expect(row.outcome).toBe("blocked");
      expect(n(row.committed_pence)).toBe(9_500);
      expect((await claims(orgA)).liveCount).toBe(0);
    });

    it("a claim that fits EXACTLY is admitted, and the next one is not", async () => {
      await resetOrg(orgA);
      await seedSpend(orgA, 9_500);
      const first = await reserve(orgA, 500);
      expect(first.row.outcome).toBe("reserved");
      // committed 9,500 + reserved 500 = 10,000 ⇒ the band gate refuses even a
      // one-penny claim: reaching the ceiling exactly must stop work.
      const second = await reserve(orgA, 1);
      expect(second.row.outcome).toBe("blocked");
      expect(n(second.row.reserved_pence)).toBe(500);
    });

    it("a single claim larger than the whole ceiling is refused outright", async () => {
      await resetOrg(orgA);
      const { row } = await reserve(orgA, CEILING + 1);
      expect(row.outcome).toBe("blocked");
    });

    it("a non-positive ceiling means NO SPEND, not unlimited", async () => {
      await resetOrg(orgA);
      for (const ceiling of [0, -1]) {
        const { row } = await reserve(orgA, 1, { ceiling });
        expect(row.outcome, `ceiling ${ceiling}`).toBe("blocked");
      }
    });

    it("100 simultaneous one-penny claims cannot collectively breach the ceiling", async () => {
      // The pathological shape: claims small enough that arithmetic error would
      // hide in the noise, issued all at once.
      await resetOrg(orgA);
      await seedSpend(orgA, 9_950); // 50p of headroom
      const results = await Promise.all(Array.from({ length: 100 }, () => reserve(orgA, 1)));
      for (const r of results) expect(r.error, r.error?.message).toBeNull();
      expect(results.filter((r) => r.row.outcome === "reserved")).toHaveLength(50);
      const after = await claims(orgA);
      expect(after.livePence).toBe(50);
      expect((await committed(orgA)) + after.livePence).toBe(CEILING);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (c) SIMULTANEOUS IDENTICAL SUBMITS ⇒ ONE PAID INVOCATION.
  // ═══════════════════════════════════════════════════════════════════════

  describe("dedupe is a database guarantee, not a hopeful read", () => {
    it("ten SIMULTANEOUS identical submits ⇒ exactly ONE claim", async () => {
      await resetOrg(orgA);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => reserve(orgA, 100, { hash: HASH_A })),
      );
      for (const r of results) expect(r.error, r.error?.message).toBeNull();
      expect(results.filter((r) => r.row.outcome === "reserved")).toHaveLength(1);
      const dupes = results.filter((r) => r.row.outcome === "duplicate");
      expect(dupes).toHaveLength(9);
      // The losers are told WHY: an identical request is running right now.
      for (const d of dupes) expect(d.row.duplicate_reason).toBe("in_flight");
      expect((await claims(orgA)).liveCount).toBe(1);
    });

    it("…and after it settles, a repeat is a RECENT SUCCESS, still charged once", async () => {
      await resetOrg(orgA);
      const first = await reserve(orgA, 100, { hash: HASH_A });
      expect(first.row.outcome).toBe("reserved");
      await settle(String(first.row.reservation_id), true, 100, { inputTokens: 10 });

      const repeat = await reserve(orgA, 100, { hash: HASH_A });
      expect(repeat.row.outcome).toBe("duplicate");
      expect(repeat.row.duplicate_reason).toBe("recent_success");
      expect(await committed(orgA)).toBe(100); // charged ONCE
    });

    it("a DIFFERENT request is never suppressed by a recent one", async () => {
      await resetOrg(orgA);
      const a = await reserve(orgA, 100, { hash: HASH_A });
      expect(a.row.outcome).toBe("reserved");
      const b = await reserve(orgA, 100, { hash: HASH_B });
      expect(b.row.outcome).toBe("reserved");
    });

    it("a FAILED attempt does not suppress its own retry", async () => {
      // Only a live claim or a recent SUCCESS deduplicates. A failure is the
      // reason a retry exists; suppressing it would strand the request.
      await resetOrg(orgA);
      const first = await reserve(orgA, 100, { hash: HASH_A });
      await settle(String(first.row.reservation_id), false, 1, { errorCode: "timeout" });
      const retry = await reserve(orgA, 100, { hash: HASH_A });
      expect(retry.row.outcome).toBe("reserved");
    });

    it("a RELEASED attempt does not suppress a retry either", async () => {
      await resetOrg(orgA);
      const first = await reserve(orgA, 100, { hash: HASH_A });
      const rel = await db(serviceClient()).rpc("ai_release_reservation", {
        p_reservation_id: first.row.reservation_id,
        p_reason: "no_provider_call",
      });
      expect(rel.error, rel.error?.message).toBeNull();
      const retry = await reserve(orgA, 100, { hash: HASH_A });
      expect(retry.row.outcome).toBe("reserved");
    });

    it("a claim with NO hash is never deduplicated — accounting without dedupe", async () => {
      await resetOrg(orgA);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => reserve(orgA, 100, { hash: null })),
      );
      expect(results.filter((r) => r.row.outcome === "reserved")).toHaveLength(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (d) A STALE CLAIM IS RECLAIMED.
  // ═══════════════════════════════════════════════════════════════════════

  describe("a crashed process cannot hold the budget hostage", () => {
    it("an expired claim stops consuming budget and its headroom becomes usable", async () => {
      await resetOrg(orgA);
      await seedSpend(orgA, 9_000); // £10 of headroom: room for exactly one claim

      // A process that claimed and died. A one-second TTL is used rather than
      // editing `expires_at`, because the lifecycle trigger FREEZES that column
      // — which is itself proven below.
      const crashed = await reserve(orgA, 1_000, { ttlSeconds: 1 });
      expect(crashed.row.outcome).toBe("reserved");
      expect((await claims(orgA)).livePence).toBe(1_000);

      // While it is live, the headroom is genuinely gone.
      const whileHeld = await reserve(orgA, 1_000);
      expect(whileHeld.row.outcome).toBe("blocked");

      await sleep(1_400);

      // The claim has lapsed, so the budget is usable again — and nothing
      // external ran to make that true.
      const after = await claims(orgA);
      expect(after.livePence).toBe(0);
      expect(after.expired).toBe(1);
      const reclaimed = await reserve(orgA, 1_000);
      expect(reclaimed.row.outcome).toBe("reserved");
      expect(n(reclaimed.row.reserved_pence)).toBe(0);
    }, 30_000);

    it("an expired claim is reclaimed by EXACTLY ONE of many concurrent callers", async () => {
      await resetOrg(orgA);
      await seedSpend(orgA, 9_000);
      const crashed = await reserve(orgA, 1_000, { ttlSeconds: 1 });
      expect(crashed.row.outcome).toBe("reserved");
      await sleep(1_400);

      const results = await Promise.all(Array.from({ length: 8 }, () => reserve(orgA, 1_000)));
      for (const r of results) expect(r.error, r.error?.message).toBeNull();
      expect(results.filter((r) => r.row.outcome === "reserved")).toHaveLength(1);
      expect((await committed(orgA)) + (await claims(orgA)).livePence).toBe(CEILING);
    }, 30_000);

    it("an expired claim no longer suppresses its duplicate — the retry gets through", async () => {
      // TTL < dedupe window is what makes this true. Were it the other way
      // round, retrying the exact request that crashed would be refused as a
      // duplicate of a call that never completed.
      await resetOrg(orgA);
      const crashed = await reserve(orgA, 100, { hash: HASH_A, ttlSeconds: 1 });
      expect(crashed.row.outcome).toBe("reserved");
      const immediate = await reserve(orgA, 100, { hash: HASH_A });
      expect(immediate.row.outcome).toBe("duplicate");
      await sleep(1_400);
      const retry = await reserve(orgA, 100, { hash: HASH_A });
      expect(retry.row.outcome).toBe("reserved");
    }, 30_000);

    it("the TTL cannot be EXTENDED — a claim's expiry is frozen", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 100, { ttlSeconds: 600 });
      const upd = await db(serviceClient())
        .from("ai_cost_reservations")
        .update({ expires_at: new Date(Date.now() + 86_400_000).toISOString() })
        .eq("id", held.row.reservation_id);
      expect(upd.error).not.toBeNull();
      expect(upd.error?.message ?? "").toMatch(/frozen/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (e) TENANT ISOLATION OF THE BUDGET.
  // ═══════════════════════════════════════════════════════════════════════

  describe("one org cannot consume another's budget", () => {
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

    it("an identical request in org B is NOT a duplicate of org A's", async () => {
      await resetOrg(orgA);
      await resetOrg(orgB);
      const a = await reserve(orgA, 100, { hash: HASH_A });
      expect(a.row.outcome).toBe("reserved");
      const b = await reserve(orgB, 100, { hash: HASH_A });
      expect(b.row.outcome).toBe("reserved");
    });

    it("concurrent storms in two orgs do not block or bleed into each other", async () => {
      // The advisory lock is keyed on the ORG, so different tenants never
      // contend. Both should fill their own ceiling exactly.
      await resetOrg(orgA);
      await resetOrg(orgB);
      await seedSpend(orgA, 8_000);
      await seedSpend(orgB, 9_000);
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => reserve(orgA, 1_000)),
        ...Array.from({ length: 6 }, () => reserve(orgB, 1_000)),
      ]);
      for (const r of results) expect(r.error, r.error?.message).toBeNull();
      expect((await claims(orgA)).livePence).toBe(2_000);
      expect((await claims(orgB)).livePence).toBe(1_000);
      expect((await committed(orgA)) + (await claims(orgA)).livePence).toBe(CEILING);
      expect((await committed(orgB)) + (await claims(orgB)).livePence).toBe(CEILING);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (f) SETTLEMENT: SUCCESS, FAILURE, IDEMPOTENCE, TEARDOWN.
  // ═══════════════════════════════════════════════════════════════════════

  describe("settlement writes the ledger and frees the claim, atomically", () => {
    it("a success commits the real cost and releases the claim", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      expect((await claims(orgA)).livePence).toBe(1_000);

      const s = await settle(String(held.row.reservation_id), true, 250, { inputTokens: 1_000 });
      expect(s.error, s.error?.message).toBeNull();
      expect(s.row.outcome).toBe("settled");
      // The claim is gone and the REAL cost — not the claim — is committed.
      expect(await committed(orgA)).toBe(250);
      const after = await claims(orgA);
      expect(after.livePence).toBe(0);
      expect(after.settled).toBe(1);
      expect(after.overruns).toBe(0);
    });

    it("a FAILURE is settled, not released — with a code, zero tokens and a real cost", async () => {
      // THE FAILED-CALL POLICY. A call that reached a provider and failed has,
      // on every major vendor, already billed its input tokens. We have no usage
      // report, so tokens are honestly 0 — but the COST is not 0, because a free
      // failure would make a retry storm invisible to the ceiling.
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
        .select("success, error_code, input_tokens, output_tokens, estimated_cost_pence")
        .eq("org_id", orgA);
      expect(led.error, led.error?.message).toBeNull();
      const rows = led.data ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.success).toBe(false);
      expect(rows[0]!.error_code).toBe("provider_timeout");
      expect(n(rows[0]!.input_tokens)).toBe(0);
      expect(n(rows[0]!.estimated_cost_pence)).toBe(1);
    });

    it("a failure with NO code still lands — the SQL supplies one the CHECK accepts", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 100);
      const s = await settle(String(held.row.reservation_id), false, 1, { errorCode: "" });
      expect(s.error, s.error?.message).toBeNull();
      expect(s.row.outcome).toBe("settled");
      const led = await db(serviceClient())
        .from("ai_invocations")
        .select("error_code")
        .eq("org_id", orgA);
      expect(String(led.data?.[0]?.error_code ?? "")).toBe("unknown_error");
    });

    it("settling TWICE writes ONE ledger row — idempotent under retry", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      const first = await settle(String(held.row.reservation_id), true, 300);
      const second = await settle(String(held.row.reservation_id), true, 300);
      expect(first.row.outcome).toBe("settled");
      expect(second.row.outcome).toBe("already_settled");
      expect(second.row.invocation_id).toBe(first.row.invocation_id);
      expect(await committed(orgA)).toBe(300);
    });

    it("settling a VANISHED claim writes nothing and says so", async () => {
      await resetOrg(orgA);
      const s = await settle("00000000-0000-4000-8000-0000000000ff", true, 500);
      expect(s.error, s.error?.message).toBeNull();
      expect(s.row.outcome).toBe("not_found");
      expect(await committed(orgA)).toBe(0);
    });

    it("a settled claim cannot be walked back to 'reserved' to free budget", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      await settle(String(held.row.reservation_id), true, 1_000);
      const upd = await db(serviceClient())
        .from("ai_cost_reservations")
        .update({
          state: "reserved",
          success: null,
          cost_pence: null,
          settled_at: null,
          invocation_id: null,
        })
        .eq("id", held.row.reservation_id);
      expect(upd.error).not.toBeNull();
      expect(upd.error?.message ?? "").toMatch(/terminal|already/i);
    });

    it("a claim's AMOUNT cannot be edited after the fact", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      const upd = await db(serviceClient())
        .from("ai_cost_reservations")
        .update({ estimate_pence: 1 })
        .eq("id", held.row.reservation_id);
      expect(upd.error).not.toBeNull();
      expect(upd.error?.message ?? "").toMatch(/frozen/i);
    });

    it("THE RESIDUE: an over-run is possible, and it is COUNTED", async () => {
      // The gate admits a call on its claim. If the true cost turns out larger,
      // committed spend passes the ceiling by the shortfall — unavoidable, since
      // the true cost is only known afterwards. It is therefore surfaced.
      await resetOrg(orgA);
      await seedSpend(orgA, 9_000);
      const held = await reserve(orgA, 1_000);
      await settle(String(held.row.reservation_id), true, 5_000, { inputTokens: 5_000_000 });
      expect(await committed(orgA)).toBe(14_000);
      expect(await committed(orgA)).toBeGreaterThan(CEILING);
      expect((await claims(orgA)).overruns).toBe(1);
      // …and the wall is up immediately afterwards, so it is a one-call event.
      const next = await reserve(orgA, 1);
      expect(next.row.outcome).toBe("blocked");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STRUCTURAL REFUSALS AND THE TRUST BOUNDARY.
  // ═══════════════════════════════════════════════════════════════════════

  describe("a deterministic claim is structurally impossible", () => {
    it("the reservation REFUSES it at the CHECK, for the service role too", async () => {
      // Three independent statements of one rule: the registry disagreement, the
      // wrapper's refusal, and this constraint — which no procedural code can
      // bypass.
      await resetOrg(orgA);
      const { error } = await reserve(orgA, 100, { taskClass: "deterministic" });
      expect(error).not.toBeNull();
      expect(error?.message ?? "").toMatch(/task_class/i);
      expect((await claims(orgA)).liveCount).toBe(0);
    });
  });

  describe("RLS: a tenant can read its own claims and forge none", () => {
    it("an org ADMIN can read their own org's claims", async () => {
      await resetOrg(orgA);
      await reserve(orgA, 100);
      const res = await db(userClient(adminA.token))
        .from("ai_cost_reservations")
        .select("id, org_id")
        .eq("org_id", orgA);
      expect(res.error, res.error?.message).toBeNull();
      expect((res.data ?? []).length).toBe(1);
    });

    it("a STAFF member of the same org sees NOTHING — usage is admin information", async () => {
      await resetOrg(orgA);
      await reserve(orgA, 100);
      const res = await db(userClient(memberA.token))
        .from("ai_cost_reservations")
        .select("id")
        .eq("org_id", orgA);
      expect(res.error, res.error?.message).toBeNull();
      expect(res.data ?? []).toEqual([]);
    });

    it("another org's ADMIN sees NOTHING — no cross-tenant read", async () => {
      await resetOrg(orgA);
      await reserve(orgA, 100);
      const res = await db(userClient(adminB.token))
        .from("ai_cost_reservations")
        .select("id")
        .eq("org_id", orgA);
      expect(res.error, res.error?.message).toBeNull();
      expect(res.data ?? []).toEqual([]);
    });

    it("an ANONYMOUS caller sees NOTHING", async () => {
      await resetOrg(orgA);
      await reserve(orgA, 100);
      const res = await db(anonClient())
        .from("ai_cost_reservations")
        .select("id")
        .eq("org_id", orgA);
      // Either a denial or an empty set; never a row.
      expect(res.data ?? []).toEqual([]);
    });

    it("a tenant admin cannot FORGE a claim — the DoS primitive is closed", async () => {
      // A forged claim of 10,000p would refuse every AI call in the org until
      // the TTL lapsed. There is no INSERT policy, so it is impossible.
      await resetOrg(orgA);
      const res = await db(userClient(adminA.token))
        .from("ai_cost_reservations")
        .insert({
          org_id: orgA,
          feature: FEATURE,
          task_class: CLASS,
          estimate_pence: CEILING,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        });
      expect(res.error).not.toBeNull();
      expect((await claims(orgA)).liveCount).toBe(0);
    });

    it("a tenant admin cannot DELETE a claim to free budget", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      const del = await db(userClient(adminA.token))
        .from("ai_cost_reservations")
        .delete()
        .eq("id", held.row.reservation_id);
      // No DELETE policy: either an error, or a silent no-op. Either way the
      // claim survives, which is the property that matters.
      if (!del.error) {
        expect((await claims(orgA)).liveCount).toBe(1);
      }
      expect((await claims(orgA)).liveCount).toBe(1);
    });

    it("a tenant admin cannot SETTLE a claim (no fabricated zero-cost spend)", async () => {
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      const upd = await db(userClient(adminA.token))
        .from("ai_cost_reservations")
        .update({ state: "released", settled_at: new Date().toISOString() })
        .eq("id", held.row.reservation_id);
      if (!upd.error) {
        expect((await claims(orgA)).liveCount).toBe(1);
      }
      expect((await claims(orgA)).liveCount).toBe(1);
    });

    it("the write RPCs are NOT executable by a tenant", async () => {
      await resetOrg(orgA);
      const res = await db(userClient(adminA.token)).rpc("ai_reserve_invocation", {
        p_org_id: orgA,
        p_feature: FEATURE,
        p_task_class: CLASS,
        p_estimate_pence: CEILING,
      });
      expect(res.error).not.toBeNull();
      expect((await claims(orgA)).liveCount).toBe(0);
    });

    it("the READ rollup is invoker-rights: another org's admin gets nothing from it", async () => {
      await resetOrg(orgA);
      await reserve(orgA, 100);
      const res = await db(userClient(adminB.token)).rpc("ai_reservations_month_totals", {
        p_org_id: orgA,
        p_month: ukTodayIso(),
      });
      // A SECURITY DEFINER rollup would have handed over another tenant's
      // totals. Invoker-rights means RLS has already decided.
      expect(Array.isArray(res.data) ? res.data : []).toEqual([]);
    });
  });

  describe("teardown still cascades — the 20261052 lesson", () => {
    it("deleting an organisation removes its claims AND its ledger rows", async () => {
      const svc = db(serviceClient());
      const tmp = await svc
        .from("organizations")
        .insert({ name: "AI Reservation Teardown", slug: `${TOKEN}-teardown` })
        .select("id")
        .single();
      expect(tmp.error, tmp.error?.message).toBeNull();
      const org = String(tmp.data?.id ?? "");

      const held = await reserve(org, 1_000);
      expect(held.row.outcome).toBe("reserved");
      await settle(String(held.row.reservation_id), true, 500);
      const live = await reserve(org, 1_000);
      expect(live.row.outcome).toBe("reserved");

      // A BEFORE DELETE guard on either table would abort this.
      const del = await svc.from("organizations").delete().eq("id", org);
      expect(del.error, del.error?.message).toBeNull();

      const left = await svc.from("ai_cost_reservations").select("id").eq("org_id", org);
      expect(left.data ?? []).toEqual([]);
      const ledLeft = await svc.from("ai_invocations").select("id").eq("org_id", org);
      expect(ledLeft.data ?? []).toEqual([]);
    });
  });

  describe("the month window matches the ledger's, to the hour", () => {
    it("both rollups bucket the SAME invocation into the SAME Europe/London month", async () => {
      // Two independent definitions of "this month" that could drift apart. They
      // are pinned against each other rather than each against a literal.
      await resetOrg(orgA);
      const held = await reserve(orgA, 1_000);
      await settle(String(held.row.reservation_id), true, 777);
      const led = await db(serviceClient()).rpc("ai_invocations_month_totals", {
        p_org_id: orgA,
        p_month: ukTodayIso(),
      });
      const res = await db(serviceClient()).rpc("ai_reservations_month_totals", {
        p_org_id: orgA,
        p_month: ukTodayIso(),
      });
      const ledRow = (Array.isArray(led.data) ? (led.data[0] as Row) : {}) ?? {};
      const resRow = (Array.isArray(res.data) ? (res.data[0] as Row) : {}) ?? {};
      expect(n(ledRow.total_cost_pence)).toBe(777);
      expect(n(resRow.settled_count)).toBe(1);
      expect(String(ledRow.month_start)).toBe(String(resRow.month_start));
    });
  });
});
