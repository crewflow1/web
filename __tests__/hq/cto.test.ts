import { describe, it, expect } from "vitest";
import {
  computeCtoBoard,
  CTO_KIND_LABEL,
  type CtoBoard,
  type CtoInput,
  type CtoMetric,
} from "@/lib/hq/cto";
import type { BoardroomTask } from "@/lib/hq/boardroom-cards";

/**
 * HQ CTO AI — pure engineering-health board contract.
 *
 * Pins:
 *   1. Deterministic composition: launch blockers/warnings, task failure ratio,
 *      retry pressure, stale leases, shadow divergence, AI-cost posture, and
 *      customer-health coverage are EXACT from fixtures, and the same inputs +
 *      `now` always give the same board.
 *   2. The honesty invariant: `value === null` IFF `kind === "insufficient"`.
 *      A source that could not be read → insufficient, never a fabricated zero.
 *   3. THE NO-DATA SOURCES: CI pass rate, deploy frequency, and platform uptime
 *      have NO source in the schema and are ALWAYS insufficient — even when every
 *      other signal is present. This is the explicit honesty requirement.
 *   4. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function task(overrides: Partial<BoardroomTask>): BoardroomTask {
  return {
    status: "completed",
    verification: null,
    result: null,
    deadline_at: null,
    lease_expires_at: null,
    heartbeat_at: null,
    retry_count: 0,
    max_retries: 3,
    pipeline_stage: null,
    ...overrides,
  };
}

// Two completed, one failed → finished = 3, failed = 1.
// One running with an EXPIRED lease (stale lease + red health).
// One running with retry_count 2, one pending with retry_count 1 → 2 active retrying.
const TASKS: BoardroomTask[] = [
  task({ status: "completed" }),
  task({ status: "completed" }),
  task({ status: "failed" }),
  task({ status: "running", lease_expires_at: iso(-60_000), heartbeat_at: iso(-30_000) }),
  task({ status: "running", lease_expires_at: iso(60_000), heartbeat_at: iso(-30_000), retry_count: 2 }),
  task({ status: "pending", retry_count: 1 }),
];

const FULL_INPUT: CtoInput = {
  launch: {
    overall: "red",
    redLabels: ["Required env vars", "Rate limiting"],
    amberLabels: ["Optional env vars"],
    greenCount: 5,
  },
  reliability: { tasks: TASKS },
  shadow: { planned: 8, refused: 2, error: 1 },
  aiCost: {
    committedPence: 0,
    reservedPence: 0,
    blockedOrgs: 0,
    overruns: 0,
    ceilingPence: 10_000,
    governorActivated: false,
  },
  health: { totalOrgs: 10, unscored: 3, critical: 2, atRisk: 4 },
};

function byKey(board: CtoBoard, key: string): CtoMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeCtoBoard — deterministic figures from fixtures", () => {
  const board = computeCtoBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("launch blockers/warnings are exact facts and list their labels", () => {
    const blockers = byKey(board, "launch_blockers");
    expect(blockers.kind).toBe("fact");
    expect(blockers.value).toBe(2);
    expect(blockers.basis).toContain("Required env vars");
    expect(blockers.basis).toContain("Rate limiting");

    const warnings = byKey(board, "launch_warnings");
    expect(warnings.value).toBe(1);
    expect(warnings.basis).toContain("Optional env vars");

    expect(board.launch).toEqual({
      overall: "red",
      blockers: ["Required env vars", "Rate limiting"],
      warnings: ["Optional env vars"],
    });
  });

  it("task failure ratio is derived exactly (1 failed of 3 finished)", () => {
    const ratio = byKey(board, "task_failure_ratio");
    expect(ratio.kind).toBe("derived");
    expect(ratio.value).toBe(33.3);
    expect(ratio.format).toBe("pct");
  });

  it("active retry pressure and stale leases are exact facts", () => {
    expect(byKey(board, "active_retry_pressure").value).toBe(2);
    expect(byKey(board, "stale_leases").value).toBe(1);
  });

  it("reuses the boardroom-cards deriveHealth idiom — expired lease reads RED", () => {
    expect(board.reliabilityHealth).not.toBeNull();
    expect(board.reliabilityHealth!.level).toBe("red");
    expect(board.reliabilityHealth!.reasons.join(" ")).toMatch(/expired lease/i);
  });

  it("shadow divergence = refused + errored; observations = total", () => {
    expect(byKey(board, "shadow_observations").value).toBe(11);
    const div = byKey(board, "shadow_divergence");
    expect(div.kind).toBe("fact");
    expect(div.value).toBe(3);
    expect(div.basis).toContain("2 refused");
    expect(div.basis).toContain("1 errored");
  });

  it("AI-cost posture: £0 committed is an honest fact with the governor-dark basis", () => {
    const spend = byKey(board, "ai_spend_committed");
    expect(spend.kind).toBe("fact");
    expect(spend.value).toBe(0);
    expect(spend.format).toBe("gbp");
    expect(spend.basis).toMatch(/dark/i);
    expect(byKey(board, "ai_blocked_orgs").value).toBe(0);
    expect(byKey(board, "ai_overruns").value).toBe(0);
    expect(byKey(board, "ai_spend_reserved").value).toBe(0);
  });

  it("customer-health coverage counts are exact facts", () => {
    expect(byKey(board, "customer_health_critical").value).toBe(2);
    expect(byKey(board, "customer_health_unscored").value).toBe(3);
  });

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeCtoBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeCtoBoard — the no-source metrics are ALWAYS insufficient", () => {
  // Even with EVERY other signal present, CI/deploy/uptime have no schema source
  // and must never be fabricated.
  const board = computeCtoBoard(FULL_INPUT, NOW);

  for (const key of ["ci_pass_rate", "deploy_frequency", "platform_uptime"]) {
    it(`${key} is insufficient with value null and a "no ... table" basis`, () => {
      const m = byKey(board, key);
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
      expect(m.basis).toMatch(/no .*(table).*schema/i);
      expect(m.basis).toMatch(/not fabricated/i);
    });
  }
});

describe("computeCtoBoard — insufficient when a source is unreadable", () => {
  const board = computeCtoBoard(
    { launch: null, reliability: null, shadow: null, aiCost: null, health: null },
    NOW,
  );

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.launch).toBeNull();
    expect(board.reliabilityHealth).toBeNull();
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "active_retry_pressure",
        "ai_blocked_orgs",
        "ai_overruns",
        "ai_spend_committed",
        "ai_spend_reserved",
        "ci_pass_rate",
        "customer_health_critical",
        "customer_health_unscored",
        "deploy_frequency",
        "launch_blockers",
        "launch_warnings",
        "platform_uptime",
        "shadow_divergence",
        "shadow_observations",
        "stale_leases",
        "task_failure_ratio",
      ].sort(),
    );
  });
});

describe("computeCtoBoard — boundary insufficient cases", () => {
  it("failure ratio is insufficient when NO tasks have finished", () => {
    const board = computeCtoBoard(
      {
        ...FULL_INPUT,
        reliability: { tasks: [task({ status: "pending" }), task({ status: "running" })] },
      },
      NOW,
    );
    const ratio = byKey(board, "task_failure_ratio");
    expect(ratio.kind).toBe("insufficient");
    expect(ratio.value).toBeNull();
    // Counts over an empty finished-set are still honest facts, not insufficient.
    expect(byKey(board, "stale_leases").kind).toBe("fact");
  });

  it("shadow divergence is insufficient when there are ZERO observations, but the count stays a fact", () => {
    const board = computeCtoBoard(
      { ...FULL_INPUT, shadow: { planned: 0, refused: 0, error: 0 } },
      NOW,
    );
    expect(byKey(board, "shadow_divergence").kind).toBe("insufficient");
    expect(byKey(board, "shadow_divergence").value).toBeNull();
    const obs = byKey(board, "shadow_observations");
    expect(obs.kind).toBe("fact");
    expect(obs.value).toBe(0);
  });

  it("committed AI spend converts pence→pounds and drops the dark note when activated", () => {
    const board = computeCtoBoard(
      {
        ...FULL_INPUT,
        aiCost: {
          committedPence: 25_000,
          reservedPence: 1_250,
          blockedOrgs: 1,
          overruns: 2,
          ceilingPence: 10_000,
          governorActivated: true,
        },
      },
      NOW,
    );
    expect(byKey(board, "ai_spend_committed").value).toBe(250);
    expect(byKey(board, "ai_spend_committed").basis).not.toMatch(/dark/i);
    expect(byKey(board, "ai_spend_reserved").value).toBe(12.5);
    expect(byKey(board, "ai_blocked_orgs").value).toBe(1);
    expect(byKey(board, "ai_overruns").value).toBe(2);
  });
});

describe("computeCtoBoard — invariants across every metric", () => {
  const boards = [
    computeCtoBoard(FULL_INPUT, NOW),
    computeCtoBoard({ launch: null, reliability: null, shadow: null, aiCost: null, health: null }, NOW),
  ];

  it("value === null IFF kind === 'insufficient' (no fabricated zeros, no null facts)", () => {
    for (const board of boards) {
      for (const m of board.metrics) {
        if (m.kind === "insufficient") expect(m.value).toBeNull();
        else expect(m.value).not.toBeNull();
      }
    }
  });

  it("every metric carries a label and a non-empty basis", () => {
    for (const board of boards) {
      for (const m of board.metrics) {
        expect(m.label.length).toBeGreaterThan(0);
        expect(m.basis.length).toBeGreaterThan(0);
      }
    }
  });

  it("the label ladder reuses the provenance wording", () => {
    expect(CTO_KIND_LABEL.fact).toBe("Fact");
    expect(CTO_KIND_LABEL.derived).toBe("Derived");
    expect(CTO_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
