import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * THE VELOCITY LIMITER — proven as BEHAVIOUR through invokeWithGovernor.
 *
 * SIMULATED-ONLY for the provider leg: there is no vendor key in this
 * environment and no network call anywhere in this file. The "provider" is a
 * vi.fn; the admin client is a mock that records every RPC it is asked for.
 * What is REAL is the governor seam, the limiter arithmetic, and the in-process
 * counter `consume()` uses outside production.
 *
 * What it pins:
 *   • the limits are derived from money (a share of the ceiling / the claim),
 *     for every tier this build binds;
 *   • one USER calling one feature in a loop is refused at the per-user limit —
 *     the governed function is NOT called and NO reservation is taken — while a
 *     different user in the same org still gets through;
 *   • system work with no human (userId null) is bounded by the per-ORG limit;
 *   • the limit is per FEATURE and per ORG (no bleed);
 *   • a limiter that cannot be consulted FAILS CLOSED;
 *   • a dark tier still short-circuits before the limiter (zero round trips).
 */

const rpcLog = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ error: null }) }),
    rpc: async (fn: string) => {
      rpcLog.calls.push(fn);
      if (fn === "ai_reserve_invocation") {
        return {
          data: [
            {
              outcome: "reserved",
              reservation_id: "11111111-1111-1111-1111-111111111111",
              committed_pence: 0,
              reserved_pence: 0,
              ceiling_pence: 10000,
            },
          ],
          error: null,
        };
      }
      if (fn === "ai_settle_reservation") return { data: [{ outcome: "settled" }], error: null };
      if (fn === "ai_release_reservation") return { data: [{ outcome: "released" }], error: null };
      return { data: [], error: null };
    },
  }),
}));

// The limiter's own store, wrapped so one test can make it throw. Everything
// else is the REAL module (in-process counter outside production).
const limiterFault = vi.hoisted(() => ({ throwOnConsume: false }));
vi.mock("@/lib/security/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/rate-limit")>();
  return {
    ...actual,
    consume: async (...args: Parameters<typeof actual.consume>) => {
      if (limiterFault.throwOnConsume) throw new Error("limiter store unavailable");
      return actual.consume(...args);
    },
  };
});

import { invokeWithGovernor } from "@/lib/ai/governor";
import {
  AI_VELOCITY_MIN_ORG_CALLS,
  AI_VELOCITY_MIN_USER_CALLS,
  AI_VELOCITY_ORG_SHARE,
  AI_VELOCITY_USER_SHARE,
  velocityLimitsFor,
} from "@/lib/ai/governor/velocity";
import { AI_MONTHLY_CEILING_PENCE, reservationClaimPence } from "@/lib/ai/governor/policy";
import { TIER_MODEL } from "@/lib/ai/governor/registry";
import { _resetForTests } from "@/lib/security/rate-limit";

// The REAL mid binding (drafting → mid). `resolveModel` reads the registry's own
// table, so the claim the governor computes is the production one — the limits
// asserted below are therefore the limits production runs with, not a fixture's.
const MID = TIER_MODEL.mid!;
const CLAIM = reservationClaimPence(MID, {
  inputTokens: MID.reserveInputTokens,
  outputTokens: MID.reserveOutputTokens,
});
const LIMITS = velocityLimitsFor(CLAIM);

const ok = () => vi.fn(async () => ({ value: "drafted", usage: null }));

let prevKey: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANTHROPIC_API_KEY;
  // A bound tier also needs its credential to be "activated"; this inert value
  // reaches nothing — the provider is a vi.fn and there is no network here.
  process.env.ANTHROPIC_API_KEY = "test-key";
  rpcLog.calls = [];
  limiterFault.throwOnConsume = false;
  _resetForTests();
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
});

