import { describe, it, expect } from "vitest";
import {
  deriveConfidence,
  deriveEta,
  deriveHealth,
  derivePipeline,
  deriveEmployeeCards,
  type BoardroomTask,
} from "@/lib/hq/boardroom-cards";

/**
 * Unit proofs for the AI Boardroom card derivations (Confidence / ETA / Health +
 * the product pipeline summary). Pure functions, deterministic under an injected
 * `now` — every value below is asserted EXACTLY, including the honest
 * "insufficient / not green" states the mandate requires on absent data.
 */

const NOW = new Date("2026-08-01T12:00:00.000Z");

function mk(over: Partial<BoardroomTask> = {}): BoardroomTask {
  return {
    status: "pending",
    verification: null,
    result: null,
    deadline_at: null,
    lease_expires_at: null,
    heartbeat_at: null,
    retry_count: 0,
    max_retries: 3,
    pipeline_stage: null,
    ...over,
  };
}

// Relative helpers for readable fixtures.
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

// =====================================================================
// Confidence — share of verified/passed vs failed; insufficient if none.
// =====================================================================

describe("deriveConfidence", () => {
  it("is INSUFFICIENT (not green) when no task carries a verdict", () => {
    const c = deriveConfidence([mk({ status: "pending" }), mk({ status: "running" })]);
    expect(c).toEqual({ level: "insufficient", pct: null, passed: 0, failed: 0, sample: 0 });
  });

  it("reads the verification jsonb first (verified/passed/status shapes)", () => {
    const c = deriveConfidence([
      mk({ status: "running", verification: { verified: true } }), // pass
      mk({ status: "running", verification: { passed: false } }), // fail
      mk({ status: "pending", verification: { status: "verified" } }), // pass
      mk({ status: "pending", verification: { status: "rejected" } }), // fail
    ]);
    // 2 pass / 4 → 50% → medium
    expect(c).toEqual({ level: "medium", pct: 50, passed: 2, failed: 2, sample: 4 });
  });

  it("falls back to the terminal execution outcome when verification is absent", () => {
    const c = deriveConfidence([
      mk({ status: "completed" }), // pass
      mk({ status: "completed" }), // pass
      mk({ status: "completed" }), // pass
      mk({ status: "failed" }), // fail
      mk({ status: "cancelled" }), // no signal
      mk({ status: "running" }), // no signal
    ]);
    // 3 pass / 4 → 75% → medium
    expect(c).toEqual({ level: "medium", pct: 75, passed: 3, failed: 1, sample: 4 });
  });

  it("verification OVERRIDES the terminal status (a completed-but-unverified fail)", () => {
    const c = deriveConfidence([mk({ status: "completed", verification: { verified: false } })]);
    expect(c).toEqual({ level: "low", pct: 0, passed: 0, failed: 1, sample: 1 });
  });

  it("bands: >=80 high, >=50 medium, else low", () => {
    expect(deriveConfidence([mk({ status: "completed" })]).level).toBe("high"); // 100
    expect(
      deriveConfidence([
        mk({ status: "completed" }),
        mk({ status: "completed" }),
        mk({ status: "completed" }),
        mk({ status: "completed" }),
        mk({ status: "failed" }),
      ]).level,
    ).toBe("high"); // 80
    expect(
      deriveConfidence([mk({ status: "completed" }), mk({ status: "failed" })]).level,
    ).toBe("medium"); // 50
    expect(
      deriveConfidence([
        mk({ status: "completed" }),
        mk({ status: "failed" }),
        mk({ status: "failed" }),
        mk({ status: "failed" }),
      ]).level,
    ).toBe("low"); // 25
  });
});

// =====================================================================
// ETA — nearest deadline among ACTIVE tasks; insufficient if none.
// =====================================================================

describe("deriveEta", () => {
  it("is INSUFFICIENT when no active task carries a deadline", () => {
    const e = deriveEta([mk({ status: "pending" }), mk({ status: "completed", deadline_at: iso(HOUR) })], NOW);
    expect(e).toEqual({ level: "insufficient", at: null, overdue: false, activeWithDeadline: 0 });
  });

  it("picks the NEAREST future deadline among active tasks", () => {
    const e = deriveEta(
      [
        mk({ status: "pending", deadline_at: iso(24 * HOUR) }),
        mk({ status: "running", deadline_at: iso(6 * HOUR) }), // nearest
        mk({ status: "running", deadline_at: iso(12 * HOUR) }),
      ],
      NOW,
    );
    expect(e.level).toBe("scheduled");
    expect(e.overdue).toBe(false);
    expect(e.at).toBe(iso(6 * HOUR));
    expect(e.activeWithDeadline).toBe(3);
  });

  it("flags OVERDUE when the nearest active deadline is in the past", () => {
    const e = deriveEta(
      [
        mk({ status: "running", deadline_at: iso(-2 * HOUR) }), // overdue, nearest
        mk({ status: "pending", deadline_at: iso(HOUR) }),
      ],
      NOW,
    );
    expect(e.level).toBe("overdue");
    expect(e.overdue).toBe(true);
    expect(e.at).toBe(iso(-2 * HOUR));
    expect(e.activeWithDeadline).toBe(2);
  });

  it("ignores deadlines on TERMINAL tasks (they are not an outlook)", () => {
    const e = deriveEta(
      [
        mk({ status: "failed", deadline_at: iso(-10 * HOUR) }),
        mk({ status: "completed", deadline_at: iso(-5 * HOUR) }),
        mk({ status: "running", deadline_at: iso(3 * HOUR) }),
      ],
      NOW,
    );
    expect(e.at).toBe(iso(3 * HOUR));
    expect(e.activeWithDeadline).toBe(1);
  });
});

