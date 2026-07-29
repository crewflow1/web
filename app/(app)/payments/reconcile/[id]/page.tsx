import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { confirmBankMatch, ignoreBankLine } from "../../actions";
import { StateForm } from "@/components/forms/StateForm";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type SP = Promise<{ error?: string; saved?: string }>;

export default async function ReconcilePage({
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

  const [{ data: statement }, { data: lines }, { data: invoices }] = await Promise.all([
    supabase
      .from("bank_statements")
      .select("id, filename, uploaded_at, line_count, matched_count")
      .eq("id", id)
      // ACTIVE-org pin — this page offers "match this line to this invoice",
      // so the statement, its lines and the candidate invoices must all be one
      // company's. Pinning the statement makes the line read (keyed on
      // bank_statement_id) derived-safe; the invoice list is pinned directly.
      .eq("org_id", ctx.org.id)
      .maybeSingle(),
    supabase
      .from("bank_statement_lines")
      .select(
        "id, posted_at, amount, description, reference, matched_invoice_id, matched_payment_id, match_confidence, match_status",
      )
      .eq("bank_statement_id", id)
      .order("posted_at", { ascending: false }),
    supabase
      .from("invoices")
      .select("id, number, total, status")
      .eq("org_id", ctx.org.id)
      .in("status", ["sent", "awaiting_payment", "partially_paid", "overdue"]),
  ]);

  if (!statement) notFound();

  const invoicesById = new Map<string, { number: string; total: number; status: string }>();
  for (const i of invoices ?? []) {
    invoicesById.set(i.id, {
      number: i.number,
      total: Number(i.total ?? 0),
      status: i.status,
    });
  }

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved
    ? sp.saved === "matched"
      ? "Match confirmed — invoice payment recorded."
      : sp.saved === "ignored"
        ? "Line ignored."
        : sp.saved === "uploaded"
          ? "Statement uploaded — review matches below."
          : null
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/payments" className="hover:text-slate-900">Payments</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900 truncate">{statement.filename}</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">
          Reconcile · {statement.filename}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {statement.line_count} lines · {statement.matched_count} matched ·
          uploaded {statement.uploaded_at.slice(0, 10)}
        </p>
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

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Suggested match</th>
                <th className="px-4 py-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(lines ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-4 text-center text-sm text-slate-500">
                    No lines on this statement.
                  </td>
                </tr>
              ) : null}
              {(lines ?? []).map((l) => {
                const matched = l.matched_invoice_id
                  ? invoicesById.get(l.matched_invoice_id)
                  : null;
                const isIncoming = Number(l.amount) > 0;
                return (
                  <tr key={l.id}>
                    <td className="px-4 py-2 text-slate-700">{l.posted_at}</td>
                    <td className="px-4 py-2">
                      <div className="text-slate-900">{l.description ?? "—"}</div>
                      {l.reference ? (
                        <div className="text-xs text-slate-500">ref: {l.reference}</div>
                      ) : null}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-medium ${isIncoming ? "text-green-700" : "text-slate-500"}`}
                    >
                      {isIncoming ? "+" : ""}{GBP.format(Number(l.amount))}
                    </td>
                    <td className="px-4 py-2">
                      {l.match_status === "confirmed" ? (
                        <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">
                          confirmed{matched ? ` · ${matched.number}` : ""}
                        </span>
                      ) : l.match_status === "ignored" ? (
                        <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                          ignored
                        </span>
                      ) : l.match_status === "suggested" && matched ? (
                        <div className="text-xs">
                          <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                            {matched.number} · {l.match_confidence}%
                          </span>
                          <div className="mt-0.5 text-slate-500">{GBP.format(matched.total)}</div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">
                          {isIncoming ? "no match found" : "outgoing — skip"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {isIncoming && l.match_status !== "confirmed" && l.match_status !== "ignored" ? (
                        <div className="flex flex-col items-end gap-1">
                          <StateForm action={confirmBankMatch.bind(null, l.id)} className="flex items-center gap-1">
                            <select
                              name="invoice_id"
                              defaultValue={l.matched_invoice_id ?? ""}
                              required
                              className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs"
                            >
                              <option value="">— pick invoice —</option>
                              {(invoices ?? []).map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.number} · {GBP.format(Number(i.total))}
                                </option>
                              ))}
                            </select>
                            <button
                              type="submit"
                              className="rounded-md border border-green-300 bg-white px-2 py-0.5 text-xs font-medium text-green-700 hover:bg-green-50"
                            >
                              Confirm
                            </button>
                          </StateForm>
                          <StateForm action={ignoreBankLine.bind(null, l.id)}>
                            <button
                              type="submit"
                              className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Ignore
                            </button>
                          </StateForm>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
