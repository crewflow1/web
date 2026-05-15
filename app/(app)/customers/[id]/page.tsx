import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateCustomer, deleteCustomer } from "../actions";
import { Field, TextareaField } from "../../_components/field";

/**
 * Customer edit page.
 *
 * Loads the customer under user JWT (RLS filters to the caller's org).
 * Renders an edit form + a delete form. Delete only succeeds for
 * admins/owners (RLS).
 */
export default async function EditCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;

  await requireOrgContext();
  const supabase = await createClient();
  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, email, phone, notes")
    .eq("id", id)
    .maybeSingle();

  if (!customer) notFound();

  const errorMessage = error
    ? error === "update_failed"
      ? "Couldn't save. Try again."
      : error === "delete_failed"
        ? "Couldn't delete. Only admins/owners can delete customers."
        : decodeURIComponent(error)
    : null;

  // Bind id into action so the form submission knows which customer.
  const updateAction = updateCustomer.bind(null, customer.id);
  const deleteAction = deleteCustomer.bind(null, customer.id);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/customers" className="hover:text-slate-900">
          Customers
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-slate-900">{customer.name}</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Edit customer</h1>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {saved ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          Saved.
        </div>
      ) : null}

      <form action={updateAction} className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <Field name="name" label="Name" required defaultValue={customer.name} />
        <Field
          name="email"
          label="Email"
          type="email"
          optional
          defaultValue={customer.email ?? ""}
        />
        <Field
          name="phone"
          label="Phone"
          type="tel"
          inputMode="tel"
          optional
          defaultValue={customer.phone ?? ""}
        />
        <TextareaField
          name="notes"
          label="Notes"
          optional
          rows={4}
          defaultValue={customer.notes ?? ""}
        />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Save changes
          </button>
          <Link
            href="/customers"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>

      <form
        action={deleteAction}
        className="rounded-xl border border-red-200 bg-red-50/50 p-4"
      >
        <p className="text-sm font-medium text-red-900">Delete this customer</p>
        <p className="mt-1 text-xs text-red-700">
          Removes the customer record. Linked jobs will keep their reference but
          the link will be cleared. Only admins/owners can delete.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
        >
          Delete customer
        </button>
      </form>
    </div>
  );
}
