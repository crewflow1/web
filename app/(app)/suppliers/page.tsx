import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  listSuppliersForOrg,
  SUPPLIER_LIST_LIMIT,
  type SuppliersClient,
} from "@/server/services/suppliers";
import { EmptyState } from "../_components/empty-state";

/**
 * /suppliers — list suppliers for the ACTIVE org.
 *
 * Each row links to /suppliers/[id] for editing. Suppliers feed into
 * the expense draft + finances workflow (Phase D).
 *
 * The read goes through listSuppliersForOrg because RLS alone does not scope
 * it: `current_org_ids()` admits every org the viewer belongs to, so a
 * dual-org member's address book would otherwise show both companies'
 * suppliers side by side with nothing to tell them apart.
 */

type SupplierRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  category: string | null;
  created_at: string;
};

export default async function SuppliersPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const rows = await listSuppliersForOrg<SupplierRow>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
    {
      columns: "id, name, email, phone, category, created_at",
      orderBy: "created_at",
      ascending: false,
      limit: SUPPLIER_LIST_LIMIT,
    },
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Suppliers</h1>
          <p className="mt-1 text-sm text-slate-600">
            People and companies you pay. Used on expenses + finances.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rows.length > 0 ? (
            <Link
              href="/suppliers/compare"
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Compare performance
            </Link>
          ) : null}
          <Link
            href="/suppliers/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            + Add supplier
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon="🏗️"
          title="No suppliers yet"
          body="Add your first supplier so you can attach receipts and expenses to them."
          primary={{ href: "/suppliers/new", label: "Add a supplier" }}
        />
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3 hidden sm:table-cell">Category</th>
                <th className="px-4 py-3 hidden md:table-cell">Email</th>
                <th className="px-4 py-3 hidden md:table-cell">Phone</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/suppliers/${row.id}`}
                      className="font-medium text-slate-900 hover:text-slate-700"
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600 hidden sm:table-cell">
                    {row.category ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 hidden md:table-cell">
                    {row.email ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 hidden md:table-cell">
                    {row.phone ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
