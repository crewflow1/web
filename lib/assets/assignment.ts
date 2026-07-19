import { z } from "zod";

/**
 * Asset assignment (custody) — shared domain constants, rules + validation.
 *
 * Pure module (no I/O), unit-tested. Custody is distinct from the asset's
 * lifecycle status: this governs who holds an asset and its history. The DB
 * enforces the single-open-assignment invariant + same-org/eligibility guard
 * (20260925000000); these mirror the allowed values and translate the DB's
 * violations into construction-language errors.
 */

export const ASSIGNMENT_TYPES = [
  "issued_to_staff",
  "allocated_to_job",
  "stored_at_depot",
  "loaded_on_vehicle",
  "sent_for_repair",
  "returned_to_supplier",
] as const;
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];

export const ASSIGNMENT_TYPE_LABELS: Record<AssignmentType, string> = {
  issued_to_staff: "Issued to staff",
  allocated_to_job: "Allocated to job",
  stored_at_depot: "Stored at depot / yard",
  loaded_on_vehicle: "Loaded on vehicle",
  sent_for_repair: "Sent for repair",
  returned_to_supplier: "Returned to supplier",
};

/** The destination field each type carries (drives the form + validation). */
export const ASSIGNMENT_DESTINATION: Record<
  AssignmentType,
  "assignee" | "job" | "vehicle" | "location"
> = {
  issued_to_staff: "assignee",
  allocated_to_job: "job",
  stored_at_depot: "location",
  loaded_on_vehicle: "vehicle",
  sent_for_repair: "location",
  returned_to_supplier: "location",
};

export const ASSIGNMENT_STATUSES = ["open", "closed", "cancelled"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const CONDITIONS = [
  "excellent",
  "good",
  "fair",
  "damaged",
  "unsafe",
  "incomplete",
  "unknown",
] as const;
export type AssetCondition = (typeof CONDITIONS)[number];

export const CONDITION_LABELS: Record<AssetCondition, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  damaged: "Damaged",
  unsafe: "Unsafe",
  incomplete: "Incomplete",
  unknown: "Unknown",
};

/** Damaged/unsafe/incomplete on return = needs attention (future inspection/maintenance). */
export function returnNeedsAttention(c: AssetCondition | null | undefined): boolean {
  return c === "damaged" || c === "unsafe" || c === "incomplete";
}

/** Only an ACTIVE asset may be assigned (matches the DB guard trigger). */
export function isAssignableStatus(assetStatus: string): boolean {
  return assetStatus === "active";
}

/** An open assignment past its expected return date. */
export function isOverdue(
  expectedReturnAt: string | null,
  status: string,
  today: string,
): boolean {
  return status === "open" && !!expectedReturnAt && expectedReturnAt < today;
}

/**
 * Translate a Postgres error from an assignment write into a construction-
 * language message — never a raw SQL string. The partial unique index yields a
 * 23505 (unique_violation); the guard trigger raises check_violation (23514).
 */
export function friendlyAssignmentError(
  code: string | undefined,
  message: string | undefined,
): string {
  if (code === "23505") return "That asset is already checked out. Return it first.";
  if (code === "23514" || code === "check_violation") {
    if (message && /cannot be assigned/.test(message)) {
      return "That asset can't be assigned in its current state (retired, sold, lost or out of service).";
    }
    if (message && /not in org|not a member/.test(message)) {
      return "The job, person or vehicle you chose isn't in your organisation.";
    }
    return "That assignment isn't allowed.";
  }
  return "Couldn't save the assignment. Try again.";
}

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const optText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optUuid = z.preprocess(blankToUndefined, z.string().uuid().optional());
const optMeter = z.preprocess(
  blankToUndefined,
  z.coerce.number().min(0).max(100_000_000).optional(),
);
const optDate = z.preprocess(
  blankToUndefined,
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker").optional(),
);
const optCondition = z.preprocess(blankToUndefined, z.enum(CONDITIONS).optional());

export const checkOutSchema = z
  .object({
    asset_id: z.string().uuid(),
    assignment_type: z.enum(ASSIGNMENT_TYPES),
    job_id: optUuid,
    assignee_id: optUuid,
    vehicle_asset_id: optUuid,
    location: optText(200),
    issue_condition: optCondition,
    issue_notes: optText(2000),
    expected_return_at: optDate,
    issue_meter_reading: optMeter,
  })
  .refine(
    (v) => {
      const need = ASSIGNMENT_DESTINATION[v.assignment_type];
      if (need === "assignee") return !!v.assignee_id;
      if (need === "job") return !!v.job_id;
      if (need === "vehicle") return !!v.vehicle_asset_id;
      return !!v.location; // depot / repair / supplier
    },
    { message: "Choose where the asset is going", path: ["assignment_type"] },
  );
export type CheckOutInput = z.infer<typeof checkOutSchema>;

export const returnSchema = z.object({
  id: z.string().uuid(),
  return_condition: optCondition,
  return_notes: optText(2000),
  return_meter_reading: optMeter,
});

export const transferSchema = checkOutSchema; // same shape; the action closes the old + opens the new atomically

export const assignmentIdSchema = z.string().uuid();
