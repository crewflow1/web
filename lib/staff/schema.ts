/**
 * Shared schema for staff / rota / leave-request forms.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

// Roles model. 'owner' is created during onboarding (cannot be set via UI).
// 'admin' and 'staff' are the assignable roles.
export const STAFF_ROLES = ["owner", "admin", "staff"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const EMPLOYMENT_TYPES = [
  "employee",
  "self_employed",
  "contractor",
  "apprentice",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const LEAVE_TYPES = ["holiday", "sick", "emergency", "unpaid"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const optionalDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
);

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const datetimeLocal = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    "Use ISO local datetime",
  );

// -------------------------------------------------------------------------
// Staff profile update — admin-only fields
// -------------------------------------------------------------------------
export const updateStaffProfileSchema = z.object({
  full_name: optionalString(200),
  phone: optionalString(40),
  hourly_pay: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().min(0).max(1000).optional(),
  ),
  employment_type: z
    .enum(EMPLOYMENT_TYPES)
    .or(z.literal(""))
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  start_date: optionalDate,
  emergency_contact_name: optionalString(200),
  emergency_contact_phone: optionalString(40),
  emergency_contact_relationship: optionalString(80),
});
export type UpdateStaffProfileInput = z.infer<typeof updateStaffProfileSchema>;

// -------------------------------------------------------------------------
// Invite-staff form. Email is the identity; the rest is optional pre-fill
// that auto-populates the user's profile after they accept the invite.
// -------------------------------------------------------------------------
export const inviteStaffSchema = z.object({
  full_name: optionalString(200),
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.string().email("Enter a valid email"),
  ),
  // UI shows Owner/Admin/Staff but Owner is rejected by the action.
  // Only the onboarding flow assigns owner role.
  role: z.enum(STAFF_ROLES, { errorMap: () => ({ message: "Pick a role" }) }),
  // Personal phone (separate from emergency_contact_phone) — pre-fill
  // that lands on users.phone after they accept the invite.
  phone: optionalString(40),
  employment_type: z
    .enum(EMPLOYMENT_TYPES)
    .or(z.literal(""))
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  hourly_pay: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().min(0).max(1000).optional(),
  ),
  emergency_contact_name: optionalString(200),
  emergency_contact_phone: optionalString(40),
  emergency_contact_relationship: optionalString(80),
});
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;

// -------------------------------------------------------------------------
// Membership / role change
// -------------------------------------------------------------------------
export const updateStaffRoleSchema = z.object({
  role: z.enum(STAFF_ROLES),
});

// -------------------------------------------------------------------------
// Rota entry create / update
// -------------------------------------------------------------------------
export const rotaEntryFormSchema = z.object({
  user_id: z.string().uuid("Pick a staff member"),
  starts_at: datetimeLocal,
  ends_at: datetimeLocal,
  job_id: z
    .string()
    .uuid()
    .or(z.literal(""))
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  notes: optionalString(1000),
});
export type RotaEntryFormInput = z.infer<typeof rotaEntryFormSchema>;

// -------------------------------------------------------------------------
// Leave request create
// -------------------------------------------------------------------------
export const leaveRequestFormSchema = z
  .object({
    type: z.enum(LEAVE_TYPES),
    starts_at: date,
    ends_at: date,
    reason: optionalString(2000),
  })
  .refine((v) => v.ends_at >= v.starts_at, {
    message: "End date must be on or after start date",
    path: ["ends_at"],
  });
export type LeaveRequestFormInput = z.infer<typeof leaveRequestFormSchema>;

// -------------------------------------------------------------------------
// Holiday entitlement config (admin-only) — mirrors holiday_entitlements.
// -------------------------------------------------------------------------
export const ACCRUAL_METHODS = ["immediate", "monthly"] as const;
export type AccrualMethodInput = (typeof ACCRUAL_METHODS)[number];

const nonNegDays = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().min(0).max(max),
  );

export const holidayEntitlementFormSchema = z.object({
  annual_allowance_days: nonNegDays(366),
  accrual_method: z.enum(ACCRUAL_METHODS),
  carry_over_max_days: nonNegDays(366),
  leave_year_start_month: z.coerce.number().int().min(1).max(12),
  leave_year_start_day: z.coerce.number().int().min(1).max(31),
});
export type HolidayEntitlementFormInput = z.infer<
  typeof holidayEntitlementFormSchema
>;

// -------------------------------------------------------------------------
// Pension auto-enrolment (admin-only) — mirrors pension_enrolments.
// Contribution rates are entered as PERCENTAGES in the UI and stored as
// fractions; the action divides by 100.
// -------------------------------------------------------------------------
export const PENSION_STATUSES = [
  "not_enrolled",
  "enrolled",
  "opted_out",
  "postponed",
] as const;
export type PensionStatusInput = (typeof PENSION_STATUSES)[number];

const percent = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.coerce.number().min(0).max(100),
);

export const pensionEnrolmentFormSchema = z.object({
  status: z.enum(PENSION_STATUSES),
  employee_contribution_percent: percent,
  employer_contribution_percent: percent,
  scheme_name: optionalString(120),
  assessment_date: optionalDate,
  enrolment_date: optionalDate,
  opt_out_date: optionalDate,
  postponement_end_date: optionalDate,
});
export type PensionEnrolmentFormInput = z.infer<
  typeof pensionEnrolmentFormSchema
>;

// -------------------------------------------------------------------------
// Payroll tax inputs (income-tax region, student loan, salary sacrifice)
// -------------------------------------------------------------------------

export const TAX_REGIONS = ["rest_of_uk", "scotland"] as const;
export type TaxRegionInput = (typeof TAX_REGIONS)[number];

export const STUDENT_LOAN_PLANS = [
  "none",
  "plan_1",
  "plan_2",
  "plan_4",
  "plan_5",
  "postgraduate",
] as const;
export type StudentLoanPlanInput = (typeof STUDENT_LOAN_PLANS)[number];

/** Annual salary sacrifice, entered in POUNDS (0..1,000,000), empty ⇒ 0. */
const salarySacrificePounds = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? 0 : v),
  z.coerce.number().min(0).max(1_000_000),
);

