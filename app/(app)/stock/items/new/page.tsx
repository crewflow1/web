import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listSuppliersForOrg, type SuppliersClient } from "@/server/services/suppliers";
import { createStockItem } from "../../actions";
import { StockItemForm } from "../_form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Add stock item · CrewFlow" };

/**
 * /stock/items/new — add a catalogue item.
 *
 * ORG-PINNED: the supplier picker reads through listSuppliersForOrg, which
 * carries the active-org predicate. Without it a dual-org member would be
 * offered the other company's suppliers, and the org-integrity trigger on
 * stock_items.preferred_supplier_id would then refuse the save — a leak turned
 * into an unexplainable error.
 */
export default async function NewStockItemPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const suppliers = await listSuppliersForOrg<{ id: string; name: string }>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href="/stock/items" className="text-sm text-slate-500 hover:text-slate-700">
          ← Stock items
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Add a stock item</h1>
        <p className="mt-1 text-sm text-slate-600">
          Only the things you keep a running count of. One-off materials stay on the purchase order
          where they belong — you do not have to catalogue everything you ever buy.
        </p>
      </header>

      <StockItemForm
        action={createStockItem}
        suppliers={suppliers}
        submitLabel="Add item"
        cancelHref="/stock/items"
      />
    </div>
  );
}
