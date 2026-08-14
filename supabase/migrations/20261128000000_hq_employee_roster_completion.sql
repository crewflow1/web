-- CrewFlow HQ — Employee roster completion (P2 HQ AI Operating System).
--
-- The HQ AI-OS shipped a real governance kernel, task engine, boardroom, memory and
-- decision centre, but only ~15 of the ~30 planned AI employees had a roster identity.
-- This migration completes the roster with the 15 remaining named roles so the whole
-- operating model is REPRESENTABLE — every function has an employee the platform can
-- reason about, render on the Boardroom, assign a task to, and (one day) authorise.
--
-- ───────────────────────────────────────────────────────────────────────────
-- FRAMEWORK ONLY — every new employee is DARK by construction
-- ───────────────────────────────────────────────────────────────────────────
-- This is the exact registry-native registration the Voice Receptionist migration
-- (20260814000000) established as the reference path: an identity row in
-- public.ai_employees plus ONE grant in the Capability Registry, at the default-deny
-- FLOOR. Every new employee here is seeded:
--   • can_execute = FALSE  — Directive 001's execution lock is never unlocked by mere
--                            registration; the gate (server/sdk/gate.ts) refuses every
--                            proposed action while the posture floor holds, so no new
--                            employee can act autonomously no matter what it proposes;
--   • requires_approval = TRUE — every binding act is drafted for a human;
--   • model_provider / model_name = NULL — no employee is wired to a model. Generative
--                            work stays governed and dark (lib/ai/governor); these
--                            employees advance only DETERMINISTIC work until a model
--                            tier is bound AND the execution lock is lifted, both of
--                            which are product decisions, never a migration.
--   • token set = read + draft + memory only — the minimal locked scope: read context,
--                            prepare a draft, use its own memory. NO send/commit/dispatch
--                            token is granted; the safety contract is provable by ABSENCE.
--
-- No runner is wired for any of these employees. They are roster + board + governed
-- identity — the framework — not autonomous actors. Adding a runner (registering a
-- task-type handler on the generic engine, server/sdk/tasks.ts) is a later, per-employee
-- increment that still cannot act while the grant sits at the deny floor.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Provably additive + idempotent
-- ───────────────────────────────────────────────────────────────────────────
-- Adds NO table, NO policy, NO function, NO trigger — no new attack surface. It seeds
-- identity rows and grants only. Every write is idempotent: the identity insert is
-- `on conflict (slug) do nothing`, the catalogue ensure is `on conflict (token) do
-- nothing`, and each grant is guarded by `where not exists` on the (scope_level,
-- scope_key) the partial unique index covers — so a re-run never clobbers an operator
-- edit. Departments are drawn only from the existing ai_employees.department CHECK set
-- (executive/engineering/finance/product/support/operations), so no constraint changes.

-- 1. The employee identities -------------------------------------------------
--    Surviving columns only (LR5.4B / 20260812000000 dropped tools_allowed and
--    permissions — the Capability Registry is the sole authority). model_provider /
--    model_name left NULL: these employees are registered, not wired to a model.
insert into public.ai_employees
  (name, slug, role, department, description, icon, accent, status, memory_scope, sort_order)