/** Employer-NI category letters. 'A' is the standard-rate default. */
export const NI_CATEGORIES = [
  "A",
  "B",
  "C",
  "J",
  "H",
  "M",
  "V",
  "Z",
] as const;
export type NiCategoryInput = (typeof NI_CATEGORIES)[number];

/** Contracted hours per working day (0..24). Empty ⇒ undefined (no holiday pay). */
const standardHoursPerDay = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.coerce.number().min(0).max(24).optional(),
);

export const payrollTaxProfileFormSchema = z.object({
  tax_region: z.enum(TAX_REGIONS),
  student_loan_plan: z.enum(STUDENT_LOAN_PLANS),
  salary_sacrifice_annual_pounds: salarySacrificePounds,
  ni_category: z.enum(NI_CATEGORIES),
  date_of_birth: optionalDate,
  standard_hours_per_day: standardHoursPerDay,
});
export type PayrollTaxProfileFormInput = z.infer<
  typeof payrollTaxProfileFormSchema
>;

// -------------------------------------------------------------------------
// Conflict detection
// -------------------------------------------------------------------------
type Interval = { starts_at: string; ends_at: string };

/** Returns true if two timestamp-bounded intervals overlap. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return (
    new Date(a.starts_at).getTime() < new Date(b.ends_at).getTime() &&
    new Date(b.starts_at).getTime() < new Date(a.ends_at).getTime()
  );
}

/** Returns the indexes (in `existing`) that conflict with `candidate`. */
export function findRotaConflicts<T extends Interval>(
  candidate: Interval,
  existing: T[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < existing.length; i++) {
    if (intervalsOverlap(candidate, existing[i]!)) out.push(i);
  }
  return out;
}
