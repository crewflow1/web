-- AI cost observability (Phase 0) — EXTEND the existing ai_invocations ledger +
-- add a service-role windowed rollup so HQ can answer, without manual maths:
-- "AI cost today / this week / this month, by tenant / feature / provider / model /
-- engine, with input / output / cached tokens, latency, and fallback events."
--
-- REUSES the existing ledger (20261062000000_ai_invocations) — no second telemetry
-- system. Purely ADDITIVE: three defaulted columns + one read-only function. No
-- provider/model behaviour change, no change to the reserve/settle path; existing
-- writers keep working and existing rows get honest defaults.

-- ── Additive columns (defaulted, so every existing writer/row is unaffected) ──
alter table public.ai_invocations
  -- Cached input tokens (prompt-cache hits), where the provider reports them.
  -- 0 until the provider adapters surface cache usage; never fabricated.
  add column if not exists cached_input_tokens integer not null default 0
    check (cached_input_tokens >= 0),
  -- Which engine served the call. Today every governed call is 'hosted'; the
  -- column is the seam the local-first roadmap will populate ('local') and keeps
  -- deterministic fallbacks nameable if a caller ever records one.
  add column if not exists engine text not null default 'hosted'
    check (engine in ('hosted', 'local', 'deterministic')),
  -- True when THIS call was a fallback after a cheaper/local engine was skipped
  -- or failed — the "fallback event" signal. Default false (no fallback).
  add column if not exists is_fallback boolean not null default false;

comment on column public.ai_invocations.cached_input_tokens is
  'Prompt-cache input tokens where the provider reports them; 0 otherwise (never fabricated).';
comment on column public.ai_invocations.engine is
  'hosted | local | deterministic — which engine served the call (today: hosted).';
comment on column public.ai_invocations.is_fallback is
  'True when this call was a fallback after a cheaper/local engine was skipped or failed.';

-- Index the time dimension the window rollups scan on (cheap, additive).
create index if not exists ai_invocations_created_at_idx
  on public.ai_invocations (created_at);

-- ── Windowed rollup — service-role only, bounded output (F-1 safe) ────────────
-- One JSON object for the Europe/London window named by p_window ('today' |
-- 'week' [ISO, Monday] | 'month'): grand totals + arrays grouped by the CLOSED
-- dimensions (feature / provider / model / engine, each a small bounded set) and
-- the TOP-20 spending orgs (bounded top-N). The London day/week/month boundaries
-- are computed in SQL (date_trunc on the London wall-clock, converted back to
-- timestamptz) so DST is handled correctly without TS date maths. SECURITY INVOKER
-- + execute revoked from client roles: only the service-role client (which bypasses
-- RLS) ever calls it, so no org-scoped guard is required and no tenant can reach
-- estate-wide spend.
create or replace function public.ai_cost_window(p_window text)
returns jsonb
language sql
stable
security invoker
as $$
  with bounds as (
    select
      (date_trunc(
        case p_window when 'today' then 'day' when 'week' then 'week' when 'month' then 'month'
             else 'day' end,
        now() at time zone 'Europe/London')
      ) as lstart,
      case p_window when 'today' then interval '1 day' when 'week' then interval '1 week'
           when 'month' then interval '1 month' else interval '1 day' end as llen
  ),
  w as (
    select
      (lstart at time zone 'Europe/London') as p_from,
      ((lstart + llen) at time zone 'Europe/London') as p_to
    from bounds
  ),
  win as (
    select i.* from public.ai_invocations i, w
    where i.created_at >= w.p_from and i.created_at < w.p_to
  ),
  by_dim as (
    select
      (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select feature as key, count(*) n, sum(estimated_cost_pence) pence,
               sum(input_tokens) in_tok, sum(output_tokens) out_tok, sum(cached_input_tokens) cached_tok
        from win group by feature order by sum(estimated_cost_pence) desc) r) as by_feature,
      (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select provider as key, count(*) n, sum(estimated_cost_pence) pence
        from win group by provider order by sum(estimated_cost_pence) desc) r) as by_provider,
      (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select model as key, count(*) n, sum(estimated_cost_pence) pence
        from win group by model order by sum(estimated_cost_pence) desc) r) as by_model,
      (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select engine as key, count(*) n, sum(estimated_cost_pence) pence
        from win group by engine order by sum(estimated_cost_pence) desc) r) as by_engine,
      (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select org_id as key, count(*) n, sum(estimated_cost_pence) pence
        from win group by org_id order by sum(estimated_cost_pence) desc limit 20) r) as top_orgs
  )
  select jsonb_build_object(
    'window', p_window,
    'from', (select p_from from w),
    'to', (select p_to from w),
    'invocations', (select count(*) from win),
    'cost_pence', (select coalesce(sum(estimated_cost_pence), 0) from win),
    'input_tokens', (select coalesce(sum(input_tokens), 0) from win),
    'output_tokens', (select coalesce(sum(output_tokens), 0) from win),
    'cached_input_tokens', (select coalesce(sum(cached_input_tokens), 0) from win),
    'failures', (select count(*) from win where not success),
    'fallback_events', (select count(*) from win where is_fallback),
    'latency_p50_ms', (select coalesce(percentile_cont(0.5) within group (order by latency_ms), 0) from win),
    'latency_p95_ms', (select coalesce(percentile_cont(0.95) within group (order by latency_ms), 0) from win),
    'by_feature', (select by_feature from by_dim),
    'by_provider', (select by_provider from by_dim),
    'by_model', (select by_model from by_dim),
    'by_engine', (select by_engine from by_dim),
    'top_orgs', (select top_orgs from by_dim)
  );
$$;

comment on function public.ai_cost_window(text) is
  'Service-role-only estate AI-cost rollup for a Europe/London window (today|week|month): totals + bounded group-bys (feature/provider/model/engine) + top-20 orgs. Read-only observability.';

-- Service-role only: no client role may read estate-wide spend.
revoke all on function public.ai_cost_window(text) from public;
revoke all on function public.ai_cost_window(text) from anon, authenticated;
