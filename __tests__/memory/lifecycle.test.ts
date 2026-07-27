import { describe, it, expect } from "vitest";
import {
  DECAY_FLOOR,
  EPISODIC_DECAY_TAU_MS,
  MIN_CONSOLIDATION_SOURCES,
  SUMMARY_MIN_BODY_CHARS,
  DEDUPE_COSINE_THRESHOLD,
  memoryAgeMs,
  isTtlExpired,
  retentionScore,
  shouldArchiveEpisodic,
  evictionPlan,
  needsSummary,
  chooseDedupeKeeper,
} from "@/lib/memory/lifecycle";
import { effectiveScore } from "@/lib/memory/retrieval";

/**
 * Shared Memory — pure lifecycle-POLICY contract tests
 * (CrewFlow Bible Volume X §9–§10; CEO Directive 009 Module 1, PR5, gate 3).
 *
 * Proves the policy layer that the recurring §9/§10 tasks consult behaves to
 * spec WITHOUT a database: TTL/decay archival decisions, eviction ordering,
 * summary staleness, and dedup keeper selection. The SQL entry points
 * (hq_memory_expire_sweep/_consolidate/_dedupe_pairs/_supersede) mirror these
 * numbers; the security gate pins that SQL agrees with these constants.
 */

const days = (n: number): number => n * 86_400_000;
const NOW = Date.UTC(2026, 5, 22); // 2026-06-22, arbitrary fixed clock

// ---------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------

describe("lifecycle policy constants", () => {
  it("are the documented Volume X §9–§10 values", () => {
    expect(DECAY_FLOOR).toBe(0.05);
    expect(EPISODIC_DECAY_TAU_MS).toBe(days(30));
    expect(MIN_CONSOLIDATION_SOURCES).toBe(3);
    expect(SUMMARY_MIN_BODY_CHARS).toBe(1200);
    expect(DEDUPE_COSINE_THRESHOLD).toBe(0.95);
  });
});

// ---------------------------------------------------------------------
// §10 — age + TTL
// ---------------------------------------------------------------------

describe("memoryAgeMs — reinforcement enters via the age clock", () => {
  it("uses last_reinforced_at when present (recall resets the decay clock)", () => {
    const created = NOW - days(40);
    const reinforced = NOW - days(2);
    expect(memoryAgeMs({ createdAtMs: created, lastReinforcedAtMs: reinforced, now: NOW })).toBe(days(2));
  });

  it("falls back to created_at when never reinforced", () => {
    const created = NOW - days(40);
    expect(memoryAgeMs({ createdAtMs: created, lastReinforcedAtMs: null, now: NOW })).toBe(days(40));
  });

  it("never returns a negative age (clock skew safe)", () => {
    expect(memoryAgeMs({ createdAtMs: NOW + days(1), lastReinforcedAtMs: null, now: NOW })).toBe(0);
  });
});

describe("isTtlExpired", () => {
  it("null expiry never expires (the durable company brain)", () => {
    expect(isTtlExpired({ expiresAtMs: null, now: NOW })).toBe(false);
  });
  it("future expiry is alive, past/equal expiry is expired", () => {
    expect(isTtlExpired({ expiresAtMs: NOW + days(1), now: NOW })).toBe(false);
    expect(isTtlExpired({ expiresAtMs: NOW, now: NOW })).toBe(true);
    expect(isTtlExpired({ expiresAtMs: NOW - days(1), now: NOW })).toBe(true);
  });
});

// ---------------------------------------------------------------------
// §10 — retention score + episodic decay archival
// ---------------------------------------------------------------------

describe("retentionScore", () => {
  it("matches effectiveScore with the class half-life", () => {
    const ageMs = days(10);
    expect(retentionScore({ memoryClass: "episodic", ageMs, salience: 50 })).toBeCloseTo(
      effectiveScore({ ageMs, tauMs: EPISODIC_DECAY_TAU_MS, salience: 50 }),
      9,
    );
  });
  it("decays with age and scales with salience", () => {
    const young = retentionScore({ memoryClass: "episodic", ageMs: days(5), salience: 50 });
    const old = retentionScore({ memoryClass: "episodic", ageMs: days(60), salience: 50 });
    expect(old).toBeLessThan(young);
    const lowSal = retentionScore({ memoryClass: "episodic", ageMs: days(30), salience: 20 });
    const highSal = retentionScore({ memoryClass: "episodic", ageMs: days(30), salience: 90 });
    expect(highSal).toBeGreaterThan(lowSal);
  });
});

