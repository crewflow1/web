import { describe, it, expect } from "vitest";
import {
  computeExecutiveAssistantBoard,
  EXECUTIVE_ASSISTANT_KIND_LABEL,
  type ExecutiveAssistantBoard,
  type ExecutiveAssistantInput,
  type ExecutiveAssistantMetric,
} from "@/lib/hq/executive-assistant";

/**
 * HQ Executive-Assistant AI — pure "what needs the human" digest contract.
 *
 * Pins:
 *   1. Deterministic composition: open approvals, proposed/delayed decisions,
 *      overdue/stalled tasks (by stage), and alerts-by-severity are EXACT from
 *      fixtures, and the same inputs + `now` always give the same board.
 *   2. THE CRITICAL NUANCE — empty-readable vs unreadable:
 *      · an EMPTY but readable queue is a TRUE factual zero ("all clear"), and the
 *        counts are `fact: 0`, NOT insufficient;
 *      · an UNREADABLE queue (null) is `insufficient` with value null, and the
 *        board's headline verdict is NEVER `all_clear` over a failed read.
 *   3. The honesty invariant: `value === null` IFF `kind === "insufficient"`.
 *   4. Prioritised ordering: critical bands first, then oldest age, then count.
 *   5. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const FULL_INPUT: ExecutiveAssistantInput = {
  approvals: {
    approvals: [
      { state: "escalated", requestedAt: iso(-6 * DAY) },
      { state: "pending", requestedAt: iso(-2 * DAY) },
      { state: "pending", requestedAt: iso(-1 * DAY) },
    ],
  },
  decisions: {
    decisions: [
      { status: "proposed", createdAt: iso(-4 * DAY), delayUntil: null },
      // delayed but revisit date already passed → delayedDue
      { status: "delayed", createdAt: iso(-9 * DAY), delayUntil: iso(-1 * DAY) },
      // delayed with revisit still in the future → parked, not due
      { status: "delayed", createdAt: iso(-3 * DAY), delayUntil: iso(5 * DAY) },
    ],
  },
  tasks: {
    tasks: [
      // overdue, staged engineering
      { status: "running", deadlineAt: iso(-2 * DAY), leaseExpiresAt: iso(1 * DAY), heartbeatAt: iso(-60_000), pipelineStage: "engineering" },
      // overdue, unstaged
      { status: "pending", deadlineAt: iso(-1 * DAY), leaseExpiresAt: null, heartbeatAt: null, pipelineStage: null },
      // stalled: running, lease expired
      { status: "running", deadlineAt: null, leaseExpiresAt: iso(-1 * DAY), heartbeatAt: iso(-60_000), pipelineStage: "testing" },
      // healthy, not counted
      { status: "running", deadlineAt: iso(3 * DAY), leaseExpiresAt: iso(1 * DAY), heartbeatAt: iso(-60_000), pipelineStage: "design" },
    ],
  },
  alerts: {
    alerts: [
      { severity: "critical", occurredAt: iso(-10 * DAY) },
      { severity: "warning", occurredAt: iso(-3 * DAY) },
      { severity: "info", occurredAt: iso(-1 * DAY) },
    ],
  },
};

const EMPTY_READABLE: ExecutiveAssistantInput = {
  approvals: { approvals: [] },
  decisions: { decisions: [] },
  tasks: { tasks: [] },
  alerts: { alerts: [] },
};

const ALL_UNREADABLE: ExecutiveAssistantInput = {
  approvals: null,
  decisions: null,
  tasks: null,
  alerts: null,
};

function byKey(board: ExecutiveAssistantBoard, key: string): ExecutiveAssistantMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeExecutiveAssistantBoard — deterministic figures from fixtures", () => {
  const board = computeExecutiveAssistantBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("approvals bucket into pending/escalated with the oldest age", () => {
    expect(byKey(board, "approvals_pending").value).toBe(2);
    expect(byKey(board, "approvals_escalated").value).toBe(1);
    expect(byKey(board, "approvals_open_total").value).toBe(3);
    expect(byKey(board, "approvals_oldest_age").value).toBe(6);
    expect(board.approvalLoad).toEqual({ pending: 2, escalated: 1, total: 3, oldestAgeDays: 6 });
  });

  it("decisions split into awaiting / delayed / delayed-now-due", () => {
    expect(byKey(board, "decisions_awaiting").value).toBe(1);
    expect(byKey(board, "decisions_delayed").value).toBe(2);
    expect(byKey(board, "decisions_delayed_due").value).toBe(1);
    expect(board.decisionLoad).toEqual({
      awaiting: 1,
      delayed: 2,
      delayedDue: 1,
      total: 3,
      oldestAgeDays: 9,
    });
  });

  it("tasks count overdue + stalled and group overdue by pipeline stage", () => {
    expect(byKey(board, "tasks_overdue").value).toBe(2);
    expect(byKey(board, "tasks_stalled").value).toBe(1);
    expect(byKey(board, "tasks_oldest_overdue_age").value).toBe(2);
    expect(board.taskLoad!.byStage).toEqual([
      { stage: "engineering", label: "Engineering", count: 1 },
      { stage: "unstaged", label: "Unstaged", count: 1 },
    ]);
  });

  it("alerts bucket by severity with attention derived (critical + warning)", () => {
    expect(byKey(board, "alerts_critical").value).toBe(1);
    expect(byKey(board, "alerts_warning").value).toBe(1);
    const attention = byKey(board, "alerts_attention");
    expect(attention.kind).toBe("derived");
    expect(attention.value).toBe(2);
    expect(byKey(board, "alerts_oldest_age").value).toBe(10);
  });

  it("rolls up items needing the human as a derived total", () => {
    const m = byKey(board, "items_needing_human");
    expect(m.kind).toBe("derived");
    // escalated 1 + pending 2 + delayedDue 1 + awaiting 1 + stalled 1 + overdue 2 + critical 1 + warning 1
    expect(m.value).toBe(10);
    expect(board.summary.itemsNeedingHuman).toBe(10);
  });

  it("verdict is `attention` when items are pending", () => {
    expect(board.summary.status).toBe("attention");
    expect(board.summary.unreadableSources).toEqual([]);
  });

  it("prioritises the digest: critical band first, then oldest age, then count", () => {
    const keys = board.needsHuman.map((i) => i.key);
    // Critical band: escalated approvals (age 6), critical alerts (age 10), stalled
    // tasks (age null). Ordered by oldest-age desc within the band, null last.
    expect(keys.slice(0, 3)).toEqual(["alerts_critical", "approvals_escalated", "tasks_stalled"]);
    // Every critical precedes every high precedes every normal.
    const rank = { critical: 0, high: 1, normal: 2 } as const;
    const ranks = board.needsHuman.map((i) => rank[i.urgency]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeExecutiveAssistantBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeExecutiveAssistantBoard — EMPTY-READABLE is a true 'all clear' (NOT insufficient)", () => {
  const board = computeExecutiveAssistantBoard(EMPTY_READABLE, NOW);

  it("every count is a FACT zero, not insufficient", () => {
    for (const key of [
      "approvals_pending",
      "approvals_escalated",
      "approvals_open_total",
      "decisions_awaiting",
      "decisions_delayed",
      "decisions_delayed_due",
      "tasks_overdue",
      "tasks_stalled",
      "alerts_critical",
      "alerts_warning",
    ]) {
      const m = byKey(board, key);
      expect(m.kind, `${key} should be a fact zero`).toBe("fact");
      expect(m.value).toBe(0);
    }
    // attention + items-needing-human are derived zeros.
    expect(byKey(board, "alerts_attention").kind).toBe("derived");
    expect(byKey(board, "alerts_attention").value).toBe(0);
    expect(byKey(board, "items_needing_human").kind).toBe("derived");
    expect(byKey(board, "items_needing_human").value).toBe(0);
  });

  it("age-over-empty is the ONLY insufficient (an undefined age, not a fabricated zero)", () => {
    for (const key of [
      "approvals_oldest_age",
      "decisions_oldest_age",
      "tasks_oldest_overdue_age",
      "alerts_oldest_age",
    ]) {
      const m = byKey(board, key);
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
  });

  it("the verdict IS all_clear, with an empty digest and no unreadable sources", () => {
    expect(board.summary.status).toBe("all_clear");
    expect(board.summary.itemsNeedingHuman).toBe(0);
    expect(board.summary.unreadableSources).toEqual([]);
    expect(board.needsHuman).toEqual([]);
    // The load panels are present (readable), not null.
    expect(board.approvalLoad).not.toBeNull();
    expect(board.decisionLoad).not.toBeNull();
    expect(board.taskLoad).not.toBeNull();
    expect(board.alertLoad).not.toBeNull();
  });
});

describe("computeExecutiveAssistantBoard — UNREADABLE is insufficient and NEVER 'all clear'", () => {
  const board = computeExecutiveAssistantBoard(ALL_UNREADABLE, NOW);

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.approvalLoad).toBeNull();
    expect(board.decisionLoad).toBeNull();
    expect(board.taskLoad).toBeNull();
    expect(board.alertLoad).toBeNull();
  });

  it("the verdict is `insufficient`, NOT `all_clear`, over a total read failure", () => {
    expect(board.summary.status).toBe("insufficient");
    expect(board.summary.status).not.toBe("all_clear");
    expect(board.summary.unreadableSources).toEqual([
      "open approvals",
      "pending decisions",
      "AI tasks",
      "HQ alerts",
    ]);
    expect(board.needsHuman).toEqual([]);
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "alerts_critical",
        "alerts_oldest_age",
        "alerts_warning",
        "alerts_attention",
        "approvals_escalated",
        "approvals_oldest_age",
        "approvals_open_total",
        "approvals_pending",
        "decisions_awaiting",
        "decisions_delayed",
        "decisions_delayed_due",
        "decisions_oldest_age",
        "items_needing_human",
        "tasks_oldest_overdue_age",
        "tasks_overdue",
        "tasks_stalled",
      ].sort(),
    );
  });
});

describe("computeExecutiveAssistantBoard — a PARTIAL read is honest, never all-clear", () => {
  it("with one unreadable source and no pending items, the verdict is insufficient", () => {
    const board = computeExecutiveAssistantBoard(
      { ...EMPTY_READABLE, tasks: null },
      NOW,
    );
    // The readable queues are all clear...
    expect(board.summary.itemsNeedingHuman).toBe(0);
    // ...but a failed read means we cannot claim all-clear.
    expect(board.summary.status).toBe("insufficient");
    expect(board.summary.unreadableSources).toEqual(["AI tasks"]);
    // The tasks metrics are insufficient; the others are honest facts.
    expect(byKey(board, "tasks_overdue").kind).toBe("insufficient");
    expect(byKey(board, "approvals_pending").kind).toBe("fact");
    expect(byKey(board, "approvals_pending").value).toBe(0);
  });

  it("with an unreadable source AND pending items elsewhere, verdict is attention and total is a floor", () => {
    const board = computeExecutiveAssistantBoard(
      {
        approvals: { approvals: [{ state: "pending", requestedAt: iso(-1 * DAY) }] },
        decisions: null,
        tasks: null,
        alerts: null,
      },
      NOW,
    );
    expect(board.summary.status).toBe("attention");
    expect(board.summary.itemsNeedingHuman).toBe(1);
    const m = byKey(board, "items_needing_human");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(1);
    expect(m.basis).toMatch(/floor/i);
  });
});

describe("computeExecutiveAssistantBoard — boundary cases", () => {
  it("a delayed decision with NO revisit date is parked but never 'now due'", () => {
    const board = computeExecutiveAssistantBoard(
      {
        ...EMPTY_READABLE,
        decisions: { decisions: [{ status: "delayed", createdAt: iso(-2 * DAY), delayUntil: null }] },
      },
      NOW,
    );
    expect(byKey(board, "decisions_delayed").value).toBe(1);
    expect(byKey(board, "decisions_delayed_due").value).toBe(0);
    // A parked-but-not-due decision is not an item needing the human now.
    expect(board.needsHuman.map((i) => i.key)).not.toContain("decisions_delayed_due");
  });

  it("a task overdue by a future-stamped deadline is not overdue; a healthy running task is neither", () => {
    const board = computeExecutiveAssistantBoard(
      {
        ...EMPTY_READABLE,
        tasks: {
          tasks: [
            { status: "running", deadlineAt: iso(3 * DAY), leaseExpiresAt: iso(1 * DAY), heartbeatAt: iso(-60_000), pipelineStage: "design" },
          ],
        },
      },
      NOW,
    );
    expect(byKey(board, "tasks_overdue").value).toBe(0);
    expect(byKey(board, "tasks_stalled").value).toBe(0);
    expect(board.summary.status).toBe("all_clear");
  });

  it("a running task with a stale heartbeat (>15m) counts as stalled even with a live lease", () => {
    const board = computeExecutiveAssistantBoard(
      {
        ...EMPTY_READABLE,
        tasks: {
          tasks: [
            { status: "running", deadlineAt: null, leaseExpiresAt: iso(1 * DAY), heartbeatAt: iso(-20 * 60_000), pipelineStage: null },
          ],
        },
      },
      NOW,
    );
    expect(byKey(board, "tasks_stalled").value).toBe(1);
  });
});

describe("computeExecutiveAssistantBoard — invariants across every metric", () => {
  const boards = [
    computeExecutiveAssistantBoard(FULL_INPUT, NOW),
    computeExecutiveAssistantBoard(EMPTY_READABLE, NOW),
    computeExecutiveAssistantBoard(ALL_UNREADABLE, NOW),
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

  it("every digest item carries a positive count and a non-empty detail", () => {
    for (const board of boards) {
      for (const item of board.needsHuman) {
        expect(item.count).toBeGreaterThan(0);
        expect(item.detail.length).toBeGreaterThan(0);
        expect(item.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("the label ladder reuses the provenance wording", () => {
    expect(EXECUTIVE_ASSISTANT_KIND_LABEL.fact).toBe("Fact");
    expect(EXECUTIVE_ASSISTANT_KIND_LABEL.derived).toBe("Derived");
    expect(EXECUTIVE_ASSISTANT_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
