import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AI_FEATURES,
  AI_FEATURE_KEYS,
  AI_TASK_CLASSES,
  AI_TIERS,
  TASK_CLASS_TIER,
  TIER_MODEL,
  featureDefinition,
  isAnyTierBound,
  resolveModel,
  tierFor,
} from "@/lib/ai/governor/registry";
import {
  AI_UNGOVERNED_INFERENCE_ENTRY_POINTS,
  composeTierReadiness,
  getAiGovernorReadiness,
  isGovernorActivated,
  KNOWN_VENDOR_CREDENTIALS,
} from "@/lib/ai/governor/readiness";

/**
 * AI Cost Governor — the seam's REFUSALS and its DARK PASS-THROUGH.
 *
 * Two behaviours are load-bearing enough to be tested against the real module
 * rather than reasoned about:
 *
 *   1. A `deterministic` task class must be REFUSED loudly. Sending a regex
 *      problem to a language model is slower, less reliable and costs money for
 *      an answer that was already computable.
 *   2. With no tier bound, the wrapper must run the caller's function and
 *      touch NOTHING — no budget read, no dedupe read, no ledger write. That is
 *      what makes wiring the governor into three dark seams a no-op, which is
 *      the only honest way to install a control ahead of the thing it controls.
 *
 * The Supabase admin client is mocked to a spy that FAILS the test if it is
 * ever constructed on the dark path — an assertion about I/O that did not
 * happen is otherwise very easy to write and very hard to keep true.
 */

const adminClientCalls = { count: 0 };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminClientCalls.count += 1;
    // Nothing on the dark path should reach this. If it does, the test that
    // asserts zero database contact fails with a real count rather than a
    // vague timeout.
    return {
      from: () => ({
        insert: async () => ({ error: null }),
        select: () => ({
          eq() {
            return this;
          },
          gte() {
            return this;
          },
          limit: async () => ({ data: [], error: null }),
        }),
      }),
      rpc: async () => ({ data: [], error: null }),
    };
  },
}));

const { invokeWithGovernor } = await import("@/lib/ai/governor");

beforeEach(() => {
  adminClientCalls.count = 0;
});
afterEach(() => vi.unstubAllEnvs());

const ORG = "00000000-0000-0000-0000-0000000000aa";

// =====================================================================
// 1. The registry is data, and it is closed.
// =====================================================================

describe("the task-class routing table is DATA, with models in exactly one place", () => {
  it("names the four task classes", () => {
    expect([...AI_TASK_CLASSES]).toEqual([
      "deterministic",
      "classification",
      "drafting",
      "complex",
    ]);
  });

  it("routes each class to its cost tier — and `deterministic` to NO tier at all", () => {
    expect(TASK_CLASS_TIER.deterministic).toBeNull();
    expect(TASK_CLASS_TIER.classification).toBe("cheap");
    expect(TASK_CLASS_TIER.drafting).toBe("mid");
    expect(TASK_CLASS_TIER.complex).toBe("high");
    expect(tierFor("deterministic")).toBeNull();
  });

  it("tiers are ABSTRACT — no vendor or model name appears among them", () => {
    for (const tier of AI_TIERS) {
      expect(tier).not.toMatch(/anthropic|openai|claude|gpt|haiku|sonnet|opus/i);
    }
  });

  it("EVERY tier is currently mapped to NO provider — the build is dark", () => {
    for (const tier of AI_TIERS) {
      expect(TIER_MODEL[tier], `${tier} must be unbound`).toBeNull();
    }
    expect(isAnyTierBound()).toBe(false);
    for (const cls of AI_TASK_CLASSES) {
      expect(resolveModel(cls), `${cls} must resolve to no model`).toBeNull();
    }
  });

  it("every registered feature declares a task class the routing table knows", () => {
    expect(AI_FEATURE_KEYS.length).toBeGreaterThan(0);
    for (const key of AI_FEATURE_KEYS) {
      const def = AI_FEATURES[key];
      expect(def.key).toBe(key);
      expect(AI_TASK_CLASSES).toContain(def.taskClass);
      // No registered capability may be deterministic — it would be
      // unreachable by construction.
      expect(def.taskClass).not.toBe("deterministic");
      expect(def.degradesTo.length).toBeGreaterThan(0);
    }
  });

  it("the registry is CLOSED — an unknown key resolves to nothing", () => {
    expect(featureDefinition("something.invented")).toBeNull();
  });
});

// =====================================================================
// 2. The deterministic refusal.
// =====================================================================

