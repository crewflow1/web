import { z } from "zod";
import { CONTROL_POINTS, SIGNOFF_RESULTS } from "./itp";

/**
 * Works Quality — ITP action input schemas + DB row shapes.
 *
 * The database is the authority for tenant, lifecycle and immutability
 * invariants; these validate shape/range at the trust boundary before a write is
 * attempted (the lib/health-safety/schema.ts convention). These tables post-date
 * the generated Supabase types, so every query casts through the row shapes
 * below rather than pretending the generated types know about them.
 */

const uuid = z.string().uuid();
const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

/** "" → null, for optional text columns. */
export function orNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

export const createPlanSchema = z.object({
  title: trimmed(200),
  workPackage: trimmed(200),
  jobId: uuid,
  location: optionalText(200),
  specificationRef: optionalText(200),
  preparedBy: uuid.optional().nullable(),
  planDate: z.string().date().optional().or(z.literal("")),
  notes: z.string().max(20000).optional().or(z.literal("")),
});
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = createPlanSchema.extend({ id: uuid });
export const planIdSchema = z.object({ id: uuid });

export const planItemSchema = z.object({
  planId: uuid,
  itemNumber: z.coerce.number().int().min(1).max(9999),
  title: trimmed(300),
  acceptanceCriteria: trimmed(4000),
  inspectionMethod: optionalText(300),
  specificationRef: optionalText(200),
  controlPoint: z.enum(CONTROL_POINTS),
  isHoldPoint: z.coerce.boolean().optional(),
  required: z.coerce.boolean().optional(),
});
export type PlanItemInput = z.infer<typeof planItemSchema>;

export const planItemIdSchema = z.object({ id: uuid, planId: uuid });

export const signoffSchema = z
  .object({
    itemId: uuid,
    planId: uuid,
    result: z.enum(SIGNOFF_RESULTS),
    comments: z.string().trim().max(4000).optional().or(z.literal("")),
    signedName: trimmed(120),
    inspectedAt: z.string().date(),
    witnessName: optionalText(120),
    witnessOrganisation: optionalText(160),
  })
  // Mirrors isg_comment_required_unless_plain_pass: an unexplained non-pass is
  // not evidence. Checked here so the operator gets a readable message rather
  // than a raw constraint violation.
  .refine((v) => v.result === "pass" || (v.comments ?? "").trim().length > 0, {
    message: "A fail or pass-with-comment must say why.",
    path: ["comments"],
  })
  // The physical inspection cannot be in the future (mirrors tg_signoff_validate).
  .refine((v) => v.inspectedAt <= new Date().toISOString().slice(0, 10), {
    message: "The inspection date cannot be in the future.",
    path: ["inspectedAt"],
  });
export type SignoffInput = z.infer<typeof signoffSchema>;

export const voidSignoffSchema = z.object({
  id: uuid,
  planId: uuid,
  voidReason: trimmed(500),
});

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------
export type ItpRow = {
  id: string;
  org_id: string;
  job_id: string | null;
  reference: string | null;
  title: string;
  work_package: string;
  location: string | null;
  specification_ref: string | null;
  prepared_by: string | null;
  plan_date: string | null;
  notes: string | null;
  status: "draft" | "issued" | "superseded" | "withdrawn";
  issued_at: string | null;
  issued_by: string | null;
  supersedes_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PlanItemRow = {
  id: string;
  org_id: string;
  inspection_test_plan_id: string;
  item_number: number;
  title: string;
  acceptance_criteria: string;
  inspection_method: string | null;
  specification_ref: string | null;
  control_point: "inspect" | "witness" | "approve";
  is_hold_point: boolean;
  required: boolean;
  created_at: string;
};

export type SignoffRow = {
  id: string;
  org_id: string;
  inspection_plan_item_id: string;
  plan_version: string;
  result: "pass" | "fail" | "pass_with_comment";
  comments: string | null;
  inspected_by: string;
  signed_name: string;
  inspected_at: string;
  recorded_at: string;
  witness_name: string | null;
  witness_organisation: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  hold_point_breach: boolean;
  open_hold_item_number: number | null;
  created_at: string;
};

/** A row of public.works_quality_plan_status (the DB-authoritative read-model). */
export type PlanStatusRow = {
  plan_id: string;
  org_id: string;
  job_id: string | null;
  status: string;
  total_items: number;
  hold_point_items: number;
  signed_off_items: number;
  outstanding_required_items: number;
  open_hold_points: number;
  failed_items: number;
  hold_point_breaches: number;
  open_hold_item_number: number | null;
};
