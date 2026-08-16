import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadBusinessOptions } from "@/lib/customers/companies";
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
export default async function NewCustomerPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const parentOptions = await loadBusinessOptions(supabase, ctx.org.id);

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

      <CustomerForm
        action={createCustomer}
        submitLabel="Save customer"
        cancelHref="/customers"
        parentOptions={parentOptions}
      />
    </div>
  );
}
