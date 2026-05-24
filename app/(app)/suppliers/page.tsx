import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";

/**
 * /suppliers — list suppliers for the org.
 *
 * Each row links to /suppliers/[id] for editing. Suppliers feed into
 * the expense draft + finances workflow (Phase D).
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
  await requireOrgContext();
  const supabase = await createClient();

  const { data } = await (
    supabase.from("suppliers" as never) as unknown as {
      select: (cols: string) => {
        order: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => Promise<{ data: SupplierRow[] | null }>;
        };
      };
    }
  )
    .select("id, name, email, phone, category, created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Suppliers</h1>
          <p className="mt-1 text-sm text-slate-600">
            People and companies you pay. Used on expenses + finances.
          </p>
        </div>
        <Link
          href="/suppliers/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + Add supplier
        </Link>
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
