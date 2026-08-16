import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import { finalisePayrollRun, deletePayrollRun } from "../actions";
import { fetchNiNumbersForOrg, maskNiNumber } from "@/lib/staff/secrets";
import {
  employerCostsForStoredLineWithPension,
  computeEmployeeDeductionsForStoredLine,
  employeeInputFromStoredProfile,
  employmentAllowanceReliefForRun,
  type EmployerCostEstimate,
  type EmployeeDeductionsEstimate,
} from "@/lib/payroll/compute";
import {
  buildPayrollInsights,
  type CurrentLine,
  type HistoricalRun,
} from "@/lib/payroll/insights";
import {
  getPensionEnrolmentsForOrg,
  getEmployeePensionRatesForOrg,
} from "@/server/services/pension-enrolment";
import { getPayrollTaxProfilesForOrg } from "@/server/services/payroll-tax-profile";

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

  const [
    { data: run, error: runError },
    { data: linesRaw, error: linesError },
  ] = await Promise.all([
    supabase
      .from("payroll_runs")
      .select("id, cycle, period_start, period_end, status, finalised_at, created_at")
      .eq("id", id)
      // ACTIVE-org pin — `payroll_runs: admin all` is `is_org_admin(org_id)`,
      // which a dual-org OWNER satisfies for BOTH orgs. Pinning the run also
      // makes the payroll_lines read below (keyed on payroll_run_id)
      // derived-safe, so the other company's pay never renders here.
      .eq("org_id", ctx.org.id)
      .maybeSingle(),
    // PAGED (F-1). These lines are reduced into the on-screen run totals below;
    // a bare `.select()` truncates at the 1000-row PostgREST cap, so a large
    // run's Gross/PAYE/NI/Net totals would silently under-report. `fetchAllRows`
    // pages under the cap. The run is org-pinned above, so keying on
    // `payroll_run_id` keeps this derived-safe; `id` asc is the unique tiebreak
    // that keeps rows from shifting across page boundaries (display stays
    // gross-desc, the primary sort).
    fetchAllRows((from, to) =>
      supabase
        .from("payroll_lines")
        .select(
          `
            id, user_id, hours, hourly_pay, gross_pay, paye_estimate, ni_estimate, net_pay, note,
            user:users ( full_name, email )
          `,
        )
        .eq("payroll_run_id", id)
        .order("gross_pay", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  // A rejected read must not masquerade as a missing run, and a failed lines
  // read must not render a £0.00 payroll over real pay.
  if (runError) throw readFailure("payroll run: run", runError);
  if (!run) notFound();
  if (linesError) throw readFailure("payroll run: lines", linesError);
  // Per-user NI numbers, sourced from the admin-gated staff_secrets table.
  const niByUser = await fetchNiNumbersForOrg(ctx.org.id);
  // Tracked pension enrolments — where an employee's auto-enrolment is recorded,
  // the employer pension estimate uses their real status + scheme rate instead
  // of the blanket statutory 3%. Empty map ⇒ every line uses the statutory
  // estimate (unchanged). Org-pinned read inside the service.
  const pensionByUser = await getPensionEnrolmentsForOrg(ctx.org.id);
  // Employee pension CONTRIBUTION rates (enrolled staff only) — recorded on the
  // staff profile but, until now, never applied to take-home pay. Where present,
  // the employee's contribution is deducted from net as a relief-at-source estimate.
  const employeePensionRates = await getEmployeePensionRatesForOrg(ctx.org.id);
  // Per-employee tax inputs (region, student-loan plan, salary sacrifice), set on the
  // staff profile. Absent ⇒ base figures (rest-of-UK / no loan / no sacrifice).
  const taxProfiles = await getPayrollTaxProfilesForOrg(ctx.org.id);
  const lines = linesRaw ?? [];

  // -----------------------------------------------------------------
  // Prior-run history for the deterministic Payroll insights layer.
  // Org-pinned + LOUD: a failed read must not render a "no anomalies"
  // panel over real data. Bounded to the most recent runs (enough for a
  // median) and paged so a large run's lines are never silently capped.
  // -----------------------------------------------------------------
  const HISTORY_RUNS = 6;
  const { data: priorRuns, error: priorRunsError } = await supabase
    .from("payroll_runs")
    .select("id, period_start")
    .eq("org_id", ctx.org.id)
    .lt("period_start", run.period_start)
    .order("period_start", { ascending: false })
    .limit(HISTORY_RUNS);
  if (priorRunsError) throw readFailure("payroll run: prior runs", priorRunsError);
  const priorRunIds = (priorRuns ?? []).map((r) => r.id);
  let history: HistoricalRun[] = [];
  if (priorRunIds.length > 0) {
    const { data: histLines, error: histLinesError } = await fetchAllRows<{
      payroll_run_id: string;
      user_id: string;
      hours: number | string | null;
      gross_pay: number | string | null;
    }>((from, to) =>
      supabase
        .from("payroll_lines")
        .select("payroll_run_id, user_id, hours, gross_pay")
        // Org-pinned; the run ids came from an org-pinned read above, so this is
        // derived-safe and never reaches another company's lines.
        .eq("org_id", ctx.org.id)
        .in("payroll_run_id", priorRunIds)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (histLinesError) throw readFailure("payroll run: history lines", histLinesError);
    const startById = new Map((priorRuns ?? []).map((r) => [r.id, r.period_start]));
    const byRun = new Map<string, HistoricalRun>();
    for (const hl of histLines ?? []) {
      let hr = byRun.get(hl.payroll_run_id);
      if (!hr) {
        hr = {
          run_id: hl.payroll_run_id,
          period_start: startById.get(hl.payroll_run_id) ?? "",
          lines: [],
        };
        byRun.set(hl.payroll_run_id, hr);
      }
      hr.lines.push({
        user_id: hl.user_id,
        hours: Number(hl.hours ?? 0),
        gross_pay: Number(hl.gross_pay ?? 0),
      });
    }
    history = Array.from(byRun.values());
  }

  // Employer NI + pension per line, DERIVED from the stored gross at the rates in
  // force for this run's own period. Employer cost is a cost to the BUSINESS, never
  // a deduction from the worker — it is shown alongside net pay, never inside it.
  const runCycle = run.cycle === "weekly" ? "weekly" : "monthly";
  const employerByLine = new Map<string, EmployerCostEstimate>();
  for (const l of lines) {
    employerByLine.set(
      l.id,
      employerCostsForStoredLineWithPension(
        l.gross_pay,
        runCycle,
        run.period_start,
        pensionByUser.get(l.user_id),
      ),
    );
  }
  // Employee-side deductions DERIVED from the stored gross. Today the only tracked
  // per-employee input is the pension contribution rate (enrolled staff); tax region,
  // student-loan plan and salary sacrifice are not yet stored, so those inputs are
  // absent and the overlay reproduces the stored PAYE/NI/net exactly for everyone
  // else. Where a pension rate exists, take-home drops by the employee contribution.
  const employeeByLine = new Map<string, EmployeeDeductionsEstimate>();
  for (const l of lines) {
    employeeByLine.set(
      l.id,
      computeEmployeeDeductionsForStoredLine(l.gross_pay, runCycle, run.period_start, {
        ...employeeInputFromStoredProfile(taxProfiles.get(l.user_id)),
        employeePensionRate: employeePensionRates.get(l.user_id),
      }),
    );
  }
  const employeePensionTracked = lines.filter((l) =>
    employeePensionRates.has(l.user_id),
  ).length;
  // Employees whose take-home differs from the stored net because a fidelity input
  // (region, student loan, sacrifice, or pension) actually applied to them.
  const fidelityApplied = lines.filter((l) => {
    const d = employeeByLine.get(l.id);
    return d ? Math.abs(d.net_pay - Number(l.net_pay ?? 0)) >= 0.005 : false;
  }).length;

  const trackedEnrolments = lines.filter((l) =>
    pensionByUser.has(l.user_id),
  ).length;
  const ratesTaxYear =
    employerByLine.values().next().value?.employer_rates_tax_year ?? null;
  const ratesExtrapolated = Array.from(employerByLine.values()).some(
    (e) => e.employer_rates_extrapolated,
  );

  const totals = lines.reduce(
    (acc, l) => {
      acc.hours += Number(l.hours ?? 0);
      acc.gross += Number(l.gross_pay ?? 0);
      acc.paye += Number(l.paye_estimate ?? 0);
      acc.ni += Number(l.ni_estimate ?? 0);
      acc.net += Number(l.net_pay ?? 0);
      const emp = employerByLine.get(l.id);
      acc.employerNi += emp?.employer_ni_estimate ?? 0;
      acc.employerPension += emp?.employer_pension_estimate ?? 0;
      acc.employmentCost += emp?.employment_cost_estimate ?? 0;
      const ded = employeeByLine.get(l.id);
      acc.employeePension += ded?.employee_pension_estimate ?? 0;
      acc.takeHome += ded?.net_pay ?? Number(l.net_pay ?? 0);
      return acc;
    },
    {
      hours: 0,
      gross: 0,
      paye: 0,
      ni: 0,
      net: 0,
      employerNi: 0,
      employerPension: 0,
      employmentCost: 0,
      employeePension: 0,
      takeHome: 0,
    },
  );

  // Employment Allowance — an org-level annual offset against the employer NI bill.
  // Shown as an "up to" estimate for this run: we don't track YTD consumption or
  // eligibility, so it is presented conditionally, never silently applied.
  const eaRelief = employmentAllowanceReliefForRun(totals.employerNi, run.period_start);

  // Deterministic Payroll insights — pure over the current lines + prior runs.
  const insightLines: CurrentLine[] = lines.map((l) => ({
    user_id: l.user_id,
    subject: l.user?.full_name ?? l.user?.email ?? l.user_id.slice(0, 8),
    hours: Number(l.hours ?? 0),
    gross_pay: Number(l.gross_pay ?? 0),
  }));
  const insights = buildPayrollInsights({
    cycle: run.cycle,
    period_start: run.period_start,
    period_end: run.period_end,
    current: insightLines,
    history,
  });

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

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Payroll insights</h2>
          <span className="text-[11px] text-slate-400">
            Deterministic checks · no AI model
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-700">{insights.summary.detail}</p>
        {insights.insights.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No anomalies flagged against the last {history.length} run(s).
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {insights.insights.map((ins, i) => (
              <li
                key={`${ins.code}-${ins.user_id ?? i}`}
                className={
                  ins.severity === "warning"
                    ? "rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                    : "rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      ins.severity === "warning"
                        ? "inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                        : "inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                    }
                  >
                    {ins.severity === "warning" ? "Check" : "Info"}
                  </span>
                  <span className="text-sm font-medium text-slate-900">{ins.title}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">{ins.detail}</p>
                <p className="mt-0.5 text-xs text-slate-500">{ins.reasoning}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Hours" value={totals.hours.toFixed(2)} />
        <Stat label="Gross" value={GBP.format(totals.gross)} />
        <Stat label="PAYE est" value={GBP.format(totals.paye)} />
        <Stat label="Employee NI est" value={GBP.format(totals.ni)} />
        <Stat label="Net" value={GBP.format(totals.net)} emphasis />
      </section>

      {fidelityApplied > 0 ? (
        <section className="space-y-2">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat
              label="Employee pension est"
              value={GBP.format(totals.employeePension)}
            />
            <Stat label="Take-home est" value={GBP.format(totals.takeHome)} emphasis />
          </div>
          <p className="text-xs text-slate-500">
            Take-home refines net pay with the per-employee tax inputs set on staff
            profiles — Scottish income-tax bands, student-loan repayments, salary
            sacrifice and the employee&apos;s own pension contribution — for{" "}
            {fidelityApplied} employee(s) this run
            {employeePensionTracked > 0
              ? ` (${employeePensionTracked} with a pension contribution, estimated relief-at-source)`
              : ""}
            . Salary sacrifice reduces the PAYE/NI base; pension and student loan reduce
            take-home only. Everyone without inputs set has take-home equal to net pay.
          </p>
        </section>
      ) : null}

      {/* Employer-side cost of employment — on TOP of gross, never deducted from
          the worker. This is the figure job costing charges as labour. */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Employer NI est" value={GBP.format(totals.employerNi)} />
        <Stat
          label="Employer pension est"
          value={GBP.format(totals.employerPension)}
        />
        <Stat
          label="Employer NI after allowance"
          value={GBP.format(eaRelief.employer_ni_after)}
        />
        <Stat
          label="Total employment cost est"
          value={GBP.format(totals.employmentCost)}
          emphasis
        />
      </section>
      <p className="text-xs text-slate-500">
        Employer NI and pension are <strong>estimates</strong> of the cost of
        employing your team — they are paid by the business on top of gross pay, not
        deducted from it, and they are what job costing charges as labour. Employer
        NI is due to HMRC with your PAYE bill; employer pension goes to your pension
        provider.{" "}
        {ratesExtrapolated
          ? `No published rate table exists for this period's tax year yet, so ${ratesTaxYear} rates were projected forward — confirm the current year's figures.`
          : `Based on ${ratesTaxYear} rates.`}{" "}
        The <strong>Employer NI after allowance</strong> tile applies the Employment
        Allowance ({GBP.format(eaRelief.allowance_annual)}/year) as an{" "}
        <strong>up-to</strong> estimate — {GBP.format(eaRelief.relief_this_run)} against
        this run — assuming your org is eligible and has not used the allowance up
        earlier in the year; it is an annual org-level offset, so a later run may find
        it exhausted. Under-21/apprentice/veteran NI categories and pension opt-outs are
        not modelled, so the employer NI figure may be higher than you actually owe.
        Confirm with your accountant before filing or paying.{" "}
        {trackedEnrolments > 0
          ? `Pension for ${trackedEnrolments} employee(s) with a tracked auto-enrolment record uses their recorded status and scheme rate; everyone else uses the statutory 3% estimate.`
          : "Set an employee's pension auto-enrolment on their staff profile to price their contribution (opt-outs included) instead of the statutory 3% estimate."}
      </p>

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
                <th className="px-4 py-2 text-right">Employee NI</th>
                <th className="px-4 py-2 text-right">Net</th>
                <th className="px-4 py-2 text-right">EE pension</th>
                <th className="px-4 py-2 text-right">Take-home</th>
                <th className="px-4 py-2 text-right">Employer cost</th>
                <th className="px-4 py-2 text-right">Payslip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-6 text-center text-sm text-slate-500">
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
                  {/* Employee pension contribution + take-home after it. */}
                  <td className="px-4 py-2 text-right text-slate-700">
                    {GBP.format(
                      employeeByLine.get(l.id)?.employee_pension_estimate ?? 0,
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {GBP.format(
                      employeeByLine.get(l.id)?.net_pay ?? Number(l.net_pay ?? 0),
                    )}
                  </td>
                  {/* Employer NI + pension — the business's cost, on top of gross. */}
                  <td className="px-4 py-2 text-right text-slate-700">
                    {GBP.format(
                      (employerByLine.get(l.id)?.employer_ni_estimate ?? 0) +
                        (employerByLine.get(l.id)?.employer_pension_estimate ?? 0),
                    )}
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
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={emphasis ? "mt-1 truncate text-2xl font-bold text-slate-900" : "mt-1 truncate text-lg font-semibold text-slate-900"}>
        {value}
      </div>
    </div>
  );
}
