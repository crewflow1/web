import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
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
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

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
   * The governed customer-success narrative — a short prose blurb over the
   * deterministic retention/adoption figures, generated via the shared HQ
   * narrative helper. `null` until a model tier is bound (and the vendor
   * credential + HQ budget org are present), on any governor refusal, or on a
   * provider failure. The UI shows an empty state.
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
    // PAGED (F-1): estate-wide lifecycle read mapped into the post-sale figures —
    // a bare select clamped at 1000 would silently under-report the lifecycle.
    const { data, error } = await fetchAllRows<DemoRow>(
      (from, to) =>
        admin
          .from("demo_requests")
          .select("status, created_at" as never)
          .order("id" as never, { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<DemoRow>>,
    );
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

  const board = await gatherCustomerSuccessBoard();
  const narrative = await loadCustomerSuccessNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Build the deterministic Customer-Success board WITHOUT the page auth gate — the
 * shared derivation used by both `loadCustomerSuccessBoard` (super-admin page) and the
 * Customer-Success executive runner (service-role cron). Reads only; no narrative, no auth.
 */
export async function gatherCustomerSuccessBoard(): Promise<CustomerSuccessBoard> {
  const [lifecycle, health] = await Promise.all([readLifecycle(), readHealth()]);

  const input: CustomerSuccessInput = { lifecycle, health };

  return computeCustomerSuccessBoard(input, new Date());
}

/**
 * Customer-success narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ
 * narrative helper (server/services/hq-narrative.ts), which reaches a model ONLY
 * through `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.customer_success_narrative` feature key (task class `drafting`), billed to
 * the HQ budget org. The model is handed the FINISHED deterministic board and may
 * only describe it — every displayed figure still comes from
 * `computeCustomerSuccessBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadCustomerSuccessNarrative(
  board: CustomerSuccessBoard,
): Promise<string | null> {
  return generateHqBoardNarrative("hq.customer_success_narrative", board);
}
