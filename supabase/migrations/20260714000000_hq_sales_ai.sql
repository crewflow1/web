-- CrewFlow HQ — Sales AI Foundation (CEO Directive 003, Phase 1).
--
-- The first version of the CrewFlow Sales AI Platform. An HQ-only feature
-- that gives the "Sales AI" employee (and the human sales team) a master
-- company-intelligence database, permanent AI research reports, a
-- per-company contact timeline, AI recommendations, and a global activity
-- feed — all fully audited and traceable.
--
-- FOUNDATION ONLY. No model provider, embedding model, or autonomous
-- outreach is wired here. AI-authored artifacts (research reports,
-- recommendations, AI-logged timeline events) carry `generated_by`,
-- `model`, and `ai_employee_id` columns so every AI action is traceable,
-- but nothing in this migration calls an LLM.
--
-- HQ-ONLY: every table below has RLS ENABLED with NO policies, so only the
-- service-role client can see or touch these rows. The customer / staff
-- user-JWT client can never read sales intelligence. This mirrors the
-- Phase 1 ai_employee* tables, the Directive-002 hq_memory* tables, and
-- public.internal_notes (HQ-9). NO customer-facing surface changes.
--
-- Tables:
--   hq_sales_sources           extensible lead-source lookup (new sources = data)
--   hq_sales_companies         master company-intelligence record (source of truth)
--   hq_sales_contacts          decision makers / contacts per company
--   hq_sales_research_reports  permanent AI research reports
--   hq_sales_recommendations   AI sales recommendations per company
--   hq_sales_timeline_events   per-company chronological timeline + global feed
--
-- Sales Memory: research reports and timeline events carry an optional
-- `memory_id` FK into public.hq_memories so a close, an objection, or a
-- research finding can be promoted into the Directive-002 Shared Memory
-- Engine and become reusable company knowledge.

-- ---------------------------------------------------------------------
-- Extensible lead-source lookup. FK target so new provenance channels can
-- be added as DATA with no code change (mirrors hq_memory_sources).
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_sources (
  slug        text primary key check (slug ~ '^[a-z0-9_]{1,60}$'),
  label       text not null check (char_length(label) between 1 and 80),
  -- 'manual'      entered by a human in the HQ UI
  -- 'research'    discovered by the Sales AI during research
  -- 'integration' future external connectors (Companies House, LinkedIn, …)
  category    text not null default 'manual'
              check (category in ('manual', 'research', 'integration')),
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamp with time zone not null default now()
);

