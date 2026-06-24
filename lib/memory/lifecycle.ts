/**
 * CrewFlow HQ — Shared Memory: the pure lifecycle POLICY
 * (CrewFlow Bible, Volume X §9–§10; CEO Directive 009 Module 1, PR5).
 *
 * Server/client-safe. ZERO I/O — no Supabase, no model provider, nothing async.
 * This is the deterministic POLICY layer that sits on top of the pure MATH in
 * retrieval.ts (`effectiveScore`, `exponentialDecay`, `evictionOrder`). The math
 * answers "how strong is this memory right now"; this module answers the
 * lifecycle QUESTIONS the recurring §9/§10 tasks ask:
 *
 *   §10  isTtlExpired          — has a hard-TTL (working) memory passed expiry?
 *   §10  shouldArchiveEpisodic — has a consolidated episode decayed below the floor?
 *   §10  evictionPlan          — under storage pressure, what fades first?
 *   §9.1 needsSummary          — is a memory's summary missing / inadequate?
 *   §9.2 MIN_CONSOLIDATION_SOURCES — when is a theme worth rolling up?
 *   §9.3 chooseDedupeKeeper    — of a near-duplicate pair, which survives?
 *
 * These thresholds are THE single source of lifecycle policy. The SQL entry
 * points (`hq_memory_expire_sweep` / `_consolidate` / `_dedupe_pairs` /
 * `_supersede`, PR5) mirror these exact numbers, and the security gate pins that
 * SQL and TS agree. Keeping the decisions pure + typed is what lets the unit
 * gate prove the policy without a database — exactly as retrieval.ts proves the
 * ranking. "Build it once, build it properly."
 */

import {
  effectiveScore,
  evictionOrder,
  RECENCY_HALF_LIFE_MS,
  type EvictionCandidate,
} from "./retrieval";
import { type MemoryClass } from "./model";

// =====================================================================
// Policy constants (Volume X §9–§10). The SQL mirrors these literals.
// =====================================================================

/**
 * §10 — the effective-retention floor. A consolidated episodic memory whose
 * `effectiveScore` (decay × salience) has fallen below this is archived (its
 * lesson is already preserved). Tuned so a salience-50 episode fades at ≈69
 * days, a salience-100 at ≈90 days — "lived experience fades on the order of
 * tens of days" (Volume X §10) — while a high-salience episode persists longer.
 */
export const DECAY_FLOOR = 0.05;

/** §10 — episodic decay time-constant τ (ms). The half-life from retrieval.ts. */
export const EPISODIC_DECAY_TAU_MS = RECENCY_HALF_LIFE_MS.episodic;

/** §10 — working-memory decay τ (ms). Working memory is TTL-driven; this is its
 *  decay constant for the eviction-under-pressure ranking. */
export const WORKING_DECAY_TAU_MS = RECENCY_HALF_LIFE_MS.working;

/**
 * §9.2 — the minimum number of source episodes a theme needs before it is worth
 * rolling up into a `long_term` memory. Below this it is noise, not a pattern;
 * `hq_memory_consolidate` returns null (a no-op) rather than create a one-off.
 */
export const MIN_CONSOLIDATION_SOURCES = 3;

/**
 * §9.1 — a body shorter than this (≈300 tokens) fits whole under any sane budget,
 * so it never needs a separate summary; only longer bodies are summarisation
 * candidates.
 */
export const SUMMARY_MIN_BODY_CHARS = 1200;

/**
 * §9.1 — a "summary" that is still ≥ this fraction of the body length is not
 * actually a summary (it saves nothing under pressure), so it is treated as
 * missing and refreshed.
 */
export const SUMMARY_MAX_RATIO = 0.6;

/**
 * §9.3 — cosine similarity above which two memories are near-duplicates and one
 * is merged away. Matches the recall diversify default (retrieval.ts) and the
 * directive's "cosine > 0.95" — deliberately conservative so dedup never merges
 * distinct facts.
 */
export const DEDUPE_COSINE_THRESHOLD = 0.95;

// =====================================================================
// §10 — age + TTL
// =====================================================================

/**
 * Age in ms of a memory for decay purposes: now − (last reinforced ?? created).
 * Reinforcement (Volume X §7) enters the decay model THROUGH this clock — a
 * recently-recalled memory has a small age and therefore a high retention score,
 * so no separate reinforcement multiplier is needed downstream. Never negative.
 */
export function memoryAgeMs(p: {
  createdAtMs: number;
  lastReinforcedAtMs: number | null;
  now: number;
}): number {
  const ref = p.lastReinforcedAtMs ?? p.createdAtMs;
  return Math.max(0, p.now - ref);
}

