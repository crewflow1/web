import { LEAD_STAGES, type LeadStage } from "@/lib/leads/schema";
import {
  scoreLead,
  type LeadScoreBand,
} from "@/lib/leads/score";
import type { PipelineLead } from "./_card";

/**
 * Pure bucketing + forecast aggregation + lead scoring for the /leads kanban.
 *
 * Extracted from the page so the exclusion contract AND the score sort/filter
 * are unit-testable without constructing a Supabase client. Behaviour mirrors
 * the page 1:1.
 *
 * CONTRACT (regression-pinned in __tests__/leads/pipeline.test.ts):
 *   A row whose status is NOT one of LEAD_STAGES — `archived` (set by the
 *   Archive action) or any other legacy/unknown value — is skipped entirely.
 *   It lands in NO column AND is excluded from `totalValue`. The stage-membership
 *   check therefore runs BEFORE both the bucketing and the forecast accumulation.
 *
 * SCORING (deterministic): every card carries a live-computed lead score + band
 * from lib/leads/score.ts. The score is computed here at render (the DB
 * lead_score* cache is a denormalised copy, not the display source), so the
 * pipeline is correct for every lead — including any whose cache is still null.
 * `asOfMs` is injected so the recency factor is deterministic and testable.
 *
 * The pipeline query already applies `.neq("status","archived")`, so archived
 * rows should not reach here in production; this guard is the second line of
 * defence and the home for every other non-stage status.
 */

/**
 * Minimal structural shape of a pipeline lead row as selected by the page
 * query, PLUS the contact fields (merged in separately for the score — they
 * aren't in the generated types) and an optional created_at. Kept permissive
 * (extra columns on the real row are fine) so the generated Supabase row type
 * is assignable without a cast.
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
  customer_id?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  created_at?: string | null;
  customer: { name: string | null } | null;
  assigned: { full_name: string | null; email: string | null } | null;
};

export type BucketedPipeline = {
  byStage: Record<LeadStage, PipelineLead[]>;
  totalValue: number;
};

export type BucketOptions = {
  /** Injected clock (ms) for the deterministic recency factor. */
  asOfMs?: number;
  /** When set, keep only leads in this band — filter by score. Affects the
   *  columns AND the forecast, exactly like the source/urgency filters. */
  band?: LeadScoreBand | null;
};

function toNumberOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

export function bucketPipelineLeads(
  leads: readonly RawPipelineLead[],
  opts: BucketOptions = {},
): BucketedPipeline {
  const asOfMs = opts.asOfMs ?? Date.now();
  const band = opts.band ?? null;

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

    const scored = scoreLead({
      status: l.status,
      source: l.source,
      estimatedValue: toNumberOrNull(l.estimated_value),
      contactName: l.contact_name ?? null,
      contactEmail: l.contact_email ?? null,
      contactPhone: l.contact_phone ?? null,
      lastActivityAt: l.last_activity_at,
      createdAt: l.created_at ?? null,
      customerId: l.customer_id ?? null,
      asOfMs,
    });

    // Score-band filter (when applied) drops the lead from BOTH the column and
    // the forecast — parity with the query-level source/urgency filters.
    if (band && scored.band !== band) continue;

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
      score: scored.score,
      band: scored.band,
    });
  }

  // Sort each column hottest-first: score desc, then most-recent activity, then
  // a stable id tiebreak so the order never flickers between renders.
  for (const stage of LEAD_STAGES) {
    byStage[stage].sort(
      (a, b) =>
        b.score - a.score ||
        b.last_activity_at.localeCompare(a.last_activity_at) ||
        a.id.localeCompare(b.id),
    );
  }

  return { byStage, totalValue };
}
