-- P3 Address-First Search: trigram indexes for fast substring search.
--
-- ===========================================================================
-- RENUMBERED: was 20260706120000_address_search_trgm.sql
-- ===========================================================================
-- This migration was authored on a long-lived branch (PR #136) and its original
-- version, 20260706120000, is FAR BEHIND the version already applied to
-- production (tip 20261040000000). It had never been applied anywhere. Landing
-- it under the old version would leave a permanent gap in the applied history —
-- `supabase migration list` would show a local-only migration ordered before
-- ~200 applied ones, and any tool that reconciles local vs remote history
-- (repair, diff, a fresh `db reset` compared against prod) would disagree about
-- what the schema is. Renumbered to 20261042000000, the next free slot after
-- the applied tip; 20261041000000 is reserved for a separate release train.
-- Nothing else about the migration changed as part of the renumber.
--
-- DUPLICATE INDEXES OMITTED as part of the same reconciliation
-- ---------------------------------------------------------------------------
-- While this branch sat, 20260709000000_scale_indexes.sql landed on main and
-- already created pg_trgm GIN indexes for several of the columns this file
-- originally covered. `create index if not exists` de-duplicates by NAME only,
-- and the two files use different naming conventions (`*_trgm` here vs
-- `*_trgm_idx` there) — so three statements would have silently built a SECOND,
-- byte-for-byte equivalent index on the same column: pure write amplification
-- and wasted storage for zero query benefit. They are therefore omitted here.
-- The columns are still fully trigram-covered, just by the earlier migration:
--
--   customers (name)     covered by customers_name_trgm_idx      (20260709)
--   leads     (postcode) covered by leads_postcode_trgm_idx      (20260709)
--   leads     (service)  covered by leads_service_trgm_idx       (20260709)
--
-- 20260709 additionally covers customers.email / customers.phone /
-- customers.notes / leads.source / quotes.number / invoices.number, none of
-- which this file ever indexed. What remains below is exactly the set of
-- address columns that no existing migration covers.
-- ===========================================================================
--
-- Tradespeople search by address, postcode, site name, unit/apartment number,
-- estate, road name, town and area far more often than by customer name. The
-- search paths (customers list, jobs list, leads kanban, global Cmd/K route)
-- run server-side `ILIKE '%term%'` filters across the structured address
-- columns added in 20260601000000_customer_job_addresses.sql +
-- 20260601000100_leads_contact_fields.sql.
--
-- A leading-wildcard `ILIKE '%term%'` cannot use a normal B-tree index, so at
-- scale every such query is a sequential scan. pg_trgm GIN indexes
-- (`gin (col gin_trgm_ops)`) make those substring matches index-backed, so the
-- search stays fast at 200+ customers and beyond. Note that for the planner to
-- use indexes across a multi-column OR, EVERY branch column needs its own trgm
-- index — which is why the address columns are indexed individually.
--
-- Scope of this migration:
--   * ADDITIVE ONLY. `create extension if not exists` + `create index if not
--     exists`. No table/column/constraint/policy is altered or removed. Safe to
--     re-run (idempotent) and safe to roll forward without a data migration.
--   * Indexed columns are the plain `text` address/identity columns that the
--     search filters target with a leading-wildcard ILIKE, minus anything
--     already covered by 20260709000000_scale_indexes.sql:
--       - customers: address_line1, address_line2, city, county, postcode
--       - jobs:      site_address_line1, site_address_line2, site_city,
--                    site_county, site_postcode
--       - leads:     contact_name
--   * customers.email is `citext` and customers.phone/notes are searched far
--     less selectively; they already have trgm indexes from 20260709 and are
--     not revisited here.
--
-- NOTE: created WITHOUT `concurrently` on purpose — Supabase runs each migration
-- inside a transaction, and `create index concurrently` is not allowed in a
-- transaction block. At launch data volumes the brief lock to build these
-- indexes is immaterial. If a table ever grows large enough that the build lock
-- matters, build the equivalent index out-of-band with `concurrently`.

create extension if not exists pg_trgm;

-- customers (structured address; `name` is already covered by
-- customers_name_trgm_idx from 20260709000000_scale_indexes.sql) -----------
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

-- jobs (site-address override) — no prior migration indexes these ----------
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

-- leads (`postcode` and `service` are already covered by
-- leads_postcode_trgm_idx / leads_service_trgm_idx from 20260709) ----------
create index if not exists leads_contact_name_trgm
  on public.leads using gin (contact_name gin_trgm_ops);
