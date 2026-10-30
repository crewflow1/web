import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/server/auth/capabilities";
import { penceToPounds } from "@/lib/money";
import { getPriceBookItem } from "@/lib/pricing/queries";
import { updatePriceBookItem } from "../actions";
import { PriceBookItemForm } from "../_forms";

/**
 * /price-book/[id] — edit a single price-book item.
 *
 * AUTHZ (R4): this page IS the editor, so it gates on price_book:edit — a
 * view-only admin can't reach it by URL (redirected), and the list page only
 * shows the "Edit" link to editors. The update action re-checks edit server-side.
 *
 * Org-pinned by-id read (ctx.org.id): current_org_ids() is the outer RLS
 * boundary, so a by-id fetch MUST carry its own org predicate or a dual-org
 * member could edit another org's rate. `unit_price` is stored in pence and
 * shown to the form in pounds.
 */

export const dynamic = "force-dynamic";

export default async function EditPriceBookItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireCapability("price_book", "edit");
  const item = await getPriceBookItem(ctx.org.id, id);
  if (!item) notFound();

  const updateAction = updatePriceBookItem.bind(null, id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/price-book" className="hover:text-slate-900">Price book</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Edit</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Edit price-book item</h1>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <PriceBookItemForm
          action={updateAction}
          submitLabel="Save changes"
          pendingLabel="Saving…"
          initial={{
            code: item.code ?? undefined,
            description: item.description,
            unit: item.unit,
            unit_price: penceToPounds(item.unit_price),
            category: item.category ?? undefined,
            vat_rate: item.vat_rate,
            active: item.active,
          }}
        />
      </section>
    </div>
  );
}
