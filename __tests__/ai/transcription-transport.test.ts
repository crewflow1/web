import { describe, it, expect, afterEach, vi } from "vitest";
import {
  estimateAudioSeconds,
  resolveTranscriptionApiKey,
  runOpenAiTranscription,
  sanitiseTranscript,
  transcriptionUploadFilename,
  usageSecondsToTokens,
  MAX_TRANSCRIPT_CHARS,
  TRANSCRIPTION_TIMEOUT_MS,
} from "@/lib/ai/transcription/openai";
import { MAX_TRANSCRIPTION_AUDIO_SECONDS } from "@/lib/ai/transcription";

/**
 * The OpenAI STT TRANSPORT (activation 2026-09-13) — unit proof over a mocked
 * `fetch`. This file pins the vendor-facing contract: the multipart request
 * shape, the duration-as-tokens usage mapping (never under-reported), the
 * body-free error taxonomy, and the sanitisation of the returned transcript
 * (untrusted user speech — data, never instructions).
 */

const BINDING = { provider: "openai", model: "gpt-4o-mini-transcribe" };
const audio = new Uint8Array([1, 2, 3, 4, 5, 6]);

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("estimateAudioSeconds — the F2 metering ladder's middle rung", () => {
  function wavBytes(seconds: number, byteRate = 16_000): Uint8Array {
    const data = new Uint8Array(44 + seconds * byteRate);
    data.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    data.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    new DataView(data.buffer).setUint32(28, byteRate, true);
    return data;
  }

  it("WAV: exact from the RIFF byte-rate header (the self-test's own format)", () => {
    expect(estimateAudioSeconds("audio/wav", wavBytes(2))).toBe(2);
    expect(estimateAudioSeconds("audio/x-wav", wavBytes(7))).toBe(7);
  });

  it("opus/ogg: 12kbps floor gives an UPPER bound — a real 16-32kbps note over-estimates, never under", () => {
    // 60s of 16kbps opus = 120,000 bytes → floor estimate ceil(80s) ≥ real 60s.
    const bytes = new Uint8Array(120_000);
    expect(estimateAudioSeconds("audio/ogg", bytes)).toBe(80);
  });

  it("the 2026-09-13 incident shape: a 2s WAV no longer meters as 300", () => {
    // First prod self-test: token-type vendor usage → flat 300 fallback →
    // 2p instead of the 1p floor. The estimator makes it honest.
    expect(estimateAudioSeconds("audio/wav", wavBytes(2))).toBeLessThan(10);
  });

  it("floors at 1 and survives garbage headers", () => {
    expect(estimateAudioSeconds("audio/wav", new Uint8Array(0))).toBe(1);
    expect(estimateAudioSeconds("audio/wav", new Uint8Array(50))).toBe(1);
    expect(estimateAudioSeconds("audio/mpeg", new Uint8Array(10))).toBe(1);
  });
});

describe("credential resolution — the 2026-09-13 doctrine, in one place", () => {
  it("the dedicated override WINS when present", () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "sk-dedicated");
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    expect(resolveTranscriptionApiKey()).toBe("sk-dedicated");
  });

  it("falls back to the deployed OPENAI_API_KEY (the default credential)", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    expect(resolveTranscriptionApiKey()).toBe("sk-shared");
  });

  it("whitespace-only values are ABSENT — a blank override must not mask the default", () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "   ");
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    expect(resolveTranscriptionApiKey()).toBe("sk-shared");
    vi.stubEnv("OPENAI_API_KEY", "   ");
    expect(resolveTranscriptionApiKey()).toBeNull();
  });

  it("null when neither key is set (the keyless deploy is dark)", () => {
    expect(process.env.TRANSCRIPTION_API_KEY ?? "").toBe("");
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");
    expect(resolveTranscriptionApiKey()).toBeNull();
  });
});

describe("the multipart request — exactly what the endpoint needs, nothing else", () => {
  it("POSTs model / response_format json / language en, with the key ONLY in the Authorization header", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ text: "hi", usage: { seconds: 1 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg; codecs=opus" }, BINDING);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-shared");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("en");
    const file = form.get("file") as File;
    // Synthetic filename by extension, MIME parameters stripped from the type.
    expect(file.name).toBe("voice-note.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(file.size).toBe(audio.byteLength);
  });

  it("passes WAV through with the matching extension (the self-test's format)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ text: "", usage: { seconds: 2 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/wav" }, BINDING);

    const form = (fetchMock.mock.calls[0]![1] as RequestInit).body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("voice-note.wav");
    expect(file.type).toBe("audio/wav");
  });

  it("filename map covers the validator's allowlist", () => {
    expect(transcriptionUploadFilename("audio/ogg")).toBe("voice-note.ogg");
    expect(transcriptionUploadFilename("audio/opus")).toBe("voice-note.opus");
    expect(transcriptionUploadFilename("audio/mpeg")).toBe("voice-note.mp3");
    expect(transcriptionUploadFilename("audio/mp3")).toBe("voice-note.mp3");
    expect(transcriptionUploadFilename("audio/mp4")).toBe("voice-note.m4a");
    expect(transcriptionUploadFilename("audio/aac")).toBe("voice-note.aac");
    expect(transcriptionUploadFilename("audio/amr")).toBe("voice-note.amr");
    expect(transcriptionUploadFilename("audio/wav")).toBe("voice-note.wav");
    expect(transcriptionUploadFilename("audio/x-wav")).toBe("voice-note.wav");
    expect(transcriptionUploadFilename("audio/webm")).toBe("voice-note.webm");
  });

  it("the timeout is 60s — well under the governor's 10-minute reservation TTL", () => {
    expect(TRANSCRIPTION_TIMEOUT_MS).toBe(60_000);
    expect(TRANSCRIPTION_TIMEOUT_MS).toBeLessThan(10 * 60 * 1000);
  });
});

