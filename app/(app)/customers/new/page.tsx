import Link from "next/link";
import { createCustomer } from "../actions";
import { CustomerForm } from "../_form";
import { FadeIn } from "@/components/ui";

/**
 * Create-customer page.
 *
 * Inline validation + state preservation are handled by `CustomerForm`
 * via React 19 `useActionState`. No `?error=` round-trip.
 */
export default function NewCustomerPage() {
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

      <FadeIn>
        <CustomerForm
          action={createCustomer}
          submitLabel="Save customer"
          cancelHref="/customers"
        />
      </FadeIn>
    </div>
  );
}