alter table public.hq_sales_sources enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- The master company-intelligence record — single source of truth.
--
-- Decision makers, email addresses, and phone numbers from the directive
-- are modelled relationally via public.hq_sales_contacts (one company has
-- many contacts); the company keeps a denormalised primary email/phone for
-- fast list display. organisation_id is a denormalised snapshot, NOT an FK
-- into tenant tables, to keep HQ fully decoupled from customer RLS.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_companies (
  id                uuid primary key default gen_random_uuid(),

  name              text not null check (char_length(name) between 1 and 300),
  -- Short AI/human-authored description, used for FTS weight C and cards.
  summary           text not null default '' check (char_length(summary) <= 4000),

  website           text check (website is null or char_length(website) <= 500),
  -- Normalised registrable domain (lowercased host) for dedupe + display.
  domain            text check (domain is null or char_length(domain) <= 255),

  industry          text check (industry is null or char_length(industry) <= 160),

  -- Size. employee_count is the precise figure when known; a band can be
  -- derived in the service/model layer for "search by Size".
  employee_count    integer check (employee_count is null or employee_count >= 0),
  -- Turnover (if available), stored in whole GBP for analytics roll-ups.
  annual_turnover_gbp bigint check (annual_turnover_gbp is null or annual_turnover_gbp >= 0),

  -- Geography. Both region and county are first-class because the directive
  -- requires "search by County" and "County analytics".
  location          text check (location is null or char_length(location) <= 300),
  region            text check (region is null or char_length(region) <= 160),
  county            text check (county is null or char_length(county) <= 160),
  country           text not null default 'United Kingdom'
                    check (char_length(country) between 1 and 120),

  -- Denormalised primary contact details (full list lives in contacts).
  primary_email     text check (primary_email is null or char_length(primary_email) <= 320),
  primary_phone     text check (primary_phone is null or char_length(primary_phone) <= 60),

  -- Social + registry links.
  linkedin_url      text check (linkedin_url is null or char_length(linkedin_url) <= 500),
  instagram_url     text check (instagram_url is null or char_length(instagram_url) <= 500),
  facebook_url      text check (facebook_url is null or char_length(facebook_url) <= 500),
  companies_house_url    text check (companies_house_url is null or char_length(companies_house_url) <= 500),
  companies_house_number text check (companies_house_number is null or char_length(companies_house_number) <= 40),

  -- Detected website technology stack (e.g. {shopify, hubspot, intercom}).
  website_technology text[] not null default '{}',

  -- Scores. Null = not scored yet (distinct from a genuine 0). 0–100.
  crm_score             integer check (crm_score is null or crm_score between 0 and 100),
  ai_qualification_score integer check (ai_qualification_score is null or ai_qualification_score between 0 and 100),

  -- Estimated annual contract value if won — drives "Pipeline value".
  estimated_deal_value_gbp bigint check (estimated_deal_value_gbp is null or estimated_deal_value_gbp >= 0),

  -- Pipeline funnel. Ordering is enforced in the model layer; the dashboard
  -- counts map 1:1 onto these statuses (Total = all rows).
  status            text not null default 'new'
                    check (status in (
                      'new',            -- captured, not yet qualified
                      'qualified',      -- AI/human qualified as a fit
                      'outreach_ready', -- research + angle prepared
                      'contacted',      -- first outbound sent
                      'replied',        -- prospect responded
                      'demo_booked',    -- demo scheduled
                      'won',            -- closed-won
                      'lost',           -- closed-lost after engagement
                      'disqualified'    -- not a fit; removed from funnel
                    )),

  -- Provenance. FK to the extensible source lookup.
  source            text not null default 'manual'
                    references public.hq_sales_sources(slug),

  -- Owning salesperson (snapshot email) — drives "Salesperson analytics".
  assigned_to_email text check (assigned_to_email is null or char_length(assigned_to_email) <= 320),

  tags              text[] not null default '{}',

  -- Last time the Sales AI (or a human) ran research on this company.
  last_researched_at timestamp with time zone,

  -- Author snapshot — row stays readable if the user is later deleted.
  created_by_id     uuid references public.users(id) on delete set null,
  created_by_email  text,

  -- Weighted full-text vector — generated, so it can never drift. Name is
  -- highest-weight; geography + industry next; summary lowest.
  search_tsv        tsvector generated always as (
                      setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
                      setweight(to_tsvector('english',
                        coalesce(industry, '') || ' ' ||
                        coalesce(location, '') || ' ' ||
                        coalesce(region, '')   || ' ' ||
                        coalesce(county, '')), 'B') ||
                      setweight(to_tsvector('english', coalesce(summary, '')), 'C')
                    ) stored,

  created_at        timestamp with time zone not null default now(),
  updated_at        timestamp with time zone not null default now()
);

alter table public.hq_sales_companies enable row level security;
-- NO policies → service-role only. Super-admin gating + audit happen in
-- the HQ-gated service/action layer, never via a customer-reachable JWT.

