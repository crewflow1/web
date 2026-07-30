import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AI_MONTHLY_CEILING_PENCE,
  FAILURE_FLOOR_PENCE,
  MIN_RESERVATION_PENCE,
  RESERVATION_TTL_MS,
} from "@/lib/ai/governor/policy";
import {
  QUOTE_WRITER_FEATURE,
  QUOTE_WRITER_TASK_CLASS,
} from "@/lib/ai/quote-writer-readiness";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — COST AND ADVERSARIAL BEHAVIOUR UNDER AN *ACTIVATED*
 * GOVERNOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everywhere else in this wave the governor is dark and the interesting
 * assertion is "nothing happened". That is the right assertion for today and
 * the wrong one for the day the CEO authorises a provider, because on that day
 * the ceiling stops being decoration and starts being the only thing between a
 * retry storm and a £500 bill.
 *
 * So this suite ACTIVATES the governor — binding a priced fake model to the
 * `mid` tier the `drafting` class routes to — and drives it against an
 * in-memory database that models the real SQL of migration 20261070000000: the
 * atomic reservation gate, settlement, release, TTL expiry, the sliding dedupe
 * window, and the month-total rollups. Every number below is the governor's own
 * arithmetic, not a restatement of it.
 *
 * THIS FILE PREVIOUSLY RECORDED TWO DEFECTS AS FINDINGS RATHER THAN PASSES.
 * The ceiling was a START GATE (N concurrent calls all read the same pre-spend
 * total and all spent), and dedupe raced identically (ten simultaneous identical
 * submits all missed and all paid). Both are now FIXED by the atomic
 * reservation, and the two tests that pinned the gaps have been rewritten to
 * pin the guarantee instead. The overshoot figures they used to measure are
 * preserved in the counterfactual measurements in docs/ai-cost-governor.md.
 *
 * WHAT THIS TIER CAN AND CANNOT PROVE. The in-memory RPCs below execute
 * synchronously, so — as with the advisory lock in Postgres — no two of them can
 * interleave. That is a FAITHFUL model of the shipped SQL, and it is not a proof
 * of it: a JS mock cannot demonstrate that Postgres serialises anything. The
 * real atomicity proof is two genuine psql sessions plus N-way concurrency
 * through the live RPC in __tests__/integration/ai/budget-reservation.test.ts,
 * with the lock-removed counterfactual recorded in docs/ai-cost-governor.md.
 */

// ---------------------------------------------------------------------------
// The fake, priced model binding. Chosen so ONE call costs exactly £10, which
// makes the £100 ceiling exactly ten calls and every assertion below countable
// by hand rather than by trusting the cost estimator.
//
// Its RESERVATION ENVELOPE is deliberately set EQUAL to the usage every test
// reports, so a claim is worth exactly what the call turns out to cost. That is
// the condition under which the ceiling holds to the penny, and stating it here
// is what makes the "never exceeds 10,000p" assertions below meaningful rather
// than lucky. The envelope being too SMALL is a real residue with its own test —
// see "a call that costs more than it reserved".
// ---------------------------------------------------------------------------

/**
 * `vi.mock` factories are hoisted above every top-level statement, so the fake
 * binding and the in-memory ledger they close over have to be hoisted with
 * them. `vi.hoisted` is the sanctioned way to share state with a mock factory.
 */
const H = vi.hoisted(() => {
  const BINDING = {
    // A KNOWN vendor, deliberately. The first draft of this harness used a
    // made-up vendor name and every ceiling assertion silently passed for the
    // wrong reason: readiness refuses a vendor whose credential it cannot
    // check, so `isGovernorActivated()` stayed false and the governor took its
    // dark short-circuit. That is correct behaviour — and it means a cost
    // harness must bind a vendor the readiness module actually knows, exactly
    // as a real activation diff would.
    provider: "anthropic",
    model: "test-model-1",
    usdPerMTokIn: 12.5,
    usdPerMTokOut: 0,
    // The worst-case envelope: identical to USAGE below, so claim === cost.
    reserveInputTokens: 1_000_000,
    reserveOutputTokens: 0,
  };
  type Reservation = {
    id: string;
    org_id: string;
    feature: string;
    task_class: string;
    estimate_pence: number;
    state: "reserved" | "settled" | "released" | "expired";
    content_hash: string | null;
    success: boolean | null;
    cost_pence: number | null;
    invocation_id: string | null;
    created_at: number;
    expires_at: number;
  };
  return {
    BINDING,
    /** 1,000,000 input tokens x $12.5/MTok = $12.50 x 0.8 x 100 = 1000 pence. */
    USAGE: {
      provider: BINDING.provider,
      model: BINDING.model,
      inputTokens: 1_000_000,
      outputTokens: 0,
    },
    ledger: [] as Array<Record<string, unknown> & { created_at: string }>,
    reservations: [] as Reservation[],
    seq: { res: 0, inv: 0 },
    /** Bumped on every rollup read, so a test can prove a read happened at all. */
    stats: {
      budgetReads: 0,
      dedupeProbes: 0,
      inserts: 0,
      reserves: 0,
      settles: 0,
      releases: 0,
    },
    /** When set, every reservation RPC returns an error — the fail-closed probe. */
    breakReservations: { on: false },
  };
});

// BINDING itself is only referenced inside the hoisted mock factories, via `H`.
const { USAGE, ledger, reservations, stats, breakReservations } = H;
const COST_PER_CALL_PENCE = 1_000;
const CALLS_TO_CEILING = AI_MONTHLY_CEILING_PENCE / COST_PER_CALL_PENCE; // 10

