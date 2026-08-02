import { describe, it, expect } from "vitest";
import {
  computeQaBoard,
  QA_KIND_LABEL,
  type QaBoard,
  type QaInput,
  type QaMetric,
} from "@/lib/hq/qa";
import type { BoardroomTask } from "@/lib/hq/boardroom-cards";

/**
 * HQ QA AI — pure AI-quality / reliability board contract.
 *
 * Pins:
 *   1. Deterministic composition: shadow divergence/error rate, reply
 *      accept/review/block rates, recorded conversation outcomes, task failure
 *      ratio, retry pressure and stale leases are EXACT from fixtures, and the
 *      same inputs + `now` always give the same board.
 *   2. The honesty invariant: `value === null` IFF `kind === "insufficient"`.
 *      A source that could not be read → insufficient, never a fabricated zero.
 *   3. THE NO-DATA SOURCES: browser / regression test pass rate, a11y audit
 *      score, and release approval have NO source in the schema and are ALWAYS
 *      insufficient — even when every other signal is present. This is the
 *      explicit honesty requirement for traditional QA telemetry.
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

const FULL_INPUT: QaInput = {
  shadow: { planned: 8, refused: 2, error: 1 },
  reply: { allow: 7, review: 2, block: 1 },
  outcome: { recorded: 4 },
  reliability: { tasks: TASKS },
};

function byKey(board: QaBoard, key: string): QaMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeQaBoard — deterministic figures from fixtures", () => {
  const board = computeQaBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("shadow observations count is an exact fact; divergence & error rates are derived", () => {
    const obs = byKey(board, "shadow_observations");
    expect(obs.kind).toBe("fact");
    expect(obs.value).toBe(11);

    const div = byKey(board, "shadow_divergence_rate");
    expect(div.kind).toBe("derived");
    expect(div.value).toBe(27.3); // (2 + 1) / 11 * 100
    expect(div.format).toBe("pct");
    expect(div.basis).toContain("2 refused");
    expect(div.basis).toContain("1 errored");

    const err = byKey(board, "shadow_error_rate");
    expect(err.kind).toBe("derived");
    expect(err.value).toBe(9.1); // 1 / 11 * 100
  });

  it("reply verdict rates are derived exactly (7 allow / 2 review / 1 block of 10)", () => {
    expect(byKey(board, "reply_audits").kind).toBe("fact");
    expect(byKey(board, "reply_audits").value).toBe(10);

    const accept = byKey(board, "reply_acceptance_rate");
    expect(accept.kind).toBe("derived");
    expect(accept.value).toBe(70);

    expect(byKey(board, "reply_review_rate").value).toBe(20);
    expect(byKey(board, "reply_block_rate").value).toBe(10);

    expect(board.replyQuality).toEqual({ total: 10, allow: 7, review: 2, block: 1 });
  });

  it("recorded conversation outcomes is an exact fact with the pinned-status basis", () => {
    const out = byKey(board, "conversation_outcomes");
    expect(out.kind).toBe("fact");
    expect(out.value).toBe(4);
    expect(out.basis).toMatch(/recorded/i);
    expect(out.basis).toMatch(/no accepted\/failed split/i);
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

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeQaBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeQaBoard — the no-source (traditional QA) metrics are ALWAYS insufficient", () => {
  // Even with EVERY other signal present, browser/regression/a11y/release have no
  // schema source and must never be fabricated.
  const board = computeQaBoard(FULL_INPUT, NOW);

  for (const key of [
    "regression_test_pass_rate",
    "browser_test_pass_rate",
    "a11y_audit_score",
    "release_approval",
  ]) {
    it(`${key} is insufficient with value null and a "no ... table" basis`, () => {
      const m = byKey(board, key);
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
      expect(m.basis).toMatch(/no .*table.*schema/i);
      expect(m.basis).toMatch(/not fabricated/i);
    });
  }
});

describe("computeQaBoard — insufficient when a source is unreadable", () => {
  const board = computeQaBoard(
    { shadow: null, reply: null, outcome: null, reliability: null },
    NOW,
  );

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.reliabilityHealth).toBeNull();
    expect(board.replyQuality).toBeNull();
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "a11y_audit_score",
        "active_retry_pressure",
        "browser_test_pass_rate",
        "conversation_outcomes",
        "regression_test_pass_rate",
        "release_approval",
        "reply_acceptance_rate",
        "reply_audits",
        "reply_block_rate",
        "reply_review_rate",
        "shadow_divergence_rate",
        "shadow_error_rate",
        "shadow_observations",
        "stale_leases",
        "task_failure_ratio",
      ].sort(),
    );
  });
});

describe("computeQaBoard — boundary insufficient cases", () => {
  it("shadow rates are insufficient with ZERO observations, but the count stays a fact", () => {
    const board = computeQaBoard(
      { ...FULL_INPUT, shadow: { planned: 0, refused: 0, error: 0 } },
      NOW,
    );
    expect(byKey(board, "shadow_divergence_rate").kind).toBe("insufficient");
    expect(byKey(board, "shadow_divergence_rate").value).toBeNull();
    expect(byKey(board, "shadow_error_rate").kind).toBe("insufficient");
    const obs = byKey(board, "shadow_observations");
    expect(obs.kind).toBe("fact");
    expect(obs.value).toBe(0);
  });

  it("reply rates are insufficient with ZERO audited replies, but the count stays a fact", () => {
    const board = computeQaBoard(
      { ...FULL_INPUT, reply: { allow: 0, review: 0, block: 0 } },
      NOW,
    );
    expect(byKey(board, "reply_audits").kind).toBe("fact");
    expect(byKey(board, "reply_audits").value).toBe(0);
    expect(byKey(board, "reply_acceptance_rate").kind).toBe("insufficient");
    expect(byKey(board, "reply_review_rate").kind).toBe("insufficient");
    expect(byKey(board, "reply_block_rate").kind).toBe("insufficient");
    expect(board.replyQuality).toEqual({ total: 0, allow: 0, review: 0, block: 0 });
  });

  it("failure ratio is insufficient when NO tasks have finished, but counts stay facts", () => {
    const board = computeQaBoard(
      {
        ...FULL_INPUT,
        reliability: { tasks: [task({ status: "pending" }), task({ status: "running" })] },
      },
      NOW,
    );
    const ratio = byKey(board, "task_failure_ratio");
    expect(ratio.kind).toBe("insufficient");
    expect(ratio.value).toBeNull();
    expect(byKey(board, "stale_leases").kind).toBe("fact");
  });

  it("recorded outcomes of zero is an honest fact, not insufficient", () => {
    const board = computeQaBoard({ ...FULL_INPUT, outcome: { recorded: 0 } }, NOW);
    const out = byKey(board, "conversation_outcomes");
    expect(out.kind).toBe("fact");
    expect(out.value).toBe(0);
  });
});

describe("computeQaBoard — invariants across every metric", () => {
  const boards = [
    computeQaBoard(FULL_INPUT, NOW),
    computeQaBoard({ shadow: null, reply: null, outcome: null, reliability: null }, NOW),
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
    expect(QA_KIND_LABEL.fact).toBe("Fact");
    expect(QA_KIND_LABEL.derived).toBe("Derived");
    expect(QA_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
