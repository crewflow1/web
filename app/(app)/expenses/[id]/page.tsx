import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { listSuppliersForOrg, type SuppliersClient } from "@/server/services/suppliers";
import { withPreservedOption } from "@/lib/quotes/preserve-option";
import { approveExpenseDraftAction, rejectExpenseDraft } from "../actions";
import { AmountInput } from "./_amount-input";

/**
 * /expenses/[id] — approve / reject an AI-extracted expense draft.
 *
 * Shows the extracted values, the AI confidence, links to the original
 * receipt file (signed URL), and an editable form. On approve we INSERT
 * into finances + stamp the draft. On reject we mark it rejected with
 * a reason.
 */

type DraftRow = {
  id: string;
  upload_id: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  amount: number | null;
  vat_rate: number | null;
  vat_total: number | null;
  total: number | null;
  category: string | null;
  invoice_date: string | null;
  reference: string | null;
  ai_confidence: number | null;
  status: string;
  finance_id: string | null;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
};

type SupplierRow = { id: string; name: string };

const ERROR_MAP: Record<string, string> = {
  validation: "Some fields look off — check amount and VAT rate.",
  approve_failed: "Couldn't approve the draft. Try again.",
  reject_failed: "Couldn't reject the draft. Try again.",
  forbidden: "Only an owner or admin can approve or reject expense drafts.",
  not_found: "That draft no longer exists.",
  already_approved: "That draft was already approved — it can't be rejected.",
};

type SP = Promise<{ error?: string }>;

export default async function ExpenseDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: row, error: rowError } = await (
    supabase.from("expense_drafts" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: DraftRow | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select(
      "id, upload_id, supplier_id, supplier_name, amount, vat_rate, vat_total, total, category, invoice_date, reference, ai_confidence, status, finance_id, created_at, approved_at, rejected_at, rejection_reason",
    )
    .eq("id", id)
    // ACTIVE-org pin (#456 read-side class). RLS admits every org the viewer
    // belongs to; without this a dual-org member could review (and post to
    // Finances) another org's expense draft — supplier, amount, VAT, reference —
    // inside this org's shell. The supplier picker below was already pinned.
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (rowError) throw readFailure("expense draft: detail", rowError);
  if (!row) notFound();

  // Active-org scoped: the picker must not offer a supplier from another org
  // the viewer belongs to — that leaked the other company's supplier names
  // into this org's shell. The WRITE side was already safe: `finances` carries
  // an org-integrity trigger (20261009000000_supplier_bills.sql) that refuses a
  // supplier from a different org, so picking one only ever produced a failed
  // approval. This makes the list match what can actually be approved.
  const suppliers = await listSuppliersForOrg<SupplierRow>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
  );
  // DEFENCE-IN-DEPTH against the picker-class silent-null (F-1). The reader pages
  // the roster complete, but the saved supplier must never be droppable from the
  // <select> — otherwise approving/editing this bill would NULL a valid supplier
  // link on a save that never touched the picker. Preserve-inject the saved id.
  const supplierOptions = withPreservedOption(
    suppliers,
    row.supplier_id ?? undefined,
    (id) => ({ id, name: "Current supplier" }),
  );

  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? sp.error : null;
  const editable = row.status === "extracted";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/expenses" className="hover:text-slate-900">
          Expenses
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">
          {row.supplier_name ?? "Draft"}
        </span>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Expense draft</h1>
          <p className="mt-1 text-sm text-slate-600">
            Review the values the AI pulled from the receipt. Approve to
            post to Finances; nothing has been recorded yet.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              row.status === "extracted"
                ? "bg-amber-100 text-amber-800"
                : row.status === "approved"
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-slate-100 text-slate-600"
            }`}
          >
            {row.status}
          </span>
          {row.ai_confidence != null ? (
            <span className="text-slate-500">
              AI confidence: {row.ai_confidence}%
            </span>
          ) : null}
        </div>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {row.status === "approved" && row.finance_id ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Approved — posted to{" "}
          <Link
            href={`/finances`}
            className="font-medium underline hover:text-emerald-900"
          >
            Finances
          </Link>
          .
        </div>
      ) : row.status === "rejected" ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Rejected{row.rejection_reason ? `: ${row.rejection_reason}` : ""}.
        </div>
      ) : null}

      <form
        action={approveExpenseDraftAction}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <input type="hidden" name="draft_id" value={row.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="amount"
              className="block text-sm font-medium text-slate-800"
            >
              Amount (net, ex VAT)
              <span className="ml-0.5 text-red-500">*</span>
            </label>
            <AmountInput
              id="amount"
              name="amount"
              step="0.01"
              min="0"
              required
              defaultValue={row.amount ?? ""}
              disabled={!editable}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-100"
            />
          </div>
          <div>
            <label
              htmlFor="vat_rate"
              className="block text-sm font-medium text-slate-800"
            >
              VAT rate
              <span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="vat_rate"
              name="vat_rate"
              required
              defaultValue={row.vat_rate ?? 20}
              disabled={!editable}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-100"
            >
              <option value="0">0% — exempt / zero-rated</option>
              <option value="5">5% — reduced</option>
              <option value="20">20% — standard</option>
            </select>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="supplier_id"
              className="block text-sm font-medium text-slate-800"
            >
              Supplier
            </label>
            <select
              id="supplier_id"
              name="supplier_id"
              defaultValue={row.supplier_id ?? ""}
              disabled={!editable}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-100"
            >
              <option value="">— No supplier —</option>
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {row.supplier_name ? (
              <p className="mt-1 text-xs text-slate-500">
                AI read: <strong>{row.supplier_name}</strong>
              </p>
            ) : null}
          </div>
          <div>
            <label
              htmlFor="category"
              className="block text-sm font-medium text-slate-800"
            >
              Category
            </label>
            <input
              id="category"
              name="category"
              type="text"
              defaultValue={row.category ?? ""}
              disabled={!editable}
              placeholder="Materials, Plant hire, Fuel…"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-100"
            />
          </div>
        </div>

        {row.invoice_date || row.reference || row.total != null ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">AI-extracted reference</p>
            <ul className="mt-1 space-y-0.5">
              {row.invoice_date ? <li>Invoice date: {row.invoice_date}</li> : null}
              {row.reference ? <li>Reference: {row.reference}</li> : null}
              {row.total != null ? <li>Total (gross): £{row.total}</li> : null}
            </ul>
          </div>
        ) : null}

        {editable ? (
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Approve + post to Finances
            </button>
            <Link
              href="/expenses"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Cancel
            </Link>
          </div>
        ) : null}
      </form>

      {editable ? (
        <form
          action={rejectExpenseDraft}
          className="space-y-3 rounded-xl border border-red-200 bg-red-50/50 p-4"
        >
          <input type="hidden" name="draft_id" value={row.id} />
          <label
            htmlFor="reason"
            className="block text-sm font-medium text-red-900"
          >
            Reject this draft
          </label>
          <textarea
            id="reason"
            name="reason"
            rows={2}
            maxLength={500}
            placeholder="Optional reason"
            className="block w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
          />
          <button
            type="submit"
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Reject
          </button>
        </form>
      ) : null}
    </div>
  );
}