-- ---------------------------------------------------------------------
-- Contacts / decision makers — many per company.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_contacts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.hq_sales_companies(id) on delete cascade,

  full_name       text not null check (char_length(full_name) between 1 and 200),
  title           text check (title is null or char_length(title) <= 200),
  -- Decision-making seniority, for prioritising outreach.
  seniority       text not null default 'unknown'
                  check (seniority in ('c_level', 'director', 'manager', 'other', 'unknown')),

  email           text check (email is null or char_length(email) <= 320),
  phone           text check (phone is null or char_length(phone) <= 60),
  linkedin_url    text check (linkedin_url is null or char_length(linkedin_url) <= 500),

  is_primary       boolean not null default false,
  is_decision_maker boolean not null default true,

  notes           text not null default '' check (char_length(notes) <= 4000),

  created_by_email text,

  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(full_name, '')), 'A') ||
                    setweight(to_tsvector('english',
                      coalesce(title, '') || ' ' || coalesce(email, '')), 'B')
                  ) stored,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

alter table public.hq_sales_contacts enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- AI research reports — stored PERMANENTLY (never hard-deleted by the
-- service layer). Each report captures the full directive-specified shape.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_research_reports (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.hq_sales_companies(id) on delete cascade,

  -- Company summary.
  summary         text not null default '' check (char_length(summary) <= 8000),
  -- Pain points (array of discrete findings).
  pain_points     text[] not null default '{}',
  -- Likelihood of needing CrewFlow: 0–100 score + human-readable band.
  likelihood_score integer check (likelihood_score is null or likelihood_score between 0 and 100),
  likelihood_band  text not null default 'unknown'
                   check (likelihood_band in ('very_high', 'high', 'medium', 'low', 'unknown')),
  -- Estimated current software spend (whole GBP) + free-text rationale.
  estimated_software_spend_gbp bigint
                   check (estimated_software_spend_gbp is null or estimated_software_spend_gbp >= 0),
  estimated_spend_note text not null default '' check (char_length(estimated_spend_note) <= 2000),
  -- Best angle to lead with.
  best_angle      text not null default '' check (char_length(best_angle) <= 4000),
  -- Suggested opening line.
  opening_line    text not null default '' check (char_length(opening_line) <= 2000),
  -- Recommended follow-up.
  recommended_follow_up text not null default '' check (char_length(recommended_follow_up) <= 4000),
  -- Risk assessment + level.
  risk_assessment text not null default '' check (char_length(risk_assessment) <= 4000),
  risk_level      text not null default 'medium'
                  check (risk_level in ('low', 'medium', 'high', 'unknown')),

  -- Traceability — who/what produced this report.
  generated_by    text not null default 'ai'
                  check (generated_by in ('ai', 'human')),
  -- Free-form model identifier (e.g. 'claude-x', 'gpt-x') for AI reports.
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  authored_by_email text,

  status          text not null default 'final'
                  check (status in ('draft', 'final', 'archived')),

  -- Sales Memory bridge — set when this report is promoted into the
  -- Directive-002 Shared Memory Engine.
  memory_id       uuid references public.hq_memories(id) on delete set null,

  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(best_angle, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(summary, '')), 'B')
                  ) stored,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

alter table public.hq_sales_research_reports enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- AI recommendations — the directive's per-company "what to do" guidance.
-- Multiple allowed (history kept); the service returns the latest.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_recommendations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.hq_sales_companies(id) on delete cascade,

  -- Why they should buy.
  why_buy         text not null default '' check (char_length(why_buy) <= 4000),
  -- What features matter most.
  key_features    text[] not null default '{}',
  -- Likely objections.
  likely_objections text[] not null default '{}',
  -- Recommended pricing: human-readable + optional structured GBP/plan.
  recommended_pricing text not null default '' check (char_length(recommended_pricing) <= 2000),
  recommended_plan    text check (recommended_plan is null or char_length(recommended_plan) <= 120),
  recommended_price_gbp bigint check (recommended_price_gbp is null or recommended_price_gbp >= 0),
  -- Best salesperson (snapshot email or name).
  best_salesperson text check (best_salesperson is null or char_length(best_salesperson) <= 200),
  -- Best time to call.
  best_time_to_call text not null default '' check (char_length(best_time_to_call) <= 500),
  -- Suggested follow-up schedule: free text + optional structured steps.
  follow_up_schedule text not null default '' check (char_length(follow_up_schedule) <= 4000),
  follow_up_steps    jsonb,

  -- Traceability.
  generated_by    text not null default 'ai'
                  check (generated_by in ('ai', 'human')),
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  authored_by_email text,

  status          text not null default 'active'
                  check (status in ('draft', 'active', 'superseded', 'archived')),

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

