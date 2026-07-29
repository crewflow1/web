import { describe, it, expect, vi, beforeEach } from "vitest";
import { AI_MONTHLY_CEILING_PENCE } from "@/lib/ai/governor/policy";
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
 * in-memory ledger that models the real SQL: a month-total rollup, a dedupe
 * probe over (org, feature, content_hash, success, created_at), and an insert.
 * Every number below is the governor's own arithmetic, not a restatement of it.
 *
 * ONE RESULT IS A FINDING RATHER THAN A PASS. The concurrency test measures a
 * genuine time-of-check/time-of-use gap in the governor as written, pins its
 * bound, and says what the fix would be. It is written to record the truth, not
 * to make the suite green — see "the ceiling is a START gate, not a reserve".
 */

// ---------------------------------------------------------------------------
// The fake, priced model binding. Chosen so ONE call costs exactly £10, which
// makes the £100 ceiling exactly ten calls and every assertion below countable
// by hand rather than by trusting the cost estimator.
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
    /** Bumped on every rollup read, so a test can prove a read happened at all. */
    stats: { budgetReads: 0, dedupeProbes: 0, inserts: 0 },
  };
});

// BINDING itself is only referenced inside the hoisted mock factories, via `H`.
const { USAGE, ledger, stats } = H;
const COST_PER_CALL_PENCE = 1_000;
const CALLS_TO_CEILING = AI_MONTHLY_CEILING_PENCE / COST_PER_CALL_PENCE; // 10