function monthTotal(orgId: string): number {
  return ledger
    .filter((r) => r.org_id === orgId)
    .reduce((sum, r) => sum + Number(r.estimated_cost_pence ?? 0), 0);
}

/** Live (unexpired) claims for an org — the other half of the ceiling arithmetic. */
function liveClaims(orgId: string): number {
  const now = Date.now();
  return reservations
    .filter((r) => r.org_id === orgId && r.state === "reserved" && r.expires_at > now)
    .reduce((sum, r) => sum + r.estimate_pence, 0);
}

/**
 * The in-memory model of migration 20261070000000.
 *
 * Each RPC body runs to completion without yielding, which is how it models the
 * per-org advisory lock: no two reservations can interleave. Every gate,
 * predicate and state transition below is transcribed from the SQL rather than
 * paraphrased, so a divergence between the two shows up as a test that passes
 * here and fails in the integration tier.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const now = Date.now();

      if (fn === "ai_invocations_month_totals") {
        H.stats.budgetReads += 1;
        // The real function returns one row per org with spend; none when there
        // is no spend at all. Modelled faithfully — a governor that only works
        // when a row exists would fail on an org's first ever call.
        const orgId = String(args.p_org_id ?? "");
        const total = H.ledger
          .filter((r) => r.org_id === orgId)
          .reduce((sum, r) => sum + Number(r.estimated_cost_pence ?? 0), 0);
        return { data: total > 0 ? [{ org_id: orgId, total_cost_pence: total }] : [], error: null };
      }

      if (fn === "ai_reservations_month_totals") {
        const orgId = String(args.p_org_id ?? "");
        const mine = H.reservations.filter((r) => r.org_id === orgId);
        if (mine.length === 0) return { data: [], error: null };
        return {
          data: [
            {
              org_id: orgId,
              live_pence: mine
                .filter((r) => r.state === "reserved" && r.expires_at > now)
                .reduce((s, r) => s + r.estimate_pence, 0),
              live_count: mine.filter((r) => r.state === "reserved" && r.expires_at > now).length,
              settled_count: mine.filter((r) => r.state === "settled").length,
              released_count: mine.filter((r) => r.state === "released").length,
              expired_count: mine.filter(
                (r) => r.state === "expired" || (r.state === "reserved" && r.expires_at <= now),
              ).length,
              overrun_count: mine.filter(
                (r) => r.state === "settled" && (r.cost_pence ?? 0) > r.estimate_pence,
              ).length,
            },
          ],
          error: null,
        };
      }

      if (fn === "ai_reserve_invocation") {
        H.stats.reserves += 1;
        if (H.breakReservations.on) {
          return { data: null, error: { message: "simulated reservation outage" } };
        }
        const orgId = String(args.p_org_id ?? "");
        const feature = String(args.p_feature ?? "");
        const taskClass = String(args.p_task_class ?? "");
        const claim = Math.max(1, Number(args.p_estimate_pence ?? 1));
        const ceiling = Number(args.p_ceiling_pence ?? 0);
        const ttlMs = Math.max(1, Number(args.p_ttl_seconds ?? 600)) * 1000;
        const windowMs = Math.max(0, Number(args.p_dedupe_window_seconds ?? 900)) * 1000;
        const hash = args.p_content_hash == null ? null : String(args.p_content_hash);

        // A non-positive ceiling means "no AI spend permitted at all".
        if (!Number.isFinite(ceiling) || ceiling <= 0) {
          return {
            data: [
              {
                outcome: "blocked",
                reservation_id: null,
                committed_pence: 0,
                reserved_pence: 0,
                ceiling_pence: ceiling,
                duplicate_reason: null,
              },
            ],
            error: null,
          };
        }

        // LAZY TTL RECLAIM — the stamp. Cosmetic: the arithmetic below filters
        // on expires_at regardless.
        for (const r of H.reservations) {
          if (r.org_id === orgId && r.state === "reserved" && r.expires_at <= now) {
            r.state = "expired";
          }
        }

        const committed = H.ledger
          .filter((r) => r.org_id === orgId)
          .reduce((s, r) => s + Number(r.estimated_cost_pence ?? 0), 0);
        const reserved = H.reservations
          .filter((r) => r.org_id === orgId && r.state === "reserved" && r.expires_at > now)
          .reduce((s, r) => s + r.estimate_pence, 0);

        if (hash) {
          H.stats.dedupeProbes += 1;
          const dup = [...H.reservations]
            .reverse()
            .find(
              (r) =>
                r.org_id === orgId &&
                r.feature === feature &&
                r.content_hash === hash &&
                r.created_at >= now - windowMs &&
                ((r.state === "reserved" && r.expires_at > now) ||
                  (r.state === "settled" && r.success === true)),
            );
          if (dup) {
            return {
              data: [
                {
                  outcome: "duplicate",
                  reservation_id: null,
                  committed_pence: committed,
                  reserved_pence: reserved,
                  ceiling_pence: ceiling,
                  duplicate_reason: dup.state === "reserved" ? "in_flight" : "recent_success",
                },
              ],
              error: null,
            };
          }
        }

        // THE TWO GATES, transcribed from the conditional insert's WHERE.
        if (committed + reserved >= ceiling || committed + reserved + claim > ceiling) {
          return {
            data: [
              {
                outcome: "blocked",
                reservation_id: null,
                committed_pence: committed,
                reserved_pence: reserved,
                ceiling_pence: ceiling,
                duplicate_reason: null,
              },
            ],
            error: null,
          };
        }

        // The table's own CHECK: a deterministic claim is unrepresentable.
        if (taskClass === "deterministic") {
          return { data: null, error: { message: "task_class check violation" } };
        }

        H.seq.res += 1;
        H.reservations.push({
          id: `res-${H.seq.res}`,
          org_id: orgId,
          feature,
          task_class: taskClass,
          estimate_pence: claim,
          state: "reserved",
          content_hash: hash,
          success: null,
          cost_pence: null,
          invocation_id: null,
          created_at: now,
          expires_at: now + ttlMs,
        });
        return {
          data: [
            {
              outcome: "reserved",
              reservation_id: `res-${H.seq.res}`,
              committed_pence: committed,
              reserved_pence: reserved,
              ceiling_pence: ceiling,
              duplicate_reason: null,
            },
          ],
          error: null,
        };
      }

      if (fn === "ai_settle_reservation") {
        H.stats.settles += 1;
        const res = H.reservations.find((r) => r.id === args.p_reservation_id);
        if (!res) return { data: [{ outcome: "not_found" }], error: null };
        if (res.state !== "reserved") {
          return {
            data: [
              {
                outcome: "already_settled",
                invocation_id: res.invocation_id,
                cost_pence: res.cost_pence,
              },
            ],
            error: null,
          };
        }
        const success = Boolean(args.p_success);
        const cost = Math.max(0, Number(args.p_cost_pence ?? 0));
        const errorCode = success ? null : String(args.p_error_code ?? "") || "unknown_error";
        // The ledger's CHECKs, restated.
        if (res.task_class === "deterministic") {
          return { data: null, error: { message: "task_class check violation" } };
        }
        if (!success && !errorCode) {
          return { data: null, error: { message: "outcome check violation" } };
        }
        H.seq.inv += 1;
        H.stats.inserts += 1;
        const invocationId = `inv-${H.seq.inv}`;
        H.ledger.push({
          id: invocationId,
          org_id: res.org_id,
          feature: res.feature,
          task_class: res.task_class,
          provider: String(args.p_provider ?? "unknown"),
          model: String(args.p_model ?? "unknown"),
          input_tokens: Math.max(0, Number(args.p_input_tokens ?? 0)),
          output_tokens: Math.max(0, Number(args.p_output_tokens ?? 0)),
          estimated_cost_pence: cost,
          latency_ms: Math.max(0, Number(args.p_latency_ms ?? 0)),
          success,
          error_code: errorCode,
          content_hash: res.content_hash,
          created_at: new Date().toISOString(),
        });
        res.state = "settled";
        res.success = success;
        res.cost_pence = cost;
        res.invocation_id = invocationId;
        return {
          data: [{ outcome: "settled", invocation_id: invocationId, cost_pence: cost }],
          error: null,
        };
      }

      if (fn === "ai_release_reservation") {
        H.stats.releases += 1;
        const res = H.reservations.find((r) => r.id === args.p_reservation_id);
        if (!res) return { data: [{ outcome: "not_found" }], error: null };
        if (res.state !== "reserved") return { data: [{ outcome: "already_settled" }], error: null };
        res.state = "released";
        return { data: [{ outcome: "released" }], error: null };
      }

      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (t: string) => {
      if (t !== "ai_invocations") throw new Error(`unexpected table ${t}`);
      return {
        // The direct ledger write. Reached only by `recordInvocation` — the
        // best-effort fallback for a settlement whose reservation has vanished.
        insert: async (row: Record<string, unknown>) => {
          // The DB's own CHECK, restated: a deterministic invocation is
          // structurally unrepresentable, and a failure must carry a code.
          if (row.task_class === "deterministic") {
            return { error: { message: "task_class check violation" } };
          }
          if (row.success === false && !row.error_code) {
            return { error: { message: "outcome check violation" } };
          }
          H.stats.inserts += 1;
          H.ledger.push({ ...row, created_at: new Date().toISOString() });
          return { error: null };
        },
      };
    },
  }),
}));

// THE ACTIVATION. `mid` is the tier the `drafting` class routes to, so binding
// it is exactly what a real activation diff would do.
vi.mock("@/lib/ai/governor/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/governor/registry")>();
  return {
    ...actual,
    TIER_MODEL: { cheap: null, mid: H.BINDING, high: null },
    resolveModel: (taskClass: string) => (taskClass === "drafting" ? H.BINDING : null),
    isAnyTierBound: () => true,
  };
});

const { invokeWithGovernor, checkBudget, invocationHash } = await import("@/lib/ai/governor");
const { getAiGovernorReadiness } = await import("@/lib/ai/governor/readiness");
const { getQuoteWriterReadiness } = await import("@/lib/ai/quote-writer-readiness");

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";

/** Seed the ledger with `pence` of prior spend for an org. */
function seedSpend(orgId: string, pence: number) {
  ledger.push({
    org_id: orgId,
    feature: QUOTE_WRITER_FEATURE,
    task_class: "drafting",
    estimated_cost_pence: pence,
    success: true,
    content_hash: null,
    created_at: new Date().toISOString(),
  });
}