// =====================================================================
// Health — lease/heartbeat staleness + retries + failed ratio.
// =====================================================================

describe("deriveHealth", () => {
  it("is INSUFFICIENT (not green) with no tasks at all", () => {
    expect(deriveHealth([], NOW).level).toBe("insufficient");
  });

  it("is RED when a running task's lease has expired (worker stalled)", () => {
    const h = deriveHealth([mk({ status: "running", lease_expires_at: iso(-1 * MIN) })], NOW);
    expect(h.level).toBe("red");
    expect(h.reasons.join(" ")).toMatch(/expired lease/);
  });

  it("is RED when a running task has not heartbeat for over 15 minutes", () => {
    const h = deriveHealth([mk({ status: "running", heartbeat_at: iso(-20 * MIN) })], NOW);
    expect(h.level).toBe("red");
  });

  it("is RED when at least half of finished tasks failed", () => {
    const h = deriveHealth([mk({ status: "completed" }), mk({ status: "failed" })], NOW);
    expect(h.level).toBe("red"); // 50%
  });

  it("is RED when an active task is on retry #3+", () => {
    const h = deriveHealth([mk({ status: "pending", retry_count: 3 })], NOW);
    expect(h.level).toBe("red");
  });

  it("is AMBER on a slow (5–15m) heartbeat", () => {
    const h = deriveHealth([mk({ status: "running", heartbeat_at: iso(-8 * MIN) })], NOW);
    expect(h.level).toBe("amber");
  });

  it("is AMBER on a moderate failed ratio (20–50%) and a single retry", () => {
    const ratio = deriveHealth(
      [
        mk({ status: "completed" }),
        mk({ status: "completed" }),
        mk({ status: "completed" }),
        mk({ status: "failed" }),
      ],
      NOW,
    );
    expect(ratio.level).toBe("amber"); // 25%
    expect(deriveHealth([mk({ status: "running", retry_count: 1 })], NOW).level).toBe("amber");
  });

  it("is GREEN when leases are fresh, no retries, and failures are low", () => {
    const h = deriveHealth(
      [
        mk({ status: "running", lease_expires_at: iso(5 * MIN), heartbeat_at: iso(-1 * MIN) }),
        mk({ status: "completed" }),
        mk({ status: "completed" }),
      ],
      NOW,
    );
    expect(h.level).toBe("green");
  });
});

// =====================================================================
// Pipeline summary — the product axis among ACTIVE tasks.
// =====================================================================

describe("derivePipeline", () => {
  it("reports the FURTHEST-ALONG active stage and per-stage counts", () => {
    const p = derivePipeline([
      mk({ status: "running", pipeline_stage: "engineering" }),
      mk({ status: "pending", pipeline_stage: "testing" }), // furthest
      mk({ status: "running", pipeline_stage: "engineering" }),
    ]);
    expect(p.current).toBe("testing");
    expect(p.staged).toBe(3);
    expect(p.counts).toEqual({ engineering: 2, testing: 1 });
  });

  it("counts only ACTIVE tasks — a completed staged task is not the outlook", () => {
    const p = derivePipeline([
      mk({ status: "completed", pipeline_stage: "deployment" }),
      mk({ status: "running", pipeline_stage: "design" }),
    ]);
    expect(p.current).toBe("design");
    expect(p.staged).toBe(1);
  });

  it("is empty (current null) when nothing active is staged", () => {
    const p = derivePipeline([mk({ status: "pending" }), mk({ status: "completed", pipeline_stage: "review" })]);
    expect(p.current).toBeNull();
    expect(p.staged).toBe(0);
    expect(p.counts).toEqual({});
  });
});

// =====================================================================
// The aggregate entry point.
// =====================================================================

describe("deriveEmployeeCards", () => {
  it("assembles all four views, all insufficient/empty on an empty roster", () => {
    const cards = deriveEmployeeCards([], NOW);
    expect(cards.confidence.level).toBe("insufficient");
    expect(cards.eta.level).toBe("insufficient");
    expect(cards.health.level).toBe("insufficient");
    expect(cards.pipeline.current).toBeNull();
  });
});
