import { describe, it, expect, afterEach, vi } from "vitest";
import {
  transcribeVoiceNote,
  isTranscriptionActivated,
  isTranscriptionModelBound,
  isTranscriptionCredentialPresent,
  TRANSCRIPTION_MODEL,
} from "@/lib/ai/transcription";

/**
 * The voice-note transcription seam — ARMED 2026-09-13 (CEO-approved:
 * openai/gpt-4o-mini-transcribe), re-anchored from the dark pins this file used
 * to hold. The load-bearing properties that SURVIVE the activation:
 *
 *   • The binding is a BUILD-TIME fact (this suite pins the exact ids), and
 *     `activated` still requires binding AND credential — a keyless deploy is
 *     dark and DEFERS with a null transcript. NEVER fabricates.
 *   • The credential is tier-aware per the 2026-09-13 doctrine: the dedicated
 *     TRANSCRIPTION_API_KEY override OR the deployed OPENAI_API_KEY default.
 */

describe("transcription seam — armed 2026-09-13, still fail-closed without a key", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ships with the CEO-approved model BOUND (the transport activation switch)", () => {
    expect(TRANSCRIPTION_MODEL).toEqual({ provider: "openai", model: "gpt-4o-mini-transcribe" });
    expect(isTranscriptionModelBound()).toBe(true);
  });

  it("credential doctrine: the dedicated override OR the OpenAI default arms it — neither ⇒ dark", () => {
    // The unit-test env carries no key: bound but NOT activated.
    expect(process.env.TRANSCRIPTION_API_KEY ?? "").toBe("");
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");
    expect(isTranscriptionCredentialPresent()).toBe(false);
    expect(isTranscriptionActivated()).toBe(false);

    // The dedicated override alone arms it (the independent kill switch)…
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-dedicated");
    expect(isTranscriptionCredentialPresent()).toBe(true);
    expect(isTranscriptionActivated()).toBe(true);
    vi.unstubAllEnvs();

    // …and so does the deployed OpenAI key alone (the default credential —
    // same vendor org; the CEO explicitly declined a second key's ceremony).
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    expect(isTranscriptionCredentialPresent()).toBe(true);
    expect(isTranscriptionActivated()).toBe(true);
  });

  it("transcribeVoiceNote DEFERS with a null transcript on a keyless deploy", async () => {
    const r = await transcribeVoiceNote({
      orgId: "org-1",
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
    });
    expect(r.status).toBe("deferred");
    expect(r.transcript).toBeNull();
    // The model IS bound now, so the honest keyless reason is the credential.
    if (r.status === "deferred") expect(r.reason).toBe("no_credential");
  });

  it("an ARMED direct call REFUSES ungoverned spend — the governed wrapper is the only door", async () => {
    // transcribeVoiceNote is exported but NEVER dispatches the transport: on a
    // fully-armed deploy a direct (ungoverned) call fails closed rather than
    // making a paid call outside the ceiling and the ledger. The only path to
    // a provider is transcribeVoiceNoteGoverned's fn inside invokeWithGovernor.
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await transcribeVoiceNote({
      orgId: "org-1",
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
    });
    expect(r.status).toBe("failed");
    expect(r.transcript).toBeNull();
    if (r.status === "failed") expect(r.error).toBe("ungoverned_transcription_refused");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never returns a fabricated (non-null) transcript without reaching a provider", async () => {
    // Keyless: no provider is reachable, and no transcript may be invented.
    const r = await transcribeVoiceNote({
      orgId: "org-1",
      audio: new Uint8Array([9, 9, 9]),
      mimeType: "audio/ogg; codecs=opus",
    });
    expect(r.transcript).toBeNull();
    expect(r.status).not.toBe("completed");
  });
});