/**
 * §10 — has a hard-TTL memory passed its expiry? Working memory carries an
 * `expires_at`; durable company-brain memory never does (null ⇒ never expires).
 */
export function isTtlExpired(p: { expiresAtMs: number | null; now: number }): boolean {
  return p.expiresAtMs != null && p.expiresAtMs <= p.now;
}

// =====================================================================
// §10 — episodic decay archival
// =====================================================================

/** The §10 effective retention score for an ephemeral memory of a given class. */
export function retentionScore(p: {
  memoryClass: MemoryClass;
  ageMs: number;
  salience: number;
  reinforcement?: number;
}): number {
  return effectiveScore({
    ageMs: p.ageMs,
    tauMs: RECENCY_HALF_LIFE_MS[p.memoryClass],
    salience: p.salience,
    reinforcement: p.reinforcement,
  });
}

/**
 * §10 — the episodic decay archival decision. An episode is archived (NOT
 * deleted — `status='archived'`, fully audited) only when BOTH:
 *   (a) its lesson is preserved — it has been `consolidated_into` a long_term
 *       memory, AND
 *   (b) its effective retention score has fallen below `DECAY_FLOOR`.
 * An UNCONSOLIDATED episode — however old — is never archived by decay: dropping
 * it would lose its lesson (Volume X §10 "Unconsolidated high-salience episodes
 * persist"). High salience also keeps a consolidated episode alive longer.
 */
export function shouldArchiveEpisodic(p: {
  ageMs: number;
  salience: number;
  consolidated: boolean;
}): boolean {
  if (!p.consolidated) return false;
  const score = effectiveScore({
    ageMs: p.ageMs,
    tauMs: EPISODIC_DECAY_TAU_MS,
    salience: p.salience,
  });
  return score < DECAY_FLOOR;
}

// =====================================================================
// §10 — eviction under pressure
// =====================================================================

/**
 * §10 — the eviction plan under storage/cost pressure. A thin, deterministic
 * wrapper over the pure `evictionOrder` (retrieval.ts): durable company-brain
 * classes are NEVER evicted; ephemeral candidates are ordered lowest-effective-
 * score first, and we take only the `count` needed to get back under budget.
 * Returns the ids to archive, in eviction order.
 */
export function evictionPlan(
  candidates: ReadonlyArray<EvictionCandidate>,
  count: number,
): string[] {
  if (count <= 0) return [];
  // evictionOrder already filters out durable classes and sorts ascending.
  return evictionOrder(candidates).slice(0, count);
}

// =====================================================================
// §9.1 — summary staleness
// =====================================================================

/**
 * §9.1 — does a memory's summary need (re)generating? True when the body is long
 * enough to be worth compressing AND there is no usable summary yet: either
 * empty, or so long relative to the body that it saves nothing under pressure.
 * The `summarise.memory` task acts on this; with no LLM provider configured the
 * task is a graceful no-op and the flag simply stays true (embeddings/LLM are a
 * plug-in, not a dependency — Volume X §11).
 */
export function needsSummary(p: { bodyChars: number; summaryChars: number }): boolean {
  if (p.bodyChars < SUMMARY_MIN_BODY_CHARS) return false;
  if (p.summaryChars === 0) return true;
  return p.summaryChars >= p.bodyChars * SUMMARY_MAX_RATIO;
}

// =====================================================================
// §9.3 — deduplication keeper selection
// =====================================================================

export type DedupeContender = {
  id: string;
  /** Epistemic confidence 0..100 (hq_memories.confidence). */
  confidence: number;
  /** Creation time in ms. */
  createdAtMs: number;
};

/**
 * §9.3 — of a near-duplicate PAIR, which memory SURVIVES the merge? Keep the
 * highest-confidence memory; on a tie keep the most recently created ("keep the
 * highest-confidence/latest", Volume X §9.3); on a further tie keep the
 * lexicographically-smaller id so the choice is stable + reproducible. The other
 * is superseded (archived, references relinked, versioned — reversible).
 */
export function chooseDedupeKeeper(
  a: DedupeContender,
  b: DedupeContender,
): { keepId: string; dropId: string } {
  const aWins =
    a.confidence !== b.confidence
      ? a.confidence > b.confidence
      : a.createdAtMs !== b.createdAtMs
        ? a.createdAtMs > b.createdAtMs
        : a.id <= b.id;
  return aWins ? { keepId: a.id, dropId: b.id } : { keepId: b.id, dropId: a.id };
}

export type { EvictionCandidate } from "./retrieval";
