import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  employerCostsForStoredLineWithPension,
  computeEmployeeDeductionsForStoredLine,
  employeeInputFromStoredProfile,
  niCategoryFromStoredProfile,
  payrollCsv,
} from "@/lib/payroll/compute";
import { fetchNiNumbersForOrg } from "@/lib/staff/secrets";
import {
  getPensionEnrolmentsForOrg,
  getEmployeePensionRatesForOrg,
} from "@/server/services/pension-enrolment";
import { getPayrollTaxProfilesForOrg } from "@/server/services/payroll-tax-profile";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import * as Sentry from "@sentry/nextjs";

export const runtime = "nodejs";

/**
 * Payroll run as a CSV — admin-only. Columns match the order an accountant
 * or payroll bureau is most likely to want.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: run, error: runError }, { data: lines, error: linesError }, niByUser] = await Promise.all([
    supabase
      .from("payroll_runs")
      .select("cycle, period_start, period_end, org_id")
      .eq("id", id)
      // ACTIVE-ORG PIN (the sibling lines/[id]/pdf idiom): RLS admits every
      // org the caller belongs to, so without this a dual-org admin in org A
      // could export org B's full payroll CSV — names, NI, gross, PAYE, net.
      .eq("org_id", ctx.org.id)
      .maybeSingle(),
    // PAGED (F-1). This CSV feeds an accountant / payroll bureau, so it must
    // carry EVERY line: a bare `.select()` truncates at the 1000-row PostgREST
    // cap, silently dropping employees 1001+ from the bureau file. `fetchAllRows`
    // pages under the cap; `id` asc is the unique tiebreak so no row is dropped
    // or repeated at a page boundary (display order stays gross-desc).
    fetchAllRows((from, to) =>
      supabase
        .from("payroll_lines")
        .select(
          `
            user_id, hours, hourly_pay, gross_pay, paye_estimate, ni_estimate, net_pay,
            overtime_hours, overtime_pay, leave_hours, leave_pay,
            user:users ( full_name )
          `,
        )
        .eq("payroll_run_id", id)
        .eq("org_id", ctx.org.id)
        .order("gross_pay", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchNiNumbersForOrg(ctx.org.id),
  ]);

  // A Promise.all array destructure quietly discards `error`. It did here: a
  // failed `payroll_lines` read exported a HEADER-ONLY payroll CSV — a file an
  // accountant or bureau would reasonably read as "nobody was paid this
  // period" and file on. 500 instead; a missing download is recoverable, a
  // wrong one that reaches a payroll bureau is not.
  if (runError) {
    Sentry.captureException(readFailure("payroll csv: run", runError));
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
  if (linesError) {
    Sentry.captureException(readFailure("payroll csv: lines", linesError));
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cycle = run.cycle === "weekly" ? "weekly" : "monthly";
  // Tracked pension enrolments — where present, the employer pension estimate
  // uses the employee's real status + scheme rate; otherwise the statutory 3%.
  // Empty map ⇒ output identical to the statutory-only path.
  const pensionByUser = await getPensionEnrolmentsForOrg(ctx.org.id);
  // Per-employee tax inputs (region, student-loan plan, salary sacrifice) and the
  // employee pension CONTRIBUTION rate — the same sources the run detail page uses.
  // Absent ⇒ the base per-line figures, so a non-profiled employee's PAYE/NI/net are
  // byte-identical to what was stored (backward compatible).
  const taxProfiles = await getPayrollTaxProfilesForOrg(ctx.org.id);
  const employeePensionRates = await getEmployeePensionRatesForOrg(ctx.org.id);
  const csv = payrollCsv(
    (lines ?? []).map((l) => {
      const profileInput = employeeInputFromStoredProfile(taxProfiles.get(l.user_id));
      // Employee-side figures refined by the per-employee tax profile: Scottish bands,
      // student loan, salary sacrifice and the employee's own pension contribution.
      // With no profile this reproduces the stored PAYE/NI/net exactly.
      const employee = computeEmployeeDeductionsForStoredLine(
        l.gross_pay,
        cycle,
        run.period_start,
        {
          ...profileInput,
          employeePensionRate: employeePensionRates.get(l.user_id),
        },
      );
      return {
        full_name: l.user?.full_name ?? "—",
        ni_number: niByUser.get(l.user_id) ?? null,
        hours: Number(l.hours ?? 0),
        hourly_pay: Number(l.hourly_pay ?? 0),
        gross_pay: Number(l.gross_pay ?? 0),
        paye_estimate: employee.paye_estimate,
        ni_estimate: employee.ni_estimate,
        salary_sacrifice: employee.salary_sacrifice,
        student_loan_estimate: employee.student_loan_estimate,
        employee_pension_estimate: employee.employee_pension_estimate,
        net_pay: employee.net_pay,
        // Overtime + holiday breakdown of the stored gross (appended CSV columns).
        overtime_hours: Number(l.overtime_hours ?? 0),
        overtime_pay: Number(l.overtime_pay ?? 0),
        holiday_hours: Number(l.leave_hours ?? 0),
        holiday_pay: Number(l.leave_pay ?? 0),
        // Employer NI + pension, DERIVED from the stored gross at the rates in force
        // for this run's own period (never today's), through the one shared helper,
        // honouring the employee's tracked pension enrolment, salary sacrifice
        // (outside the employer NI + pension base) AND their NI category letter
        // (H/M/V/Z pay 0% employer NI up to the Upper Secondary Threshold).
        ...employerCostsForStoredLineWithPension(
          l.gross_pay,
          cycle,
          run.period_start,
          pensionByUser.get(l.user_id),
          profileInput.salarySacrificeAnnual,
          niCategoryFromStoredProfile(taxProfiles.get(l.user_id)),
        ),
      };
    }),
    { period_start: run.period_start, period_end: run.period_end, cycle: run.cycle },
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${run.cycle}-${run.period_start}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
