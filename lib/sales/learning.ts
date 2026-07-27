/**
 * CrewFlow HQ — Sales Learning Engine, pure learning model (CEO Directive
 * 004, Phase 7).
 *
 * Server/client-safe. NO Supabase / server-only imports. The Learning Engine
 * renders its distilled winning patterns, its by-type breakdown and its
 * headline effectiveness from these pure functions, so this module owns the
 * learning vocabulary (pattern types, channels, lifecycle), the confidence
 * tone the UI pills use, and the window roll-up maths.
 *
 * FOUNDATION ONLY. Nothing here captures, scores, or applies a learning; it
 * classifies and aggregates learning rows that already exist in the
 * permanent, audited hq_sales_learnings table. Win-rate and usage are
 * computed only from real, logged use — a pattern earns its numbers, they
 * are never faked.
 */

import { pct } from "./model";

// Re-export the percentage helper so the Learning Engine page and its tests
// share a single import surface.
export { pct };

// ---------------------------------------------------------------------
// Vocabulary — mirrors the hq_sales_learnings CHECK constraints exactly,
// in display order.
// ---------------------------------------------------------------------

/** The winning-pattern taxonomy from the directive. */
export const PATTERN_TYPES = [
  "cold_call",
  "email",
  "linkedin",
  "objection",
  "discovery",
  "demo",
  "close",
  "follow_up",
  "voicemail",
  "referral",
  "other",
] as const;
export type PatternType = (typeof PATTERN_TYPES)[number];

export const PATTERN_TYPE_LABELS: Record<PatternType, string> = {
  cold_call: "Cold call",
  email: "Email",
  linkedin: "LinkedIn",
  objection: "Objection",
  discovery: "Discovery",
  demo: "Demo",
  close: "Close",
  follow_up: "Follow-up",
  voicemail: "Voicemail",
  referral: "Referral",
  other: "Other",
};

export function patternTypeLabel(t: string): string {
  return PATTERN_TYPE_LABELS[t as PatternType] ?? t;
}

/**
 * Optional comms channel a pattern applies to — forward-compatible with the
 * Communication Centre's channel set. `null` means channel-agnostic.
 */
export const LEARNING_CHANNELS = [
  "phone",
  "email",
  "linkedin",
  "instagram",
  "whatsapp",
  "sms",
  "facebook",
  "in_person",
  "other",
] as const;
export type LearningChannel = (typeof LEARNING_CHANNELS)[number];

export const LEARNING_CHANNEL_LABELS: Record<LearningChannel, string> = {
  phone: "Phone",
  email: "Email",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  sms: "SMS",
  facebook: "Facebook",
  in_person: "In person",
  other: "Other",
};

/** Label for a (possibly null) channel — null renders as "Any channel". */
export function learningChannelLabel(c: string | null): string {
  if (c == null) return "Any channel";
  return LEARNING_CHANNEL_LABELS[c as LearningChannel] ?? c;
}

/** Shared draft/active/archived lifecycle (mirrors the playbook lifecycle). */
export const LEARNING_STATUSES = ["draft", "active", "archived"] as const;
export type LearningStatus = (typeof LEARNING_STATUSES)[number];

export const LEARNING_STATUS_LABELS: Record<LearningStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

export function learningStatusLabel(s: string): string {
  return LEARNING_STATUS_LABELS[s as LearningStatus] ?? s;
}

// ---------------------------------------------------------------------
// Confidence tone — maps a 0–100 belief to a pill colour token (the page
// owns the classes). Mirrors calling.ts's CallTone vocabulary.
// ---------------------------------------------------------------------

export type LearningTone = "positive" | "neutral" | "negative";

/**
 * A learning's confidence band as a tone:
 *   ≥ 70 → positive (a strong prior), ≥ 40 → neutral, else negative.
 * A null confidence is neutral (unrated, not bad).
 */
export function confidenceTone(confidence: number | null | undefined): LearningTone {
  if (confidence == null || !Number.isFinite(confidence)) return "neutral";
  if (confidence >= 70) return "positive";
  if (confidence >= 40) return "neutral";
  return "negative";
}

/** Short band label for a confidence value ("High" / "Medium" / "Low" / "—"). */
export function confidenceLabel(confidence: number | null | undefined): string {
  if (confidence == null || !Number.isFinite(confidence)) return "—";
  if (confidence >= 70) return "High";
  if (confidence >= 40) return "Medium";
  return "Low";
}

// ---------------------------------------------------------------------
// Window roll-up — turns a list of learnings into the headline stats.
// ---------------------------------------------------------------------

/** The minimal shape summariseLearnings needs — a subset of SalesLearning. */
export type LearningSummaryInput = {
  status: string;
  pattern_type: string;
  confidence: number | null;
  times_used: number;
  times_won: number;
  memory_id: string | null;
  updated_at: string | null;
};

/** A vocabulary entry rolled up with its count (always includes zeros). */
export type LearningFacet = {
  slug: string;
  label: string;
  count: number;
};

export type LearningStats = {
  total: number;
  /** Learnings in the active lifecycle state. */
  active: number;
  /** One entry per pattern type, in display order — includes zero counts. */
  byType: LearningFacet[];
  /** Mean confidence over learnings that carry one, whole number, or null. */
  avgConfidence: number | null;
  /** Total real, logged uses across all learnings. */
  totalUses: number;
  /** Total logged wins across all learnings. */
  totalWins: number;
  /** Blended win rate — totalWins ÷ totalUses, 0–100 to 1 d.p. */
  blendedWinRate: number;
  /** Learnings promoted into the company-wide Shared Memory engine. */
  promoted: number;
  /** Most recent update time across the window. */
  lastUpdatedAt: string | null;
};

function laterIso(a: string | null, b: string | null): string | null {
  if (!b) return a;
  if (!a) return b;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

export function summariseLearnings(
  rows: ReadonlyArray<LearningSummaryInput>,
): LearningStats {
  const typeCounts = new Map<string, number>();
  for (const t of PATTERN_TYPES) typeCounts.set(t, 0);

  let total = 0;
  let active = 0;
  let totalUses = 0;
  let totalWins = 0;
  let promoted = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let lastUpdatedAt: string | null = null;

  for (const r of rows) {
    total += 1;
    if (r.status === "active") active += 1;
    if (r.memory_id != null) promoted += 1;

    typeCounts.set(r.pattern_type, (typeCounts.get(r.pattern_type) ?? 0) + 1);

    if (typeof r.times_used === "number" && r.times_used > 0) {
      totalUses += r.times_used;
    }
    if (typeof r.times_won === "number" && r.times_won > 0) {
      totalWins += r.times_won;
    }

    if (typeof r.confidence === "number" && Number.isFinite(r.confidence)) {
      confidenceSum += r.confidence;
      confidenceCount += 1;
    }

    lastUpdatedAt = laterIso(lastUpdatedAt, r.updated_at);
  }

  const byType: LearningFacet[] = PATTERN_TYPES.map((slug) => ({
    slug,
    label: PATTERN_TYPE_LABELS[slug],
    count: typeCounts.get(slug) ?? 0,
  }));

  return {
    total,
    active,
    byType,
    avgConfidence:
      confidenceCount > 0 ? Math.round(confidenceSum / confidenceCount) : null,
    totalUses,
    totalWins,
    blendedWinRate: pct(totalWins, totalUses),
    promoted,
    lastUpdatedAt,
  };
}