values
  ('COO AI', 'coo-ai',
   'Chief Operating Officer — cross-functional operational coordination and execution cadence',
   'executive',
   'Coordinates the operating rhythm across every department — surfacing where work is blocked, where cadence has slipped, and where two functions need to align. Advises and drafts; commits nothing without a human.',
   'building', 'indigo', 'idle', 'global', 130),

  ('CFO AI', 'cfo-ai',
   'Chief Financial Officer — financial strategy, controls and cash discipline',
   'finance',
   'Watches the money position — margins, cash runway, spend against budget — and drafts the financial view for strategic decisions. It never moves money and never commits spend; every figure is drafted for a human.',
   'coins', 'emerald', 'idle', 'organization', 140),

  ('Onboarding AI', 'onboarding-ai',
   'Customer onboarding — activation, first value and time-to-value',
   'support',
   'Shepherds a new customer from sign-up to first real value: what is set up, what is missing, and where activation has stalled. Drafts guidance and next steps; takes no action on the customer''s account.',
   'sparkles', 'amber', 'idle', 'department', 150),

  ('People & HR AI', 'hr-ai',
   'Human resources — workforce, people operations and internal wellbeing',
   'operations',
   'Keeps the internal picture of the workforce coherent — roles, capacity, and people-operations follow-ups. Drafts summaries and reminders for a human; it holds no authority over any person''s record.',
   'users', 'rose', 'idle', 'organization', 160),

  ('Legal & Compliance AI', 'legal-compliance-ai',
   'Legal and regulatory compliance oversight',
   'operations',
   'Tracks the platform''s compliance obligations and flags where a decision carries legal or regulatory weight. It advises and drafts; it never signs, accepts terms, or commits the business to anything.',
   'scale', 'slate', 'idle', 'organization', 170),

  ('Security AI', 'security-ai',
   'Application and platform security posture',
   'engineering',
   'Holds the security picture — what is exposed, what is hardened, and where a change touches the trust boundary. It reports and drafts findings for a human to act on; it changes no setting and grants no access.',
   'shield', 'red', 'idle', 'organization', 180),

  ('DevOps AI', 'devops-ai',
   'CI/CD, releases and infrastructure operations',
   'engineering',
   'Understands the release pipeline and infrastructure state — what is deploying, what is failing, and what is at risk. It drafts the operational read for a human; it triggers no deploy and touches no environment.',
   'infinity', 'cyan', 'idle', 'organization', 190),

  ('Database AI', 'database-ai',
   'Schema, migrations and data integrity',
   'engineering',
   'Reasons about the data model — schema shape, migration ordering, and integrity risk. It reviews and drafts recommendations; it runs no migration and mutates no data.',
   'database', 'violet', 'idle', 'organization', 200),

  ('API AI', 'api-ai',
   'API surface, contracts and integrations',
   'engineering',
   'Keeps the API contract picture coherent — surfaces, versions, and where an integration might break. It drafts contract notes for a human; it changes no endpoint and ships no breaking change.',
   'plug', 'teal', 'idle', 'organization', 210),

  ('Monitoring & Incident AI', 'monitoring-incident-ai',
   'Observability, alerting and incident response coordination',
   'operations',
   'Watches the health signals and, when something breaks, assembles the deterministic incident picture — what changed, what is affected, what to check first. It drafts the incident read; it resolves nothing on its own.',
   'activity', 'orange', 'idle', 'organization', 220),

  ('Orchestrator AI', 'orchestrator-ai',
   'Cross-employee task orchestration and routing',
   'executive',
   'The traffic controller of the AI workforce — it reads the shared task queue and reasons about which employee should hold which work. It drafts routing proposals; it enqueues nothing and commits no assignment autonomously.',
   'network', 'indigo', 'idle', 'global', 230),

  ('Memory Manager AI', 'memory-manager-ai',
   'Shared-memory curation, lifecycle and retention',
   'engineering',
   'Curates the company brain — what is worth remembering, what has gone stale, and what should be superseded. It drafts curation proposals; it forgets nothing and rewrites no memory without a human.',
   'brain', 'violet', 'idle', 'global', 240),

  ('Workflow AI', 'workflow-ai',
   'Multi-step workflow decomposition and sequencing',
   'operations',
   'Takes a large objective and reasons about the deterministic steps and dependencies to reach it. It drafts the plan; it launches no workflow and runs no step on its own.',
   'workflow', 'blue', 'idle', 'organization', 250),

  ('Notification AI', 'notification-ai',
   'Notification routing and delivery coordination',
   'operations',
   'Reasons about who needs to know what, and when — assembling the deterministic notification picture. It drafts the routing; it sends nothing without a human behind it.',
   'bell', 'amber', 'idle', 'department', 260),

  ('Analytics AI', 'analytics-ai',
   'Product and business analytics synthesis',
   'product',
   'Synthesises the numbers into a coherent read of how the product and business are doing. It reports and drafts the analytical view; every figure is drawn from real signals, and it fabricates nothing.',
   'chart', 'emerald', 'idle', 'organization', 270)
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
  ('coo-ai',                 'global'),
  ('cfo-ai',                 'organization'),
  ('onboarding-ai',          'department'),
  ('hr-ai',                  'organization'),
  ('legal-compliance-ai',    'organization'),
  ('security-ai',            'organization'),
  ('devops-ai',              'organization'),
  ('database-ai',            'organization'),
  ('api-ai',                 'organization'),
  ('monitoring-incident-ai', 'organization'),
  ('orchestrator-ai',        'global'),
  ('memory-manager-ai',      'global'),
  ('workflow-ai',            'organization'),
  ('notification-ai',        'department'),
  ('analytics-ai',           'organization')
) as v(slug, memory_scope)
where not exists (
  select 1 from public.hq_capability_grants g
  where g.scope_level = 'employee' and g.scope_key = v.slug
);
