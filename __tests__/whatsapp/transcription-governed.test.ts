import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GOVERNED VOICE-NOTE TRANSCRIPTION — the STT seam under the cost governor.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * RE-ANCHORED for the 2026-09-13 activation (openai/gpt-4o-mini-transcribe,
 * transport + cost binding in one reviewed diff). The load-bearing properties:
 *
 *   • KEYLESS ⇒ DEFERRED, before the governor: a bound build with no usable
 *     credential defers with a null transcript, reaches NO provider, issues NO
 *     reservation RPC, and NEVER fabricates.
 *   • ARMED + KEY ⇒ the REAL governed path: reservation → provider (mocked
 *     fetch here) → settlement, with usage metered as ceil(audio seconds).
 *   • Audio is validated (empty / oversized / too-long / non-audio) BEFORE any
 *     spend decision, key or no key.
 *   • The governor stays the authority over the task class.
 */

// A STATEFUL admin mock: counts constructions (so "no reservation while
// keyless" stays a measurement) and, for the armed path, services the
// persist-first ledger read and the reservation/settlement RPCs.
const adminState = vi.hoisted(() => ({
  constructions: 0,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** Rows returned by the whatsapp_inbound_media persist-first/duplicate read. */
  mediaRows: [] as Array<{ transcript: string | null }>,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminState.constructions += 1;
    return {
      from: () => ({
        insert: async () => ({ error: null }),
        select: () => {
          const chain = {
            eq: () => chain,
            limit: async () => ({ data: adminState.mediaRows, error: null }),
          };
          return chain;
        },
      }),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        adminState.rpcCalls.push({ fn, args });
        if (fn === "ai_reserve_invocation") {
          return {
            data: [
              {
                outcome: "reserved",
                reservation_id: "res-selftest-1",
                committed_pence: 0,
                reserved_pence: 2,
                ceiling_pence: 10_000,
              },
            ],
            error: null,
          };
        }
        if (fn === "ai_settle_reservation") {
          return { data: [{ outcome: "settled" }], error: null };
        }
        return { data: [], error: null };
      },
    };
  },
}));

import {
  transcribeVoiceNoteGoverned,
  validateVoiceNoteAudio,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  isTranscriptionActivated,
  TRANSCRIPTION_MODEL,
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
  adminState.constructions = 0;
  adminState.rpcCalls = [];
  adminState.mediaRows = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("registry wiring — transcription is its own modality, ARMED 2026-09-13", () => {
  it("admits 'transcription' as a billable task class and a separate tier", () => {
    expect(AI_TASK_CLASSES).toContain("transcription");
    expect(AI_TIERS).toContain("transcription");
    expect(TASK_CLASS_TIER.transcription).toBe("transcription");
    // Armed: the tier maps to the CEO-approved model, in ONE reviewed diff
    // with the transport binding (they must never drift apart).
    expect(TIER_MODEL.transcription?.model).toBe("gpt-4o-mini-transcribe");
    expect(resolveModel("transcription")?.model).toBe("gpt-4o-mini-transcribe");
    expect(TRANSCRIPTION_MODEL).toEqual({ provider: "openai", model: "gpt-4o-mini-transcribe" });
    expect(tierFor("transcription")).toBe("transcription");
  });

  it("registers the voice_note.transcription feature against that class", () => {
    const def = featureDefinition("voice_note.transcription");
    expect(def).not.toBeNull();
    expect(def!.taskClass).toBe("transcription");
    expect(def!.degradesTo.length).toBeGreaterThan(20);
  });
});

describe("transcribeVoiceNoteGoverned — KEYLESS ⇒ deferred, never fabricates, never spends", () => {
  it("is dark on a keyless deploy (binding alone is not activation)", () => {
    expect(process.env.TRANSCRIPTION_API_KEY ?? "").toBe("");
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");
    expect(isTranscriptionActivated()).toBe(false);
  });

  it("DEFERS with a null transcript and reaches no provider / no reservation", async () => {
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r.status).toBe("deferred");
    expect(r.transcript).toBeNull();
    if (r.status === "deferred") expect(r.reason).toBe("no_credential");
    // Keyless ⇒ the governor is never entered — NO database contact at all
    // (not even the persist-first read, which sits behind the activation gate).
    expect(adminState.constructions).toBe(0);
  });

  it("NEVER returns a fabricated (non-null) transcript while keyless", async () => {
    const r = await transcribeVoiceNoteGoverned({
      orgId: ORG,
      audio,
      mimeType: "audio/ogg; codecs=opus",
    });
    expect(r.transcript).toBeNull();
    expect(r.status).not.toBe("completed");
  });
});

