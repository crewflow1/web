import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { finalisePayrollRun, deletePayrollRun } from "../actions";
import { fetchNiNumbersForOrg, maskNiNumber } from "@/lib/staff/secrets";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type SP = Promise<{ error?: string; saved?: string }>;

export default async function PayrollRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return (
      <p className="text-sm text-slate-700">
        Payroll detail is admin-only. Visit{" "}
        <Link href="/me" className="font-medium underline">
          your dashboard
        </Link>
        .
      </p>
    );
  }
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: run }, { data: linesRaw }] = await Promise.all([
    supabase
      .from("payroll_runs")
      .select("id, cycle, period_start, period_end, status, finalised_at, created_at")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("payroll_lines")
      .select(
        `
          id, user_id, hours, hourly_pay, gross_pay, paye_estimate, ni_estimate, net_pay, note,
          user:users ( full_name, email )
        `,
      )
      .eq("payroll_run_id", id)
      .order("gross_pay", { ascending: false }),
  ]);

  if (!run) notFound();
  // Per-user NI numbers, sourced from the admin-gated staff_secrets table.
  const niByUser = await fetchNiNumbersForOrg(ctx.org.id);
  const lines = linesRaw ?? [];

  const totals = lines.reduce(
    (acc, l) => {
      acc.hours += Number(l.hours ?? 0);
      acc.gross += Number(l.gross_pay ?? 0);
      acc.paye += Number(l.paye_estimate ?? 0);
      acc.ni += Number(l.ni_estimate ?? 0);
      acc.net += Number(l.net_pay ?? 0);
      return acc;
    },
    { hours: 0, gross: 0, paye: 0, ni: 0, net: 0 },
  );

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved
    ? sp.saved === "finalised"
      ? "Run finalised. Time entries are now locked."
      : sp.saved === "created"
        ? "Draft created."
        : null
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/payroll" className="hover:text-slate-900">Payroll</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">
          {run.cycle} · {run.period_start} → {run.period_end}
        </span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {run.cycle === "weekly" ? "Weekly" : "Monthly"} payroll
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {run.period_start} → {run.period_end} ·{" "}
            <span
              className={
                run.status === "finalised"
                  ? "inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800"
                  : "inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
              }
            >
              {run.status}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/payroll/${run.id}/csv`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Export CSV
          </a>
          {run.status === "draft" ? (
            <>
              <form action={finalisePayrollRun.bind(null, run.id)}>
                <button
                  type="submit"
                  className="rounded-md border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100"
                >
                  Finalise run
                </button>
              </form>
              <form action={deletePayrollRun.bind(null, run.id)}>
                <button
                  type="submit"
                  className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  Delete draft
                </button>
              </form>
            </>
          ) : null}
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

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Hours" value={totals.hours.toFixed(2)} />
        <Stat label="Gross" value={GBP.format(totals.gross)} />
        <Stat label="PAYE est" value={GBP.format(totals.paye)} />
        <Stat label="NI est" value={GBP.format(totals.ni)} />
        <Stat label="Net" value={GBP.format(totals.net)} emphasis />
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">NI no.</th>
                <th className="px-4 py-2 text-right">Hours</th>
                <th className="px-4 py-2 text-right">£/h</th>
                <th className="px-4 py-2 text-right">Gross</th>
                <th className="px-4 py-2 text-right">PAYE</th>
                <th className="px-4 py-2 text-right">NI</th>
                <th className="px-4 py-2 text-right">Net</th>
                <th className="px-4 py-2 text-right">Payslip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-slate-500">
                    No staff had hours logged in this period.
                  </td>
                </tr>
              ) : null}
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2 font-medium text-slate-900">
                    {l.user?.full_name ?? l.user?.email ?? l.user_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2 text-slate-500 text-xs">
                    {maskNiNumber(niByUser.get(l.user_id) ?? null)}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-700">{Number(l.hours).toFixed(2)}</td>
                  <td className="px-4 py-2 text-right text-slate-700">{GBP.format(Number(l.hourly_pay ?? 0))}</td>
                  <td className="px-4 py-2 text-right font-medium text-slate-900">
                    {GBP.format(Number(l.gross_pay ?? 0))}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {GBP.format(Number(l.paye_estimate ?? 0))}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {GBP.format(Number(l.ni_estimate ?? 0))}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-900">
                    {GBP.format(Number(l.net_pay ?? 0))}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <a
                      href={`/api/payroll/lines/${l.id}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-slate-700 hover:underline"
                    >
                      PDF
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-slate-500">
        PAYE + NI shown here are <strong>estimates</strong> based on standard
        1257L tax code and 2025-26 thresholds. Confirm with your accountant
        or HMRC&apos;s Basic PAYE Tools before submitting RTI.
      </p>
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={emphasis ? "mt-1 text-2xl font-bold text-slate-900" : "mt-1 text-lg font-semibold text-slate-900"}>
        {value}
      </div>
    </div>
  );
}
