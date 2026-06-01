import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../../_components/empty-state";
import { NewInvoiceForm } from "./_form";

/**
 * New-invoice page: server-fetches the org's ACCEPTED quotes for the
 * dropdown, then renders the client form.
 *
 * Why only accepted quotes? Invoices are normally auto-created the moment a
 * quote is accepted (acceptQuoteAsOwner / the public-portal accept). This
 * manual page is the documented fallback for an accepted quote whose
 * auto-invoice didn't fire (see quotes/[id]/page.tsx). Listing draft/sent/etc.
 * quotes here would let an operator bill work the customer never accepted, and
 * — when no quote is accepted yet — leave the user on a dead, disabled form.
 */
export default async function NewInvoicePage() {
  await requireOrgContext();
  const supabase = await createClient();
  const { data: quotes } = await supabase
    .from("quotes")
    .select("id, number, subtotal, total, status")
    .eq("status", "accepted")
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
          Pick an accepted quote to bill. The next sequential invoice number is
          allocated automatically.
        </p>
      </header>

      {options.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🧾"
            title="No accepted quotes to bill"
            body="Invoices are generated automatically the moment a quote is accepted. To bill one by hand you first need a quote in the accepted state — approve and send a quote, then accept it on the customer's behalf (or have them accept it on their portal)."
            primary={{ href: "/quotes", label: "Go to quotes" }}
            secondary={{ href: "/invoices", label: "Back to invoices" }}
          />
        </div>
      ) : (
        <NewInvoiceForm quotes={options} />
      )}
    </div>
  );
}
