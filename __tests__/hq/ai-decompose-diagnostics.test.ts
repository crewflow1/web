import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * AI saga decomposition — DIAGNOSTIC failure reasons (2026-09-10 incident).
 *
 * The first live attempt failed with every stage collapsed into one `null`:
 * the operator saw one blended error while the actual cause (an internal
 * budget org that no longer existed → fail-closed reserve refusal with ZERO
 * ledger footprint) was indistinguishable from a dark model. Each stage now
 * refuses with its own reason, and this suite proves each reason fires at
 * exactly its stage — plus the fence-stripping parse fix (models WILL fence
 * JSON; refusing fenced-but-valid JSON was a latent second defect).
 *
 * Nothing here weakens a control: every refusal is still a refusal; the graph
 * validation still rejects invalid proposals; the reasons carry stage names
 * only, never provider bodies or secrets.
 */

const h = vi.hoisted(() => ({
  tierActivated: true,
  budgetOrg: "org-hq" as string | null,
  provider: null as null | { info: { provider: string }; generate: ReturnType<typeof vi.fn> },
  governorOutcome: null as unknown,
  governorThrows: null as Error | null,
  invoked: vi.fn(),
}));

vi.mock("@/lib/ai/governor", () => ({
  isTierActivated: () => h.tierActivated,
  invokeWithGovernor: async (
    feature: string,
    taskClass: string,
    fn: () => Promise<{ value: string; usage: unknown }>,
    opts: unknown,
  ) => {
    h.invoked(feature, taskClass, opts);
    if (h.governorThrows) throw h.governorThrows;
    if (h.governorOutcome) return h.governorOutcome;
    const call = await fn();
    return { status: "ran", value: call.value, budget: "allowed", recorded: true, dark: false };
  },
}));
vi.mock("@/lib/ai/governor/attribution", () => ({
  hqBudgetOrgId: () => h.budgetOrg,
}));
vi.mock("@/lib/ai/text", () => ({
  getTextProvider: () => h.provider,
}));

import {
  maybeDecomposeWithAi,
  SAGA_DECOMPOSE_MAX_TOKENS,
} from "@/lib/hq/workflow/ai-decompose";
import { TIER_MODEL } from "@/lib/ai/governor/registry";

const VALID_PLAN_JSON = JSON.stringify({
  title: "Ship the reliability push",
  steps: [
    { title: "Scope it", department: "Research", role: "researcher", dependsOnOrdinal: null },
    { title: "Build it", department: "Engineering", role: "engineer", dependsOnOrdinal: 1 },
  ],
});

function providerReturning(text: string, over: { stopReason?: string | null; outputTokens?: number } = {}) {
  return {
    info: { provider: "anthropic" },
    generate: vi.fn().mockResolvedValue({
      text,
      model: "claude-opus-5",
      inputTokens: 100,
      outputTokens: over.outputTokens ?? 50,
      stopReason: over.stopReason ?? "end_turn",
    }),
  };
}

