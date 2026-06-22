/**
 * Shared Memory — text-generation provider abstraction (types).
 *
 * CEO Directive 009 Module 1, PR5. The Memory Engine's lifecycle reducers
 * (summarisation, consolidation refinement — Bible Volume X §9) sometimes want
 * an LLM to turn a long body into a short summary or a deterministic digest
 * into a cleaner lesson. As with embeddings, the engine is NEVER coupled to a
 * single LLM vendor: "Version 1" is Anthropic Haiku (preferred) with OpenAI
 * as a fallback, but swapping to Google, Azure, a local model, etc. must be
 * CONFIGURATION ONLY — no application code changes.
 *
 * This module is pure types — no SDK, no `server-only`, no Node builtins — so
 * the worker, the cost ledger, and the tests can share one vocabulary without
 * dragging a vendor SDK into their bundle.
 *
 *   Text Interface  →  Anthropic Provider  →  OpenAI Provider  →  (future)
 *
 * Two distinct seams carry the CEO's "plug-in, never a dependency" rule —
 * identical to the embedding seam:
 *   - `getTextProvider()` returns `null` when nothing is configured — the
 *     LLM-assisted reducers simply switch off; the deterministic SQL digest /
 *     existing summary stays in place and every other lifecycle reducer keeps
 *     running. The application cannot tell the difference.
 *   - `provider.generate()` THROWS on a provider failure — the worker owns
 *     skip / retry / backoff and records the failure reason. A transient API
 *     error must never be silently turned into a bad summary.
 */

/**
 * The stable identity of a text provider+model. Recorded per AI action for
 * cost accounting and observability ("every AI action measurable" — §10).
 */
export type TextModelInfo = {
  /** Vendor id, lowercase. e.g. "anthropic", "openai". */
  provider: string;
  /** Model id as the vendor names it. e.g. "claude-haiku-4-5", "gpt-4o-mini". */
  model: string;
};

/** Optional per-call controls. */
export type TextGenerationOptions = {
  /** A system prompt / instruction, applied as the vendor's system channel. */
  system?: string;
  /** Hard cap on output tokens. Providers default to a sane summary-sized cap. */
  maxTokens?: number;
  /** Sampling temperature. Omitted → the vendor default. */
  temperature?: number;
  /** Abort/timeout signal. Providers default to their own timeout when absent. */
  signal?: AbortSignal;
};

/**
 * The result of one text generation.
 *
 * `inputTokens` / `outputTokens` are the provider's AUTHORITATIVE billed
 * counts, split so per-action cost is exact (LLMs price input and output
 * differently — see `textCostUsd`). `model` is echoed from the provider — the
 * model that actually ran, which may differ from the requested alias.
 */
export type TextResult = {
  /** The generated text, trimmed. Empty string when the model returned nothing. */
  text: string;
  /** Echoed from the provider — the model that actually ran. */
  model: string;
  /** Billed input/prompt tokens (provider truth, for the ledger). */
  inputTokens: number;
  /** Billed output/completion tokens (provider truth, for the ledger). */
  outputTokens: number;
};

/**
 * The one interface the Memory Engine knows. Implementations live behind the
 * config-driven factory (`./index`); the engine never imports a vendor SDK
 * directly.
 */
export interface TextProvider {
  /** Identity of what this provider produces — drives cost + metadata. */
  readonly info: TextModelInfo;
  /**
   * Generate text for a single prompt. Throws on any provider failure
   * (network, auth, rate-limit) so the worker can skip / retry / back off
   * while recording the failure reason. Returns an empty result for a blank
   * prompt WITHOUT touching the network.
   */
  generate(prompt: string, opts?: TextGenerationOptions): Promise<TextResult>;
}
