-- Deny-floor Capability Registry grants for the wave-2 roster cohort
-- (roadmap/final-completion consolidation; supersedes 20261225's "no grants"
-- design note).
--
-- 20261225 seeded the eleven product-mapped identities WITHOUT employee-scoped
-- grants, reasoning that the registry's implicit default-deny floor is the
-- honest posture for an identity with no runner. That reasoning conflicts with
-- the registry's own pinned invariant (R2 backfill completeness / LR5.3
-- registry-only operation, integration-enforced): EVERY non-retired employee
-- must be served FROM the registry by an EXPLICIT employee grant — the floor
-- is the automatic fail-safe, never the steady-state posture. The precedent is
-- 20261205 (roster workers): an explicit deny-floor grant row per identity —
-- can_execute FALSE, requires_approval TRUE, read/draft/memory tokens only —
-- which serves the IDENTICAL posture the floor would, but from the registry,
-- auditable and individually revocable.
--
-- memory_scope mirrors each identity's ai_employees.memory_scope (20261225).
-- Idempotent: guarded by `where not exists` on (scope_level, scope_key).
-- Rollback:
--   delete from public.hq_capability_grants
--   where scope_level = 'employee' and scope_key in (…the eleven slugs…);

insert into public.hq_capability_grants
  (scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope)
select
  'employee', v.slug, array['read','draft','memory'], false, true, v.memory_scope
from (values
  ('whatsapp-ai',       'department'),
  ('email-ai',          'department'),
  ('scheduler-ai',      'department'),
  ('quote-writer-ai',   'department'),
  ('cashflow-ai',       'department'),
  ('payroll-ai',        'department'),
  ('business-coach-ai', 'organization'),
  ('site-manager-ai',   'department'),
  ('blueprint-ai',      'department'),
  ('procurement-ai',    'department'),
  ('intelligence-ai',   'organization')
) as v(slug, memory_scope)
where not exists (
  select 1 from public.hq_capability_grants g
  where g.scope_level = 'employee' and g.scope_key = v.slug
);
