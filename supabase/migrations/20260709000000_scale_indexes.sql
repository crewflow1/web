-- Scale hardening — indexes for 200-tenant steady-state volume.
--
-- Addresses two audit findings:
--   F-4  list/dashboard queries filter by org_id and order by created_at desc,
--        but customers/invoices/jobs have only single-column (org_id) indexes.
--        Postgres can satisfy the org filter from those, but then has to SORT
--        every matching row to honour `order by created_at desc`. A composite
--        (org_id, created_at desc) lets the planner walk the index in order.
--   F-5  global search (/api/search), the customers + leads list filters, and
--        the activity page all use leading-wildcard `ilike '%term%'`. A btree
--        cannot serve a leading wildcard, so today these do per-row scans within
--        the org. pg_trgm GIN indexes make `%term%` index-assisted.
--
-- SAFETY: these run as plain (in-transaction) CREATE INDEX, NOT CONCURRENTLY,
-- because at launch every target table is tiny (hundreds of rows) so the build
-- is sub-millisecond and the brief ACCESS EXCLUSIVE lock is immaterial. The
-- whole point is to land them BEFORE the data volume accrues. If any of these
-- ever has to be (re)built on a large, live table later, do it by hand with
-- CREATE INDEX CONCURRENTLY outside a transaction (same pattern noted in
-- 20260706000000_support_tickets_customer_scope.sql).

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- F-4 — (org_id, created_at desc) composites for the list/dashboard ordering.
-- quotes already has quotes_org_id_status_created_at_idx and leads already has
-- leads_org_id_status_last_activity_at_idx, so they are intentionally omitted.
-- ---------------------------------------------------------------------------
create index if not exists customers_org_created_idx
  on public.customers (org_id, created_at desc);

create index if not exists invoices_org_created_idx
  on public.invoices (org_id, created_at desc);

create index if not exists jobs_org_created_idx
  on public.jobs (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- F-5 — trigram GIN indexes for the columns hit by `ilike '%term%'`.
-- The global search ORs several columns per table; for the planner to use an
-- index for the whole OR, every OR-branch column needs its own trgm index,
-- hence all of name/email/phone/notes on customers and service/source on leads.
-- ---------------------------------------------------------------------------

-- customers — global search + customers list (lib/customers/list.ts)
create index if not exists customers_name_trgm_idx
  on public.customers using gin (name gin_trgm_ops);
create index if not exists customers_email_trgm_idx
  on public.customers using gin (email gin_trgm_ops);
create index if not exists customers_phone_trgm_idx
  on public.customers using gin (phone gin_trgm_ops);
create index if not exists customers_notes_trgm_idx
  on public.customers using gin (notes gin_trgm_ops);

-- quotes / invoices — number search (global search)
create index if not exists quotes_number_trgm_idx
  on public.quotes using gin (number gin_trgm_ops);
create index if not exists invoices_number_trgm_idx
  on public.invoices using gin (number gin_trgm_ops);

-- leads — service/source (global search) + postcode (leads list filter)
create index if not exists leads_service_trgm_idx
  on public.leads using gin (service gin_trgm_ops);
create index if not exists leads_source_trgm_idx
  on public.leads using gin (source gin_trgm_ops);
create index if not exists leads_postcode_trgm_idx
  on public.leads using gin (postcode gin_trgm_ops);

-- NOTE (deliberate omission): activity/page.tsx searches activity_log.actor_name
-- with `ilike '%term%'`. activity_log is the highest-write table in the system
-- (a row per audited action) and that search is a low-frequency admin
-- convenience, so a GIN index there would tax every write for little benefit.
-- Left unindexed on purpose; the existing (org_id, created_at) index bounds the
-- scan. Revisit only if actor search becomes a hot path.
