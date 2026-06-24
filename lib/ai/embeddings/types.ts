/**
 * Shared Memory — embedding provider abstraction (types).
 *
 * CEO Directive 009 Module 1, PR4. The Memory Engine is NEVER coupled to a
 * single embedding vendor. "Version 1" is OpenAI `text-embedding-3-small`
 * (1536-d), but the architecture assumes that changes: swapping to Anthropic,
 * Google, Azure OpenAI, Voyage AI, or a local model must be CONFIGURATION
 * ONLY — no application code changes.
 *
 * This module is pure types — no SDK, no `server-only`, no Node builtins — so
 * recall, the worker, the cost ledger, and the tests can all share one
 * vocabulary without dragging a vendor SDK into their bundle.
 *
 *   Embedding Interface  →  OpenAI Provider  →  (future providers)
 *
 * Two distinct seams carry the CEO's "plug-in, never a dependency" rule:
 *   - `getEmbeddingProvider()` returns `null` when nothing is configured —
 *     semantic search simply switches off; every other recall channel
 *     (permission → lexical → structural → ranking → assembly) keeps working.
 *   - `provider.embed()` THROWS on a provider failure — the worker owns
 *     retry / backoff / dead-letter, and records the failure reason. A
 *     transient API error must never be swallowed into a silent gap.
 */

/** A dense embedding vector. Length === the provider's `dimension`. */
export type EmbeddingVector = number[];

/**
 * The stable identity of a provider+model+dimension+revision tuple.
 *
 * `version` is the CANONICAL staleness key (CEO queue source:
 * "embedded_at IS NULL OR embedding_version mismatch"). It is a single
 * composite string so one comparison detects EVERY kind of drift — provider
 * upgrade, model upgrade, dimension change, or a quality-only revision. The
 * provider/model/dimension fields are also stored per-memory for
 * observability, cost analysis, and mixed-provider filtering.
 */
export type EmbeddingModelInfo = {
  /** Vendor id, lowercase. e.g. "openai", "anthropic", "voyage". */
  provider: string;
  /** Model id as the vendor names it. e.g. "text-embedding-3-small". */
  model: string;
  /** Output dimensionality. e.g. 1536. */
  dimension: number;
  /** Composite identity string — the single re-embed trigger. */
  version: string;
};

/**
 * The result of embedding a batch of texts.
 *
 * `vectors[i]` corresponds to `texts[i]` (order preserved). `tokens` is the
 * provider's AUTHORITATIVE billed total for the whole request — vendors bill
 * per-request, not per-input, so per-memory cost is attributed downstream
 * (see `estimateTokens`); the request ledger keeps the exact truth.
 */
export type EmbeddingResult = {
  vectors: EmbeddingVector[];
  /** Echoed from the provider — the model that actually ran. */
  model: string;
  /** Echoed from the provider — the dimensionality actually returned. */
  dimension: number;
  /** Total tokens billed for the request (provider truth, for the ledger). */
  tokens: number;
};

/** Optional per-call controls. */
export type EmbeddingCallOptions = {
  /** Abort/timeout signal. Providers default to their own timeout when absent. */
  signal?: AbortSignal;
};

/**
 * The one interface the Memory Engine knows. Implementations live behind the
 * config-driven factory; the engine never imports a vendor SDK directly.
 */
export interface EmbeddingProvider {
  /** Identity of what this provider produces — drives versioning + metadata. */
  readonly info: EmbeddingModelInfo;
  /**
   * Embed a batch of texts, preserving order. Throws on any provider failure
   * (network, auth, rate-limit, dimension mismatch) so the worker can retry,
   * back off, and dead-letter while recording the failure reason. Returns an
   * empty result for an empty batch WITHOUT touching the network.
   */
  embed(texts: string[], opts?: EmbeddingCallOptions): Promise<EmbeddingResult>;
}

/**
 * Per-memory embedding lifecycle state.
 *   - "pending"  — queued, no vector yet (embedded_at IS NULL).
 *   - "embedded" — a current-version vector is stored and searchable.
 *   - "failed"   — exhausted retries; dead-lettered. Still lexically/
 *                  structurally recallable — semantic only is unavailable.
 *   - "stale"    — a vector exists but its version no longer matches the
 *                  target (provider/model/quality upgrade). Old vector stays
 *                  searchable until an atomic replacement lands.
 */
export type EmbeddingStatus = "pending" | "embedded" | "failed" | "stale";
