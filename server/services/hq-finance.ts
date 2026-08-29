import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { buildHqSnapshot } from "@/server/services/hq-snapshot";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { MONTHLY_PRICE_GBP } from "@/lib/hq/metrics";
import {
  computeFinanceBoard,
  type FinanceBoard,
  type FinanceInput,
} from "@/lib/hq/finance";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

/**
 * CrewFlow HQ — FINANCE AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-ceo.ts`: it gathers the raw
 * figures from the existing HQ snapshot (`buildHqSnapshot`) and hands a plain
 * `FinanceInput` to the pure, deterministic `computeFinanceBoard`
 * (lib/hq/finance.ts). All honesty/labelling lives in the pure layer.
 *
 * DELIBERATELY-ABSENT SOURCES. The "…Gbp" inputs below are passed as
 * `null` because the schema has nowhere to read them from today:
 *   - cost of revenue (COGS)      → gross margin is `insufficient`
 *   - collected payments (Stripe) → cash in is `insufficient`
 *   - cash balance on hand        → runway is `insufficient` (numerator)
 *   - monthly operating burn      → runway is `insufficient` (denominator)
 *   - acquisition / marketing spend → CAC is `insufficient`
 * When a real source lands, this is where a number replaces the `null` — the
 * pure layer already computes the real figure from it, no other change needed.
 * We do NOT fabricate any of them.
 */

export type FinanceBoardResult = {
  board: FinanceBoard;
  /**
   * The governed board narrative — a short prose blurb over the deterministic
   * figures, generated via the shared HQ narrative helper. `null` until a model
   * tier is bound (and the vendor credential + HQ budget org are present), on any
   * governor refusal, or on a provider failure. The UI shows an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/**
 * Assemble the deterministic finance board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then
 * builds the board from the existing snapshot and attaches the (dark)
 * narrative.
 */
export async function loadFinanceBoard(): Promise<FinanceBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const board = await gatherFinanceBoard();
  const narrative = await loadFinanceNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Build the deterministic finance board WITHOUT the page auth gate — the shared
 * derivation used by both `loadFinanceBoard` (super-admin page) and the Finance/CFO
 * executive runners (service-role cron). Reads only; no narrative, no auth.
 */
export async function gatherFinanceBoard(): Promise<FinanceBoard> {
  const snapshot = await buildHqSnapshot();

  const growth = snapshot.series.customerGrowth;
  const cancellation = snapshot.series.cancellation;
  const newCustomersThisMonth =
    growth.length >= 1 ? growth[growth.length - 1]?.count ?? 0 : 0;
  const churnedThisMonth =
    cancellation.length >= 1 ? cancellation[cancellation.length - 1]?.count ?? 0 : 0;

  // P12 — the REAL per-org revenue source: organizations.mrr_gbp / ltv_gbp for
  // every ACTIVE org (the same columns the HQ customers OS reads). LOUD read
  // with honest degradation: a failure logs and passes null, and the pure layer
  // labels MRR as the count × list-price ESTIMATE / marks LTV insufficient —
  // never a silently fabricated figure.
  const perOrg = await readActiveOrgRevenue();

  const input: FinanceInput = {
    activeCustomers: snapshot.orgs.active,
    trials: snapshot.orgs.trial,
    newCustomersThisMonth,
    churnedThisMonth,
    monthlyPriceGbp: MONTHLY_PRICE_GBP,
    activeOrgMrrsGbp: perOrg?.mrrs ?? null,
    activeOrgLtvsGbp: perOrg?.ltvs ?? null,
    // P12 — the forecast's real inputs: the demo_requests lifecycle counts the
    // snapshot already reads (live pipeline + historical won/lost outcomes).
    // Legacy 'new' rows are pending first contact, so they count as pipeline.
    demoLifecycle: {
      pendingDemo: snapshot.demos.pending_demo + snapshot.demos.legacy_new,
      demoBooked: snapshot.demos.demo_booked,
      approved: snapshot.demos.approved,
      rejected: snapshot.demos.rejected,
      cancelled: snapshot.demos.cancelled,
    },
    // Absent sources — honest nulls, never fabricated figures.
    costOfRevenueGbp: null,
    cashCollectedGbp: null,
    cashBalanceGbp: null,
    monthlyBurnGbp: null,
    acquisitionSpendGbp: null,
  };

  return computeFinanceBoard(input, new Date());
}

/**
 * Per-active-org mrr_gbp/ltv_gbp — PAGED (F-1: the estate can exceed the
 * 1000-row PostgREST clamp; a clamped read would silently drop revenue).
 * Returns null on any read error (logged loudly) so the pure layer degrades
 * honestly instead of summing a partial estate as if it were the whole one.
 */
async function readActiveOrgRevenue(): Promise<{
  mrrs: Array<number | null>;
  ltvs: Array<number | null>;
} | null> {
  type Row = { mrr_gbp: number | string | null; ltv_gbp: number | string | null };
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      admin
        .from("organizations")
        .select("mrr_gbp, ltv_gbp" as never)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<Row>>,
  );
  if (error) {
    console.error("[hq-finance] active-org revenue read failed", error);
    return null;
  }
  const toNumberOrNull = (v: number | string | null): number | null => {
    if (v == null) return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? n : null;
  };
  return {
    mrrs: data.map((r) => toNumberOrNull(r.mrr_gbp)),
    ltvs: data.map((r) => toNumberOrNull(r.ltv_gbp)),
  };
}

/**
 * Board narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ narrative
 * helper (server/services/hq-narrative.ts), which reaches a model ONLY through
 * `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.finance_narrative` feature key (task class `drafting`), billed to the HQ
 * budget org. The model is handed the FINISHED deterministic board and may only
 * describe it — every displayed figure still comes from `computeFinanceBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound the shared provider
 * door returns null, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — which is now honest,
 * because binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadFinanceNarrative(board: FinanceBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.finance_narrative", board);
}
