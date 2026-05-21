import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";

/**
 * Customers list.
 *
 * Server-component fetch under user JWT — RLS limits the rows to the
 * caller's org automatically. We still call requireOrgContext() so the
 * page redirects to /onboarding if the user has no org yet.
 *
 * Renders a card list on mobile (<sm:) and a four-column table on
 * tablet/desktop. The earlier table-only version horizontally scrolled
 * on phones, which made it impossible to tap the "Edit" affordance.
 */
export default async function CustomersPage() {
  await requireOrgContext();

  const supabase = await createClient();
  const { data: customers, error } = await supabase
    .from("customers")
    .select("id, name, email, phone, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[customers] list failed", error);
  }
  const rows = customers ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="mt-1 text-sm text-slate-600">
            {rows.length} {rows.length === 1 ? "customer" : "customers"}
          </p>
        </div>
        <Link
          href="/customers/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          + New customer
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="👥"
            title="No customers yet"
            body="Capture the people you do work for. You can link jobs, quotes, and invoices to customers later."
            primary={{ href: "/customers/new", label: "Add first customer" }}
          />
        </div>
      ) : (
        <>
          {/* Mobile: stacked card list */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-slate-200 bg-white shadow-sm"
              >
                <Link
                  href={`/customers/${c.id}`}
                  className="block px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold text-slate-900">
                        {c.name}
                      </p>
                      {c.email ? (
                        <p className="mt-0.5 truncate text-xs text-slate-600">
                          {c.email}
                        </p>
                      ) : null}
                      {c.phone ? (
                        <p className="mt-0.5 truncate text-xs text-slate-600">
                          {c.phone}
                        </p>
                      ) : null}
                    </div>
                    <span
                      aria-hidden
                      className="shrink-0 self-center text-slate-400"
                    >
                      ›
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Tablet + desktop: table */}
          <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm sm:block">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-sm">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {c.name}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.email ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.phone ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/customers/${c.id}`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
