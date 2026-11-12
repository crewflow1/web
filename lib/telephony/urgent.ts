/**
 * Urgent-call detection (Twilio receptionist PR 6) — a PURE, conservative
 * heuristic over the caller's transcribed words that decides whether a call
 * should be TRANSFERRED to a human immediately rather than handled by the AI.
 *
 * Deliberately pure + keyword-based (no model call): it runs on the caller's
 * `SpeechResult` in the gather loop and must be deterministic + testable, and it
 * only ever triggers a transfer to the org's OWN configured escalation number, so
 * a false positive is safe (a human answers) and a false negative is safe (the AI
 * continues). AI-model-driven urgency classification is a later enhancement; this
 * is the safe v1 the directive's "urgent-call escalation" needs.
 */

/**
 * Trade-emergency vocabulary. Kept tight + unambiguous so a routine enquiry
 * ("my boiler needs a service") does NOT transfer, but a genuine emergency
 * ("gas leak", "flooding", "no heat and I have a newborn") does. Matched as
 * whole words / phrases, case-insensitively.
 */
const URGENT_PATTERNS: readonly RegExp[] = [
  /\bemergenc(?:y|ies)\b/,
  /\burgent(?:ly)?\b/,
  /\bgas\s*leak\b/,
  /\bsmell(?:ing)?\s+gas\b/,
  /\bcarbon\s*monoxide\b/,
  /\bflood(?:ing|ed)?\b/,
  /\bburst\s+(?:pipe|main)\b/,
  /\bleak(?:ing)?\s+(?:everywhere|badly|through the ceiling)\b/,
  /\bwater\s+(?:pouring|everywhere|coming through)\b/,
  /\bno\s+(?:heat|heating|hot water)\b/,
  /\belectric(?:al)?\s+(?:fire|sparks|burning)\b/,
  /\bburning\s+smell\b/,
  /\bsparking\b/,
  /\bfire\b/,
  /\bdanger(?:ous)?\b/,
  /\bright\s+now\b/,
  /\bas soon as possible\b/,
  /\basap\b/,
  /\bcan'?t wait\b/,
];

/**
 * True when the transcript shows a genuine emergency / urgent intent. Empty or
 * trivial input → false. Normalises whitespace + case before matching.
 */
export function isUrgentTranscript(transcript: string | null | undefined): boolean {
  const text = (transcript ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (text.length < 3) return false;
  return URGENT_PATTERNS.some((re) => re.test(text));
}
