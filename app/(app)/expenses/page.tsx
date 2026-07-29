import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";

/**
 * /expenses — expense drafts queue.
 *
 * Three buckets:
 *   - Pending (status='extracted') → waiting for operator approval.
 *   - Approved → finance row created (links to /finances/<id>).
 *   - Rejected → archived with reason.
 *
 * Approval / rejection both happen on the /expenses/[id] detail page.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type DraftRow = {
  id: string;
  supplier_name: string | null;
  amount: number | null;
  vat_rate: number | null;
  total: number | null;
  category: string | null;
  invoice_date: string | null;
  ai_confidence: number | null;
  status: string;
  finance_id: string | null;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
};

const SAVED_MAP: Record<string, string> = {
  approved: "Expense approved and posted to Finances.",
  rejected: "Draft rejected.",
};

type SP = Promise<{ status?: string; saved?: string }>;

export default async function ExpensesPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const filter =
    sp.status && ["extracted", "approved", "rejected"].includes(sp.status)
      ? sp.status
      : "extracted";

  const { data } = await (
    supabase.from("expense_drafts" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            order: (col: string, opts: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: DraftRow[] | null }>;
            };
          };
        };
      };
    }
  )
    .select(
      "id, supplier_name, amount, vat_rate, total, category, invoice_date, ai_confidence, status, finance_id, created_at, approved_at, rejected_at",
    )
    // ACTIVE-org pin — receipt drafts are money documents; RLS alone put both
    // companies' inboxes on one screen.
    .eq("org_id", ctx.org.id)
    .eq("status", filter)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = data ?? [];
  const savedMessage = sp.saved ? SAVED_MAP[sp.saved] ?? null : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Expenses</h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload a receipt or supplier invoice — the AI extracts amount,
            VAT, supplier and category. Nothing posts to your books until
            you approve.
          </p>
        </div>
        <Link
          href="/expenses/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + Upload receipt
        </Link>
      </header>

      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      <nav aria-label="Status" className="flex flex-wrap gap-2 text-xs">
        <FilterLink current={filter} value="extracted" label="Pending" />
        <FilterLink current={filter} value="approved" label="Approved" />
        <FilterLink current={filter} value="rejected" label="Rejected" />
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          icon="🧾"
          title={
            filter === "extracted"
              ? "No drafts waiting"
              : `No ${filter} drafts`
          }
          body={
            filter === "extracted"
              ? "Upload a receipt to extract the amount, VAT and supplier with AI."
              : "Nothing here yet."
          }
          primary={
            filter === "extracted"
              ? { href: "/expenses/new", label: "Upload a receipt" }
              : undefined
          }
        />
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3 hidden sm:table-cell">Amount</th>
                <th className="px-4 py-3 hidden md:table-cell">VAT</th>
                <th className="px-4 py-3 hidden lg:table-cell">Category</th>
                <th className="px-4 py-3 hidden lg:table-cell">AI confidence</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/expenses/${row.id}`}
                      className="font-medium text-slate-900 hover:text-slate-700"
                    >
                      {row.supplier_name ?? "Unknown supplier"}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600 hidden sm:table-cell">
                    {row.amount != null ? GBP.format(Number(row.amount)) : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 hidden md:table-cell">
                    {row.vat_rate != null ? `${row.vat_rate}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">
                    {row.category ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">
                    {row.ai_confidence != null ? `${row.ai_confidence}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {row.created_at.slice(0, 10)}
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

function FilterLink({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  return (
    <Link
      href={`/expenses?status=${value}`}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-full bg-slate-900 px-3 py-1 font-medium text-white"
          : "rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {label}
    </Link>
  );
}