const okCall = async () => ({ value: "a draft", usage: USAGE });

beforeEach(() => {
  ledger.length = 0;
  reservations.length = 0;
  H.seq.res = 0;
  H.seq.inv = 0;
  stats.budgetReads = 0;
  stats.dedupeProbes = 0;
  stats.inserts = 0;
  stats.reserves = 0;
  stats.settles = 0;
  stats.releases = 0;
  breakReservations.on = false;
  vi.unstubAllEnvs();
  // Binding alone is not activation — the vendor credential is the other half.
  // Stubbed per test and never present in production.
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key");
});

// =====================================================================
// 0. The activation actually took.
// =====================================================================

describe("the harness really did activate the governor", () => {
  it("binds a priced model to the drafting tier", () => {
    const r = getAiGovernorReadiness();
    const mid = r.tiers.find((t) => t.tier === "mid")!;
    expect(mid.modelBindingPresent).toBe(true);
    expect(r.anyTierBound).toBe(true);
  });

  it("binding AND credential together DO make the writer available", () => {
    // The other half of the #433 invariant: the conditions are NECESSARY, not
    // merely obstructive. If this never went true, every "it stays dark" test
    // in this wave would be passing for a trivial reason.
    expect(getQuoteWriterReadiness().available).toBe(true);
  });

  it("removing the credential makes it unavailable again, binding notwithstanding", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const r = getQuoteWriterReadiness();
    expect(r.modelBindingPresent).toBe(true);
    expect(r.credentialsPresent).toBe(false);
    expect(r.available).toBe(false);
    expect(r.blockers).toContain("ANTHROPIC_API_KEY");
  });
});

