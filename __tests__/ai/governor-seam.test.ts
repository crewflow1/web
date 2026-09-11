import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AI_FEATURES,
  AI_FEATURE_KEYS,
  AI_TASK_CLASSES,
  AI_TIERS,
  INFERENCE_TIERS,
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
  it("names the six task classes — 'embedding' admitted by migration 20261080, 'transcription' by 20261191", () => {
    expect([...AI_TASK_CLASSES]).toEqual([
      "deterministic",
      "classification",
      "drafting",
      "complex",
      "embedding",
      "transcription",
    ]);
  });

  it("routes each class to its cost tier — and `deterministic` to NO tier at all", () => {
    expect(TASK_CLASS_TIER.deterministic).toBeNull();
    expect(TASK_CLASS_TIER.classification).toBe("cheap");
    expect(TASK_CLASS_TIER.drafting).toBe("mid");
    expect(TASK_CLASS_TIER.complex).toBe("high");
    // The modality IS the class: embedding routes to its OWN tier, never to a
    // generative price band, so the two arming switches stay separable.
    expect(TASK_CLASS_TIER.embedding).toBe("embedding");
    expect(tierFor("deterministic")).toBeNull();
    expect(tierFor("embedding")).toBe("embedding");
  });

  it("tiers are ABSTRACT — no vendor or model name appears among them", () => {
    for (const tier of AI_TIERS) {
      expect(tier).not.toMatch(/anthropic|openai|claude|gpt|haiku|sonnet|opus/i);
    }
  });

  it("the armed lineup: cheap/mid/high (2026-09-10) + embedding (2026-09-11) — transcription stays dark", () => {
    // The armed truth, pinned so it can only change through a reviewed diff
    // (exact ids + prices are re-pinned in __tests__/ai/tier-bindings.test.ts).
    expect(TIER_MODEL.cheap?.model).toBe("claude-haiku-4-5-20251001");
    expect(TIER_MODEL.mid?.model).toBe("claude-sonnet-5");
    expect(TIER_MODEL.high?.model).toBe("claude-opus-5");
    expect(TIER_MODEL.embedding?.model).toBe("text-embedding-3-small");
    // The dark pin that REMAINS: transcription is unbound AND has no
    // transport (lib/ai/transcription.ts) — its own future reviewed diff.
    expect(TIER_MODEL.transcription).toBeNull();
    expect(isAnyTierBound()).toBe(true);
    expect(resolveModel("classification")?.model).toBe("claude-haiku-4-5-20251001");
    expect(resolveModel("drafting")?.model).toBe("claude-sonnet-5");
    expect(resolveModel("complex")?.model).toBe("claude-opus-5");
    expect(resolveModel("embedding")?.model).toBe("text-embedding-3-small");
    expect(resolveModel("transcription")).toBeNull();
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
// 1b. The embedding modality — registered, SEPARABLE, and dark.
// =====================================================================

describe("the 'embedding' modality is its own tier, never a generative price band", () => {
  it("'embedding' is a task class AND a tier — the modality is the class", () => {
    expect(AI_TASK_CLASSES).toContain("embedding");
    expect(AI_TIERS).toContain("embedding");
  });

  it("INFERENCE_TIERS is exactly the generative set — 'embedding' is EXCLUDED", () => {
    // The separability pin: the text/vision doors gate on INFERENCE_TIERS, so
    // admitting 'embedding' here would let an embedding binding open a
    // generative door on a bare key — the cross-activation defect the
    // governance closure exists to prevent.
    expect([...INFERENCE_TIERS]).toEqual(["cheap", "mid", "high"]);
    expect(INFERENCE_TIERS).not.toContain("embedding");
    // And every inference tier is a real tier.
    for (const t of INFERENCE_TIERS) expect(AI_TIERS).toContain(t);
  });

  it("both memory.embedding_* features are registered under the 'embedding' class", () => {
    for (const key of ["memory.embedding_write", "memory.embedding_query"]) {
      const def = featureDefinition(key);
      expect(def, `${key} must be registered`).not.toBeNull();
      expect(def!.taskClass, `${key} task class`).toBe("embedding");
      expect(def!.degradesTo.length).toBeGreaterThan(20);
    }
  });

  it("TIER_MODEL.embedding is ARMED to the factory's one accepted model", () => {
    // ARMED 2026-09-11. The provider factory (lib/ai/embeddings/index.ts)
    // hard-refuses any other model id, so this pin and the factory must move
    // together in any future rebind diff.
    expect(TIER_MODEL.embedding?.provider).toBe("openai");
    expect(TIER_MODEL.embedding?.model).toBe("text-embedding-3-small");
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

  it("a DARK modality stays a pure pass-through even with every vendor credential set", async () => {
    // The invariant survives the activation: a key alone still arms nothing.
    // cheap/mid/high are now bound (their calls take the real governed path),
    // so the pin moves to the modality that REMAINS dark — transcription.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-real");
    vi.stubEnv("OPENAI_API_KEY", "sk-not-real");
    const outcome = await invokeWithGovernor(
      "voice_note.transcription",
      "transcription",
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
  it("reports the ARMED inference tiers and the still-dark modalities, honestly", () => {
    // Activated readiness still tells the whole truth: bindings present for
    // cheap/mid/high; embedding/transcription report dark with their blockers.
    vi.stubEnv("ANTHROPIC_API_KEY", "present");
    const r = getAiGovernorReadiness();
    expect(r.anyTierBound).toBe(true);
    expect(isGovernorActivated()).toBe(true);
    for (const tier of r.tiers) {
      if (tier.tier === "cheap" || tier.tier === "mid" || tier.tier === "high") {
        expect(tier.modelBindingPresent).toBe(true);
        expect(tier.provider).toBe("anthropic");
        expect(tier.providerResolvable).toBe(true);
      } else if (tier.tier === "embedding") {
        // Bound to openai, but ONLY the anthropic key is stubbed here — the
        // per-vendor split is the honest report: binding present, vendor
        // credential absent, NOT resolvable; provider/model report null by
        // the resolvable-only rule, and the blocker NAMES the missing key.
        expect(tier.modelBindingPresent).toBe(true);
        expect(tier.providerResolvable).toBe(false);
        expect(tier.provider).toBeNull();
        expect(tier.blockers).toContain("OPENAI_API_KEY");
      } else {
        expect(tier.modelBindingPresent).toBe(false);
        expect(tier.providerResolvable).toBe(false);
        expect(tier.provider).toBeNull();
        expect(tier.model).toBeNull();
      }
    }
  });

  it("an armed tier WITHOUT its vendor credential is NOT resolvable — no false green", () => {
    // The #433 invariant survives in its real remaining form: binding alone is
    // not activation; the credential must also be present.
    const r = getAiGovernorReadiness();
    for (const tier of r.tiers) {
      if (tier.tier === "cheap" || tier.tier === "mid" || tier.tier === "high") {
        expect(tier.modelBindingPresent).toBe(true);
        expect(tier.providerResolvable).toBe(false);
      }
    }
    expect(isGovernorActivated()).toBe(false);
  });

  it("with every credential present: embedding resolves (armed 2026-09-11), transcription STAYS dark", () => {
    // #433 in its remaining form: a credential arms only what a reviewed
    // binding names. Embedding is now bound (openai) so the key resolves it;
    // transcription has no binding, so no credential can ever open it.
    for (const v of KNOWN_VENDOR_CREDENTIALS) vi.stubEnv(v, "present");
    const r = getAiGovernorReadiness();
    expect(r.credentialsPresent.length).toBe(KNOWN_VENDOR_CREDENTIALS.length);
    const emb = r.tiers.find((t) => t.tier === "embedding");
    const stt = r.tiers.find((t) => t.tier === "transcription");
    expect(emb?.providerResolvable).toBe(true);
    expect(stt?.providerResolvable).toBe(false);
  });

  it("still REPORTS the drift — a credential with no binding is named, not hidden", () => {
    // The credential's presence is a fact an operator must see either way: it is
    // either an activation half-done or a key that should be removed. What
    // changed with the governance closure is what it IMPLIES, asserted below.
    vi.stubEnv("OPENAI_API_KEY", "present");
    const r = getAiGovernorReadiness();
    expect(r.credentialsPresent).toContain("OPENAI_API_KEY");
    // OPENAI_API_KEY now arms the embedding binding (2026-09-11), while the
    // three anthropic tiers still miss THEIR credential in this env — the
    // blockers list keeps naming what is genuinely missing, never hidden.
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
    // Since the 2026-09-10 activation, binding + credential = activated —
    // and every one of those calls flows through the governed ledger, which
    // is exactly why the risk flag above stays false.
    expect(both.activated).toBe(true);
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
