import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { buildAnalyticsSnapshot } from "@/server/services/hq-analytics-snapshot";
import { computeRevenueAnalytics } from "@/lib/hq/analytics";
import {
  computeMarketingBoard,
  type MarketingBoard,
  type MarketingInput,
} from "@/lib/hq/marketing";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

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
   * The governed marketing narrative — a short prose blurb over the deterministic
   * top-of-funnel figures, generated via the shared HQ narrative helper. `null`
   * until a model tier is bound (and the vendor credential + HQ budget org are
   * present), on any governor refusal, or on a provider failure. The UI shows an
   * empty state.
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
    // PAGED (F-1): estate-wide funnel read mapped into the acquisition figures —
    // a bare select clamped at 1000 would silently under-report the top-of-funnel.
    const { data, error } = await fetchAllRows<DemoRow>(
      (from, to) =>
        admin
          .from("demo_requests")
          .select("status, source, created_at" as never)
          .order("id" as never, { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<DemoRow>>,
    );
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
  const narrative = await loadMarketingNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Marketing narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ
 * narrative helper (server/services/hq-narrative.ts), which reaches a model ONLY
 * through `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.marketing_narrative` feature key (task class `drafting`), billed to the HQ
 * budget org. The model is handed the FINISHED deterministic board and may only
 * describe it — every displayed figure still comes from `computeMarketingBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadMarketingNarrative(board: MarketingBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.marketing_narrative", board);
}