// =====================================================================
// 1. The ceiling.
// =====================================================================

describe("the £100 ceiling refuses work rather than warning about it", () => {
  it("blocks at EXACTLY the ceiling, and does not call the function", async () => {
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE);
    const fn = vi.fn(okCall);
    const outcome = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, fn, {
      orgId: ORG_A,
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("unreachable");
    expect(outcome.spentPence).toBe(AI_MONTHLY_CEILING_PENCE);
    expect(outcome.ceilingPence).toBe(AI_MONTHLY_CEILING_PENCE);
    // THE point. Refusing after spending the money is not a control.
    expect(fn).not.toHaveBeenCalled();
    expect(stats.inserts).toBe(0);
  });

  it("EXACTLY one call's worth of headroom still runs — the boundary is exact", async () => {
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE - COST_PER_CALL_PENCE);
    const outcome = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
    });
    expect(outcome.status).toBe("ran");
    // …and it lands exactly on the ceiling, never a penny past it.
    expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE);
  });

  it("BEHAVIOUR CHANGE: one PENNY of headroom no longer admits a pound of inference", async () => {
    // ─────────────────────────────────────────────────────────────────────
    // Under the old START GATE this ran: the check was "is recorded spend
    // below the ceiling", so 9,999p of spend admitted a £10 call and the month
    // ended at 10,999p. Under the reserve the gate is "does THIS CALL still
    // fit", so it is refused BEFORE the provider is reached.
    //
    // This is a real, intended change in what the ceiling means, and it is the
    // whole point: a hard limit that can be exceeded by the last call through
    // it is not a hard limit.
    // ─────────────────────────────────────────────────────────────────────
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE - 1);
    const fn = vi.fn(okCall);
    const outcome = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, fn, {
      orgId: ORG_A,
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("ceiling");
    expect(fn).not.toHaveBeenCalled();
    expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE - 1);
  });

  it("the warning bands fire and are ADVISORY — they never refuse work that fits", async () => {
    for (const [spend, expected] of [
      [0, "allowed"],
      [AI_MONTHLY_CEILING_PENCE * 0.5 - 1, "allowed"],
      [AI_MONTHLY_CEILING_PENCE * 0.5, "warn_50"],
      [AI_MONTHLY_CEILING_PENCE * 0.8 - 1, "warn_50"],
      [AI_MONTHLY_CEILING_PENCE * 0.8, "warn_80"],
      // The last band row a £10 claim can still fit inside.
      [AI_MONTHLY_CEILING_PENCE - COST_PER_CALL_PENCE, "warn_80"],
    ] as const) {
      ledger.length = 0;
      seedSpend(ORG_A, spend as number);
      const fn = vi.fn(okCall);
      const outcome = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, fn, {
        orgId: ORG_A,
      });
      expect(outcome.status, `spend ${spend}`).toBe("ran");
      if (outcome.status !== "ran") throw new Error("unreachable");
      expect(outcome.budget, `spend ${spend}`).toBe(expected);
      expect(fn).toHaveBeenCalledOnce();
    }
  });

  it("ten calls spend the whole ceiling and the eleventh is refused", async () => {
    for (let i = 0; i < CALLS_TO_CEILING; i += 1) {
      const outcome = await invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        okCall,
        { orgId: ORG_A, dedupeContent: `request-${i}` },
      );
      expect(outcome.status, `call ${i}`).toBe("ran");
    }
    expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE);
    const eleventh = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A, dedupeContent: "request-11" },
    );
    expect(eleventh.status).toBe("blocked");
  });
});

// =====================================================================
// 2. Tenant isolation of the budget.
// =====================================================================

describe("one org cannot consume another's budget", () => {
  it("org A at its ceiling leaves org B entirely unaffected", async () => {
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE);
    const a = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
    });
    const b = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_B,
    });
    expect(a.status).toBe("blocked");
    expect(b.status).toBe("ran");
  });

  it("org B's spend never counts against org A", async () => {
    for (let i = 0; i < CALLS_TO_CEILING; i += 1) {
      await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
        orgId: ORG_B,
        dedupeContent: `b-${i}`,
      });
    }
    expect(monthTotal(ORG_B)).toBe(AI_MONTHLY_CEILING_PENCE);
    expect((await checkBudget(ORG_A)).spentPence).toBe(0);
    expect((await checkBudget(ORG_A)).status).toBe("allowed");
  });

  it("an identical request in org B is NOT a duplicate of org A's", async () => {
    // The dedupe key is (org, feature, hash). Sharing it across tenants would
    // let one org's cached-out result suppress another's genuinely new call.
    const content = "the same bathroom, described identically";
    await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
      dedupeContent: content,
    });
    const b = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_B,
      dedupeContent: content,
    });
    expect(b.status).toBe("ran");
  });
});

