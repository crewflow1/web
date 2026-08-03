import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  loadReplenishmentSuggestions,
} from "@/server/services/stock-reorder";
import type { StockClient } from "@/server/services/stock";
import { AccountingNote, Card, CardHeader } from "../_components/ui";
import { ReplenishmentForm } from "./_replenishment-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Replenishment · CrewFlow" };

/**
 * /stock/replenishment — what to re-order, and one click to raise it.
 *
 * ROLE-GATED: owner/admin only. Replenishment is a purchasing decision, so the
 * whole surface (view AND the create action behind it) is restricted the same
 * way createPoDraftFromRequest is. A member sees a clear message, not a 404.
 *
 * ORG-PINNED: the read goes through loadReplenishmentSuggestions →
 * loadStockPositions, which carries `.eq("org_id", ctx.org.id)` on top of RLS
 * (current_org_ids() admits every org a dual-org member belongs to) and fails
 * loudly rather than rendering an empty list from a rejected query.
 *
 * DETERMINISTIC AND HONEST: every row is an item at or below its reorder point
 * with a quantity the user's own config justifies (a fixed batch, or the
 * order-up-to shortfall). Items with no reorder point never appear; nothing is
 * fabricated. See lib/stock/reorder.ts.
 *
 * THE ACCOUNTING BOUNDARY: no value is shown or written. Raising a request asks
 * for quantities; the office prices them on the PO. Materials are costed once,
 * at the supplier bill.
 */

export default async function ReplenishmentPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const header = (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Replenishment</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Items at or below their reorder point, with how many to buy. Raising a request hands
          off to the materials queue — nothing is ordered until the office says so.
        </p>
      </div>
      <Link
        href="/stock"
        className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        ← Stock
      </Link>
    </header>
  );

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {header}
        <Card>
          <p className="px-4 py-6 text-sm text-slate-600">
            Only an owner or admin can raise replenishment requests. Ask one of them, or set
            reorder levels on items from{" "}
            <Link href="/stock/items" className="font-medium text-slate-900 underline">
              the item list
            </Link>
            .
          </p>
        </Card>
      </div>
    );
  }

  const supabase = await createClient();
  const suggestions = await loadReplenishmentSuggestions(
    supabase as unknown as StockClient,
    ctx.org.id, // ACTIVE-ORG PIN
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {header}
      <AccountingNote />

      {suggestions.length === 0 ? (
        <Card>
          <CardHeader title="Nothing to re-order" />
          <p className="px-4 py-6 text-sm text-slate-500">
            No tracked item is at or below its reorder point right now. Set a reorder level and a
            re-order quantity (or a target level) on an item, and it will show up here when it
            runs low.
          </p>
        </Card>
      ) : (
        <ReplenishmentForm
          rows={suggestions.map((s) => ({
            itemId: s.itemId,
            name: s.name,
            unit: s.unit,
            available: s.available,
            reorderPoint: s.reorderPoint,
            suggestedQuantity: s.suggestedQuantity,
            basis: s.basis,
          }))}
        />
      )}
    </div>
  );
}