alter table public.hq_sales_recommendations enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- Timeline events — the per-company chronological timeline AND the source
-- of the global Activity Feed (queried across all companies). Captures
-- human-logged interactions, AI actions, and lifecycle markers.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_timeline_events (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.hq_sales_companies(id) on delete cascade,
  contact_id      uuid references public.hq_sales_contacts(id) on delete set null,

  event_type      text not null check (event_type in (
                    -- Interactions (directive: Emails, Calls, LinkedIn,
                    -- Instagram, Notes, Meetings, Demos, Quotes, Follow-ups).
                    'email', 'call', 'linkedin', 'instagram', 'facebook',
                    'note', 'meeting', 'demo', 'quote', 'follow_up',
                    -- Lifecycle (directive Activity Feed: new companies,
                    -- AI research completed, …, deals won).
                    'created', 'research', 'recommendation',
                    'status_change', 'system'
                  )),
  -- Communication direction (meaningful for email/call/social).
  direction       text not null default 'internal'
                  check (direction in ('inbound', 'outbound', 'internal')),

  subject         text check (subject is null or char_length(subject) <= 300),
  body            text not null default '' check (char_length(body) <= 20000),
  -- Outcome of the interaction (e.g. replied / no_answer / positive).
  outcome         text check (outcome is null or char_length(outcome) <= 80),

  -- When it actually happened (may differ from created_at for back-fills).
  occurred_at     timestamp with time zone not null default now(),

  -- Traceability — human actor email, OR an AI employee, never both empty
  -- for a logged action (system events may have neither).
  actor_email     text,
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  source          text not null default 'manual'
                  references public.hq_sales_sources(slug),

  -- Structured extras (e.g. status_change carries {from, to}).
  metadata        jsonb,

  -- Sales Memory bridge — set when this interaction is promoted into the
  -- Shared Memory Engine (e.g. a logged objection becomes knowledge).
  memory_id       uuid references public.hq_memories(id) on delete set null,

  created_at      timestamp with time zone not null default now()
);

alter table public.hq_sales_timeline_events enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- Indexes — built for instant search, the funnel dashboard, and every
-- analytics facet the directive requires, at scale.
-- ---------------------------------------------------------------------

-- Company full-text search + array facets.
create index if not exists hq_sales_companies_search_idx
  on public.hq_sales_companies using gin (search_tsv);
create index if not exists hq_sales_companies_tags_idx
  on public.hq_sales_companies using gin (tags);
create index if not exists hq_sales_companies_tech_idx
  on public.hq_sales_companies using gin (website_technology);

-- Company filter / analytics facets.
create index if not exists hq_sales_companies_status_idx     on public.hq_sales_companies (status);
create index if not exists hq_sales_companies_industry_idx   on public.hq_sales_companies (industry);
create index if not exists hq_sales_companies_region_idx     on public.hq_sales_companies (region);
create index if not exists hq_sales_companies_county_idx     on public.hq_sales_companies (county);
create index if not exists hq_sales_companies_source_idx     on public.hq_sales_companies (source);
create index if not exists hq_sales_companies_assigned_idx   on public.hq_sales_companies (assigned_to_email);
create index if not exists hq_sales_companies_crm_score_idx  on public.hq_sales_companies (crm_score desc nulls last);
create index if not exists hq_sales_companies_ai_score_idx   on public.hq_sales_companies (ai_qualification_score desc nulls last);
create index if not exists hq_sales_companies_created_idx    on public.hq_sales_companies (created_at desc);
create index if not exists hq_sales_companies_researched_idx on public.hq_sales_companies (last_researched_at desc nulls last);
create index if not exists hq_sales_companies_domain_idx     on public.hq_sales_companies (lower(domain)) where domain is not null;

