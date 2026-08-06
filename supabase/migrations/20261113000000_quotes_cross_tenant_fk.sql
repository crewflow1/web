-- Cross-tenant reference integrity for QUOTES (hostile-audit 🔴).
--
-- The problem — a WORSE sibling of the jobs/leads miss (20261112000000)
-- ---------------------------------------------------------------------
-- quotes.customer_id / property_id / lead_id / job_id are all BARE single-column
-- FKs to the GLOBAL parent tables. The only tenant guard on the write path is
-- `.eq("org_id", ctx.org.id)` on the ROW being written — which constrains the
-- org_id the caller supplies, never the customer/property/lead/job the row POINTS
-- AT. So a caller working in org A can attach org B's customer_id to an org A
-- quote. RLS cannot express this: it guards the row being written, not the FK
-- target. This is the invoices/#349 + jobs-leads/#? (20261112000000) defect
-- class, now closed for QUOTES.
--
-- Why quotes is WORSE than jobs/leads
-- -----------------------------------
-- A quote renders on a PUBLIC, unauthenticated, service-role route:
--   * app/q/[token]/page.tsx      → createAdminClient() (RLS BYPASS), embeds
--                                    customer:customers(id, name, email)
--   * app/q/[token]/pdf/route.ts  → createAdminClient(), embeds
--                                    customer:customers(name)
-- An org-A member attaching an org-B customer_id therefore renders that FOREIGN
-- customer's name + email on an attacker-controlled public token URL — a
-- cross-tenant PII leak, not merely an internal integrity slip. The same bare FK
-- is also read by the quote-followup cron (which EMAILS the quote's customer) and
-- the invoice-reminders cron. The composite FK below closes all of them at once,
-- for EVERY writer regardless of role — the service-role/admin client included.
--
-- The shape — mirrors jobs/leads (20261112000000) and invoices (20260915000000)
-- ----------------------------------------------------------------------------
--   customer_id: COMPOSITE FK (customer_id, org_id) -> customers (id, org_id).
--   property_id: COMPOSITE FK (property_id, org_id) -> properties (id, org_id).
--   lead_id:     COMPOSITE FK (lead_id, org_id)     -> leads (id, org_id).
--   job_id:      COMPOSITE FK (job_id, org_id)      -> jobs (id, org_id).
-- Each makes "a quote's <ref> must live in the quote's org" a DATABASE
-- invariant, enforced by Postgres for every writer.
--
-- Parent candidate keys
-- ---------------------
-- customers already carries customers_id_org_key (id, org_id) (20260915000000);
-- jobs already carries jobs_id_org_key (id, org_id) (20261112-era). properties
-- and leads do NOT yet have an (id, org_id) unique key, so section 1 ADDS them.
-- Their id is already the PK, so UNIQUE(id, org_id) is always satisfiable and
-- safe — it adds the second column a composite FK needs as its target.
--
-- ON DELETE semantics are PRESERVED per column (baseline 00000000000000)
-- ---------------------------------------------------------------------
--   customer_id: NOT NULL, bare FK had NO ON DELETE (NO ACTION / restrict) — a
--     customer with quotes cannot be deleted. Kept: the composite FK carries no
--     ON DELETE clause, so NO ACTION survives. (A SET NULL is impossible anyway —
--     customer_id is NOT NULL.)
--   property_id / lead_id / job_id: nullable, bare FKs were ON DELETE SET NULL. A
--     plain composite `on delete set null` would try to null BOTH the ref column
--     AND org_id, and org_id is NOT NULL — which would ABORT every parent delete.
--     So we use the PG15+ column-list form `on delete set null (<col>)` — only the
--     ref column is nulled, the NOT NULL org_id survives. (Same idiom as
--     20261112000000's jobs/leads FKs and 20261084000000's evidence links.) All
--     three columns are nullable and the composite FK uses MATCH SIMPLE, so a NULL
--     ref is never checked — a quote with no property/lead/job stays valid.
--
-- Prod-data safety — MEASURED (linked project jzntbskdqdopzwdqwvkp, read-only):
-- 0 quotes with a cross-org customer_id, property_id, lead_id, or job_id. So all
-- four FK swaps apply cleanly against live data.
--
-- Additive and reversible:
--   alter table public.quotes drop constraint quotes_customer_org_fkey;
--   alter table public.quotes drop constraint quotes_property_org_fkey;
--   alter table public.quotes drop constraint quotes_lead_org_fkey;
--   alter table public.quotes drop constraint quotes_job_org_fkey;
--   -- (optionally restore the bare FKs from the baseline / variation_orders mig)

-- ── 1. parent candidate keys the composite FKs target ───────────────────────
-- customers_id_org_key + jobs_id_org_key already exist; properties + leads need
-- theirs added. All four re-asserted introspection-guarded so this migration is
-- self-contained if run against a database where any is somehow absent.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customers_id_org_key') then
    alter table public.customers add constraint customers_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jobs_id_org_key') then
    alter table public.jobs add constraint jobs_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'properties_id_org_key') then
    alter table public.properties add constraint properties_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_id_org_key') then
    alter table public.leads add constraint leads_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 2. quotes.customer_id → composite FK (NOT NULL: preserve NO ACTION) ──────
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'quotes_customer_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes drop constraint quotes_customer_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_customer_org_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes
      add constraint quotes_customer_org_fkey
      foreign key (customer_id, org_id)
      references public.customers (id, org_id);
  end if;
