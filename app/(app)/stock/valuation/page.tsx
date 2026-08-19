import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadStockValuationReport, type StockClient } from "@/server/services/stock";
import { formatGbp } from "@/lib/money";
import { formatQuantity } from "@/lib/stock/movements";
import { EmptyState } from "../../_components/empty-state";
import { Card, CardHeader, Tile } from "../_components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stock valuation · CrewFlow" };

/**
 * /stock/valuation — the WEIGHTED-AVERAGE stock valuation report (qty × wavg).
 *
 * ORG-PINNED and LOUD: the read goes through server/services/stock.ts, which
 * carries `.eq("org_id", ctx.org.id)` on top of RLS and throws on a failed
 * query, so a rejected read can never render as "nothing in stock".
 *
 * THE ACCOUNTING MODEL (CEO decision D1 — DECIDED: weighted-average cost). This
 * is a MANAGEMENT-ACCOUNTING valuation: it is NOT a second expense. The
 * company's cost of sale is still recorded exactly once, when the supplier's
 * bill is entered — this report re-expresses that spend as the value of stock
 * still on hand. Because it posts nothing to the accounts, it can never
 * double-count. See docs/operational-stock.md.
 */
export default async function StockValuationPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { rows, totals } = await loadStockValuationReport(
    supabase as unknown as StockClient,
    ctx.org.id,
  );

  const inStock = rows.filter((r) => r.onHand !== 0 || r.bookValue !== 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Link href="/stock" className="hover:text-slate-700">
            Stock
          </Link>
          <span aria-hidden>/</span>
          <span className="text-slate-700">Valuation</span>
        </div>
        <h1 className="text-xl font-semibold text-slate-900">Stock valuation</h1>
        <p className="text-sm text-slate-600">
          What the stock on hand is worth at{" "}
          <span className="font-medium text-slate-800">weighted-average cost</span> — the running
          average of what you paid for it, from the delivery prices on your posted goods received
          notes.
        </p>
      </header>

      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        This is a <span className="font-medium text-slate-800">valuation, not a second cost</span>.
        Materials are expensed once, when you record the supplier&rsquo;s bill; this report simply
        values what has not yet been issued. Issuing stock to a job releases its average cost to
        that job&rsquo;s costing — it never bills you again.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Total stock value" value={formatGbp(totals.bookValue)} />
        <Tile label="Items in stock" value={String(totals.itemsInStock)} />
        <Tile
          label="Items with unpriced stock"
          value={String(totals.itemsWithUncosted)}
          hint={totals.itemsWithUncosted > 0 ? "Some on-hand has no known cost" : undefined}
        />
      </div>

      <Card>
        <CardHeader
          title="Valuation by item"
          hint="Quantity on hand × its weighted-average unit cost. Highest value first."
        />
        {inStock.length === 0 ? (
          <EmptyState
            title="Nothing to value yet"
            body="Once you receive priced deliveries into stock, their value shows here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 text-right font-medium">On hand</th>
                  <th className="px-4 py-2 text-right font-medium">Avg unit cost</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {inStock.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{r.name}</div>
                      {r.sku ? <div className="text-xs text-slate-500">{r.sku}</div> : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {formatQuantity(r.onHand)} {r.unit}
                      {r.hasUncosted ? (
                        <div className="text-xs text-amber-600">
                          {formatQuantity(r.uncostedQty)} at unknown cost
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {r.avgUnitCost === null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        formatGbp(r.avgUnitCost)
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">
                      {formatGbp(r.bookValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {totals.itemsWithUncosted > 0 ? (
        <p className="text-xs text-slate-500">
          &ldquo;Unknown cost&rdquo; is stock that was on hand before cost tracking began, or
          received without a priced delivery line. It is counted in the quantity but not in the
          value, so the total is never inflated by a figure CrewFlow does not actually know.
        </p>
      ) : null}
    </div>
  );
}
