import "server-only";
import { createHash } from "node:crypto";
import { invokeWithGovernor, isTierActivated, type GovernedCall } from "@/lib/ai/governor";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VOICE-NOTE TRANSCRIPTION — a GOVERNOR-DARK seam.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WhatsApp voice notes arrive as `audio` with `voice: true`. Turning that audio
 * into text is an AI capability — a SEPARATE MODALITY from the text/vision
 * inference the cost governor's generative tiers cover, and from embeddings. It
 * is built here DARK, ahead of any provider, in the exact shape the governor's
 * readiness doctrine mandates (lib/ai/governor/readiness.ts):
 *
 *   modelBindingPresent — a real STT model is bound.        (build-time fact)
 *   credentialsPresent  — the vendor secret is set.         (configuration)
 *   activated           — a transcription CAN reach a provider.
 *
 * THE LOAD-BEARING RULE, inherited verbatim from the comms + AI incidents:
 * `activated` can NEVER be true without `modelBindingPresent`. No amount of
 * environment configuration can manufacture a capability this build does not
 * contain. TRANSCRIPTION_MODEL below is deliberately `null` — so today, on every
 * deploy, `isTranscriptionActivated()` is false and `transcribeVoiceNote()`
 * returns `{ status: "deferred", transcript: null }` WITHOUT touching a network.
 *
 * IT NEVER FABRICATES. A dark build does not guess, summarise, or invent a
 * transcript — it returns null and says why. A caller stores null; the operator
 * still sees the voice note, its media bytes, and the deterministic placeholder
 * summary the ingestion core already produced. That is the honest degraded path.
 *
 * GOVERNOR WIRING — ALREADY IN PLACE (migration 20261191000000).
 * The governor's ledger (`ai_invocations.task_class` CHECK) ALREADY admits the
 * `transcription` class: migration 20261191 widened the CHECK and the registry
 * carries the `voice_note.transcription` feature (task class `transcription`,
 * its own tier). `transcribeVoiceNoteGoverned` below routes through
 * `invokeWithGovernor` today — while dark that is a no-op short-circuit (the
 * tier's TIER_MODEL binding is null, so no reservation, no ledger row, no
 * spend), preserving the "wiring the dark seam changed nothing" property. The
 * ACTIVATION diff's remaining work is binding a real STT model (here and in
 * TIER_MODEL.transcription), implementing the vendor transport, and calibrating
 * the reservation envelope against MAX_TRANSCRIPTION_AUDIO_SECONDS. This module
 * constructs NO vendor SDK and reads NO generative credential, so it is not an
 * ungoverned inference entry point.
 */

/**
 * A concrete STT provider+model binding — THE activation switch, deliberately
 * `null`. A non-null value here is a build-time fact that this deploy contains a
 * real transcription capability; it is paired with the vendor credential
 * (TRANSCRIPTION_API_KEY) before a call can happen. Populating this is the
 * single code change that arms transcription — and it is not sufficient alone.
 *
 * Deliberately NOT read from an environment variable: which model transcribes
 * every tenant's voice notes is a cost + quality decision that belongs in a
 * reviewed diff, exactly like the governor's TIER_MODEL.
 */
export type TranscriptionModelBinding = {
  /** Vendor id, lowercase. */
  provider: string;
  /** Model id as the vendor names it. */
  model: string;
};

export const TRANSCRIPTION_MODEL: TranscriptionModelBinding | null = null;

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

/** True when a real STT model is bound in THIS build. Configuration cannot fake it. */
export function isTranscriptionModelBound(): boolean {
  return TRANSCRIPTION_MODEL !== null;
}

/**
 * True when the vendor credential is present. Reads `process.env` DIRECTLY (like
 * lib/ai/governor/readiness.ts) rather than the frozen `env` object, so a
 * readiness probe reflects the live configuration and can never throw.
 */
export function isTranscriptionCredentialPresent(): boolean {
  return present(process.env.TRANSCRIPTION_API_KEY);
}

/**
 * THE headline: can a voice note actually reach a transcription provider? Both
 * gates must pass — a bound model AND a credential — mirroring
 * `isEmbeddingActivated()`. False on every deploy today (binding is null).
 */
export function isTranscriptionActivated(): boolean {
  return isTranscriptionModelBound() && isTranscriptionCredentialPresent();
}

