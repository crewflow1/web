import { describe, it, expect } from "vitest";
import {
  computeSalesOrchestratorBoard,
  SALES_ORCHESTRATOR_KIND_LABEL,
  type SalesOrchestratorBoard,
  type SalesOrchestratorInput,
  type SalesOrchestratorMetric,
} from "@/lib/hq/sales-orchestrator";

/**
 * HQ Sales-Orchestrator AI — pure cross-stage pipeline board contract.
 *
 * Pins:
 *   1. Deterministic composition: stage counts, stage-to-stage conversion, win /
 *      close rate, open-deal ages, the stalled count, per-drain backlog/health,
 *      drain backlog age and outreach cadence health are EXACT from fixtures, and
 *      the same inputs + `now` always give the same board.
 *   2. THE READABLE-ZERO vs INSUFFICIENT LINE: a COUNT that reads as zero is a
 *      `fact` (no deals at a stage, no pending tasks); a RATIO or AGE with no base
 *      is `insufficient` (undefined, not zero); a whole unreadable SOURCE is
 *      insufficient for every figure it feeds.
 *   3. The honesty invariant: `value === null` IFF `kind === "insufficient"`.
 *   4. THE NO-SOURCE SIGNALS: cohort deal velocity and forecast win probability
 *      have NO schema source and are ALWAYS insufficient — even with every other
 *      signal present.
 *   5. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

const D10 = "2026-08-05T12:00:00.000Z"; // 10 days before NOW
const D30 = "2026-07-16T12:00:00.000Z"; // 30 days before NOW
const RECENT = "2026-08-14T12:00:00.000Z"; // 1 day before NOW (not stalled)
const STALE = "2026-07-01T12:00:00.000Z"; // 45 days before NOW (stalled)
const CLOSED = "2026-08-10T12:00:00.000Z"; // timestamps for closed deals

const FULL_INPUT: SalesOrchestratorInput = {
  pipeline: {
    companies: [
      // 8 open deals: 7 aged 10d, 1 aged 30d (the oldest); 3 stalled (>14d idle).
      { status: "new", created_at: D10, updated_at: RECENT },
      { status: "new", created_at: D10, updated_at: STALE }, // stalled
      { status: "qualified", created_at: D10, updated_at: RECENT },
      { status: "qualified", created_at: D10, updated_at: STALE }, // stalled
      { status: "outreach_ready", created_at: D10, updated_at: RECENT },
      { status: "contacted", created_at: D10, updated_at: STALE }, // stalled
      { status: "replied", created_at: D10, updated_at: RECENT },
      { status: "demo_booked", created_at: D30, updated_at: RECENT }, // oldest
      // Closed deals — count in totals + rates, excluded from open ages/stalled.
      { status: "won", created_at: CLOSED, updated_at: CLOSED },
      { status: "lost", created_at: CLOSED, updated_at: CLOSED },
      { status: "disqualified", created_at: CLOSED, updated_at: CLOSED },
    ],
  },
  drains: {
    research: {
      pending: 5,
      running: 2,
      completed: 40,
      failed: 3,
      oldestPendingAt: "2026-08-13T12:00:00.000Z", // 2 days
    },
    qualification: {
      pending: 0,
      running: 1,
      completed: 20,
      failed: 0,
      oldestPendingAt: null, // no backlog → age is insufficient (not 0)
    },
    outreach: {
      pending: 2,
      running: 0,
      completed: 10,
      failed: 1,
      oldestPendingAt: CLOSED, // 5 days
    },
  },
  cadence: {
    activeOutreachDeals: 6,
    touchedWithinWindow: 4,
    overdue: 2,
  },
};

const EMPTY_INPUT: SalesOrchestratorInput = {
  pipeline: null,
  drains: null,
  cadence: null,
};

function byKey(board: SalesOrchestratorBoard, key: string): SalesOrchestratorMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeSalesOrchestratorBoard — deterministic figures from fixtures", () => {
  const board = computeSalesOrchestratorBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("stage counts are exact facts (open, per-stage, won, lost)", () => {
    expect(byKey(board, "open_pipeline").kind).toBe("fact");
    expect(byKey(board, "open_pipeline").value).toBe(8);
    expect(byKey(board, "deals_new").value).toBe(2);
    expect(byKey(board, "deals_qualified").value).toBe(2);
    expect(byKey(board, "deals_outreach_ready").value).toBe(1);
    expect(byKey(board, "deals_in_conversation").value).toBe(3); // contacted+replied+demo
    expect(byKey(board, "deals_won").value).toBe(1);
    expect(byKey(board, "deals_lost").value).toBe(2); // lost + disqualified
  });

  it("stage-to-stage conversion is derived exactly (position ratio, not a cohort)", () => {
    const q = byKey(board, "qualification_conversion");
    expect(q.kind).toBe("derived");
    expect(q.value).toBe(77.8); // reached qualified 7 / reached new 9
    expect(q.basis).toMatch(/not a cohort/i);
    const o = byKey(board, "outreach_conversion");
    expect(o.kind).toBe("derived");
    expect(o.value).toBe(71.4); // reached outreach 5 / reached qualified 7
  });

  it("win rate and close rate are derived exactly", () => {
    expect(byKey(board, "win_rate").value).toBe(9.1); // 1 won / 11 total
    expect(byKey(board, "close_rate").value).toBe(33.3); // 1 won / 3 decided
  });

  it("open-deal ages and the stalled count are computed against `now`", () => {
    const avg = byKey(board, "avg_open_deal_age");
    expect(avg.kind).toBe("derived");
    expect(avg.value).toBe(12.5); // (7×10 + 30) / 8
    expect(avg.format).toBe("days");
    const oldest = byKey(board, "oldest_open_deal_age");
    expect(oldest.kind).toBe("derived");
    expect(oldest.value).toBe(30);
    const stalled = byKey(board, "stalled_deals");
    expect(stalled.kind).toBe("fact");
    expect(stalled.value).toBe(3);
  });

  it("the unified funnel is ordered new → won with conversion from previous", () => {
    expect(board.funnel.map((s) => s.key)).toEqual([
      "stage_new",
      "stage_qualified",
      "stage_outreach_ready",
      "stage_contacted",
      "stage_replied",
      "stage_demo_booked",
      "stage_won",
    ]);
    const first = board.funnel[0]!;
    expect(first.reached).toBe(9);
    expect(first.conversionFromPrev).toBeNull();
    expect(board.funnel[1]!.reached).toBe(7);
    expect(board.funnel[1]!.conversionFromPrev).toBe(77.8);
  });

  it("per-drain facts are exact; a drain with no backlog has an insufficient age", () => {
    expect(byKey(board, "research_backlog").value).toBe(5);
    expect(byKey(board, "research_in_flight").value).toBe(2);
    expect(byKey(board, "research_failed").value).toBe(3);
    expect(byKey(board, "research_oldest_backlog_age").kind).toBe("derived");
    expect(byKey(board, "research_oldest_backlog_age").value).toBe(2);
    expect(byKey(board, "outreach_oldest_backlog_age").value).toBe(5);

    // Readable zero vs insufficient: backlog 0 is a FACT, its age is UNDEFINED.
    expect(byKey(board, "qualification_backlog").kind).toBe("fact");
    expect(byKey(board, "qualification_backlog").value).toBe(0);
    expect(byKey(board, "qualification_failed").kind).toBe("fact");
    expect(byKey(board, "qualification_failed").value).toBe(0);
    const age = byKey(board, "qualification_oldest_backlog_age");
    expect(age.kind).toBe("insufficient");
    expect(age.value).toBeNull();
    expect(age.basis).toMatch(/not zero/i);
  });

  it("the drains block mirrors the queue facts", () => {
    expect(board.drains).toEqual([
      { key: "research", label: "Research", backlog: 5, inFlight: 2, completed: 40, failed: 3 },
      { key: "qualification", label: "Qualification", backlog: 0, inFlight: 1, completed: 20, failed: 0 },
      { key: "outreach", label: "Outreach", backlog: 2, inFlight: 0, completed: 10, failed: 1 },
    ]);
  });

  it("outreach cadence health is derived; active + overdue are facts", () => {
    expect(byKey(board, "active_outreach_deals").value).toBe(6);
    const h = byKey(board, "outreach_cadence_health");
    expect(h.kind).toBe("derived");
    expect(h.value).toBe(66.7); // 4 of 6
    expect(byKey(board, "overdue_outreach_deals").value).toBe(2);
  });

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeSalesOrchestratorBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeSalesOrchestratorBoard — the no-source metrics are ALWAYS insufficient", () => {
  const board = computeSalesOrchestratorBoard(FULL_INPUT, NOW);

  it("cohort deal velocity + forecast win probability are insufficient", () => {
    for (const key of ["deal_velocity_cohort", "forecast_win_probability"]) {
      const m = byKey(board, key);
      expect(m.kind, key).toBe("insufficient");
      expect(m.value, key).toBeNull();
    }
    expect(byKey(board, "deal_velocity_cohort").basis).toMatch(/proxy|per-stage/i);
    expect(byKey(board, "forecast_win_probability").basis).toMatch(/probability|not fabricated/i);
  });
});

describe("computeSalesOrchestratorBoard — insufficient when a source is unreadable", () => {
  const board = computeSalesOrchestratorBoard(EMPTY_INPUT, NOW);

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.funnel).toEqual([]);
    expect(board.drains).toBeNull();
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "active_outreach_deals",
        "avg_open_deal_age",
        "close_rate",
        "deal_velocity_cohort",
        "deals_in_conversation",
        "deals_lost",
        "deals_new",
        "deals_outreach_ready",
        "deals_qualified",
        "deals_won",
        "forecast_win_probability",
        "oldest_open_deal_age",
        "open_pipeline",
        "outreach_backlog",
        "outreach_cadence_health",
        "outreach_conversion",
        "outreach_failed",
        "outreach_in_flight",
        "outreach_oldest_backlog_age",
        "overdue_outreach_deals",
        "qualification_backlog",
        "qualification_conversion",
        "qualification_failed",
        "qualification_in_flight",
        "qualification_oldest_backlog_age",
        "research_backlog",
        "research_failed",
        "research_in_flight",
        "research_oldest_backlog_age",
        "stalled_deals",
        "win_rate",
      ].sort(),
    );
  });
});

describe("computeSalesOrchestratorBoard — readable-zero pipeline (facts, not insufficient)", () => {
  const board = computeSalesOrchestratorBoard(
    { pipeline: { companies: [] }, drains: null, cadence: null },
    NOW,
  );

  it("empty-but-readable stage counts are honest facts of zero", () => {
    for (const key of [
      "open_pipeline",
      "deals_new",
      "deals_qualified",
      "deals_outreach_ready",
      "deals_in_conversation",
      "deals_won",
      "deals_lost",
      "stalled_deals",
    ]) {
      const m = byKey(board, key);
      expect(m.kind, key).toBe("fact");
      expect(m.value, key).toBe(0);
    }
    // The funnel renders (readable), every stage reached zero.
    expect(board.funnel.length).toBe(7);
    expect(board.funnel.every((s) => s.reached === 0)).toBe(true);
  });

  it("ratios and ages with no base are insufficient (undefined, not zero)", () => {
    for (const key of [
      "qualification_conversion",
      "outreach_conversion",
      "win_rate",
      "close_rate",
      "avg_open_deal_age",
      "oldest_open_deal_age",
    ]) {
      const m = byKey(board, key);
      expect(m.kind, key).toBe("insufficient");
      expect(m.value, key).toBeNull();
    }
  });
});

describe("computeSalesOrchestratorBoard — cadence readable-zero", () => {
  it("no active outreach deals → active is a fact of zero, health is insufficient", () => {
    const board = computeSalesOrchestratorBoard(
      {
        pipeline: null,
        drains: null,
        cadence: { activeOutreachDeals: 0, touchedWithinWindow: 0, overdue: 0 },
      },
      NOW,
    );
    expect(byKey(board, "active_outreach_deals").kind).toBe("fact");
    expect(byKey(board, "active_outreach_deals").value).toBe(0);
    expect(byKey(board, "overdue_outreach_deals").value).toBe(0);
    const h = byKey(board, "outreach_cadence_health");
    expect(h.kind).toBe("insufficient");
    expect(h.value).toBeNull();
  });
});

describe("computeSalesOrchestratorBoard — invariants across every metric", () => {
  const boards = [
    computeSalesOrchestratorBoard(FULL_INPUT, NOW),
    computeSalesOrchestratorBoard(EMPTY_INPUT, NOW),
    computeSalesOrchestratorBoard({ pipeline: { companies: [] }, drains: null, cadence: null }, NOW),
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
    expect(SALES_ORCHESTRATOR_KIND_LABEL.fact).toBe("Fact");
    expect(SALES_ORCHESTRATOR_KIND_LABEL.derived).toBe("Derived");
    expect(SALES_ORCHESTRATOR_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