// =====================================================================
// 3. Retries.
// =====================================================================

describe("a retry cannot buy what the first attempt was refused", () => {
  it("an identical request within the window is a DUPLICATE and never reaches the model", async () => {
    const content = "refit the bathroom at 14 Cedar Road";
    const first = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
      dedupeContent: content,
    });
    expect(first.status).toBe("ran");

    const fn = vi.fn(okCall);
    const second = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, fn, {
      orgId: ORG_A,
      dedupeContent: content,
    });
    expect(second.status).toBe("duplicate");
    expect(fn).not.toHaveBeenCalled();
    expect(monthTotal(ORG_A)).toBe(COST_PER_CALL_PENCE); // charged once, not twice
  });

  it("FIXED: ten SIMULTANEOUS identical submits cost ONCE, not ten times", async () => {
    // ─────────────────────────────────────────────────────────────────────
    // THE DEFECT THIS REPLACES. Dedupe used to be a READ-THEN-ACT probe, so ten
    // requests issued in the same tick all found no prior row and all called
    // the model. With this harness's £10-per-call model that was the ENTIRE
    // monthly ceiling consumed by one impatient double-click.
    //
    // The fix is not a better probe: it is the same probe moved INSIDE the
    // reservation's critical section, so the nine losers queue behind the
    // winner's claim and see it. There is no window left to race in.
    //
    // Counterfactual, measured on real Postgres with the advisory lock removed
    // and everything else byte-identical: 6 of 10 simultaneous identical
    // submits were admitted — 6x the cost. Transcript in
    // docs/ai-cost-governor.md.
    // ─────────────────────────────────────────────────────────────────────
    const content = "the same request, ten times";
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
          orgId: ORG_A,
          dedupeContent: content,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "ran")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(9);
    // ONE paid invocation, and the ledger agrees.
    expect(monthTotal(ORG_A)).toBe(COST_PER_CALL_PENCE);
    expect(ledger).toHaveLength(1);
  });

  it("the nine losers are told WHY — an identical request is in flight", async () => {
    // Honest over convenient: the loser gets a clear state, not the winner's
    // result. Handing back the winner's output would need a cache of model
    // prose in a subsystem that deliberately stores only a SHA-256 digest.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
          orgId: ORG_A,
          dedupeContent: "simultaneous",
        }),
      ),
    );
    const dupes = results.filter((r) => r.status === "duplicate");
    expect(dupes).toHaveLength(3);
    for (const d of dupes) {
      if (d.status !== "duplicate") throw new Error("unreachable");
      expect(d.reason).toBe("in_flight");
      expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("a SEQUENTIAL repeat is reported as a recent SUCCESS, not as in-flight", async () => {
    // The two duplicate reasons are operationally different — one means "wait",
    // the other means "you already have this" — so they are not collapsed.
    const content = "pressed again after the first returned";
    await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
      dedupeContent: content,
    });
    const second = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A, dedupeContent: content },
    );
    expect(second.status).toBe("duplicate");
    if (second.status !== "duplicate") throw new Error("unreachable");
    expect(second.reason).toBe("recent_success");
  });

  it("…but a SEQUENTIAL repeat — what an impatient human actually does — is caught every time", async () => {
    const content = "the same request, pressed again after the first returned";
    for (let i = 0; i < 5; i += 1) {
      const outcome = await invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        okCall,
        { orgId: ORG_A, dedupeContent: content },
      );
      expect(outcome.status, `press ${i}`).toBe(i === 0 ? "ran" : "duplicate");
    }
    // Five presses, one charge.
    expect(monthTotal(ORG_A)).toBe(COST_PER_CALL_PENCE);
  });

  it("retrying after a BLOCK is still blocked — no amount of trying gets through", async () => {
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE);
    for (let i = 0; i < 5; i += 1) {
      const outcome = await invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        okCall,
        { orgId: ORG_A, dedupeContent: `retry-${i}` },
      );
      expect(outcome.status).toBe("blocked");
    }
    expect(stats.inserts).toBe(0);
  });

  it("a NEW request is not suppressed by an unrelated recent one", async () => {
    await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
      dedupeContent: "bathroom",
    });
    const other = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
      dedupeContent: "kitchen",
    });
    expect(other.status).toBe("ran");
  });

  it("the dedupe fingerprint is domain-separated across features", () => {
    expect(invocationHash("a", "drafting", "bc")).not.toBe(invocationHash("ab", "drafting", "c"));
    expect(invocationHash(QUOTE_WRITER_FEATURE, "drafting", "x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =====================================================================
// 4. Failures are recorded, not swallowed.
// =====================================================================

describe("a failed call still cost something, and the ledger says so", () => {
  it("records the failure WITH a code and RETHROWS the original error", async () => {
    const boom = new Error("provider exploded");
    await expect(
      invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        async () => {
          throw boom;
        },
        { orgId: ORG_A },
      ),
    ).rejects.toBe(boom);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.success).toBe(false);
    // The DB refuses an unexplained failure; the governor must supply a code.
    expect(String(ledger[0]!.error_code ?? "")).not.toBe("");
    expect(ledger[0]!.feature).toBe(QUOTE_WRITER_FEATURE);
  });

  it("a failure records ZERO tokens — honest about what we do not know", async () => {
    await expect(
      invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        async () => {
          throw new Error("timeout");
        },
        { orgId: ORG_A },
      ),
    ).rejects.toThrow();
    expect(ledger[0]!.input_tokens).toBe(0);
    expect(ledger[0]!.output_tokens).toBe(0);
  });

  it("…but it does NOT record ZERO COST — a free failure makes a retry storm invisible", async () => {
    // THE FAILED-CALL POLICY. A call that reached a provider and failed has, on
    // every major vendor, already billed its input tokens. We have no usage
    // report, so the token counts are honestly 0 — but recording the COST as
    // £0 would let ten thousand failures spend real money while the ceiling saw
    // nothing. The floor is one penny: the same "never round a real cost down to
    // zero" rule estimateCostPence already applies.
    await expect(
      invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        async () => {
          throw new Error("timeout");
        },
        { orgId: ORG_A },
      ),
    ).rejects.toThrow();
    expect(ledger[0]!.estimated_cost_pence).toBe(FAILURE_FLOOR_PENCE);
    expect(FAILURE_FLOOR_PENCE).toBe(1);
  });

  it("a failure SETTLES its claim rather than leaving it to time out", async () => {
    // The claim must not outlive the call. Were it released instead of settled,
    // the failure would cost nothing; were it left standing, the org would lose
    // headroom for ten minutes over a call that already finished.
    await expect(
      invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        async () => {
          throw new Error("boom");
        },
        { orgId: ORG_A },
      ),
    ).rejects.toThrow();
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.state).toBe("settled");
    expect(reservations[0]!.success).toBe(false);
    expect(liveClaims(ORG_A)).toBe(0);
  });

  it("a crash loop is BOUNDED — each failure costs a penny and the wall still arrives", async () => {
    // A failure claims a full call's worth of budget and then settles for a
    // penny, so a crash loop consumes the ceiling a penny at a time rather than
    // for free — and stops the moment a whole claim no longer fits.
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE - COST_PER_CALL_PENCE);
    await expect(
      invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        async () => {
          throw new Error("boom");
        },
        { orgId: ORG_A },
      ),
    ).rejects.toThrow();
    expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE - COST_PER_CALL_PENCE + 1);

    // The next attempt cannot fit a whole claim, so it never reaches a provider
    // at all — the retry storm is stopped rather than merely metered.
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    const next = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      fn as unknown as () => Promise<{ value: string; usage: typeof USAGE }>,
      { orgId: ORG_A },
    );
    expect(next.status).toBe("blocked");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a failed call does NOT count as a successful duplicate — a retry is allowed", async () => {
    const content = "a request that failed once";
    await expect(
      invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        async () => {
          throw new Error("transient");
        },
        { orgId: ORG_A, dedupeContent: content },
      ),
    ).rejects.toThrow();
    const retry = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A, dedupeContent: content },
    );
    expect(retry.status).toBe("ran");
  });

  it("a function that degraded internally (usage null) records NOTHING", async () => {
    const outcome = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      async () => ({ value: null, usage: null }),
      { orgId: ORG_A },
    );
    expect(outcome.status).toBe("ran");
    if (outcome.status !== "ran") throw new Error("unreachable");
    expect(outcome.recorded).toBe(false);
    expect(ledger).toHaveLength(0);
  });

  it("…and it GIVES THE CLAIM BACK immediately rather than holding it for the TTL", async () => {
    // No provider was reached, so nothing is owed. Leaving the claim standing
    // would cost the org ten minutes of headroom for a call that never happened.
    await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      async () => ({ value: null, usage: null }),
      { orgId: ORG_A },
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.state).toBe("released");
    expect(liveClaims(ORG_A)).toBe(0);
    expect(stats.releases).toBe(1);
  });
});

