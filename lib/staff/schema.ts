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
