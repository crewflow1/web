import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadStockItem, type StockClient } from "@/server/services/stock";
import { listSuppliersForOrg, type SuppliersClient } from "@/server/services/suppliers";
import { updateStockItem } from "../../../actions";
import { StockItemForm } from "../../_form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Edit stock item · CrewFlow" };

/**
 * /stock/items/[id]/edit.
 *
 * ORG-PINNED on the load (an item in the caller's other org 404s, exactly as a
 * missing one does) AND on the write (`updateStockItem` is count-gated on
 * `.eq("org_id", ctx.org.id)`), because RLS alone passes for every org a
 * dual-org member belongs to.
 *
 * A number that is 0 must still render as "0", not as an empty field — hence
 * the explicit null checks rather than `?? ""` on a falsy-able value.
 */
type Params = Promise<{ id: string }>;

const text = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);

export default async function EditStockItemPage({ params }: { params: Params }) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const item = await loadStockItem(supabase as unknown as StockClient, ctx.org.id, id);
  if (!item) notFound();

  const suppliers = await listSuppliersForOrg<{ id: string; name: string }>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href={`/stock/items/${item.id}`} className="text-sm text-slate-500 hover:text-slate-700">
          ← {item.name}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Edit item</h1>
        <p className="mt-1 text-sm text-slate-600">
          Changing the name or unit re-labels this item&rsquo;s own history and nothing else. The
          quantities themselves come from the movements and can never be edited here.
        </p>
      </header>

      <StockItemForm
        action={updateStockItem.bind(null, item.id)}
        suppliers={suppliers}
        submitLabel="Save changes"
        cancelHref={`/stock/items/${item.id}`}
        defaults={{
          name: item.name,
          description: text(item.description),
          sku: text(item.sku),
          unit: item.unit,
          preferred_supplier_id: text(item.preferred_supplier_id),
          supplier_reference: text(item.supplier_reference),
          reorder_level: text(item.reorder_level),
          target_level: text(item.target_level),
          notes: text(item.notes),
        }}
      />
    </div>
  );
}