describe("shouldArchiveEpisodic — archive only when consolidated AND decayed", () => {
  it("NEVER archives an unconsolidated episode, however old (the lesson would be lost)", () => {
    expect(shouldArchiveEpisodic({ ageMs: days(3650), salience: 0, consolidated: false })).toBe(false);
  });

  it("archives a consolidated, decayed episode (salience 50 fades at ≈69d)", () => {
    // age 60d → score ≈ 0.0677 > floor → keep
    expect(shouldArchiveEpisodic({ ageMs: days(60), salience: 50, consolidated: true })).toBe(false);
    // age 80d → score ≈ 0.0347 < floor → archive
    expect(shouldArchiveEpisodic({ ageMs: days(80), salience: 50, consolidated: true })).toBe(true);
  });

  it("high salience keeps a consolidated episode alive longer", () => {
    // salience 100 at 80d still above floor (≈0.069); salience 50 at 80d is below.
    expect(shouldArchiveEpisodic({ ageMs: days(80), salience: 100, consolidated: true })).toBe(false);
    expect(shouldArchiveEpisodic({ ageMs: days(100), salience: 100, consolidated: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------
// §10 — eviction under pressure
// ---------------------------------------------------------------------

describe("evictionPlan", () => {
  const candidates = [
    { id: "work-low", memoryClass: "working" as const, ageMs: days(2), tauMs: EPISODIC_DECAY_TAU_MS, salience: 10 },
    { id: "epi-high", memoryClass: "episodic" as const, ageMs: days(1), tauMs: EPISODIC_DECAY_TAU_MS, salience: 90 },
    { id: "durable", memoryClass: "semantic" as const, ageMs: days(1), tauMs: EPISODIC_DECAY_TAU_MS, salience: 1 },
  ];

  it("returns nothing when there is no pressure", () => {
    expect(evictionPlan(candidates, 0)).toEqual([]);
    expect(evictionPlan(candidates, -3)).toEqual([]);
  });

  it("never evicts a durable company-brain class", () => {
    expect(evictionPlan(candidates, 99)).not.toContain("durable");
  });

  it("evicts the lowest effective-score ephemeral first, capped at the count", () => {
    expect(evictionPlan(candidates, 1)).toEqual(["work-low"]);
    expect(evictionPlan(candidates, 99)).toEqual(["work-low", "epi-high"]);
  });
});

// ---------------------------------------------------------------------
// §9.1 — summary staleness
// ---------------------------------------------------------------------

describe("needsSummary", () => {
  it("a short body never needs a separate summary", () => {
    expect(needsSummary({ bodyChars: 500, summaryChars: 0 })).toBe(false);
    expect(needsSummary({ bodyChars: SUMMARY_MIN_BODY_CHARS - 1, summaryChars: 0 })).toBe(false);
  });
  it("a long body with no summary needs one", () => {
    expect(needsSummary({ bodyChars: 2000, summaryChars: 0 })).toBe(true);
    expect(needsSummary({ bodyChars: SUMMARY_MIN_BODY_CHARS, summaryChars: 0 })).toBe(true);
  });
  it("a long body with a genuinely shorter summary is satisfied", () => {
    expect(needsSummary({ bodyChars: 2000, summaryChars: 300 })).toBe(false);
  });
  it("a 'summary' nearly as long as the body is not a summary → refresh", () => {
    expect(needsSummary({ bodyChars: 2000, summaryChars: 1300 })).toBe(true); // 65% ≥ 60%
  });
});

// ---------------------------------------------------------------------
// §9.3 — dedup keeper selection
// ---------------------------------------------------------------------

describe("chooseDedupeKeeper — keep highest-confidence, then latest, then stable", () => {
  it("keeps the higher-confidence memory", () => {
    expect(
      chooseDedupeKeeper(
        { id: "a", confidence: 80, createdAtMs: NOW },
        { id: "b", confidence: 90, createdAtMs: NOW - days(10) },
      ),
    ).toEqual({ keepId: "b", dropId: "a" });
  });

  it("on a confidence tie, keeps the most recently created", () => {
    expect(
      chooseDedupeKeeper(
        { id: "a", confidence: 80, createdAtMs: NOW },
        { id: "b", confidence: 80, createdAtMs: NOW - days(10) },
      ),
    ).toEqual({ keepId: "a", dropId: "b" });
  });

  it("on a full tie, the choice is stable (smaller id) and order-independent", () => {
    const x = { id: "aaa", confidence: 80, createdAtMs: NOW };
    const y = { id: "bbb", confidence: 80, createdAtMs: NOW };
    expect(chooseDedupeKeeper(x, y)).toEqual({ keepId: "aaa", dropId: "bbb" });
    expect(chooseDedupeKeeper(y, x)).toEqual({ keepId: "aaa", dropId: "bbb" });
  });
});
