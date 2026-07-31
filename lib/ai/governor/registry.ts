/**
 * AI Cost Governor — the FEATURE REGISTRY and the TASK-CLASS ROUTING TABLE.
 *
 * Two closed sets and one mapping, expressed as DATA rather than as branches
 * scattered through call sites:
 *
 *   1. AI_FEATURES     — every capability allowed to spend money on inference.
 *   2. TASK_CLASS_TIER — what KIND of work each task class is, as an abstract
 *                        cost tier. No model names here.
 *   3. TIER_MODEL      — the ONE place a tier becomes a concrete provider+model.
 *
 * The split between (2) and (3) is the whole point. A call site says "this is
 * drafting"; it does not say "this is claude-haiku-4-5". Re-tiering every
 * drafting call — because a cheaper model got good enough, or an expensive one
 * got cheap — is then an edit to a single table, reviewable in isolation,
 * instead of a hunt through the codebase for hard-coded model strings. The
 * codebase already learned this lesson once: lib/ai/text/index.ts made vendor
 * selection configuration-only. This does the same for model TIER.
 *
 * EVERY TIER CURRENTLY MAPS TO `null`. Nothing generative is authorised, so no
 * tier resolves to a model and `invokeWithGovernor` short-circuits before it
 * reaches a provider. Activation is a deliberate edit HERE, paired with
 * credentials and CEO authorisation — see ./readiness.ts for why credentials
 * alone can never switch it on.
 *
 * Pure data + types. No `server-only`, no SDK, no I/O — importable by the edge
 * readiness probe, the HQ page, and the tests alike.
 */

// ---------------------------------------------------------------------------
// 1. Task classes — what kind of work is being asked for.
// ---------------------------------------------------------------------------

/**
 * The four kinds of work the governor recognises.
 *
 * `deterministic` is in this list ON PURPOSE even though it names work that
 * must never reach a model. Naming it is what lets a call site declare "this
 * is deterministic" and be REFUSED loudly, rather than having no vocabulary for
 * the claim and quietly sending a regex problem to an LLM. The refusal lives in
 * `invokeWithGovernor`; the database states the same rule structurally by
 * omitting 'deterministic' from the ledger's task_class CHECK.
 */
export const AI_TASK_CLASSES = [
  "deterministic",
  "classification",
  "drafting",
  "complex",
] as const;
export type AiTaskClass = (typeof AI_TASK_CLASSES)[number];

/** Abstract cost tiers. Names describe PRICE BAND, never a vendor or a model. */
export const AI_TIERS = ["cheap", "mid", "high"] as const;
export type AiTier = (typeof AI_TIERS)[number];

/**
 * Task class → cost tier. `null` means "no model is appropriate for this class,
 * ever" — the deterministic refusal, expressed as data.
 */
export const TASK_CLASS_TIER: Readonly<Record<AiTaskClass, AiTier | null>> = {
  // NO LLM. Keyword matching, regex, SQL, arithmetic. If the answer is
  // computable, computing it is cheaper, faster, and correct every time.
  deterministic: null,
  // Short, bounded, low-stakes judgement: is this urgent? which category?
  classification: "cheap",
  // Customer-facing prose that a human reviews before it goes anywhere.
  drafting: "mid",
  // Multi-step reasoning over substantial context.
  complex: "high",
};

// ---------------------------------------------------------------------------
// 2. The model binding — the ONE place a tier becomes a real model.
// ---------------------------------------------------------------------------

