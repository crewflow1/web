import "server-only";

/**
 * Voice Telephony (Wave 8) — the AI spoken-turn seam, GOVERNED and DARK.
 *
 * When an inbound voice call is answered, this is where the AI receptionist's
 * spoken reply WOULD be generated. It is dark today and returns `null`, so the
 * webhook plays its deterministic acknowledgement TwiML — a caller hears the
 * fixed greeting, exactly as today.
 *
 * THE GATE IS ACTIVATION, NOT A KEY — the governance-closure idiom
 * (server/services/receptionist.ts `extractFields`). This is deliberately NOT a
 * credential check (`isAiConfigured()` has zero callers and the closure ratchet
 * pins it there): a vendor key with no bound cost tier must change nothing. So:
 *
 *   1. gate on the EXISTING generative tier activation (`isInferenceTierActivated`
 *      — the `drafting` tier's modality). Dark ⇒ return null before any work.
 *   2. reach the model ONLY through the shared text door (`getTextProvider`),
 *      which itself refuses without a bound tier — this file constructs no SDK
 *      and reads no vendor credential, so the closure ratchet's pinned counts
 *      are untouched.
 *   3. wrap the provider leg in `invokeWithGovernor` under the registered
 *      `receptionist.voice_turn` feature (`drafting`), so the £100/org ceiling,
 *      the recent-duplicate refusal and the invocation ledger are already in the
 *      path on activation day. A `blocked`/`duplicate` outcome degrades to null.
 *
 * NO NEW GOVERNOR TIER: `receptionist.voice_turn` is a FEATURE key mapping to the
 * existing `drafting` task class → `mid` tier. It registers no tier that maps to
 * no model (which the governance-closure ratchet forbids).
 */

import { getTextProvider } from "@/lib/ai/text";
import { invokeWithGovernor } from "@/lib/ai/governor";
import { isInferenceTierActivated } from "@/lib/ai/governor/readiness";

export type VoiceTurnInput = {
  orgId: string;
  /** The caller's latest utterance (transcribed by the provider), if any. */
  transcript: string;
  /** Optional prior context for the turn. */
  context?: string | null;
};

/**
 * Generate the AI receptionist's next spoken turn, or `null` when the seam is
 * dark, blocked, deduplicated, or the provider failed. Never throws — a voice
 * call must always be able to fall back to the deterministic TwiML.
 */
export async function maybeGenerateVoiceTurn(input: VoiceTurnInput): Promise<string | null> {
  // 1. DARK SHORT-CIRCUIT — the generative modality must be armed. A key alone
  //    does not satisfy this; nothing below runs until a tier is bound.
  if (!isInferenceTierActivated()) return null;
  if (!input.transcript.trim()) return null;

  // 2. The model is reachable ONLY through the shared door, which refuses
  //    without a bound tier. Null ⇒ dark ⇒ deterministic fallback.
  const provider = getTextProvider();
  if (!provider) return null;

  try {
    // 3. GOVERNED. The registry classes this as `drafting`; the governor owns
    //    the ceiling, the ledger and the duplicate refusal.
    const outcome = await invokeWithGovernor(
      "receptionist.voice_turn",
      "drafting",
      async () => {
        const res = await provider.generate(input.transcript, {
          system: [
            "You are CrewFlow Receptionist, answering a phone call for a UK construction firm.",
            "Reply in ONE or TWO short spoken sentences — plain speech, no markdown, no lists.",
            "Be warm and concise. Never promise prices, never book or schedule work.",
            input.context ? `Context: ${input.context}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          maxTokens: 200,
        });
        return {
          value: res.text.trim() || null,
          usage: {
            provider: provider.info.provider,
            model: res.model,
            inputTokens: res.inputTokens,
            outputTokens: res.outputTokens,
          },
        };
      },
      { orgId: input.orgId, userId: null, dedupeContent: input.transcript },
    );
    if (outcome.status === "ran") return outcome.value;
  } catch (e) {
    console.error("[telephony] voice turn generation failed", e);
  }
  // blocked / duplicate / provider error → deterministic fallback.
  return null;
}
