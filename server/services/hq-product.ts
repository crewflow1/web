import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { listFeatureSignalRowsForHq } from "@/server/services/hq-support-snapshot";
import { buildAnalyticsSnapshot } from "@/server/services/hq-analytics-snapshot";
import {
  computeCustomerAnalytics,
  computeRevenueAnalytics,
} from "@/lib/hq/analytics";
import {
  computeProductBoard,
  type ProductBoard,
  type ProductInput,
} from "@/lib/hq/product";

/**
 * CrewFlow HQ — Product AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-cto.ts` and
 * `server/services/hq-support-ai.ts`: it gathers the raw voice-of-customer /
 * product signals from the EXISTING read models and hands a plain `ProductInput`
 * to the pure, deterministic `computeProductBoard` (lib/hq/product.ts). All
 * honesty/labelling lives in the pure layer — this module never duplicates it; it
 * reads the lean feature-request/support-ticket rows and the HQ analytics
 * snapshot, then folds each to the lean shape the pure layer consumes.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as an honest
 * `insufficient` card rather than a fabricated zero or a broken page. The genuinely
 * absent sources (competitor monitoring, roadmap prioritisation) have NO reader
 * here at all — the pure layer emits them insufficient by construction.
 */

export type ProductBoardResult = {
  board: ProductBoard;
  /**
   * The governed product narrative. DARK for now (see `loadProductNarrative`) —
   * always `null` until a model tier is bound. The UI shows an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/**
 * Assemble the deterministic Product AI board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadProductBoard(): Promise<ProductBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const [tickets, snapshot] = await Promise.all([
    listFeatureSignalRowsForHq().catch((e) => {
      console.error("[hq-product] feature-signal read threw", e);
      return null;
    }),
    buildAnalyticsSnapshot().catch((e) => {
      console.error("[hq-product] analytics snapshot read failed", e);
      return null;
    }),
  ]);

  const input: ProductInput = {
    demand:
      tickets == null
        ? null
        : {
            tickets: tickets.map((t) => ({
              category: t.category,
              status: t.status,
              created_at: t.created_at,
            })),
          },
    adoption:
      snapshot == null
        ? null
        : (() => {
            const cust = computeCustomerAnalytics(snapshot);
            const rev = computeRevenueAnalytics(snapshot);
            const activeOrgs = snapshot.orgs.filter(
              (o) => o.status === "active",
            ).length;
            const trialOrgs = snapshot.orgs.filter(
              (o) => o.status === "trial",
            ).length;
            return {
              activeOrgs,
              trialOrgs,
              usageActive30d: cust.usage.activeLast30Days,
              usageNeverLoggedIn: cust.usage.neverLoggedIn,
              payingOrTrialBase: activeOrgs + trialOrgs,
              growthPct: rev.growthPct,
            };
          })(),
  };

  const board = computeProductBoard(input, new Date());
  const narrative = await loadProductNarrative();

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Product narrative — DARK STUB. Returns `null` and constructs NO SDK.
 *
 * A governed prose summary of the product-signal board belongs behind
 * `invokeWithGovernor` (lib/ai/governor.ts), under a registered AI feature whose
 * tier the registry arms. There is no registered feature/task_class for an HQ
 * Product narrative today, and reusing a tenant-facing key would misattribute HQ
 * spend in the governor ledger.
 *
 * Deliberately NO governor registry key is added for it: an unwired registry
 * entry is a permission granted to nothing, which the governance-closure ratchet
 * (__tests__/security/ai-governance-closure.test.ts) treats as drift — the CTO AI
 * and Support AI deferred their keys for exactly this reason, and the Product AI
 * follows suit.
 *
 * Rather than mis-key a governed call, this stays dark: it returns `null` and
 * imports no model SDK, so the dark path can construct nothing that could spend
 * money. The page shows a "populates once a model tier is bound" empty state.
 */
async function loadProductNarrative(): Promise<string | null> {
  return null;
}