describe("velocityLimitsFor — the limits are derived from money", () => {
  it("is a share of the default ceiling divided by the claim, with floors", () => {
    expect(velocityLimitsFor(5)).toEqual({
      orgCallsPerWindow: Math.floor((AI_MONTHLY_CEILING_PENCE * AI_VELOCITY_ORG_SHARE) / 5),
      userCallsPerWindow: Math.floor((AI_MONTHLY_CEILING_PENCE * AI_VELOCITY_USER_SHARE) / 5),
    });
    // A claim so large the share buys <1 call still admits the floor, never 0.
    expect(velocityLimitsFor(9_999)).toEqual({
      orgCallsPerWindow: AI_VELOCITY_MIN_ORG_CALLS,
      userCallsPerWindow: AI_VELOCITY_MIN_USER_CALLS,
    });
  });

  it("treats a zero / negative / NaN claim as the 1p floor — never an unbounded rate", () => {
    const floor = velocityLimitsFor(1);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(velocityLimitsFor(bad)).toEqual(floor);
    }
    expect(Number.isFinite(floor.orgCallsPerWindow)).toBe(true);
  });

  it("a dearer claim never buys MORE calls per window than a cheaper one", () => {
    let prev = velocityLimitsFor(1);
    for (const claim of [2, 4, 5, 16, 50, 600]) {
      const cur = velocityLimitsFor(claim);
      expect(cur.orgCallsPerWindow).toBeLessThanOrEqual(prev.orgCallsPerWindow);
      expect(cur.userCallsPerWindow).toBeLessThanOrEqual(prev.userCallsPerWindow);
      expect(cur.userCallsPerWindow).toBeLessThanOrEqual(cur.orgCallsPerWindow);
      prev = cur;
    }
  });

  it("no user can CLAIM more than the user share of the ceiling in one window (above the floor)", () => {
    for (const claim of [1, 2, 4, 5, 16, 50]) {
      const { userCallsPerWindow, orgCallsPerWindow } = velocityLimitsFor(claim);
      expect(userCallsPerWindow * claim).toBeLessThanOrEqual(
        AI_MONTHLY_CEILING_PENCE * AI_VELOCITY_USER_SHARE,
      );
      expect(orgCallsPerWindow * claim).toBeLessThanOrEqual(
        AI_MONTHLY_CEILING_PENCE * AI_VELOCITY_ORG_SHARE,
      );
    }
  });
});

