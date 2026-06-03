-- P3 Address-First Search: trigram indexes for fast substring search.
--
-- Tradespeople search by address, postcode, site name, unit/apartment number,
-- estate, road name, town and area far more often than by customer name. The
-- search paths (customers list, jobs list, leads kanban, global Cmd/K route)
-- run server-side `ILIKE '%term%'` filters across the structured address
-- columns added in 20260601000000_customer_job_addresses.sql +
-- 20260601000000_leads_contact_fields.sql.
--
-- A leading-wildcard `ILIKE '%term%'` cannot use a normal B-tree index, so at
-- scale every such query is a sequential scan. pg_trgm GIN indexes
-- (`gin (col gin_trgm_ops)`) make those substring matches index-backed, so the
-- search stays fast at 200+ customers and beyond.
--
-- Scope of this migration:
--   * ADDITIVE ONLY. `create extension if not exists` + `create index if not
--     exists`. No table/column/constraint/policy is altered or dropped. Safe to
--     re-run (idempotent) and safe to roll forward without a data migration.
--   * Indexed columns are the plain `text` address/identity columns that the
--     search filters target with a leading-wildcard ILIKE:
--       - customers: name, address_line1, address_line2, city, county, postcode
--       - jobs:      site_address_line1, site_address_line2, site_city,
--                    site_county, site_postcode
--       - leads:     postcode, contact_name, service
--   * customers.email is `citext` and customers.phone/notes are searched far
--     less selectively; they keep plain ILIKE (a seq scan that is negligible at
--     launch scale). They can gain trigram indexes later if profiling warrants.
--
-- NOTE: created WITHOUT `concurrently` on purpose — Supabase runs each migration
-- inside a transaction, and `create index concurrently` is not allowed in a
-- transaction block. At launch data volumes the brief lock to build these
-- indexes is immaterial. If a table ever grows large enough that the build lock
-- matters, build the equivalent index out-of-band with `concurrently`.

create extension if not exists pg_trgm;

-- customers ---------------------------------------------------------------
create index if not exists customers_name_trgm
  on public.customers using gin (name gin_trgm_ops);
create index if not exists customers_address_line1_trgm
  on public.customers using gin (address_line1 gin_trgm_ops);
create index if not exists customers_address_line2_trgm
  on public.customers using gin (address_line2 gin_trgm_ops);
create index if not exists customers_city_trgm
  on public.customers using gin (city gin_trgm_ops);
create index if not exists customers_county_trgm
  on public.customers using gin (county gin_trgm_ops);
create index if not exists customers_postcode_trgm
  on public.customers using gin (postcode gin_trgm_ops);

-- jobs (site-address override) -------------------------------------------
create index if not exists jobs_site_address_line1_trgm
  on public.jobs using gin (site_address_line1 gin_trgm_ops);
create index if not exists jobs_site_address_line2_trgm
  on public.jobs using gin (site_address_line2 gin_trgm_ops);
create index if not exists jobs_site_city_trgm
  on public.jobs using gin (site_city gin_trgm_ops);
create index if not exists jobs_site_county_trgm
  on public.jobs using gin (site_county gin_trgm_ops);
create index if not exists jobs_site_postcode_trgm
  on public.jobs using gin (site_postcode gin_trgm_ops);

-- leads -------------------------------------------------------------------
create index if not exists leads_postcode_trgm
  on public.leads using gin (postcode gin_trgm_ops);
create index if not exists leads_contact_name_trgm
  on public.leads using gin (contact_name gin_trgm_ops);
create index if not exists leads_service_trgm
  on public.leads using gin (service gin_trgm_ops);