// =====================================================================
// 4b. The reservation's own edges: TTL, fail-closed, over-run.
// =====================================================================

describe("a crashed process cannot hold the budget hostage", () => {
  it("a stale claim stops consuming budget and the headroom becomes usable again", async () => {
    // Simulate the crash: a claim taken and never settled. `Date.now` is moved
    // past its TTL rather than the row being edited, because the guarantee under
    // test is that the ARITHMETIC ignores expired claims — the 'expired' stamp is
    // cosmetic and the ceiling must be right without it.
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE - COST_PER_CALL_PENCE);

    let stuck: (() => void) | null = null;
    const hanging = invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      () =>
        new Promise((resolve) => {
          stuck = () => resolve({ value: "late", usage: null });
        }),
      { orgId: ORG_A, dedupeContent: "the call that crashed" },
    );
    await new Promise((r) => setTimeout(r, 0));

    // The claim is live, so the last call's worth of headroom is gone.
    expect(liveClaims(ORG_A)).toBe(COST_PER_CALL_PENCE);
    const whileHeld = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A, dedupeContent: "blocked-by-the-crash" },
    );
    expect(whileHeld.status).toBe("blocked");

    // Time passes beyond the TTL.
    const realNow = Date.now;
    try {
      const jumped = realNow() + RESERVATION_TTL_MS + 1_000;
      Date.now = () => jumped;
      expect(liveClaims(ORG_A)).toBe(0);
      const reclaimed = await invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        okCall,
        { orgId: ORG_A, dedupeContent: "after-the-ttl" },
      );
      expect(reclaimed.status).toBe("ran");
      expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE);
      // The lazy stamp ran too, so the audit view shows the truth.
      expect(reservations.some((r) => r.state === "expired")).toBe(true);
    } finally {
      Date.now = realNow;
    }
    stuck?.();
    await hanging;
  });

  it("the TTL is SHORTER than the dedupe window, so a crashed request can be retried", async () => {
    // If the claim outlived its duplicate suppression, retrying the exact
    // request that crashed would be refused as a duplicate of a call that never
    // completed — permanently, from the user's point of view.
    const { DEDUPE_WINDOW_MS } = await import("@/lib/ai/governor/policy");
    expect(RESERVATION_TTL_MS).toBeLessThan(DEDUPE_WINDOW_MS);
  });
});