describe("invokeWithGovernor REFUSES the deterministic task class, loudly", () => {
  it("throws rather than calling the function", async () => {
    const fn = vi.fn(async () => ({ value: 1, usage: null }));
    await expect(
      invokeWithGovernor(
        "receptionist.inbound_extraction",
        // The declared class a caller might reach for when the work is a regex.
        "deterministic",
        fn,
        { orgId: ORG },
      ),
    ).rejects.toThrow(/REFUSED|registered as/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it("the refusal explains WHAT to do instead — compute, do not generate", async () => {
    // Registered as `drafting`, invoked as `deterministic`: the registry
    // mismatch fires first and is itself an explicit, actionable refusal.
    await expect(
      invokeWithGovernor(
        "receptionist.reply_draft",
        "deterministic",
        async () => ({ value: null, usage: null }),
        { orgId: ORG },
      ),
    ).rejects.toThrow(/registry is the authority|deterministic/i);
  });

  it("refuses BEFORE any database contact", async () => {
    await expect(
      invokeWithGovernor(
        "expense.receipt_extraction",
        "deterministic",
        async () => ({ value: null, usage: null }),
        { orgId: ORG },
      ),
    ).rejects.toThrow();
    expect(adminClientCalls.count).toBe(0);
  });

  it("an UNREGISTERED feature is refused too — the registry is the review point", async () => {
    const fn = vi.fn(async () => ({ value: 1, usage: null }));
    await expect(
      // @ts-expect-error — deliberately outside the AiFeature union.
      invokeWithGovernor("some.new.ai.surface", "drafting", fn, { orgId: ORG }),
    ).rejects.toThrow(/not in the registry/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a call site cannot PROMOTE itself to a more expensive class", async () => {
    // `expense.receipt_extraction` is registered `classification` (cheap tier).
    // Declaring it `complex` would silently route it to the expensive tier.
    const fn = vi.fn(async () => ({ value: 1, usage: null }));
    await expect(
      invokeWithGovernor("expense.receipt_extraction", "complex", fn, { orgId: ORG }),
    ).rejects.toThrow(/registered as "classification"/);
    expect(fn).not.toHaveBeenCalled();
  });
});

// =====================================================================
// 3. The dark pass-through — the proof that wiring changed nothing.
// =====================================================================

describe("with NO provider bound, the wrapper is a pure pass-through", () => {
  it("runs the function and returns its value unchanged", async () => {
    const outcome = await invokeWithGovernor(
      "expense.receipt_extraction",
      "classification",
      async () => ({ value: { amount: 42 }, usage: null }),
      { orgId: ORG },
    );
    expect(outcome.status).toBe("ran");
    if (outcome.status !== "ran") throw new Error("unreachable");
    expect(outcome.value).toEqual({ amount: 42 });
    expect(outcome.dark).toBe(true);
  });

  it("RECORDS NOTHING", async () => {
    const outcome = await invokeWithGovernor(
      "receptionist.reply_draft",
      "drafting",
      async () => ({ value: "draft", usage: null }),
      { orgId: ORG },
    );
    expect(outcome.status).toBe("ran");
    if (outcome.status !== "ran") throw new Error("unreachable");
    expect(outcome.recorded).toBe(false);
  });

  it("performs ZERO database round trips — not even a budget read", async () => {
    // The assertion that makes "wiring the dark seams costs nothing" a fact
    // rather than a claim: no admin client is ever constructed.
    await invokeWithGovernor(
      "receptionist.inbound_extraction",
      "classification",
      async () => ({ value: "x", usage: null }),
      { orgId: ORG, dedupeContent: "a message that would otherwise be hashed and looked up" },
    );
    expect(adminClientCalls.count).toBe(0);
  });

  it("is dark even with a vendor credential set — a key alone activates nothing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-real");
    vi.stubEnv("OPENAI_API_KEY", "sk-not-real");
    const outcome = await invokeWithGovernor(
      "expense.receipt_extraction",
      "classification",
      async () => ({ value: "still degraded", usage: null }),
      { orgId: ORG },
    );
    expect(outcome.status).toBe("ran");
    if (outcome.status !== "ran") throw new Error("unreachable");
    expect(outcome.dark).toBe(true);
    expect(adminClientCalls.count).toBe(0);
  });

  it("PROPAGATES a thrown error untouched, so every caller's existing catch still owns the degraded path", async () => {
    const boom = new Error("provider exploded");
    await expect(
      invokeWithGovernor(
        "receptionist.inbound_extraction",
        "classification",
        async () => {
          throw boom;
        },
        { orgId: ORG },
      ),
    ).rejects.toBe(boom);
    // And it did not try to record the failure on the dark path either.
    expect(adminClientCalls.count).toBe(0);
  });
});

// =====================================================================
// 4. Readiness — the #433 false-green invariant, applied to AI.
// =====================================================================

describe("activation readiness — no binding ⇒ NEVER activated", () => {
  it("reports dark today, with a checklist of what is missing", () => {
    const r = getAiGovernorReadiness();
    expect(r.activated).toBe(false);
    expect(r.anyTierBound).toBe(false);
    expect(isGovernorActivated()).toBe(false);
    expect(r.blockers.length).toBeGreaterThan(0);
    for (const tier of r.tiers) {
      expect(tier.modelBindingPresent).toBe(false);
      expect(tier.providerResolvable).toBe(false);
      expect(tier.provider).toBeNull();
      expect(tier.model).toBeNull();
    }
  });

  it("stays dark with EVERY known vendor credential present — the invariant", () => {
    // The exact shape of the comms incident (#433) transposed to AI: everything
    // an operator controls is satisfied, and the capability still does not exist.
    for (const v of KNOWN_VENDOR_CREDENTIALS) vi.stubEnv(v, "present");
    const r = getAiGovernorReadiness();
    expect(r.credentialsPresent.length).toBe(KNOWN_VENDOR_CREDENTIALS.length);
    expect(r.activated).toBe(false);
    expect(isGovernorActivated()).toBe(false);
  });

  it("still REPORTS the drift — a credential with no binding is named, not hidden", () => {
    // The credential's presence is a fact an operator must see either way: it is
    // either an activation half-done or a key that should be removed. What
    // changed with the governance closure is what it IMPLIES, asserted below.
    vi.stubEnv("ANTHROPIC_API_KEY", "present");
    const r = getAiGovernorReadiness();
    expect(r.credentialsPresent).toContain("ANTHROPIC_API_KEY");
    expect(r.activated).toBe(false);
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it("a credential with no binding is NO LONGER an ungoverned-spend risk", () => {
    // THE readiness change. This used to be `true`, because seven call sites
    // gated on a bare key check and would have reached a provider on the
    // strength of the credential alone — spend with no ceiling and no ledger
    // row, while `invokeWithGovernor` waved it through as a dark pass-through.
    //
    // Every provider door now requires `isGovernorActivated()`, so the
    // credential switches nothing on. The flag is DERIVED from
    // `AI_UNGOVERNED_INFERENCE_ENTRY_POINTS`, which the security ratchet
    // recomputes from source text — so if a bare-credential path ever returns,
    // this goes amber again on its own rather than staying green by assertion.
    vi.stubEnv("ANTHROPIC_API_KEY", "present");
    expect(AI_UNGOVERNED_INFERENCE_ENTRY_POINTS).toBe(0);
    expect(getAiGovernorReadiness().ungovernedCredentialRisk).toBe(false);

    // And with BOTH vendor credentials present, which is the worst case an
    // operator can create without touching the build.
    for (const v of KNOWN_VENDOR_CREDENTIALS) vi.stubEnv(v, "present");
    const both = getAiGovernorReadiness();
    expect(both.credentialsPresent.length).toBe(KNOWN_VENDOR_CREDENTIALS.length);
    expect(both.ungovernedCredentialRisk).toBe(false);
    expect(both.activated).toBe(false);
  });

  it("no credentials ⇒ no drift risk", () => {
    for (const v of KNOWN_VENDOR_CREDENTIALS) vi.stubEnv(v, "");
    const r = getAiGovernorReadiness();
    expect(r.credentialsPresent).toEqual([]);
    expect(r.ungovernedCredentialRisk).toBe(false);
  });

  it("composeTierReadiness proves the rule DIRECTLY — credential satisfied, still not resolvable", () => {
    const r = composeTierReadiness({
      tier: "cheap",
      binding: null, // nothing bound in this build…
      credentialPresent: true, // …but the operator has done everything right
    });
    expect(r.credentialsPresent).toBe(true);
    expect(r.modelBindingPresent).toBe(false);
    expect(r.providerResolvable).toBe(false);
    expect(r.blockers).toContain("no model bound to the 'cheap' tier in this build");
  });

  it("a bound tier WITHOUT its credential is also not resolvable (both are necessary)", () => {
    const r = composeTierReadiness({
      tier: "mid",
      binding: { provider: "anthropic", model: "a-model" },
      credentialPresent: false,
    });
    expect(r.modelBindingPresent).toBe(true);
    expect(r.providerResolvable).toBe(false);
    expect(r.blockers).toContain("ANTHROPIC_API_KEY");
  });

  it("binding AND credential together DO resolve — the fields are necessary, not merely obstructive", () => {
    const r = composeTierReadiness({
      tier: "high",
      binding: { provider: "anthropic", model: "a-model" },
      credentialPresent: true,
    });
    expect(r.providerResolvable).toBe(true);
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("a-model");
    expect(r.blockers).toEqual([]);
  });

  it("an unknown vendor is not resolvable — we cannot check a credential we do not know", () => {
    const r = composeTierReadiness({
      tier: "cheap",
      binding: { provider: "some-new-vendor", model: "m" },
    });
    expect(r.providerResolvable).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/no known credential/);
  });

  it("never throws, whatever the environment — a readiness probe must always answer", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "   ");
    expect(() => getAiGovernorReadiness()).not.toThrow();
    expect(getAiGovernorReadiness().activated).toBe(false);
  });
});
