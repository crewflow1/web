-- Automation OS — human APPROVAL gate for custom rules.
--
-- WHAT THIS ADDS, AND WHY IT IS A SEPARATE TABLE
-- ----------------------------------------------
-- A custom rule (automation_custom_rules, 20261133000000) may place an APPROVAL
-- NODE among its ordered actions: actions before the node run the instant the
-- trigger fires; actions AFTER the node are held until a human approves. This
-- table is that hold — one pending row per (rule, event occurrence), created by
-- the dispatcher when it reaches the gate, decided by an admin, and — on approval
-- — the vehicle that carries the downstream actions forward to execution.
--
--   automation_approvals — a pending-approval gate. It snapshots the triggering
--     event (type/source/payload) and the DOWNSTREAM actions still to run, so the
--     approve step is a self-contained replay: no live event object is needed at
--     approval time. status advances pending → approved | rejected, once.
--
-- IDEMPOTENCY — TWO CLAIMS, MIRRORING THE DISPATCHER
-- --------------------------------------------------
--  1. CREATION is idempotent on (custom_rule_id, correlation_id): re-firing the
--     same event (webhook replay, retry) can only ever create ONE gate row —
--     ON CONFLICT DO NOTHING. correlation_id is the dispatcher's own
--     `<type>:<source_table>:<source_id>`, so it matches the run that created it.
--  2. THE DECISION is an atomic status transition: approve/reject is a conditional
--     UPDATE gated on `status = 'pending'`. Two admins racing the same row: Postgres
--     serialises on the row, exactly one flips it, the other updates 0 rows and is
--     a no-op. So the downstream actions run AT MOST ONCE.
--
-- TENANCY — org-pinned, cascade, composite candidate key (#456). Created by the
-- dispatcher under service-role (RLS-bypassing), decided by admins under RLS.
--
-- RLS — MEMBER-READ, ADMIN-WRITE. Every member sees what is awaiting approval;
-- only an admin may approve or reject. The insert policy is admin-gated for
-- symmetry (the engine writes via service-role, which bypasses RLS anyway).
--
-- NOT A LEDGER — this is transient runtime execution-gate state, the sibling of
-- automation_runs. It holds a payload snapshot that MIRRORS data already exported
-- via the source tables, so it is excluded from the GDPR bulk export the same way
-- automation_runs is (lib/gdpr/org-tables.json).
--
-- Additive + idempotent. Reversible: drop table public.automation_approvals;

create table if not exists public.automation_approvals (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  -- The rule whose approval node created this gate. Cascade so deleting a rule
  -- tidies its outstanding gates. Composite FK pins the child to the same org.
  custom_rule_id uuid not null,
  -- Snapshot of the rule's name at gate time, so the approvals UI reads cleanly
  -- even if the rule is later renamed or deleted.
  rule_name      text not null default '',
  -- The triggering event, snapshotted so approval is a self-contained replay.
  event_type     text not null,
  source_table   text not null,
  source_id      text not null,
  -- The dispatcher's correlation id: <type>:<source_table>:<source_id>. The
  -- idempotency key that ties this gate to the run that created it.
  correlation_id text not null,
  payload        jsonb not null default '{}'::jsonb,
  -- The DOWNSTREAM actions (those after the approval node) to run on approval.
  -- Validated JSON, re-sanitised in code before execution — never executed as-is.
  pending_actions jsonb not null default '[]'::jsonb,
  status         text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected')),
  decided_by     uuid references public.users(id) on delete set null,
  decided_at     timestamptz,
  note           text check (note is null or length(note) <= 500),
  -- Set once the approved downstream actions have executed (approve is: flip
  -- status, then run + stamp). NULL for pending/rejected.
  executed_at    timestamptz,
  execution_result jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- ONE gate per (rule, event occurrence) — the creation idempotency key.
  constraint automation_approvals_rule_corr_uniq unique (custom_rule_id, correlation_id),
  constraint automation_approvals_id_org_key unique (id, org_id),
  -- Composite FK: the gate and its rule are always the same org.
  constraint automation_approvals_rule_fk
    foreign key (custom_rule_id, org_id)
    references public.automation_custom_rules (id, org_id) on delete cascade
);

create index if not exists automation_approvals_org_idx
  on public.automation_approvals (org_id);
-- The approvals inbox: "everything pending for this org", newest first.
create index if not exists automation_approvals_pending_idx
  on public.automation_approvals (org_id, status, created_at desc);

drop trigger if exists automation_approvals_set_updated_at on public.automation_approvals;
create trigger automation_approvals_set_updated_at before update on public.automation_approvals
  for each row execute function public.tg_set_updated_at();

alter table public.automation_approvals enable row level security;

drop policy if exists "automation_approvals: members can select" on public.automation_approvals;
create policy "automation_approvals: members can select" on public.automation_approvals
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "automation_approvals: admins can insert" on public.automation_approvals;
create policy "automation_approvals: admins can insert" on public.automation_approvals
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "automation_approvals: admins can update" on public.automation_approvals;
create policy "automation_approvals: admins can update" on public.automation_approvals
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "automation_approvals: admins can delete" on public.automation_approvals;
create policy "automation_approvals: admins can delete" on public.automation_approvals
  for delete to authenticated using (public.is_org_admin(org_id));
