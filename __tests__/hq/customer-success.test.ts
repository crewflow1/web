import { describe, it, expect } from "vitest";
import {
  computeCustomerSuccessBoard,
  CUSTOMER_SUCCESS_KIND_LABEL,
  type CustomerSuccessBoard,
  type CustomerSuccessInput,
  type CustomerSuccessMetric,
} from "@/lib/hq/customer-success";

/**
 * HQ Customer-Success AI — pure retention / adoption board contract.
 *
 * Pins:
 *   1. Deterministic composition: the post-sale lifecycle counts, the
 *      onboarding→live completion, trial→paid conversion, 30-day activation,
 *      onboarding completion, health segmentation, churn and the time-to-value
 *      proxy are EXACT from fixtures, and the same inputs + `now` always give the
 *      same board.
 *   2. The honesty invariant: `value === null` IFF `kind === "insufficient"`. A
 *      source that could not be read → insufficient, never a fabricated zero, and
 *      never a green card conjured from absent data.
 *   3. THE NO-SOURCE SIGNALS: NPS/CSAT, renewal-cohort retention, support
 *      satisfaction and time-to-first-value have NO source in the schema and are
 *      ALWAYS insufficient — even when every other signal is present.
 *   4. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

const FULL_INPUT: CustomerSuccessInput = {
  lifecycle: {
    demoRequests: [
      { status: "payment_received", created_at: "2026-08-01T00:00:00.000Z" },
      { status: "payment_received", created_at: "2026-08-02T00:00:00.000Z" },
      { status: "active_onboarding", created_at: "2026-08-03T00:00:00.000Z" },
      { status: "active_onboarding", created_at: "2026-08-04T00:00:00.000Z" },
      { status: "active_onboarding", created_at: "2026-08-05T00:00:00.000Z" },
      { status: "active", created_at: "2026-08-06T00:00:00.000Z" },
      { status: "active", created_at: "2026-08-07T00:00:00.000Z" },
      { status: "active", created_at: "2026-08-08T00:00:00.000Z" },
      { status: "active", created_at: "2026-08-09T00:00:00.000Z" },
      // Pre-sale statuses — Customer Success owns NONE of these; they must not
      // land in any post-sale stage count.
      { status: "pending_demo", created_at: "2026-08-10T00:00:00.000Z" },
      { status: "won", created_at: "2026-08-11T00:00:00.000Z" },
      { status: "lost", created_at: "2026-08-12T00:00:00.000Z" },
    ],
  },
  health: {
    activeOrgs: 12,
    trialOrgs: 8,
    healthyCustomers: 10,
    atRiskCustomers: 5,
    criticalCustomers: 2,
    unscoredCustomers: 3,
    usageActive30d: 15,
    neverLoggedIn: 3,
    payingOrTrialBase: 20,
    onboardingAveragePct: 64.4,
    onboardingCompleted: 9,
    onboardingStalled: 2,
    avgDaysToOnboard: 5.5,
    churnPct: 4.2,
  },
};

const EMPTY_INPUT: CustomerSuccessInput = { lifecycle: null, health: null };

function byKey(board: CustomerSuccessBoard, key: string): CustomerSuccessMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeCustomerSuccessBoard — deterministic figures from fixtures", () => {
  const board = computeCustomerSuccessBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("post-sale lifecycle counts are exact facts (pre-sale rows excluded)", () => {
    expect(byKey(board, "onboarding_in_progress").kind).toBe("fact");
    expect(byKey(board, "onboarding_in_progress").value).toBe(3);
    expect(byKey(board, "fully_live").kind).toBe("fact");
    expect(byKey(board, "fully_live").value).toBe(4);
  });

  it("onboarding→live completion is derived exactly (4 live of 7 handed-off)", () => {
    const m = byKey(board, "activation_completion_rate");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(57.1); // 4 / (3 + 4) = 57.14 → 57.1
    expect(m.format).toBe("pct");
    expect(m.basis).toContain("4 live of 7");
  });

  it("the onboarding funnel is ordered paid → onboarding → live", () => {
    expect(board.onboardingFunnel).toEqual([
      { key: "funnel_paid", label: "Paid, awaiting onboarding", value: 2 },
      { key: "funnel_onboarding", label: "Onboarding", value: 3 },
      { key: "funnel_live", label: "Fully live", value: 4 },
    ]);
  });

  it("active / trial counts are exact facts", () => {
    expect(byKey(board, "active_customers").value).toBe(12);
    expect(byKey(board, "trial_customers").value).toBe(8);
  });

  it("trial→paid conversion is derived (snapshot ratio, not a cohort)", () => {
    const m = byKey(board, "trial_to_paid");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(60); // 12 / (12 + 8)
    expect(m.basis).toMatch(/NOT a cohort/i);
  });

  it("30-day activation rate is derived (15 of 20)", () => {
    const m = byKey(board, "activation_rate_30d");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(75);
    expect(byKey(board, "never_logged_in").kind).toBe("fact");
    expect(byKey(board, "never_logged_in").value).toBe(3);
  });

  it("onboarding completion and time-to-value proxy are derived", () => {
    expect(byKey(board, "onboarding_completion").kind).toBe("derived");
    expect(byKey(board, "onboarding_completion").value).toBe(64.4);
    expect(byKey(board, "onboarding_completed_count").value).toBe(9);
    expect(byKey(board, "onboarding_stalled").value).toBe(2);
    const ttv = byKey(board, "avg_time_to_onboard");
    expect(ttv.kind).toBe("derived");
    expect(ttv.value).toBe(5.5);
    expect(ttv.format).toBe("days");
    expect(ttv.basis).toMatch(/proxy/i);
  });

  it("health segmentation counts are exact facts, unscored kept separate", () => {
    expect(byKey(board, "healthy_customers").value).toBe(10);
    expect(byKey(board, "at_risk_customers").value).toBe(5);
    expect(byKey(board, "critical_customers").value).toBe(2);
    expect(byKey(board, "unscored_customers").value).toBe(3);
    expect(board.healthSegments).toEqual([
      { key: "seg_healthy", label: "Healthy (70+)", value: 10 },
      { key: "seg_at_risk", label: "At risk (40–69)", value: 5 },
      { key: "seg_critical", label: "Critical (<40)", value: 2 },
      { key: "seg_unscored", label: "Unscored", value: 3 },
    ]);
  });

  it("churn is derived from the passed churn figure", () => {
    const m = byKey(board, "churn_30d");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(4.2);
    expect(m.basis).toMatch(/not a cohort retention curve/i);
  });

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeCustomerSuccessBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeCustomerSuccessBoard — the no-source metrics are ALWAYS insufficient", () => {
  // Even with EVERY other signal present, NPS/CSAT, renewal cohort, support
  // satisfaction and time-to-first-value have no schema source.
  const board = computeCustomerSuccessBoard(FULL_INPUT, NOW);

  it("NPS/CSAT, renewal cohort, support satisfaction, TTFV are insufficient", () => {
    for (const key of [
      "nps_csat",
      "renewal_retention_cohort",
      "support_satisfaction",
      "time_to_first_value",
    ]) {
      const m = byKey(board, key);
      expect(m.kind, key).toBe("insufficient");
      expect(m.value, key).toBeNull();
      expect(m.basis, key).toMatch(/not fabricated|cannot be measured/i);
    }
    expect(byKey(board, "nps_csat").basis).toMatch(/survey/i);
    expect(byKey(board, "renewal_retention_cohort").basis).toMatch(/cohort/i);
    expect(byKey(board, "time_to_first_value").basis).toMatch(/proxy/i);
  });
});

describe("computeCustomerSuccessBoard — insufficient when a source is unreadable", () => {
  const board = computeCustomerSuccessBoard(EMPTY_INPUT, NOW);

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.onboardingFunnel).toEqual([]);
    expect(board.healthSegments).toBeNull();
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "activation_completion_rate",
        "activation_rate_30d",
        "active_customers",
        "at_risk_customers",
        "avg_time_to_onboard",
        "churn_30d",
        "critical_customers",
        "fully_live",
        "healthy_customers",
        "never_logged_in",
        "nps_csat",
        "onboarding_completed_count",
        "onboarding_completion",
        "onboarding_in_progress",
        "onboarding_stalled",
        "renewal_retention_cohort",
        "support_satisfaction",
        "time_to_first_value",
        "trial_customers",
        "trial_to_paid",
        "unscored_customers",
      ].sort(),
    );
  });
});

describe("computeCustomerSuccessBoard — boundary insufficient cases", () => {
  it("onboarding→live completion is insufficient with no handed-off accounts", () => {
    const board = computeCustomerSuccessBoard(
      {
        ...FULL_INPUT,
        lifecycle: {
          demoRequests: [
            { status: "payment_received", created_at: "2026-08-01T00:00:00.000Z" },
            { status: "pending_demo", created_at: "2026-08-02T00:00:00.000Z" },
          ],
        },
      },
      NOW,
    );
    const m = byKey(board, "activation_completion_rate");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    // Zero counts are still honest facts, not insufficient.
    expect(byKey(board, "onboarding_in_progress").kind).toBe("fact");
    expect(byKey(board, "onboarding_in_progress").value).toBe(0);
    expect(byKey(board, "fully_live").value).toBe(0);
  });

  it("trial→paid and activation are insufficient when there is no base", () => {
    const board = computeCustomerSuccessBoard(
      {
        ...FULL_INPUT,
        health: {
          ...FULL_INPUT.health!,
          activeOrgs: 0,
          trialOrgs: 0,
          payingOrTrialBase: 0,
        },
      },
      NOW,
    );
    expect(byKey(board, "trial_to_paid").kind).toBe("insufficient");
    expect(byKey(board, "trial_to_paid").value).toBeNull();
    expect(byKey(board, "activation_rate_30d").kind).toBe("insufficient");
    expect(byKey(board, "onboarding_completion").kind).toBe("insufficient");
    // Zero counts remain honest facts.
    expect(byKey(board, "active_customers").kind).toBe("fact");
    expect(byKey(board, "active_customers").value).toBe(0);
  });

  it("avg onboarding time is insufficient when nothing has completed (null proxy)", () => {
    const board = computeCustomerSuccessBoard(
      {
        ...FULL_INPUT,
        health: { ...FULL_INPUT.health!, avgDaysToOnboard: null },
      },
      NOW,
    );
    const m = byKey(board, "avg_time_to_onboard");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    // A completed COUNT of zero is still an honest fact, never insufficient.
    expect(byKey(board, "onboarding_completed_count").kind).toBe("fact");
  });

  it("funnel omits stages when only the health source is readable", () => {
    const board = computeCustomerSuccessBoard(
      { lifecycle: null, health: FULL_INPUT.health },
      NOW,
    );
    expect(board.onboardingFunnel).toEqual([]);
    expect(board.healthSegments).not.toBeNull();
    expect(byKey(board, "onboarding_in_progress").kind).toBe("insufficient");
    expect(byKey(board, "active_customers").kind).toBe("fact");
  });

  it("health segments are null when only the lifecycle source is readable", () => {
    const board = computeCustomerSuccessBoard(
      { lifecycle: FULL_INPUT.lifecycle, health: null },
      NOW,
    );
    expect(board.healthSegments).toBeNull();
    expect(board.onboardingFunnel.map((s) => s.key)).toEqual([
      "funnel_paid",
      "funnel_onboarding",
      "funnel_live",
    ]);
  });
});

describe("computeCustomerSuccessBoard — invariants across every metric", () => {
  const boards = [
    computeCustomerSuccessBoard(FULL_INPUT, NOW),
    computeCustomerSuccessBoard(EMPTY_INPUT, NOW),
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
    expect(CUSTOMER_SUCCESS_KIND_LABEL.fact).toBe("Fact");
    expect(CUSTOMER_SUCCESS_KIND_LABEL.derived).toBe("Derived");
    expect(CUSTOMER_SUCCESS_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