describe("invokeWithGovernor — one user looping one feature is refused at the user limit", () => {
  it("admits exactly the limit, then blocks as rate_limited WITHOUT calling the function or reserving", async () => {
    // Production arithmetic, stated: a 5p mid claim ⇒ 10% of £100 / 5p = 200/h.
    expect(CLAIM).toBe(5);
    expect(LIMITS.userCallsPerWindow).toBe(200);
    const input = { orgId: "org-vel-1", userId: "user-a" };

    for (let i = 0; i < LIMITS.userCallsPerWindow; i++) {
      const fn = ok();
      const out = await invokeWithGovernor("quote.writer_draft", "drafting", fn, input);
      expect(out.status, `call ${i + 1} is inside the limit`).toBe("ran");
      expect(fn).toHaveBeenCalledTimes(1);
    }
    const reservesBefore = rpcLog.calls.filter((c) => c === "ai_reserve_invocation").length;
    expect(reservesBefore).toBe(LIMITS.userCallsPerWindow);

    const fn = ok();
    const refused = await invokeWithGovernor("quote.writer_draft", "drafting", fn, input);

    expect(refused.status).toBe("blocked");
    if (refused.status === "blocked") expect(refused.reason).toBe("rate_limited");
    expect(fn, "a rate-limited call must never reach the provider").not.toHaveBeenCalled();
    expect(
      rpcLog.calls.filter((c) => c === "ai_reserve_invocation").length,
      "a rate-limited call must not take a budget claim",
    ).toBe(reservesBefore);
  });

  it("does not punish a DIFFERENT user in the same org for it", async () => {
    const hog = { orgId: "org-vel-2", userId: "user-hog" };
    for (let i = 0; i <= LIMITS.userCallsPerWindow; i++) {
      await invokeWithGovernor("quote.writer_draft", "drafting", ok(), hog);
    }
    const fn = ok();
    const other = await invokeWithGovernor("quote.writer_draft", "drafting", fn, {
      orgId: "org-vel-2",
      userId: "user-colleague",
    });
    expect(other.status).toBe("ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a refused user call does not consume the ORG window the rest of the firm shares", async () => {
    const hog = { orgId: "org-vel-3", userId: "user-hog" };
    // userLimit admitted (each also counts 1 against the org window) + 400 refused.
    for (let i = 0; i < LIMITS.userCallsPerWindow + 400; i++) {
      await invokeWithGovernor("quote.writer_draft", "drafting", ok(), hog);
    }
    // Had the 400 refusals each taken an org slot, the org window (500) would now
    // be exhausted. It is not: exactly org − user slots remain for everyone else.
    const remaining = LIMITS.orgCallsPerWindow - LIMITS.userCallsPerWindow;
    let admitted = 0;
    for (let i = 0; i < remaining + 5; i++) {
      const out = await invokeWithGovernor("quote.writer_draft", "drafting", ok(), {
        orgId: "org-vel-3",
        userId: `user-other-${i}`,
      });
      if (out.status === "ran") admitted += 1;
    }
    expect(admitted).toBe(remaining);
  });
});

describe("invokeWithGovernor — system work with no human is bounded by the ORG limit", () => {
  it("admits the org limit, then refuses (userId null: webhook / cron / inbound message)", async () => {
    expect(LIMITS.orgCallsPerWindow).toBe(500); // 25% of £100 / 5p
    const input = { orgId: "org-vel-4", userId: null };
    let ran = 0;
    for (let i = 0; i < LIMITS.orgCallsPerWindow; i++) {
      const out = await invokeWithGovernor("chat.auto_reply", "drafting", ok(), input);
      if (out.status === "ran") ran += 1;
    }
    expect(ran).toBe(LIMITS.orgCallsPerWindow);

    const fn = ok();
    const refused = await invokeWithGovernor("chat.auto_reply", "drafting", fn, input);
    expect(refused.status).toBe("blocked");
    if (refused.status === "blocked") expect(refused.reason).toBe("rate_limited");
    expect(fn).not.toHaveBeenCalled();
  });

  it("is per FEATURE and per ORG — neither bleeds into the other", async () => {
    const input = { orgId: "org-vel-5", userId: null };
    for (let i = 0; i <= LIMITS.orgCallsPerWindow; i++) {
      await invokeWithGovernor("chat.auto_reply", "drafting", ok(), input);
    }
    // Same org, different feature of the same tier: its own window.
    const otherFeature = await invokeWithGovernor("insights.narrative", "drafting", ok(), input);
    expect(otherFeature.status).toBe("ran");
    // Same feature, different org: its own window.
    const otherOrg = await invokeWithGovernor("chat.auto_reply", "drafting", ok(), {
      orgId: "org-vel-6",
      userId: null,
    });
    expect(otherOrg.status).toBe("ran");
  });
});

describe("invokeWithGovernor — the limiter FAILS CLOSED and stays behind the dark short-circuit", () => {
  it("refuses when the limiter store cannot be consulted — no provider call, no reservation", async () => {
    limiterFault.throwOnConsume = true;
    const fn = ok();
    const out = await invokeWithGovernor("quote.writer_draft", "drafting", fn, {
      orgId: "org-vel-7",
      userId: "user-a",
    });
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("rate_limited");
    expect(fn).not.toHaveBeenCalled();
    expect(rpcLog.calls).not.toContain("ai_reserve_invocation");
  });

  it("a DARK tier still runs the caller's degraded path with zero limiter or DB round trips", async () => {
    delete process.env.ANTHROPIC_API_KEY; // no credential ⇒ the tier is genuinely dark
    limiterFault.throwOnConsume = true; // would refuse if it were ever consulted
    const fn = ok();
    const out = await invokeWithGovernor("quote.writer_draft", "drafting", fn, {
      orgId: "org-vel-8",
      userId: "user-a",
    });
    expect(out.status).toBe("ran");
    if (out.status === "ran") expect(out.dark).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(rpcLog.calls).toEqual([]);
  });
});
