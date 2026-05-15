import Link from "next/link";
import { createCustomer } from "../actions";
import { Field, TextareaField } from "../../_components/field";

/**
 * Create-customer page.
 *
 * Server-rendered form posting to `createCustomer`. Errors are surfaced
 * via the `?error=` query param so the form survives a round-trip.
 */
export default async function NewCustomerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error
    ? error === "create_failed"
      ? "Something went wrong saving the customer. Try again."
      : decodeURIComponent(error)
    : null;

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

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <form action={createCustomer} className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <Field
          name="name"
          label="Name"
          required
          placeholder="e.g. Sarah Murphy"
          autoComplete="name"
        />
        <Field
          name="email"
          label="Email"
          type="email"
          optional
          placeholder="sarah@example.com"
          autoComplete="email"
        />
        <Field
          name="phone"
          label="Phone"
          type="tel"
          inputMode="tel"
          optional
          placeholder="+44 7700 900123"
          autoComplete="tel"
        />
        <TextareaField
          name="notes"
          label="Notes"
          optional
          rows={4}
          placeholder="Anything worth remembering — preferred call times, gate codes, etc."
        />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Save customer
          </button>
          <Link
            href="/customers"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
