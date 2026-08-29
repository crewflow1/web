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
 * The five kinds of work the governor recognises.
 *
 * `deterministic` is in this list ON PURPOSE even though it names work that
 * must never reach a model. Naming it is what lets a call site declare "this
 * is deterministic" and be REFUSED loudly, rather than having no vocabulary for
 * the claim and quietly sending a regex problem to an LLM. The refusal lives in
 * `invokeWithGovernor`; the database states the same rule structurally by
 * omitting 'deterministic' from the ledger's task_class CHECK.
 *
 * `embedding` is a DIFFERENT MODALITY, not a price band of the same one: a
 * vector, not prose, billed on input tokens only, typically ~100× cheaper per
 * token than generation. It was the last ungoverned AI path in the build (the
 * readiness surface said so explicitly) — admitted here, and to the ledger's
 * CHECK, by migration 20261080.
 *
 * `transcription` is a THIRD modality on the same footing: Speech-to-Text turns
 * audio bytes into a transcript, billed on audio DURATION through a distinct
 * vendor surface (lib/ai/transcription.ts). Like `embedding` it must be
 * independently armable — binding a text model must not authorise transcription
 * spend, and binding an STT model must open no text door — so it carries its own
 * tier (below). Admitted here, and to the ledger's CHECK, by migration 20261191;
 * still DARK (no STT model bound), so it meters nothing until activation.
 */
export const AI_TASK_CLASSES = [
  "deterministic",
  "classification",
  "drafting",
  "complex",
  "embedding",
  "transcription",
] as const;
export type AiTaskClass = (typeof AI_TASK_CLASSES)[number];

/**
 * Abstract cost tiers. Names describe PRICE BAND, never a vendor or a model.
 *
 * `embedding` is its own tier rather than a reuse of `cheap` because the two
 * must be independently armable: binding a cheap TEXT model must not authorise
 * embedding spend, and binding an embedding model must not open any text door.
 * The per-modality door gates in lib/ai/{text,vision,embeddings} depend on the
 * tiers being separable — see isInferenceTierActivated / isEmbeddingActivated
 * in ./readiness.ts.
 */
export const AI_TIERS = ["cheap", "mid", "high", "embedding", "transcription"] as const;
export type AiTier = (typeof AI_TIERS)[number];

/**
 * The tiers that arm GENERATIVE inference (the text and vision doors), as
 * distinct from the embedding modality. The doors gate on "is any tier of MY
 * modality bound", never on the global any-tier answer — otherwise binding an
 * embedding model would open the text door on a bare key, recreating the exact
 * cross-activation defect the governance closure fixed.
 */
