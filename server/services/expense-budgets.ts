import "server-only";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  currentYearStartDayKey,
  type ExpenseBudgetRow,
  type ExpenseSpendRow,
} from "@/lib/expenses/budget";

/**
 * Expense budgets — the read layer for `expense_budgets` (20261089) and the
 * `finances` spend it is compared against.
 *
 * THE ACCOUNTING BOUNDARY: reads only. A budget is a PLAN; nothing here writes
 * the actual-cost ledger. The spend read below SUMS `finances` for the overlay
 * and never mutates it. See lib/expenses/budget.ts.
 *
 * SCOPING — the job-site-hub doctrine:
 *   1. RLS, via the caller's client (the user's JWT in the app).
 *   2. `org_id` PINNED on every read. `current_org_ids()` returns EVERY org the
 *      viewer belongs to, so RLS alone BLENDS orgs for a dual-org member — the
 *      defect class this product has shipped repeated fixes for. Budgets and
 *      spend are money, so the pin is load-bearing.
 *
 * LOUD READS: every read binds `error` and throws `readFailure`. An empty
 * budgets table must mean "no budgets set", never "the query failed" — a
 * silently-failed spend read would tell an operator they are under budget.
 *
 * `expense_budgets` is not in the generated Supabase types yet, so it goes
 * through the established loose-client cast (the job-budget idiom). The cast is
 * TypeScript-only and changes nothing about the RLS-scoped runtime client.
 */

type Row = Record<string, unknown>;
type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  gte: (k: string, v: unknown) => Builder;
  or: (f: string) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  limit: (n: number) => Builder;
  range: (from: number, to: number) => Builder;
};
export type ExpenseBudgetClient = { from: (t: string) => Builder };

const BUDGET_COLS = "id, category, amount_pence, period_type, note, created_by, updated_at";

/** Every standing budget target for an org. Org-pinned, loud. */
export async function loadExpenseBudgets(
  client: ExpenseBudgetClient,
  orgId: string,
): Promise<ExpenseBudgetRow[]> {
  const res = await client
    .from("expense_budgets")
    .select(BUDGET_COLS)
    .eq("org_id", orgId)
    .order("category", { ascending: true })
    .limit(100);
  if (res.error) throw readFailure("expense budgets: targets", res.error);
  return (res.data ?? []) as unknown as ExpenseBudgetRow[];
}

/**
 * The `finances` spend an overlay for `now` needs: every row in the org from the
 * start of the current London calendar YEAR onward — the widest window any
 * current monthly / quarterly / annual budget line can reference (see
 * `currentYearStartDayKey`). The PURE layer then buckets each row into the right
 * category window; this read only bounds the fetch.
 *
 * Bounded on BOTH date columns with an OR: `bill_date` (the supplier-invoice
 * date, when present) or `created_at` (when the row was entered). A row is in
 * scope if EITHER lands in the current year, so a bill dated this year but
 * entered late, and a bill with no `bill_date` entered this year, are both
 * caught. PostgREST expresses the OR via `.or(...)`; the year-start bound keeps
 * the scan off the whole ledger.
 */
export async function loadCurrentYearSpend(
  client: ExpenseBudgetClient,
  orgId: string,
  now: Date | string | number,
): Promise<ExpenseSpendRow[]> {
  const yearStartDay = currentYearStartDayKey(now); // YYYY-01-01, London
  const yearStartIso = `${yearStartDay}T00:00:00.000Z`;
  // PAGED (F-1): the pure layer SUMS every returned row into the budget-vs-spend
  // overlay, so the old `.limit(5000)` was a raw cap over an unbounded year of
  // finances — an org with >5000 finance rows this year silently under-reported
  // its spend and read as "under budget". `fetchAllRows` walks the whole set
  // under the PostgREST cap on a unique `created_at`+`id` total order. `id` must
  // be selected so it can be the pagination tiebreak.
  const res = await fetchAllRows<Row>((from, to) =>
    client
      .from("finances")
      .select("id, category, amount, bill_date, created_at")
      .eq("org_id", orgId)
      .or(`bill_date.gte.${yearStartDay},created_at.gte.${yearStartIso}`)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (res.error) throw readFailure("expense budgets: current-year spend", res.error);
  return (res.data ?? []) as unknown as ExpenseSpendRow[];
}
