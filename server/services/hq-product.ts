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
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

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
   * The governed product narrative — a short prose blurb over the deterministic
   * product-signal figures, generated via the shared HQ narrative helper. `null`
   * until a model tier is bound (and the vendor credential + HQ budget org are
   * present), on any governor refusal, or on a provider failure. The UI shows an
   * empty state.
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
  const narrative = await loadProductNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Product narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ narrative
 * helper (server/services/hq-narrative.ts), which reaches a model ONLY through
 * `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.product_narrative` feature key (task class `drafting`), billed to the HQ
 * budget org. The model is handed the FINISHED deterministic board and may only
 * describe it — every displayed figure still comes from `computeProductBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadProductNarrative(board: ProductBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.product_narrative", board);
}
