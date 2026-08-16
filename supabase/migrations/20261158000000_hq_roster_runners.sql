-- CrewFlow HQ — Roster runners: the two missing identities (MP Wave R3).
--
-- The HQ AI-OS roster completion (20261128000000) registered the ~15 remaining named
-- roles, but two functions the platform already RUNS code for still had no employee
-- identity: Customer Success (a hq-customer-success service exists with no roster row)
-- and Engineering Management. This migration closes that last gap so EVERY function the
-- OS reasons about has an employee it can render on the Boardroom, assign a task to,
-- and (one day) authorise — the roster is finally exhaustive.
--
-- ───────────────────────────────────────────────────────────────────────────
-- FRAMEWORK ONLY — both new employees are DARK by construction
-- ───────────────────────────────────────────────────────────────────────────
-- This mirrors 20261128000000 EXACTLY (itself the Voice-Receptionist reference path):
-- an identity row in public.ai_employees plus ONE grant in the Capability Registry at
-- the default-deny FLOOR. Both new employees are seeded:
--   • can_execute = FALSE  — Directive 001's execution lock is never unlocked by mere
--                            registration; the gate (server/sdk/gate.ts) refuses every
--                            proposed action while the posture floor holds.
--   • requires_approval = TRUE — every binding act is drafted for a human.
--   • model_provider / model_name = NULL — no employee is wired to a model. The
--                            deterministic runners shipped alongside this migration
--                            (server/services/hq-*-runner.ts) make NO model call; they
--                            COMPUTE and REPORT over real data sources and complete a
--                            task on the existing engine. Generative work stays dark.
--   • token set = read + draft + memory only — the minimal locked scope. NO
--                            send/commit/dispatch token is granted; the safety contract
--                            is provable by ABSENCE.
--
-- The deterministic runners this wave adds are wired for EXISTING employees only
-- (analytics-ai, monitoring-incident-ai, notification-ai) and drive the generic Task
-- Engine (server/sdk/tasks.ts) — none can act while its grant sits at the deny floor,
-- because the runners take no irreversible action: they read, derive, and complete a
-- task with an explainable result. These two new identities get NO runner yet; they are
-- roster + board + governed identity — the framework — not autonomous actors.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Provably additive + idempotent
-- ───────────────────────────────────────────────────────────────────────────
-- Adds NO table, NO policy, NO function, NO trigger — no new attack surface. It seeds
-- identity rows and grants only. Every write is idempotent: the identity insert is
-- `on conflict (slug) do nothing`, the catalogue ensure is `on conflict (token) do
-- nothing`, and each grant is guarded by `where not exists` on (scope_level, scope_key),
-- so a re-run never clobbers an operator edit. Departments are drawn only from the
-- existing ai_employees.department CHECK set (support/engineering), so no constraint
-- changes.

-- 1. The two employee identities --------------------------------------------
--    Surviving columns only (LR5.4B / 20260812000000 dropped tools_allowed and
--    permissions — the Capability Registry is the sole authority). model_provider /
--    model_name left NULL: these employees are registered, not wired to a model.
insert into public.ai_employees
  (name, slug, role, department, description, icon, accent, status, memory_scope, sort_order)
values
  ('Customer Success AI', 'customer-success-ai',
   'Customer success — retention, adoption and account health',
   'support',
   'Holds the post-onboarding picture of every account — who is healthy, who is drifting, and where an intervention is due. It synthesises real account signals and drafts the success read for a human; it touches no customer account and commits nothing.',
   'life-buoy', 'amber', 'idle', 'organization', 280),

  ('Eng Manager AI', 'eng-manager-ai',
   'Engineering management — delivery cadence, throughput and team coordination',
   'engineering',
   'Keeps the engineering delivery picture coherent — what is in flight, where throughput has slipped, and where coordination is needed. It drafts the delivery read for a human; it ships no code and merges nothing.',
   'users', 'blue', 'idle', 'organization', 290)
on conflict (slug) do nothing;

-- 2. Ensure the catalogue tokens the grants depend on ------------------------
--    read + draft + memory already exist (registry backfill / 20260814000000), so this
--    is a defensive, idempotent guard making the token dependency self-contained: the
--    grant's validate trigger rejects any token absent from the catalogue.
insert into public.hq_capabilities (token, kind, description) values
  ('read',   'scope', 'Read context the employee is permitted to see.'),
  ('draft',  'scope', 'Prepare a draft artifact for human review (never a final act).'),
  ('memory', 'scope', 'Access the employee''s own memory scope.')
on conflict (token) do nothing;

-- 3. The employee grants, at the default-deny FLOOR --------------------------
--    can_execute FALSE, requires_approval TRUE. Token set read+draft+memory only — no
--    send/commit/dispatch. memory_scope mirrors each identity. Set-based + guarded by
--    `where not exists` on (scope_level, scope_key), so a re-run is a no-op and an
--    operator edit is never overwritten. The validate trigger normalises `tokens` to a
--    sorted-distinct set.
insert into public.hq_capability_grants
  (scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope)
select
  'employee', v.slug, array['read','draft','memory'], false, true, v.memory_scope
from (values
  ('customer-success-ai', 'organization'),
  ('eng-manager-ai',      'organization')
) as v(slug, memory_scope)
where not exists (
  select 1 from public.hq_capability_grants g
  where g.scope_level = 'employee' and g.scope_key = v.slug
);
