import { describe, it, expect } from "vitest";
import {
  computeMarketingBoard,
  MARKETING_KIND_LABEL,
  type MarketingBoard,
  type MarketingInput,
  type MarketingMetric,
} from "@/lib/hq/marketing";

/**
 * HQ Marketing AI — pure top-of-funnel / acquisition board contract.
 *
 * Pins:
 *   1. Deterministic composition: demo-request volume/pending/approved, the
 *      demo approval rate, trial/active counts, trial→paid conversion, new
 *      customers this month and growth MoM are EXACT from fixtures, and the same
 *      inputs + `now` always give the same board.
 *   2. The honesty invariant: `value === null` IFF `kind === "insufficient"`.
 *      A source that could not be read → insufficient, never a fabricated zero.
 *   3. THE NO-DATA SOURCES: marketing channel attribution, campaign performance,
 *      ad spend / CAC and SEO rankings have NO source in the schema and are
 *      ALWAYS insufficient — even when every other signal is present. This is the
 *      explicit honesty requirement (channel/campaign/spend/SEO have no source).
 *   4. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const FULL_INPUT: MarketingInput = {
  leads: {
    demoRequests: [
      { status: "pending_demo", source: "landing", created_at: iso(-2 * DAY) },
      { status: "demo_booked", source: "landing", created_at: iso(-5 * DAY) },
      { status: "approved", source: "landing", created_at: iso(-40 * DAY) },
      { status: "approved", source: "referral", created_at: iso(-10 * DAY) },
      { status: "rejected", source: "referral", created_at: iso(-50 * DAY) },
      { status: "closed_won", source: "web", created_at: iso(-1 * DAY) },
      { status: "closed_lost", source: "web", created_at: iso(-3 * DAY) },
      { status: "new", source: "landing", created_at: iso(-100 * DAY) },
    ],
  },
  acquisition: {
    activeOrgs: 12,
    trialOrgs: 8,
    pendingOrgs: 3,
    newCustomersThisMonth: 4,
    growthPct: 25,
  },
};

const EMPTY_INPUT: MarketingInput = { leads: null, acquisition: null };

function byKey(board: MarketingBoard, key: string): MarketingMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeMarketingBoard — deterministic figures from fixtures", () => {
  const board = computeMarketingBoard(FULL_INPUT, NOW);

  it("labels the period from the injected `now` (UTC)", () => {
    expect(board.periodLabel).toBe("August 2026");
    expect(board.asOf).toBe(NOW.toISOString());
  });

  it("demo-request volume, momentum, pending and approved are exact facts", () => {
    expect(byKey(board, "lead_volume_total").kind).toBe("fact");
    expect(byKey(board, "lead_volume_total").value).toBe(8);
    expect(byKey(board, "lead_volume_new_30d").value).toBe(5);
    expect(byKey(board, "demos_pending").value).toBe(2); // pending_demo + legacy new
    expect(byKey(board, "demos_approved").value).toBe(3); // approved ×2 + closed_won
  });

  it("demo approval rate is derived exactly (3 won of 5 decided = 60%)", () => {
    const m = byKey(board, "demo_approval_rate");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(60);
    expect(m.format).toBe("pct");
    expect(m.basis).toContain("3 greenlit of 5");
    expect(m.basis).toContain("won + lost terminals");
  });

  it("customer funnel counts (trial / active) are exact facts", () => {
    expect(byKey(board, "trial_signups").value).toBe(8);
    expect(byKey(board, "active_customers").value).toBe(12);
    expect(byKey(board, "new_customers_month").value).toBe(4);
  });

  it("trial→paid conversion is derived (snapshot ratio, not a cohort)", () => {
    const m = byKey(board, "trial_to_paid");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(60); // 12 active / (12 + 8) = 60%
    expect(m.format).toBe("pct");
    expect(m.basis).toMatch(/snapshot ratio/i);
    expect(m.basis).toMatch(/not a cohort/i);
  });

  it("customer growth MoM is derived from the passed growth figure", () => {
    const m = byKey(board, "growth_mom");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(25);
    expect(m.format).toBe("pct");
  });

  it("the lead-source breakdown groups by stored source, ordered by volume", () => {
    expect(board.sources).not.toBeNull();
    expect(board.sources!.total).toBe(8);
    expect(board.sources!.breakdown).toEqual([
      { source: "landing", label: "Landing page", total: 4, new30d: 2 },
      { source: "referral", label: "Referral", total: 2, new30d: 1 },
      { source: "web", label: "Web", total: 2, new30d: 2 },
    ]);
  });

  it("the acquisition funnel is ordered widest→narrowest across both sources", () => {
    expect(board.funnel).toEqual([
      { key: "funnel_demo_requests", label: "Demo requests", value: 8, source: "demo_requests" },
      { key: "funnel_demos_approved", label: "Demos approved", value: 3, source: "demo_requests" },
      { key: "funnel_trials", label: "Trials", value: 8, source: "organizations" },
      { key: "funnel_active", label: "Active customers", value: 12, source: "organizations" },
    ]);
  });

  it("is deterministic — same inputs + now give an identical board", () => {
    expect(computeMarketingBoard(FULL_INPUT, NOW)).toEqual(board);
  });
});

describe("computeMarketingBoard — the no-source metrics are ALWAYS insufficient", () => {
  // Even with EVERY other signal present, channel/campaign/spend/SEO have no
  // schema source and must never be fabricated.
  const board = computeMarketingBoard(FULL_INPUT, NOW);

  it("channel attribution is insufficient (source is a form-origin tag, not a channel)", () => {
    const m = byKey(board, "channel_attribution");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/form-origin/i);
    expect(m.basis).toMatch(/not fabricated/i);
  });

  it("campaign performance, ad spend/CAC and SEO rankings are insufficient", () => {
    for (const key of ["campaign_performance", "ad_spend_cac", "seo_rankings"]) {
      const m = byKey(board, key);
      expect(m.kind, key).toBe("insufficient");
      expect(m.value, key).toBeNull();
      expect(m.basis, key).toMatch(/not fabricated/i);
    }
    expect(byKey(board, "ad_spend_cac").basis).toMatch(/acquisition cost/i);
    expect(byKey(board, "seo_rankings").basis).toMatch(/keyword-ranking/i);
  });
});

describe("computeMarketingBoard — insufficient when a source is unreadable", () => {
  const board = computeMarketingBoard(EMPTY_INPUT, NOW);

  it("every metric is insufficient with value null when all sources are null", () => {
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
    }
    expect(board.sources).toBeNull();
    expect(board.funnel).toEqual([]);
  });

  it("still emits the full metric set (nothing dropped on the dark path)", () => {
    const keys = board.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "active_customers",
        "ad_spend_cac",
        "campaign_performance",
        "channel_attribution",
        "demo_approval_rate",
        "demos_approved",
        "demos_pending",
        "growth_mom",
        "lead_volume_new_30d",
        "lead_volume_total",
        "new_customers_month",
        "seo_rankings",
        "trial_signups",
        "trial_to_paid",
      ].sort(),
    );
  });
});

describe("computeMarketingBoard — boundary insufficient cases", () => {
  it("demo approval rate is insufficient when NO demo has been decided", () => {
    const board = computeMarketingBoard(
      {
        ...FULL_INPUT,
        leads: {
          demoRequests: [
            { status: "pending_demo", source: "landing", created_at: iso(-1 * DAY) },
            { status: "demo_booked", source: "landing", created_at: iso(-2 * DAY) },
          ],
        },
      },
      NOW,
    );
    const m = byKey(board, "demo_approval_rate");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    // Volume over an undecided set is still an honest fact.
    expect(byKey(board, "lead_volume_total").kind).toBe("fact");
    expect(byKey(board, "lead_volume_total").value).toBe(2);
    expect(byKey(board, "demos_approved").value).toBe(0);
  });

  it("trial→paid conversion is insufficient when there is no active-or-trial base", () => {
    const board = computeMarketingBoard(
      {
        ...FULL_INPUT,
        acquisition: {
          activeOrgs: 0,
          trialOrgs: 0,
          pendingOrgs: 5,
          newCustomersThisMonth: 0,
          growthPct: 0,
        },
      },
      NOW,
    );
    const m = byKey(board, "trial_to_paid");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    // Zero counts are still honest facts, not insufficient.
    expect(byKey(board, "active_customers").kind).toBe("fact");
    expect(byKey(board, "active_customers").value).toBe(0);
  });

  it("rounds the demo approval rate to one decimal (1 won of 3 decided)", () => {
    const board = computeMarketingBoard(
      {
        ...FULL_INPUT,
        leads: {
          demoRequests: [
            { status: "approved", source: "web", created_at: iso(-1 * DAY) },
            { status: "rejected", source: "web", created_at: iso(-2 * DAY) },
            { status: "rejected", source: "web", created_at: iso(-3 * DAY) },
          ],
        },
      },
      NOW,
    );
    expect(byKey(board, "demo_approval_rate").value).toBe(33.3);
  });

  it("a future-stamped demo request is excluded from the 30-day window (never negative-aged in)", () => {
    const board = computeMarketingBoard(
      {
        ...FULL_INPUT,
        leads: {
          demoRequests: [
            { status: "pending_demo", source: "landing", created_at: iso(2 * DAY) },
          ],
        },
      },
      NOW,
    );
    expect(byKey(board, "lead_volume_total").value).toBe(1);
    // Created "in the future" relative to now → age = now - created is negative,
    // which is OUTSIDE the [0, 30d] window, so it is NOT counted as new. The row
    // is still an honest all-time fact (total = 1); it is only excluded from the
    // 30-day momentum figure, never dropped or NaN'd.
    expect(byKey(board, "lead_volume_new_30d").value).toBe(0);
  });

  it("funnel omits demo stages when only the acquisition source is readable", () => {
    const board = computeMarketingBoard(
      { leads: null, acquisition: FULL_INPUT.acquisition },
      NOW,
    );
    expect(board.funnel.map((s) => s.key)).toEqual(["funnel_trials", "funnel_active"]);
    expect(board.sources).toBeNull();
  });

  it("funnel omits customer stages when only the leads source is readable", () => {
    const board = computeMarketingBoard(
      { leads: FULL_INPUT.leads, acquisition: null },
      NOW,
    );
    expect(board.funnel.map((s) => s.key)).toEqual([
      "funnel_demo_requests",
      "funnel_demos_approved",
    ]);
  });

  it("an unspecified/empty source folds into an 'Unspecified' bucket", () => {
    const board = computeMarketingBoard(
      {
        ...FULL_INPUT,
        leads: {
          demoRequests: [
            { status: "pending_demo", source: "", created_at: iso(-1 * DAY) },
            { status: "pending_demo", source: "unspecified", created_at: iso(-2 * DAY) },
          ],
        },
      },
      NOW,
    );
    expect(board.sources!.breakdown).toEqual([
      { source: "unspecified", label: "Unspecified", total: 2, new30d: 2 },
    ]);
  });
});

describe("computeMarketingBoard — LIVE sales-kanban lifecycle statuses", () => {
  // The current kanban (20260604000000_hq_shell_demos_lifecycle.sql) writes the
  // new lifecycle vocab — won/lost/payment_*/active — NOT the legacy
  // approved/closed_won. The classifier MUST recognise these or `demos_approved`
  // reads a false zero on real data and the rate falsely claims "no decisions".
  const LIVE_INPUT: MarketingInput = {
    ...FULL_INPUT,
    leads: {
      demoRequests: [
        { status: "won", source: "landing", created_at: iso(-1 * DAY) },
        { status: "payment_received", source: "referral", created_at: iso(-2 * DAY) },
        { status: "active", source: "web", created_at: iso(-3 * DAY) },
        { status: "lost", source: "web", created_at: iso(-4 * DAY) },
        // Mid-funnel: worked but undecided — neither won nor lost.
        { status: "demo_done", source: "landing", created_at: iso(-5 * DAY) },
      ],
    },
  };
  const board = computeMarketingBoard(LIVE_INPUT, NOW);

  it("won / payment_received / active all land in demos_approved (greenlit or beyond)", () => {
    const m = byKey(board, "demos_approved");
    expect(m.kind).toBe("fact");
    expect(m.value).toBe(3); // won + payment_received + active
  });

  it("lost counts as a decision in the denominator; demo_done (mid-funnel) does not", () => {
    const m = byKey(board, "demo_approval_rate");
    expect(m.kind).toBe("derived");
    // 3 greenlit of 4 decided (3 won-terminals + 1 lost); demo_done excluded.
    expect(m.value).toBe(75);
    expect(m.format).toBe("pct");
    expect(m.basis).toContain("3 greenlit of 4");
    expect(m.basis).toContain("won + lost terminals");
    // The mid-funnel row is still counted as volume, never as a decision.
    expect(byKey(board, "lead_volume_total").value).toBe(5);
  });

  it("a won/lost-only dataset computes a real rate — never the 'no decisions yet' message", () => {
    const wonLostOnly = computeMarketingBoard(
      {
        ...FULL_INPUT,
        leads: {
          demoRequests: [
            { status: "won", source: "landing", created_at: iso(-1 * DAY) },
            { status: "payment_received", source: "web", created_at: iso(-2 * DAY) },
            { status: "lost", source: "referral", created_at: iso(-3 * DAY) },
          ],
        },
      },
      NOW,
    );
    const m = byKey(wonLostOnly, "demo_approval_rate");
    expect(m.kind).toBe("derived"); // NOT insufficient
    expect(m.value).toBe(66.7); // 2 greenlit of 3 decided, rounded to 1dp
    expect(m.basis).not.toMatch(/No demo requests have reached/i);
    expect(byKey(wonLostOnly, "demos_approved").value).toBe(2);
  });
});

describe("computeMarketingBoard — invariants across every metric", () => {
  const boards = [
    computeMarketingBoard(FULL_INPUT, NOW),
    computeMarketingBoard(EMPTY_INPUT, NOW),
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
    expect(MARKETING_KIND_LABEL.fact).toBe("Fact");
    expect(MARKETING_KIND_LABEL.derived).toBe("Derived");
    expect(MARKETING_KIND_LABEL.insufficient).toBe("Insufficient data");
  });
});
