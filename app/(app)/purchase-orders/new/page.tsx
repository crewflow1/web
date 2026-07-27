import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { PurchaseOrderBuilder } from "../_builder";
import { createPurchaseOrder } from "../actions";
import { listPoFormOptions } from "../_data";

export default async function NewPurchaseOrderPage() {
  await requireOrgContext();
  const supabase = await createClient();

  const { suppliers, jobs } = await listPoFormOptions(supabase);

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

      <PurchaseOrderBuilder
        action={createPurchaseOrder}
        suppliers={suppliers}
        jobs={jobs}
        submitLabel="Create purchase order"
      />
    </div>
  );
}
