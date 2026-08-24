import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  updateStaffProfile,
  updateStaffRole,
  removeStaff,
  upsertHolidayEntitlementAction,
  upsertPensionEnrolmentAction,
  upsertPayrollTaxProfileAction,
  addStaffQualification,
  deleteStaffQualification,
} from "../actions";
import { STAFF_ROLES } from "@/lib/staff/schema";
import { StaffProfileForm } from "./_profile-form";
import { HolidayEntitlementForm } from "./_holiday-form";
import { PensionEnrolmentForm } from "./_pension-form";
import { PayrollTaxProfileForm } from "./_payroll-tax-form";
import { AddQualificationForm } from "./_qualifications";
import { ConfirmForm } from "@/components/forms/ConfirmForm";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { readFailure } from "@/lib/supabase/read-failure";
import { getHolidayBalanceForUser } from "@/server/services/holiday-balance";
import { getPensionEnrolment } from "@/server/services/pension-enrolment";
import { getPayrollTaxProfile } from "@/server/services/payroll-tax-profile";
import { DEFAULT_HOLIDAY_ENTITLEMENT } from "@/lib/staff/holiday";
import { listStaffQualifications } from "@/server/services/staff-qualifications";
import { getStaffPerformance } from "@/server/services/staff-performance";
import {
  qualificationExpiryStatus,
  qualificationTypeLabel,
  daysUntil,
  type QualificationExpiryStatus,
} from "@/lib/staff/qualifications";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export default async function StaffDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // (Read deleted upstream — #480's loud-read guard here is obsolete, not lost.)
  // Current user's role — from ctx (own membership in the ACTIVE org); an
  // unfiltered memberships read returns every member's row and `.single()`
  // errors in any org with ≥2 members.
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  // Target row + extended profile.
  const { data: row, error: rowError } = await supabase
    .from("memberships")
    .select(
      `
        role, user_id,
        user:users ( id, full_name, email, phone, employment_type, start_date )
      `,
    )
    .eq("org_id", ctx.org.id)
    .eq("user_id", id)
    .maybeSingle();
  if (rowError) throw readFailure("staff detail: member", rowError);

  if (!row) notFound();

  const user = row.user as {
    id: string;
    full_name: string | null;
    email: string;
    phone: string | null;
    employment_type: string | null;
    start_date: string | null;
  } | null;

  // Pay + emergency contact live in staff_compensation (20261218): the self-or-
  // admin RLS admits an admin viewing any org member, and a member viewing their
  // OWN detail — but not a co-worker's, so a staff member who reaches another's
  // detail page by URL sees pay/emergency as "—".
  const { data: compRow, error: compError } = await supabase
    .from("staff_compensation")
    .select("hourly_pay, emergency_contact")
    .eq("user_id", id)
    .maybeSingle();
  if (compError) throw readFailure("staff detail: compensation", compError);
  const comp = compRow as {
    hourly_pay: number | null;
    emergency_contact: {
      name?: string | null;
      phone?: string | null;
      relationship?: string | null;
    } | null;
  } | null;

  // Holiday balance (derived) + entitlement config, and pension enrolment.
  // Reads are org-pinned inside the services; RLS admits admins across the org.
  const holiday = await getHolidayBalanceForUser(ctx.org.id, id);
  const enrolment = isAdmin ? await getPensionEnrolment(ctx.org.id, id) : null;
  const taxProfile = isAdmin ? await getPayrollTaxProfile(ctx.org.id, id) : null;

  // Competency + performance (loud reads: a failure throws to the error
  // boundary, never a false-empty scorecard). Any org member may read both.
  const [qualifications, performance] = await Promise.all([
    listStaffQualifications(ctx.org.id, id),
    getStaffPerformance(ctx.org.id, id),
  ]);
  const todayIso = new Date().toISOString().slice(0, 10);

  const holidayDefaults = {
    annual_allowance_days: String(
      holiday?.config.annual_allowance_days ??
        DEFAULT_HOLIDAY_ENTITLEMENT.annual_allowance_days,
    ),
    accrual_method:
      holiday?.config.accrual_method ??
      DEFAULT_HOLIDAY_ENTITLEMENT.accrual_method,
    carry_over_max_days: String(
      holiday?.config.carry_over_max_days ??
        DEFAULT_HOLIDAY_ENTITLEMENT.carry_over_max_days,
    ),
    leave_year_start_month: String(
      holiday?.config.leave_year_start_month ??
        DEFAULT_HOLIDAY_ENTITLEMENT.leave_year_start_month,
    ),
    leave_year_start_day: String(
      holiday?.config.leave_year_start_day ??
        DEFAULT_HOLIDAY_ENTITLEMENT.leave_year_start_day,
    ),
  };
  const pctToStr = (n: number | null | undefined): string =>
    n == null ? "" : String(Math.round(n * 1000) / 10);
  const pensionDefaults = {
    status: enrolment?.status ?? "not_enrolled",
    employee_contribution_percent:
      pctToStr(enrolment?.employee_contribution_rate) || "5",
    employer_contribution_percent:
      pctToStr(enrolment?.employer_contribution_rate) || "3",
    scheme_name: enrolment?.scheme_name ?? "",
    assessment_date: enrolment?.assessment_date ?? "",
    enrolment_date: enrolment?.enrolment_date ?? "",
    opt_out_date: enrolment?.opt_out_date ?? "",
    postponement_end_date: enrolment?.postponement_end_date ?? "",
  };
  const payrollTaxDefaults = {
    tax_region: taxProfile?.tax_region ?? "rest_of_uk",
    student_loan_plan: taxProfile?.student_loan_plan ?? "none",
    salary_sacrifice_annual_pounds: taxProfile
      ? String(Math.round(taxProfile.salary_sacrifice_annual_pence) / 100)
      : "0",
    ni_category: taxProfile?.ni_category ?? "A",
    date_of_birth: taxProfile?.date_of_birth ?? "",
    standard_hours_per_day:
      taxProfile?.standard_hours_per_day != null
        ? String(taxProfile.standard_hours_per_day)
        : "",
  };

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/staff" className="hover:text-slate-900">Staff</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900 truncate">
          {user?.full_name ?? user?.email}
        </span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">
            {user?.full_name ?? user?.email}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {user?.email} · role: <strong>{row.role}</strong>
          </p>
        </div>
        {/* De-orphan: the per-person weekly timesheet had no inbound link. */}
        <ButtonLink href={`/staff/${id}/timesheet`} variant="secondary" size="sm">
          View timesheet
        </ButtonLink>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {sp.saved ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Saved.
        </div>
      ) : null}

      {/* Profile form — admin-only edit */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Profile</h2>
        <StaffProfileForm
          action={updateStaffProfile.bind(null, id)}
          isAdmin={isAdmin}
          defaults={{
            full_name: user?.full_name ?? "",
            phone: user?.phone ?? "",
            hourly_pay: comp?.hourly_pay != null ? String(comp.hourly_pay) : "",
            employment_type: user?.employment_type ?? "",
            start_date: user?.start_date ?? "",
            emergency_contact_name: comp?.emergency_contact?.name ?? "",
            emergency_contact_phone: comp?.emergency_contact?.phone ?? "",
            emergency_contact_relationship:
              comp?.emergency_contact?.relationship ?? "",
          }}
        />
      </section>

      {/* Pay summary (read-only mini-tile) */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Pay</h2>
        <p className="mt-2 text-sm text-slate-600">
          Hourly:{" "}
          <strong className="text-slate-900">
            {comp?.hourly_pay != null ? GBP.format(Number(comp.hourly_pay)) : "—"}
          </strong>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Weekly pay is computed from rota hours × hourly pay once rota
          entries exist for this user (Mon–Sun).
        </p>
      </section>

      {/* Performance (read-model, derived from existing ledgers) */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Performance</h2>
        <p className="mt-1 text-xs text-slate-500">
          Derived from this person&rsquo;s own records — jobs assigned to them,
          non-conformance reports they are responsible for, and clocked vs
          rostered hours over the last {performance.utilisation.windowDays} days.
          Not a rating.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <BalanceStat
            label="Jobs assigned"
            value={String(performance.jobs.assigned)}
          />
          <BalanceStat
            label="Completed"
            value={String(performance.jobs.completed)}
          />
          <BalanceStat
            label="On-time"
            value={
              performance.jobs.onTimeRate != null
                ? `${performance.jobs.onTimeRate}%`
                : "—"
            }
            emphasis
          />
          <BalanceStat
            label="Open NCRs"
            value={`${performance.quality.responsibleOpen} / ${performance.quality.responsibleTotal}`}
          />
          <BalanceStat
            label="Hours recorded"
            value={`${performance.utilisation.coverage.recorded} h`}
          />
          <BalanceStat
            label="Coverage"
            value={
              performance.utilisation.coverage.pct != null
                ? `${performance.utilisation.coverage.pct}%`
                : "—"
            }
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {performance.jobs.onTimeRate != null
            ? `On-time is ${performance.jobs.onTime} of ${performance.jobs.measurable} completed jobs that had both a target and a completion date.`
            : `On-time % needs at least a few completed jobs with both a target and a completion date (${performance.jobs.measurable} so far).`}
          {performance.jobs.notMeasurable > 0
            ? ` ${performance.jobs.notMeasurable} completed ${
                performance.jobs.notMeasurable === 1 ? "job is" : "jobs are"
              } not measurable (missing a target or completion date).`
            : ""}
          {performance.utilisation.coverage.pct == null
            ? " Coverage % needs at least a full day of rostered hours in the window."
            : ""}
        </p>
      </section>

      {/* Qualifications / certifications */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Qualifications &amp; certifications
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Cards, tickets and certificates held by this person. Expiring or lapsed
          items surface in the daily briefing, and the rota generator prefers
          people who hold a job&rsquo;s required qualifications.
        </p>
        {qualifications.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">
            No qualifications recorded yet{isAdmin ? " — add one below." : "."}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {qualifications.map((q) => {
              const status = qualificationExpiryStatus(q.expires_on, todayIso);
              return (
                <li
                  key={q.id}
                  className="flex flex-wrap items-start justify-between gap-2 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">
                        {q.title}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                        {qualificationTypeLabel(q.qualification_type)}
                      </span>
                      <ExpiryBadge status={status} expiresOn={q.expires_on} today={todayIso} />
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {q.reference_no ? `Ref ${q.reference_no} · ` : ""}
                      {q.issued_on ? `Issued ${q.issued_on}` : "No issue date"}
                      {q.expires_on ? ` · Expires ${q.expires_on}` : " · No expiry"}
                    </p>
                    {q.notes ? (
                      <p className="mt-1 text-xs text-slate-600">{q.notes}</p>
                    ) : null}
                  </div>
                  {isAdmin ? (
                    <ConfirmForm
                      action={deleteStaffQualification.bind(null, id)}
                      confirm={`Delete "${q.title}"? This cannot be undone.`}
                    >
                      <input type="hidden" name="qualification_id" value={q.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        Delete
                      </button>
                    </ConfirmForm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {isAdmin ? (
          <AddQualificationForm action={addStaffQualification.bind(null, id)} />
        ) : null}
      </section>

      {/* Holiday entitlement + derived balance */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Holiday entitlement
        </h2>
        {holiday ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <BalanceStat
                label="Remaining"
                value={`${holiday.balance.remaining_days} d`}
                emphasis
              />
              <BalanceStat
                label="Allowance"
                value={`${holiday.balance.allowance_days} d`}
              />
              <BalanceStat
                label="Accrued"
                value={`${holiday.balance.accrued_days} d`}
              />
              <BalanceStat
                label="Taken"
                value={`${holiday.balance.taken_days} d`}
              />
              <BalanceStat
                label="Booked (pending)"
                value={`${holiday.balance.booked_days} d`}
              />
              <BalanceStat
                label="Carried over"
                value={`${holiday.balance.carried_over_days} d`}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Leave year {holiday.balance.leave_year_start} →{" "}
              {holiday.balance.leave_year_end}. Days are working days (Mon–Fri).
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            No holiday entitlement configured yet
            {isAdmin ? " — set one below." : "."}
          </p>
        )}
        {isAdmin ? (
          <HolidayEntitlementForm
            action={upsertHolidayEntitlementAction.bind(null, id)}
            defaults={holidayDefaults}
          />
        ) : null}
      </section>

      {/* Pension auto-enrolment (admin only) */}
      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">
            Pension auto-enrolment
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Feeds the payroll employer-cost <strong>estimate</strong>. Filing to
            your pension provider / HMRC is external.
          </p>
          <PensionEnrolmentForm
            action={upsertPensionEnrolmentAction.bind(null, id)}
            defaults={pensionDefaults}
          />
        </section>
      ) : null}

      {/* Payroll tax inputs — income-tax region, student loan, salary sacrifice (admin only) */}
      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Payroll tax inputs</h2>
          <p className="mt-1 text-xs text-slate-500">
            Refines this employee&apos;s take-home <strong>estimate</strong> on payroll
            runs. Defaults leave pay unchanged.
          </p>
          <PayrollTaxProfileForm
            action={upsertPayrollTaxProfileAction.bind(null, id)}
            defaults={payrollTaxDefaults}
          />
        </section>
      ) : null}

      {/* Role + remove (admin only) */}
      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Role</h2>
          <form action={updateStaffRole.bind(null, id)} className="mt-3 flex items-end gap-2">
            <label className="block text-xs text-slate-600">
              Role
              <select
                name="role"
                defaultValue={row.role}
                className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {STAFF_ROLES.filter((r) => r !== "owner").map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
                {row.role === "owner" ? <option value="owner">owner</option> : null}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              disabled={row.role === "owner"}
              title={row.role === "owner" ? "Owner role can't be changed here" : "Update role"}
            >
              Update
            </button>
          </form>
        </section>
      ) : null}

      <AttachmentsPanel targetTable="memberships" targetId={id} />

      {isAdmin && row.role !== "owner" ? (
        <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
          <p className="text-sm font-medium text-red-900">Remove from organisation</p>
          <p className="mt-1 text-xs text-red-700">
            This removes their access. Their historical job assignments + rota
            entries stay (the user record persists).
          </p>
          <ConfirmForm
            action={removeStaff.bind(null, id)}
            confirm={`Remove ${row.user?.full_name ?? row.user?.email ?? "this staff member"} from the organisation? Their historical assignments stay but they lose access immediately.`}
            className="mt-3"
          >
            <button
              type="submit"
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Remove
            </button>
          </ConfirmForm>
        </section>
      ) : null}
    </div>
  );
}

function ExpiryBadge({
  status,
  expiresOn,
  today,
}: {
  status: QualificationExpiryStatus;
  expiresOn: string | null;
  today: string;
}) {
  if (status === "no_expiry" || status === "valid") return null;
  const days = expiresOn ? daysUntil(expiresOn, today) : null;
  if (status === "expired") {
    return (
      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">
        Expired{days != null ? ` ${Math.abs(days)}d ago` : ""}
      </span>
    );
  }
  return (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">
      Expiring{days != null ? ` in ${days}d` : " soon"}
    </span>
  );
}

function BalanceStat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={
          emphasis
            ? "mt-1 text-xl font-bold text-slate-900"
            : "mt-1 text-base font-semibold text-slate-800"
        }
      >
        {value}
      </div>
    </div>
  );
}

