import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { buildAnalyticsSnapshot } from "@/server/services/hq-analytics-snapshot";
import {
  computeCustomerAnalytics,
  computeRevenueAnalytics,
} from "@/lib/hq/analytics";
import {
  computeCustomerSuccessBoard,
  type CustomerSuccessBoard,
  type CustomerSuccessInput,
} from "@/lib/hq/customer-success";

/**
 * CrewFlow HQ — Customer-Success AI aggregator (super-admin surface).
 * Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-marketing.ts` and
 * `server/services/hq-product.ts`: it gathers the raw retention / adoption
 * signals from the EXISTING read models and hands a plain `CustomerSuccessInput`
 * to the pure, deterministic `computeCustomerSuccessBoard`
 * (lib/hq/customer-success.ts). All honesty/labelling lives in the pure layer —
 * this module never duplicates it; it reads CrewFlow's own post-sale
 * demo-request lifecycle and the HQ analytics snapshot, then folds each to the
 * lean shape the pure layer consumes.
 *
 * WHY demo_requests (and NOT the tenant `leads` table)? `demo_requests` is
 * CrewFlow's OWN capture — a single global table, read here on the service-role
 * path. The tenant-facing `leads` table is a customer PRODUCT feature scoped per
 * org by RLS; summing it across tenants on this HQ surface would blend tenants
 * (the #456 leak class), so it is deliberately NOT read. Only status and
 * created_at are selected — no name/email/phone — so no lead PII crosses onto
 * this board.
 *
 * WHY the analytics snapshot? The org health / activation / onboarding / churn
 * posture is already derived globally by `buildAnalyticsSnapshot` +
 * `computeCustomerAnalytics` / `computeRevenueAnalytics` — the SAME HQ read the
 * Marketing and Product boards use. No tenant table is queried directly here.
 *
 * WHY retention, not acquisition? Customer Success owns what happens after a
 * customer signs; the Marketing AI owns the top of the funnel. This aggregator
 * reads no demo-volume / lead-source / channel signal.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as an honest
 * `insufficient` card rather than a fabricated zero or a broken page. The
 * genuinely absent sources (NPS/CSAT, renewal cohort, support satisfaction,
 * time-to-first-value) have NO reader here at all — the pure layer emits them
 * insufficient by construction.
 */

export type CustomerSuccessBoardResult = {
  board: CustomerSuccessBoard;
  /**
   * The governed customer-success narrative. DARK for now (see
   * `loadCustomerSuccessNarrative`) — always `null` until a model tier is bound.
   * The UI shows an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

type DemoRow = { status: string; created_at: string };

/**
 * Read CrewFlow's own demo-request lifecycle, lean (status/created_at only — no
 * PII). Returns `null` on failure (loud) so the pure layer marks the post-sale
 * lifecycle figures insufficient rather than fabricating a zero funnel.
 */
async function readLifecycle(): Promise<CustomerSuccessInput["lifecycle"]> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("demo_requests")
      .select("status, created_at" as never);
    if (error) throw readFailure("hq customer-success: demo requests", error);
    const rows = (data ?? []) as unknown as DemoRow[];
    return {
      demoRequests: rows.map((r) => ({
        status: r.status,
        created_at: r.created_at,
      })),
    };
  } catch (e) {
    console.error("[hq-customer-success] demo-request read failed", e);
    return null;
  }
}

/**
 * Read the HQ analytics snapshot and fold it to the pure layer's health /
 * adoption shape. Returns `null` on failure (loud) so the pure layer marks the
 * retention figures insufficient rather than fabricating an all-healthy split.
 */
async function readHealth(): Promise<CustomerSuccessInput["health"]> {
  try {
    const snapshot = await buildAnalyticsSnapshot();
    const cust = computeCustomerAnalytics(snapshot);
    const rev = computeRevenueAnalytics(snapshot);
    const activeOrgs = snapshot.orgs.filter((o) => o.status === "active").length;
    const trialOrgs = snapshot.orgs.filter((o) => o.status === "trial").length;
    return {
      activeOrgs,
      trialOrgs,
      healthyCustomers: cust.healthy,
      atRiskCustomers: cust.atRisk,
      criticalCustomers: cust.critical,
      unscoredCustomers: cust.unscored,
      usageActive30d: cust.usage.activeLast30Days,
      neverLoggedIn: cust.usage.neverLoggedIn,
      payingOrTrialBase: activeOrgs + trialOrgs,
      onboardingAveragePct: cust.migration.averagePct,
      onboardingCompleted: cust.migration.completedCount,
      onboardingStalled: cust.migration.stalledCount,
      avgDaysToOnboard: cust.migration.averageDaysToComplete,
      churnPct: rev.churnPct,
    };
  } catch (e) {
    console.error("[hq-customer-success] analytics snapshot read failed", e);
    return null;
  }
}

/**
 * Assemble the deterministic Customer-Success AI board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadCustomerSuccessBoard(): Promise<CustomerSuccessBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const [lifecycle, health] = await Promise.all([readLifecycle(), readHealth()]);

  const input: CustomerSuccessInput = { lifecycle, health };

  const board = computeCustomerSuccessBoard(input, new Date());
  const narrative = await loadCustomerSuccessNarrative();

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Customer-success narrative — DARK STUB. Returns `null` and constructs NO SDK.
 *
 * A governed prose summary of the customer-success board belongs behind
 * `invokeWithGovernor` (lib/ai/governor.ts), under a registered AI feature whose
 * tier the registry arms. There is no registered feature/task_class for an HQ
 * Customer-Success narrative today, and reusing a tenant-facing key would
 * misattribute HQ spend in the governor ledger.
 *
 * Deliberately NO governor registry key is added for it: an unwired registry
 * entry is a permission granted to nothing, which the governance-closure ratchet
 * (__tests__/security/ai-governance-closure.test.ts) treats as drift — the
 * Marketing AI and Product AI both deferred their keys for exactly this reason,
 * and the Customer-Success AI follows suit.
 *
 * Rather than mis-key a governed call, this stays dark: it returns `null` and
 * imports no model SDK, so the dark path can construct nothing that could spend
 * money. The page shows a "populates once a model tier is bound" empty state.
 */
async function loadCustomerSuccessNarrative(): Promise<string | null> {
  return null;
}
