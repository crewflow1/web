-- CrewFlow HQ — Shared Memory Engine seed (CEO Directive 002, Phase 2).
--
-- Seeds the extensible type + source lookups and a small set of example
-- memories (with relationships, employee links, and timeline events) so
-- the dashboard, search, detail, relationships, and audit views are
-- populated for review. Fully idempotent: lookups use
-- `on conflict (slug) do nothing`; example rows use fixed UUIDs with
-- `on conflict (id) do nothing`, so re-running never clobbers operator
-- edits or duplicates rows.

-- ---------------------------------------------------------------------
-- Memory types — the 16 from the directive. New types can be added
-- later by inserting another row here (or via a future admin UI); no
-- application code change is required.
-- ---------------------------------------------------------------------

insert into public.hq_memory_types
  (slug, label, description, icon, accent, default_department, sort_order)
values
  ('company',        'Company Memory',        'Mission, positioning, values, and company-level facts.',        'building',    'violet',  'executive',     10),
  ('product',        'Product Memory',        'Product capabilities, specs, and behavioural decisions.',       'package',     'indigo',  'product',       20),
  ('customer',       'Customer Memory',       'Account context, relationships, and customer-specific facts.',  'users',       'sky',     'support',       30),
  ('sales',          'Sales Memory',          'Pipeline insight, deal context, and objection handling.',       'trending-up', 'emerald', 'sales',         40),
  ('engineering',    'Engineering Memory',    'Architecture, standards, technical decisions, and risks.',      'cpu',         'sky',     'engineering',   50),
  ('marketing',      'Marketing Memory',      'Positioning, brand voice, campaigns, and growth learnings.',    'megaphone',   'pink',    'marketing',     60),
  ('finance',        'Finance Memory',        'Revenue models, billing facts, and financial decisions.',       'banknote',    'green',   'finance',       70),
  ('documentation',  'Documentation Memory',  'Internal and customer-facing documentation knowledge.',         'book-open',   'cyan',    'documentation', 80),
  ('meeting',        'Meeting Memory',        'Meeting notes, outcomes, and follow-up actions.',               'calendar',    'amber',   'executive',     90),
  ('decision',       'Decision Memory',       'Recorded decisions, rationale, and trade-offs.',                'gavel',       'fuchsia', 'executive',     100),
  ('deployment',     'Deployment Memory',     'Release and deployment reports, rollbacks, and incidents.',     'rocket',      'sky',     'engineering',   110),
  ('research',       'Research Memory',       'User research, experiments, and synthesised findings.',         'flask',       'indigo',  'product',       120),
  ('competitor',     'Competitor Memory',     'Competitive landscape, positioning, and intelligence.',         'crosshair',   'amber',   'marketing',     130),
  ('support',        'Support Memory',        'Recurring issues, resolutions, and support playbooks.',         'life-buoy',   'blue',    'support',       140),
  ('roadmap',        'Roadmap Memory',        'Roadmap items, priorities, and sequencing.',                    'map',         'violet',  'product',       150),
  ('knowledge_base', 'Knowledge Base Memory', 'Evergreen reference knowledge and how-tos.',                    'library',     'slate',   'documentation', 160)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- Sources — provenance channels. Manual + system are active now;
-- external integrations are seeded INACTIVE so the engine is ready to
-- plug them in later (GitHub, Slack, Twilio, Retell, Vapi, model
-- providers, …) without a schema change.
-- ---------------------------------------------------------------------

insert into public.hq_memory_sources (slug, label, category, is_active, sort_order)
values
  ('manual',            'Manual entry',        'manual',      true,  10),
  ('documentation',     'Documentation',       'manual',      true,  20),
  ('customer_feedback', 'Customer feedback',   'manual',      true,  30),
  ('sales_research',    'Sales research',      'manual',      true,  40),
  ('meeting_notes',     'Meeting notes',       'manual',      true,  50),
  ('roadmap',           'Roadmap',             'manual',      true,  60),
  ('system',            'System generated',    'system',      true,  70),
  ('product_decision',  'Product decision',    'system',      true,  80),
  ('release_notes',     'Release notes',       'system',      true,  90),
  ('deployment_report', 'Deployment report',   'system',      true,  100),
  -- Future external connectors (inactive until a later directive wires them).
  ('github',            'GitHub',              'integration', false, 200),
  ('slack',             'Slack',               'integration', false, 210),
  ('email',             'Email',               'integration', false, 220),
  ('notion',            'Notion',              'integration', false, 230),
  ('google_drive',      'Google Drive',        'integration', false, 240),
  ('crm',               'CRM',                 'integration', false, 250),
  ('support_ticket',    'Support tickets',     'integration', false, 260),
  ('voice_transcript',  'Voice transcripts',   'integration', false, 270),
  ('twilio',            'Twilio',              'integration', false, 280),
  ('retell',            'Retell',              'integration', false, 290),
  ('vapi',              'Vapi',                'integration', false, 300),
  ('claude',            'Claude',              'integration', false, 310),
  ('openai',            'OpenAI',              'integration', false, 320),
  ('gemini',            'Gemini',              'integration', false, 330)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- Example memories. Fixed UUIDs → idempotent. created_by_email is the
