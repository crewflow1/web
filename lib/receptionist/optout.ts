/**
 * WhatsApp STOP / opt-out keyword detection — PURE (no I/O, no clock, no RNG),
 * the same discipline as lib/receptionist/policy.ts, so the same message always
 * yields the same classification and a suppression decision is reconstructable
 * from named rules alone.
 *
 * CONTRACT (2026-09-13 activation-hardening wave, P2-7):
 *
 *   • OPT-OUT triggers on a WHOLE-MESSAGE match — the message, trimmed,
 *     punctuation-stripped and case-folded, must BE one of the keywords
 *     (STOP / UNSUBSCRIBE / OPT OUT), never merely contain one. "Please don't
 *     stop the job" is a customer sentence, not an opt-out.
 *   • RE-SUBSCRIBE is EXPLICIT ONLY: the same whole-message mechanism on
 *     START / UNSTOP. An ordinary follow-up message from an opted-out sender
 *     NEVER silently re-subscribes them — deliberately conservative: a sender
 *     who said STOP stays suppressed until they say START, even if they keep
 *     messaging. (An inbound message is still ingested and visible to the
 *     operator either way; suppression governs only AI drafting and outbound
 *     transport.)
 *   • Detection applies to TEXT messages only — a caption or media placeholder
 *     is not an opt-out instruction (the caller enforces the message_type
 *     gate; this module classifies text it is handed).
 */

/** Whole-message keywords that record an opt-out. Compared post-normalisation. */
export const OPT_OUT_KEYWORDS: readonly string[] = ["stop", "unsubscribe", "opt out"];

/** Whole-message keywords that remove an opt-out. Explicit re-subscribe only. */
export const OPT_IN_KEYWORDS: readonly string[] = ["start", "unstop"];

/**
 * Normalise one inbound message body for keyword comparison: case-fold, strip
 * punctuation (anything that is not a letter, digit or whitespace), collapse
 * whitespace, trim. "STOP!!" → "stop"; " Opt   out. " → "opt out".
 */
export function normaliseForKeywordMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type OptOutSignal = "opt_out" | "opt_in" | null;

/**
 * Classify one inbound TEXT message: an explicit opt-out, an explicit
 * re-subscribe, or neither. Whole-message match only (see the contract above).
 */
export function detectOptOutSignal(text: string | null | undefined): OptOutSignal {
  if (typeof text !== "string" || text.length === 0) return null;
  const normalised = normaliseForKeywordMatch(text);
  if (normalised.length === 0) return null;
  if (OPT_OUT_KEYWORDS.includes(normalised)) return "opt_out";
  if (OPT_IN_KEYWORDS.includes(normalised)) return "opt_in";
  return null;
}

/**
 * Normalise a sender identity (Meta wa_id, or an E.164 destination) to the
 * DIGITS-ONLY form the whatsapp_optouts ledger stores — Meta wa_ids carry no
 * '+', outbound destinations do, and the suppression check must agree with
 * itself across both. Empty/undigited input → null (no identity, no match).
 */
export function normaliseWaId(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  const digits = ref.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}
