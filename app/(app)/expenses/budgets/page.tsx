import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  loadExpenseBudgets,
  loadCurrentYearSpend,
  type ExpenseBudgetClient,
} from "@/server/services/expense-budgets";
import {
  computeExpenseBudgetPosition,
  NEAR_THRESHOLD_PCT,
  OVER_THRESHOLD_PCT,
  type BudgetBand,
  type CategoryBudgetLine,
  type ExpenseCategory,
} from "@/lib/expenses/budget";
import { FINANCE_CATEGORIES } from "@/lib/finances/schema";
import { setExpenseBudget, deleteExpenseBudget } from "./actions";

/**
 * /expenses/budgets — org/category operational spend vs a standing budget.
 *
 * Two parts on one page (depth 2, so plain server-action redirects are safe):
 *   1. Budget vs actual — every category's spend in ITS current period against
 *      its target, with variance and an under/near/over band.
 *   2. Set budgets — admin-only, one editable form per category.
 *
 * This is a READ overlay + a CRUD table on the PLAN. It never touches expense
 * approval or any money arithmetic on `finances`.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});
const penceGbp = (p: number | null): string =>
  p === null ? "—" : GBP.format(p / 100);

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  materials: "Materials",
  labor: "Labour",
  fuel: "Fuel",
  subcontractor: "Subcontractors",
  tools: "Tools",
  office: "Office",
  vehicle: "Vehicle",
  misc: "Miscellaneous",
};

const PERIOD_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

const BAND: Record<BudgetBand, { label: string; cls: string }> = {
  no_budget: { label: "No budget set", cls: "border-slate-300 bg-slate-50 text-slate-600" },
  under: { label: "Under budget", cls: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  near: { label: "Near limit", cls: "border-amber-200 bg-amber-50 text-amber-800" },
  over: { label: "Over budget", cls: "border-red-200 bg-red-50 text-red-800" },
};

const ERROR_MAP: Record<string, string> = {
  forbidden: "Only owners and admins can set budgets.",
  validation: "Check the amount and category and try again.",
  save_failed: "Couldn't save the budget. Try again.",
  delete_failed: "Couldn't remove the budget. Try again.",
};
const SAVED_MAP: Record<string, string> = {
  set: "Budget saved.",
  deleted: "Budget removed.",
};

type SP = Promise<{ error?: string; saved?: string }>;

export default async function ExpenseBudgetsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const isManager = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const supabase = await createClient();
  const client = supabase as unknown as ExpenseBudgetClient;
  const now = new Date();

  const [budgets, spend] = await Promise.all([
    loadExpenseBudgets(client, ctx.org.id),
    loadCurrentYearSpend(client, ctx.org.id, now),
  ]);

  const position = computeExpenseBudgetPosition({ budgets, spend, now });
  const byCategory = new Map<string, CategoryBudgetLine>(
    position.lines.map((l) => [l.category, l]),
  );

  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? sp.error : null;
  const savedMessage = sp.saved ? SAVED_MAP[sp.saved] ?? null : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/expenses" className="hover:text-slate-900">
          Expenses
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Budgets</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Expense budgets</h1>
        <p className="mt-1 text-sm text-slate-600">
          Set an operational spend target per category and track it against
          actual spend for the current period. These are org-wide targets — for a
          single job&rsquo;s cost baseline, see that job&rsquo;s commercial page.
        </p>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      {/* ── Budget vs actual ─────────────────────────────────────────────── */}
      <section
        aria-labelledby="vs-actual"
        className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 id="vs-actual" className="text-sm font-semibold text-slate-900">
            Budget vs actual
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Actual spend is the sum of approved expenses (money out) posted to
            your books in each category&rsquo;s current period.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 hidden sm:table-cell">Period</th>
                <th className="px-4 py-3 text-right">Budget</th>
                <th className="px-4 py-3 text-right">Actual</th>
                <th className="px-4 py-3 text-right hidden md:table-cell">Remaining</th>
                <th className="px-4 py-3 hidden lg:table-cell">Used</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {position.lines.map((line) => {
                const b = BAND[line.band];
                const remaining =
                  line.variancePence === null ? null : line.variancePence;
                return (
                  <tr key={line.category} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {CATEGORY_LABEL[line.category]}
                    </td>
                    <td className="px-4 py-3 text-slate-500 hidden sm:table-cell">
                      {line.periodLabel}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {penceGbp(line.budgetPence)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {penceGbp(line.actualPence)}
                    </td>
                    <td
                      className={
                        "px-4 py-3 text-right hidden md:table-cell " +
                        (remaining !== null && remaining < 0
                          ? "text-red-700 font-medium"
                          : "text-slate-700")
                      }
                    >
                      {penceGbp(remaining)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">
                      {line.utilisationPct === null ? "—" : `${line.utilisationPct}%`}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          "inline-block rounded-full border px-2 py-0.5 text-xs font-medium " +
                          b.cls
                        }
                      >
                        {b.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Bands: under &le; {NEAR_THRESHOLD_PCT}% used &middot; near{" "}
          {NEAR_THRESHOLD_PCT}&ndash;{OVER_THRESHOLD_PCT}% &middot; over &gt;{" "}
          {OVER_THRESHOLD_PCT}%.
          {position.unbudgetedActualPence > 0 ? (
            <>
              {" "}
              Categories with no budget set still show their spend above.
            </>
          ) : null}
        </div>
      </section>

      {/* ── Set budgets (admin only) ─────────────────────────────────────── */}
      {isManager ? (
        <section
          aria-labelledby="set-budgets"
          className="rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 id="set-budgets" className="text-sm font-semibold text-slate-900">
              Set budgets
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Enter a target and cadence for a category. Saving replaces the
              existing target for that category. Amounts are in pounds.
            </p>
          </div>
          <ul className="divide-y divide-slate-100">
            {FINANCE_CATEGORIES.map((category) => {
              const line = byCategory.get(category);
              const current = line?.budgetPence ?? null;
              return (
                <li key={category} className="px-4 py-4">
                  <form
                    action={setExpenseBudget}
                    className="flex flex-wrap items-end gap-3"
                  >
                    <input type="hidden" name="category" value={category} />
                    <div className="min-w-[8rem]">
                      <span className="block text-sm font-medium text-slate-800">
                        {CATEGORY_LABEL[category]}
                      </span>
                      {current !== null ? (
                        <span className="text-xs text-slate-500">
                          Current: {penceGbp(current)} ·{" "}
                          {PERIOD_LABEL[line?.periodType ?? "monthly"]}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">No budget set</span>
                      )}
                    </div>
                    <div>
                      <label
                        htmlFor={`amount-${category}`}
                        className="block text-xs font-medium text-slate-600"
                      >
                        Amount (£)
                      </label>
                      <input
                        id={`amount-${category}`}
                        name="amount"
                        type="number"
                        min="0.01"
                        step="0.01"
                        inputMode="decimal"
                        defaultValue={current !== null ? (current / 100).toFixed(2) : ""}
                        required
                        className="mt-1 w-32 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`period-${category}`}
                        className="block text-xs font-medium text-slate-600"
                      >
                        Period
                      </label>
                      <select
                        id={`period-${category}`}
                        name="period_type"
                        defaultValue={line?.periodType ?? "monthly"}
                        className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                      >
                        <option value="monthly">Monthly</option>
                        <option value="quarterly">Quarterly</option>
                        <option value="annual">Annual</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Save
                    </button>
                  </form>
                  {current !== null ? (
                    <form action={deleteExpenseBudget} className="mt-2">
                      <input type="hidden" name="category" value={category} />
                      <button
                        type="submit"
                        className="text-xs font-medium text-red-600 hover:text-red-800"
                      >
                        Remove budget
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