function monthTotal(orgId: string): number {
  return ledger
    .filter((r) => r.org_id === orgId)
    .reduce((sum, r) => sum + Number(r.estimated_cost_pence ?? 0), 0);
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "ai_invocations_month_totals") return { data: [], error: null };
      H.stats.budgetReads += 1;
      // The real function returns one row per org with spend; none when there
      // is no spend at all. Modelled faithfully — a governor that only works
      // when a row exists would fail on an org's first ever call.
      const orgId = String(args.p_org_id ?? "");
      const total = H.ledger
        .filter((r) => r.org_id === orgId)
        .reduce((sum, r) => sum + Number(r.estimated_cost_pence ?? 0), 0);
      return { data: total > 0 ? [{ org_id: orgId, total_cost_pence: total }] : [], error: null };
    },
    from: (t: string) => {
      if (t !== "ai_invocations") throw new Error(`unexpected table ${t}`);
      return {
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
        select: () => {
          const filters: Record<string, unknown> = {};
          let since = 0;
          const probe = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return probe;
            },
            gte(_col: string, val: unknown) {
              since = new Date(String(val)).getTime();
              return probe;
            },
            limit: async () => {
              H.stats.dedupeProbes += 1;
              const hits = H.ledger.filter(
                (r) =>
                  r.org_id === filters.org_id &&
                  r.feature === filters.feature &&
                  r.content_hash === filters.content_hash &&
                  r.success === filters.success &&
                  new Date(r.created_at).getTime() >= since,
              );
              return { data: hits.slice(0, 1), error: null };
            },
          };
          return probe;
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
  stats.budgetReads = 0;
  stats.dedupeProbes = 0;
  stats.inserts = 0;
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

  it("one penny under the ceiling still runs — the boundary is exact", async () => {
    seedSpend(ORG_A, AI_MONTHLY_CEILING_PENCE - 1);
    const outcome = await invokeWithGovernor(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, okCall, {
      orgId: ORG_A,
    });
    expect(outcome.status).toBe("ran");
  });

  it("the warning bands fire and are ADVISORY — they never refuse work", async () => {
    for (const [spend, expected] of [
      [0, "allowed"],
      [AI_MONTHLY_CEILING_PENCE * 0.5 - 1, "allowed"],
      [AI_MONTHLY_CEILING_PENCE * 0.5, "warn_50"],
      [AI_MONTHLY_CEILING_PENCE * 0.8 - 1, "warn_50"],
      [AI_MONTHLY_CEILING_PENCE * 0.8, "warn_80"],
      [AI_MONTHLY_CEILING_PENCE - 1, "warn_80"],
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

  it("FINDING: ten SIMULTANEOUS identical submits are NOT deduplicated", async () => {
    // ─────────────────────────────────────────────────────────────────────
    // This test asserts the behaviour that exists, not the one that would be
    // nicer. Dedupe is a READ-THEN-ACT probe, exactly like the budget check, so
    // ten requests issued in the same tick all find no prior row and all call
    // the model. Ten identical presses therefore cost ten times, not once.
    //
    // With this harness's £10-per-call model that is the ENTIRE monthly ceiling
    // consumed by one impatient double-click — which is worth stating plainly
    // rather than leaving for someone to find on a bill. The realistic cost per
    // drafting call is far below £10, so the real-world exposure is smaller;
    // the SHAPE of the defect is identical either way.
    //
    // Both this and the budget gap have the same root cause and the same fix: a
    // single atomic SQL reservation instead of a read followed by a write. It
    // is listed as a pre-activation item. Note that the governor's own header
    // is honest about this — it calls the recent-duplicate check "a backstop
    // for the doctrine, not a substitute for following it".
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
    const ran = results.filter((r) => r.status === "ran").length;
    expect(ran).toBe(10);
    expect(monthTotal(ORG_A)).toBe(10 * COST_PER_CALL_PENCE);
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
});

// =====================================================================
// 5. THE CONCURRENCY FINDING.
// =====================================================================

describe("the ceiling is a START gate, not a reserve — and here is the size of the gap", () => {
  it("MEASURES the overshoot when N calls are genuinely in flight at once", async () => {
    // ─────────────────────────────────────────────────────────────────────
    // THIS TEST RECORDS A REAL LIMITATION. It is not a pass dressed up as one.
    //
    // `invokeWithGovernor` reads the month total, then runs the function, then
    // records the cost. Twenty calls issued in the same tick all read the SAME
    // pre-spend total, all find themselves under the ceiling, and all spend.
    // That is a textbook time-of-check/time-of-use gap, and no amount of
    // application-side care closes it, because the check and the write are two
    // round trips with the provider call in between.
    //
    // WHAT IS ACTUALLY GUARANTEED: no call STARTS once recorded spend has
    // reached the ceiling. The exposure is therefore bounded by
    //     (calls in flight) x (cost of the most expensive single call),
    // which for realistic drafting traffic is small — but it is not zero, and
    // "the ceiling was only exceeded by the calls that were already running"
    // should be written down rather than discovered.
    //
    // THE FIX, when this matters: make the reservation atomic in SQL — an
    // `insert ... select where (select coalesce(sum(estimated_cost_pence),0)
    // from ai_invocations where org_id = $1 and <month>) < $ceiling` that
    // reserves before the call and reconciles the true cost after. That belongs
    // in the governor, not here, and it is listed as a pre-activation item.
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

    const ran = outcomes.filter((o) => o.status === "ran").length;
    const finalSpend = monthTotal(ORG_A);
    const overshoot = finalSpend - AI_MONTHLY_CEILING_PENCE;

    // The honest expectation: the in-flight calls are NOT individually stopped.
    expect(ran).toBeGreaterThan(1);
    expect(overshoot).toBeGreaterThan(0);

    // …and the bound holds. This is the assertion that would catch a
    // regression making the gap unbounded.
    expect(overshoot).toBeLessThanOrEqual(CONCURRENCY * COST_PER_CALL_PENCE);

    // THE GUARANTEE THAT DOES HOLD: once the spend is recorded, the wall is up.
    const afterwards = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      okCall,
      { orgId: ORG_A, dedupeContent: "after-the-storm" },
    );
    expect(afterwards.status).toBe("blocked");
  });

  it("SEQUENTIAL traffic — the realistic case — never exceeds the ceiling by a penny", async () => {
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
