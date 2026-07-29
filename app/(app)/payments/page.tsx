import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { uploadBankCsv } from "./actions";

/**
 * Payments overview — entry point for bank reconciliation.
 *
 *   /payments       — list past statements, upload form
 *   /payments/reconcile/[statementId] — match suggestions for a single upload
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type SP = Promise<{ error?: string; saved?: string }>;

export default async function PaymentsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  // Caller's role from ctx — their own membership in the ACTIVE org. An
  // unfiltered memberships read returns every member's row (org-member
  // visibility policy) and `.single()` errors in any org with ≥2 members.
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const [{ data: statements }, { data: outstandingRows }] = await Promise.all([
    supabase
      .from("bank_statements")
      .select("id, filename, uploaded_at, line_count, matched_count")
      // ACTIVE-org pin — statements and the outstanding total below are money
      // figures; RLS admits every org the viewer belongs to.
      .eq("org_id", ctx.org.id)
      .order("uploaded_at", { ascending: false })
      .limit(20),
    supabase
      .from("invoices")
      .select("id, number, total, due_date, status")
      .eq("org_id", ctx.org.id)
      .in("status", ["sent", "awaiting_payment", "partially_paid", "overdue"]),
  ]);

  const outstandingTotal = (outstandingRows ?? []).reduce(
    (s, i) => s + Number(i.total ?? 0),
    0,
  );

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved
    ? sp.saved === "payment"
      ? "Payment recorded and allocated."
      : sp.saved === "uploaded"
      ? "Statement uploaded — review matches below."
      : sp.saved === "matched"
        ? "Match confirmed."
        : sp.saved === "ignored"
          ? "Line ignored."
          : null
    : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Payments</h1>
          <p className="mt-1 text-sm text-slate-600">
            Track who paid, who owes. Upload a bank CSV to auto-match
            payments to invoices. No payment gateway — CrewFlow tracks
            payments, doesn&apos;t process them.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Outstanding
            </div>
            <div className="text-xl font-semibold text-slate-900">
              {GBP.format(outstandingTotal)}
            </div>
            <div className="text-xs text-slate-500">
              {(outstandingRows ?? []).length} unpaid invoices
            </div>
          </div>
          <Link
            href="/payments/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Record payment
          </Link>
        </div>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {savedMessage}
        </div>
      ) : null}

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">
            Upload bank statement (CSV)
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Most UK banks export a CSV with at least <em>date</em>,{" "}
            <em>amount</em>, <em>description</em>. We auto-match incoming
            payments to outstanding invoices by amount + reference + customer
            name. Anything 70%+ confidence is suggested; you confirm or pick
            a different invoice.
          </p>
          <form
            action={uploadBankCsv}
            encType="multipart/form-data"
            className="mt-4 flex flex-wrap items-end gap-2"
          >
            <input
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="block text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-800"
            />
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Upload + match
            </button>
          </form>
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-6 py-3">
          <h2 className="text-base font-semibold text-slate-900">
            Statement history
          </h2>
        </header>
        {(statements ?? []).length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            No statements uploaded yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {(statements ?? []).map((s) => (
              <li key={s.id} className="flex items-center justify-between px-6 py-3 text-sm">
                <div className="min-w-0">
                  <Link
                    href={`/payments/reconcile/${s.id}`}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {s.filename}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {s.uploaded_at.slice(0, 10)} · {s.line_count} lines
                  </div>
                </div>
                <span className="text-xs text-slate-600">
                  {s.matched_count}/{s.line_count} matched
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
