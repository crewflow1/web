/**
 * Shared Memory — embedding versioning, checksums, cost, and validation.
 *
 * CEO Directive 009 Module 1, PR4. Embeddings are VERSIONED ASSETS, not a
 * transient cache: every embedded memory permanently records which provider,
 * model, dimension, and revision produced it, plus a checksum of the source
 * text so drift and duplication are detectable. These are the pure functions
 * that compute those values — no SDK, no `server-only`, deterministic, and
 * unit-tested in isolation.
 *
 * `node:crypto` is the only dependency; the Memory Engine runs in the Node
 * runtime, never the edge, so this stays importable by recall, the worker,
 * the cost ledger, and the tests.
 */

import { createHash } from "node:crypto";

/**
 * Bumped by hand when embedding QUALITY changes WITHOUT a model swap — e.g. a
 * new input-normalisation step that makes existing vectors stale even though
 * the provider/model/dimension are unchanged. Provider/model/dimension
 * changes are captured automatically because they are part of the composite
 * id, so this is the "everything else" lever for forcing a re-embed.
 */
export const EMBEDDING_SCHEMA_REVISION = 1;

/**
 * The canonical staleness key. A single string so the re-embed trigger is one
 * comparison: a row is current iff its stored `embedding_version` equals this
 * for the active provider. Any drift — provider, model, dimension, or a
 * quality revision — changes the string and flags the row for re-embedding.
 */
export function embeddingVersion(info: {
  provider: string;
  model: string;
  dimension: number;
}): string {
  return `${info.provider}:${info.model}:d${info.dimension}:v${EMBEDDING_SCHEMA_REVISION}`;
}

/**
 * A stable SHA-256 of the exact source text that was embedded.
 *
 * Two jobs:
 *   - Idempotency — "never generate duplicate embeddings": if the stored
 *     checksum matches the live text, the vector is already correct, skip it.
 *   - Drift detection — if a memory's body is edited, its checksum changes,
 *     so the queue knows to re-embed even though the version is unchanged.
 */
export function embeddingChecksum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * "Version 1" embedding pricing — USD per 1,000,000 tokens, keyed by
 * `${provider}:${model}`. Pricing is PROVIDER METADATA, not a constant of the
 * Memory Engine: adding a provider/model adds a row here, it never touches
 * application code. Values current as of 2026-06.
 */
const PRICE_PER_MTOK_USD: Readonly<Record<string, number>> = {
  "openai:text-embedding-3-small": 0.02,
  "openai:text-embedding-3-large": 0.13,
  "openai:text-embedding-ada-002": 0.1,
};

/**
 * Cost in USD for `tokens` against a provider/model. Returns `null` when the
 * model's price is unknown — cost is OBSERVABILITY, never a correctness gate,
 * so an unpriced model still embeds; its cost is simply recorded as unknown.
 */
export function embeddingCostUsd(
  info: { provider: string; model: string },
  tokens: number,
): number | null {
  const rate = PRICE_PER_MTOK_USD[`${info.provider}:${info.model}`];
  if (rate === undefined) return null;
  return (tokens / 1_000_000) * rate;
}

/**
 * A rough token estimate (~4 chars/token) for budgeting and for attributing a
 * BATCH's billed tokens across its inputs. NEVER used for billing — the
 * provider's reported usage is the source of truth there; this only splits a
 * request total into per-memory shares and bounds worker batch sizes.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Thrown when a vector is the wrong length or contains non-finite values. */
export class EmbeddingDimensionError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    message?: string,
  ) {
    super(message ?? `embedding dimension mismatch: expected ${expected}, got ${actual}`);
    this.name = "EmbeddingDimensionError";
  }
}

/**
 * Structural soundness predicate: right length AND every element a finite
 * number. Catches the realistic "vector corruption" failure modes — a
 * truncated row, a wrong-model vector, or a NaN/Infinity poisoning the ANN
 * index — without trusting the storage layer blindly.
 */
export function isValidEmbedding(vec: unknown, expected: number): vec is number[] {
  return (
    Array.isArray(vec) &&
    vec.length === expected &&
    vec.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Assert a vector is sound, or throw `EmbeddingDimensionError`. The worker
 * calls this before storing a vector so corruption is dead-lettered instead
 * of silently indexed.
 */
export function assertValidEmbedding(vec: unknown, expected: number): asserts vec is number[] {
  if (!Array.isArray(vec)) {
    throw new EmbeddingDimensionError(expected, -1, "embedding is not an array");
  }
  if (vec.length !== expected) {
    throw new EmbeddingDimensionError(expected, vec.length);
  }
  if (!vec.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new EmbeddingDimensionError(
      expected,
      vec.length,
      "embedding contains a non-finite value (corruption)",
    );
  }
}
