import "server-only";

/**
 * Voice-note transcription — the OpenAI STT TRANSPORT (activation 2026-09-13).
 *
 * The vendor call behind `runBoundTranscription` (lib/ai/transcription.ts) for
 * the CEO-approved binding openai/gpt-4o-mini-transcribe. This file does NOT
 * decide whether to call a model — the seam has already checked the transport
 * binding + credential and `transcribeVoiceNoteGoverned` has already validated
 * the audio and entered the governor — so, like lib/ai/text/anthropic.ts, it is
 * TRANSPORT behind a gated door, not an inference entry point.
 *
 * RAW `fetch`, DELIBERATELY NO VENDOR SDK. The governance-closure ratchet
 * (__tests__/security/ai-governance-closure.test.ts) pins every SDK-construction
 * site by name and count; a multipart POST needs none of the SDK's surface, so
 * using `fetch` keeps the SDK allowlist untouched and this file auditable in one
 * screen. It IS a credential-read site (the ratchet's other sweep) — allowlisted
 * there by name, deliberately, as the ONE new credential read of the
 * transcription activation.
 *
 * CREDENTIAL DOCTRINE (2026-09-13): `TRANSCRIPTION_API_KEY` is an OPTIONAL
 * dedicated override — an independent kill switch for STT spend — and
 * `OPENAI_API_KEY` is the DEFAULT credential. Same vendor org; the deployed
 * restricted Model-capabilities key covers /v1/audio, so a second owner-created
 * key is not technically necessary and the CEO explicitly declined the key
 * ceremony. The override, when present, WINS — removing it falls back to the
 * shared key rather than going dark.
 */

// TYPE-ONLY imports from the seam, deliberately: they are erased at compile
// time, so this transport has NO runtime dependency back on the seam module
// (the seam imports THIS file — a runtime edge both ways would be a cycle).
import type {
  TranscriptionInput,
  TranscriptionModelBinding,
  TranscriptionResult,
  TranscriptionUsage,
} from "@/lib/ai/transcription";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/**
 * The worst-case metering fallback, in seconds — MUST equal the validator's
 * MAX_TRANSCRIPTION_AUDIO_SECONDS (lib/ai/transcription.ts). Stated locally
 * (rather than imported) to keep this module free of a runtime import cycle
 * with the seam; __tests__/ai/transcription-transport.test.ts pins the two
 * constants equal so they cannot drift.
 */
const WORST_CASE_AUDIO_SECONDS = 300;

/**
 * 60s — generous for a ≤300s note on a synchronous STT endpoint, and WELL under
 * the governor's 10-minute reservation TTL, so a hung call can never leave its
 * budget claim to lapse rather than settle.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/**
 * Hard clamp on the RETURNED transcript. 300s of speech is ~1,000 words; 20,000
 * chars is ~4× that — anything longer is a malfunctioning or hostile response,
 * not a voice note, and an unbounded string must not reach the note store.
 */
export const MAX_TRANSCRIPT_CHARS = 20_000;

/**
 * Resolve the STT credential: the dedicated override wins when present,
 * otherwise the already-deployed OpenAI key (see the doctrine above). Returns
 * null when neither is set — the seam defers before this transport is reached,
 * so a null here is defensive, not a control point.
 *
 * THE one new credential-read site of the transcription activation — pinned by
 * name in the governance-closure credential allowlist.
 */
export function resolveTranscriptionApiKey(): string | null {
  const dedicated = process.env.TRANSCRIPTION_API_KEY?.trim();
  if (dedicated) return dedicated;
  const shared = process.env.OPENAI_API_KEY?.trim();
  return shared && shared.length > 0 ? shared : null;
}

/**
 * Synthetic upload filename for a validated base MIME. The endpoint sniffs the
 * container but keys format handling on the extension, so the name must agree
 * with the bytes. The map covers exactly the validator's allowlist
 * (ALLOWED_AUDIO_MIME in lib/ai/transcription.ts) — an unlisted type cannot
 * reach this transport through the governed path, so the fallback is defensive.
 */
const MIME_EXTENSION: Readonly<Record<string, string>> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

export function transcriptionUploadFilename(mimeBase: string): string {
  return `voice-note.${MIME_EXTENSION[mimeBase] ?? "ogg"}`;
}

/**
 * Sanitise the vendor's transcript before it can reach a note body: strip
 * control characters (newlines and tabs survive — real dictation has line
 * breaks), trim, clamp. A transcript is UNTRUSTED USER SPEECH — data, never
 * instructions — the same posture lib/telephony/ai-turn.ts takes with caller
 * transcript lines; nothing downstream may treat it as anything but text.
 */
export function sanitiseTranscript(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * Map the endpoint's usage report to the governor's duration-as-tokens proxy.
 *
 * STT bills on AUDIO SECONDS; the ledger meters tokens. The transcription
 * binding prices ONE "token" as ONE second ($0.003/min = $0.00005/s ⇒
 * usdPerMTokIn 50 — see TIER_MODEL.transcription), so `inputTokens =
 * ceil(seconds)` and `outputTokens = 0`.
 *
 * NEVER UNDER-REPORT: when the response carries no usable `usage.seconds`, the
 * call is metered at the WORST CASE the validator admits
 * (WORST_CASE_AUDIO_SECONDS = MAX_TRANSCRIPTION_AUDIO_SECONDS). Over-metering an
 * odd response by a fraction of a penny is safe; a zero-cost settled call would
 * let a retry storm hide from the very ceiling that exists to stop one.
 */
export function usageSecondsToTokens(seconds: unknown): number {
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds);
  }
  return WORST_CASE_AUDIO_SECONDS;
}

