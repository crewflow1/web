-- CrewFlow HQ — Master-Plan task lifecycle alignment + Competitor Intelligence.
--
-- Two additive, deterministic capabilities in one migration, both HQ-only:
--
--   PART A — align the PRODUCT pipeline to the full Master-Plan lifecycle. The Task
--   Engine's pipeline_stage (20261094000000) admits ELEVEN stages; the Master-Plan
--   Task Engine models FOUR more the shipped enum is missing — `architecture`,
--   `approval`, `monitoring`, `continuous-improvement`. This migration WIDENS the three
--   SQL surfaces that pin the stage vocabulary (the column CHECK, the append-only
--   stage-event child's to_stage CHECK, and the sanctioned hq_ai_task_set_stage mover)
--   to the full FIFTEEN-stage set. `marketing` and `sales` are KEPT — both are live in
--   the workflow's department→stage mapping, so dropping them would orphan driven data.
--   Widening a CHECK to a SUPERSET can never orphan an existing row: every value the old
--   constraint admitted the new one still admits. The append-only stage-event log and
--   its immutability triggers (20261094000000) are untouched and preserved.
--
--   PART B — a Competitor Intelligence store the CEO briefing can read. Competitor
--   references live today only in marketing SEO copy — there is no live intel store the
--   daily briefing can narrate. This adds a deterministic, operator-authored competitor
--   note store on the hq_decisions child-table idiom (RLS:hq — RLS enabled, ZERO
--   policies → service-role only; a single SECURITY DEFINER writer). It ties each note
--   to the seeded `competitor` memory_type (hq_memory_types), so the note store IS the
--   competitor memory-type ingestion path. NO model, no scraping, no fabricated claims —
--   an operator authors each note.
--
-- Additive + idempotent throughout (add-if-not-exists, drop-then-recreate CHECK to a
-- superset, create-if-not-exists, guarded triggers): applying this migration forces no
-- existing row to a stage, changes no existing behaviour, and touches no tenant table.

-- ===========================================================================
-- PART A — widen the pipeline_stage vocabulary to the full Master-Plan set.
-- ===========================================================================

-- 1. The column CHECK on hq_ai_tasks.pipeline_stage — widened to a SUPERSET.
--    Drop the shipped eleven-stage constraint and re-add the fifteen-stage one in the
--    same statement block. Because the new set is a strict superset of the old, no
--    existing row can be orphaned. Still nullable + un-defaulted: an unstaged task
--    stays valid.
alter table public.hq_ai_tasks
  drop constraint if exists hq_ai_tasks_pipeline_stage_check;

alter table public.hq_ai_tasks
  add constraint hq_ai_tasks_pipeline_stage_check
  check (pipeline_stage is null or pipeline_stage in (
    'idea','research','specification','architecture','design','engineering','testing',
    'documentation','approval','marketing','sales','deployment','monitoring','review',
    'continuous-improvement'
  ));

comment on column public.hq_ai_tasks.pipeline_stage is
  'The Master-Plan PRODUCT pipeline stage (idea…continuous-improvement, fifteen stages) — orthogonal to the EXECUTION status. Nullable: an unstaged task is valid. Moved only via hq_ai_task_set_stage(); every change appends to hq_ai_task_stage_events.';

-- 2. The append-only stage-event child's to_stage CHECK — widened to the same superset.
--    Postgres names an inline column check <table>_<column>_check; drop it and re-add a
--    named constraint carrying the full vocabulary. The immutability triggers and RLS on
--    the table are NOT touched.
alter table public.hq_ai_task_stage_events
  drop constraint if exists hq_ai_task_stage_events_to_stage_check;

alter table public.hq_ai_task_stage_events
  add constraint hq_ai_task_stage_events_to_stage_check
  check (to_stage in (
    'idea','research','specification','architecture','design','engineering','testing',
    'documentation','approval','marketing','sales','deployment','monitoring','review',
    'continuous-improvement'
  ));

-- 3. The sanctioned stage-mover — re-created with the widened vocabulary. Identical
--    hardening to 20261094000000 §4: SECURITY DEFINER, pinned empty search_path, active
--    statuses only (terminal tasks stay frozen), EXECUTE revoked from every JWT role and
--    granted only to service_role. The AFTER trigger still records each transition.
create or replace function public.hq_ai_task_set_stage(
  p_task_id uuid,
  p_stage   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.hq_ai_tasks;
begin
  if p_stage is null or p_stage not in (
    'idea','research','specification','architecture','design','engineering','testing',
    'documentation','approval','marketing','sales','deployment','monitoring','review',
    'continuous-improvement'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_stage');
  end if;

  update public.hq_ai_tasks
  set pipeline_stage = p_stage
  where id = p_task_id
    and status in ('pending','running','blocked','claimed','waiting_approval','verifying')
  returning * into v_row;

  if not found then
    -- No such task, or it is terminal (completed/failed/cancelled) and frozen.
    return jsonb_build_object('ok', false, 'reason', 'not_updatable');
  end if;

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

revoke all on function public.hq_ai_task_set_stage(uuid, text) from public, anon, authenticated;
grant execute on function public.hq_ai_task_set_stage(uuid, text) to service_role;

-- ===========================================================================
-- PART B — Competitor Intelligence: the operator-authored intel store.
-- ===========================================================================

-- 4. Ensure the `competitor` memory_type exists (idempotent). This is the type the
--    note store ingests under — new memory_types are DATA rows, not code
--    (20260713000000). `on conflict do nothing` makes re-application a no-op even where
--    20260713000100 already seeded it.
insert into public.hq_memory_types
  (slug, label, description, icon, accent, default_department, sort_order)
values
  ('competitor', 'Competitor Memory', 'Competitive landscape, positioning, and intelligence.', 'crosshair', 'amber', 'marketing', 130)
on conflict (slug) do nothing;

-- 5. hq_competitor_notes — the deterministic, operator-authored competitor intel store.
--
-- One row per operator-authored competitor observation. HQ infrastructure: RLS:hq (RLS
-- enabled, ZERO policies → service_role only; every JWT client denied). The store is the
-- competitor memory-type ingestion path — memory_type defaults to 'competitor' and is FK
-- to the extensible hq_memory_types lookup. Deterministic: no model writes here; an
-- operator authors each note through the SECURITY DEFINER function below.
create table if not exists public.hq_competitor_notes (
  id              uuid        primary key default gen_random_uuid(),

  competitor_name text        not null check (char_length(competitor_name) between 1 and 120),
  headline        text        not null check (char_length(headline) between 1 and 200),
  detail          text        not null default '' check (char_length(detail) <= 4000),

  -- The intel facet. Nullable — a note may be uncategorised.
  category        text        check (category is null or category in (
                    'positioning','pricing','product','gtm','funding','hiring','other'
                  )),
  source_url      text        check (source_url is null or char_length(source_url) <= 2000),

  -- Ties the note to the seeded competitor memory_type (the ingestion path).
  memory_type     text        not null default 'competitor'
                    references public.hq_memory_types(slug),

  -- Reuses the memory engine's importance vocabulary (lib/memory/model.ts).
  importance      text        not null default 'normal'
                    check (importance in ('low','normal','high','critical')),
  status          text        not null default 'active'
                    check (status in ('active','archived')),

  captured_by     text,       -- operator email (provenance)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The briefing reads the most recent ACTIVE notes; index the live set by recency.
create index if not exists hq_competitor_notes_active_idx
  on public.hq_competitor_notes (created_at desc)
  where status = 'active';

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT client
-- is denied. Competitor intel is HQ infrastructure; tenants never see it.
alter table public.hq_competitor_notes enable row level security;

comment on table public.hq_competitor_notes is
  'CrewFlow HQ — deterministic, operator-authored Competitor Intelligence notes. RLS:hq, service-role only. The competitor memory-type ingestion path (memory_type FK → hq_memory_types). Read by the daily CEO briefing. NO model writes.';

-- 6. hq_competitor_note_add — the sanctioned writer (the ONE write path).
--
-- SECURITY DEFINER with a pinned empty search_path; validates its inputs and returns the
-- house {ok} envelope. Deterministic: it records exactly the operator-supplied note. Not
-- gated on a lease (an operator act, like the Decision Centre's propose). EXECUTE revoked
-- from every JWT role, granted only to service_role — the request-path super-admin gate
-- (server/auth/hq.ts) is the only door, exactly as the rest of HQ.
create or replace function public.hq_competitor_note_add(
  p_competitor_name text,
  p_headline        text,
  p_detail          text default '',
  p_category        text default null,
  p_source_url      text default null,
  p_importance      text default 'normal',
  p_captured_by     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.hq_competitor_notes;
begin
  if p_competitor_name is null or char_length(btrim(p_competitor_name)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  if p_headline is null or char_length(btrim(p_headline)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'headline_required');
  end if;
  if p_category is not null and p_category not in (
    'positioning','pricing','product','gtm','funding','hiring','other'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_category');
  end if;
  if p_importance not in ('low','normal','high','critical') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_importance');
  end if;

  insert into public.hq_competitor_notes
    (competitor_name, headline, detail, category, source_url, importance, captured_by)
  values
    (btrim(p_competitor_name), btrim(p_headline), coalesce(p_detail, ''), p_category,
     p_source_url, p_importance, p_captured_by)
  returning * into v_row;

  return jsonb_build_object('ok', true, 'note', to_jsonb(v_row));
end;
$$;

revoke all on function public.hq_competitor_note_add(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_competitor_note_add(text, text, text, text, text, text, text)
  to service_role;
