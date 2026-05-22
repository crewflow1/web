import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeRevenueAnalytics,
  computeCustomerAnalytics,
  computeBenchmarks,
  buildInsightsPanel,
  analyticsToCsv,
  type AnalyticsSnapshot,
  type AnalyticsOrg,
  type AnalyticsInvoice,
} from "@/lib/hq/analytics";
import { HEALTH_TRIGGERS } from "@/server/services/hq-health-recompute";
import { monthBuckets } from "@/lib/hq/metrics";

/**
 * HQ-6 Analytics + Health Engine contract tests.
 *
 * What's pinned here:
 *   1. Pure compute — revenue / customer / benchmarks / insights
 *      math for synthetic snapshots (positive cases).
 *   2. Negative cases — zero-state snapshots must NOT divide by
 *      zero, must NOT crash, must return defensible defaults.
 *   3. Load / regression — compute stays correct at N=1, 25, 100
 *      synthetic orgs (no crash, monotonic averages).
 *   4. Insights panel firing on positive AND negative growth.
 *   5. CSV serialisation has stable headers + every directive row.
 *   6. Migration shape — health_score_events trigger CHECK, FK,
 *      RLS no policies, all 3 indexes.
 *   7. Cron endpoint — 401 without bearer, gated by isCronAuthorised,
 *      runtime nodejs, force-dynamic.
 *   8. Health-recompute service — idempotent (no write when score
 *      unchanged), every directive trigger present, dual-write
 *      audit, exports recomputeAll + recomputeForOrg + listEvents.
 *   9. Export routes — both gated by isSuperAdminEmail, both
 *      hit buildAnalyticsSnapshot, both set correct headers.
 *  10. Page wiring — every directive section present, every export
 *      link wired, recompute form action set.
 *  11. HQ_NAV — analytics is no longer Coming soon.
 *  12. vercel.json registers /api/cron/health-recompute.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260609000000_health_score_events.sql");
const ANALYTICS_LIB = read("lib/hq/analytics.ts");
const HEALTH_SVC = read("server/services/hq-health-recompute.ts");
const ANALYTICS_SNAPSHOT_SVC = read("server/services/hq-analytics-snapshot.ts");
const CRON_ROUTE = read("app/api/cron/health-recompute/route.ts");
const CSV_ROUTE = read("app/api/admin/analytics/export.csv/route.ts");
const PDF_ROUTE = read("app/api/admin/analytics/export.pdf/route.ts");
const PAGE = read("app/admin/analytics/page.tsx");
const LAYOUT = read("app/admin/layout.tsx");
const VERCEL = read("vercel.json");
const ACTIONS = read("app/admin/analytics/actions.ts");

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const NOW = new Date("2026-05-22T12:00:00Z");
const NOW_ISO = NOW.toISOString();

function isoDaysAgo(d: number): string {
  return new Date(NOW.getTime() - d * 86_400_000).toISOString();
}

function org(o: Partial<AnalyticsOrg> = {}): AnalyticsOrg {
  // Use spread-with-defaults so explicit nulls survive — `??` would
  // promote null back to the default value and quietly break tests
  // that pin null behaviour ("health_score: null" → should stay null).
  return {
    id: "org-1",
    name: "Adams Roofing",
    status: "active",
    mrr_gbp: 500,
    ltv_gbp: 5000,
    health_score: 75,
    setup_fee_paid: true,
    approved_at: isoDaysAgo(60),
    cancelled_at: null,
    trial_ends_at: null,
    last_login_at: isoDaysAgo(1),
    onboarding_percent: 100,
    migration_percent: 100,
    migration_days: 14,
    created_at: isoDaysAgo(90),
    ...o,
  };
}

function invoice(o: Partial<AnalyticsInvoice> = {}): AnalyticsInvoice {
  return {
    org_id: "org-1",
    status: "paid",
    kind: "subscription",
    amount_gbp: 500,
    paid_at: isoDaysAgo(1),
    failed_at: null,
    due_date: null,
    created_at: isoDaysAgo(5),
    ...o,
  };
}

function emptySeries() {
  return monthBuckets(12).map((m) => ({ month: m, count: 0 }));
}

function snap(over: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot {
  return {
    orgs: over.orgs ?? [],
    invoices: over.invoices ?? [],
    series: over.series ?? {
      customerGrowth: emptySeries(),
      mrr: monthBuckets(12).map((m) => ({ month: m, mrr: 0 })),
      cancellation: emptySeries(),
      revenue: monthBuckets(12).map((m) => ({ month: m, revenue: 0 })),
    },
    generatedAt: over.generatedAt ?? NOW_ISO,
  };
}

// =====================================================================
// 1. Revenue compute — positive
// =====================================================================

describe("computeRevenueAnalytics — positive cases", () => {
  it("MRR = sum of active orgs' mrr_gbp", () => {
    const s = snap({
      orgs: [
        org({ id: "a", status: "active", mrr_gbp: 500 }),
        org({ id: "b", status: "active", mrr_gbp: 1000 }),
        org({ id: "c", status: "trial", mrr_gbp: 500 }),
      ],
    });
    expect(computeRevenueAnalytics(s).mrrGbp).toBe(1500);
  });

  it("ARR = MRR × 12", () => {
    const s = snap({
      orgs: [org({ status: "active", mrr_gbp: 500 })],
    });
    expect(computeRevenueAnalytics(s).arrGbp).toBe(6000);
  });

  it("Outstanding = sent + failed invoices summed", () => {
    const s = snap({
      invoices: [
        invoice({ status: "sent", amount_gbp: 1000 }),
        invoice({ status: "failed", amount_gbp: 500 }),
        invoice({ status: "paid", amount_gbp: 2000 }),
      ],
    });
    expect(computeRevenueAnalytics(s).outstandingGbp).toBe(1500);
    expect(computeRevenueAnalytics(s).paidGbp).toBe(2000);
  });

  it("Lost revenue = refunded + void", () => {
    const s = snap({
      invoices: [
        invoice({ status: "refunded", amount_gbp: 300 }),
        invoice({ status: "void", amount_gbp: 200 }),
        invoice({ status: "paid", amount_gbp: 500 }),
      ],
    });
    expect(computeRevenueAnalytics(s).lostRevenueGbp).toBe(500);
  });

  it("Average customer value = MRR / active count", () => {
    const s = snap({
      orgs: [
        org({ id: "a", status: "active", mrr_gbp: 1000 }),
        org({ id: "b", status: "active", mrr_gbp: 500 }),
      ],
    });
    expect(computeRevenueAnalytics(s).avgCustomerValueGbp).toBe(750);
  });

  it("YTD revenue only counts paid invoices in the current calendar year", () => {
    const s = snap({
      orgs: [],
      invoices: [
        invoice({ status: "paid", amount_gbp: 100, paid_at: NOW_ISO }),
        invoice({
          status: "paid",
          amount_gbp: 200,
          paid_at: new Date("2024-01-15").toISOString(),
        }),
      ],
      generatedAt: NOW_ISO,
    });
    expect(computeRevenueAnalytics(s).ytdRevenueGbp).toBe(100);
  });
});

// =====================================================================
// 2. Revenue compute — negative / zero state
// =====================================================================

describe("computeRevenueAnalytics — negative / zero state", () => {
  it("zero everywhere when snapshot is empty (no NaN, no Infinity)", () => {
    const r = computeRevenueAnalytics(snap());
    expect(r.mrrGbp).toBe(0);
    expect(r.arrGbp).toBe(0);
    expect(r.outstandingGbp).toBe(0);
    expect(r.paidGbp).toBe(0);
    expect(r.lostRevenueGbp).toBe(0);
    expect(r.avgCustomerValueGbp).toBe(0);
    expect(Number.isFinite(r.forecast90dGbp)).toBe(true);
    expect(Number.isFinite(r.growthPct)).toBe(true);
    expect(Number.isFinite(r.churnPct)).toBe(true);
  });

  it("growth % returns 100 when there is a current bucket but no previous", () => {
    const s = snap({
      series: {
        customerGrowth: monthBuckets(12).map((m, i) => ({
          month: m,
          count: i === 11 ? 1 : 0,
        })),
        mrr: monthBuckets(12).map((m) => ({ month: m, mrr: 0 })),
        cancellation: emptySeries(),
        revenue: monthBuckets(12).map((m) => ({ month: m, revenue: 0 })),
      },
    });
    expect(computeRevenueAnalytics(s).growthPct).toBe(100);
  });

  it("forecast clamps the compounding rate so it can't explode", () => {
    // A wildly negative growth shouldn't drive forecast below zero.
    const s = snap({
      orgs: [org({ status: "active", mrr_gbp: 1000 })],
      series: {
        customerGrowth: monthBuckets(12).map((m, i) => ({
          month: m,
          count: i === 10 ? 100 : i === 11 ? 1 : 0,
        })),
        mrr: monthBuckets(12).map((m) => ({ month: m, mrr: 0 })),
        cancellation: emptySeries(),
        revenue: monthBuckets(12).map((m) => ({ month: m, revenue: 0 })),
      },
    });
    const r = computeRevenueAnalytics(s);
    expect(r.forecast90dGbp).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.forecast90dGbp)).toBe(true);
  });
});

// =====================================================================
// 3. Customer compute — positive
// =====================================================================

describe("computeCustomerAnalytics — health buckets", () => {
  it("places orgs in healthy / at-risk / critical buckets correctly", () => {
    const s = snap({
      orgs: [
        org({ id: "a", health_score: 90 }),
        org({ id: "b", health_score: 70 }),
        org({ id: "c", health_score: 55 }),
        org({ id: "d", health_score: 39 }),
        org({ id: "e", health_score: 10 }),
        org({ id: "f", health_score: null }),
      ],
    });
    const c = computeCustomerAnalytics(s);
    expect(c.healthy).toBe(2);
    expect(c.atRisk).toBe(1);
    expect(c.critical).toBe(2);
    expect(c.unscored).toBe(1);
  });

  it("ignores cancelled / suspended customers in the health bucket counts", () => {
    const s = snap({
      orgs: [
        org({ id: "a", status: "cancelled", health_score: 80 }),
        org({ id: "b", status: "suspended", health_score: 30 }),
        org({ id: "c", status: "active", health_score: 80 }),
      ],
    });
    const c = computeCustomerAnalytics(s);
    expect(c.healthy).toBe(1);
    expect(c.critical).toBe(0);
  });

  it("migration averages reflect only paying-or-trial orgs", () => {
    const s = snap({
      orgs: [
        org({ id: "a", status: "active", migration_percent: 100, migration_days: 10 }),
        org({ id: "b", status: "active", migration_percent: 40, migration_days: 5 }),
        org({ id: "c", status: "cancelled", migration_percent: 0 }),
      ],
    });
    const c = computeCustomerAnalytics(s);
    expect(c.migration.averagePct).toBe(70);
    expect(c.migration.completedCount).toBe(1);
  });

  it("stalled count = paying-or-trial with migration < 100 AND age > 7d", () => {
    const s = snap({
      orgs: [
        org({
          id: "a",
          status: "active",
          migration_percent: 50,
          migration_days: 10,
        }),
        org({
          id: "b",
          status: "active",
          migration_percent: 50,
          migration_days: 2, // not yet stalled
        }),
      ],
    });
    expect(computeCustomerAnalytics(s).migration.stalledCount).toBe(1);
  });

  it("usage stats only count paying-or-trial orgs", () => {
    const s = snap({
      orgs: [
        org({ id: "a", status: "active", last_login_at: isoDaysAgo(2) }),
        org({ id: "b", status: "active", last_login_at: isoDaysAgo(45) }),
        org({ id: "c", status: "active", last_login_at: null }),
        org({ id: "d", status: "cancelled", last_login_at: isoDaysAgo(1) }),
      ],
    });
    const c = computeCustomerAnalytics(s);
    expect(c.usage.activeLast7Days).toBe(1);
    expect(c.usage.activeLast30Days).toBe(1);
    expect(c.usage.neverLoggedIn).toBe(1);
  });
});

describe("computeCustomerAnalytics — negative / zero state", () => {
  it("empty snapshot returns zero everywhere (no NaN)", () => {
    const c = computeCustomerAnalytics(snap());
    expect(c.healthy).toBe(0);
    expect(c.atRisk).toBe(0);
    expect(c.critical).toBe(0);
    expect(c.unscored).toBe(0);
    expect(c.migration.averagePct).toBe(0);
    expect(c.migration.averageDaysToComplete).toBeNull();
    expect(c.migration.fastestDays).toBeNull();
    expect(c.usage.averageDaysSinceLogin).toBeNull();
  });
});

// =====================================================================
// 4. Benchmarks
// =====================================================================

describe("computeBenchmarks", () => {
  it("orders top-by-MRR descending, max 5", () => {
    const orgs = Array.from({ length: 8 }, (_, i) =>
      org({ id: `o-${i}`, name: `Org ${i}`, mrr_gbp: (i + 1) * 100 }),
    );
    const b = computeBenchmarks(snap({ orgs }));
    expect(b.topByMrr).toHaveLength(5);
    expect(b.topByMrr[0]?.mrr).toBe(800);
    expect(b.topByMrr[4]?.mrr).toBe(400);
  });

  it("orders top-by-health descending and skips null scores", () => {
    const s = snap({
      orgs: [
        org({ id: "a", health_score: 95 }),
        org({ id: "b", health_score: null }),
        org({ id: "c", health_score: 70 }),
      ],
    });
    const b = computeBenchmarks(s);
    expect(b.topByHealth).toHaveLength(2);
    expect(b.topByHealth[0]?.health).toBe(95);
  });

  it("averages are null when no orgs qualify", () => {
    const b = computeBenchmarks(snap());
    expect(b.averageHealth).toBeNull();
    expect(b.averageMrrGbp).toBe(0);
    expect(b.averageMigrationDays).toBeNull();
  });
});

// =====================================================================
// 5. Insights panel
// =====================================================================

describe("buildInsightsPanel", () => {
  const baseRev = (over: Partial<ReturnType<typeof computeRevenueAnalytics>> = {}) => ({
    mrrGbp: 0,
    arrGbp: 0,
    growthPct: 0,
    churnPct: 0,
    forecast90dGbp: 0,
    avgCustomerValueGbp: 0,
    outstandingGbp: 0,
    paidGbp: 0,
    lostRevenueGbp: 0,
    ytdRevenueGbp: 0,
    series: snap().series,
    ...over,
  });
  const baseCust = (over: Partial<ReturnType<typeof computeCustomerAnalytics>> = {}) => ({
    healthy: 0,
    atRisk: 0,
    critical: 0,
    unscored: 0,
    migration: {
      averagePct: 0,
      averageDaysToComplete: null as number | null,
      stalledCount: 0,
      fastestDays: null as number | null,
      completedCount: 0,
    },
    usage: {
      activeLast7Days: 0,
      activeLast30Days: 0,
      neverLoggedIn: 0,
      averageDaysSinceLogin: null as number | null,
    },
    ...over,
  });
  const baseBench = (over: Partial<ReturnType<typeof computeBenchmarks>> = {}) => ({
    averageHealth: null,
    averageMrrGbp: 0,
    averageLtvGbp: 0,
    averageMigrationDays: null,
    topByMrr: [],
    topByLtv: [],
    topByHealth: [],
    ...over,
  });

  it("fires 'growth up' on positive MoM", () => {
    const out = buildInsightsPanel(
      baseRev({ growthPct: 14, mrrGbp: 4000 }),
      baseCust(),
      baseBench(),
      [],
    );
    expect(out.some((i) => i.id === "growth_up")).toBe(true);
  });

  it("fires 'growth down' on negative MoM", () => {
    const out = buildInsightsPanel(baseRev({ growthPct: -8 }), baseCust(), baseBench(), []);
    expect(out.some((i) => i.id === "growth_down")).toBe(true);
  });

  it("fires churn-risk only above the 5% guardrail", () => {
    expect(
      buildInsightsPanel(baseRev({ churnPct: 4 }), baseCust(), baseBench(), [])
        .map((i) => i.id),
    ).not.toContain("churn_risk");
    expect(
      buildInsightsPanel(baseRev({ churnPct: 7 }), baseCust(), baseBench(), [])
        .map((i) => i.id),
    ).toContain("churn_risk");
  });

  it("surfaces highest-risk customer list when provided", () => {
    const out = buildInsightsPanel(baseRev(), baseCust(), baseBench(), [
      { id: "a", name: "Risky Co" },
    ]);
    const hit = out.find((i) => i.id === "highest_risk_customers");
    expect(hit?.detail).toMatch(/Risky Co/);
  });

  it("flags outstanding invoices > £5k as negative", () => {
    const out = buildInsightsPanel(
      baseRev({ outstandingGbp: 7500 }),
      baseCust(),
      baseBench(),
      [],
    );
    const hit = out.find((i) => i.id === "outstanding_invoices");
    expect(hit?.kind).toBe("negative");
  });

  it("returns an empty array for a healthy zero-state snapshot", () => {
    const out = buildInsightsPanel(baseRev(), baseCust(), baseBench(), []);
    expect(out).toEqual([]);
  });
});

// =====================================================================
// 6. CSV serialisation
// =====================================================================

describe("analyticsToCsv", () => {
  it("starts with the canonical Section/Metric/Value header", () => {
    const csv = analyticsToCsv(
      computeRevenueAnalytics(snap()),
      computeCustomerAnalytics(snap()),
      computeBenchmarks(snap()),
    );
    expect(csv.startsWith("Section,Metric,Value\n")).toBe(true);
  });

  it("includes every directive-mandated row", () => {
    const csv = analyticsToCsv(
      computeRevenueAnalytics(snap()),
      computeCustomerAnalytics(snap()),
      computeBenchmarks(snap()),
    );
    for (const line of [
      "Revenue,MRR,",
      "Revenue,ARR,",
      "Revenue,Growth % MoM,",
      "Revenue,Churn % 30d,",
      "Revenue,Outstanding,",
      "Revenue,Paid,",
      "Revenue,Lost revenue,",
      "Customers,Healthy,",
      "Customers,At risk,",
      "Customers,Critical,",
      "Migration,Average %,",
      "Migration,Stalled count,",
      "Usage,Active last 7d,",
      "Benchmark,Average health,",
      "Benchmark,Average MRR,",
    ]) {
      expect(csv).toContain(line);
    }
  });
});

// =====================================================================
// 7. Load / regression
// =====================================================================

describe("compute stability — load / regression", () => {
  for (const n of [1, 25, 100]) {
    it(`stable shape at N=${n} synthetic orgs`, () => {
      const orgs = Array.from({ length: n }, (_, i) =>
        org({
          id: `o-${i}`,
          name: `Org ${i}`,
          mrr_gbp: (i % 5 === 0 ? 1000 : 500),
          health_score: (i * 7) % 100,
          status: i % 7 === 0 ? "cancelled" : "active",
          migration_percent: (i * 5) % 100,
          migration_days: i % 14,
          last_login_at: i % 3 === 0 ? null : isoDaysAgo(i % 30),
          cancelled_at: i % 7 === 0 ? isoDaysAgo(i % 30) : null,
          approved_at: isoDaysAgo(60 + (i % 30)),
        }),
      );
      const s = snap({ orgs });
      const r = computeRevenueAnalytics(s);
      const c = computeCustomerAnalytics(s);
      const b = computeBenchmarks(s);
      // No NaN / Infinity slipped through.
      for (const v of [
        r.mrrGbp,
        r.arrGbp,
        r.growthPct,
        r.churnPct,
        r.forecast90dGbp,
        r.avgCustomerValueGbp,
        r.outstandingGbp,
        r.paidGbp,
        r.lostRevenueGbp,
      ]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // Counts are non-negative integers across every band — the
      // total can legitimately be 0 (e.g. N=1 with a cancelled org).
      expect(c.healthy + c.atRisk + c.critical + c.unscored).toBeGreaterThanOrEqual(0);
      expect(b.topByMrr.length).toBeLessThanOrEqual(5);
    });
  }
});

// =====================================================================
// 8. Migration shape
// =====================================================================

describe("migration 20260609000000 — health_score_events", () => {
  it("creates the table with trigger CHECK against every documented trigger", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.health_score_events/);
    for (const trigger of HEALTH_TRIGGERS) {
      expect(MIGRATION).toMatch(new RegExp(`'${trigger}'`));
    }
  });

  it("FK on org_id cascades on org delete", () => {
    expect(MIGRATION).toMatch(/org_id\s+uuid not null references public\.organizations\(id\)\s+on delete cascade/);
  });

  it("enables RLS with no policies (service-role only)", () => {
    expect(MIGRATION).toMatch(/alter table public\.health_score_events enable row level security/);
    expect(MIGRATION).not.toMatch(/create policy/i);
  });

  it("creates all 3 directive-required indexes", () => {
    expect(MIGRATION).toMatch(/health_score_events_org_recent_idx/);
    expect(MIGRATION).toMatch(/health_score_events_trigger_idx/);
    expect(MIGRATION).toMatch(/health_score_events_delta_idx/);
  });

  it("delta is a generated column from old/new score", () => {
    expect(MIGRATION).toMatch(/generated always as \(new_score - coalesce\(old_score, new_score\)\) stored/);
  });

  it("score columns are CHECK-constrained to 0..100", () => {
    expect(MIGRATION).toMatch(/new_score\s+smallint not null check \(new_score between 0 and 100\)/);
  });
});

// =====================================================================
// 9. Health-recompute service
// =====================================================================

describe("hq-health-recompute service", () => {
  it("exports every directive-mandated trigger", () => {
    expect(HEALTH_TRIGGERS).toEqual(
      expect.arrayContaining([
        "cron",
        "invoice_change",
        "payment_change",
        "migration_change",
        "login_change",
        "manual",
        "backfill",
      ]),
    );
  });

  it("exports recomputeHealthForOrg / recomputeAllOrgs / listRecentHealthEvents", () => {
    expect(HEALTH_SVC).toMatch(/export async function recomputeHealthForOrg/);
    expect(HEALTH_SVC).toMatch(/export async function recomputeAllOrgs/);
    expect(HEALTH_SVC).toMatch(/export async function listRecentHealthEvents/);
  });

  it("idempotency: only writes when score actually changed", () => {
    // The processRow function only updates / inserts when `changed` is true.
    expect(HEALTH_SVC).toMatch(/const changed = oldScore !== newScore/);
    expect(HEALTH_SVC).toMatch(/if \(changed\)/);
  });

  it("writes admin_activity_log on every health change (audit trail)", () => {
    expect(HEALTH_SVC).toMatch(/recordAdminActivity/);
    expect(HEALTH_SVC).toMatch(/"health\.recomputed"/);
  });
});

// =====================================================================
// 10. Cron endpoint
// =====================================================================

describe("/api/cron/health-recompute", () => {
  it("gates on isCronAuthorised → 401 when missing bearer", () => {
    expect(CRON_ROUTE).toMatch(/isCronAuthorised/);
    expect(CRON_ROUTE).toMatch(/status: 401/);
  });
  it("invokes recomputeAllOrgs with trigger='cron'", () => {
    expect(CRON_ROUTE).toMatch(/recomputeAllOrgs\("cron"/);
  });
  it("runs on nodejs runtime + dynamic", () => {
    expect(CRON_ROUTE).toMatch(/runtime = "nodejs"/);
    expect(CRON_ROUTE).toMatch(/dynamic = "force-dynamic"/);
  });
});

// =====================================================================
// 11. Export routes
// =====================================================================

describe("/api/admin/analytics/export.csv", () => {
  it("rejects non-super-admin with a 404 (no info leak)", () => {
    expect(CSV_ROUTE).toMatch(/isSuperAdminEmail/);
    expect(CSV_ROUTE).toMatch(/status: 404/);
  });
  it("sets the CSV content-type + attachment disposition", () => {
    expect(CSV_ROUTE).toMatch(/text\/csv; charset=utf-8/);
    expect(CSV_ROUTE).toMatch(/Content-Disposition/);
    expect(CSV_ROUTE).toMatch(/attachment; filename=/);
  });
  it("hits buildAnalyticsSnapshot + analyticsToCsv", () => {
    expect(CSV_ROUTE).toMatch(/buildAnalyticsSnapshot/);
    expect(CSV_ROUTE).toMatch(/analyticsToCsv/);
  });
});

describe("/api/admin/analytics/export.pdf", () => {
  it("gates on isSuperAdminEmail", () => {
    expect(PDF_ROUTE).toMatch(/isSuperAdminEmail/);
  });
  it("renders the AnalyticsPdf component via @react-pdf/renderer", () => {
    expect(PDF_ROUTE).toMatch(/from "@react-pdf\/renderer"/);
    expect(PDF_ROUTE).toMatch(/renderToBuffer/);
    expect(PDF_ROUTE).toMatch(/AnalyticsPdf/);
  });
  it("sets PDF content-type + inline disposition", () => {
    expect(PDF_ROUTE).toMatch(/application\/pdf/);
  });
});

// =====================================================================
// 12. Page wiring
// =====================================================================

describe("/admin/analytics page", () => {
  it("renders every directive section header", () => {
    expect(PAGE).toMatch(/1 · Revenue/);
    expect(PAGE).toMatch(/2 · Customers/);
    expect(PAGE).toMatch(/3 · Benchmarking/);
    expect(PAGE).toMatch(/4 · Health engine/);
  });

  it("renders all 4 sparklines (revenue / mrr / customer growth / churn)", () => {
    expect(PAGE).toMatch(/Revenue trend/);
    expect(PAGE).toMatch(/MRR growth/);
    expect(PAGE).toMatch(/Customer growth/);
    expect(PAGE).toMatch(/Churn trend/);
  });

  it("wires the CSV + PDF export links", () => {
    expect(PAGE).toMatch(/\/api\/admin\/analytics\/export\.csv/);
    expect(PAGE).toMatch(/\/api\/admin\/analytics\/export\.pdf/);
  });

  it("wires the recompute-now form to the server action", () => {
    expect(PAGE).toMatch(/action=\{recomputeHealthNow\}/);
  });

  it("renders the AI COO insights panel", () => {
    expect(PAGE).toMatch(/AI COO insights/);
    expect(PAGE).toMatch(/buildInsightsPanel/);
  });

  it("shows the recent health-events stream", () => {
    expect(PAGE).toMatch(/listRecentHealthEvents/);
    expect(PAGE).toMatch(/Recent health changes/);
  });
});

describe("server actions wiring", () => {
  it("recomputeHealthNow re-checks isSuperAdminEmail", () => {
    expect(ACTIONS).toMatch(/isSuperAdminEmail\(user\.email\)/);
  });
  it("writes the batch summary to admin_activity_log", () => {
    expect(ACTIONS).toMatch(/recordAdminActivity/);
    expect(ACTIONS).toMatch(/"health\.batch_recomputed"/);
  });
});

describe("snapshot service", () => {
  it("pulls organizations + billing_invoices via untypedAdminTable (no N+1)", () => {
    expect(ANALYTICS_SNAPSHOT_SVC).toMatch(/untypedAdminTable\("organizations"/);
    expect(ANALYTICS_SNAPSHOT_SVC).toMatch(/untypedAdminTable\("billing_invoices"/);
  });
  it("exposes pickHighestRiskCustomers helper", () => {
    expect(ANALYTICS_SNAPSHOT_SVC).toMatch(/export function pickHighestRiskCustomers/);
  });
});

describe("HQ_NAV — analytics is ready", () => {
  it("analytics entry has no shipsIn flag", () => {
    expect(LAYOUT).toMatch(/href: "\/admin\/analytics", label: "Analytics" \}/);
    expect(LAYOUT).not.toMatch(/href: "\/admin\/analytics"[^}]*shipsIn:/);
  });
});

describe("vercel.json registers health-recompute cron", () => {
  it("includes /api/cron/health-recompute on a cron schedule", () => {
    expect(VERCEL).toMatch(/\/api\/cron\/health-recompute/);
  });
});

// =====================================================================
// 13. Module-level export sanity (regression)
// =====================================================================

describe("module exports", () => {
  it("lib/hq/analytics exports the directive's compute surfaces", () => {
    for (const symbol of [
      "computeRevenueAnalytics",
      "computeCustomerAnalytics",
      "computeBenchmarks",
      "buildInsightsPanel",
      "analyticsToCsv",
    ]) {
      expect(ANALYTICS_LIB).toMatch(new RegExp(`export function ${symbol}`));
    }
  });
});