export type TranscriptionInput = {
  /** Owning org — carried for future governed accounting; unused while dark. */
  orgId: string;
  /** The voice-note bytes. */
  audio: Uint8Array;
  /** Vendor MIME (e.g. `audio/ogg; codecs=opus`), when known. */
  mimeType: string | null;
  /**
   * DECLARED audio duration in seconds, when the caller knows it. Meta's
   * inbound descriptor declares none today, so this is usually absent — the
   * byte cap then stands in as the duration proxy (see
   * MAX_TRANSCRIPTION_AUDIO_SECONDS).
   */
  durationSeconds?: number | null;
};

/**
 * The metered usage a bound STT call reports, for the governor's ledger. STT is
 * billed on audio DURATION, so `outputTokens` is 0 and `inputTokens` carries the
 * worst-case audio-duration proxy the reservation envelope was calibrated
 * against. Absent while dark — no call, no usage.
 */
export type TranscriptionUsage = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type TranscriptionResult =
  /** A real provider returned a transcript. Only reachable once a model is bound. */
  | {
      status: "completed";
      transcript: string;
      provider: string;
      model: string;
      /** Metered usage for the governor's ledger; present only on a real bound call. */
      usage?: TranscriptionUsage;
    }
  /**
   * DARK: no model bound / no credential. transcript is null — NEVER fabricated.
   * The caller stores null and shows the deterministic placeholder instead.
   */
  | { status: "deferred"; transcript: null; reason: "no_model_bound" | "no_credential" }
  /** A bound provider was called and errored. transcript is null. */
  | { status: "failed"; transcript: null; error: string };

/**
 * Transcribe one voice note — or DEFER when transcription is dark.
 *
 * The dark short-circuit is the whole point: with no model bound (today, always)
 * this returns `deferred` with a null transcript before any I/O. It performs no
 * network call, constructs no client, and reads no generative credential. When a
 * model IS bound, the vendor call is delegated to `runBoundTranscription`, which
 * is a documented ACTIVATION seam — it must be implemented alongside the binding,
 * and until then throws rather than pretend. It never returns a made-up string.
 */
