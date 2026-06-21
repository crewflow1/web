/**
 * CrewFlow HQ — Shared Memory: the pure retrieval engine
 * (CrewFlow Bible, Volume X §7–§10; CEO Directive 009, Module 1).
 *
 * Server/client-safe. ZERO I/O — no Supabase, no model provider, nothing
 * async. This module holds the four pure cores the Volume X retrieval
 * pipeline is built from, so each is unit-testable without a database:
 *
 *   §7.3  scoreCandidate   — the blended ranking score
 *   §10   effectiveScore   — the episodic decay model + eviction order
 *   §8    assembleContext  — the token-budget knapsack (summarise, never truncate)
 *   §7.4  diversify        — dedupe + MMR-style spread
 *
 * The SQL entry point hq_memory_recall (PR3) performs the permissioned,
 * indexed reads (stage 1–2); this module performs the deterministic maths
 * over the candidates it returns (stage 3–5). Keeping the maths here — pure
 * and typed — is what lets the security gate prove "permission before
 * scoring" and the unit gate prove the ranking without a live pgvector.
 */

import { MEMORY_CLASSES, type MemoryClass } from "./model";

// =====================================================================
// Primitive helpers
// =====================================================================

/**
 * Cheap, model-agnostic token estimate. The ≈4-chars-per-token heuristic
 * is deliberately conservative and deterministic; the SDK swaps in the
 * model's real tokenizer at assembly time (Volume X §8), but the knapsack
 * logic is identical and is what we unit-test here.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Exponential decay in [0, 1]: 1 at age 0, → 0 as age ≫ τ. τ in ms. */
export function exponentialDecay(ageMs: number, tauMs: number): number {
  if (ageMs <= 0) return 1;
  if (tauMs <= 0) return 0;
  return Math.exp(-ageMs / tauMs);
}

