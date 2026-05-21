import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { QuoteBuilder } from "../_builder";
import {
  listCustomersForQuote,
  listPropertiesForQuote,
  listLeadsForQuote,
} from "../_form-helpers";
import { createQuote } from "../actions";

/**
 * New-quote page.
 *
 * Server-renders dropdown options + the org's saved default_terms (so a
 * fresh quote pre-fills with the boilerplate the owner set in Settings).
 *
 * Form-level errors are surfaced inline via useActionState in the
 * QuoteBuilder — no `?error=` querystring round-trip.
 */

type SP = Promise<{
  lead_id?: string;
  customer_id?: string;
}>;

export default async function NewQuotePage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const [customers, properties, leads, orgRow] = await Promise.all([
    listCustomersForQuote(),
    listPropertiesForQuote(),
    listLeadsForQuote(),
    supabase
      .from("organizations")
      .select("default_terms")
      .eq("id", ctx.org.id)
      .maybeSingle()
      .then((r) => r.data),
  ]);

  // Pre-fill from /leads/[id] "Create a quote" CTA. Validates the IDs are
  // org-visible (RLS already filtered both lists, so we just check inclusion).
  const customerIds = new Set(customers.map((c) => c.id));
  const leadIds = new Set(leads.map((l) => l.id));
  const prefillCustomerId =
    sp.customer_id && customerIds.has(sp.customer_id) ? sp.customer_id : "";
  const prefillLeadId =
    sp.lead_id && leadIds.has(sp.lead_id) ? sp.lead_id : "";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/quotes" className="hover:text-slate-900">
          Quotes
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New quote</h1>
        <p className="mt-1 text-sm text-slate-600">
          Add line items, set terms, and you&apos;ll get a customer-facing link
          they can accept online.
        </p>
      </header>

      <QuoteBuilder
        action={createQuote}
        submitLabel="Save quote"
        customers={customers}
        properties={properties}
        leads={leads}
        defaultCustomerId={prefillCustomerId}
        defaultLeadId={prefillLeadId}
        defaultTerms={orgRow?.default_terms ?? ""}
      />
    </div>
  );
}
