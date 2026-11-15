/**
 * Tenant Semantic Search — the pure hybrid ranker + chunking helper.
 *
 * SQL returns candidates with their raw signals (cos_sim, ts_rank); the final
 * blended order is computed HERE, in a pure function, so it is deterministic and
 * unit-testable in isolation (no DB, no provider). Permission is already
 * enforced in SQL before anything reaches this layer — the ranker only ORDERS,
 * it can never widen what is visible.
 */

import type { SemanticHit } from "./types";

/** Clamp to [0, 1] (cosine similarity can arrive slightly outside [0,1]). */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1; // +Infinity clamps to 1
  return x;
}

/**
 * Squash an unbounded, non-negative lexical rank (ts_rank) into [0, 1) so it is
 * commensurable with cosine similarity. Monotonic: bigger rank → bigger score,
 * asymptotes at 1. x/(x+1) — the standard, parameter-free saturating map.
 */
export function normalizeLexical(tsRank: number): number {
  const x = Number.isFinite(tsRank) && tsRank > 0 ? tsRank : 0;
  return x / (x + 1);
}

export type HybridWeights = {
  /** Weight on semantic (cosine) similarity. */
  semantic: number;
  /** Weight on lexical (ts_rank) similarity. */
  lexical: number;
};

/** Default blend: semantic-leaning, lexical as a strong tie-breaker. */
export const DEFAULT_WEIGHTS: HybridWeights = { semantic: 0.65, lexical: 0.35 };

/**
 * The blended score of a single hit ∈ [0, 1]. A hit with no vector (cosSim
 * null) scores on lexical alone; a hit found only semantically scores on
 * cosine alone. Pure.
 */
export function hybridScore(hit: SemanticHit, weights: HybridWeights = DEFAULT_WEIGHTS): number {
  const sem = clamp01(hit.cosSim ?? 0);
  const lex = normalizeLexical(hit.tsRank);
  return weights.semantic * sem + weights.lexical * lex;
}

/**
 * Rank candidates by blended score, descending. Stable: equal scores keep input
 * order (so the SQL coarse order breaks ties predictably). Returns a new array;
 * never mutates the input.
 */
export function hybridRank(
  hits: readonly SemanticHit[],
  weights: HybridWeights = DEFAULT_WEIGHTS,
): SemanticHit[] {
  return hits
    .map((hit, i) => ({ hit, i, score: hybridScore(hit, weights) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i))
    .map((x) => x.hit);
}

/**
 * Split text into chunks no longer than `maxChars`, breaking on whitespace when
 * possible so a word is not cut mid-token. Used to bound the text handed to the
 * embedding provider (a single over-long record is chunked, not truncated
 * blindly). Pure + deterministic.
 *
 *   - empty / whitespace-only input → [] (nothing to embed).
 *   - a chunk with no breakable whitespace is hard-split at maxChars (so a
 *     pathological unbroken string still terminates).
 */
export function chunkText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    // No space in the window (or it's at index 0) → hard split at the limit.
    if (cut <= 0) cut = limit;
    const piece = rest.slice(0, cut).trim();
    if (piece.length > 0) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
