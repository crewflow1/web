import "server-only";

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
 * WHY IT IS NOT ROUTED THROUGH invokeWithGovernor TODAY.
 * The governor's ledger (`ai_invocations.task_class` CHECK) admits only the
 * registered generative + embedding classes. Transcription is a new modality;
 * admitting it to the ledger CHECK is a migration that belongs to the ACTIVATION
 * diff (alongside binding a real STT model and calibrating its reservation
 * envelope), not to this dark seam. Until then there is nothing to meter: the
 * binding is null, so no provider call, no cost, no ledger row — the same
 * "wiring the dark seam changed nothing" property the governor itself relies on.
 * When a model is bound, the activator wires the real vendor call through
 * `invokeWithGovernor` with a newly-registered `voice_note.transcription`
 * feature. This module constructs NO vendor SDK and reads NO generative
 * credential, so it is not an ungoverned inference entry point.
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
};

export type TranscriptionResult =
  /** A real provider returned a transcript. Only reachable once a model is bound. */
  | { status: "completed"; transcript: string; provider: string; model: string }
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
      `is implemented — wire the vendor call (through invokeWithGovernor) in the activation diff. ` +
      `Refusing to fabricate a transcript.`,
  );
}