describe("the reservation fails CLOSED — a database blip must not switch the ceiling off", () => {
  it("an unavailable reservation REFUSES the call rather than letting it through", async () => {
    // The one place the governor's fail-open posture is deliberately reversed.
    // `checkBudget` fails open because it is an observation; this is the
    // authorisation, and "the control is bypassed on error" is not a control.
    breakReservations.on = true;
    const fn = vi.fn(okCall);
    const outcome = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, fn, {
      orgId: ORG_A,
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("reservation_unavailable");
    expect(fn).not.toHaveBeenCalled();
    expect(ledger).toHaveLength(0);
  });

  it("the two block reasons are distinguishable — one is money, one is plumbing", async () => {
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE);
    const ceilinged = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A },
    );
    breakReservations.on = true;
    const broken = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_B },
    );
    if (ceilinged.status !== "blocked" || broken.status !== "blocked") {
      throw new Error("both should be blocked");
    }
    expect(ceilinged.reason).toBe("ceiling");
    expect(broken.reason).toBe("reservation_unavailable");
  });
});

describe("the claim size is the ceiling's precondition, and its residue is visible", () => {
  it("a claim is never free, even for an unpriced model", async () => {
    // A zero claim consumes no budget, so N concurrent unpriced calls would all
    // pass however many there were — the exact hole the reservation closes.
    const { reservationClaimPence } = await import("@/lib/ai/governor/policy");
    expect(reservationClaimPence(null, { inputTokens: 1, outputTokens: 1 })).toBe(
      MIN_RESERVATION_PENCE,
    );
    expect(
      reservationClaimPence(
        { usdPerMTokIn: 0, usdPerMTokOut: 0 },
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      ),
    ).toBe(MIN_RESERVATION_PENCE);
  });

  it("the claim equals the eventual cost for this binding — the ceiling's precondition", async () => {
    await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
    });
    expect(reservations[0]!.estimate_pence).toBe(COST_PER_CALL_PENCE);
    expect(reservations[0]!.cost_pence).toBe(COST_PER_CALL_PENCE);
  });

  it("THE RESIDUE: a call that costs MORE than it reserved can pass the ceiling, and it is FLAGGED", async () => {
    // ─────────────────────────────────────────────────────────────────────
    // The one thing the reservation cannot prevent, stated rather than hidden.
    // The gate admits a call on its claim; if the true cost turns out larger,
    // committed spend passes the ceiling by the shortfall. There is no way to
    // know the true cost beforehand, so the mitigation is (1) a pessimistic
    // worst-case envelope required on every model binding and (2) a COUNT of
    // settled claims that exceeded their estimate, surfaced on /admin/ai-costs.
    // ─────────────────────────────────────────────────────────────────────
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE - COST_PER_CALL_PENCE);
    // Ten times the reported usage the envelope was calibrated for.
    const greedy = async () => ({
      value: "a draft",
      usage: { ...USAGE, inputTokens: USAGE.inputTokens * 10 },
    });
    const outcome = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      greedy,
      { orgId: ORG_A },
    );
    expect(outcome.status).toBe("ran");
    // The breach is real: 10 x £10 committed against £10 of headroom.
    expect(monthTotal(ORG_A)).toBeGreaterThan(AI_MONTHLY_CEILING_PENCE);
    // And it is VISIBLE, which is what makes it a calibration bug rather than
    // an invisible leak.
    const overruns = reservations.filter(
      (r) => r.state === "settled" && (r.cost_pence ?? 0) > r.estimate_pence,
    );
    expect(overruns).toHaveLength(1);
    // The wall is up straight afterwards, so the breach is a one-call event.
    const next = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A },
    );
    expect(next.status).toBe("blocked");
  });
});

// =====================================================================
// 5. THE CONCURRENCY FINDING.
// =====================================================================

