import { z } from "zod";
import { PERMIT_TYPES } from "./permits";

/**
 * Permit-to-Work action input schemas. The DB is the authority for tenant +
 * lifecycle + issue-gate + immutability invariants; these validate shape at the
 * trust boundary (mirrors lib/health-safety/schema.ts for RAMS).
 */

const uuid = z.string().uuid();
const optDate = z.string().datetime({ offset: true }).optional().or(z.literal("")).nullable();

export const createPermitSchema = z.object({
  permitType: z.enum(PERMIT_TYPES),
  title: z.string().trim().min(1).max(200),
  scope: z.string().trim().min(1).max(4000),
  location: z.string().trim().max(200).optional().or(z.literal("")),
  jobId: uuid.optional().nullable(),
  riskAssessmentId: uuid.optional().nullable(),
  responsiblePerson: z.string().trim().max(200).optional().or(z.literal("")),
  isolationDetails: z.string().trim().max(4000).optional().or(z.literal("")),
  emergencyArrangements: z.string().trim().max(4000).optional().or(z.literal("")),
  validFrom: optDate,
  validUntil: optDate,
});
export type CreatePermitInput = z.infer<typeof createPermitSchema>;

export const updatePermitSchema = createPermitSchema.extend({ id: uuid });
export const permitIdSchema = z.object({ id: uuid });

export const addConditionSchema = z.object({
  permitId: uuid,
  label: z.string().trim().min(1).max(300),
  required: z.union([z.literal("on"), z.boolean()]).optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
});
export const conditionIdSchema = z.object({ id: uuid, permitId: uuid });

export type PermitRow = {
  id: string;
  org_id: string;
  job_id: string | null;
  risk_assessment_id: string | null;
  reference: string | null;
  permit_type: string;
  title: string;
  scope: string;
  location: string | null;
  responsible_person: string | null;
  isolation_details: string | null;
  emergency_arrangements: string | null;
  valid_from: string | null;
  valid_until: string | null;
  status: "draft" | "issued" | "active" | "suspended" | "closed" | "cancelled";
  closeout_notes: string | null;
  issued_by: string | null;
  issued_at: string | null;
  activated_at: string | null;
  suspended_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PermitConditionRow = {
  id: string;
  org_id: string;
  permit_id: string;
  label: string;
  required: boolean;
  confirmed: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
  notes: string | null;
  sort_order: number;
};

export function orNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** Map a transition verb to the status + the stamp column it sets. */
export const TRANSITION_STAMP: Record<string, { status: PermitRow["status"]; stamp: string | null }> = {
  activate: { status: "active", stamp: "activated_at" },
  suspend: { status: "suspended", stamp: "suspended_at" },
  close: { status: "closed", stamp: "closed_at" },
  cancel: { status: "cancelled", stamp: "cancelled_at" },
};
