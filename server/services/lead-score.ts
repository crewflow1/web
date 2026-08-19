import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFailure } from "@/lib/supabase/read-failure";
import { scoreLead, type LeadScore } from "@/lib/leads/score";

/**
 * LEAD SCORE — write-through cache refresh.
 *
 * The rubric (lib/leads/score.ts) is the single source of truth; this service
 * is the ONLY writer of the leads.lead_score* cache columns. Every lead-mutating
 * server action calls it AFTER its own write, so the cache always reflects the
 * row as it now stands on disk (we RE-READ the row rather than trusting the
 * caller's in-memory view — one code path, no way for create/update/move to
 * disagree on which fields feed the score).
 *
 * ORG-PINNED + LOUD:
 *   · the read and the write both carry `.eq("org_id", orgId)` on top of RLS —
 *     `current_org_ids()` admits every org the caller belongs to, so a dual-org
 *     user must not be able to rescore org B's lead from org A;
 *   · the read throws on error (readFailure) — a rejected read must never be
 *     mistaken for "lead gone" and silently skip the rescore.
 *
 * NON-FATAL WRITE: the UI computes the score live at render, so the cache is an
 * optimisation, not the source of truth. A cache-write hiccup is logged, never
 * thrown — it must not fail the user's underlying action (save / move / convert).
 */

type LeadScoreRow = {
  status: string | null;
  source: string | null;
  estimated_value: number | string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  last_activity_at: string | null;
  created_at: string | null;
  customer_id: string | null;
};

function toNumberOrNull(v: number | string | null): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Recompute and persist the lead-score cache for one lead. Safe to call after
 * any lead mutation; a no-op (returns null) if the lead is gone or foreign-org.
 */
export async function recomputeLeadScore(
  // Loosely typed on purpose: the lead_score* + contact_* columns aren't in the
  // generated Supabase types yet, so callers pass their normal server client and
  // we drive it through `as never` casts (the established idiom in this domain).
  supabase: SupabaseClient,
  orgId: string,
  leadId: string,
): Promise<LeadScore | null> {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "status, source, estimated_value, contact_name, contact_email, contact_phone, last_activity_at, created_at, customer_id" as never,
    )
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("lead score: recompute read", error);
  if (!data) return null;

  const row = data as unknown as LeadScoreRow;
  const score = scoreLead({
    status: row.status,
    source: row.source,
    estimatedValue: toNumberOrNull(row.estimated_value),
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    customerId: row.customer_id,
    asOfMs: Date.now(),
  });

  const { error: writeError } = await supabase
    .from("leads")
    .update(
      {
        lead_score: score.score,
        lead_score_band: score.band,
        lead_score_factors: score as unknown,
        lead_score_updated_at: new Date().toISOString(),
      } as never,
    )
    .eq("id", leadId)
    .eq("org_id", orgId);
  // Non-fatal: the display path recomputes live, so a stale cache degrades
  // sort accuracy at worst — it must not break the action that triggered it.
  if (writeError) {
    console.error("[lead-score] cache write failed", writeError);
  }

  return score;
}