/** A concrete provider+model pair, in the vendor's own naming. */
export type AiModelBinding = {
  /** Vendor id, lowercase — matches lib/ai/text/types.ts `TextModelInfo`. */
  provider: string;
  /** Model id as the vendor names it. */
  model: string;
  /** Vendor price per 1,000,000 tokens, in USD, split input/output. */
  usdPerMTokIn: number;
  usdPerMTokOut: number;

  /**
   * THE RESERVATION ENVELOPE: the WORST-CASE token count one call on this model
   * may consume. Not the typical count — the largest one a single invocation
   * could plausibly reach with this model's context window and output cap.
   *
   * WHY IT LIVES ON THE BINDING AND IS REQUIRED.
   * The atomic ceiling reservation (supabase/migrations/20261070000000) claims
   * budget BEFORE the call, when the real token count is unknowable. It has to
   * claim SOMETHING, and the ceiling holds exactly only while the claim is at
   * least as large as the eventual cost. Putting these two numbers on the
   * binding as REQUIRED fields makes that impossible to forget: TypeScript
   * refuses an activation diff that binds a model without stating its
   * worst case. A separate lookup table would have been one more thing to
   * remember, and the failure mode of forgetting is silent over-spend.
   *
   * A caller may NOT shrink this. A per-call override would be a way for a call
   * site to under-reserve and slip past the gate, which is exactly the class of
   * self-promotion `taskClass` is already protected against.
   *
   * CALIBRATION IS A PRE-ACTIVATION STEP. Too small and committed spend can
   * pass the ceiling by the shortfall; too large and the org is refused while
   * real headroom remains. `ai_reservations_month_totals.overrun_count` counts
   * settled claims whose true cost exceeded the estimate — a non-zero figure
   * means these numbers are too small for the bound model.
   */
  reserveInputTokens: number;
  reserveOutputTokens: number;
};

/**
 * Tier → model. THE activation switch, and it is deliberately all `null`.
 *
 * A `null` binding means the tier reaches no provider, so `invokeWithGovernor`
 * runs the caller's existing degraded path and records nothing. Populating an
 * entry here is the single code change that arms a tier — and it is not
 * sufficient on its own: the vendor credential must also be present (see
 * ./readiness.ts). Both, plus CEO authorisation, or nothing happens.
 *
 * Deliberately NOT read from an environment variable. Which model a tier uses
 * changes cost and output quality for every tenant at once; that is a product
 * decision that belongs in a reviewed diff, not in a deploy dashboard where it
 * can be changed without a trace.
 */
export const TIER_MODEL: Readonly<Record<AiTier, AiModelBinding | null>> = {
  cheap: null,
  mid: null,
  high: null,
};

/** The concrete model for a task class, or `null` when the tier is dark or the class reaches no model. */
export function resolveModel(taskClass: AiTaskClass): AiModelBinding | null {
  const tier = TASK_CLASS_TIER[taskClass];
  return tier === null ? null : TIER_MODEL[tier];
}

/** The abstract tier for a task class (`null` for `deterministic`). */
export function tierFor(taskClass: AiTaskClass): AiTier | null {
  return TASK_CLASS_TIER[taskClass];
}

/**
 * The worst-case token envelope for a binding, or `null` when nothing is bound.
 *
 * Takes the BINDING rather than the task class on purpose: the seam has already
 * resolved it, and a second internal `resolveModel` call here would be a second
 * source of truth for "which model is this" that a caller could not intercept.
 */
export function reservationEnvelopeOf(
  binding: AiModelBinding | null,
): { inputTokens: number; outputTokens: number } | null {
  if (!binding) return null;
  return {
    inputTokens: binding.reserveInputTokens,
    outputTokens: binding.reserveOutputTokens,
  };
}

/**
 * Is ANY tier bound to a real model in this build? A BUILD-TIME fact — the
 * honest answer to "could this deployment spend money on inference at all".
 * False today, and no environment variable can change that.
 */
export function isAnyTierBound(): boolean {
  return AI_TIERS.some((t) => TIER_MODEL[t] !== null);
}

// ---------------------------------------------------------------------------
// 3. The feature registry — who is allowed to spend.
// ---------------------------------------------------------------------------

export type AiFeatureDefinition = {
  /** Stable ledger key. Written to `ai_invocations.feature`; renaming is a breaking change. */
  readonly key: string;
  /** Human label for the HQ cost view. */
  readonly label: string;
  /**
   * The task class this capability is permitted to run as. The registry is the
   * AUTHORITY: `invokeWithGovernor` refuses a call whose declared task class
   * disagrees, so a call site cannot quietly promote itself from `cheap` to
   * `high` without an edit here that a reviewer will see.
   */
  readonly taskClass: AiTaskClass;
  /** What the capability degrades to when no provider is bound. Prose, for reviewers. */
  readonly degradesTo: string;
};

