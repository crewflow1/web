import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { NewInvoiceForm } from "./_form";

/**
 * New-invoice page: server-fetches the org's quotes for the dropdown,
 * then renders the client form.
 */
export default async function NewInvoicePage() {
  await requireOrgContext();
  const supabase = await createClient();
  const { data: quotes } = await supabase
    .from("quotes")
    .select("id, number, subtotal, total, status")
    .order("created_at", { ascending: false })
    .limit(500);

  const options = (quotes ?? []).map((q) => ({
    id: q.id,
    number: q.number ?? null,
    subtotal: Number(q.subtotal ?? 0),
    total: Number(q.total ?? 0),
    status: String(q.status ?? "draft"),
  }));

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/invoices" className="hover:text-slate-900">
          Invoices
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Generate invoice</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pick a quote to bill. The next sequential invoice number is
          allocated automatically.
        </p>
      </header>

      <NewInvoiceForm quotes={options} />
    </div>
  );
}
