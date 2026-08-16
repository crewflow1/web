import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * PER-EMPLOYEE LIMIT + EFFECTIVE CEILING — the seam translation and the
 * fail-closed enforcement, proven end-to-end through invokeWithGovernor.
 *
 * The SQL (ai_reserve_invocation) is the authoritative enforcer and is pinned by
 * source in __tests__/security/ai-budget-controls.test.ts. Here we drive the
 * TypeScript seam with a MOCKED reserve RPC so we can prove, as behaviour:
 *
 *   • a `blocked` with block_reason 'employee_limit' surfaces as an
 *     `employee_limit` block AND the governed function is NEVER called
 *     (over-limit ⇒ no provider work, fail-closed);
 *   • a `blocked` with block_reason 'org_ceiling' still maps to `ceiling`;
 *   • the DEFAULT ceiling is passed to the RPC as p_ceiling_pence and the
 *     EFFECTIVE ceiling the RPC returns flows back up;
 *   • a reserve error fails CLOSED (blocked / reservation_unavailable), unchanged.
 *
 * A mutable TIER_MODEL arms exactly the 'mid' tier (drafting → mid) so the seam
 * reaches the reservation path rather than the dark short-circuit; the admin
 * client is a mock whose RESERVE_FN result each test sets.
 */

const tierModelRef = vi.hoisted(
  () => ({ cheap: null, mid: null, high: null, embedding: null }) as Record<string, unknown>,
);
vi.mock("@/lib/ai/governor/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/governor/registry")>();
  return { ...actual, TIER_MODEL: tierModelRef };
});

// The reserve RPC result each test controls, plus a record of the args it saw.
const reserveState = vi.hoisted(
  () =>
    ({
      row: null as Record<string, unknown> | null,
      error: null as { message: string } | null,
      lastArgs: null as Record<string, unknown> | null,
      settleCalls: 0,
    }),
);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ error: null }) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "ai_reserve_invocation") {
        reserveState.lastArgs = args;
        return { data: reserveState.row ? [reserveState.row] : [], error: reserveState.error };
      }
      if (fn === "ai_settle_reservation") {
        reserveState.settleCalls += 1;
        return { data: [{ outcome: "settled", invocation_id: "00000000-0000-0000-0000-000000000000", cost_pence: 0 }], error: null };
      }
      if (fn === "ai_release_reservation") return { data: [{ outcome: "released" }], error: null };
      return { data: [], error: null };
    },
  }),
}));

// resolveEffectiveCeiling (checkBudget) reads this — irrelevant to invoke, benign.
vi.mock("@/lib/ai/governor/limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/governor/limits")>();
  return { ...actual };
});

import { invokeWithGovernor, reserveBudget } from "@/lib/ai/governor";

const MID_BINDING = {
  provider: "anthropic",
  model: "test-mid",
  usdPerMTokIn: 1,
  usdPerMTokOut: 1,
  reserveInputTokens: 1000,
  reserveOutputTokens: 500,
};

const INPUT = { orgId: "org-1", userId: "user-1" };

let prevKey: string | undefined;
beforeEach(() => {
  for (const t of ["cheap", "mid", "high", "embedding"]) tierModelRef[t] = null;
  tierModelRef.mid = MID_BINDING; // drafting → mid
  // A bound tier alone is not "activated": readiness also requires the vendor
  // credential (see lib/ai/governor/readiness.ts). Set it so the seam reaches
  // the reservation path instead of the dark short-circuit.
  prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  reserveState.row = null;
  reserveState.error = null;
  reserveState.lastArgs = null;
  reserveState.settleCalls = 0;
});
afterEach(() => {
  for (const t of ["cheap", "mid", "high", "embedding"]) tierModelRef[t] = null;
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
});

describe("invokeWithGovernor — per-employee limit is FAIL-CLOSED", () => {
  it("blocks and NEVER calls the function when the employee is over their limit", async () => {
    reserveState.row = {
      outcome: "blocked",
      block_reason: "employee_limit",
      committed_pence: 200,
      reserved_pence: 0,
      ceiling_pence: 10000,
    };
    const fn = vi.fn(async () => ({ value: "drafted", usage: null }));

    const outcome = await invokeWithGovernor("quote.writer_draft", "drafting", fn, INPUT);

    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") expect(outcome.reason).toBe("employee_limit");
    expect(fn, "the governed function must not run when over the employee limit").not.toHaveBeenCalled();
    expect(reserveState.settleCalls, "nothing is settled — nothing ran").toBe(0);
  });

  it("still maps an org-ceiling block to 'ceiling'", async () => {
    reserveState.row = {
      outcome: "blocked",
      block_reason: "org_ceiling",
      committed_pence: 10000,
      reserved_pence: 0,
      ceiling_pence: 10000,
    };
    const fn = vi.fn(async () => ({ value: "x", usage: null }));

    const outcome = await invokeWithGovernor("quote.writer_draft", "drafting", fn, INPUT);

    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") expect(outcome.reason).toBe("ceiling");
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs the function when the reservation is granted", async () => {
    reserveState.row = {
      outcome: "reserved",
      reservation_id: "11111111-1111-1111-1111-111111111111",
      committed_pence: 0,
      reserved_pence: 0,
      ceiling_pence: 10000,
    };
    const fn = vi.fn(async () => ({ value: "drafted", usage: null }));

    const outcome = await invokeWithGovernor("quote.writer_draft", "drafting", fn, INPUT);

    expect(outcome.status).toBe("ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("reserveBudget — effective-ceiling threading", () => {
  it("passes the DEFAULT as p_ceiling_pence and returns the EFFECTIVE ceiling", async () => {
    reserveState.row = {
      outcome: "reserved",
      reservation_id: "22222222-2222-2222-2222-222222222222",
      committed_pence: 0,
      reserved_pence: 0,
      ceiling_pence: 4000, // the RPC resolved an override to £40
    };
    const res = await reserveBudget({
      orgId: "org-1",
      userId: "user-1",
      feature: "quote.writer_draft",
      taskClass: "drafting",
      claimPence: 5,
    });
    // The default (10000) is handed to the RPC; the RPC decides the effective one.
    expect(reserveState.lastArgs?.p_ceiling_pence).toBe(10000);
    expect(res.outcome).toBe("reserved");
    if (res.outcome === "reserved") expect(res.ceilingPence).toBe(4000);
  });

  it("maps a blocked/employee_limit row to reason employee_limit", async () => {
    reserveState.row = {
      outcome: "blocked",
      block_reason: "employee_limit",
      committed_pence: 100,
      reserved_pence: 0,
      ceiling_pence: 10000,
    };
    const res = await reserveBudget({
      orgId: "o",
      userId: "u",
      feature: "quote.writer_draft",
      taskClass: "drafting",
      claimPence: 5,
    });
    expect(res.outcome).toBe("blocked");
    if (res.outcome === "blocked") expect(res.reason).toBe("employee_limit");
  });

  it("fails CLOSED on a reserve RPC error", async () => {
    reserveState.error = { message: "db down" };
    const res = await reserveBudget({
      orgId: "o",
      userId: "u",
      feature: "quote.writer_draft",
      taskClass: "drafting",
      claimPence: 5,
    });
    expect(res.outcome).toBe("blocked");
    if (res.outcome === "blocked") expect(res.reason).toBe("reservation_unavailable");
  });
});
