-- Automation OS — VISUAL WORKFLOW GRAPHS (the node-graph builder's storage).
--
-- WHAT THIS ADDS (and, deliberately, does NOT add)
-- ------------------------------------------------
-- The engine already runs per-org, user-composed CUSTOM rules
-- (automation_custom_rules, 20261133): a validated `definition` jsonb loaded and
-- executed by the ONE dispatcher through the automation_runs / action-registry
-- path. A tenant authored those rules with a stacked FORM. This migration backs a
-- VISUAL node-graph authoring surface for the SAME rules.
--
-- The compiled rule REUSES automation_custom_rules — it is NOT a second engine and
-- NOT a second execution table. `compileWorkflowGraph` (lib/automation/
-- workflow-graph.ts) reduces a graph to the exact `CustomRuleDefinition` the form
-- builder produces, re-validated by the SAME injection boundary, and stores it in
-- automation_custom_rules.definition. This migration only adds:
--
--   1. Round-trip authoring state ON the existing rule row — the visual `graph`
--      (nodes + edges + canvas positions), the `graph_version`, whether the rule
--      was authored via the 'form' or 'visual' surface, and an `is_draft` flag the
--      compiler sets when the graph contains a DARK node (delay / ai-decision /
--      webhook) that has no live engine primitive yet, so nothing dark can ever be
--      enabled by accident.
--
--   2. automation_workflow_versions — an append-only VERSION HISTORY of a rule's
--      graph + the definition it compiled to, so an admin can see and restore prior
--      revisions. A pure audit/history table; the dispatcher never reads it.
--
-- TENANCY IS STRUCTURAL — org-pinned, cascade-on-org-delete, composite candidate
-- key, RLS member-read / admin-write (the automation_custom_rules doctrine). A
-- version row can only ever belong to, and be read within, its own organisation.
--
-- Additive + idempotent + reversible.

-- ── 1. Authoring state on the existing rule row ────────────────────────────────
-- All columns nullable / defaulted so existing form-built rows are untouched:
-- source defaults to 'form', graph stays null, graph_version 0, is_draft false.

alter table public.automation_custom_rules
  add column if not exists source text not null default 'form'
    check (source in ('form', 'visual'));

alter table public.automation_custom_rules
  add column if not exists graph jsonb;

alter table public.automation_custom_rules
  add column if not exists graph_version integer not null default 0
    check (graph_version >= 0);

alter table public.automation_custom_rules
  add column if not exists is_draft boolean not null default false;

comment on column public.automation_custom_rules.graph is
  'Visual node-graph (nodes+edges+positions) for the workflow builder. Null for form-built rules. The RUNNABLE artifact is always `definition`, compiled from this graph.';
comment on column public.automation_custom_rules.is_draft is
  'True when the graph contains a dark node (delay/ai-decision/webhook) with no live primitive. A draft is force-disabled so nothing dark runs.';

-- ── 2. Append-only version history for the visual builder ──────────────────────

create table if not exists public.automation_workflow_versions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  -- The rule this snapshot belongs to. Composite FK pins the parent's org too, so
  -- a version can never be reparented across a tenant boundary.
  custom_rule_id uuid not null,
  -- Monotonic per rule; unique below. 1-based.
  version        integer not null check (version >= 1),
  -- The authored graph and the definition it compiled to, captured together so a
  -- restore is a self-contained replay.
  graph          jsonb not null default '{}'::jsonb,
  compiled_definition jsonb not null default '{}'::jsonb,
  is_draft       boolean not null default false,
  note           text check (note is null or length(note) <= 500),
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint automation_workflow_versions_rule_fk
    foreign key (custom_rule_id, org_id)
    references public.automation_custom_rules (id, org_id) on delete cascade,
  constraint automation_workflow_versions_rule_version_key
    unique (custom_rule_id, version),
  constraint automation_workflow_versions_id_org_key unique (id, org_id)
);

create index if not exists automation_workflow_versions_rule_idx
  on public.automation_workflow_versions (custom_rule_id, version desc);
create index if not exists automation_workflow_versions_org_idx
  on public.automation_workflow_versions (org_id);

alter table public.automation_workflow_versions enable row level security;

drop policy if exists "automation_workflow_versions: members can select" on public.automation_workflow_versions;
create policy "automation_workflow_versions: members can select" on public.automation_workflow_versions
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "automation_workflow_versions: admins can insert" on public.automation_workflow_versions;
create policy "automation_workflow_versions: admins can insert" on public.automation_workflow_versions
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "automation_workflow_versions: admins can update" on public.automation_workflow_versions;
create policy "automation_workflow_versions: admins can update" on public.automation_workflow_versions
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "automation_workflow_versions: admins can delete" on public.automation_workflow_versions;
create policy "automation_workflow_versions: admins can delete" on public.automation_workflow_versions
  for delete to authenticated using (public.is_org_admin(org_id));
