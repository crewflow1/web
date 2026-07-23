import { z } from "zod";

/**
 * Health & Safety — RAMS action input schemas. The DB is the authority for
 * tenant + immutability invariants; these validate shape/range at the trust
 * boundary before a write is attempted (mirrors lib/snags/schema.ts).
 */

const uuid = z.string().uuid();
const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const createRaSchema = z.object({
  title: trimmed(200),
  activity: trimmed(500),
  location: z.string().trim().max(200).optional().or(z.literal("")),
  jobId: uuid.optional().nullable(),
  assessorId: uuid.optional().nullable(),
  assessmentDate: z.string().date().optional().or(z.literal("")),
  reviewDate: z.string().date().optional().or(z.literal("")),
  ppe: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  methodStatement: z.string().max(20000).optional().or(z.literal("")),
});
export type CreateRaInput = z.infer<typeof createRaSchema>;

export const updateRaSchema = createRaSchema.extend({ id: uuid });
export type UpdateRaInput = z.infer<typeof updateRaSchema>;

export const raIdSchema = z.object({ id: uuid });

export const hazardSchema = z.object({
  riskAssessmentId: uuid,
  hazard: trimmed(500),
  whoAtRisk: z.string().trim().max(300).optional().or(z.literal("")),
  likelihood: z.coerce.number().int().min(1).max(5),
  severity: z.coerce.number().int().min(1).max(5),
  controlMeasures: trimmed(4000),
  residualLikelihood: z.coerce.number().int().min(1).max(5).optional().nullable(),
  residualSeverity: z.coerce.number().int().min(1).max(5).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
});
export type HazardActionInput = z.infer<typeof hazardSchema>;

export const updateHazardSchema = hazardSchema.extend({ id: uuid });
export const hazardIdSchema = z.object({ id: uuid, riskAssessmentId: uuid });

// DB row shapes (these tables post-date the generated Supabase types, so queries
// cast through these precise shapes — the compliance_documents / snags idiom).
export type RiskAssessmentRow = {
  id: string;
  org_id: string;
  job_id: string | null;
  reference: string | null;
  title: string;
  activity: string;
  location: string | null;
  assessor_id: string | null;
  assessment_date: string | null;
  review_date: string | null;
  ppe: string[];
  method_statement: string | null;
  status: "draft" | "issued" | "superseded" | "withdrawn";
  issued_at: string | null;
  issued_by: string | null;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
};

export type HazardRow = {
  id: string;
  org_id: string;
  risk_assessment_id: string;
  hazard: string;
  who_at_risk: string | null;
  likelihood: number;
  severity: number;
  risk_rating: number;
  control_measures: string;
  residual_likelihood: number | null;
  residual_severity: number | null;
  residual_rating: number | null;
  sort_order: number;
  created_at: string;
};

/** Normalise an optional date/text form value to null. */
export function orNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}
