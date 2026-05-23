import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeHealthScore,
  estimateLtvGbp,
  formatMigrationEta,
  subscriptionStatusFromOrg,
  SETUP_FEE_GBP,
  DEFAULT_MONTHLY_GBP,
} from "@/lib/hq/customer-financials";

/**
 * HQ-3 Customers OS contract tests.
 *
 * Pins:
 *   1. Pure compute: health score / LTV / subscription derivation
 *      are stable + bounded.
 *   2. Migration 20260606000000 adds every directive-mandated column
 *      with the right defaults + check constraints.
 *   3. Server actions re-check super-admin AND dual-write to
 *      admin_activity_log.
 *   4. Pages render the headline KPIs (MRR, LTV, setup fee, migration,
 *      health, last_login) and surface every directive action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260606000000_customers_os.sql");
const ACTIONS = read("app/admin/customers/actions.ts");
const LIST_PAGE = read("app/admin/customers/page.tsx");
const DETAIL_PAGE = read("app/admin/customers/[id]/page.tsx");
const IMPERSONATE = read("app/admin/customers/[id]/_impersonate.tsx");
const SNAPSHOT = read("server/services/hq-customer-snapshot.ts");
const LAYOUT = read("app/admin/layout.tsx");

describe("computeHealthScore — bounded + reactive to signals", () => {
  it("returns a score between 0 and 100 for every reasonable input", () => {
    const inputs = [
      {
        status: "active" as const,
        setupFeeStatus: "paid" as const,
        lastLoginAt: new Date().toISOString(),
        onboardingPercent: 100,
        migrationPercent: 100,
      },
      {
        status: "cancelled" as const,
        setupFeeStatus: "refunded" as const,
        lastLoginAt: null,
        onboardingPercent: 0,
        migrationPercent: 0,
      },
      {
        status: "trial" as const,
        setupFeeStatus: "pending" as const,
        lastLoginAt: null,
        onboardingPercent: 50,
        migrationPercent: 30,
      },
    ];
    for (const i of inputs) {
      const r = computeHealthScore(i);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(["high", "medium", "low"]).toContain(r.risk);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it("active + paid + recent login + complete = high health", () => {
    const r = computeHealthScore({
      status: "active",
      setupFeeStatus: "paid",
      lastLoginAt: new Date().toISOString(),
      onboardingPercent: 90,
      migrationPercent: 90,
    });
    expect(r.risk).toBe("low");
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it("cancelled + refunded + never-logged-in = high risk", () => {
    const r = computeHealthScore({
      status: "cancelled",
      setupFeeStatus: "refunded",
      lastLoginAt: null,
      onboardingPercent: 0,
      migrationPercent: 0,
    });
    expect(r.risk).toBe("high");
  });
});

describe("subscriptionStatusFromOrg", () => {
  it("active org with paid setup fee → active", () => {
    expect(subscriptionStatusFromOrg("active", "paid")).toBe("active");
  });
  it("active org with pending setup → past_due (chase!)", () => {
    expect(subscriptionStatusFromOrg("active", "pending")).toBe("past_due");
  });
  it("active org with waived setup → active (we forgave it)", () => {
    expect(subscriptionStatusFromOrg("active", "waived")).toBe("active");
  });
  it("trial preserves trial regardless of setup fee", () => {
    expect(subscriptionStatusFromOrg("trial", "pending")).toBe("trial");
  });
  it("suspended / cancelled / rejected map straight through", () => {
    expect(subscriptionStatusFromOrg("suspended", "paid")).toBe("suspended");
    expect(subscriptionStatusFromOrg("cancelled", "paid")).toBe("cancelled");
    expect(subscriptionStatusFromOrg("rejected", "paid")).toBe("cancelled");
  });
});

describe("estimateLtvGbp", () => {
  it("prefers cached LTV when provided", () => {
    const got = estimateLtvGbp({
      mrrGbp: 500,
      approvedAt: "2024-01-01T00:00:00Z",
      createdAt: "2024-01-01T00:00:00Z",
      setupFeeStatus: "paid",
      cachedLtvGbp: 12345.67,
    });
    expect(got).toBe(12345.67);
  });

  it("falls back to monthsSince(approved) * mrr + setup fee", () => {
    // 12 months ago, £500/mo, setup paid → ~ £6000 + £1000.
    const twelveMonthsAgo = new Date(
      Date.now() - 12 * 30.4375 * 86_400_000,
    ).toISOString();
    const got = estimateLtvGbp({
      mrrGbp: DEFAULT_MONTHLY_GBP,
      approvedAt: twelveMonthsAgo,
      createdAt: twelveMonthsAgo,
      setupFeeStatus: "paid",
    });
    // 12 mo of £500 is £6000 ± a few quid, plus the £1000 setup.
    expect(got).toBeGreaterThanOrEqual(SETUP_FEE_GBP + 5_900);
    expect(got).toBeLessThanOrEqual(SETUP_FEE_GBP + 6_100);
  });

  it("does not credit setup fee when not paid", () => {
    const now = new Date().toISOString();
    const got = estimateLtvGbp({
      mrrGbp: 500,
      approvedAt: now,
      createdAt: now,
      setupFeeStatus: "pending",
    });
    expect(got).toBe(0);
  });
});

describe("formatMigrationEta", () => {
  it("returns — for null", () => {
    expect(formatMigrationEta(null)).toBe("—");
  });
  it("renders 'Tomorrow' for d+1", () => {
    const d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(formatMigrationEta(d)).toBe("Tomorrow");
  });
  it("renders 'Yesterday' for d-1", () => {
    const d = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(formatMigrationEta(d)).toBe("Yesterday");
  });
});

describe("migration 20260606000000 — Customers OS schema", () => {
  it("adds the financial columns with the right defaults + check constraint", () => {
    expect(MIGRATION).toMatch(/add column if not exists setup_fee_status text not null default 'pending'/);
    expect(MIGRATION).toMatch(/setup_fee_status in \('pending', 'sent', 'paid', 'waived', 'refunded'\)/);
    expect(MIGRATION).toMatch(/add column if not exists mrr_gbp numeric/);
    expect(MIGRATION).toMatch(/add column if not exists ltv_gbp numeric/);
  });

  it("backfills MRR for existing active/trial orgs (£500/mo)", () => {
    expect(MIGRATION).toMatch(/update public\.organizations[\s\S]+set mrr_gbp = 500[\s\S]+status in \('active', 'trial'\)/);
  });

  it("adds onboarding + migration % columns with 0-100 range checks", () => {
    expect(MIGRATION).toMatch(/onboarding_percent smallint not null default 0[\s\S]+between 0 and 100/);
    expect(MIGRATION).toMatch(/migration_percent smallint not null default 0[\s\S]+between 0 and 100/);
  });

  it("adds health_score with default 50 and 0-100 range", () => {
    expect(MIGRATION).toMatch(/health_score smallint not null default 50[\s\S]+between 0 and 100/);
  });

  it("adds Stripe future-proofing columns (no logic, just schema)", () => {
    expect(MIGRATION).toMatch(/stripe_customer_id text/);
    expect(MIGRATION).toMatch(/stripe_subscription_id text/);
    expect(MIGRATION).toMatch(/billing_email text/);
  });

  it("adds indexes for setup-fee, health, last-login filters", () => {
    expect(MIGRATION).toMatch(/organizations_setup_fee_status_idx/);
    expect(MIGRATION).toMatch(/organizations_health_idx/);
    expect(MIGRATION).toMatch(/organizations_last_login_idx/);
  });
});

describe("server actions — super-admin gate + dual-write to admin_activity_log", () => {
  it("every action re-checks isSuperAdminEmail", () => {
    expect(ACTIONS).toMatch(/isSuperAdminEmail\(user\.email\)/);
    for (const action of [
      "updateCustomerFinancials",
      "updateCustomerProgress",
      "updateCustomerNotes",
      "setCustomerLifecycle",
      "logImpersonationAttempt",
    ]) {
      expect(ACTIONS).toMatch(new RegExp(`export async function ${action}`));
    }
  });

  it("writes to admin_activity_log via recordAdminActivity for every mutating action", () => {
    const occurrences = (ACTIONS.match(/recordAdminActivity\(/g) ?? []).length;
    // 5 actions × 1 audit row each.
    expect(occurrences).toBeGreaterThanOrEqual(5);
  });

  it("setup_fee → paid stamps setup_fee_paid_at the first time only", () => {
    expect(ACTIONS).toMatch(/setup_fee_status === "paid"[\s\S]+prevRow\?.setup_fee_status !== "paid"/);
  });

  it("zod schemas reject out-of-range percentages", () => {
    expect(ACTIONS).toMatch(/min\(0\)\.max\(100\)/);
  });
});

describe("snapshot service — aggregates the full picture", () => {
  it("queries org row + memberships + demo_requests + imports + invoice_payments + admin_activity_log", () => {
    for (const table of [
      "organizations",
      "memberships",
      "demo_requests",
      "imports",
      "invoice_payments",
    ]) {
      expect(SNAPSHOT).toMatch(new RegExp(`\\.from\\("${table}"`));
    }
    expect(SNAPSHOT).toMatch(/listAdminActivity\("organizations"/);
  });

  it("timeline sorts newest first", () => {
    expect(SNAPSHOT).toMatch(/timeline\.sort\(\(a, b\) => \(a\.at < b\.at \? 1 : -1\)\)/);
  });

  it("exports the lightweight list-roll-up for /admin/customers (skips heavy joins)", () => {
    expect(SNAPSHOT).toMatch(/export async function listCustomersForHq/);
  });
});

describe("/admin/customers list page", () => {
  it("renders MRR, LTV, Setup fee, Migration %, Health, Last login columns", () => {
    for (const col of [
      "MRR",
      "LTV",
      "Setup fee",
      "Migration",
      "Health",
      "Last login",
    ]) {
      expect(LIST_PAGE).toContain(col);
    }
  });
  it("URL params q / status / setup / sort drive filtering", () => {
    expect(LIST_PAGE).toMatch(/sp\.q/);
    expect(LIST_PAGE).toMatch(/sp\.status/);
    expect(LIST_PAGE).toMatch(/sp\.setup/);
    expect(LIST_PAGE).toMatch(/sp\.sort/);
  });
  it("has a mobile card stack (md:hidden) alongside the desktop table (md:block)", () => {
    expect(LIST_PAGE).toMatch(/md:hidden/);
    expect(LIST_PAGE).toMatch(/md:block/);
  });
});

describe("/admin/customers/[id] detail page", () => {
  it("renders every directive action", () => {
    for (const label of [
      "Open workspace",
      "Email owner",
      "Message",
      "Call",
      "Suspend",
      "Cancel",
    ]) {
      expect(DETAIL_PAGE).toContain(label);
    }
    expect(DETAIL_PAGE).toMatch(/CustomerImpersonateModal/);
  });

  it("renders the 6 KPI tiles (MRR / LTV / Onboarding / Migration / Migration ETA / Last login)", () => {
    for (const label of [
      "MRR",
      "LTV",
      "Onboarding",
      "Migration",
      "Migration ETA",
      "Last login",
    ]) {
      expect(DETAIL_PAGE).toContain(label);
    }
  });

  it("loads exactly one snapshot per page render (no N+1)", () => {
    const calls = (DETAIL_PAGE.match(/loadCustomerSnapshot\(/g) ?? []).length;
    expect(calls).toBe(1);
  });

  it("Suspend / Cancel use the confirmation wrapper", () => {
    expect(DETAIL_PAGE).toMatch(/ClientConfirmForm/);
    expect(DETAIL_PAGE).toMatch(/confirm=/);
  });
});

describe("impersonation — modal + action wiring (HQ-10 full session swap)", () => {
  it("renders a confirmation modal with a required reason field", () => {
    expect(IMPERSONATE).toMatch(/role="dialog"/);
    expect(IMPERSONATE).toMatch(/name="reason"[^>]*required/);
  });
  it("modal action prop wires through to startImpersonation (HQ-10) — no longer the legacy logImpersonationAttempt stub", () => {
    expect(DETAIL_PAGE).toMatch(/action=\{startImpersonation\}/);
    expect(DETAIL_PAGE).not.toMatch(/action=\{logImpersonationAttempt\}/);
  });
});

describe("HQ_NAV — customers is ready (no shipsIn)", () => {
  it("layout marks /admin/customers as a normal ready nav item", () => {
    expect(LAYOUT).toMatch(/href: "\/admin\/customers", label: "Customers" \}/);
    expect(LAYOUT).not.toMatch(/href: "\/admin\/customers"[^}]*shipsIn:/);
  });
});