/**
 * Conservative duration ESTIMATE from the audio bytes, in whole seconds —
 * the middle rung of the metering ladder (F2 follow-up, 2026-09-13).
 *
 * The first production self-test proved gpt-4o-mini-transcribe returns
 * TOKEN-type usage, not `{seconds}` — so the flat worst-case fallback metered
 * a 2-second clip as 300 "seconds" (2p instead of the 1p floor): safe, but a
 * ~150x distortion of per-call cost telemetry. This estimator replaces the
 * flat fallback while preserving the NEVER-UNDER-REPORT doctrine:
 *
 *   - WAV: exact — the RIFF header's byte-rate field (offset 28, LE u32)
 *     divides the payload precisely (the self-test's own format).
 *   - Everything else: bytes at a FLOOR bitrate of 12 kbps — at or below any
 *     plausible voice-note encoding (WhatsApp opus is 16-32 kbps), so the
 *     estimate is an UPPER bound on true duration. Over-estimating by up to
 *     ~2.7x on real opus is pennies-safe; under-estimating would let spend
 *     hide from the ceiling, so the floor is deliberately low, never typical.
 *
 * Vendor-reported `{seconds}` (whisper-class models, or a future shape
 * change) always wins over this estimate. Result is at least 1, uncapped —
 * the over-cap refusal upstream must see the honest magnitude.
 */
export function estimateAudioSeconds(mimeBase: string, bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 1;
  if ((mimeBase === "audio/wav" || mimeBase === "audio/x-wav") && bytes.byteLength > 44) {
    const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const wave = bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
    if (riff && wave) {
      const byteRate =
        (bytes[28]! | (bytes[29]! << 8) | (bytes[30]! << 16) | (bytes[31]! << 24)) >>> 0;
      if (byteRate > 0) return Math.max(1, Math.ceil((bytes.byteLength - 44) / byteRate));
    }
  }
  const FLOOR_BITS_PER_SECOND = 12_000;
  return Math.max(1, Math.ceil((bytes.byteLength * 8) / FLOOR_BITS_PER_SECOND));
}

/**
 * The bound-provider call: one multipart POST to /v1/audio/transcriptions.
 *
 * THROWS on any transport/vendor failure — status-coded, BODY-FREE messages
 * (an error body from an audio endpoint is unbounded and untrusted; the ledger
 * clamps error codes to 120 chars and gets a stable short string instead). The
 * seam converts a throw into `{ status: "failed" }`. An EMPTY transcript is a
 * legitimate `completed` result with "" — silence transcribes to nothing, and
 * the assistant layer already refuses to substitute for an empty transcript.
 */
/**
 * A transport error whose NAME is the stable code: the governor's ledger
 * derives `error_code` from `err.name || err.message` (errorCodeOf), so a bare
 * `new Error(code)` would settle every failure as the useless code "Error".
 */
function sttError(code: string): Error {
  return Object.assign(new Error(code), { name: code });
}

export async function runOpenAiTranscription(
  input: TranscriptionInput,
  binding: TranscriptionModelBinding,
): Promise<TranscriptionResult> {
  const apiKey = resolveTranscriptionApiKey();
  if (!apiKey) {
    // Defensive: the seam defers on a missing credential before dispatching.
    throw sttError("transcription_no_credential");
  }

  // The validated base MIME (parameters like `; codecs=opus` stripped) — the
  // governed path has already refused anything outside the allowlist.
  const mimeBase = (input.mimeType?.split(";")[0] ?? "").trim().toLowerCase();

  const form = new FormData();
  form.append(
    "file",
    new Blob([input.audio as BlobPart], { type: mimeBase || "application/octet-stream" }),
    transcriptionUploadFilename(mimeBase),
  );
  form.append("model", binding.model);
  form.append("response_format", "json");
  // WhatsApp voice notes from this estate are UK-English tradespeople; pinning
  // the language removes the detector's failure mode on short/noisy notes.
  form.append("language", "en");

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
  } catch (e) {
    // A timeout abort surfaces as a stable, ledger-friendly code; anything else
    // (DNS, TLS, socket) keeps a short network marker — never a body dump.
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw sttError("timeout");
    }
    throw sttError("transcription_network_error");
  }

  if (!res.ok) {
    // Status only — deliberately no response body (unbounded, untrusted).
    throw sttError(`transcription_http_${res.status}`);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw sttError("transcription_bad_response");
  }
  const body = (parsed ?? {}) as { text?: unknown; usage?: { seconds?: unknown } | null };

  const transcript = sanitiseTranscript(typeof body.text === "string" ? body.text : "");
  // Metering ladder: vendor-reported seconds > conservative byte estimate.
  // (gpt-4o-*-transcribe returns token-type usage — proven on the first prod
  // self-test — so the estimate is the working rung today; a vendor `seconds`
  // field, if it ever appears, is authoritative.)
  const vendorSeconds = body.usage?.seconds;
  const vendorAuthoritative =
    typeof vendorSeconds === "number" && Number.isFinite(vendorSeconds) && vendorSeconds > 0;
  const meteredSeconds = vendorAuthoritative
    ? Math.ceil(vendorSeconds as number)
    : estimateAudioSeconds((input.mimeType ?? "").split(";")[0]!.trim().toLowerCase(), input.audio);
  const usage: TranscriptionUsage = {
    provider: binding.provider,
    model: binding.model,
    inputTokens: meteredSeconds,
    outputTokens: 0,
    // P1-3: name the rung so the seam can distinguish "the vendor PROVED this
    // duration" (over-cap refusal may fire) from "our deliberate over-estimate"
    // (metering only — never grounds to refuse a paid transcript).
    secondsSource: vendorAuthoritative ? "vendor" : "estimate",
  };

  return {
    status: "completed",
    transcript,
    provider: binding.provider,
    model: binding.model,
    usage,
  };
}
