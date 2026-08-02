import { describe, it, expect } from "vitest";
import {
  computeProductBoard,
  PRODUCT_KIND_LABEL,
  type ProductBoard,
  type ProductInput,
  type ProductMetric,
  type ProductTicketRow,
} from "@/lib/hq/product";

/**
 * HQ Product AI — pure voice-of-customer board contract.
 *
 * Pins:
 *   1. Deterministic composition: feature-request volume (all-time / open /
 *      new-30d / aging), open bug reports, adoption counts, activation rate, and
 *      customer growth are EXACT from fixtures, and the same inputs + `now` always
 *      give the same board.
 *   2. The honesty invariant: `value === null` IFF `kind === "insufficient"`.
 *      A source that could not be read → insufficient, never a fabricated zero.
 *   3. THE NO-DATA SOURCES: competitor signals, roadmap priority score, and
 *      keyword themes have NO source (or would need PII) and are ALWAYS
 *      insufficient — even when every other signal is present.
 *   4. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const DAY = 86_400_000;

// Feature requests:
//   - open + new (created 5 days ago)          → open, new30d
//   - open + aging (created 40 days ago)        → open, aging
//   - closed (created 10 days ago)              → total only, new30d (created <=30d)
// Bugs:
//   - one open, one resolved
// Other categories for the theme distribution.
const TICKETS: ProductTicketRow[] = [
  { category: "feature_request", status: "open", created_at: iso(-5 * DAY) },
  { category: "feature_request", status: "in_progress", created_at: iso(-40 * DAY) },
  { category: "feature_request", status: "closed", created_at: iso(-10 * DAY) },
  { category: "bug", status: "open", created_at: iso(-3 * DAY) },
  { category: "bug", status: "resolved", created_at: iso(-60 * DAY) },
  { category: "billing", status: "open", created_at: iso(-1 * DAY) },
  { category: "billing", status: "closed", created_at: iso(-2 * DAY) },
  { category: "billing", status: "waiting_on_customer", created_at: iso(-2 * DAY) },
];

const FULL_INPUT: ProductInput = {
  demand: { tickets: TICKETS },
  adoption: {
    activeOrgs: 8,
    trialOrgs: 2,
    usageActive30d: 6,
    usageNeverLoggedIn: 1,
    payingOrTrialBase: 10,
    growthPct: 12.5,
  },
};

function byKey(board: ProductBoard, key: string): ProductMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeProductBoard — deterministic figures from fixtures", () => {
  const board = computeProductBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("feature-request volume facts are exact", () => {
    expect(byKey(board, "feature_requests_total").kind).toBe("fact");
    expect(byKey(board, "feature_requests_total").value).toBe(3);
    expect(byKey(board, "feature_requests_open").value).toBe(2);
    // new-30d: the 5-day and 10-day tickets (the 40-day one is excluded).
    expect(byKey(board, "feature_requests_new_30d").value).toBe(2);
    // aging: only the open, 40-day-old request.
    expect(byKey(board, "feature_requests_aging").value).toBe(1);
  });

  it("open bug reports counts active-status bug tickets only", () => {
    const bugs = byKey(board, "bug_reports_open");
    expect(bugs.kind).toBe("fact");
    expect(bugs.value).toBe(1);
  });

  it("adoption counts are exact facts", () => {
    expect(byKey(board, "active_orgs").value).toBe(8);
    expect(byKey(board, "trial_orgs").value).toBe(2);
    expect(byKey(board, "usage_active_30d").value).toBe(6);
    expect(byKey(board, "usage_never_logged_in").value).toBe(1);
  });

  it("activation rate is derived exactly (6 of 10 = 60%)", () => {
    const rate = byKey(board, "activation_rate_30d");
    expect(rate.kind).toBe("derived");
    expect(rate.value).toBe(60);
    expect(rate.format).toBe("pct");
  });

  it("customer growth is derived from the series pct", () => {
    const g = byKey(board, "customer_growth_mom");
    expect(g.kind).toBe("derived");
    expect(g.value).toBe(12.5);
    expect(g.format).toBe("pct");
  });

  it("demand themes are grouped by category, sorted by total desc then name", () => {
    expect(board.demand).not.toBeNull();
    expect(board.demand!.totalTickets).toBe(8);
    const themes = board.demand!.themes;
    // billing (3) = feature_request (3) > bug (2) → the two 3s tie-break by
    // category name (billing < feature_request), then bug.
    expect(themes.map((t) => t.category)).toEqual([
      "billing",
      "feature_request",
      "bug",
    ]);
    const billing = themes.find((t) => t.category === "billing")!;
    expect(billing.total).toBe(3);
    expect(billing.open).toBe(2); // open + waiting_on_customer are active; closed is not
    expect(billing.label).toBe("Billing");
  });

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeProductBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeProductBoard — no-source metrics are ALWAYS insufficient", () => {
  const board = computeProductBoard(FULL_INPUT, NOW);

  it("competitor signals and roadmap priority have no schema source", () => {
    for (const key of ["competitor_signals", "roadmap_priority_score"]) {
      const m = byKey(board, key);
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
      expect(m.basis).toMatch(/no .*table.*schema/i);
      expect(m.basis).toMatch(/not fabricated/i);
    }
  });

  it("keyword themes are insufficient — extracting them would need ticket bodies (PII)", () => {
    const m = byKey(board, "keyword_themes");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/PII/i);
  });
});

describe("computeProductBoard — insufficient when a source is unreadable", () => {
  const board = computeProductBoard({ demand: null, adoption: null }, NOW);

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.demand).toBeNull();
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "activation_rate_30d",
        "active_orgs",
        "bug_reports_open",
        "competitor_signals",
        "customer_growth_mom",
        "feature_requests_aging",
        "feature_requests_new_30d",
        "feature_requests_open",
        "feature_requests_total",
        "keyword_themes",
        "roadmap_priority_score",
        "trial_orgs",
        "usage_active_30d",
        "usage_never_logged_in",
      ].sort(),
    );
  });
});

describe("computeProductBoard — boundary insufficient cases", () => {
  it("activation rate is insufficient when the paying-or-trial base is zero", () => {
    const board = computeProductBoard(
      {
        ...FULL_INPUT,
        adoption: {
          activeOrgs: 0,
          trialOrgs: 0,
          usageActive30d: 0,
          usageNeverLoggedIn: 0,
          payingOrTrialBase: 0,
          growthPct: 0,
        },
      },
      NOW,
    );
    const rate = byKey(board, "activation_rate_30d");
    expect(rate.kind).toBe("insufficient");
    expect(rate.value).toBeNull();
    // Counts over an empty base are still honest facts, not insufficient.
    expect(byKey(board, "active_orgs").kind).toBe("fact");
    expect(byKey(board, "active_orgs").value).toBe(0);
  });

  it("empty ticket window yields fact zeros for demand and an empty theme list", () => {
    const board = computeProductBoard(
      { ...FULL_INPUT, demand: { tickets: [] } },
      NOW,
    );
    expect(byKey(board, "feature_requests_total").kind).toBe("fact");
    expect(byKey(board, "feature_requests_total").value).toBe(0);
    expect(byKey(board, "bug_reports_open").value).toBe(0);
    expect(board.demand).not.toBeNull();
    expect(board.demand!.themes).toEqual([]);
    expect(board.demand!.totalTickets).toBe(0);
  });

  it("negative customer growth is preserved (a real derived figure, not clamped to null)", () => {
    const board = computeProductBoard(
      { ...FULL_INPUT, adoption: { ...FULL_INPUT.adoption!, growthPct: -4.2 } },
      NOW,
    );
    const g = byKey(board, "customer_growth_mom");
    expect(g.kind).toBe("derived");
    expect(g.value).toBe(-4.2);
  });
});

describe("computeProductBoard — invariants across every metric", () => {
  const boards = [
    computeProductBoard(FULL_INPUT, NOW),
    computeProductBoard({ demand: null, adoption: null }, NOW),
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
    expect(PRODUCT_KIND_LABEL.fact).toBe("Fact");
    expect(PRODUCT_KIND_LABEL.derived).toBe("Derived");
    expect(PRODUCT_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
