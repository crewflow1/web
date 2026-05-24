/**
 * Phase 5 — AI safety contract.
 *
 * The CEO directive's Step 1 explicitly names these guarantees:
 *
 *   - read-only by default
 *   - clearly labelled
 *   - confidence scored
 *   - source-linked where possible
 *   - never allowed to change invoices/quotes/jobs automatically
 *   - never allowed to send emails automatically without approval
 *   - never allowed to delete data
 *
 * This module encodes those guarantees as types + assertions that the
 * AI surfaces import. Tests pin every invariant.
 *
 * No Supabase, no server-only — importable everywhere.
 */

export type AiConfidence = "high" | "medium" | "low";

export const AI_CONFIDENCE_DESCRIPTIONS: Record<AiConfidence, string> = {
  high: "Directly derived from your own data.",
  medium: "Interpreted from your data — review before acting.",
  low: "Limited signal — treat as a hint, not a recommendation.",
};

/**
 * Stable shape every AI response carries. The dashboard/UI relies on
 * the `confidence` + `sources` fields being present.
 */
export type AiResponse = {
  /** The model's text answer. Plain prose; no markdown. */
  answer: string;
  /** How much CrewFlow trusts the answer. */
  confidence: AiConfidence;
  /** What part of the org's data the answer was built from. */
  sources: ReadonlyArray<AiSource>;
  /** Whether this response came from an LLM or a deterministic
   *  fallback. The UI labels deterministic answers differently. */
  generated_by: "anthropic" | "openai" | "deterministic";
};

/** A pointer back to the org's data that informed the answer. */
export type AiSource = {
  /** Human-readable label, e.g. "Invoices (last 30 days)". */
  label: string;
  /** Optional deep-link the operator can click to verify. */
  href?: string;
};

/**
 * Top-level statement of what AI is NOT allowed to do. The list is
 * referenced by the safety badge on every AI surface so operators
 * (and reviewers) see the rule, not just trust it implicitly.
 *
 * Adding an item here is a deliberate broadening of the contract;
 * always pair with a test in __tests__/ai/phase5.test.ts.
 */
export const AI_FORBIDDEN_ACTIONS: ReadonlyArray<string> = [
  "Create or modify invoices, quotes, or jobs without explicit operator approval.",
  "Send emails on behalf of the operator without explicit approval.",
  "Delete any record.",
  "Change customer-visible data (status, totals, contact details).",
  "Persist changes to billing or payment records.",
  "Impersonate users.",
];

/**
 * Build the disclosure copy the AI surfaces render under every
 * answer. Keeps the wording consistent across the question box,
 * insights page, and migration assistant.
 */
export function aiDisclosure(): string {
  return [
    "AI insights are read-only — they never change your records, send messages, or move money.",
    "Treat them as a second pair of eyes. Confidence is reported alongside every answer.",
  ].join(" ");
}

/**
 * Defensive guard for AI response shapes coming from the LLM. The
 * caller passes the raw object the model returned; we validate the
 * required fields and clamp confidence to the allowed enum. Returns
 * `null` if the response is malformed — caller falls back to the
 * deterministic answer.
 */
export function validateAiResponse(raw: unknown): AiResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AiResponse>;
  if (typeof r.answer !== "string" || r.answer.length === 0) return null;
  const confidence: AiConfidence =
    r.confidence === "high" || r.confidence === "medium" || r.confidence === "low"
      ? r.confidence
      : "medium";
  const sources = Array.isArray(r.sources)
    ? r.sources.filter(
        (s): s is AiSource =>
          !!s && typeof (s as AiSource).label === "string",
      )
    : [];
  const generated_by: AiResponse["generated_by"] =
    r.generated_by === "anthropic" ||
    r.generated_by === "openai" ||
    r.generated_by === "deterministic"
      ? r.generated_by
      : "deterministic";
  return { answer: r.answer.trim(), confidence, sources, generated_by };
}

/**
 * Returns true when at least one provider key is present. Used by the
 * fallback path — when this is false, every AI surface still works
 * but renders deterministic content + a "AI not configured" badge.
 */
export function isAiConfigured(): boolean {
  return (
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY)
  );
}
