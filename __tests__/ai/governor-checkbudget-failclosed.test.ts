import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * AI Cost Governor — `checkBudget` FAILS CLOSED on an unreadable ledger.
 *
 * The hazard two independent audits flagged: `checkBudget` used to answer
 * "allowed, £0 spent" whenever the cost ledger (or the live-reservation state)
 * could not be read — a database blip silently uncapping AI spend. A budget
 * check that cannot see the budget must DENY, not assume an empty one.
 *
 * These tests drive the REAL module through a controllable admin-client mock:
 *   - the RESERVATION RPC read (ai_reservations_month_totals) or the SPEND RPC
 *     read (ai_invocations_month_totals) can be told to return `{ error }` or to
 *     THROW, independently;
 *   - the happy path returns real figures.
 *
 * The invariant proven: any read error ⇒ `status: "blocked"` (deny), reported
 * loudly to Sentry; a readable, within-budget month ⇒ `status: "allowed"`
 * (permit). Nothing about the reservation math or the atomic reserve path is
 * touched — only the failure-mode of the pre-spend read.
 */

type RpcMode = "ok" | "error" | "throw";

const rpc = {
  mode: "ok" as RpcMode,
  /** null ⇒ the chosen failure applies to BOTH reads; else only to this RPC name. */
  failFn: null as string | null,
  spendPence: 0,
  reservedPence: 0,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ error: null }) }),
    rpc: async (fn: string) => {
      const applies = rpc.failFn === null || rpc.failFn === fn;
      if (applies && rpc.mode === "throw") {
        throw new Error(`simulated connection reset reading ${fn}`);
      }
      if (applies && rpc.mode === "error") {
        return { data: null, error: { message: `simulated PostgREST failure reading ${fn}` } };
      }
      if (fn === "ai_invocations_month_totals") {
        return { data: [{ total_cost_pence: rpc.spendPence }], error: null };
      }
      if (fn === "ai_reservations_month_totals") {
        return { data: [{ live_pence: rpc.reservedPence }], error: null };
      }
      return { data: [], error: null };
    },
  }),
}));

const sentryCaptures: unknown[] = [];
vi.mock("@sentry/nextjs", () => ({
  captureException: (e: unknown) => {
    sentryCaptures.push(e);
  },
}));

const { checkBudget } = await import("@/lib/ai/governor");
const { AI_MONTHLY_CEILING_PENCE, budgetPermits } = await import("@/lib/ai/governor/policy");

const ORG = "00000000-0000-0000-0000-0000000000aa";
const MONTH = "2026-08";

let consoleErr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpc.mode = "ok";
  rpc.failFn = null;
  rpc.spendPence = 0;
  rpc.reservedPence = 0;
  sentryCaptures.length = 0;
  consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleErr.mockRestore();
});

describe("checkBudget fails CLOSED when the ledger cannot be read", () => {
  it("DENIES (blocked) when the spend read throws — never allows uncapped spend", async () => {
    rpc.mode = "throw";
    rpc.failFn = "ai_invocations_month_totals";

    const snap = await checkBudget(ORG, MONTH);

    expect(snap.status).toBe("blocked");
    expect(budgetPermits(snap.status)).toBe(false);
    expect(sentryCaptures).toHaveLength(1);
    expect(sentryCaptures[0]).toBeInstanceOf(Error);
    expect((sentryCaptures[0] as Error).message).toMatch(/FAILING CLOSED/);
  });

  it("DENIES (blocked) when the spend read returns a PostgREST error", async () => {
    rpc.mode = "error";
    rpc.failFn = "ai_invocations_month_totals";

    const snap = await checkBudget(ORG, MONTH);

    expect(snap.status).toBe("blocked");
    expect(budgetPermits(snap.status)).toBe(false);
    expect(sentryCaptures).toHaveLength(1);
  });

  it("DENIES (blocked) when the RESERVATION read fails, even if spend is readable", async () => {
    // Only the reservation RPC fails; spend reads clean and well under ceiling.
    rpc.mode = "error";
    rpc.failFn = "ai_reservations_month_totals";
    rpc.spendPence = 0;

    const snap = await checkBudget(ORG, MONTH);

    expect(snap.status).toBe("blocked");
    expect(budgetPermits(snap.status)).toBe(false);
    expect(sentryCaptures).toHaveLength(1);
  });

  it("DENIES (blocked) when BOTH reads throw", async () => {
    rpc.mode = "throw";
    rpc.failFn = null;

    const snap = await checkBudget(ORG, MONTH);

    expect(snap.status).toBe("blocked");
    expect(budgetPermits(snap.status)).toBe(false);
    // Loud: the degraded-deny mode is an explicit, captured incident.
    expect(sentryCaptures.length).toBeGreaterThanOrEqual(1);
  });
});

describe("checkBudget still PERMITS on the normal, readable path", () => {
  it("returns 'allowed' and the real figures when both reads succeed within budget", async () => {
    rpc.mode = "ok";
    rpc.spendPence = 1_234;
    rpc.reservedPence = 500;

    const snap = await checkBudget(ORG, MONTH);

    expect(snap.status).toBe("allowed");
    expect(budgetPermits(snap.status)).toBe(true);
    expect(snap.spentPence).toBe(1_234);
    expect(snap.reservedPence).toBe(500);
    expect(snap.ceilingPence).toBe(AI_MONTHLY_CEILING_PENCE);
    // No incident on the happy path.
    expect(sentryCaptures).toHaveLength(0);
  });

  it("a genuinely empty (readable) month is 'allowed' with zero spend — NOT the same as unreadable", async () => {
    rpc.mode = "ok";
    rpc.spendPence = 0;
    rpc.reservedPence = 0;

    const snap = await checkBudget(ORG, MONTH);

    expect(snap.status).toBe("allowed");
    expect(snap.spentPence).toBe(0);
    expect(sentryCaptures).toHaveLength(0);
  });

  it("still BLOCKS on a readable month that is genuinely at the ceiling (unchanged math)", async () => {
    rpc.mode = "ok";
    rpc.spendPence = AI_MONTHLY_CEILING_PENCE;
    rpc.reservedPence = 0;

    const snap = await checkBudget(ORG, MONTH);

    // Blocked because it is over the ceiling, not because of a read failure —
    // so no Sentry incident is raised.
    expect(snap.status).toBe("blocked");
    expect(sentryCaptures).toHaveLength(0);
  });
});
