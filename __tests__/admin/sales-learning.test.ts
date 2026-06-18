import { describe, it, expect } from "vitest";
import {
  LEARNING_CHANNELS,
  LEARNING_STATUSES,
  PATTERN_TYPES,
  confidenceLabel,
  confidenceTone,
  learningChannelLabel,
  learningStatusLabel,
  patternTypeLabel,
  summariseLearnings,
  type LearningSummaryInput,
} from "@/lib/sales/learning";

/**
 * CrewFlow HQ — Sales Learning Engine model tests (CEO Directive 004,
 * Phase 7).
 *
 * The Learning Engine renders its distilled winning patterns, its by-type
 * breakdown and its headline effectiveness from these pure functions, so the
 * tests pin the learning vocabulary + labels, the confidence tone/band
 * mapping the pills use, and the window roll-up maths (blended win-rate,
 * average confidence, promotion count, latest update).
 */

function learning(
  over: Partial<LearningSummaryInput> = {},
): LearningSummaryInput {
  return {
    status: "active",
    pattern_type: "cold_call",
    confidence: null,
    times_used: 0,
    times_won: 0,
    memory_id: null,
    updated_at: null,
    ...over,
  };
}

describe("learning — vocabulary + labels", () => {
  it("mirrors the DB CHECK constraints exactly", () => {
    expect(PATTERN_TYPES).toHaveLength(11);
    expect(LEARNING_CHANNELS).toHaveLength(9);
    expect(LEARNING_STATUSES).toHaveLength(3);
  });

  it("labels every pattern type, channel and status", () => {
    expect(patternTypeLabel("cold_call")).toBe("Cold call");
    expect(patternTypeLabel("linkedin")).toBe("LinkedIn");
    expect(patternTypeLabel("follow_up")).toBe("Follow-up");
    expect(learningChannelLabel("phone")).toBe("Phone");
    expect(learningChannelLabel("in_person")).toBe("In person");
    expect(learningChannelLabel(null)).toBe("Any channel");
    expect(learningStatusLabel("archived")).toBe("Archived");
  });

  it("falls back to the raw slug for unknown values", () => {
    expect(patternTypeLabel("pigeon")).toBe("pigeon");
    expect(learningChannelLabel("pigeon")).toBe("pigeon");
    expect(learningStatusLabel("pigeon")).toBe("pigeon");
  });
});

describe("learning — confidence tone + band", () => {
  it("tones a confidence for its pill", () => {
    expect(confidenceTone(80)).toBe("positive");
    expect(confidenceTone(70)).toBe("positive");
    expect(confidenceTone(69)).toBe("neutral");
    expect(confidenceTone(40)).toBe("neutral");
    expect(confidenceTone(39)).toBe("negative");
    expect(confidenceTone(null)).toBe("neutral");
    expect(confidenceTone(Number.NaN)).toBe("neutral");
  });

  it("bands a confidence into a short label", () => {
    expect(confidenceLabel(80)).toBe("High");
    expect(confidenceLabel(70)).toBe("High");
    expect(confidenceLabel(50)).toBe("Medium");
    expect(confidenceLabel(40)).toBe("Medium");
    expect(confidenceLabel(39)).toBe("Low");
    expect(confidenceLabel(null)).toBe("—");
  });
});

describe("learning — summariseLearnings", () => {
  const rows: LearningSummaryInput[] = [
    // Active, promoted, proven cold-call play.
    learning({
      status: "active",
      pattern_type: "cold_call",
      confidence: 80,
      times_used: 10,
      times_won: 4,
      memory_id: "m1",
      updated_at: "2026-06-17T09:00:00.000Z",
    }),
    // Active email play, most-used, not promoted.
    learning({
      status: "active",
      pattern_type: "email",
      confidence: 60,
      times_used: 20,
      times_won: 6,
      updated_at: "2026-06-18T08:00:00.000Z",
    }),
    // Draft objection prior — authored, never used yet.
    learning({
      status: "draft",
      pattern_type: "objection",
      confidence: 40,
      updated_at: "2026-06-16T09:00:00.000Z",
    }),
    // Archived cold-call play — promoted, no confidence recorded.
    learning({
      status: "archived",
      pattern_type: "cold_call",
      confidence: null,
      times_used: 5,
      times_won: 1,
      memory_id: "m2",
      updated_at: "2026-06-15T09:00:00.000Z",
    }),
    // Active demo prior — high confidence, latest update, no usage.
    learning({
      status: "active",
      pattern_type: "demo",
      confidence: 90,
      updated_at: "2026-06-18T10:00:00.000Z",
    }),
  ];
  const stats = summariseLearnings(rows);

  it("rolls up the headline counts", () => {
    expect(stats.total).toBe(5);
    expect(stats.active).toBe(3); // two active priors + the proven email play
    expect(stats.promoted).toBe(2); // the two with a memory_id bridge
  });

  it("blends usage and wins across the window", () => {
    expect(stats.totalUses).toBe(35); // 10 + 20 + 0 + 5 + 0
    expect(stats.totalWins).toBe(11); // 4 + 6 + 0 + 1 + 0
    expect(stats.blendedWinRate).toBe(31.4); // 11 / 35 → 31.4%
  });

  it("averages confidence only over learnings that carry one", () => {
    // 80 + 60 + 40 + 90 = 270 over 4 (the null is excluded) → round(67.5).
    expect(stats.avgConfidence).toBe(68);
  });

  it("reports every pattern type, including the silent ones", () => {
    expect(stats.byType).toHaveLength(PATTERN_TYPES.length);
    expect(stats.byType.find((t) => t.slug === "cold_call")?.count).toBe(2);
    expect(stats.byType.find((t) => t.slug === "email")?.count).toBe(1);
    expect(stats.byType.find((t) => t.slug === "demo")?.count).toBe(1);
    expect(stats.byType.find((t) => t.slug === "voicemail")?.count).toBe(0);
    expect(stats.byType.reduce((n, t) => n + t.count, 0)).toBe(5);
  });

  it("tracks the most recent update time", () => {
    expect(stats.lastUpdatedAt).toBe("2026-06-18T10:00:00.000Z");
  });

  it("is safe on an empty window", () => {
    const empty = summariseLearnings([]);
    expect(empty.total).toBe(0);
    expect(empty.active).toBe(0);
    expect(empty.blendedWinRate).toBe(0);
    expect(empty.avgConfidence).toBeNull();
    expect(empty.promoted).toBe(0);
    expect(empty.lastUpdatedAt).toBeNull();
    expect(empty.byType).toHaveLength(PATTERN_TYPES.length);
  });
});