beforeEach(() => {
  h.tierActivated = true;
  h.budgetOrg = "org-hq";
  h.provider = providerReturning(VALID_PLAN_JSON);
  h.governorOutcome = null;
  h.governorThrows = null;
  h.invoked.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("each refusal stage names itself", () => {
  it("dark high tier → model_dark, before any attribution or provider work", async () => {
    h.tierActivated = false;
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "model_dark" });
    expect(h.invoked).not.toHaveBeenCalled();
  });

  it("no internal budget org → attribution_missing (the 2026-09-10 empty-env case)", async () => {
    h.budgetOrg = null;
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "attribution_missing" });
    expect(h.invoked).not.toHaveBeenCalled();
  });

  it("text door refuses → model_dark", async () => {
    h.provider = null;
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "model_dark" });
    expect(h.invoked).not.toHaveBeenCalled();
  });

  it("governor blocked (ceiling OR reservation store/stale-org FK refusal) → budget_refused", async () => {
    // The 2026-09-10 stale-org case surfaces as blocked/reservation_unavailable
    // with zero ledger rows — it must be nameable, not a blended null.
    h.governorOutcome = {
      status: "blocked",
      budget: "blocked",
      spentPence: 0,
      ceilingPence: 10_000,
      reason: "reservation_unavailable",
    };
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "budget_refused" });
  });

  it("governor duplicate → duplicate_suppressed", async () => {
    h.governorOutcome = { status: "duplicate", contentHash: "abc", reason: "recent_success" };
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "duplicate_suppressed" });
  });

  it("provider throw → provider_failure (governor already settled the claim)", async () => {
    h.governorThrows = new Error("529 overloaded");
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "provider_failure" });
  });

  it("empty provider text → provider_invalid_response", async () => {
    h.provider = providerReturning("   ");
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "provider_invalid_response" });
  });

  it("TRUNCATED output → provider_invalid_response, EVEN when the fragment parses (attempt-2 incident)", async () => {
    // 2026-09-10 attempt 2: output_tokens == max_tokens exactly; the plan was
    // cut mid-JSON. Worse: a truncated fragment that HAPPENS to parse must
    // also be refused — half a step graph must never persist as the plan.
    h.provider = providerReturning(VALID_PLAN_JSON, {
      stopReason: "max_tokens",
      outputTokens: SAGA_DECOMPOSE_MAX_TOKENS,
    });
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "provider_invalid_response" });
  });

  it("output at the cap WITHOUT a stop reason is still refused (belt for vendors that omit it)", async () => {
    h.provider = providerReturning(VALID_PLAN_JSON, {
      stopReason: null,
      outputTokens: SAGA_DECOMPOSE_MAX_TOKENS,
    });
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "provider_invalid_response" });
  });

  it("the output cap NEVER exceeds the high tier's reservation envelope", () => {
    // The governor's claim is sized by the ENVELOPE; a cap above it could
    // settle above the reservation. 3,200 is the armed high envelope.
    expect(SAGA_DECOMPOSE_MAX_TOKENS).toBeLessThanOrEqual(
      TIER_MODEL.high!.reserveOutputTokens,
    );
    // And it must be comfortably above the measured attempt-2 need (1,500 was
    // too small for a real Opus-5 plan).
    expect(SAGA_DECOMPOSE_MAX_TOKENS).toBeGreaterThanOrEqual(2_500);
  });

  it("non-JSON text → parse_failure", async () => {
    h.provider = providerReturning("I cannot produce a plan for that.");
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "parse_failure" });
  });

  it("valid JSON with an invalid graph → plan_validation_failure (validation NOT weakened)", async () => {
    h.provider = providerReturning(
      JSON.stringify({
        title: "Bad graph",
        steps: [{ title: "Self-dep", department: "QA", role: "qa", dependsOnOrdinal: 5 }],
      }),
    );
    const out = await maybeDecomposeWithAi({ directive: "Anything" });
    expect(out).toEqual({ plan: null, reason: "plan_validation_failure" });
  });
});

describe("the happy path and the fence fix", () => {
  it("bare JSON → plan", async () => {
    const out = await maybeDecomposeWithAi({ directive: "Ship it" });
    expect(out.reason).toBeNull();
    expect(out.plan?.steps).toHaveLength(2);
    expect(out.plan?.templateKey).toBe("");
  });

  it("MARKDOWN-FENCED JSON parses (the latent parse defect): ```json … ```", async () => {
    h.provider = providerReturning("```json\n" + VALID_PLAN_JSON + "\n```");
    const out = await maybeDecomposeWithAi({ directive: "Ship it" });
    expect(out.reason).toBeNull();
    expect(out.plan?.title).toBe("Ship the reliability push");
  });

  it("JSON with surrounding prose parses via brace-matching", async () => {
    h.provider = providerReturning("Here is the plan:\n" + VALID_PLAN_JSON + "\nLet me know.");
    const out = await maybeDecomposeWithAi({ directive: "Ship it" });
    expect(out.reason).toBeNull();
  });

  it("the governed call carries the registered feature, class and dedupe key", async () => {
    await maybeDecomposeWithAi({ directive: "Ship it" });
    expect(h.invoked).toHaveBeenCalledWith(
      "hq.saga_decomposition",
      "complex",
      expect.objectContaining({ orgId: "org-hq", userId: null, dedupeContent: "Ship it" }),
    );
  });
});
