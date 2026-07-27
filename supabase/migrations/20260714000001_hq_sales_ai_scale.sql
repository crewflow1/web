-- CrewFlow HQ — Sales AI Foundation, Scale Expansion (CEO Directive 003).
--
-- "Design once. Scale forever." This migration is the permanent foundation
-- for every future autonomous AI sales employee. It is PURELY ADDITIVE — the
-- live 20260714000000_hq_sales_ai.sql migration is never edited. Everything
-- here is idempotent (IF NOT EXISTS / on conflict do nothing / drop+recreate
-- constraints), so it is safe to re-run.
--
-- What it adds (foundation only — NO integrations, NO model calls, NO
-- autonomous execution; only the schema that future work will fill in):
--
--   1. Lookup tables (DATA not code):
--        hq_sales_channel_types     phone / email / linkedin / social / …
--        hq_sales_task_types        the kinds of work an AI employee performs
--        hq_sales_integrations      future external connectors (planned)
--   2. Company Intelligence columns — ~12 nullable reserved signals on
--      hq_sales_companies (revenue, growth, fleet/staff size, quality scores,
--      digital maturity, software used, a free-form enrichment bag).
--   3. hq_sales_locations  — multiple physical locations per company.
--   4. hq_sales_channels   — ONE polymorphic table for multiple phones,
--      emails, LinkedIn profiles, and social accounts, attachable to a
--      company, a contact, or a location.
--   5. hq_sales_ai_tasks   — the AI Task Queue foundation (pending/running/
--      completed/failed/cancelled, priority, retries, scheduling, timing,
--      error, payload/result). No worker runs yet.
--   6. hq_sales_external_records — future-integration link/snapshot store.
--   7. AI Timeline — widen hq_sales_timeline_events.event_type with every AI
--      action (researched, enriched, scored, email/LinkedIn generated+sent,
--      call completed, objection handled, demo booked/completed, follow-up
--      created, proposal generated, task lifecycle) + a generated search_tsv
--      so EVERYTHING is searchable.
--
-- HQ-ONLY: every new table has RLS ENABLED with NO policies → service-role
-- only. No customer-facing surface changes. AI-authorable rows carry the
-- generated_by / model / ai_employee_id traceability triad from day one.

-- ---------------------------------------------------------------------
-- 1. Lookup tables — "new types are DATA, not code".
-- ---------------------------------------------------------------------

-- Channel kinds: the vocabulary for hq_sales_channels.value. Category lets
-- the UI group "phone-like" vs "email" vs "social" without hard-coding slugs.
create table if not exists public.hq_sales_channel_types (
  slug        text primary key check (slug ~ '^[a-z0-9_]{1,60}$'),
  label       text not null check (char_length(label) between 1 and 80),
  -- Coarse grouping for UI + validation hints.
  category    text not null default 'other'
              check (category in ('phone', 'email', 'linkedin', 'social', 'web', 'messaging', 'other')),
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamp with time zone not null default now()
);
alter table public.hq_sales_channel_types enable row level security;
-- NO policies → service-role only.

-- Task kinds: what an AI employee can be asked to do. Adding a new capability
-- is an INSERT, never a deploy.
create table if not exists public.hq_sales_task_types (
  slug        text primary key check (slug ~ '^[a-z0-9_]{1,60}$'),
  label       text not null check (char_length(label) between 1 and 80),
  -- Coarse grouping: research / outreach / call / meeting / admin / memory.
  category    text not null default 'other'
              check (category in ('research', 'outreach', 'call', 'meeting', 'admin', 'memory', 'other')),
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamp with time zone not null default now()
);
alter table public.hq_sales_task_types enable row level security;
-- NO policies → service-role only.