/**
 * Every governed capability. This is the closed set: `invokeWithGovernor`
 * rejects an unregistered key, so a new AI surface cannot reach a provider
 * without an entry here — which is the review point.
 *
 * Every entry below is BUILT AND DARK today: the code paths exist and, with no
 * bound tier, they behave exactly as they did before this file existed.
 *
 * NOTE THE ONE ASYMMETRY, because it is the honest part. Most capabilities
 * degrade to a DETERMINISTIC ANSWER — a regex, an empty draft, a fixed
 * acknowledgement — so a user cannot tell whether AI ran. Three cannot:
 * `quote.writer_draft` (a scope of works is not computable from a customer's
 * description), `imports.ocr` (a scanned invoice cannot be parsed without
 * vision), and the two `research.*` keys (there is nothing to interpret without
 * a model). Dark means those produce NOTHING and say so. A registry entry
 * claiming otherwise would be the false-green this codebase has already been
 * bitten by once (#433) — so each `degradesTo` below states what the caller
 * ACTUALLY returns, not what would be reassuring.
 */
export const AI_FEATURES = {
  "expense.receipt_extraction": {
    key: "expense.receipt_extraction",
    label: "Receipt / invoice extraction",
    taskClass: "classification",
    degradesTo: "Empty draft; the operator types the values (zeroExtraction).",
  },
  "receptionist.inbound_extraction": {
    key: "receptionist.inbound_extraction",
    label: "Inbound enquiry extraction",
    taskClass: "classification",
    degradesTo: "Keyword urgency + postcode regex (deterministicExtract).",
  },
  "receptionist.reply_draft": {
    key: "receptionist.reply_draft",
    label: "Conversation reply draft",
    taskClass: "drafting",
    degradesTo: "The deterministic acknowledgement (fallbackResponse).",
  },
  /**
   * Quote drafting — a scope of works a human reviews, edits, prices and only
   * then turns into a quote through the existing builder.
   *
   * `drafting`, not `complex`: it is customer-facing prose behind a mandatory
   * human review, which is that class's definition. The registry is the
   * authority, so a call site declaring `complex` to get a better model is
   * refused by `invokeWithGovernor` rather than silently routed to the
   * expensive tier.
   */
  "quote.writer_draft": {
    key: "quote.writer_draft",
    label: "Quote writer draft",
    taskClass: "drafting",
    degradesTo:
      "NOTHING — a scope of works cannot be computed, so there is no deterministic leg. The surface reports honestly that AI drafting is off and the operator writes the quote in the existing builder, exactly as today.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // The closure wave. Every entry below names a provider call that EXISTED
  // BEFORE the governor and reached a model without passing through it — the
  // gap that made "a credential alone cannot spend money" untrue. Each is now
  // wrapped, keyed, and classed here, so the registry is once again the
  // complete list of everything in this build that may spend on inference.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The prose blurb above the deterministic cards on /insights.
   *
   * `drafting`, not `classification`: it is TENANT-FACING PROSE, which is that
   * class's definition, and the class carries the cost tier appropriate to text
   * a paying customer reads. It is not `complex` — the model is handed FINISHED
   * aggregates and may only describe them, so there is no multi-step reasoning
   * to pay the high tier for. (lib/ai/insight-narrative.ts.)
   */
  "insights.narrative": {
    key: "insights.narrative",
    label: "Insights narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /insights page renders its deterministic cards alone, with no prose blurb. A tenant cannot tell the difference beyond the missing paragraph.",
  },
  /**
   * The tenant "Ask CrewFlow Insights" answer box on /insights.
   *
   * `drafting` for the same reason as the narrative: a customer reads the
   * prose. Deliberately NOT `complex` — the model's only ground truth is one
   * slim, fixed snapshot at temperature 0; paying the high tier would buy
   * reasoning the prompt forbids. (server/services/ai-question.ts.)
   */
  "insights.question": {
    key: "insights.question",
    label: "Insights question answer",
    taskClass: "drafting",
    degradesTo:
      "The deterministic keyword-routed answer built from the same snapshot (deterministicAnswer), labelled `generated_by: \"deterministic\"` so the UI can say so.",
  },
  /**
   * HQ's shared Draft Engine — the outreach/comms drafts every AI employee
   * inherits.
   *
   * `drafting` is the textbook case: prose that goes to a customer only after a
   * human approves it. (server/services/hq-drafts.ts.)
   */
  "hq.draft": {
    key: "hq.draft",
    label: "HQ draft generation",
    taskClass: "drafting",
    degradesTo:
      "The deterministic draft (deterministicDraft) persisted with status 'fallback' and provenance 'deterministic'. Generation stays TOTAL — a draft always exists.",
  },
  /**
   * Shared-Memory summarisation in the lifecycle worker.
   *
   * `classification`, and this is the one judgement call worth stating. It is
   * NOT `drafting` because nothing it writes is customer-facing and no human
   * reviews it: it compresses an HQ memory body for HQ's own recall. The mid
   * tier's premium exists for prose a customer will read, so spending it here
   * would buy quality nobody sees. Short, bounded, internal, low-stakes — the
   * cheap tier is the honest tier. (server/services/memory-lifecycle.ts.)
   */
  "memory.summarise": {
    key: "memory.summarise",
    label: "Memory summarisation",
    taskClass: "classification",
    degradesTo:
      "The memory keeps its existing summary / the deterministic SQL digest. Every other lifecycle reducer (expiry, decay, dedupe, eviction) is unaffected.",
  },
  /**
   * PDF / photo OCR on the Migration OS import path.
   *
   * `classification` — structured extraction of a fixed JSON schema from a
   * document, which is exactly what `expense.receipt_extraction` already is.
   * The same kind of work must carry the same class, or the tier table stops
   * meaning anything. (lib/imports/ocr.ts.)
   */
  "imports.ocr": {
    key: "imports.ocr",
    label: "Import OCR (PDF / photo)",
    taskClass: "classification",
    degradesTo:
      "OcrUnavailableError — the upload action redirects with `error=ocr_unavailable` and tells the operator to upload CSV / Excel instead. Byte-identical to the no-key path today.",
  },
  /**
   * The inbound-lead summary on the leads screen.
   *
   * `drafting`: operator-facing prose about a real customer, in the same shape
   * as `insights.narrative`. NOT in the audit's list of five — found by sweeping
   * for provider-SDK constructions rather than for `isAiConfigured()` gates.
   * (server/services/lead-summary.ts.)
   */
  "lead.summary": {
    key: "lead.summary",
    label: "Lead summary",
    taskClass: "drafting",
    degradesTo:
      "The deterministic summary assembled from the lead's own structured fields (deterministicSummary). Same return shape, so no UI branches on it.",
  },
  /**
   * HQ research: interpreting fetched evidence into intelligence.
   *
   * `complex` — genuinely multi-step reasoning over substantial context (a
   * fetched evidence corpus, ~2,800 output tokens), which is what that class is
   * for and the only entry in this registry that earns the high tier.
   * (server/services/research-llm.ts.)
   */
  "research.analysis": {
    key: "research.analysis",
    label: "HQ research analysis",
    taskClass: "complex",
    degradesTo:
      "null — the runner falls back to its deterministic report assembly, exactly as it does with no key.",
  },
  /**
   * HQ research: the sales-prep pack built from the same evidence.
   *
   * `complex`, for the same reason and over a slightly larger output cap. Kept
   * as its OWN key rather than folded into `research.analysis` so the HQ
   * per-feature cost rollup can tell the two apart — they are separate calls
   * with separate prompts and separate spend.
   */
  "research.sales_prep": {
    key: "research.sales_prep",
    label: "HQ research sales prep",
    taskClass: "complex",
    degradesTo:
      "null — the runner falls back to its deterministic prep assembly, exactly as it does with no key.",
  },
} as const satisfies Record<string, AiFeatureDefinition>;

export type AiFeature = keyof typeof AI_FEATURES;

/** Every registered feature key, for iteration in the HQ view and the tests. */
export const AI_FEATURE_KEYS = Object.keys(AI_FEATURES) as ReadonlyArray<AiFeature>;

/** The definition for a feature key, or `null` when unregistered. */
export function featureDefinition(key: string): AiFeatureDefinition | null {
  return (AI_FEATURES as Record<string, AiFeatureDefinition>)[key] ?? null;
}
