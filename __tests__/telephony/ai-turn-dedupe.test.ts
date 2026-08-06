import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Voice AI turn — the PER-CALL dedupe key (C30, GAP 1).
 *
 * The governor refuses an identical (org, feature, content_hash) inside its 900s
 * window as a DUPLICATE, and it hashes the `dedupeContent` the seam passes. The
 * bug: the seam passed the RAW latest utterance, so two callers to one org — or
 * one caller repeating a short phrase — collided, the second turn returned null,
 * and the call dropped. The fix prefixes the call identity + turn ordinal
 * (`${callId} ${ordinal} ${transcript}`), mirroring receptionist-generation.ts.
 *
 * Hermetic: the tier readiness + text provider are stubbed present, and
 * `invokeWithGovernor` is replaced with a faithful in-memory model of its dedupe
 * — it refuses a `dedupeContent` it has already seen. No real provider, no DB.
 */

// The seam gates on its OWN tier (`mid`, the `drafting` class) via
// `isTierActivated` + a text provider before reaching the governor; stub both
// present so the governed path is exercised.
vi.mock("@/lib/ai/governor/readiness", () => ({
  isInferenceTierActivated: () => true,
  isTierActivated: () => true,
}));
vi.mock("@/lib/ai/text", () => ({
  getTextProvider: () => ({
    info: { provider: "test" },
    generate: async () => ({ text: "unused", model: "test", inputTokens: 0, outputTokens: 0 }),
  }),
}));

// A faithful stand-in for the governor's reservation dedupe: an identical
// `dedupeContent` (⇒ identical content_hash) within the window is a DUPLICATE.
// `seen` is hoisted so the (hoisted) vi.mock factory can safely close over it.
const { seen } = vi.hoisted(() => ({ seen: new Set<string>() }));
vi.mock("@/lib/ai/governor", () => ({
  isTierActivated: () => true,
  invokeWithGovernor: vi.fn(
    async (
      _feature: string,
      _taskClass: string,
      _fn: unknown,
      input: { dedupeContent?: string },
    ) => {
      const key = input.dedupeContent ?? "";
      if (seen.has(key)) return { status: "duplicate" as const };
      seen.add(key);
      return { status: "ran" as const, value: `reply:${key}` };
    },
  ),
}));

async function seam() {
  return (await import("@/lib/telephony/ai-turn")).maybeGenerateVoiceTurn;
}
async function governorMock() {
  return vi.mocked((await import("@/lib/ai/governor")).invokeWithGovernor);
}

describe("maybeGenerateVoiceTurn — per-call dedupe key", () => {
  beforeEach(() => seen.clear());
  afterEach(async () => (await governorMock()).mockClear());

  it("composes the key as `${callId} ${ordinal} ${transcript}`", async () => {
    const maybeGenerateVoiceTurn = await seam();
    await maybeGenerateVoiceTurn({ orgId: "org-1", transcript: "yes", callId: "call-A", ordinal: 2 });
    const call = (await governorMock()).mock.calls[0]!;
    expect(call[3]).toMatchObject({ orgId: "org-1", dedupeContent: "call-A 2 yes" });
  });

  it("two callers saying the same short phrase (different callIds) BOTH run", async () => {
    const maybeGenerateVoiceTurn = await seam();
    const a = await maybeGenerateVoiceTurn({ orgId: "org-1", transcript: "yes", callId: "call-A", ordinal: 0 });
    const b = await maybeGenerateVoiceTurn({ orgId: "org-1", transcript: "yes", callId: "call-B", ordinal: 0 });
    // Under the old transcript-only key these collided and `b` was null (dropped).
    expect(a).toBe("reply:call-A 0 yes");
    expect(b).toBe("reply:call-B 0 yes");
    expect(a).not.toBe(b);
  });

  it("the same caller repeating a phrase at a LATER turn (higher ordinal) runs", async () => {
    const maybeGenerateVoiceTurn = await seam();
    const t0 = await maybeGenerateVoiceTurn({ orgId: "org-1", transcript: "yes", callId: "call-A", ordinal: 0 });
    const t1 = await maybeGenerateVoiceTurn({ orgId: "org-1", transcript: "yes", callId: "call-A", ordinal: 1 });
    expect(t0).toBe("reply:call-A 0 yes");
    expect(t1).toBe("reply:call-A 1 yes");
  });

  it("a genuine REDELIVERY (same callId + ordinal + transcript) still dedupes to null", async () => {
    const maybeGenerateVoiceTurn = await seam();
    const first = await maybeGenerateVoiceTurn({ orgId: "org-1", transcript: "hello", callId: "call-A", ordinal: 0 });
    const redelivery = await maybeGenerateVoiceTurn({ orgId: "org-1", transcript: "hello", callId: "call-A", ordinal: 0 });
    expect(first).toBe("reply:call-A 0 hello");
    expect(redelivery).toBeNull(); // duplicate ⇒ deterministic fallback
  });
});
