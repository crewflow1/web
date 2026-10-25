-- Companies House FREE bulk-dataset sourcing — eligible-company POOL + import log.
--
-- Separates the SOURCE CATALOGUE (every qualifying NI construction company the
-- monthly free bulk dataset yields) from PROMOTED HQ SALES PROSPECTS (the small
-- deterministic weekly trickle the lead_sourcing worker pushes into
-- hq_sales_companies via the sanctioned createCompany door). The pool can hold
-- thousands of eligible companies cheaply; only ≤10/week are promoted, preserving
-- the existing controlled-sourcing philosophy and 10/week cap.
--
-- SECURITY: both tables are SERVICE-ROLE-ONLY — RLS enabled with NO row-level
-- policy and NO grant to anon/authenticated (identical posture to every other
-- hq_sales_* table, 20260714000000_hq_sales_ai.sql). The bulk importer (a
-- GitHub-Actions Node process) and the roster worker reach them only through the
-- service-role client (lib/supabase/admin.ts); the customer/staff user-JWT client
-- can never see sourcing intelligence. Because there is NO client-reachable
-- policy, the Data-API grant guard (__tests__/security/migration-data-api-grant-guard.test.ts)
-- does not flag these tables and no grant / no `data-api:exempt:` marker is needed.
--
-- Additive / forward-only. No data change to existing tables.

-- ── Eligible-company pool (the source catalogue) ──────────────────────────────
create table if not exists public.hq_sales_sourcing_pool (
  id                   uuid primary key default gen_random_uuid(),
  -- Stable external identity. UNIQUE here (unlike hq_sales_companies, which has
  -- no unique) so monthly re-imports UPSERT by company number — no duplicate pool rows.
  company_number       text not null unique
                         check (char_length(company_number) between 1 and 40),
  name                 text not null default '' check (char_length(name) <= 300),
  status               text check (char_length(status) <= 60),
  company_category     text check (char_length(company_category) <= 160),
  postcode             text check (char_length(postcode) <= 20),
  country              text check (char_length(country) <= 120),
  incorporation_date   date,
  -- All register SIC codes + the subset that matched the construction allowlist.
  sic_codes            text[] not null default '{}',
  matched_sic          text[] not null default '{}',
  -- This pipeline sources Northern Ireland only; recorded for provenance/filtering.
  geography            text not null default 'northern_ireland'
                         check (geography = 'northern_ireland'),
  -- Deterministic eligibility reason codes (active / ni_registered_office / construction_sic).
  reason_codes         text[] not null default '{}',
  -- Snapshot provenance: the monthly dataset date that FIRST and LAST saw this row.
  first_snapshot_date  date,
  last_snapshot_date   date,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  -- True while the company is still Active in the latest snapshot that saw it.
  active               boolean not null default true,
  -- Promotion state — flipped true once the weekly worker creates the prospect.
  promoted             boolean not null default false,
  promoted_at          timestamptz,
  promoted_company_id  uuid references public.hq_sales_companies(id) on delete set null,
  provenance           jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.hq_sales_sourcing_pool is
  'Service-role-only. Eligible NI construction companies from the free Companies House bulk dataset; the weekly lead_sourcing worker promotes <=10 un-promoted active rows into hq_sales_companies.';

alter table public.hq_sales_sourcing_pool enable row level security;
-- No policy on purpose: service-role only (createAdminClient). RLS-with-no-policy
-- denies every user-JWT (anon/authenticated) read/write.

-- The worker reads un-promoted active rows, newest snapshot first.
create index if not exists hq_sales_sourcing_pool_promotable_idx
  on public.hq_sales_sourcing_pool (active, promoted, last_snapshot_date desc)
  where active and not promoted;

-- ── Import run log (idempotency + provenance + row counts) ────────────────────
create table if not exists public.hq_sales_sourcing_imports (
  id               uuid primary key default gen_random_uuid(),
  -- One row per monthly snapshot; UNIQUE so a re-run of the same snapshot is a
  -- detectable no-op (idempotency) rather than a second pass.
  snapshot_date    date not null unique,
  source_file      text,
  status           text not null default 'running'
                     check (status in ('running', 'success', 'failed')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  -- Row-count telemetry across the streamed pass.
  scanned          bigint not null default 0,
  ni_matched       bigint not null default 0,
  sic_matched      bigint not null default 0,
  active_matched   bigint not null default 0,
  normalized       bigint not null default 0,
  inserted         bigint not null default 0,
  updated          bigint not null default 0,
  rejected         bigint not null default 0,
  error            text,
  created_at       timestamptz not null default now()
);

comment on table public.hq_sales_sourcing_imports is
  'Service-role-only. One row per monthly Companies House bulk-import run: idempotency (unique snapshot_date), status, and scanned/matched/inserted/updated/rejected counts.';

alter table public.hq_sales_sourcing_imports enable row level security;
-- No policy on purpose: service-role only.

create index if not exists hq_sales_sourcing_imports_recent_idx
  on public.hq_sales_sourcing_imports (started_at desc);