-- Future integrations. status starts 'planned'; a connector flips to
-- 'connected' when its phase ships. NOTHING here makes a network call.
create table if not exists public.hq_sales_integrations (
  slug        text primary key check (slug ~ '^[a-z0-9_]{1,60}$'),
  label       text not null check (char_length(label) between 1 and 80),
  category    text not null default 'other'
              check (category in ('social', 'comms', 'registry', 'maps', 'crawler', 'other')),
  status      text not null default 'planned'
              check (status in ('planned', 'connected', 'disabled')),
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamp with time zone not null default now()
);
alter table public.hq_sales_integrations enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- 2. Company Intelligence — reserved, nullable signals. Null everywhere
--    today; future enrichment fills them in. Adding columns is additive
--    and non-breaking (every read lists columns explicitly).
-- ---------------------------------------------------------------------

alter table public.hq_sales_companies
  add column if not exists revenue_estimate_gbp bigint
    check (revenue_estimate_gbp is null or revenue_estimate_gbp >= 0),
  add column if not exists growth_score integer
    check (growth_score is null or growth_score between 0 and 100),
  add column if not exists construction_sector text
    check (construction_sector is null or char_length(construction_sector) <= 160),
  add column if not exists software_used text[] not null default '{}',
  add column if not exists estimated_software_spend_gbp bigint
    check (estimated_software_spend_gbp is null or estimated_software_spend_gbp >= 0),
  add column if not exists fleet_size integer
    check (fleet_size is null or fleet_size >= 0),
  add column if not exists staff_size integer
    check (staff_size is null or staff_size >= 0),
  add column if not exists website_quality_score integer
    check (website_quality_score is null or website_quality_score between 0 and 100),
  add column if not exists marketing_quality_score integer
    check (marketing_quality_score is null or marketing_quality_score between 0 and 100),
  add column if not exists hiring_activity_score integer
    check (hiring_activity_score is null or hiring_activity_score between 0 and 100),
  add column if not exists digital_maturity_score integer
    check (digital_maturity_score is null or digital_maturity_score between 0 and 100),
  -- Free-form reserved bag for any signal we have not promoted to a column.
  add column if not exists enrichment jsonb;

-- Intelligence facet indexes (sort/filter by score) — partial, null-aware.
create index if not exists hq_sales_companies_growth_idx
  on public.hq_sales_companies (growth_score desc nulls last);
create index if not exists hq_sales_companies_digital_idx
  on public.hq_sales_companies (digital_maturity_score desc nulls last);
create index if not exists hq_sales_companies_sector_idx
  on public.hq_sales_companies (construction_sector) where construction_sector is not null;
create index if not exists hq_sales_companies_software_idx
  on public.hq_sales_companies using gin (software_used);

-- ---------------------------------------------------------------------
-- 3. Locations — multiple physical sites per company.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_locations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.hq_sales_companies(id) on delete cascade,

  label           text check (label is null or char_length(label) <= 120),
  is_primary       boolean not null default false,
  is_headquarters  boolean not null default false,

  address_line1   text check (address_line1 is null or char_length(address_line1) <= 300),
  address_line2   text check (address_line2 is null or char_length(address_line2) <= 300),
  city            text check (city is null or char_length(city) <= 160),
  county          text check (county is null or char_length(county) <= 160),
  region          text check (region is null or char_length(region) <= 160),
  postcode        text check (postcode is null or char_length(postcode) <= 32),
  country         text not null default 'United Kingdom'
                  check (char_length(country) between 1 and 120),

  latitude        double precision check (latitude is null or latitude between -90 and 90),
  longitude       double precision check (longitude is null or longitude between -180 and 180),

  phone           text check (phone is null or char_length(phone) <= 60),
  notes           text not null default '' check (char_length(notes) <= 4000),

  -- Traceability — a location can be AI-discovered (e.g. Google Maps).
  generated_by    text not null default 'human'
                  check (generated_by in ('ai', 'human')),
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  created_by_email text,

  metadata        jsonb,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_locations enable row level security;
-- NO policies → service-role only.

create index if not exists hq_sales_locations_company_idx
  on public.hq_sales_locations (company_id);
create index if not exists hq_sales_locations_primary_idx
  on public.hq_sales_locations (company_id) where is_primary = true;
create index if not exists hq_sales_locations_county_idx
  on public.hq_sales_locations (county) where county is not null;
