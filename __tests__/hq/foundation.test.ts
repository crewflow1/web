import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeMetrics,
  buildMorningSummary,
  monthBuckets,
  sparklinePoints,
  MONTHLY_PRICE_GBP,
  SETUP_FEE_GBP,
  type HqSnapshot,
} from "@/lib/hq/metrics";

/**
 * CrewFlow HQ Sprint 1 — foundation + overview contract tests.
 *
 *  1. Metrics compute is exact for synthetic snapshots
 *  2. Morning summary is deterministic
 *  3. Month bucketing is timezone-safe (UTC)
 *  4. Sparkline points stay in-frame
 *  5. /admin/* routes 404 for non-allowlisted users (gate intact)
 *  6. HQ nav covers every directive section, none missing
 *  7. Stub pages exist for every section the directive listed and
 *     are NOT dead-ends — each links to a working surface or back
 *     to overview
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const LAYOUT = read("app/admin/layout.tsx");
const OVERVIEW = read("app/admin/overview/page.tsx");
const COMING_SOON = read("app/admin/_coming-soon.tsx");

function emptySnapshot(): HqSnapshot {
  const buckets = monthBuckets(12);
  return {
    demos: {
      pending_demo: 0,
      demo_booked: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      legacy_new: 0,
    },
    orgs: {
      pending: 0,
      trial: 0,
      active: 0,
      suspended: 0,
      rejected: 0,
      cancelled: 0,
    },
    setupFees: { paid_orgs: 0, pending_orgs: 0 },
    series: {
      customerGrowth: buckets.map((m) => ({ month: m, count: 0 })),
      mrr: buckets.map((m) => ({ month: m, mrr: 0 })),
      cancellation: buckets.map((m) => ({ month: m, count: 0 })),
      revenue: buckets.map((m) => ({ month: m, revenue: 0 })),
    },
    generatedAt: "2026-05-22T00:00:00Z",
  };
}

describe("computeMetrics", () => {
  it("zero everywhere when the snapshot is empty", () => {
    const m = computeMetrics(emptySnapshot());
    expect(m).toEqual({
      mrrGbp: 0,
      setupFeesEarnedGbp: 0,
      activeCustomers: 0,
      activeOnboarding: 0,
      pendingDemos: 0,
      cancelledCustomers: 0,
      forecastMrrGbp: 0,
      growthPct: 0,
    });
  });

  it("MRR = active × £500", () => {
    const snap = emptySnapshot();
    snap.orgs.active = 9;
    expect(computeMetrics(snap).mrrGbp).toBe(9 * MONTHLY_PRICE_GBP);
  });

  it("Forecast MRR = (active + trial) × £500", () => {
    const snap = emptySnapshot();
    snap.orgs.active = 3;
    snap.orgs.trial = 5;
    expect(computeMetrics(snap).forecastMrrGbp).toBe(8 * MONTHLY_PRICE_GBP);
  });

  it("Setup fees = paid_orgs × £1,000", () => {
    const snap = emptySnapshot();
    snap.setupFees.paid_orgs = 4;
    expect(computeMetrics(snap).setupFeesEarnedGbp).toBe(4 * SETUP_FEE_GBP);
  });

  it("Pending demos count includes legacy 'new' rows", () => {
    const snap = emptySnapshot();
    snap.demos.pending_demo = 3;
    snap.demos.legacy_new = 2;
    expect(computeMetrics(snap).pendingDemos).toBe(5);
  });

  it("Growth % = ((current - previous) / previous) × 100 from the cumulative customer-growth series", () => {
    const snap = emptySnapshot();
    // Cumulative ends at month 11. Two non-zero buckets:
    snap.series.customerGrowth = snap.series.customerGrowth.map((row, i) => ({
      month: row.month,
      count: i === 10 ? 10 : i === 11 ? 2 : 0,
    }));
    // Cumulative: …,10 at idx 10, 12 at idx 11. Growth = (12-10)/10 = 20%.
    const m = computeMetrics(snap);
    expect(m.growthPct).toBe(20);
  });

  it("Growth % returns 100 when there's no previous cumulative but a current value", () => {
    const snap = emptySnapshot();
    snap.series.customerGrowth = snap.series.customerGrowth.map((row, i) => ({
      month: row.month,
      count: i === 11 ? 1 : 0,
    }));
    expect(computeMetrics(snap).growthPct).toBe(100);
  });

  it("Growth % clamps at ±999 to keep the UI from breaking", () => {
    const snap = emptySnapshot();
    // 1 → 1000 over one step = 99900%. Should clamp.
    snap.series.customerGrowth = snap.series.customerGrowth.map((row, i) => ({
      month: row.month,
      count: i === 10 ? 1 : i === 11 ? 999 : 0,
    }));
    expect(computeMetrics(snap).growthPct).toBe(999);
  });
});

describe("buildMorningSummary", () => {
  const noon = new Date("2026-05-22T12:00:00Z");

  it("greets with first name in the afternoon (UTC noon)", () => {
    const snap = emptySnapshot();
    snap.orgs.active = 1;
    const metrics = computeMetrics(snap);
    const s = buildMorningSummary(metrics, "Moe", noon);
    expect(s.greeting).toMatch(/^Good afternoon Moe\./);
  });

  it("falls back to no-name greeting when full_name is null", () => {
    const s = buildMorningSummary(computeMetrics(emptySnapshot()), null, noon);
    expect(s.greeting).toBe("Good afternoon.");
  });

  it("surfaces exactly 5 bullet lines with the directive's labels", () => {
    const s = buildMorningSummary(computeMetrics(emptySnapshot()), null, noon);
    expect(s.bullets).toHaveLength(5);
    const labels = s.bullets.map((b) => b.label);
    expect(labels).toEqual([
      "New demos awaiting contact",
      "Customers in onboarding/trial",
      "Active paying customers",
      "MRR right now",
      "Forecast MRR (incl. trials)",
    ]);
  });

  it("formats MRR as GBP with thousand separators", () => {
    const snap = emptySnapshot();
    snap.orgs.active = 9; // £4,500
    const s = buildMorningSummary(computeMetrics(snap), null, noon);
    expect(s.bullets.find((b) => b.label === "MRR right now")?.value).toBe(
      "£4,500",
    );
  });
});

describe("monthBuckets", () => {
  it("returns 12 buckets ending at the anchor month, oldest → newest", () => {
    const anchor = new Date(Date.UTC(2026, 4, 22)); // 2026-05
    const out = monthBuckets(12, anchor);
    expect(out).toHaveLength(12);
    expect(out[0]).toBe("2025-06");
    expect(out[11]).toBe("2026-05");
  });

  it("uses UTC so DST doesn't shift the answer", () => {
    // UK clocks went forward on 2026-03-29. Anchor right after.
    const anchor = new Date(Date.UTC(2026, 2, 30));
    const out = monthBuckets(3, anchor);
    expect(out).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

describe("sparklinePoints", () => {
  it("returns an empty path for an empty series", () => {
    const out = sparklinePoints([], "count", 100, 50);
    expect(out.d).toBe("");
  });

  it("produces an SVG path starting with M and using L between points", () => {
    const series = [
      { month: "a", count: 0 },
      { month: "b", count: 10 },
      { month: "c", count: 5 },
    ];
    const out = sparklinePoints(series, "count", 100, 50);
    expect(out.d.startsWith("M ")).toBe(true);
    expect(out.d).toContain(" L ");
  });
});

describe("HQ layout — auth gate", () => {
  it("layout calls isSuperAdminEmail and 404s when it returns false", () => {
    expect(LAYOUT).toMatch(/isSuperAdminEmail\(user\.email\)/);
    expect(LAYOUT).toMatch(/notFound\(\)/);
  });

  it("layout enforces gate via the requireUser → check → notFound chain", () => {
    const idxRequire = LAYOUT.indexOf("await requireUser()");
    // Match the actual call site (with semicolon), not the prose mention
    // in the doc-comment block that sits above the code.
    const idxNotFound = LAYOUT.indexOf("notFound();");
    expect(idxRequire).toBeGreaterThan(0);
    expect(idxNotFound).toBeGreaterThan(idxRequire);
  });

  it("HQ_NAV is exported as a named ReadonlyArray", () => {
    expect(LAYOUT).toMatch(/export const HQ_NAV/);
  });

  it("HQ_NAV covers every directive section (12 entries)", () => {
    const navEntries = (LAYOUT.match(/href:\s*"\/admin\/[^"]+"/g) ?? []).length;
    // 12 sections from the directive — all present in the nav.
    expect(navEntries).toBe(12);
  });

  it("each non-overview section is annotated with the sprint it ships in (no silent stubs)", () => {
    // Sections still on the roadmap carry a shipsIn annotation. As each
    // sprint flips a section to ready, the annotation drops — so this
    // threshold decreases over time. HQ-2 ships /admin/demos, so demos
    // no longer needs `shipsIn` — there are now 10 stub sections left
    // (customers, onboarding, billing, support, alerts, analytics,
    // impersonation, notes, health, settings).
    const shipsInCount = (LAYOUT.match(/shipsIn:/g) ?? []).length;
    expect(shipsInCount).toBeGreaterThanOrEqual(10);
  });
});

describe("Overview page", () => {
  it("imports the snapshot service + metrics", () => {
    expect(OVERVIEW).toMatch(/buildHqSnapshot/);
    expect(OVERVIEW).toMatch(/computeMetrics/);
    expect(OVERVIEW).toMatch(/buildMorningSummary/);
  });

  it("renders all 4 directive-required sparklines (revenue / mrr / growth / cancellation)", () => {
    expect(OVERVIEW).toMatch(/Revenue \(12 mo\)/);
    expect(OVERVIEW).toMatch(/MRR \(12 mo\)/);
    expect(OVERVIEW).toMatch(/Customer growth \(12 mo\)/);
    expect(OVERVIEW).toMatch(/Cancellations \(12 mo\)/);
  });

  it("each sparkline card has an empty-state fallback (rule 6 — empty state)", () => {
    expect(OVERVIEW).toMatch(/No data in this window yet/);
  });
});

describe("Stubs — no dead ends (rule 5)", () => {
  it("ComingSoonStub always links somewhere working", () => {
    // Either the optional primary CTA OR the always-rendered overview link.
    expect(COMING_SOON).toMatch(/href="\/admin\/overview"/);
  });

  it("ComingSoonStub announces which sprint will ship the section", () => {
    expect(COMING_SOON).toMatch(/Ships in \{sprint\}/);
  });
});