describe("response handling — completed, metered, sanitised", () => {
  it("maps usage seconds to inputTokens = ceil(seconds), outputTokens = 0", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ text: "done", usage: { seconds: 7.01 } })));
    const r = await runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING);
    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      expect(r.usage).toEqual({
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        inputTokens: 8,
        outputTokens: 0,
        // P1-3: vendor-reported seconds are AUTHORITATIVE — the shape says so,
        // and only this source may drive the over-cap refusal upstream.
        secondsSource: "vendor",
      });
    }
  });

  it("ABSENT/invalid usage NEVER under-reports — invalid seconds fall to the cap; an absent report meters the byte estimate", async () => {
    expect(usageSecondsToTokens(undefined)).toBe(MAX_TRANSCRIPTION_AUDIO_SECONDS);
    expect(usageSecondsToTokens(null)).toBe(MAX_TRANSCRIPTION_AUDIO_SECONDS);
    expect(usageSecondsToTokens(0)).toBe(MAX_TRANSCRIPTION_AUDIO_SECONDS);
    expect(usageSecondsToTokens(-5)).toBe(MAX_TRANSCRIPTION_AUDIO_SECONDS);
    expect(usageSecondsToTokens(Number.NaN)).toBe(MAX_TRANSCRIPTION_AUDIO_SECONDS);
    expect(usageSecondsToTokens("3")).toBe(MAX_TRANSCRIPTION_AUDIO_SECONDS);
    expect(usageSecondsToTokens(3)).toBe(3);
    expect(usageSecondsToTokens(3.0001)).toBe(4);

    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ text: "no usage here" })));
    const r = await runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING);
    if (r.status === "completed") {
      // F2 ladder (2026-09-13): absent vendor usage now meters the
      // CONSERVATIVE BYTE ESTIMATE (12kbps floor ⇒ an upper bound on true
      // duration), not the flat 300 worst case that distorted telemetry
      // ~150x on the first prod self-test. Still never under-reports.
      expect(r.usage?.inputTokens).toBe(
        Math.max(1, Math.ceil((audio.byteLength * 8) / 12_000)),
      );
      // ...and the shape NAMES it an estimate (P1-3): metering only — it can
      // never drive the over-cap refusal of a transcript the org paid for.
      expect(r.usage?.secondsSource).toBe("estimate");
    } else {
      throw new Error("expected completed");
    }
  });

  it("sanitises the transcript: control chars stripped, trimmed, clamped to 20,000", async () => {
    expect(sanitiseTranscript("  a\u0000b\u0007c\u001bd  ")).toBe("abcd");
    // Newlines and tabs survive — real dictation has line breaks.
    expect(sanitiseTranscript("line one\nline\ttwo")).toBe("line one\nline\ttwo");
    expect(sanitiseTranscript("x".repeat(30_000))).toHaveLength(MAX_TRANSCRIPT_CHARS);

    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ text: "  y".repeat(15_000), usage: { seconds: 2 } })),
    );
    const r = await runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING);
    if (r.status !== "completed") throw new Error("expected completed");
    expect(r.transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
  });

  it("an empty transcript is completed with '' — silence is a result, not an error", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ text: "", usage: { seconds: 2 } })));
    const r = await runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING);
    expect(r.status).toBe("completed");
    if (r.status === "completed") expect(r.transcript).toBe("");
  });
});

describe("failure taxonomy — status-coded, body-free, timeout-bounded", () => {
  it("non-2xx throws `transcription_http_<status>` and NEVER includes the body", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-laden vendor error body", { status: 400 })),
    );
    await expect(
      runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING),
    ).rejects.toThrow(/^transcription_http_400$/);
  });

  it("a timeout abort surfaces as the stable code 'timeout'", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    const timeoutErr = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(timeoutErr)));
    await expect(
      runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING),
    ).rejects.toThrow(/^timeout$/);
  });

  it("a network failure surfaces as a short marker, never the raw error chain", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNRESET deep stack"))));
    await expect(
      runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING),
    ).rejects.toThrow(/^transcription_network_error$/);
  });

  it("an unparseable 2xx body throws `transcription_bad_response`", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(
      runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING),
    ).rejects.toThrow(/^transcription_bad_response$/);
  });

  it("keyless dispatch throws (defensive — the seam defers before this point)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      runOpenAiTranscription({ orgId: "o1", audio, mimeType: "audio/ogg" }, BINDING),
    ).rejects.toThrow(/transcription_no_credential/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
