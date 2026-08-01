import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { buildHqSnapshot } from "@/server/services/hq-snapshot";
import { MONTHLY_PRICE_GBP } from "@/lib/hq/metrics";
import {
  computeFinanceBoard,
  type FinanceBoard,
  type FinanceInput,
} from "@/lib/hq/finance";

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
   * The governed board narrative. DARK for now (see `loadFinanceNarrative`) —
   * always `null` until a model tier is bound. The UI shows an empty state.
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

  const snapshot = await buildHqSnapshot();

  const growth = snapshot.series.customerGrowth;
  const cancellation = snapshot.series.cancellation;
  const newCustomersThisMonth =
    growth.length >= 1 ? growth[growth.length - 1]?.count ?? 0 : 0;
  const churnedThisMonth =
    cancellation.length >= 1 ? cancellation[cancellation.length - 1]?.count ?? 0 : 0;

  const input: FinanceInput = {
    activeCustomers: snapshot.orgs.active,
    trials: snapshot.orgs.trial,
    newCustomersThisMonth,
    churnedThisMonth,
    monthlyPriceGbp: MONTHLY_PRICE_GBP,
    // Absent sources — honest nulls, never fabricated figures.
    costOfRevenueGbp: null,
    cashCollectedGbp: null,
    cashBalanceGbp: null,
    monthlyBurnGbp: null,
    acquisitionSpendGbp: null,
  };

  const board = computeFinanceBoard(input, new Date());
  const narrative = await loadFinanceNarrative();

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Board narrative — DARK STUB. Returns `null` and constructs NO SDK.
 *
 * A governed prose summary of the board belongs behind `invokeWithGovernor`
 * (lib/ai/governor.ts), under a registered AI feature whose tier the registry
 * arms. There is no registered feature/task_class for an HQ finance narrative
 * today, and reusing a tenant-facing key (e.g. `insights.narrative`) would
 * misattribute HQ spend in the governor ledger. Rather than mis-key a governed
 * call, this stays dark: it returns `null` and imports no model SDK, so the
 * dark path can construct nothing that could spend money.
 *
 * DEFERRED: the narrative needs a governed feature/task_class binding (a
 * registry entry + a bound model tier) before it can be wired. Until then the
 * board is fully honest on the deterministic figures alone, and the page shows
 * a "populates once a model tier is bound" empty state.
 */
async function loadFinanceNarrative(): Promise<string | null> {
  return null;
}
