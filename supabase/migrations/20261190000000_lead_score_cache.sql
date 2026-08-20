-- ═════════════════════════════════════════════════════════════════════════════
-- TENANT LEAD SCORE — denormalised cache columns on public.leads.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CrewFlow scores its OWN prospects inside HQ (lib/research/score.ts) but a
-- tenant's own leads had no score. This adds an explainable, DETERMINISTIC
-- "lead score" for each tenant's leads. The rubric is NOT in SQL — it is the
-- single pure source of truth in lib/leads/score.ts (scoreLead). These columns
-- are a WRITE-THROUGH CACHE of that rubric's output, refreshed by the lead
-- server actions on every lead change (server/services/lead-score.ts,
-- recomputeLeadScore). Keeping the arithmetic in exactly one place (TypeScript)
-- means there is no second SQL rubric to drift from it.
--
-- WHY A CACHE AT ALL, when the UI computes the score live at render:
--   · the /leads pipeline and the lead-detail page compute the score LIVE from
--     the pure rubric, so display is correct for EVERY row the instant this
--     migration lands — including pre-existing leads whose cache is still null
--     (no backfill needed for correctness);
--   · the cache exists so the score is queryable at the DB layer — sortable and
--     band-filterable without materialising the whole table in memory — for the
--     public API and future reporting. It is populated lazily: each lead's cache
--     fills the next time that lead is touched.
--
-- All columns are NULLABLE and additive. No RLS change: the leads table's
-- existing org-scoped policies already govern every column on the row, so these
-- inherit the same tenant isolation. `leads` is already classified in
-- lib/gdpr/org-tables.json — no new table, no new classification.
--
-- Reversible:
--   drop index if exists public.leads_org_score_idx;
--   alter table public.leads
--     drop column if exists lead_score,
--     drop column if exists lead_score_band,
--     drop column if exists lead_score_factors,
--     drop column if exists lead_score_updated_at;

alter table public.leads
  -- 0–100 rubric total (smallint is ample; CHECK pins the domain).
  add column if not exists lead_score smallint
    check (lead_score is null or (lead_score >= 0 and lead_score <= 100)),
  -- hot | warm | cold — mirrors lib/leads/score.ts LEAD_SCORE_BANDS. The CHECK
  -- is a domain guard only; the band is always derived from lead_score by the
  -- rubric, never set independently.
  add column if not exists lead_score_band text
    check (lead_score_band is null or lead_score_band in ('hot', 'warm', 'cold')),
  -- The full per-factor breakdown (score, band, confidence, factors[]) as the
  -- rubric emitted it, so an API/report consumer gets the explanation, not just
  -- the number. Shape mirrors the LeadScore type; no server reads it back today.
  add column if not exists lead_score_factors jsonb,
  -- When the cache was last refreshed. Distinct from last_activity_at so a stale
  -- cache is visible (updated_at older than last_activity_at ⇒ not yet refreshed).
  add column if not exists lead_score_updated_at timestamptz;

-- Score-ordered index for DB-level sort/filter, org-pinned to match every read.
-- Partial (score not null) so the lazily-populated cache doesn't bloat it with
-- unscored rows. DESC + NULLS LAST so "hottest first" is the natural order.
create index if not exists leads_org_score_idx
  on public.leads (org_id, lead_score desc nulls last)
  where lead_score is not null;
