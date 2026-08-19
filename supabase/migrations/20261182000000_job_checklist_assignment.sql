-- Per-person task assignment on job checklists (W3 — CRM/jobs finisher).
--
-- THE GAP THIS CLOSES. job_checklists (20261132000000) is the crew's run-list,
-- but every item is anonymous: there is no way to say "Priya does the meter
-- reading by Friday". This migration adds the two fields that turn a shared list
-- into assignable work — an OWNER and a DUE DATE — and nothing else. Completion
-- provenance (is_done / done_by / done_at, stamped by the untouched
-- tg_job_checklist_completion trigger) is left exactly as it was: WHO ticked it
-- is still derived from the transition, never from the client. Assignment is a
-- DIFFERENT axis (who SHOULD do it) and does not touch that machinery.
--
-- ── WHY A MEMBERSHIP TRIGGER, NOT A LITERAL COMPOSITE FK TO memberships ──────
-- The natural instinct is a composite FK (org_id, assigned_to) → memberships
-- (org_id, user_id). We deliberately do NOT, for the same reason jobs.assigned_to
-- and leads.assigned_to don't (20261112000000):
--   · A composite FK to memberships can only ON DELETE CASCADE or NO ACTION.
--     CASCADE would DELETE a job's checklist item the moment the assignee is
--     offboarded — silent loss of the job's run-list history. NO ACTION would
--     BLOCK removing a member while they hold any assigned item, and worse would
--     RESTRICT org teardown (organizations → memberships cascade would hit the
--     reference) — the exact 20261052 teardown-safety lesson.
--   · SET NULL is impossible: the pair includes the NOT NULL org_id.
-- So assigned_to is a BARE FK to users(id) ON DELETE SET NULL (a deleted user
-- unassigns the item, the item survives), and the org-membership dimension is
-- enforced by the SAME blessed trigger the jobs/leads assignees already use:
-- public.tg_assignee_is_org_member() (20261112000000). It rejects — for every
-- writer, service-role included — an assigned_to that is not a member of the
-- row's own org, only when assigned_to or org_id actually changes. This is the
-- composite-FK guarantee (no cross-org assignee) with non-destructive,
-- teardown-safe delete semantics.
--
-- Additive, reversible, tenant-safe (org-scoped RLS already on the table;
-- assignee cross-org rejected by the trigger). To roll back:
--   drop trigger job_checklists_assignee_member_guard on public.job_checklists;
--   alter table public.job_checklists drop column assigned_to, drop column due_on;
-- Depends on: job_checklists (20261132000000), tg_assignee_is_org_member (20261112000000).

alter table public.job_checklists
  -- The person who SHOULD do this step. NULL = unassigned (the default; a plain
  -- shared item, exactly today's behaviour). Bare FK to users; org-membership is
  -- enforced by the trigger below. ON DELETE SET NULL preserves the item.
  add column if not exists assigned_to uuid references public.users(id) on delete set null,
  -- When it's due. A plain calendar date (no time-of-day — site work is
  -- day-grained). NULL = no deadline.
  add column if not exists due_on date;

comment on column public.job_checklists.assigned_to is
  'Optional owner of this checklist step (who SHOULD do it) — a member of the '
  'row''s org, enforced by tg_assignee_is_org_member. Distinct from done_by '
  '(who actually ticked it, stamped by the completion trigger). NULL = unassigned.';
comment on column public.job_checklists.due_on is
  'Optional due date for this checklist step. NULL = no deadline. Drives the '
  '"My tasks" list on /me (assigned-to-me, open, by due date).';

-- Drives the "My tasks" read on /me: assigned to a person, still open, by due
-- date. Partial on the open+assigned rows so the index stays small and the
-- worker's own task list resolves without scanning ticked/anonymous items.
create index if not exists job_checklists_assignee_open_idx
  on public.job_checklists (org_id, assigned_to, due_on)
  where assigned_to is not null and is_done = false;

-- Cross-tenant integrity: an assignee must be a member of the item's org. Reuses
-- the exact function jobs/leads use (it reads new.assigned_to + new.org_id, both
-- present here). BEFORE INSERT/UPDATE, so it cannot participate in a delete
-- cascade; runs only when the assignee or org actually changes.
drop trigger if exists job_checklists_assignee_member_guard on public.job_checklists;
create trigger job_checklists_assignee_member_guard
  before insert or update on public.job_checklists
  for each row execute function public.tg_assignee_is_org_member();