-- internal system account; these are illustrative seeds an operator can
-- edit or archive at will.
-- ---------------------------------------------------------------------

insert into public.hq_memories
  (id, title, summary, body, memory_type, department, importance, tags, keywords,
   created_by_email, source, visibility, confidence, status, pinned)
values
  (
    'b1000000-0000-0000-0000-000000000001',
    'CrewFlow positioning',
    'CrewFlow is the AI-powered operating system for service businesses — receptionist, jobs, and billing in one.',
    'CrewFlow gives small service businesses (trades, home services, clinics) an AI receptionist plus job management and billing in a single product. Core promise: never miss a call, never drop a job, get paid faster. Voice and tone: confident, plain-spoken, no jargon. Primary buyer: owner-operator.',
    'company', 'executive', 'high',
    array['positioning','brand','mission'], array['crewflow','positioning','service-business','receptionist'],
    'system@crewflow.uk', 'manual', 'public_hq', 95, 'active', true
  ),
  (
    'b1000000-0000-0000-0000-000000000002',
    'HQ build roadmap — CEO directives',
    'The CrewFlow HQ foundation is being built directive-by-directive: Phase 1 AI Employee Framework, Phase 2 Shared Memory Engine.',
    'Directive 001 (done): AI Employee Framework — the boardroom roster, framework only. Directive 002 (in progress): Shared Memory Engine — the company brain every AI employee reads from. Directive 003: TBD. Execution and provider connections remain gated behind future directives.',
    'roadmap', 'product', 'high',
    array['roadmap','hq','directives'], array['roadmap','directive','memory-engine','boardroom'],
    'system@crewflow.uk', 'roadmap', 'public_hq', 90, 'active', true
  ),
  (
    'b1000000-0000-0000-0000-000000000003',
    'Deployment: AI Employee Framework (Phase 1) shipped',
    'PR #163 merged to main and deployed to production — the HQ AI Boardroom went live, framework only.',
    'The AI Employee Framework shipped via PR #163 on 2026-06-17. Three HQ-only tables (ai_employees, ai_employee_tasks, ai_employee_memory) with RLS-no-policies. Execution stays locked (can_execute=false). Production verified healthy; customer surfaces unaffected.',
    'deployment', 'engineering', 'normal',
    array['deploy','phase-1','boardroom'], array['deployment','pr-163','ai-employee','framework'],
    'system@crewflow.uk', 'deployment_report', 'public_hq', 88, 'active', false
  ),
  (
    'b1000000-0000-0000-0000-000000000004',
    'Decision: Shared Memory is read-first for AI',
    'AI employees may only READ shared memory in Phase 2. All writes go through human-gated HQ actions and are audited + versioned.',
    'To keep the knowledge engine safe before any autonomous behaviour, Phase 2 is strictly read-first for AI employees. Humans (HQ super-admins) author and edit memories; every write is audited to admin_activity_log and snapshotted to hq_memory_versions. Granting AI write access is a separately-gated future phase.',
    'decision', 'executive', 'critical',
    array['decision','security','read-first'], array['decision','read-first','memory','security','audit'],
    'system@crewflow.uk', 'product_decision', 'public_hq', 92, 'active', true
  ),
  (
    'b1000000-0000-0000-0000-000000000005',
    'HQ table security pattern: RLS enabled, zero policies',
    'Every HQ-only table enables RLS with no policies, so only the service-role client can read or write. Customer JWTs see nothing.',
    'Pattern reused across internal_notes, the ai_employee* tables, and now the hq_memory* tables. RLS is enabled but no policies exist, which denies all access to anon/authenticated roles and leaves the service-role client (used only behind super-admin-gated server code) as the sole path. Defence-in-depth: the /admin layout 404s non-allowlisted users and every action re-checks isSuperAdminEmail.',
    'engineering', 'engineering', 'normal',
    array['security','rls','hq'], array['rls','security','service-role','hq-only'],
    'system@crewflow.uk', 'documentation', 'department', 90, 'active', false
  ),
  (
    'b1000000-0000-0000-0000-000000000006',
    'Competitive note: incumbents bolt AI onto legacy CRMs',
    'Most competitors add an AI add-on to a legacy field-service CRM; CrewFlow is AI-native from the call inward.',
    'Restricted competitive intel. Incumbent field-service tools treat AI as a bolt-on. CrewFlow''s wedge is the AI receptionist as the front door, feeding jobs and billing natively. Emphasise time-to-value and "never miss a call" in head-to-head positioning.',
    'competitor', 'marketing', 'normal',
    array['competitor','positioning','intel'], array['competitor','intel','positioning','ai-native'],
    'system@crewflow.uk', 'sales_research', 'restricted', 75, 'active', false
  )