describe("the ceiling is a RESERVE, and it holds under concurrency", () => {
  it("N calls in flight at once: the ones that fit run, the rest are REFUSED", async () => {
    // ─────────────────────────────────────────────────────────────────────
    // THE DEFECT THIS REPLACES, and the measurement that pinned it. The old
    // governor read the month total, ran the function, then recorded the cost —
    // so twenty calls issued in the same tick all read the SAME pre-spend total,
    // all found themselves under the ceiling, and all spent. Overshoot was
    // bounded only by (in-flight x per-call cost). It was recorded here as a
    // finding rather than a pass, and this is that finding closed.
    //
    // The claim is now taken BEFORE the call and is visible to every other
    // caller from the instant it commits, so the twentieth caller is refused by
    // the nineteenth's claim rather than by a ledger row that does not exist
    // yet.
    //
    // Counterfactual, measured on real Postgres with the advisory lock removed
    // and everything else byte-identical: 5 claims admitted where 3 fit, total
    // 12,000p against a 10,000p ceiling — a 20% breach. Transcript in
    // docs/ai-cost-governor.md.
    // ─────────────────────────────────────────────────────────────────────
    const CONCURRENCY = 20;
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE - COST_PER_CALL_PENCE); // one call left

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
          orgId: ORG_A,
          dedupeContent: `concurrent-${i}`,
        }),
      ),
    );

    // EXACTLY the number that fit — one — and nineteen refusals.
    expect(outcomes.filter((o) => o.status === "ran")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "blocked")).toHaveLength(CONCURRENCY - 1);
    for (const o of outcomes.filter((x) => x.status === "blocked")) {
      if (o.status !== "blocked") throw new Error("unreachable");
      expect(o.reason).toBe("ceiling");
    }

    // THE INVARIANT: committed spend never passes the ceiling. Not "by less
    // than N x cost" — never.
    expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE);
    expect(monthTotal(ORG_A) + liveClaims(ORG_A)).toBeLessThanOrEqual(AI_MONTHLY_CEILING_PENCE);

    const afterwards = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A, dedupeContent: "after-the-storm" },
    );
    expect(afterwards.status).toBe("blocked");
  });

  it("committed + reserved never exceeds the ceiling at ANY point during a storm", async () => {
    // Sampled from a caller's own view of the world: every reservation the gate
    // admits reports the position it was admitted against, and adding this
    // call's claim to that position must never breach.
    const CONCURRENCY = 30;
    const positions: number[] = [];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        invokeWithGovernor(
          QUOTE_WRITER_FEATURE,
          QUOTE_WRITER_TASK_CLASS,
          async () => {
            positions.push(monthTotal(ORG_A) + liveClaims(ORG_A));
            return { value: "a draft", usage: USAGE };
          },
          { orgId: ORG_A, dedupeContent: `storm-${i}` },
        ),
      ),
    );
    expect(positions).toHaveLength(CALLS_TO_CEILING);
    for (const p of positions) {
      expect(p).toBeLessThanOrEqual(AI_MONTHLY_CEILING_PENCE);
    }
    expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE);
  });

  it("SEQUENTIAL traffic — unchanged — never exceeds the ceiling by a penny", async () => {
    // A human pressing a button is sequential. This is the path that actually
    // carries the money today, and on it the ceiling is exact.
    let ran = 0;
    for (let i = 0; i < 50; i += 1) {
      const outcome = await invokeWithGovernor(
        QUOTE_WRITER_FEATURE,
        QUOTE_WRITER_TASK_CLASS,
        okCall,
        { orgId: ORG_A, dedupeContent: `sequential-${i}` },
      );
      if (outcome.status === "ran") ran += 1;
    }
    expect(ran).toBe(CALLS_TO_CEILING);
    expect(monthTotal(ORG_A)).toBe(AI_MONTHLY_CEILING_PENCE);
  });
});

// =====================================================================
// 6. The routing table cannot be talked around.
// =====================================================================

describe("the registry is the authority on what class a call runs as", () => {
  it("`quote.writer_draft` is REGISTERED as drafting", async () => {
    const { featureDefinition } = await import("@/lib/ai/governor/registry");
    expect(featureDefinition(QUOTE_WRITER_FEATURE)?.taskClass).toBe("drafting");
    expect(QUOTE_WRITER_TASK_CLASS).toBe("drafting");
  });

  it("REFUSES a deterministic task mislabelled as this feature, before any I/O", async () => {
    // The class is caller-supplied, so "what stops a deterministic task being
    // sent to a model?" is a real question. The answer is three independent
    // layers: this registry disagreement, the wrapper's deterministic refusal,
    // and the ledger's task_class CHECK — which makes the row unrepresentable
    // even for the service role.
    const fn = vi.fn(okCall);
    await expect(
      invokeWithGovernor(QUOTE_WRITER_FEATURE, "deterministic", fn, { orgId: ORG_A }),
    ).rejects.toThrow(/registered as "drafting"|deterministic/i);
    expect(fn).not.toHaveBeenCalled();
    expect(stats.budgetReads).toBe(0);
    expect(stats.inserts).toBe(0);
  });

  it("REFUSES a promotion to the expensive tier", async () => {
    const fn = vi.fn(okCall);
    await expect(
      invokeWithGovernor(QUOTE_WRITER_FEATURE, "complex", fn, { orgId: ORG_A }),
    ).rejects.toThrow(/registered as "drafting"/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("REFUSES an unregistered feature — the registry is the review point", async () => {
    const fn = vi.fn(okCall);
    await expect(
      // @ts-expect-error — deliberately outside the AiFeature union.
      invokeWithGovernor("quotes.some_new_ai_surface", "drafting", fn, { orgId: ORG_A }),
    ).rejects.toThrow(/not in the registry/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it("the ledger REFUSES a deterministic row even if one were somehow constructed", async () => {
    // Belt and braces, restating the DB CHECK in the harness so the layering is
    // visible: three independent statements of one rule.
    const admin = (await import("@/lib/supabase/admin")).createAdminClient() as unknown as {
      from(t: string): { insert(row: Record<string, unknown>): Promise<{ error: unknown }> };
    };
    const { error } = await admin
      .from("ai_invocations")
      .insert({ task_class: "deterministic", success: true });
    expect(error).not.toBeNull();
  });
});