-- Partial index over the OPEN pipeline (drives pipeline-value roll-ups).
create index if not exists hq_sales_companies_open_pipeline_idx
  on public.hq_sales_companies (status)
  where status in ('new','qualified','outreach_ready','contacted','replied','demo_booked');

-- Contacts.
create index if not exists hq_sales_contacts_company_idx on public.hq_sales_contacts (company_id);
create index if not exists hq_sales_contacts_search_idx  on public.hq_sales_contacts using gin (search_tsv);
create index if not exists hq_sales_contacts_email_idx   on public.hq_sales_contacts (lower(email)) where email is not null;
create index if not exists hq_sales_contacts_primary_idx on public.hq_sales_contacts (company_id) where is_primary = true;

-- Research reports.
create index if not exists hq_sales_research_company_idx on public.hq_sales_research_reports (company_id, created_at desc);
create index if not exists hq_sales_research_status_idx  on public.hq_sales_research_reports (status);
create index if not exists hq_sales_research_search_idx  on public.hq_sales_research_reports using gin (search_tsv);

-- Recommendations.
create index if not exists hq_sales_reco_company_idx on public.hq_sales_recommendations (company_id, created_at desc);
create index if not exists hq_sales_reco_status_idx  on public.hq_sales_recommendations (company_id) where status = 'active';

-- Timeline / activity feed.
create index if not exists hq_sales_timeline_company_idx  on public.hq_sales_timeline_events (company_id, occurred_at desc);
create index if not exists hq_sales_timeline_feed_idx     on public.hq_sales_timeline_events (occurred_at desc);
create index if not exists hq_sales_timeline_type_idx     on public.hq_sales_timeline_events (event_type, occurred_at desc);
create index if not exists hq_sales_timeline_actor_idx    on public.hq_sales_timeline_events (actor_email);
create index if not exists hq_sales_timeline_ai_idx       on public.hq_sales_timeline_events (ai_employee_id) where ai_employee_id is not null;
create index if not exists hq_sales_timeline_contact_idx  on public.hq_sales_timeline_events (contact_id) where contact_id is not null;

-- ---------------------------------------------------------------------
-- updated_at touch trigger, shared by every mutable Sales AI table.
-- ---------------------------------------------------------------------

create or replace function public._hq_sales_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists hq_sales_companies_touch on public.hq_sales_companies;
create trigger hq_sales_companies_touch
  before update on public.hq_sales_companies
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_contacts_touch on public.hq_sales_contacts;
create trigger hq_sales_contacts_touch
  before update on public.hq_sales_contacts
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_research_touch on public.hq_sales_research_reports;
create trigger hq_sales_research_touch
  before update on public.hq_sales_research_reports
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_reco_touch on public.hq_sales_recommendations;
create trigger hq_sales_reco_touch
  before update on public.hq_sales_recommendations
  for each row execute function public._hq_sales_touch();

-- ---------------------------------------------------------------------
-- Seed the lead-source lookup. Required so company/timeline FK inserts
-- succeed out of the box. Idempotent — safe to re-run.
-- ---------------------------------------------------------------------

insert into public.hq_sales_sources (slug, label, category, sort_order) values
  ('manual',          'Manual entry',       'manual',      10),
  ('ai_research',     'AI research',         'research',    20),
  ('companies_house', 'Companies House',     'integration', 30),
  ('linkedin',        'LinkedIn',            'integration', 40),
  ('website',         'Website / inbound',   'manual',      50),
  ('referral',        'Referral',            'manual',      60),
  ('event',           'Event / conference',  'manual',      70),
  ('cold_list',       'Cold list / import',  'manual',      80),
  ('partner',         'Partner',             'manual',      90),
  ('other',           'Other',               'manual',     100)
on conflict (slug) do nothing;
