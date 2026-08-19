import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GOVERNED VOICE-NOTE TRANSCRIPTION — the STT seam under the cost governor.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The completed path (migration 20261191 + registry): WhatsApp voice-note audio
 * is safety-validated, then transcription is metered through invokeWithGovernor
 * under the `voice_note.transcription` feature (task class `transcription`). It
 * is DARK today (no STT model bound), and these tests pin the load-bearing
 * properties of the dark path:
 *
 *   • It DEFERS with a null transcript and NEVER fabricates.
 *   • While dark, it reaches NO provider and issues NO reservation RPC — wiring
 *     the governor into the dark seam changed nothing observable.
 *   • The governor is the authority: the new task class flows through it, a
 *     mismatched class is refused, and a deterministic class is refused.
 *   • Audio is validated (empty / oversized / non-audio) before any spend.
 */

// A COUNTING admin mock: "no reservation RPC while dark" is a measurement, not a
// claim. If the governor ever reached the reservation path this count would rise.
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

import {
  transcribeVoiceNoteGoverned,
  validateVoiceNoteAudio,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  isTranscriptionActivated,
} from "@/lib/ai/transcription";
import { invokeWithGovernor } from "@/lib/ai/governor";
import {
  AI_TASK_CLASSES,
  AI_TIERS,
  TASK_CLASS_TIER,
  TIER_MODEL,
  featureDefinition,
  resolveModel,
  tierFor,
} from "@/lib/ai/governor/registry";

const ORG = "00000000-0000-0000-0000-0000000000f1";
const audio = new Uint8Array([1, 2, 3, 4, 5]);

afterEach(() => {
  adminConstructions.count = 0;
  vi.unstubAllEnvs();
});

describe("registry wiring — transcription is its own modality, dark", () => {
  it("admits 'transcription' as a billable task class and a separate tier", () => {
    expect(AI_TASK_CLASSES).toContain("transcription");
    expect(AI_TIERS).toContain("transcription");
    expect(TASK_CLASS_TIER.transcription).toBe("transcription");
    // Dark: the tier maps to no model, so the governor short-circuits.
    expect(TIER_MODEL.transcription).toBeNull();
    expect(resolveModel("transcription")).toBeNull();
    // Not the deterministic refusal — it DOES route to a (dark) tier.
    expect(tierFor("transcription")).toBe("transcription");
  });

  it("registers the voice_note.transcription feature against that class", () => {
    const def = featureDefinition("voice_note.transcription");
    expect(def).not.toBeNull();
    expect(def!.taskClass).toBe("transcription");
    expect(def!.degradesTo.length).toBeGreaterThan(20);
  });
});

describe("transcribeVoiceNoteGoverned — dark, never fabricates, never spends", () => {
  it("is dark on every deploy today (no STT model bound)", () => {
    // Even with a credential present, no binding ⇒ not activated.
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    expect(isTranscriptionActivated()).toBe(false);
  });

  it("DEFERS with a null transcript and reaches no provider / no reservation", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r.status).toBe("deferred");
    expect(r.transcript).toBeNull();
    // Dark ⇒ the governor is never entered, so NO reservation RPC is issued.
    expect(adminConstructions.count).toBe(0);
  });

  it("NEVER returns a fabricated (non-null) transcript while dark", async () => {
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/ogg; codecs=opus" });
    expect(r.transcript).toBeNull();
    expect(r.status).not.toBe("completed");
  });
});

describe("safe validation — rejects before any spend decision", () => {
  it("accepts a supported voice-note MIME (base type, params stripped)", () => {
    expect(validateVoiceNoteAudio({ audio, mimeType: "audio/ogg; codecs=opus" })).toEqual({
      ok: true,
      mimeBase: "audio/ogg",
    });
  });

  it("refuses empty audio", () => {
    expect(validateVoiceNoteAudio({ audio: new Uint8Array(0), mimeType: "audio/ogg" })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("refuses oversized audio", () => {
    const huge = { byteLength: MAX_TRANSCRIPTION_AUDIO_BYTES + 1 } as unknown as Uint8Array;
    expect(validateVoiceNoteAudio({ audio: huge, mimeType: "audio/ogg" })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("refuses a non-audio / unknown MIME (a hostile media id cannot reach a provider)", () => {
    expect(validateVoiceNoteAudio({ audio, mimeType: "application/x-msdownload" }).ok).toBe(false);
    expect(validateVoiceNoteAudio({ audio, mimeType: null }).ok).toBe(false);
  });

  it("the governed wrapper reports a FAILED (never fabricated) result on invalid audio", async () => {
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio: new Uint8Array(0), mimeType: "audio/ogg" });
    expect(r.status).toBe("failed");
    expect(r.transcript).toBeNull();
    expect(adminConstructions.count).toBe(0);
  });
});

describe("the governor is the AUTHORITY over the new task class", () => {
  it("runs the transcription feature through the dark short-circuit (no spend, no ledger)", async () => {
    const fn = vi.fn(async () => ({
      value: { status: "completed" as const, transcript: "SHOULD NOT BE PRODUCED", provider: "x", model: "y" },
      usage: { provider: "x", model: "y", inputTokens: 10, outputTokens: 0 },
    }));
    const outcome = await invokeWithGovernor("voice_note.transcription", "transcription", fn, { orgId: ORG });
    // Dark tier ⇒ the caller's fn runs, but nothing is reserved or recorded.
    expect(outcome.status).toBe("ran");
    if (outcome.status === "ran") {
      expect(outcome.dark).toBe(true);
      expect(outcome.recorded).toBe(false);
    }
    expect(adminConstructions.count).toBe(0);
  });

  it("REFUSES a task class that disagrees with the registry (no self-promotion)", async () => {
    await expect(
      invokeWithGovernor(
        "voice_note.transcription",
        // The registry says `transcription`; a caller cannot declare `drafting`
        // to reach the generative text tier.
        "drafting" as never,
        async () => ({ value: null, usage: null }),
        { orgId: ORG },
      ),
    ).rejects.toThrow(/registered as "transcription"/);
  });

  it("REFUSES a deterministic invocation of the feature loudly", async () => {
    await expect(
      invokeWithGovernor(
        "voice_note.transcription",
        "deterministic" as never,
        async () => ({ value: null, usage: null }),
        { orgId: ORG },
      ),
    ).rejects.toThrow();
  });
});