end $$;

comment on constraint quotes_customer_org_fkey on public.quotes is
  'Tenant integrity: a quote may reference only a customer in the same org. RLS '
  'cannot enforce this — it guards the row being written, not the customer the '
  'row points at. WORSE than the jobs/leads case because /q/[token] renders the '
  'customer name+email on a PUBLIC service-role route. customer_id is NOT NULL so '
  'ON DELETE stays NO ACTION (the original bare FK''s semantics).';

-- ── 3. quotes.property_id → composite FK (nullable: SET NULL column-list) ────
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'quotes_property_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes drop constraint quotes_property_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_property_org_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes
      add constraint quotes_property_org_fkey
      foreign key (property_id, org_id)
      references public.properties (id, org_id)
      on delete set null (property_id);
  end if;
end $$;

comment on constraint quotes_property_org_fkey on public.quotes is
  'Tenant integrity: a quote may reference only a property in the same org. '
  'ON DELETE SET NULL (property_id) preserves the original bare FK''s semantics '
  'while keeping the NOT NULL org_id. See quotes_customer_org_fkey.';

-- ── 4. quotes.lead_id → composite FK (nullable: SET NULL column-list) ────────
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'quotes_lead_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes drop constraint quotes_lead_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_lead_org_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes
      add constraint quotes_lead_org_fkey
      foreign key (lead_id, org_id)
      references public.leads (id, org_id)
      on delete set null (lead_id);
  end if;
end $$;

comment on constraint quotes_lead_org_fkey on public.quotes is
  'Tenant integrity: a quote may reference only a lead in the same org. '
  'ON DELETE SET NULL (lead_id) preserves the original bare FK''s semantics. '
  'See quotes_customer_org_fkey.';

-- ── 5. quotes.job_id → composite FK (nullable: SET NULL column-list) ─────────
-- job_id was added by 20260520180000 (variation orders) as
--   references public.jobs(id) on delete set null.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'quotes_job_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes drop constraint quotes_job_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_job_org_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes
      add constraint quotes_job_org_fkey
      foreign key (job_id, org_id)
      references public.jobs (id, org_id)
      on delete set null (job_id);
  end if;
end $$;

comment on constraint quotes_job_org_fkey on public.quotes is
  'Tenant integrity: a quote/variation may reference only a job in the same org. '
  'ON DELETE SET NULL (job_id) preserves the original bare FK''s semantics '
  '(20260520180000). See quotes_customer_org_fkey.';

-- ── 6. schema self-audit: enumerate BARE cross-tenant FKs ────────────────────
-- Powers the systemic completeness guard (__tests__/integration/rls/
-- cross-tenant-fk-completeness.test.ts). Returns every single-column FK where
-- BOTH child and parent carry org_id — i.e. every FK that COULD point at another
-- tenant's row. A composite (col, org_id) FK has ncols=2 and drops out, so this
-- lists exactly the FKs still relying on a same-org invariant elsewhere.
--
-- Reads only the system catalog (pg_constraint / information_schema.columns) —
-- NO tenant data. Exposed via PostgREST RPC so the DB-less test tiers cannot run
-- it; granted to service_role ONLY (which already reads the whole catalog, so
-- this adds no new exposure). NOT granted to anon/authenticated.
create or replace function public._introspect_bare_cross_tenant_fks()
returns table (child text, parent text, conname text)
language sql
stable
security invoker
set search_path = pg_catalog, public, information_schema
as $$
  with childcols as (
    select
      conrelid::regclass::text as child,
      conname::text as conname,
      confrelid::regclass::text as parent,
      (select count(*) from information_schema.columns c
         where c.table_schema = 'public'
           and c.table_name = con.conrelid::regclass::text
           and c.column_name = 'org_id') > 0 as child_has_org,
      (select count(*) from information_schema.columns c
         where c.table_schema = 'public'
           and c.table_name = con.confrelid::regclass::text
           and c.column_name = 'org_id') > 0 as parent_has_org,
      array_length(con.conkey, 1) as ncols
    from pg_constraint con
    where con.contype = 'f'
      and con.connamespace = 'public'::regnamespace
  )
  select child, parent, conname
  from childcols
  where child_has_org and parent_has_org and ncols = 1
  order by child, parent;
$$;

revoke all on function public._introspect_bare_cross_tenant_fks() from public;
grant execute on function public._introspect_bare_cross_tenant_fks() to service_role;

comment on function public._introspect_bare_cross_tenant_fks() is
  'Schema self-audit for the cross-tenant FK completeness guard: lists every '
  'bare (single-column) FK where both child and parent carry org_id. Composite '
  '(col, org_id) FKs have ncols=2 and are excluded. Catalog-only, no tenant '
  'data; service_role only.';