export async function transcribeVoiceNote(
  input: TranscriptionInput,
): Promise<TranscriptionResult> {
  if (!isTranscriptionModelBound()) {
    return { status: "deferred", transcript: null, reason: "no_model_bound" };
  }
  if (!isTranscriptionCredentialPresent()) {
    return { status: "deferred", transcript: null, reason: "no_credential" };
  }
  // ACTIVATION PATH (unreachable while TRANSCRIPTION_MODEL is null). The real
  // vendor call + `invokeWithGovernor` metering is wired here by the activation
  // diff. Failing loudly rather than fabricating keeps the "never a made-up
  // transcript" contract even against a half-finished activation.
  try {
    return await runBoundTranscription(input, TRANSCRIPTION_MODEL as TranscriptionModelBinding);
  } catch (e) {
    return { status: "failed", transcript: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The bound-provider transcription call. Intentionally unimplemented: it is the
 * ACTIVATION seam, wired when TRANSCRIPTION_MODEL is populated (with the vendor
 * transport + governor metering). It throws rather than return a fabricated
 * transcript, so a binding without an implementation fails safe and loud.
 */
async function runBoundTranscription(
  _input: TranscriptionInput,
  binding: TranscriptionModelBinding,
): Promise<TranscriptionResult> {
  throw new Error(
    `[transcription] model ${binding.provider}/${binding.model} is bound but no transport ` +
      `is implemented — implement the vendor call here (returning status:"completed" with a ` +
      `populated \`usage\`) in the activation diff. The governor wrapper ` +
      `(transcribeVoiceNoteGoverned) already meters it. Refusing to fabricate a transcript.`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SAFE VALIDATION — reject before any spend decision.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hard cap on the DURATION of audio accepted for transcription (5 minutes). STT
 * is billed per second of audio, so duration — not bytes — is the true spend
 * axis; this constant is the number the ACTIVATION diff calibrates the
 * governor's reservation envelope against.
 *
 * ENFORCEMENT TODAY IS BY PROXY. Meta's inbound media descriptor declares no
 * duration and we deliberately do NOT parse audio containers here (a parser is
 * attack surface and this validator must stay pure). So:
 *   • when a caller DOES know the duration it passes `durationSeconds` and an
 *     over-long note is refused as `too_long`, and
 *   • when it doesn't (today's WhatsApp path), the tightened
 *     MAX_TRANSCRIPTION_AUDIO_BYTES below IS the duration proxy.
 */
export const MAX_TRANSCRIPTION_AUDIO_SECONDS = 300;

/**
 * Hard cap on the audio BYTES accepted for transcription — deliberately 10 MB,
 * TIGHTER than the media pipeline's MAX_WHATSAPP_MEDIA_BYTES (25 MB). A
 * WhatsApp voice note is minutes of low-bitrate opus, not hours: 25 MB of opus
 * is 5+ hours of audio, which no legitimate voice note is. Because the inbound
 * descriptor declares no duration (and we refuse to ship a container parser in
 * a pure validator), this byte cap doubles as the DURATION PROXY backing
 * MAX_TRANSCRIPTION_AUDIO_SECONDS: it is the cheapest defence against a hostile
 * or malformed media id inflating an STT bill.
 */
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * The audio MIME types a voice note may carry, base type only (parameters like
 * `; codecs=opus` are stripped before the check). WhatsApp voice notes are
 * `audio/ogg` (opus); the rest cover the other inbound voice formats. An
 * unlisted type is refused rather than sent to a provider that would reject or
 * mis-handle it — a cost + correctness guard.
 */
const ALLOWED_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);

export type AudioValidation =
  | { ok: true; mimeBase: string }
  | { ok: false; reason: "empty" | "too_large" | "too_long" | "unsupported_mime" };

/**
 * Validate voice-note audio before it can reach the (governed) transcription
 * call. Pure and side-effect-free — no I/O, no throw — so it is trivially tested
 * and can gate the spend decision without itself being able to fail open.
 *
 * `durationSeconds` is a DECLARED duration when the caller knows one (today's
 * WhatsApp descriptor doesn't declare it; a future caller or the activation
 * diff's provider metadata may). A declared duration over
 * MAX_TRANSCRIPTION_AUDIO_SECONDS refuses as `too_long`; with no declared
 * duration the tightened byte cap is the documented duration proxy.
 */
export function validateVoiceNoteAudio(input: {
  audio: Uint8Array;
  mimeType: string | null;
  durationSeconds?: number | null;
}): AudioValidation {
  if (!input.audio || input.audio.byteLength === 0) return { ok: false, reason: "empty" };
  if (input.audio.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  if (
    typeof input.durationSeconds === "number" &&
    Number.isFinite(input.durationSeconds) &&
    input.durationSeconds > MAX_TRANSCRIPTION_AUDIO_SECONDS
  ) {
    return { ok: false, reason: "too_long" };
  }
  const base = (input.mimeType?.split(";")[0] ?? "").trim().toLowerCase();
  if (!base || !ALLOWED_AUDIO_MIME.has(base)) return { ok: false, reason: "unsupported_mime" };
  return { ok: true, mimeBase: base };
}

/**
 * A stable, PII-free dedupe key for one voice note: the SHA-256 of its exact
 * audio bytes. The governor hashes (feature, taskClass, this) into the ledger's
 * content_hash, so a webhook REDELIVERY of the identical voice note refuses as a
 * duplicate rather than paying to transcribe the same audio twice. The bytes
 * themselves never leave this function.
 */
function audioDedupeKey(audio: Uint8Array): string {
  return createHash("sha256").update(audio).digest("hex");
}

/**
 * GOVERNED transcription — the metered wrapper the assistant pipeline calls.
 *
 * This is the seam that COMPLETES the WhatsApp voice-note → note path under the
 * cost governor, and it is dark-safe by construction:
 *
 *   1. SAFE VALIDATION FIRST. Empty, oversized, or non-audio bytes are refused
 *      as `failed` before any spend decision — a malformed media id can never
 *      reach a provider or the ledger.
 *   2. DARK TRANSPORT ⇒ DEFER, no governor. With no STT model bound (today,
 *      always) `isTranscriptionActivated()` is false, so this returns the seam's
 *      `deferred` result WITHOUT entering the governor — no reads, no writes, no
 *      fabrication. Identical to the pre-governor behaviour while dark.
 *   3. FAIL-CLOSED ON A HALF-WIRED ACTIVATION. If the transport is armed
 *      (TRANSCRIPTION_MODEL + credential) but the governor's `transcription`
 *      COST binding (TIER_MODEL.transcription) is still dark, this REFUSES —
 *      deferring rather than making an ungoverned paid call with no ceiling and
 *      no ledger. This is the door's own-tier gate, mirroring the primary fix in
 *      lib/telephony/ai-turn.ts; the governor's backstop is the second line.
 *   4. GOVERNED. Only when BOTH the transport and the cost binding are armed does
 *      the real vendor call run — inside `invokeWithGovernor` under the
 *      registered `voice_note.transcription` feature (task class
 *      `transcription`), so the £100/org ceiling, the atomic reservation, the
 *      SHA-256 duplicate refusal and the invocation ledger are all in the path.
 *
 * NEVER FABRICATES and NEVER THROWS. Any non-`completed` outcome — deferred,
 * blocked, duplicate, a provider error — returns a null transcript so the caller
 * records the honest deterministic placeholder instead.
 */
export async function transcribeVoiceNoteGoverned(
  input: TranscriptionInput & { userId?: string | null },
): Promise<TranscriptionResult> {
  // 1. Safe validation — reject before any spend decision.
  const valid = validateVoiceNoteAudio({
    audio: input.audio,
    mimeType: input.mimeType,
    durationSeconds: input.durationSeconds,
  });
  if (!valid.ok) {
    return { status: "failed", transcript: null, error: `audio_${valid.reason}` };
  }

  // 2. DARK TRANSPORT ⇒ defer without touching the governor (no call, no cost).
  if (!isTranscriptionActivated()) {
    return transcribeVoiceNote(input);
  }

  // 3. Transport armed but the governor's cost binding dark ⇒ half-wired
  //    activation. Refuse rather than spend ungoverned. Fail closed.
  if (!isTierActivated("transcription")) {
    return { status: "deferred", transcript: null, reason: "no_model_bound" };
  }

  // 4. GOVERNED. The registry classes this as `transcription`; the governor owns
  //    the ceiling, the ledger and the duplicate refusal.
  try {
    const outcome = await invokeWithGovernor(
      "voice_note.transcription",
      "transcription",
      async (): Promise<GovernedCall<TranscriptionResult>> => {
        const result = await transcribeVoiceNote(input);
        // Only a COMPLETED call reached a provider ⇒ meter it. A deferred/failed
        // result took no provider call, so usage is null and the governor
        // releases the claim and records nothing.
        if (result.status === "completed" && result.usage) {
          return { value: result, usage: result.usage };
        }
        return { value: result, usage: null };
      },
      {
        orgId: input.orgId,
        userId: input.userId ?? null,
        dedupeContent: audioDedupeKey(input.audio),
      },
    );
    if (outcome.status === "ran") return outcome.value;
    // A governor DUPLICATE means this org ALREADY PAID to transcribe these exact
    // bytes (the dedupe key is the SHA-256 of the audio). A webhook redelivery
    // must not lose a transcript the org already paid for — re-read the
    // persisted transcript from the media ledger and return it. No provider
    // call, no new spend. Falls back to an honest defer when nothing persisted.
    if (outcome.status === "duplicate") {
      return resolveDuplicateTranscription(input);
    }
  } catch (e) {
    // The governor settles the failure + rethrows; degrade honestly, never fabricate.
    return { status: "failed", transcript: null, error: e instanceof Error ? e.message : String(e) };
  }
  // blocked ⇒ defer honestly (never a fabricated transcript).
  return { status: "deferred", transcript: null, reason: "no_model_bound" };
}

// ═══════════════════════════════════════════════════════════════════════════
// TRANSCRIPT PERSISTENCE — the media-ledger seam (whatsapp_inbound_media).
// ═══════════════════════════════════════════════════════════════════════════
//
// Migration 20261127000000 gave the inbound-media ledger `transcript` +
// `transcript_status` columns; the two helpers below are the ONLY writers and
// the duplicate-recovery reader. Both are service-role paths (the table has no
// tenant write policy) and both are UNREACHABLE in prod today — the WhatsApp
// transport is null, so no inbound media ever reaches them. Built dark.
//
// EVIDENCE DISCIPLINE: the UPDATE touches ONLY transcript/transcript_status.
// content_hash and storage_path are write-once, enforced for every role by
// tg_whatsapp_media_evidence_immutable — this code must never include them in a
// payload, and doesn't.

/** SHA-256 hex of the exact audio bytes — identical to the media ledger's `content_hash`. */
export function voiceNoteContentHash(audio: Uint8Array): string {
  return audioDedupeKey(audio);
}

/**
 * Persist one transcription outcome onto the org's media-ledger row for these
 * exact bytes (keyed org_id + content_hash — the pipeline stored the SHA-256 of
 * the same bytes). Rules:
 *
 *   • completed ⇒ { transcript, transcript_status: "completed" }
 *   • failed    ⇒ { transcript_status: "failed" }   (transcript untouched)
 *   • deferred  ⇒ { transcript_status: "deferred" } (transcript untouched)
 *   • NEVER DOWNGRADES: a row already holding a completed transcript is
 *     excluded from the UPDATE (`transcript_status <> 'completed'`), so a
 *     redelivery while dark can never erase a transcript the org paid for.
 *   • NEVER touches content_hash / storage_path (write-once evidence).
 *
 * Best-effort and never throws — the webhook must ack Meta regardless.
 * Returns true when the update statement succeeded (matching 0 rows is still
 * a success; the media row may legitimately not exist yet).
 */
export async function persistVoiceNoteTranscription(input: {
  orgId: string;
  audio: Uint8Array;
  result: TranscriptionResult;
}): Promise<boolean> {
  const payload: { transcript?: string; transcript_status: string } =
    input.result.status === "completed"
      ? { transcript: input.result.transcript, transcript_status: "completed" }
      : { transcript_status: input.result.status === "failed" ? "failed" : "deferred" };
  try {
    const admin = createAdminClient();
    const { error } = await (admin.from("whatsapp_inbound_media" as never) as unknown as {
      update: (p: unknown) => {
        eq: (k: string, v: string) => {
          eq: (k: string, v: string) => {
            neq: (k: string, v: string) => Promise<{ error: { message: string } | null }>;
          };
        };
      };
    })
      .update(payload)
      .eq("org_id", input.orgId)
      .eq("content_hash", voiceNoteContentHash(input.audio))
      .neq("transcript_status", "completed");
    if (error) {
      console.error("[transcription] transcript persist failed", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      "[transcription] transcript persist threw",
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/**
 * DUPLICATE RECOVERY — the governor refused to pay twice for these exact bytes,
 * so return the transcript the org already paid for, read back from the media
 * ledger (org_id + content_hash, completed rows only). When none is persisted
 * (e.g. the first attempt's persist failed) this defers honestly — it NEVER
 * fabricates and NEVER triggers a new provider call.
 *
 * Only reachable from the governed wrapper's ACTIVATED path (a duplicate
 * outcome requires a reservation attempt, which the dark short-circuit never
 * makes) — so it is dark-unreachable today, like everything downstream of
 * activation. Never throws.
 */
export async function resolveDuplicateTranscription(
  input: TranscriptionInput,
): Promise<TranscriptionResult> {
  try {
    const admin = createAdminClient();
    const { data, error } = await (admin.from("whatsapp_inbound_media" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: string) => {
          eq: (k: string, v: string) => {
            eq: (k: string, v: string) => {
              limit: (n: number) => Promise<{
                data: Array<{ transcript: string | null }> | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    })
      .select("transcript")
      .eq("org_id", input.orgId)
      .eq("content_hash", voiceNoteContentHash(input.audio))
      .eq("transcript_status", "completed")
      .limit(1);
    if (!error) {
      const transcript = data?.[0]?.transcript;
      if (typeof transcript === "string" && transcript.trim().length > 0) {
        // The ledger row doesn't record which provider produced it; label the
        // recovery with the live binding (non-null on any reachable path).
        const binding = TRANSCRIPTION_MODEL as TranscriptionModelBinding | null;
        return {
          status: "completed",
          transcript,
          provider: binding?.provider ?? "persisted",
          model: binding?.model ?? "persisted",
        };
      }
    } else {
      console.error("[transcription] duplicate re-read failed", error.message);
    }
  } catch (e) {
    console.error(
      "[transcription] duplicate re-read threw",
      e instanceof Error ? e.message : String(e),
    );
  }
  // Nothing persisted (or the read failed) ⇒ defer honestly, never fabricate.
  return { status: "deferred", transcript: null, reason: "no_model_bound" };
}
