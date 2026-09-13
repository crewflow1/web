import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The /admin/ai-costs transcription SELF-TEST action — the provider-proof path
 * for the STT tier (armed 2026-09-13). Pinned properties:
 *
 *   • GATED like every ai-costs action: non-super-admins bounce to /dashboard
 *     before anything runs (defence-in-depth over the /admin layout 404).
 *   • HONEST: it runs the REAL transcribeVoiceNoteGoverned and renders that
 *     outcome verbatim — a dark/keyless tier's `deferred` refusal is shown,
 *     never a simulated green, and there is no side door past any gate.
 *   • NO KEY EXPOSURE: the redirect carries status/latency/model/transcript
 *     of our own synthetic audio — never credential material.
 *   • AUDITED: every run records `transcription.selftest`.
 *   • The synthetic WAV is a REAL, validator-passing, nonce-varied clip.
 */

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireUserMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  requireUser: () => requireUserMock(),
}));

const isSuperAdminEmailMock = vi.fn();
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: (e: string | null) => isSuperAdminEmailMock(e),
}));

const recordAdminActivityMock = vi.fn(async (_a: unknown) => {});
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: (a: unknown) => recordAdminActivityMock(a),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));

const transcribeMock = vi.fn();
vi.mock("@/lib/ai/transcription", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/transcription")>();
  return { ...actual, transcribeVoiceNoteGoverned: (input: unknown) => transcribeMock(input) };
});

import { runTranscriptionSelftestAction } from "@/app/admin/ai-costs/actions";
import { buildSelftestWav, SELFTEST_WAV_SECONDS } from "@/lib/ai/transcription/selftest";

const SUPER = { id: "user-hq-1", email: "hello@crewflow.uk" };

async function runAction(): Promise<string> {
  try {
    await runTranscriptionSelftestAction();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("REDIRECT:")) return msg.slice("REDIRECT:".length);
    throw e;
  }
  throw new Error("action returned without redirecting");
}

beforeEach(() => {
  redirectMock.mockClear();
  requireUserMock.mockReset();
  isSuperAdminEmailMock.mockReset();
  recordAdminActivityMock.mockClear();
  transcribeMock.mockReset();
  requireUserMock.mockResolvedValue(SUPER);
  isSuperAdminEmailMock.mockReturnValue(true);
  vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", "00000000-0000-0000-0000-0000000000hq");
});
afterEach(() => vi.unstubAllEnvs());

describe("gating — super-admin only, before any work", () => {
  it("a non-super-admin bounces to /dashboard; nothing runs, nothing is audited", async () => {
    isSuperAdminEmailMock.mockReturnValue(false);
    const url = await runAction();
    expect(url).toBe("/dashboard");
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("no HQ budget org ⇒ honest refusal, no governed call (fail-closed attribution)", async () => {
    vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", "");
    const url = await runAction();
    expect(url).toContain("st_status=refused");
    expect(url).toContain("CREWFLOW_INTERNAL_ORG_ID");
    expect(transcribeMock).not.toHaveBeenCalled();
  });
});

describe("honesty — the production outcome is rendered verbatim", () => {
  it("a dark/keyless tier's DEFERRED refusal is shown as deferred — never a simulated green", async () => {
    transcribeMock.mockResolvedValue({
      status: "deferred",
      transcript: null,
      reason: "no_credential",
    });
    const url = await runAction();
    expect(url).toContain("/admin/ai-costs?");
    expect(url).toContain("st_status=deferred");
    expect(url).toContain("st_reason=no_credential");
    expect(url).not.toContain("completed");
    // Audited, with the honest status.
    expect(recordAdminActivityMock).toHaveBeenCalledTimes(1);
    const audit = recordAdminActivityMock.mock.calls[0]![0] as {
      action: string;
      metadata: { status: string };
    };
    expect(audit.action).toBe("transcription.selftest");
    expect(audit.metadata.status).toBe("deferred");
  });

  it("a completed run reports status, latency, model — and marks a recovered result", async () => {
    transcribeMock.mockResolvedValue({
      status: "completed",
      transcript: "",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      recovered: true,
    });
    const url = await runAction();
    expect(url).toContain("st_status=completed");
    expect(url).toMatch(/st_ms=\d+/);
    expect(url).toContain(encodeURIComponent("openai/gpt-4o-mini-transcribe"));
    expect(url).toContain("st_recovered=1");
  });

  it("a failed run carries its clamped reason", async () => {
    transcribeMock.mockResolvedValue({
      status: "failed",
      transcript: null,
      error: "transcription_http_429",
    });
    const url = await runAction();
    expect(url).toContain("st_status=failed");
    expect(url).toContain("st_reason=transcription_http_429");
  });

  it("NEVER exposes credential material in the redirect", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-super-secret-openai");
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-super-secret-dedicated");
    transcribeMock.mockResolvedValue({
      status: "completed",
      transcript: "tone",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
    });
    const url = await runAction();
    expect(url).not.toContain("sk-super-secret");
    expect(url).not.toContain("API_KEY");
  });
});

describe("the synthetic audio — real bytes through the REAL governed seam", () => {
  it("passes the governed function a valid, declared-duration WAV (no gate bypass)", async () => {
    transcribeMock.mockResolvedValue({
      status: "deferred",
      transcript: null,
      reason: "no_credential",
    });
    await runAction();
    const input = transcribeMock.mock.calls[0]![0] as {
      orgId: string;
      userId: string | null;
      audio: Uint8Array;
      mimeType: string;
      durationSeconds: number;
    };
    expect(input.orgId).toBe("00000000-0000-0000-0000-0000000000hq");
    // HQ spend runs unattributed to an employee, like all HQ-billed AI.
    expect(input.userId).toBeNull();
    expect(input.mimeType).toBe("audio/wav");
    expect(input.durationSeconds).toBe(SELFTEST_WAV_SECONDS);
    // A genuine RIFF/WAVE container of the expected size (44B header + PCM).
    const bytes = input.audio;
    expect(bytes.byteLength).toBe(44 + 8_000 * SELFTEST_WAV_SECONDS * 2);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
  });

  it("the WAV passes the REAL validator (the same one production audio faces)", async () => {
    const { validateVoiceNoteAudio } = await vi.importActual<
      typeof import("@/lib/ai/transcription")
    >("@/lib/ai/transcription");
    const v = validateVoiceNoteAudio({
      audio: buildSelftestWav(42),
      mimeType: "audio/wav",
      durationSeconds: SELFTEST_WAV_SECONDS,
    });
    expect(v).toEqual({ ok: true, mimeBase: "audio/wav" });
  });

  it("nonce-varies the bytes so the dedupe hash never collides across runs", () => {
    const a = buildSelftestWav(1);
    const b = buildSelftestWav(2);
    expect(a.byteLength).toBe(b.byteLength);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