create index if not exists hq_sales_locations_region_idx
  on public.hq_sales_locations (region) where region is not null;

-- ---------------------------------------------------------------------
-- 4. Channels — ONE polymorphic table for multiple phones, emails,
--    LinkedIn profiles, and social accounts. Anchored to a company
--    (always) and optionally narrowed to a contact or a location. This
--    is the directive's "multiple of everything" without N per-type
--    tables: a new channel kind is a row in hq_sales_channel_types.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_channels (
  id              uuid primary key default gen_random_uuid(),
  -- Anchor: every channel rolls up to a company for fast lookups.
  company_id      uuid not null references public.hq_sales_companies(id) on delete cascade,
  -- Optional narrowing: this email/phone belongs to a specific contact …
  contact_id      uuid references public.hq_sales_contacts(id) on delete set null,
  -- … or a specific location (e.g. a depot switchboard).
  location_id     uuid references public.hq_sales_locations(id) on delete set null,

  channel_type    text not null references public.hq_sales_channel_types(slug),
  -- The actual address/number/URL/handle.
  value           text not null check (char_length(value) between 1 and 500),
  label           text check (label is null or char_length(label) <= 120),

  is_primary      boolean not null default false,
  is_verified     boolean not null default false,
  status          text not null default 'active'
                  check (status in ('active', 'inactive', 'invalid')),

  -- Traceability — a channel can be AI-discovered during enrichment.
  generated_by    text not null default 'human'
                  check (generated_by in ('ai', 'human')),
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  created_by_email text,

  metadata        jsonb,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_channels enable row level security;
-- NO policies → service-role only.

create index if not exists hq_sales_channels_company_idx
  on public.hq_sales_channels (company_id);
create index if not exists hq_sales_channels_contact_idx
  on public.hq_sales_channels (contact_id) where contact_id is not null;
create index if not exists hq_sales_channels_location_idx
  on public.hq_sales_channels (location_id) where location_id is not null;
create index if not exists hq_sales_channels_type_idx
  on public.hq_sales_channels (channel_type);
create index if not exists hq_sales_channels_primary_idx
  on public.hq_sales_channels (company_id, channel_type) where is_primary = true;
-- Dedupe guard: one value per (company, type) — case-insensitive.
create unique index if not exists hq_sales_channels_dedupe_idx
  on public.hq_sales_channels (company_id, channel_type, lower(value));

-- ---------------------------------------------------------------------
-- 5. AI Task Queue — the foundation for autonomous AI workers. NO worker
--    runs yet; this is the durable record every future executor will
--    poll, claim, and update. priority_rank is generated so the queue can
--    be ordered by an index, not a CASE at query time.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_ai_tasks (
  id              uuid primary key default gen_random_uuid(),
  -- Most tasks are company-scoped; nullable allows future global tasks
  -- (e.g. "scan for new companies") without a schema change.
  company_id      uuid references public.hq_sales_companies(id) on delete cascade,
  contact_id      uuid references public.hq_sales_contacts(id) on delete set null,

  task_type       text not null references public.hq_sales_task_types(slug),

  status          text not null default 'pending'
                  check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  priority        text not null default 'normal'
                  check (priority in ('low', 'normal', 'high', 'urgent')),
  -- Numeric rank for index-ordered dequeue (urgent first).
  priority_rank   integer generated always as (
                    case priority
                      when 'urgent' then 0
                      when 'high'   then 1
                      when 'normal' then 2
                      when 'low'    then 3
                      else 2
                    end
                  ) stored,

  retry_count     integer not null default 0 check (retry_count >= 0),
  max_retries     integer not null default 3 check (max_retries >= 0),

  assigned_ai_employee_id uuid references public.ai_employees(id) on delete set null,

  -- Lifecycle timing.
  scheduled_at    timestamp with time zone,  -- null = run as soon as possible
  started_at      timestamp with time zone,
  finished_at     timestamp with time zone,

  error_message   text check (error_message is null or char_length(error_message) <= 4000),

  -- Structured input / output for the worker.
  payload         jsonb,
  result          jsonb,

  -- Optional idempotency key — prevents double-queueing the same unit of
  -- work while it is still live (see partial-unique index below).
  dedupe_key      text check (dedupe_key is null or char_length(dedupe_key) <= 200),

  source          text not null default 'manual' references public.hq_sales_sources(slug),
  created_by_email text,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_ai_tasks enable row level security;
-- NO policies → service-role only.

-- The dequeue index: pending/running work, highest priority, earliest first.
create index if not exists hq_sales_ai_tasks_queue_idx
  on public.hq_sales_ai_tasks (status, priority_rank, scheduled_at nulls first, created_at);
create index if not exists hq_sales_ai_tasks_company_idx
  on public.hq_sales_ai_tasks (company_id) where company_id is not null;
create index if not exists hq_sales_ai_tasks_assigned_idx
  on public.hq_sales_ai_tasks (assigned_ai_employee_id) where assigned_ai_employee_id is not null;
create index if not exists hq_sales_ai_tasks_type_idx
  on public.hq_sales_ai_tasks (task_type, status);
create index if not exists hq_sales_ai_tasks_created_idx
  on public.hq_sales_ai_tasks (created_at desc);
-- One LIVE task per dedupe_key — re-queueing after completion is allowed.
create unique index if not exists hq_sales_ai_tasks_dedupe_idx
  on public.hq_sales_ai_tasks (dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');

-- ---------------------------------------------------------------------
-- 6. External records — future-integration link + snapshot store. When a
--    connector ships it writes the foreign id/url and a raw payload here,
--    linked back to the company/contact/location it enriched.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_external_records (
  id              uuid primary key default gen_random_uuid(),
  integration     text not null references public.hq_sales_integrations(slug),

  company_id      uuid references public.hq_sales_companies(id) on delete cascade,
  contact_id      uuid references public.hq_sales_contacts(id) on delete set null,
  location_id     uuid references public.hq_sales_locations(id) on delete set null,

  external_id     text check (external_id is null or char_length(external_id) <= 300),
  external_url    text check (external_url is null or char_length(external_url) <= 500),

  status          text not null default 'linked'
                  check (status in ('linked', 'stale', 'error')),

  payload         jsonb,
  synced_at       timestamp with time zone,

  created_by_email text,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_external_records enable row level security;
-- NO policies → service-role only.

create index if not exists hq_sales_external_company_idx
  on public.hq_sales_external_records (company_id) where company_id is not null;
create index if not exists hq_sales_external_integration_idx
  on public.hq_sales_external_records (integration, status);
-- One canonical link per (integration, external_id).
create unique index if not exists hq_sales_external_dedupe_idx
  on public.hq_sales_external_records (integration, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------
-- 7. AI Timeline — widen event_type so EVERY AI action is a permanent,
--    searchable timeline entry, then add a generated search_tsv + GIN.
-- ---------------------------------------------------------------------

-- Drop the original inline (auto-named) check and recreate it as a named
-- constraint covering the original interaction/lifecycle types PLUS every
-- AI action and task-lifecycle marker from the directive.
alter table public.hq_sales_timeline_events
  drop constraint if exists hq_sales_timeline_events_event_type_check;

alter table public.hq_sales_timeline_events
  add constraint hq_sales_timeline_events_event_type_check
  check (event_type in (
    -- Original interactions (human-loggable).
    'email', 'call', 'linkedin', 'instagram', 'facebook',
    'note', 'meeting', 'demo', 'quote', 'follow_up',
    -- Original lifecycle markers.
    'created', 'research', 'recommendation', 'status_change', 'system',
    -- NEW — AI actions (the autonomous sales engine's footprint).
    'enriched', 'scored',
    'email_generated', 'email_sent',
    'linkedin_generated', 'linkedin_sent',
    'call_completed', 'objection_handled',
    'demo_booked', 'demo_completed',
    'follow_up_created', 'proposal_generated',
    -- NEW — AI task-queue lifecycle.
    'task_scheduled', 'task_started', 'task_completed', 'task_failed'
  ));

-- Make the entire timeline full-text searchable ("everything searchable").
alter table public.hq_sales_timeline_events
  add column if not exists search_tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B') ||
    setweight(to_tsvector('english',
      coalesce(outcome, '') || ' ' || coalesce(event_type, '')), 'C')
  ) stored;

create index if not exists hq_sales_timeline_search_idx
  on public.hq_sales_timeline_events using gin (search_tsv);

-- ---------------------------------------------------------------------
-- 8. updated_at touch triggers for the new mutable tables (reuse the
--    shared public._hq_sales_touch() defined in the base migration).
-- ---------------------------------------------------------------------

drop trigger if exists hq_sales_locations_touch on public.hq_sales_locations;
create trigger hq_sales_locations_touch
  before update on public.hq_sales_locations
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_channels_touch on public.hq_sales_channels;
create trigger hq_sales_channels_touch
  before update on public.hq_sales_channels
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_ai_tasks_touch on public.hq_sales_ai_tasks;
create trigger hq_sales_ai_tasks_touch
  before update on public.hq_sales_ai_tasks
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_external_touch on public.hq_sales_external_records;
create trigger hq_sales_external_touch
  before update on public.hq_sales_external_records
  for each row execute function public._hq_sales_touch();

-- ---------------------------------------------------------------------
-- 9. Seed the lookups. Idempotent. New types are added here as DATA.
-- ---------------------------------------------------------------------

insert into public.hq_sales_channel_types (slug, label, category, sort_order) values
  ('phone',     'Phone',            'phone',     10),
  ('mobile',    'Mobile',           'phone',     20),
  ('email',     'Email',            'email',     30),
  ('linkedin',  'LinkedIn',         'linkedin',  40),
  ('instagram', 'Instagram',        'social',    50),
  ('facebook',  'Facebook',         'social',    60),
  ('twitter',   'X / Twitter',      'social',    70),
  ('tiktok',    'TikTok',           'social',    80),
  ('youtube',   'YouTube',          'social',    90),
  ('whatsapp',  'WhatsApp',         'messaging', 100),
  ('website',   'Website',          'web',       110),
  ('other',     'Other',            'other',     120)
on conflict (slug) do nothing;

insert into public.hq_sales_task_types (slug, label, category, sort_order) values
  ('research_company',  'Research company',     'research', 10),
  ('enrich_company',    'Enrich company',       'research', 20),
  ('score_company',     'Score company',        'research', 30),
  ('generate_email',    'Generate email',       'outreach', 40),
  ('send_email',        'Send email',           'outreach', 50),
  ('generate_linkedin', 'Generate LinkedIn DM', 'outreach', 60),
  ('send_linkedin',     'Send LinkedIn DM',     'outreach', 70),
  ('cold_call',         'Cold call',            'call',     80),
  ('handle_objection',  'Handle objection',     'call',     90),
  ('book_demo',         'Book demo',            'meeting',  100),
  ('run_demo',          'Run demo',             'meeting',  110),
  ('create_follow_up',  'Create follow-up',     'admin',    120),
  ('generate_proposal', 'Generate proposal',    'outreach', 130),
  ('promote_memory',    'Promote to memory',    'memory',   140),
  ('other',             'Other task',           'other',    150)
on conflict (slug) do nothing;

insert into public.hq_sales_integrations (slug, label, category, status, sort_order) values
  ('linkedin',        'LinkedIn',        'social',   'planned', 10),
  ('instagram',       'Instagram',       'social',   'planned', 20),
  ('email',           'Email',           'comms',    'planned', 30),
  ('twilio',          'Twilio',          'comms',    'planned', 40),
  ('whatsapp',        'WhatsApp',        'comms',    'planned', 50),
  ('companies_house', 'Companies House', 'registry', 'planned', 60),
  ('google_maps',     'Google Maps',     'maps',     'planned', 70),
  ('website_crawler', 'Website crawler', 'crawler',  'planned', 80)
on conflict (slug) do nothing;
