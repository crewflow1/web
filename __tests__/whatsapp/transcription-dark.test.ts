import { describe, it, expect, afterEach, vi } from "vitest";
import {
  transcribeVoiceNote,
  isTranscriptionActivated,
  isTranscriptionModelBound,
  isTranscriptionCredentialPresent,
  TRANSCRIPTION_MODEL,
} from "@/lib/ai/transcription";

/**
 * The voice-note transcription seam is GOVERNOR-DARK. The load-bearing property:
 * with no STT model bound (the state on every deploy today), it returns a
 * `deferred` result with transcript=null and NEVER fabricates a transcript — even
 * with a credential present. `activated` can never be true without a build-time
 * binding.
 */

describe("transcription seam — dark, never fabricates", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ships with NO model bound (the activation switch is null)", () => {
    expect(TRANSCRIPTION_MODEL).toBeNull();
    expect(isTranscriptionModelBound()).toBe(false);
  });

  it("is NOT activated even when a credential is present (binding is the gate)", () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    expect(isTranscriptionCredentialPresent()).toBe(true);
    // No model bound ⇒ not activated. Configuration cannot manufacture the capability.
    expect(isTranscriptionActivated()).toBe(false);
  });

  it("transcribeVoiceNote DEFERS with a null transcript when dark", async () => {
    const r = await transcribeVoiceNote({
      orgId: "org-1",
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
    });
    expect(r.status).toBe("deferred");
    expect(r.transcript).toBeNull();
    if (r.status === "deferred") expect(r.reason).toBe("no_model_bound");
  });

  it("never returns a fabricated (non-null) transcript on a dark build", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    const r = await transcribeVoiceNote({
      orgId: "org-1",
      audio: new Uint8Array([9, 9, 9]),
      mimeType: "audio/ogg; codecs=opus",
    });
    expect(r.transcript).toBeNull();
    expect(r.status).not.toBe("completed");
  });
});
