import { z } from "zod";
import { CONTROL_POINTS, SIGNOFF_RESULTS, WITNESS_STATUSES } from "./itp";
import { NCR_SEVERITIES, NCR_STATUSES } from "./ncr";
import { TEMPLATE_STATUSES } from "./templates";

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
    // M2: the invitation this sign-off honours (witness/approve items only;
    // the DB validates it belongs to the same item).
    witnessInvitationId: uuid.optional().or(z.literal("")),
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
// M2 — NCRs
// ---------------------------------------------------------------------------
export const raiseNcrSchema = z
  .object({
    itemId: uuid,
    sourceSignoffId: uuid.optional().nullable(),
    title: trimmed(200),
    description: trimmed(20000),
    severity: z.enum(NCR_SEVERITIES),
    responsibleUserId: uuid.optional().nullable(),
    responsibleSubcontractor: optionalText(200),
    dueDate: z.string().date().optional().or(z.literal("")),
  })
  // Mirrors ncr_responsible_party_present: someone must be answerable.
  .refine(
    (v) => Boolean(v.responsibleUserId) || (v.responsibleSubcontractor ?? "").trim().length > 0,
    {
      message: "Name a responsible member or a responsible subcontractor.",
      path: ["responsibleUserId"],
    },
  );
export type RaiseNcrInput = z.infer<typeof raiseNcrSchema>;

export const updateNcrSchema = z
  .object({
    id: uuid,
    title: trimmed(200),
    description: trimmed(20000),
    severity: z.enum(NCR_SEVERITIES),
    responsibleUserId: uuid.optional().nullable(),
    responsibleSubcontractor: optionalText(200),
    dueDate: z.string().date().optional().or(z.literal("")),
  })
  .refine(
    (v) => Boolean(v.responsibleUserId) || (v.responsibleSubcontractor ?? "").trim().length > 0,
    {
      message: "Name a responsible member or a responsible subcontractor.",
      path: ["responsibleUserId"],
    },
  );

export const ncrIdSchema = z.object({ id: uuid });

export const closeNcrSchema = z.object({
  id: uuid,
  closureComment: trimmed(4000),
});

export const proposeActionSchema = z.object({
  ncrId: uuid,
  description: trimmed(4000),
  assignedTo: uuid.optional().nullable(),
  dueDate: z.string().date().optional().or(z.literal("")),
});

export const decideActionSchema = z
  .object({
    id: uuid,
    ncrId: uuid,
    decision: z.enum(["accepted", "rejected"]),
    decisionReason: optionalText(2000),
  })
  // Mirrors nca_rejection_reason_required.
  .refine((v) => v.decision !== "rejected" || (v.decisionReason ?? "").trim().length > 0, {
    message: "Rejecting a corrective action requires a reason.",
    path: ["decisionReason"],
  });

export const completeActionSchema = z.object({
  id: uuid,
  ncrId: uuid,
  completionComment: trimmed(4000),
});

// ---------------------------------------------------------------------------
// M2 — Witness invitations
// ---------------------------------------------------------------------------
export const inviteWitnessSchema = z.object({
  itemId: uuid,
  planId: uuid,
  witnessName: trimmed(120),
  witnessOrganisation: trimmed(160),
  witnessEmail: z.string().trim().email().max(200).optional().or(z.literal("")),
  scheduledFor: z.string().date().optional().or(z.literal("")),
});

export const witnessOutcomeSchema = z.object({
  id: uuid,
  planId: uuid,
  outcome: z.enum(["attended", "not_attended", "cancelled"]),
});

// ---------------------------------------------------------------------------
// M2 — Templates
// ---------------------------------------------------------------------------
export const createTemplateSchema = z.object({
  name: trimmed(200),
  description: optionalText(2000),
});

export const templateIdSchema = z.object({ id: uuid });

export const templateItemSchema = z.object({
  templateId: uuid,
  itemNumber: z.coerce.number().int().min(1).max(9999),
  title: trimmed(300),
  acceptanceCriteria: trimmed(4000),
  inspectionMethod: optionalText(300),
  specificationRef: optionalText(200),
  controlPoint: z.enum(CONTROL_POINTS),
  isHoldPoint: z.coerce.boolean().optional(),
  required: z.coerce.boolean().optional(),
});

export const templateItemIdSchema = z.object({ id: uuid, templateId: uuid });

export const instantiateTemplateSchema = z.object({
  templateId: uuid,
  jobId: uuid,
  workPackage: trimmed(200),
  title: optionalText(200),
});

// ---------------------------------------------------------------------------
// M2 — Revision lineage
// ---------------------------------------------------------------------------
export const startRevisionSchema = z.object({ id: uuid });

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
  // M2 revision lineage (20261081): the series identity + position.
  root_plan_id: string;
  revision_number: number;
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
  // M2 (20261081): the honoured witness invitation, when one was recorded.
  witness_invitation_id: string | null;
};

export type NcrRow = {
  id: string;
  org_id: string;
  inspection_plan_item_id: string;
  source_signoff_id: string | null;
  reference: string;
  title: string;
  description: string;
  severity: (typeof NCR_SEVERITIES)[number];
  responsible_user_id: string | null;
  responsible_subcontractor: string | null;
  due_date: string | null;
  status: (typeof NCR_STATUSES)[number];
  raised_by: string;
  verified_by: string | null;
  verified_at: string | null;
  closure_comment: string | null;
  created_at: string;
  updated_at: string;
};

export type CorrectiveActionRow = {
  id: string;
  org_id: string;
  ncr_id: string;
  description: string;
  assigned_to: string | null;
  due_date: string | null;
  proposed_by: string | null;
  proposed_at: string;
  decision: "accepted" | "rejected" | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  completed_at: string | null;
  completion_comment: string | null;
  created_at: string;
  updated_at: string;
};

export type WitnessInvitationRow = {
  id: string;
  org_id: string;
  inspection_plan_item_id: string;
  witness_name: string;
  witness_organisation: string;
  witness_email: string | null;
  scheduled_for: string | null;
  status: (typeof WITNESS_STATUSES)[number];
  invited_by: string | null;
  attendance_recorded_by: string | null;
  attendance_recorded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TemplateRow = {
  id: string;
  org_id: string;
  name: string;
  version: number;
  description: string | null;
  status: (typeof TEMPLATE_STATUSES)[number];
  created_by: string | null;
  published_by: string | null;
  published_at: string | null;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TemplateItemRow = {
  id: string;
  org_id: string;
  template_id: string;
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
