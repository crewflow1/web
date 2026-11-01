import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadBusinessOptions } from "@/lib/customers/companies";
import { loadImportDraftDefaults } from "@/server/services/document-autofill";
import { ImportPrefillBanner } from "@/components/import/import-prefill-banner";
import type { CustomerFormInput } from "@/lib/customers/schema";
import { createCustomer } from "../actions";
import { CustomerForm } from "../_form";

/**
 * Create-customer page.
 *
 * Inline validation + state preservation are handled by `CustomerForm`
 * via React 19 `useActionState`. No `?error=` round-trip.
 *
 * Loads the org's business customers so a new record can be rolled up under a
 * parent business immediately (loud read — a failure throws, never a silent
 * empty picker). Active-org pinned inside the loader.
 */
export default async function NewCustomerPage({
  searchParams,
}: {
  searchParams: Promise<{ import?: string }>;
}) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const parentOptions = await loadBusinessOptions(supabase, ctx.org.id);

  // Document-autofill prefill. The draft is RLS-scoped to this operator + org;
  // an absent/foreign/wrong-type id simply yields no defaults, so the form opens
  // blank. The values are suggestions — the operator edits and saves normally.
  const sp = await searchParams;
  const prefill = sp.import ? await loadImportDraftDefaults("customer", sp.import) : null;
  const defaults = (prefill?.fields ?? undefined) as Partial<CustomerFormInput> | undefined;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/customers" className="hover:text-slate-900">
          Customers
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New customer</h1>
        <p className="mt-1 text-sm text-slate-600">
          Save contact details once; link them to jobs and quotes later.
        </p>
      </header>

      {prefill ? <ImportPrefillBanner engine={prefill.engine} recordLabel="customer" /> : null}

      <CustomerForm
        action={createCustomer}
        submitLabel="Save customer"
        cancelHref="/customers"
        parentOptions={parentOptions}
        defaults={defaults}
      />
    </div>
  );
}
