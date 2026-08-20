import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
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
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  // COMPLETE read (F-1). The old `.limit(500)` capped this picker: an org with
  // more than 500 accepted-but-uninvoiced quotes silently could not bill the
  // overflow. Page the WHOLE accepted set so every billable quote is selectable.
  const { data: quotes, error: quotesError } = await fetchAllRows<{
    id: string;
    number: string | null;
    subtotal: number | null;
    total: number | null;
    status: string | null;
  }>((from, to) =>
    supabase
      .from("quotes")
      .select("id, number, subtotal, total, status")
      // ACTIVE-org pin — offering the other org's accepted quote here produces an
      // invoice the org-scoped write side cannot honour.
      .eq("org_id", ctx.org.id)
      .eq("status", "accepted")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (quotesError) throw readFailure("new invoice: accepted quotes", quotesError);

  const rawOptions = (quotes ?? []).map((q) => ({
    id: q.id,
    number: q.number ?? null,
    subtotal: Number(q.subtotal ?? 0),
    total: Number(q.total ?? 0),
    status: String(q.status ?? "draft"),
  }));

  // Exclude any accepted variation quote already captured in a non-cancelled
  // interim valuation — it is billed via the valuation invoice, so offering it
  // here would let an operator double-bill (its accept-invoice was deleted on
  // valuation-link, freeing the quote_id unique slot). The valuation link table is
  // the persistent fence. Bounded to this page's accepted set; loud + org-pinned.
  const acceptedIds = rawOptions.map((o) => o.id);
  const excluded = new Set<string>();
  if (acceptedIds.length > 0) {
    type QB = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> & {
      select: (c: string) => QB;
      eq: (k: string, v: unknown) => QB;
      in: (k: string, v: unknown[]) => QB;
      neq: (k: string, v: unknown) => QB;
      order: (k: string, o: { ascending: boolean }) => QB;
      range: (f: number, t: number) => PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
    };
    const looseDb = supabase as unknown as { from: (t: string) => QB };
    const { data: links, error: linksError } = await fetchAllRows<Record<string, unknown>>((from, to) =>
      looseDb
        .from("job_valuation_variations")
        .select("variation_quote_id, valuation_id")
        .eq("org_id", ctx.org.id)
        .in("variation_quote_id", acceptedIds)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (linksError) throw readFailure("new invoice: valuation links", linksError);
    const valIds = [...new Set((links ?? []).map((l) => String(l.valuation_id)))];
    const liveVal = new Set<string>();
    if (valIds.length > 0) {
      const { data: vals, error: valsError } = await fetchAllRows<Record<string, unknown>>((from, to) =>
        looseDb
          .from("job_valuations")
          .select("id")
          .eq("org_id", ctx.org.id)
          .in("id", valIds)
          .neq("status", "cancelled")
          .order("id", { ascending: true })
          .range(from, to),
      );
      if (valsError) throw readFailure("new invoice: valuation status", valsError);
      for (const v of vals ?? []) liveVal.add(String(v.id));
    }
    for (const l of links ?? []) {
      if (liveVal.has(String(l.valuation_id))) excluded.add(String(l.variation_quote_id));
    }
  }
  const options = rawOptions.filter((o) => !excluded.has(o.id));

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
