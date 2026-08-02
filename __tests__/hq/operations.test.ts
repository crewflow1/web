import { describe, it, expect } from "vitest";
import {
  computeOperationsBoard,
  OPERATIONS_KIND_LABEL,
  type OperationsBoard,
  type OperationsInput,
  type OperationsMetric,
} from "@/lib/hq/operations";

/**
 * HQ Operations AI — pure operations-health board contract.
 *
 * Pins:
 *   1. Deterministic composition: cron/email/env system facts, alerts by
 *      severity + aging, and task-queue depth/throughput/failure-ratio are EXACT
 *      from fixtures, and the same inputs + `now` always give the same board.
 *   2. The honesty invariant: `value === null` IFF `kind === "insufficient"`.
 *      A source that could not be read → insufficient, never a fabricated zero.
 *   3. THE NO-DATA SOURCES: SLA compliance and cross-tenant estate throughput
 *      have NO source in the schema and are ALWAYS insufficient — even when every
 *      other signal is present. This is the explicit honesty requirement.
 *   4. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const FULL_INPUT: OperationsInput = {
  system: {
    status: "amber",
    summary: "cron failures in last 7d: notifications-drain (3 fail)",
    missingRequiredEnv: [],
    cronFailures7d: 3,
    cronRoutesFailing: 1,
    cronRoutesStale: 2,
    cronRoutesTotal: 8,
    emailQueued: 4,
    emailPermanentFailures: 1,
  },
  alerts: {
    alerts: [
      { severity: "critical", occurredAt: iso(-10 * DAY) },
      { severity: "warning", occurredAt: iso(-3 * DAY) },
      { severity: "info", occurredAt: iso(-1 * DAY) },
    ],
  },
  queue: {
    total: 20,
    queued: 5,
    active: 3,
    waitingApproval: 2,
    completed: 8,
    failed: 2,
  },
};

const EMPTY_INPUT: OperationsInput = { system: null, alerts: null, queue: null };

function byKey(board: OperationsBoard, key: string): OperationsMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeOperationsBoard — deterministic figures from fixtures", () => {
  const board = computeOperationsBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("system cron/email/env are exact facts", () => {
    expect(byKey(board, "system_cron_failures").kind).toBe("fact");
    expect(byKey(board, "system_cron_failures").value).toBe(3);
    expect(byKey(board, "system_crons_failing").value).toBe(1);
    expect(byKey(board, "system_crons_stale").value).toBe(2);
    expect(byKey(board, "system_email_backlog").value).toBe(4);
    expect(byKey(board, "system_email_permanent_failures").value).toBe(1);
    expect(byKey(board, "system_env_missing").value).toBe(0);
    expect(byKey(board, "system_env_missing").basis).toMatch(/every required/i);
  });

  it("system-health panel restates the status, summary and reasons", () => {
    expect(board.systemHealth).not.toBeNull();
    expect(board.systemHealth!.status).toBe("amber");
    expect(board.systemHealth!.summary).toContain("notifications-drain");
    expect(board.systemHealth!.reasons).toEqual([
      "3 cron failures across 1 route in the last 7 days.",
      "2 cron routes recorded no run in the last 7 days.",
      "1 email permanently failed.",
      "4 emails queued.",
    ]);
  });

  it("missing required env is listed by name in the basis", () => {
    const board2 = computeOperationsBoard(
      {
        ...FULL_INPUT,
        system: { ...FULL_INPUT.system!, missingRequiredEnv: ["CRON_SECRET", "RESEND_API_KEY"] },
      },
      NOW,
    );
    const m = byKey(board2, "system_env_missing");
    expect(m.value).toBe(2);
    expect(m.basis).toContain("CRON_SECRET");
    expect(m.basis).toContain("RESEND_API_KEY");
    expect(board2.systemHealth!.reasons[0]).toContain("Missing required env");
  });

  it("alert load buckets by severity and finds the oldest open age", () => {
    expect(byKey(board, "alerts_open_total").value).toBe(3);
    expect(byKey(board, "alerts_critical").value).toBe(1);
    expect(byKey(board, "alerts_warning").value).toBe(1);
    const oldest = byKey(board, "alerts_oldest_age");
    expect(oldest.kind).toBe("fact");
    expect(oldest.value).toBe(10);
    expect(oldest.format).toBe("days");
    expect(board.alertLoad).toEqual({
      critical: 1,
      warning: 1,
      info: 1,
      total: 3,
      oldestAgeDays: 10,
    });
  });

  it("attention required is derived (critical + warning, info excluded)", () => {
    const m = byKey(board, "alerts_attention");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(2);
    expect(m.basis).toContain("1 critical");
    expect(m.basis).toContain("1 warning");
  });

  it("queue depth / in-flight / awaiting-approval / completed are exact facts", () => {
    expect(byKey(board, "queue_depth").value).toBe(5);
    expect(byKey(board, "queue_active").value).toBe(3);
    expect(byKey(board, "queue_waiting_approval").value).toBe(2);
    expect(byKey(board, "queue_completed").value).toBe(8);
  });

  it("queue failure ratio is derived exactly (2 failed of 10 finished)", () => {
    const m = byKey(board, "queue_failure_ratio");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(20);
    expect(m.format).toBe("pct");
  });

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeOperationsBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeOperationsBoard — the no-source metrics are ALWAYS insufficient", () => {
  // Even with EVERY other signal present, SLA + cross-tenant throughput have no
  // schema source and must never be fabricated.
  const board = computeOperationsBoard(FULL_INPUT, NOW);

  it("sla_compliance is insufficient with value null and a no-table basis", () => {
    const m = byKey(board, "sla_compliance");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/no sla/i);
    expect(m.basis).toMatch(/not fabricated/i);
  });

  it("estate_operational_throughput is insufficient (tenant-scoped, never blended)", () => {
    const m = byKey(board, "estate_operational_throughput");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/tenant-scoped/i);
    expect(m.basis).toMatch(/not fabricated/i);
  });
});

describe("computeOperationsBoard — insufficient when a source is unreadable", () => {
  const board = computeOperationsBoard(EMPTY_INPUT, NOW);

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.systemHealth).toBeNull();
    expect(board.alertLoad).toBeNull();
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "alerts_attention",
        "alerts_critical",
        "alerts_oldest_age",
        "alerts_open_total",
        "alerts_warning",
        "estate_operational_throughput",
        "queue_active",
        "queue_completed",
        "queue_depth",
        "queue_failure_ratio",
        "queue_waiting_approval",
        "sla_compliance",
        "system_cron_failures",
        "system_crons_failing",
        "system_crons_stale",
        "system_email_backlog",
        "system_email_permanent_failures",
        "system_env_missing",
      ].sort(),
    );
  });
});

describe("computeOperationsBoard — boundary insufficient cases", () => {
  it("oldest alert age is insufficient when there are ZERO open alerts, but counts stay facts", () => {
    const board = computeOperationsBoard(
      { ...FULL_INPUT, alerts: { alerts: [] } },
      NOW,
    );
    const oldest = byKey(board, "alerts_oldest_age");
    expect(oldest.kind).toBe("insufficient");
    expect(oldest.value).toBeNull();
    // Zero-alert counts are still honest facts, not insufficient.
    expect(byKey(board, "alerts_open_total").kind).toBe("fact");
    expect(byKey(board, "alerts_open_total").value).toBe(0);
    expect(byKey(board, "alerts_attention").kind).toBe("derived");
    expect(byKey(board, "alerts_attention").value).toBe(0);
    expect(board.alertLoad).toEqual({
      critical: 0,
      warning: 0,
      info: 0,
      total: 0,
      oldestAgeDays: null,
    });
  });

  it("queue failure ratio is insufficient when NO tasks have finished", () => {
    const board = computeOperationsBoard(
      {
        ...FULL_INPUT,
        queue: { total: 8, queued: 5, active: 3, waitingApproval: 0, completed: 0, failed: 0 },
      },
      NOW,
    );
    const m = byKey(board, "queue_failure_ratio");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    // Depth over an empty finished-set is still an honest fact.
    expect(byKey(board, "queue_depth").kind).toBe("fact");
    expect(byKey(board, "queue_depth").value).toBe(5);
  });

  it("alert age clamps at 0 for a future-stamped alert (never negative)", () => {
    const board = computeOperationsBoard(
      { ...FULL_INPUT, alerts: { alerts: [{ severity: "warning", occurredAt: iso(5 * DAY) }] } },
      NOW,
    );
    expect(byKey(board, "alerts_oldest_age").value).toBe(0);
  });

  it("rounds the failure ratio to one decimal (1 of 3 finished)", () => {
    const board = computeOperationsBoard(
      {
        ...FULL_INPUT,
        queue: { total: 3, queued: 0, active: 0, waitingApproval: 0, completed: 2, failed: 1 },
      },
      NOW,
    );
    expect(byKey(board, "queue_failure_ratio").value).toBe(33.3);
  });
});

describe("computeOperationsBoard — invariants across every metric", () => {
  const boards = [
    computeOperationsBoard(FULL_INPUT, NOW),
    computeOperationsBoard(EMPTY_INPUT, NOW),
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
    expect(OPERATIONS_KIND_LABEL.fact).toBe("Fact");
    expect(OPERATIONS_KIND_LABEL.derived).toBe("Derived");
    expect(OPERATIONS_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