/** Cosine similarity of two equal-length vectors, in [-1, 1]. 0 if degenerate. */
export function cosineSimilarity(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Clamp to [lo, hi]. */
export function clamp(x: number, lo = 0, hi = 1): number {
  return x < lo ? lo : x > hi ? hi : x;
}

const DAY_MS = 86_400_000;

// =====================================================================
// §7.3 — the blended ranking score
// =====================================================================

export type ScoreWeights = {
  semantic: number; // w_sem · cosine similarity
  lexical: number; // w_lex · full-text rank
  recency: number; // w_rec · time decay
  salience: number; // w_sal · salience/100
  importance: number; // w_imp · importance rank
  popularity: number; // w_pop · log(access count)
  pinned: number; // w_pin · pinned flag
  structural: number; // w_rel · relationship-graph match
};

/**
 * Per-class default weights (Volume X §7.3: "weights are per-class &
 * tunable"). Semantic/long_term/procedural lean on meaning + lexical match
 * and barely decay; episodic/working lean on recency + salience.
 * A future directive can move these into a tunable settings row without a
 * code change — they live here as the documented defaults.
 */
export const DEFAULT_WEIGHTS_BY_CLASS: Record<MemoryClass, ScoreWeights> = {
  semantic: { semantic: 0.34, lexical: 0.24, recency: 0.04, salience: 0.06, importance: 0.14, popularity: 0.08, pinned: 0.06, structural: 0.04 },
  long_term: { semantic: 0.34, lexical: 0.20, recency: 0.04, salience: 0.08, importance: 0.16, popularity: 0.08, pinned: 0.06, structural: 0.04 },
  procedural: { semantic: 0.30, lexical: 0.22, recency: 0.04, salience: 0.10, importance: 0.16, popularity: 0.08, pinned: 0.06, structural: 0.04 },
  episodic: { semantic: 0.22, lexical: 0.16, recency: 0.26, salience: 0.16, importance: 0.06, popularity: 0.04, pinned: 0.04, structural: 0.06 },
  working: { semantic: 0.16, lexical: 0.12, recency: 0.34, salience: 0.22, importance: 0.04, popularity: 0.02, pinned: 0.04, structural: 0.06 },
};

/**
 * Recency half-life per class (ms). Durable knowledge effectively never
 * decays in the score; lived experience fades on the order of days.
 */
export const RECENCY_HALF_LIFE_MS: Record<MemoryClass, number> = {
  semantic: 3650 * DAY_MS,
  long_term: 3650 * DAY_MS,
  procedural: 3650 * DAY_MS,
  episodic: 30 * DAY_MS,
  working: 1 * DAY_MS,
};

/** Access count at which the popularity term saturates to ~1. */
const POPULARITY_SATURATION = 200;

export type CandidateSignals = {
  memoryClass: MemoryClass;
  /** Semantic similarity in [0,1]. Undefined until embeddings are switched on (PR4) → treated as 0. */
  cosSim?: number;
  /** Normalised lexical rank in [0,1] (ts_rank, scaled by the caller). */
  tsRank?: number;
  /** Age of the memory in ms (now − created/reinforced). Drives the recency term. */
  ageMs?: number;
  /** Salience 0..100. */
  salience?: number;
  /** Importance rank 0..3 (low..critical), per model.importanceRank(). */
  importanceRank?: number;
  /** Lifetime access count (popularity signal). */
  accessCount?: number;
  /** Pinned memory gets a floor-boost (Volume X §7.3 "pinned/critical floor-boost"). */
  pinned?: boolean;
  /** Structural match to the task subject in [0,1] (graph relationship). */
  structuralMatch?: number;
};

/**
 * The single blended score for one candidate (Volume X §7.3):
 *
 *   score = w_sem·cos + w_lex·ts + w_rec·recency + w_sal·(sal/100)
 *         + w_imp·(impRank/3) + w_pop·logPop + w_pin·pinned + w_rel·structural
 *
 * All terms are normalised to [0,1] before weighting, so the score is in
 * [0,1] for default weights (which sum to ~1). Pinned candidates are floored
 * so a hand-pinned memory always out-ranks unpinned noise.
 */
export function scoreCandidate(
  s: CandidateSignals,
  weights: ScoreWeights = DEFAULT_WEIGHTS_BY_CLASS[s.memoryClass],
): number {
  const cos = clamp(s.cosSim ?? 0);
  const lex = clamp(s.tsRank ?? 0);
  const recency = exponentialDecay(s.ageMs ?? 0, RECENCY_HALF_LIFE_MS[s.memoryClass]);
  const sal = clamp((s.salience ?? 50) / 100);
  const imp = clamp((s.importanceRank ?? 1) / 3);
  const pop = clamp(Math.log1p(s.accessCount ?? 0) / Math.log1p(POPULARITY_SATURATION));
  const pin = s.pinned ? 1 : 0;
  const rel = clamp(s.structuralMatch ?? 0);

  const score =
    weights.semantic * cos +
    weights.lexical * lex +
    weights.recency * recency +
    weights.salience * sal +
    weights.importance * imp +
    weights.popularity * pop +
    weights.pinned * pin +
    weights.structural * rel;

  // Pinned floor-boost: a pinned memory never ranks below this floor, so a
  // deliberately pinned fact is always assembled ahead of unpinned matches.
  const PINNED_FLOOR = 0.8;
  return s.pinned ? Math.max(score, PINNED_FLOOR) : score;
}

// =====================================================================
// §10 — episodic decay + eviction order
// =====================================================================

/**
 * Effective retention score (Volume X §10):
 *
 *   effective = base · e^(−age/τ) · (salience/100) · reinforcement
 *
 * Used to decide which ephemeral (working/episodic) memories fade or are
 * evicted under storage pressure. Durable classes never call this — they
 * are the company brain and never auto-expire.
 */
export function effectiveScore(p: {
  base?: number;
  ageMs: number;
  tauMs: number;
  salience: number;
  reinforcement?: number;
}): number {
  const base = p.base ?? 1;
  const decay = exponentialDecay(p.ageMs, p.tauMs);
  const sal = clamp(p.salience / 100);
  const reinforcement = p.reinforcement ?? 1;
  return base * decay * sal * reinforcement;
}

export type EvictionCandidate = {
  id: string;
  memoryClass: MemoryClass;
  ageMs: number;
  tauMs: number;
  salience: number;
  reinforcement?: number;
  /** Episodic memory whose lesson is already preserved elsewhere may be archived. */
  consolidated?: boolean;
};

/**
 * Order ephemeral candidates for eviction under pressure — LOWEST effective
 * score first (Volume X §10). Durable classes are filtered out entirely:
 * shared knowledge is never evicted. Returns ids, lowest-value first.
 */
export function evictionOrder(candidates: ReadonlyArray<EvictionCandidate>): string[] {
  return candidates
    .filter((c) => c.memoryClass === "working" || c.memoryClass === "episodic")
    .map((c) => ({
      id: c.id,
      score: effectiveScore({
        ageMs: c.ageMs,
        tauMs: c.tauMs,
        salience: c.salience,
        reinforcement: c.reinforcement,
      }),
    }))
    .sort((a, b) => a.score - b.score)
    .map((c) => c.id);
}

// =====================================================================
// §7.4 — diversify + dedupe (MMR-style)
// =====================================================================

export type DiversifyItem = {
  id: string;
  score: number;
  /** Optional embedding for near-duplicate detection (cosine). */
  embedding?: ReadonlyArray<number>;
  /** Fine-grained type, for type-spread (avoid 10 paraphrases of one fact). */
  memoryType?: string;
  /** Version chain: a candidate superseded by an already-selected one is dropped. */
  supersededBy?: string | null;
};

export type DiversifyOptions = {
  /** Cosine above this = near-duplicate; drop the lower-scoring one. Default 0.95 (Volume X §7.4). */
  duplicateThreshold?: number;
  /** Soft cap of items per memory_type, to spread the context. Default 4. */
  maxPerType?: number;
  /** Hard cap on the returned set. Default Infinity. */
  limit?: number;
};

/**
 * Drop near-duplicates, prefer the latest version, and spread across types
 * (Volume X §7.4). Greedy over score-desc input: a candidate is skipped if
 * it is superseded by an already-selected item, a near-duplicate (cosine >
 * threshold) of one, or would exceed the per-type soft cap. Stable and pure.
 */
export function diversify(
  items: ReadonlyArray<DiversifyItem>,
  opts: DiversifyOptions = {},
): DiversifyItem[] {
  const duplicateThreshold = opts.duplicateThreshold ?? 0.95;
  const maxPerType = opts.maxPerType ?? 4;
  const limit = opts.limit ?? Infinity;

  const ranked = [...items].sort((a, b) => b.score - a.score);
  const selected: DiversifyItem[] = [];
  const selectedIds = new Set<string>();
  const typeCounts = new Map<string, number>();

  for (const cand of ranked) {
    if (selected.length >= limit) break;

    // Superseded by something already chosen → drop (keep the latest version).
    if (cand.supersededBy && selectedIds.has(cand.supersededBy)) continue;

    // Near-duplicate of an already-selected, higher-scoring item → drop.
    if (cand.embedding) {
      let isDup = false;
      for (const chosen of selected) {
        if (!chosen.embedding) continue;
        if (cosineSimilarity(cand.embedding, chosen.embedding) > duplicateThreshold) {
          isDup = true;
          break;
        }
      }
      if (isDup) continue;
    }

    // Type-spread soft cap.
    const type = cand.memoryType ?? "_";
    const count = typeCounts.get(type) ?? 0;
    if (count >= maxPerType) continue;

    selected.push(cand);
    selectedIds.add(cand.id);
    typeCounts.set(type, count + 1);
  }

  return selected;
}

// =====================================================================
// §8 — the token-budget knapsack
// =====================================================================

export type AssemblyItem = {
  id: string;
  /** Token cost of the FULL body. */
  tokens: number;
  /** Token cost of the stored summary, used under pressure (Volume X §8/§9). */
  summaryTokens?: number;
  /** Ranking score (from scoreCandidate). */
  score: number;
  /** Always-in context: the task's own working memory + pinned in-scope memories. */
  alwaysIn?: boolean;
};

export type AssemblyResult = {
  /** Ids included in FULL. */
  included: string[];
  /** Ids included as their SUMMARY (full did not fit, summary did). */
  summarised: string[];
  /** Ids that did not fit at all. */
  dropped: string[];
  tokensUsed: number;
  budget: number;
};

/**
 * Greedy knapsack assembly under a token budget (Volume X §8). Always-in
 * items (working memory + pinned) are packed first and are non-negotiable;
 * the rest are packed by score-desc — full body if it fits, else the summary
 * if THAT fits, else dropped (summarise, never truncate). Deterministic.
 */
export function assembleContext(
  items: ReadonlyArray<AssemblyItem>,
  budget: number,
): AssemblyResult {
  const included: string[] = [];
  const summarised: string[] = [];
  const dropped: string[] = [];
  let used = 0;

  const fits = (cost: number) => used + cost <= budget;

  const place = (item: AssemblyItem, force: boolean): void => {
    const summaryCost = item.summaryTokens ?? item.tokens;
    if (fits(item.tokens)) {
      included.push(item.id);
      used += item.tokens;
    } else if (fits(summaryCost) && summaryCost < item.tokens) {
      summarised.push(item.id);
      used += summaryCost;
    } else if (force) {
      // Always-in items must be present even if they bust the budget; we
      // include the cheaper of body/summary and let the caller see overflow.
      const cost = Math.min(item.tokens, summaryCost);
      if (cost < item.tokens) summarised.push(item.id);
      else included.push(item.id);
      used += cost;
    } else {
      dropped.push(item.id);
    }
  };

  // 1) Always-in tier first (never dropped).
  for (const item of items.filter((i) => i.alwaysIn)) place(item, true);

  // 2) The rest, highest score first.
  const rest = items.filter((i) => !i.alwaysIn).sort((a, b) => b.score - a.score);
  for (const item of rest) place(item, false);

  return { included, summarised, dropped, tokensUsed: used, budget };
}

// Re-exported so callers building candidates have the canonical class list.
export { MEMORY_CLASSES };
