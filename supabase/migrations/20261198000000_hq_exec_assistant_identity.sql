-- CrewFlow HQ — Executive-Assistant identity (exec execution-path wave).
--
-- The exec execution-path wave gives all 13 EXECUTIVE employees a REAL, deterministic
-- Task-Engine execution path (server/services/hq-{role}-exec-runner.ts). Twelve of the
-- thirteen already have a seeded identity + a Capability-Registry grant:
--   ceo-ai, cto-ai (20260712000100); cfo-ai, coo-ai (20261128000000);
--   sales-ai, marketing-ai, product-ai, qa-ai, finance-ai, operations-ai,
--   support-ai (20260712000100); customer-success-ai (20261158000000).
-- The one function that had a Boardroom board but no seeded identity was the Executive
-- Assistant. This migration closes that last gap so the Executive-Assistant runner has
-- a seeded employee it can attribute its `exec_assistant_review` task to.
--
-- ───────────────────────────────────────────────────────────────────────────
-- FRAMEWORK ONLY — the new employee is DARK by construction
-- ───────────────────────────────────────────────────────────────────────────
-- This mirrors 20261158000000 / 20261128000000 EXACTLY: an identity row in
-- public.ai_employees plus ONE grant in the Capability Registry at the default-deny
-- FLOOR. The employee is seeded:
--   • can_execute = FALSE  — Directive 001's execution lock is never unlocked by mere
--                            registration; the gate refuses every proposed action while
--                            the posture floor holds.
--   • requires_approval = TRUE — every binding act is drafted for a human.
--   • model_provider / model_name = NULL — no employee is wired to a model. The
--                            deterministic exec runners shipped alongside this migration
--                            make NO model call; they COMPUTE and REPORT over the
--                            employee's own deterministic board and complete a task with
--                            an explainable, sourced review. Generative work stays dark.
--   • token set = read + draft + memory only — the minimal locked scope. NO
--                            send/commit/dispatch token is granted; the safety contract
--                            is provable by ABSENCE.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Provably additive + idempotent
-- ───────────────────────────────────────────────────────────────────────────
-- Adds NO table, NO policy, NO function, NO trigger — no new attack surface. It seeds
-- one identity row and one grant only. Every write is idempotent: the identity insert is
-- `on conflict (slug) do nothing`, the catalogue ensure is `on conflict (token) do
-- nothing`, and the grant is guarded by `where not exists` on (scope_level, scope_key),
-- so a re-run never clobbers an operator edit. The department is drawn only from the
-- existing ai_employees.department CHECK set (executive), so no constraint changes.

-- 1. The Executive-Assistant identity ---------------------------------------
--    Surviving columns only (LR5.4B / 20260812000000 dropped tools_allowed and
--    permissions — the Capability Registry is the sole authority). model_provider /
--    model_name left NULL: this employee is registered, not wired to a model.
insert into public.ai_employees
  (name, slug, role, department, description, icon, accent, status, memory_scope, sort_order)
values
  ('Executive Assistant AI', 'exec-assistant-ai',
   'Executive assistant — cross-queue triage of what needs the human now',
   'executive',
   'Holds the "what needs the human" picture across the HQ queues — open approvals, proposed and delayed decisions, overdue and stalled tasks, and open alerts — and drafts the prioritised digest for a human. It decides nothing, approves nothing, and touches no customer account.',
   'clipboard-list', 'violet', 'idle', 'organization', 300)
on conflict (slug) do nothing;

-- 2. Ensure the catalogue tokens the grant depends on -----------------------
--    read + draft + memory already exist (registry backfill / 20260814000000); this is a
--    defensive, idempotent guard so the token dependency is self-contained (the grant's
--    validate trigger rejects any token absent from the catalogue).
insert into public.hq_capabilities (token, kind, description) values
  ('read',   'scope', 'Read context the employee is permitted to see.'),
  ('draft',  'scope', 'Prepare a draft artifact for human review (never a final act).'),
  ('memory', 'scope', 'Access the employee''s own memory scope.')
on conflict (token) do nothing;

-- 3. The employee grant, at the default-deny FLOOR --------------------------
--    can_execute FALSE, requires_approval TRUE. Token set read+draft+memory only — no
--    send/commit/dispatch. Guarded by `where not exists` on (scope_level, scope_key), so
--    a re-run is a no-op and an operator edit is never overwritten. The validate trigger
--    normalises `tokens` to a sorted-distinct set.
insert into public.hq_capability_grants
  (scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope)
select
  'employee', v.slug, array['read','draft','memory'], false, true, v.memory_scope
from (values
  ('exec-assistant-ai', 'organization')
) as v(slug, memory_scope)
where not exists (
  select 1 from public.hq_capability_grants g
  where g.scope_level = 'employee' and g.scope_key = v.slug
);