on conflict (id) do nothing;

-- Restricted memory (m6) — explicit grants to marketing + sales departments.
insert into public.hq_memory_access_grants (memory_id, grantee_type, grantee_value, created_by_email)
values
  ('b1000000-0000-0000-0000-000000000006', 'department', 'marketing', 'system@crewflow.uk'),
  ('b1000000-0000-0000-0000-000000000006', 'department', 'sales',     'system@crewflow.uk')
on conflict (memory_id, grantee_type, grantee_value) do nothing;

-- Relationships — make the knowledge interconnected.
insert into public.hq_memory_relationships
  (id, memory_id, entity_type, entity_id, entity_label, relation, created_by_email)
values
  ('c1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000003', 'github_pr',    '163',           'PR #163 — AI Employee Framework',           'documents', 'system@crewflow.uk'),
  ('c1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 'roadmap_item', 'directive-002', 'CEO Directive 002 — Shared Memory Engine',  'tracks',    'system@crewflow.uk'),
  ('c1000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000004', 'feature',      'shared-memory', 'Shared Memory Engine',                      'informs',   'system@crewflow.uk')
on conflict (id) do nothing;

-- Memory <-> employee links — drive the read-only per-employee feed.
insert into public.hq_memory_employee_links (memory_id, ai_employee_id, link_kind, created_by_email)
select m.mid, e.id, m.kind, 'system@crewflow.uk'
from (values
  ('b1000000-0000-0000-0000-000000000001'::uuid, 'ceo-ai',         'pinned'),
  ('b1000000-0000-0000-0000-000000000002'::uuid, 'ceo-ai',         'relevant'),
  ('b1000000-0000-0000-0000-000000000002'::uuid, 'product-ai',     'pinned'),
  ('b1000000-0000-0000-0000-000000000003'::uuid, 'cto-ai',         'pinned'),
  ('b1000000-0000-0000-0000-000000000004'::uuid, 'cto-ai',         'relevant'),
  ('b1000000-0000-0000-0000-000000000005'::uuid, 'cto-ai',         'relevant'),
  ('b1000000-0000-0000-0000-000000000005'::uuid, 'qa-ai',          'relevant'),
  ('b1000000-0000-0000-0000-000000000006'::uuid, 'marketing-ai',   'pinned')
) as m(mid, slug, kind)
join public.ai_employees e on e.slug = m.slug
on conflict (memory_id, ai_employee_id, link_kind) do nothing;

-- Seed a 'created' timeline event per example memory (fixed UUIDs → idempotent).
insert into public.hq_memory_events (id, memory_id, event_type, actor_email, detail)
values
  ('e1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'created', 'system@crewflow.uk', '{"seed": true}'::jsonb),
  ('e1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 'created', 'system@crewflow.uk', '{"seed": true}'::jsonb),
  ('e1000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000003', 'created', 'system@crewflow.uk', '{"seed": true}'::jsonb),
  ('e1000000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000004', 'created', 'system@crewflow.uk', '{"seed": true}'::jsonb),
  ('e1000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000005', 'created', 'system@crewflow.uk', '{"seed": true}'::jsonb),
  ('e1000000-0000-0000-0000-000000000006', 'b1000000-0000-0000-0000-000000000006', 'created', 'system@crewflow.uk', '{"seed": true}'::jsonb)
on conflict (id) do nothing;