describe("transcribeVoiceNoteGoverned — ARMED + KEY runs the REAL governed path", () => {
  const okResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("mocked provider 2xx ⇒ completed, sanitised transcript, usage = ceil(seconds)", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-dedicated-key");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ text: "  boiler fixed\u0007 on site  ", usage: { seconds: 3.2 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const r = await transcribeVoiceNoteGoverned({
      orgId: ORG,
      audio,
      mimeType: "audio/ogg; codecs=opus",
    });

    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      // Control chars stripped, trimmed — untrusted speech is data, never markup.
      expect(r.transcript).toBe("boiler fixed on site");
      expect(r.provider).toBe("openai");
      expect(r.model).toBe("gpt-4o-mini-transcribe");
      // Duration-as-tokens: ceil(3.2s) = 4 "tokens", output side zero.
      expect(r.usage).toEqual({
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        inputTokens: 4,
        outputTokens: 0,
      });
      expect(r.recovered).toBeUndefined();
    }
    // The FULL governed lifecycle ran: atomic reservation, then settlement.
    expect(adminState.rpcCalls.map((c) => c.fn)).toEqual([
      "ai_reserve_invocation",
      "ai_settle_reservation",
    ]);
    // And the key never leaks anywhere but the Authorization header.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-dedicated-key",
    );
  });

  it("OVER-CAP audio (review F1): real usage is settled ONCE, the transcript is REFUSED", async () => {
    // A 10MB low-bitrate opus can be ~5,000+ REAL seconds — the byte cap is
    // the only pre-spend proxy, so the vendor may bill far beyond the 300s
    // product cap. The REAL seconds must be settled (never clamped, never
    // floored via a throw) but the transcript must fail: a note the validator
    // would have refused (had duration been declared) never persists.
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({ text: "a very long hostile transcript", usage: { seconds: 5200 } }),
      ),
    );

    const r = await transcribeVoiceNoteGoverned({
      orgId: ORG,
      audio,
      mimeType: "audio/ogg",
    });

    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.transcript).toBeNull();
      expect(r.error).toBe("transcription_over_duration_cap");
    }
    // The full governed lifecycle still ran — the vendor billed those seconds,
    // so they are settled exactly once at their REAL magnitude.
    expect(adminState.rpcCalls.map((c) => c.fn)).toEqual([
      "ai_reserve_invocation",
      "ai_settle_reservation",
    ]);
    const settle = adminState.rpcCalls.find((c) => c.fn === "ai_settle_reservation");
    // 5,200 'tokens' × $50/MTok × 0.8 × 100 = 20.8 → 21p — the honest overrun,
    // recorded (and alarmed via overrun_count), never hidden at a 1p floor.
    expect((settle?.args as Record<string, unknown>).p_cost_pence).toBe(21);
  });

  it("also arms on OPENAI_API_KEY alone — the default-credential doctrine", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ text: "ok", usage: { seconds: 1 } })),
    );
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r.status).toBe("completed");
    if (r.status === "completed") expect(r.usage?.inputTokens).toBe(1);
  });

  it("PERSIST-FIRST: a transcript the org already paid for is returned RECOVERED, with no reservation", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    adminState.mediaRows = [{ transcript: "customer confirmed Tuesday" }];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/ogg" });

    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      expect(r.transcript).toBe("customer confirmed Tuesday");
      expect(r.recovered).toBe(true);
      // Nothing new was metered — no usage on a recovered result.
      expect(r.usage).toBeUndefined();
    }
    // No provider call, no reservation, no settlement — zero re-pay.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adminState.rpcCalls).toEqual([]);
  });

  it("vendor 4xx/5xx ⇒ failed with a clamped, body-free reason (and the failure is SETTLED)", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("an enormous vendor error body that must never surface", { status: 429 }),
      ),
    );

    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/ogg" });

    expect(r.status).toBe("failed");
    expect(r.transcript).toBeNull();
    if (r.status === "failed") {
      expect(r.error).toBe("transcription_http_429");
      expect(r.error.length).toBeLessThanOrEqual(120);
      expect(r.error).not.toContain("enormous vendor error body");
    }
    // A failure that reached the provider is settled, never left in flight.
    expect(adminState.rpcCalls.map((c) => c.fn)).toEqual([
      "ai_reserve_invocation",
      "ai_settle_reservation",
    ]);
  });

  it("an EMPTY transcript is a legitimate completed result — never substituted", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ text: "", usage: { seconds: 2 } })),
    );
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/wav" });
    expect(r.status).toBe("completed");
    if (r.status === "completed") expect(r.transcript).toBe("");
  });

  it("ABSENT usage NEVER under-reports: metered at the conservative byte estimate (F2 ladder)", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ text: "hello" })));
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      // 12kbps-floor estimate: an UPPER bound on true duration (never under),
      // honest instead of the flat 300 that inflated telemetry ~150x.
      const expected = Math.max(1, Math.ceil((audio.byteLength * 8) / 12_000));
      expect(r.usage?.inputTokens).toBe(expected);
      expect(expected).toBeLessThan(MAX_TRANSCRIPTION_AUDIO_SECONDS);
    }
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

  it("pins the caps: 10 MB bytes (the duration proxy) and 300 s duration", () => {
    // The byte cap is deliberately TIGHTER than the 25 MB media-storage cap: a
    // voice note is minutes of opus, not hours, and with no declared duration
    // the byte cap IS the duration proxy backing the seconds constant — which
    // the ARMED reservation envelope (TIER_MODEL.transcription) is sized to.
    expect(MAX_TRANSCRIPTION_AUDIO_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_TRANSCRIPTION_AUDIO_SECONDS).toBe(300);
  });

  it("refuses a DECLARED over-long duration as too_long", () => {
    expect(
      validateVoiceNoteAudio({
        audio,
        mimeType: "audio/ogg",
        durationSeconds: MAX_TRANSCRIPTION_AUDIO_SECONDS + 1,
      }),
    ).toEqual({ ok: false, reason: "too_long" });
    // At the cap exactly, still fine.
    expect(
      validateVoiceNoteAudio({
        audio,
        mimeType: "audio/ogg",
        durationSeconds: MAX_TRANSCRIPTION_AUDIO_SECONDS,
      }).ok,
    ).toBe(true);
    // Unknown duration ⇒ the byte cap stands in as the proxy; no refusal.
    expect(validateVoiceNoteAudio({ audio, mimeType: "audio/ogg", durationSeconds: null }).ok).toBe(true);
  });

  it("refuses a non-audio / unknown MIME (a hostile media id cannot reach a provider)", () => {
    expect(validateVoiceNoteAudio({ audio, mimeType: "application/x-msdownload" }).ok).toBe(false);
    expect(validateVoiceNoteAudio({ audio, mimeType: null }).ok).toBe(false);
  });

  it("the governed wrapper reports a FAILED (never fabricated) result on invalid audio — even ARMED with a key", async () => {
    // Validation precedes the spend decision on every path: with the tier
    // armed and a key present, bad bytes still never reach a provider.
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio: new Uint8Array(0), mimeType: "audio/ogg" });
    expect(r.status).toBe("failed");
    expect(r.transcript).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adminState.constructions).toBe(0);
  });

  it("refuses too-large audio BEFORE any spend decision (no reservation, no provider)", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    const huge = { byteLength: MAX_TRANSCRIPTION_AUDIO_BYTES + 1 } as unknown as Uint8Array;
    const r = await transcribeVoiceNoteGoverned({ orgId: ORG, audio: huge, mimeType: "audio/ogg" });
    expect(r.status).toBe("failed");
    expect(r.transcript).toBeNull();
    if (r.status === "failed") expect(r.error).toBe("audio_too_large");
    expect(adminState.constructions).toBe(0);
  });

  it("refuses a declared over-long note BEFORE any spend decision", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-present");
    const r = await transcribeVoiceNoteGoverned({
      orgId: ORG,
      audio,
      mimeType: "audio/ogg",
      durationSeconds: MAX_TRANSCRIPTION_AUDIO_SECONDS + 60,
    });
    expect(r.status).toBe("failed");
    expect(r.transcript).toBeNull();
    if (r.status === "failed") expect(r.error).toBe("audio_too_long");
    expect(adminState.constructions).toBe(0);
  });
});

describe("the governor is the AUTHORITY over the task class", () => {
  it("keyless: the transcription feature short-circuits dark (no spend, no ledger)", async () => {
    expect(process.env.TRANSCRIPTION_API_KEY ?? "").toBe("");
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");
    const fn = vi.fn(async () => ({
      value: { status: "completed" as const, transcript: "SHOULD NOT BE PRODUCED", provider: "x", model: "y" },
      usage: { provider: "x", model: "y", inputTokens: 10, outputTokens: 0 },
    }));
    const outcome = await invokeWithGovernor("voice_note.transcription", "transcription", fn, { orgId: ORG });
    expect(outcome.status).toBe("ran");
    if (outcome.status === "ran") {
      expect(outcome.dark).toBe(true);
      expect(outcome.recorded).toBe(false);
    }
    expect(adminState.constructions).toBe(0);
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
