import { LEAD_STAGES, type LeadStage } from "@/lib/leads/schema";
import type { PipelineLead } from "./_card";

/**
 * Pure bucketing + forecast aggregation for the /leads kanban.
 *
 * Extracted from the page so the exclusion contract is unit-testable
 * without constructing a Supabase client. Behaviour mirrors the page 1:1.
 *
 * CONTRACT (regression-pinned in __tests__/leads/pipeline.test.ts):
 *   A row whose status is NOT one of LEAD_STAGES — `archived` (set by the
 *   Archive action) or any other legacy/unknown value — is skipped entirely.
 *   It lands in NO column AND is excluded from `totalValue`. The stage-membership
 *   check therefore runs BEFORE both the bucketing and the forecast accumulation.
 *   Previously unknown statuses were coerced to `new` (surfacing archived leads
 *   at the top of the New column) and their value still inflated the forecast.
 *
 * The pipeline query already applies `.neq("status","archived")`, so archived
 * rows should not reach here in production; this guard is the second line of
 * defence and the home for every other non-stage status.
 */

/**
 * Minimal structural shape of a pipeline lead row as selected by the page
 * query. Kept permissive (extra columns on the real row are fine) so the
 * generated Supabase row type is assignable without a cast.
 */
export type RawPipelineLead = {
  id: string;
  status: string;
  source: string;
  urgency: string | null;
  postcode: string | null;
  service: string | null;
  estimated_value: number | string | null;
  last_activity_at: string;
  customer: { name: string | null } | null;
  assigned: { full_name: string | null; email: string | null } | null;
};

export type BucketedPipeline = {
  byStage: Record<LeadStage, PipelineLead[]>;
  totalValue: number;
};

export function bucketPipelineLeads(
  leads: readonly RawPipelineLead[],
): BucketedPipeline {
  const byStage: Record<LeadStage, PipelineLead[]> = {
    new: [],
    contacted: [],
    qualified: [],
    quoted: [],
    won: [],
    lost: [],
    job_booked: [],
  };
  let totalValue = 0;

  for (const l of leads) {
    // Stage-membership gate FIRST: unknown/terminal statuses (e.g. `archived`)
    // are never coerced to `new` and never counted in the forecast.
    if (!(LEAD_STAGES as readonly string[]).includes(l.status)) continue;
    const status = l.status as LeadStage;

    totalValue += Number(l.estimated_value ?? 0);
    byStage[status].push({
      id: l.id,
      service: l.service ?? null,
      source: l.source,
      urgency: l.urgency ?? null,
      postcode: l.postcode ?? null,
      estimated_value: l.estimated_value ? Number(l.estimated_value) : null,
      status,
      last_activity_at: l.last_activity_at,
      customer_name: l.customer?.name ?? null,
      assigned_name: l.assigned?.full_name ?? l.assigned?.email ?? null,
    });
  }

  return { byStage, totalValue };
}
