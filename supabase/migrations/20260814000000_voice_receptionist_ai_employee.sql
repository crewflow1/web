-- CrewFlow HQ — Voice Receptionist AI, registered in the Capability Registry
-- (CEO Directive #018, the AI Receptionist Programme — increment R1).
--
-- This is the FIRST registry-native employee registration. Every earlier
-- employee (outreach-ai and before) was authored through the legacy
-- ai_employees.tools_allowed / permissions columns and translated into grants
-- by the 20260807 backfill. LR5.4B (20260812, the Data Removal Rule) DROPPED
-- those columns: the Capability Registry is now the SOLE authority, so a new
-- employee is authored by INSERTING its identity row AND its grant directly.
-- This migration is the reference for that path — the shape every future
-- customer-facing AI employee is registered by.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why this is DATA ONLY, and why NO new ADR precedes it
-- ───────────────────────────────────────────────────────────────────────────
-- Directive #018 asked whether a new architectural decision (ADR 0012) was
-- genuinely required before any code. The answer, on the repository evidence,
-- was NO: the Receptionist is built ENTIRELY within accepted architecture —
-- the Capability Registry (ADR 0010) is the authority model, approved-only
-- customer contact is already DB-enforced by the hq_communications trigger
-- (ADR 0003), and external dispatch is already the accepted irreversible class
-- routed to the future API gateway (ADR 0009 / #017). Governance is not minted
-- for process. So the programme begins with its lowest-risk increment: register
-- the employee in the registry. This migration adds NO table, NO policy, NO
-- function, NO trigger — no behaviour and no new attack surface. It seeds an
-- identity row and one grant, and is proved by a parity test against the live
-- runtime resolver.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why the grant is the DENY FLOOR (can_execute=false, requires_approval=true)
-- ───────────────────────────────────────────────────────────────────────────
-- Employee #26 is a Tier-T3 Channel employee: it captures and routes, but it
-- makes NO commitment, quote or booking, because a spoken word to a caller is
-- external and irreversible — it cannot be unsaid. The registry expresses that
-- posture natively: the grant is seeded at the default-deny FLOOR — can_execute
-- FALSE (Directive 001's execution lock is never unlocked by mere registration)
-- and requires_approval TRUE (every binding act is drafted for a human). The
-- token set is read + draft + memory only: it can READ context, DRAFT a record,
-- recall/write its ISOLATED memory, and SUBMIT drafts for approval. It is
-- granted NO send, commit, book or dispatch token — the T3 safety contract is
-- provable by ABSENCE, and the resolver serves exactly this locked authority.
--
-- Channel-specific tokens (phone / crm / calendar) are deliberately NOT minted
-- here: token names are immutable once set, so each is coined in the build
-- increment that earns it, not speculatively at registration.
--
-- Idempotent throughout: the identity insert is `on conflict (slug) do nothing`,
-- the catalogue ensure is `on conflict (token) do nothing`, and the grant is
-- guarded by `where not exists` — re-running never clobbers an operator edit.

-- 1. The employee identity ---------------------------------------------------
--    No tools_allowed / permissions columns (LR5.4B dropped them). model_provider
--    / model_name are left NULL: R1 registers the employee, it does not wire a
--    model — that belongs to the increment where the Receptionist first runs.
--    memory_scope 'isolated' mirrors the T3 posture and the grant below.
insert into public.ai_employees
  (name, slug, role, department, description, icon, accent, status,
   memory_scope, sort_order)
values
  (
    'Voice Receptionist AI', 'voice-receptionist-ai',
    'Reception — inbound call handling, enquiry capture and routing (captures and routes; never commits, quotes or books)',
    'support',
    'CrewFlow''s always-on front desk — the first customer-facing AI employee, and the reference implementation for every AI employee that follows. It answers inbound enquiries, understands what the caller wants, and either routes them to the right person or captures the enquiry as a structured record for a human to act on. It captures and routes autonomously, but it makes no commitment, quote or booking: anything that would bind CrewFlow — a price, a callback promise, an appointment — is drafted and handed to a human to approve. A spoken word to a caller is external and irreversible; it cannot be unsaid, so the Receptionist never says it without a human behind it. It never changes a customer record, never deletes anything, and never moves money. Its memory is isolated to its own work.',
    'phone', 'cyan', 'idle',
    'isolated', 120
  )
on conflict (slug) do nothing;

-- 2. Ensure the catalogue tokens the grant depends on ------------------------
--    All six already exist in hq_capabilities (seeded by the registry backfill),
--    so this is a defensive, idempotent guard that makes the migration's token
--    dependency explicit and self-contained: the grant's validate trigger rejects
--    any token absent from the catalogue, so we ensure presence before granting.
--    `on conflict (token) do nothing` keeps the established kinds untouched.
insert into public.hq_capabilities (token, kind, description) values
  ('read',                'scope',           'Read context the employee is permitted to see.'),
  ('draft',               'scope',           'Prepare a draft artifact for human review (never a final act).'),
  ('memory',              'scope',           'Access the employee''s own memory scope.'),
  ('recall_memory',       'tool_permission', 'Recall entries from the employee''s memory.'),
  ('write_memory',        'tool_permission', 'Write an entry to the employee''s memory.'),
  ('submit_for_approval', 'tool_permission', 'Submit a drafted artifact into the Approval Engine.')
on conflict (token) do nothing;

-- 3. The employee grant, at the default-deny FLOOR ---------------------------
--    can_execute FALSE, requires_approval TRUE, memory_scope 'isolated' — the
--    locked, approval-gated, isolated posture the T3 contract requires. The
--    validate trigger normalises `tokens` to a sorted-distinct set. Guarded by
--    `where not exists` on the (scope_level, scope_key) the partial unique index
--    covers, so a re-run is a no-op and an operator edit is never overwritten.
insert into public.hq_capability_grants
  (scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope)
select
  'employee', 'voice-receptionist-ai',
  array['read','draft','memory','recall_memory','write_memory','submit_for_approval'],
  false, true, 'isolated'
where not exists (
  select 1 from public.hq_capability_grants
  where scope_level = 'employee' and scope_key = 'voice-receptionist-ai'
);
