import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { PurchaseOrderBuilder } from "../_builder";
import { createPurchaseOrder } from "../actions";
import { listPoFormOptions } from "../_data";
import { loadImportDraftDefaults } from "@/server/services/document-autofill";
import { ImportPrefillBanner } from "@/components/import/import-prefill-banner";

export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ import?: string }>;
}) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const { import: importId } = await searchParams;

  const { suppliers, jobs } = await listPoFormOptions(supabase, ctx.org.id);

  // Build the builder's `initial` from an imported supplier quote/proforma: the
  // header reference/date/notes plus the priced lines mapped to the builder's
  // numeric shape. Relational supplier/job are NOT imported — the operator picks
  // them (a document can't name a CrewFlow id).
  const prefill = importId
    ? await loadImportDraftDefaults("purchase_order", importId)
    : null;
  const initial = prefill
    ? {
        supplier_reference: prefill.fields.supplier_reference ?? null,
        expected_date: prefill.fields.expected_date ?? null,
        notes: prefill.fields.notes ?? null,
        line_items: prefill.lineItems.map((li) => ({
          description: li.description ?? "",
          qty: Number(li.qty) || 0,
          unit: li.unit ?? "ea",
          unit_price: Number(li.unit_price) || 0,
          vat_rate: Number(li.vat_rate ?? "20") || 0,
        })),
      }
    : undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/purchase-orders" className="hover:text-slate-900">
          Purchase orders
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>
      <header>
        <h1 className="text-2xl font-bold text-slate-900">New purchase order</h1>
        <p className="mt-0.5 text-sm text-slate-500">Record what you&apos;re ordering from a supplier.</p>
      </header>

      {prefill ? (
        <ImportPrefillBanner engine={prefill.engine} recordLabel="purchase order" />
      ) : null}

      <PurchaseOrderBuilder
        action={createPurchaseOrder}
        suppliers={suppliers}
        jobs={jobs}
        initial={initial}
        submitLabel="Create purchase order"
      />
    </div>
  );
}