export const INFERENCE_TIERS = ["cheap", "mid", "high"] as const satisfies readonly AiTier[];

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
  // Vector generation. Its own tier — see the AI_TIERS note for why it must
  // never share an arming switch with a generative tier.
  embedding: "embedding",
  // Speech-to-Text. Its own tier for the same reason as embedding: the STT
  // modality must be independently armable from generation and from embeddings.
  transcription: "transcription",
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
  // The embedding modality's own switch. For an embedding model,
  // `usdPerMTokOut` and `reserveOutputTokens` are 0 — embeddings bill input
  // only — and `reserveInputTokens` is the worst-case BATCH size the worker
  // may submit in one call, not one document's tokens.
  embedding: null,
  // The transcription (STT) modality's own switch — the governor-side COST
  // binding, distinct from the transport binding in lib/ai/transcription.ts
  // (TRANSCRIPTION_MODEL). Both are null today. On activation BOTH are bound
  // together: TRANSCRIPTION_MODEL does the vendor call; this entry states the
  // worst-case reservation envelope so the ceiling can claim budget before an
  // STT call whose true cost (audio seconds) is unknowable in advance. STT
  // bills on audio, so `usdPerMTokOut`/`reserveOutputTokens` are 0 and
  // `reserveInputTokens` encodes the worst-case audio duration as a token proxy.
  transcription: null,
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
   * The automated reply on a customer's PORTAL LIVE CHAT (MP Phase 8). When a
   * customer sends a chat message, the portal posts one automated
   * acknowledgement back (server/services/chat-auto-reply.ts).
   *
   * `drafting`, exactly like `receptionist.reply_draft`: customer-facing prose,
   * and — like that key — it degrades to a DETERMINISTIC acknowledgement rather
   * than to nothing, so the customer always gets a reply and cannot tell whether
   * a model ran. DARK today: no generative tier is bound, so
   * `maybeGenerateChatReply` returns null before the governor is reached and the
   * fixed `DETERMINISTIC_CHAT_ACK` is posted. Whatever posts it, the message is
   * stamped auto_generated = true so the panel labels it "Automated" — an AI
   * reply is never passed off as a person.
   */
  "chat.auto_reply": {
    key: "chat.auto_reply",
    label: "Portal live-chat auto reply",
    taskClass: "drafting",
    degradesTo:
      "The deterministic acknowledgement (DETERMINISTIC_CHAT_ACK), posted with auto_generated = true. The customer always receives a reply; nothing is generated while dark.",
  },
  /**
   * The AI receptionist's spoken conversation turn on an inbound VOICE call
   * (Wave 8). `drafting`, not `complex`: it is customer-facing prose (spoken to
   * the caller), the same class as the WhatsApp/SMS reply draft, and it reaches
   * a model only through the shared text door under the governor.
   *
   * DARK: no generative tier is bound, so `maybeGenerateVoiceTurn`
   * (lib/telephony/ai-turn.ts) returns null before the governor is reached and
   * the caller speaks the deterministic acknowledgement TwiML. There is no
   * spoken AI turn until a tier is bound.
   */
  "receptionist.voice_turn": {
    key: "receptionist.voice_turn",
    label: "Voice receptionist spoken turn",
    taskClass: "drafting",
    degradesTo:
      "null — the voice webhook plays the deterministic acknowledgement TwiML (no generated speech). A caller hears the fixed greeting, exactly as today; nothing is generated.",
  },
  /**
   * WhatsApp voice-note TRANSCRIPTION (Speech-to-Text). When a customer sends a
   * voice note, the assistant pipeline downloads the audio
   * (server/services/whatsapp-media-pipeline.ts), validates it, and — through
   * this feature — asks the STT seam (lib/ai/transcription.ts) for a transcript
   * to store as the job note.
   *
   * `transcription`, NOT a generative class: it is a distinct modality (audio →
   * text), so it maps to the `transcription` tier which shares an arming switch
   * with no generative tier. The registry is the authority, so a call site
   * declaring `drafting` (to reach the text door) is refused by
   * invokeWithGovernor.
   *
   * DARK: no STT model is bound (TRANSCRIPTION_MODEL is null), so the seam
   * returns `deferred` with a null transcript and NEVER fabricates. The note is
   * recorded with the deterministic placeholder text instead. There is no
   * transcript until an STT model is bound AND its credential is present AND the
   * `transcription` tier's cost binding (TIER_MODEL) is set.
   */
  "voice_note.transcription": {
    key: "voice_note.transcription",
    label: "WhatsApp voice-note transcription",
    taskClass: "transcription",
    degradesTo:
      "deferred — a null transcript that is NEVER fabricated. The voice note's job note keeps the deterministic placeholder (its caption / a fixed marker), and the operator still sees the stored audio bytes. Byte-identical to today while dark.",
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
   * The Shared-Memory embedding WORKER: turning queued memory bodies into
   * searchable vectors, in batches, on a cron.
   *
   * `embedding` — the modality IS the class. Billed to CrewFlow's own org
   * (hqBudgetOrgId): memories are HQ-internal, no tenant asked for this spend.
   * The worker keeps its own independent gates (the `worker_enabled` DB flag,
   * a per-run USD cost cap, a wall-clock deadline); the governor's ceiling and
   * ledger sit UNDER those, not instead of them.
   */
  "memory.embedding_write": {
    key: "memory.embedding_write",
    label: "Memory embedding (worker)",
    taskClass: "embedding",
    degradesTo:
      "The batch is not embedded this run; queued memories stay 'pending' and recall keeps serving lexical/structural results. Nothing is failed or dead-lettered — a budget refusal is not the row's fault.",
  },
  /**
   * HQ recall's query-time embed: one short human query vectorised on demand
   * so semantic search can rank against the stored vectors.
   *
   * Same class, same HQ attribution, separate key — the HQ cost view must be
   * able to tell a worker backfill burst from interactive recall traffic.
   */
  "memory.embedding_query": {
    key: "memory.embedding_query",
    label: "Memory recall query embedding",
    taskClass: "embedding",
    degradesTo:
      "Semantic ranking is skipped for this query; lexical + structural recall answer alone, exactly as they do with no provider configured.",
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

  /**
   * HQ Workflow-Saga: AI-assisted decomposition of a directive into a
   * cross-department step GRAPH (lib/hq/workflow/ai-decompose.ts).
   *
   * `complex` — genuinely multi-step reasoning that reads a free-form directive
   * and proposes an ordered, dependency-linked graph of steps across
   * departments. It is a FEATURE key mapping to the existing `complex` task
   * class → `high` tier; it registers NO new governor TIER (which the
   * governance-closure ratchet forbids), so binding a tier is what arms it, not
   * a key alone.
   *
   * DARK: no generative tier is bound, so `maybeDecomposeWithAi` returns null
   * before the governor is reached and the caller uses the DETERMINISTIC
   * template decomposition (lib/hq/workflow/decompose.ts) — the substrate the
   * whole feature rests on. There is no AI-planned saga until a tier is bound.
   */
  "hq.saga_decomposition": {
    key: "hq.saga_decomposition",
    label: "Workflow-saga decomposition",
    taskClass: "complex",
    degradesTo:
      "null — the caller falls back to the deterministic template decomposition (decomposeDirective), which is the substrate and is always available. No saga is ever left unplanned for want of a model.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // The HQ BOARD NARRATIVES. Ten super-admin boardroom surfaces
  // (app/admin/{finance,cto,operations,marketing,product,customer-success,
  // qa-ai,executive-assistant,sales-orchestrator,support}-ai) each compute a
  // deterministic board in a pure layer (lib/hq/*) and want a short prose blurb
  // ABOVE the deterministic cards. The blurb is NARRATE-ONLY: the model is handed
  // the FINISHED board and may only describe it — every figure the operator sees
  // still comes from the deterministic compute, so a hallucination can never
  // change a displayed number. All ten reach a model through the ONE shared
  // governed door (server/services/hq-narrative.ts → invokeWithGovernor →
  // getTextProvider), billed to the HQ budget org (hqBudgetOrgId).
  //
  // `drafting`, exactly like the tenant `insights.narrative`: it is prose a human
  // reads, and the model is forbidden from reasoning past the supplied board, so
  // there is no `complex` multi-step work to pay the high tier for. Each board
  // gets its OWN key — never the tenant `insights.narrative` key — so the HQ
  // per-feature cost rollup attributes HQ's own spend correctly and cannot be
  // confused with a tenant's. Every key is WIRED at exactly one call site (the
  // shared helper, invoked from each board's `load*Narrative`); DARK until a
  // generative tier is bound, at which point the loader begins returning prose.
  // ─────────────────────────────────────────────────────────────────────────

  "hq.finance_narrative": {
    key: "hq.finance_narrative",
    label: "HQ finance board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/finance board renders its deterministic figures only, with no prose blurb. A super-admin sees the same numbers, just no paragraph above them.",
  },
  "hq.cto_narrative": {
    key: "hq.cto_narrative",
    label: "HQ CTO board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/cto-ai engineering-health board renders its deterministic cards only, with no prose blurb.",
  },
  "hq.operations_narrative": {
    key: "hq.operations_narrative",
    label: "HQ operations board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/operations-ai board renders its deterministic cards only, with no prose blurb.",
  },
  "hq.marketing_narrative": {
    key: "hq.marketing_narrative",
    label: "HQ marketing board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/marketing-ai board renders its deterministic cards only, with no prose blurb.",
  },
  "hq.product_narrative": {
    key: "hq.product_narrative",
    label: "HQ product board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/product-ai board renders its deterministic cards only, with no prose blurb.",
  },
  "hq.customer_success_narrative": {
    key: "hq.customer_success_narrative",
    label: "HQ customer-success board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/customer-success-ai board renders its deterministic cards only, with no prose blurb.",
  },
  "hq.qa_narrative": {
    key: "hq.qa_narrative",
    label: "HQ QA board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/qa-ai AI-quality board renders its deterministic cards only, with no prose blurb.",
  },
  "hq.executive_assistant_narrative": {
    key: "hq.executive_assistant_narrative",
    label: "HQ executive-assistant board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/executive-assistant-ai digest renders its deterministic cards only, with no prose blurb.",
  },
  "hq.sales_orchestrator_narrative": {
    key: "hq.sales_orchestrator_narrative",
    label: "HQ sales-orchestrator board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/sales-orchestrator-ai pipeline board renders its deterministic cards only, with no prose blurb.",
  },
  "hq.support_ai_narrative": {
    key: "hq.support_ai_narrative",
    label: "HQ support board narrative",
    taskClass: "drafting",
    degradesTo:
      "null — the /admin/support-ai triage board renders its deterministic cards only, with no prose blurb.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // The HQ DEPARTMENT GENERATIVE LEGS (L9a). Three department AI contracts
  // (Marketing content, Design review, Documentation drafting) each produce a
  // DETERMINISTIC artifact from real data via the Task Engine, and each carries
  // ONE governed dark seam for the generative half of its roadmap contract. All
  // three reach a model only through the shared department-seam helper
  // (server/services/hq-generative-seams.ts) → invokeWithGovernor →
  // getTextProvider, billed to the HQ budget org — the same one-door shape as
  // the board narratives above. `drafting`, because each is prose a human
  // reviews; none needs `complex` multi-step reasoning over the artifact it is
  // handed. DARK until a generative tier is bound; while dark every artifact
  // states its generative field is null and the deterministic content stands
  // alone.
  // ─────────────────────────────────────────────────────────────────────────

  "hq.marketing_draft": {
    key: "hq.marketing_draft",
    label: "HQ marketing content draft",
    taskClass: "drafting",
    degradesTo:
      "null — the weekly content brief stays fully deterministic (real demo-request sources + the SEO page inventory); its generativeDraft field is null and says so. No copy is generated while dark.",
  },
  "hq.design_review": {
    key: "hq.design_review",
    label: "HQ design review critique",
    taskClass: "drafting",
    degradesTo:
      "null — the design_review task completes with its deterministic token/consistency findings only; the generativeCritique field is null and says so. No UI critique prose is generated while dark.",
  },
  "hq.doc_draft": {
    key: "hq.doc_draft",
    label: "HQ documentation draft",
    taskClass: "drafting",
    degradesTo:
      "null — release notes remain the deterministic composition over admin_activity_log / hq_events / hq_decisions; the generativeProse field is null and says so. No documentation prose is generated while dark.",
  },
} as const satisfies Record<string, AiFeatureDefinition>;

export type AiFeature = keyof typeof AI_FEATURES;

/** Every registered feature key, for iteration in the HQ view and the tests. */
export const AI_FEATURE_KEYS = Object.keys(AI_FEATURES) as ReadonlyArray<AiFeature>;

/** The definition for a feature key, or `null` when unregistered. */
export function featureDefinition(key: string): AiFeatureDefinition | null {
  return (AI_FEATURES as Record<string, AiFeatureDefinition>)[key] ?? null;
}
