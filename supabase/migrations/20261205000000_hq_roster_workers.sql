-- CrewFlow HQ — Roster-worker execution paths (HQ AI workforce completion).
--
-- The employee-roster completion migration (20261128000000) registered the HQ roster at
-- the default-deny FLOOR with NO runner, so twelve identity-only roles rendered
-- "insufficient" on the Boardroom. This wave gives each of those twelve a REAL
-- deterministic EXECUTION PATH on the generic Task Engine (server/sdk/tasks.ts):
--
--   security-ai · devops-ai · database-ai · api-ai · documentation-ai · onboarding-ai ·
--   hr-ai · legal-compliance-ai · design-ai · orchestrator-ai · workflow-ai ·
--   memory-manager-ai
--
-- Each gets: a registered task type, a bounded SELECT-only read of a genuine existing data
-- source, a pure deterministic derivation (lib/hq/roster-workers.ts), and a cron
-- (app/api/cron/hq-roster-workers-tick) that enqueues + drains it through the canonical
-- runner SDK — so its card populates from a real hq_ai_tasks.result. The RUNNER lives in
-- code; this migration only re-asserts the governance floor those runners execute under.
--
-- ───────────────────────────────────────────────────────────────────────────
-- DARK by construction — a runner changes nothing about the safety contract
-- ───────────────────────────────────────────────────────────────────────────
-- Adding a runner does NOT lift the execution lock. Every worker:
--   • can_execute = FALSE, requires_approval = TRUE — the gate (server/sdk/gate.ts)
--     refuses every proposed action while the posture floor holds; a worker COMPUTES and
--     REPORTS a sourced result and nothing more. No send/commit/dispatch token is granted.
--   • model_provider / model_name = NULL — no worker is wired to a model. The derivations
--     are pure deterministic reads of real columns; generative (LLM) enrichment stays dark.
--   • Level-1 approval floor — every result carries approvalRequired=true; a human keeps
--     final approval, and no worker applies anything autonomously.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Provably additive + idempotent — no new attack surface
-- ───────────────────────────────────────────────────────────────────────────
-- Adds NO table, NO policy, NO function, NO trigger, and alters/drops NO column. The
-- twelve identities and their deny-floor grants ALREADY exist (20261128000000 and the
-- earlier 20260712000100 seed). This migration only DEFENSIVELY re-ensures the
-- deny-floor grant for each worker so its runner can never execute above the floor even if
-- an operator edit had removed a grant — a safety backstop, not a new authority. Every
-- write is guarded: the catalogue ensure is `on conflict (token) do nothing`, and each
-- grant is guarded by `where not exists` on (scope_level, scope_key) — so a re-run is a
-- no-op and an existing operator-authored grant (e.g. design-ai / documentation-ai carry
-- extra domain tokens) is NEVER overwritten.

-- 1. Ensure the deny-floor scope tokens the grants depend on (idempotent, defensive) -----
insert into public.hq_capabilities (token, kind, description) values
  ('read',   'scope', 'Read context the employee is permitted to see.'),
  ('draft',  'scope', 'Prepare a draft artifact for human review (never a final act).'),
  ('memory', 'scope', 'Access the employee''s own memory scope.')
on conflict (token) do nothing;

-- 2. Re-ensure each worker's deny-floor grant (can_execute FALSE, requires_approval TRUE,
--    read+draft+memory only). Guarded by `where not exists` on (scope_level, scope_key),
--    so this touches nothing that already has a grant — it is a pure safety backstop that
--    only fires if a grant is ever missing. memory_scope mirrors each identity's scope.
insert into public.hq_capability_grants
  (scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope)
select
  'employee', v.slug, array['read','draft','memory'], false, true, v.memory_scope
from (values
  ('security-ai',         'organization'),
  ('devops-ai',           'organization'),
  ('database-ai',         'organization'),
  ('api-ai',              'organization'),
  ('documentation-ai',    'organization'),
  ('onboarding-ai',       'department'),
  ('hr-ai',               'organization'),
  ('legal-compliance-ai', 'organization'),
  ('design-ai',           'department'),
  ('orchestrator-ai',     'global'),
  ('workflow-ai',         'organization'),
  ('memory-manager-ai',   'global')
) as v(slug, memory_scope)
where not exists (
  select 1 from public.hq_capability_grants g
  where g.scope_level = 'employee' and g.scope_key = v.slug
);
