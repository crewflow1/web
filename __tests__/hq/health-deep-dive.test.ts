import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bandFromScore,
  HEALTH_BAND_LABEL,
  HEALTH_BAND_PILL,
  applyHealthFilter,
  recommendForRow,
  HEALTH_FILTER_LABEL,
  type HealthDeepDiveRow,
} from "@/lib/hq/health-deep-dive";

/**
 * HQ-11 Customer Health Deep Dive contract tests.
 *
 * Pinned:
 *   1. Band buckets match directive (red <40, yellow 40-69, green ≥70, unknown for null).
 *   2. applyHealthFilter every filter narrows correctly.
 *   3. recommendForRow returns the most urgent recommendation,
 *      with stable IDs, weighted by criticality.
 *   4. Empty / healthy rows return null recommendation.
 *   5. Service exposes listHealthDeepDive + listHealthHistoryForOrg.
 *   6. /admin/health renders KPIs, filters, recommendations.
 *   7. HQ_NAV no longer marks /admin/health Coming soon.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SVC = read("server/services/hq-health-deep-dive.ts");
const PAGE = read("app/admin/health/page.tsx");
const HQ_LAYOUT = read("app/admin/layout.tsx");

// ---- Fixtures ----

function row(over: Partial<HealthDeepDiveRow> = {}): HealthDeepDiveRow {
  return {
    org_id: "o1",
    org_name: "Test Org",
    status: "active",
    health_score: 75,
    health_recomputed_at: null,
    trend: [],
    mrr_gbp: 500,
    setup_fee_status: "paid",
    days_since_login: 1,
    days_since_signup: 60,
    onboarding_percent: 100,
    migration_percent: 100,
    active_support_tickets: 0,
    urgent_support_tickets: 0,
    outstanding_gbp: 0,
    failed_payments_90d: 0,
    notifications_7d: 0,
    ...over,
  };
}

// =====================================================================
// Bands
// =====================================================================

describe("bandFromScore", () => {
  it("null → unknown", () => expect(bandFromScore(null)).toBe("unknown"));
  it("<40 → red", () => expect(bandFromScore(39)).toBe("red"));
  it("40..69 → yellow", () => {
    expect(bandFromScore(40)).toBe("yellow");
    expect(bandFromScore(69)).toBe("yellow");
  });
  it("≥70 → green", () => expect(bandFromScore(70)).toBe("green"));
  it("every band has a label + pill", () => {
    for (const b of ["red", "yellow", "green", "unknown"] as const) {
      expect(HEALTH_BAND_LABEL[b]).toBeTruthy();
      expect(HEALTH_BAND_PILL[b]).toBeTruthy();
    }
  });
});

// =====================================================================
// Filters
// =====================================================================

describe("applyHealthFilter", () => {
  const rows = [
    row({ org_id: "red", health_score: 20 }),
    row({ org_id: "yel", health_score: 50 }),
    row({ org_id: "grn", health_score: 80 }),
    row({ org_id: "no", health_score: null }),
    row({ org_id: "inact", days_since_login: 30 }),
    row({
      org_id: "unp",
      status: "active",
      setup_fee_status: "pending",
    }),
    row({
      org_id: "stuck",
      onboarding_percent: 20,
      days_since_signup: 30,
    }),
    row({
      org_id: "support",
      active_support_tickets: 3,
    }),
  ];

  it("all is identity", () => {
    expect(applyHealthFilter(rows, "all").length).toBe(rows.length);
  });
  it("red", () => {
    expect(applyHealthFilter(rows, "red").map((r) => r.org_id)).toContain("red");
  });
  it("yellow", () => {
    expect(applyHealthFilter(rows, "yellow").map((r) => r.org_id)).toContain(
      "yel",
    );
  });
  it("green", () => {
    expect(applyHealthFilter(rows, "green").map((r) => r.org_id)).toContain(
      "grn",
    );
  });
  it("unscored", () => {
    expect(applyHealthFilter(rows, "unscored").map((r) => r.org_id)).toContain(
      "no",
    );
  });
  it("inactive (>14d no login)", () => {
    expect(applyHealthFilter(rows, "inactive").map((r) => r.org_id)).toContain(
      "inact",
    );
  });
  it("unpaid", () => {
    expect(applyHealthFilter(rows, "unpaid").map((r) => r.org_id)).toContain(
      "unp",
    );
  });
  it("onboarding_stuck", () => {
    expect(
      applyHealthFilter(rows, "onboarding_stuck").map((r) => r.org_id),
    ).toContain("stuck");
  });
  it("high_support (2+ active tickets)", () => {
    expect(applyHealthFilter(rows, "high_support").map((r) => r.org_id)).toContain(
      "support",
    );
  });
  it("every filter has a label", () => {
    for (const k of Object.keys(HEALTH_FILTER_LABEL)) {
      expect(HEALTH_FILTER_LABEL[k as keyof typeof HEALTH_FILTER_LABEL]).toBeTruthy();
    }
  });
});

// =====================================================================
// Recommendations
// =====================================================================

describe("recommendForRow — deterministic next-best-action", () => {
  it("returns null when nothing is wrong", () => {
    expect(recommendForRow(row())).toBeNull();
  });

  it("failed payment beats everything else", () => {
    const r = row({
      failed_payments_90d: 1,
      urgent_support_tickets: 5,
      health_score: 20,
    });
    expect(recommendForRow(r)?.id).toBe("chase_failed_payment");
  });

  it("urgent support beats critical health when no failed payments", () => {
    const r = row({
      urgent_support_tickets: 1,
      health_score: 30,
    });
    expect(recommendForRow(r)?.id).toBe("respond_urgent_support");
  });

  it("critical health surfaces retention call", () => {
    const r = row({ health_score: 30 });
    expect(recommendForRow(r)?.id).toBe("retention_call_critical");
  });

  it("first-login follow-up for never-logged-in old signups", () => {
    const r = row({
      days_since_login: null,
      days_since_signup: 10,
      health_score: 50,
    });
    const rec = recommendForRow(r);
    expect(rec?.id).toBe("first_login_followup");
  });

  it("setup fee unpaid surfaces collect-setup", () => {
    const r = row({
      status: "active",
      setup_fee_status: "pending",
    });
    expect(recommendForRow(r)?.id).toBe("setup_fee_unpaid");
  });

  it("outstanding < £5k is a chase (not a collect)", () => {
    const r = row({ outstanding_gbp: 500 });
    expect(recommendForRow(r)?.id).toBe("chase_invoice");
  });

  it("outstanding > £5k is escalated to collect", () => {
    const r = row({ outstanding_gbp: 7500 });
    expect(recommendForRow(r)?.id).toBe("collect_outstanding");
  });

  it("re-engagement for inactive > 30d", () => {
    const r = row({ days_since_login: 45 });
    expect(recommendForRow(r)?.id).toBe("re_engage_inactive");
  });

  it("recommendations carry action_url + detail", () => {
    const r = row({ failed_payments_90d: 1 });
    const rec = recommendForRow(r);
    expect(rec?.action_url).toMatch(/^\//);
    expect(rec?.detail.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// Service
// =====================================================================

describe("hq-health-deep-dive service", () => {
  it("exports listHealthDeepDive + listHealthHistoryForOrg", () => {
    expect(SVC).toMatch(/export async function listHealthDeepDive/);
    expect(SVC).toMatch(/export async function listHealthHistoryForOrg/);
  });

  it("batched IN queries — no N+1", () => {
    expect(SVC).toMatch(/\.in\("org_id", orgIds\)/);
  });

  it("aggregates health_score_events + support_tickets + billing_invoices + notifications", () => {
    expect(SVC).toMatch(/health_score_events/);
    expect(SVC).toMatch(/support_tickets/);
    expect(SVC).toMatch(/billing_invoices/);
    expect(SVC).toMatch(/notifications/);
  });
});

// =====================================================================
// /admin/health page
// =====================================================================

describe("/admin/health page", () => {
  it("renders 4 KPI tiles (Critical / At risk / Healthy / Unscored)", () => {
    expect(PAGE).toMatch(/Critical/);
    expect(PAGE).toMatch(/At risk/);
    expect(PAGE).toMatch(/Healthy/);
    expect(PAGE).toMatch(/Unscored/);
  });

  it("wires filter + search", () => {
    expect(PAGE).toMatch(/name="filter"/);
    expect(PAGE).toMatch(/name="q"/);
  });

  it("surfaces recommendation per row via recommendForRow", () => {
    expect(PAGE).toMatch(/recommendForRow/);
  });

  it("links each row to /admin/customers/<id>", () => {
    expect(PAGE).toMatch(/\/admin\/customers\/\$\{row\.org_id\}/);
  });

  it("renders trend sparkline (numeric inline)", () => {
    expect(PAGE).toMatch(/row\.trend/);
  });
});

// =====================================================================
// HQ_NAV
// =====================================================================

describe("HQ_NAV — health is ready", () => {
  it("/admin/health no shipsIn", () => {
    expect(read("app/admin/_nav/hq-nav-model.ts")).toMatch(/href: "\/admin\/health"/);
    expect(HQ_LAYOUT).not.toMatch(/href: "\/admin\/health"[^}]*shipsIn:/);
  });
});
