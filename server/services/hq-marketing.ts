import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { buildAnalyticsSnapshot } from "@/server/services/hq-analytics-snapshot";
import { computeRevenueAnalytics } from "@/lib/hq/analytics";
import {
  computeMarketingBoard,
  type MarketingBoard,
  type MarketingInput,
} from "@/lib/hq/marketing";

/**
 * CrewFlow HQ — Marketing AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-operations.ts` and
 * `server/services/hq-product.ts`: it gathers the raw top-of-funnel / acquisition
 * signals from the EXISTING read models and hands a plain `MarketingInput` to the
 * pure, deterministic `computeMarketingBoard` (lib/hq/marketing.ts). All
 * honesty/labelling lives in the pure layer — this module never duplicates it; it
 * reads CrewFlow's own demo-request lead capture and the HQ analytics snapshot,
 * then folds each to the lean shape the pure layer consumes.
 *
 * WHY demo_requests (and NOT the tenant `leads` table)? `demo_requests` is
 * CrewFlow's OWN marketing-site capture — a single global table, read here on the
 * service-role path. The tenant-facing `leads` table is a customer PRODUCT feature
 * scoped per org by RLS; summing it across tenants on this HQ surface would blend
 * tenants (the #456 leak class), so it is deliberately NOT read. Only status,
 * source and created_at are selected — no name/email/phone — so no lead PII crosses
 * onto this board.
 *
 * WHY acquisition, not adoption? Marketing owns the top of the funnel; the Product
 * AI owns adoption/usage. This aggregator reads no login/usage signal.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as an honest
 * `insufficient` card rather than a fabricated zero or a broken page. The
 * genuinely absent sources (channel attribution, campaigns, ad spend/CAC, SEO
 * rankings) have NO reader here at all — the pure layer emits them insufficient by
 * construction.
 */

export type MarketingBoardResult = {
  board: MarketingBoard;
  /**
   * The governed marketing narrative. DARK for now (see `loadMarketingNarrative`)
   * — always `null` until a model tier is bound. The UI shows an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

type DemoRow = { status: string; source: string | null; created_at: string };

/**
 * Read CrewFlow's own demo-request lead capture, lean (status/source/created_at
 * only — no PII). Returns `null` on failure (loud) so the pure layer marks the
 * top-of-funnel figures insufficient rather than fabricating a zero funnel.
 */
async function readLeads(): Promise<MarketingInput["leads"]> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("demo_requests")
      .select("status, source, created_at" as never);
    if (error) throw readFailure("hq marketing: demo requests", error);
    const rows = (data ?? []) as unknown as DemoRow[];
    return {
      demoRequests: rows.map((r) => ({
        status: r.status,
        source: r.source ?? "unspecified",
        created_at: r.created_at,
      })),
    };
  } catch (e) {
    console.error("[hq-marketing] demo-request read failed", e);
    return null;
  }
}

/**
 * Read the HQ analytics snapshot and fold it to the pure layer's acquisition
 * shape. Returns `null` on failure (loud) so the pure layer marks the customer
 * funnel insufficient rather than fabricating an empty funnel.
 */
async function readAcquisition(): Promise<MarketingInput["acquisition"]> {
  try {
    const snapshot = await buildAnalyticsSnapshot();
    const rev = computeRevenueAnalytics(snapshot);
    const activeOrgs = snapshot.orgs.filter((o) => o.status === "active").length;
    const trialOrgs = snapshot.orgs.filter((o) => o.status === "trial").length;
    const pendingOrgs = snapshot.orgs.filter((o) => o.status === "pending").length;
    const series = snapshot.series.customerGrowth;
    const newCustomersThisMonth =
      series.length > 0 ? series[series.length - 1]?.count ?? 0 : 0;
    return {
      activeOrgs,
      trialOrgs,
      pendingOrgs,
      newCustomersThisMonth,
      growthPct: rev.growthPct,
    };
  } catch (e) {
    console.error("[hq-marketing] analytics snapshot read failed", e);
    return null;
  }
}

/**
 * Assemble the deterministic Marketing AI board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadMarketingBoard(): Promise<MarketingBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const [leads, acquisition] = await Promise.all([
    readLeads(),
    readAcquisition(),
  ]);

  const input: MarketingInput = { leads, acquisition };

  const board = computeMarketingBoard(input, new Date());
  const narrative = await loadMarketingNarrative();

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Marketing narrative — DARK STUB. Returns `null` and constructs NO SDK.
 *
 * A governed prose summary of the marketing board belongs behind
 * `invokeWithGovernor` (lib/ai/governor.ts), under a registered AI feature whose
 * tier the registry arms. There is no registered feature/task_class for an HQ
 * Marketing narrative today, and reusing a tenant-facing key would misattribute
 * HQ spend in the governor ledger.
 *
 * Deliberately NO governor registry key is added for it: an unwired registry
 * entry is a permission granted to nothing, which the governance-closure ratchet
 * (__tests__/security/ai-governance-closure.test.ts) treats as drift — the
 * Operations AI and Product AI both deferred their keys for exactly this reason,
 * and the Marketing AI follows suit.
 *
 * Rather than mis-key a governed call, this stays dark: it returns `null` and
 * imports no model SDK, so the dark path can construct nothing that could spend
 * money. The page shows a "populates once a model tier is bound" empty state.
 */
async function loadMarketingNarrative(): Promise<string | null> {
  return null;
}
