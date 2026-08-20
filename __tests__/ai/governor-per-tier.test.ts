import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * PER-TIER ACTIVATION — the cross-modality pins.
 *
 * The governor's dark short-circuit used to be GLOBAL (`isGovernorActivated()`):
 * with a single modality in the registry that was indistinguishable from
 * per-tier. The moment the `embedding` tier joined, "some tier somewhere is
 * bound" became the wrong question at every gate:
 *
 *   - inside `invokeWithGovernor`, a build with ONLY embeddings armed would
 *     have pushed every drafting/classification call into the reservation path
 *     with a NULL binding — a floor claim for a call that reaches no model;
 *   - at the doors, binding an embedding model would have let a bare
 *     ANTHROPIC_API_KEY open `getTextProvider()` — recreating the exact
 *     key-only activation the governance closure removed.
 *
 * This file arms ONE tier at a time (a mutable TIER_MODEL stands in for the
 * registry's; everything else — readiness, the governor, the doors — is real)
 * and pins that the OTHER modality stays dark in both directions. The Supabase
 * admin client is a counting mock, so "no reservation" is a measurement.
 */

const tierModelRef = vi.hoisted(
  () =>
    ({
      cheap: null,
      mid: null,
      high: null,
      embedding: null,
      transcription: null,
    }) as Record<string, unknown>,
);

vi.mock("@/lib/ai/governor/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/governor/registry")>();
  // Same object identity across the whole module graph; tests mutate its keys.
  return { ...actual, TIER_MODEL: tierModelRef };
});

const adminConstructions = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminConstructions.count += 1;
    return {
      from: () => ({ insert: async () => ({ error: null }) }),
      rpc: async () => ({ data: [], error: null }),
    };
  },
}));

import { invokeWithGovernor } from "@/lib/ai/governor";
import {
  isEmbeddingActivated,
  isInferenceTierActivated,
  isTierActivated,
} from "@/lib/ai/governor/readiness";
import { getTextProvider } from "@/lib/ai/text";
import { getVisionProvider } from "@/lib/ai/vision";
import { getEmbeddingProvider } from "@/lib/ai/embeddings";

const ORG = "00000000-0000-0000-0000-0000000000aa";

/** A plausible embedding binding whose model MATCHES the openai provider's. */
const EMBED_BINDING = {
  provider: "openai",
  model: "text-embedding-3-small",
  usdPerMTokIn: 0.02,
  usdPerMTokOut: 0,
  reserveInputTokens: 8_000,
  reserveOutputTokens: 0,
};

/** A generative binding for the inverse direction. */
const CHEAP_BINDING = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  usdPerMTokIn: 1,
  usdPerMTokOut: 5,
  reserveInputTokens: 4_000,
  reserveOutputTokens: 1_000,
};

function bindOnly(tier: "embedding" | "cheap", binding: unknown): void {
  for (const t of ["cheap", "mid", "high", "embedding", "transcription"]) tierModelRef[t] = null;
  tierModelRef[tier] = binding;
}

beforeEach(() => {
  for (const t of ["cheap", "mid", "high", "embedding", "transcription"]) tierModelRef[t] = null;
  adminConstructions.count = 0;
  // Worst case an operator can create: EVERY vendor credential present.
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-real");
  vi.stubEnv("OPENAI_API_KEY", "sk-not-real");
  vi.stubEnv("MEMORY_TEXT_PROVIDER", "auto");
  vi.stubEnv("MEMORY_EMBEDDING_PROVIDER", "openai");
});
afterEach(() => vi.unstubAllEnvs());

// =====================================================================
// Readiness separates the modalities
// =====================================================================

describe("readiness answers PER TIER, so the modalities cannot arm each other", () => {
  it("only 'embedding' bound ⇒ embedding activated, NO inference tier activated", () => {
    bindOnly("embedding", EMBED_BINDING);
    expect(isEmbeddingActivated()).toBe(true);
    expect(isTierActivated("embedding")).toBe(true);
    expect(isInferenceTierActivated()).toBe(false);
    for (const t of ["cheap", "mid", "high"] as const) {
      expect(isTierActivated(t), `${t} must stay dark`).toBe(false);
    }
  });

  it("only 'cheap' bound ⇒ inference activated, embedding STAYS dark", () => {
    bindOnly("cheap", CHEAP_BINDING);
    expect(isInferenceTierActivated()).toBe(true);
    expect(isEmbeddingActivated()).toBe(false);
  });
});

// =====================================================================
// The governor's dark short-circuit is PER TIER
// =====================================================================

describe("invokeWithGovernor short-circuits on the CALL'S tier, not on any tier", () => {
  it("only 'embedding' bound: a DRAFTING call takes the dark path — fn runs, no reservation", async () => {
    bindOnly("embedding", EMBED_BINDING);
    const fn = vi.fn(async () => ({ value: "draft", usage: null }));

    const outcome = await invokeWithGovernor("receptionist.reply_draft", "drafting", fn, {
      orgId: ORG,
      dedupeContent: "content that must never be hashed on a dark tier",
    });

    expect(outcome.status).toBe("ran");
    if (outcome.status !== "ran") throw new Error("unreachable");
    expect(outcome.value).toBe("draft");
    expect(outcome.dark).toBe(true);
    expect(outcome.recorded).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    // The measurement, not the claim: zero database contact.
    expect(adminConstructions.count).toBe(0);
  });

  it("only 'cheap' bound: an EMBEDDING call takes the dark path — the vice-versa pin", async () => {
    bindOnly("cheap", CHEAP_BINDING);
    const fn = vi.fn(async () => ({ value: { vectors: [] }, usage: null }));

    const outcome = await invokeWithGovernor("memory.embedding_write", "embedding", fn, {
      orgId: ORG,
    });

    expect(outcome.status).toBe("ran");
    if (outcome.status !== "ran") throw new Error("unreachable");
    expect(outcome.dark).toBe(true);
    expect(outcome.recorded).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(adminConstructions.count).toBe(0);
  });
});

// =====================================================================
// The doors — each modality's door opens on ITS OWN tier only
// =====================================================================

describe("the provider doors are per-modality — no cross-activation", () => {
  it("only 'embedding' bound + ANTHROPIC_API_KEY set: the TEXT door stays SHUT", () => {
    // THE cross-modality pin. Under the old global gate this returned a live
    // Anthropic provider — a key-only activation reachable by binding a model
    // for a different modality entirely.
    bindOnly("embedding", EMBED_BINDING);
    expect(getTextProvider()).toBeNull();
  });

  it("only 'embedding' bound: the VISION door stays shut too", () => {
    bindOnly("embedding", EMBED_BINDING);
    expect(getVisionProvider()).toBeNull();
  });

  it("only 'cheap' bound + OPENAI_API_KEY set: the PAID EMBEDDING door stays shut", () => {
    bindOnly("cheap", CHEAP_BINDING);
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("'embedding' bound to the provider's own model: its door OPENS", () => {
    bindOnly("embedding", EMBED_BINDING);
    const p = getEmbeddingProvider();
    expect(p).not.toBeNull();
    expect(p?.info.provider).toBe("openai");
    expect(p?.info.model).toBe("text-embedding-3-small");
  });

  it("'embedding' bound to a DIFFERENT model: the door REFUSES rather than bill an unauthorised model", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    bindOnly("embedding", { ...EMBED_BINDING, model: "text-embedding-3-large" });
    expect(getEmbeddingProvider()).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
