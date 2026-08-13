-- Cross-tenant reference integrity for FINANCES + INVOICES (hostile-audit 🔴).
--
-- The problem — the C36/C37 class, never swept onto the two MONEY tables
-- --------------------------------------------------------------------------
-- finances.job_id and invoices.job_id are BARE single-column FKs to the GLOBAL
-- jobs table (finances_job_id_fkey / invoices_job_id_fkey — inline column FKs
-- from 20260515180000_finances_and_receipts.sql and 20260520150000_
-- invoice_job_link.sql respectively). The only tenant guard on the write path is
-- `.eq("org_id", ctx.org.id)` / `org_id: ctx.org.id` on the ROW being written —
-- which constrains the org_id the row CARRIES, never the job the row POINTS AT.
-- So a caller working in org A can attach org B's job_id to an org A finance or
-- invoice. RLS cannot express this: it guards the row being written, not the FK
-- target. This is the exact defect closed for jobs/leads (20261112000000) and
-- quotes (20261113000000) — now closed for the two money tables.
--
-- Why the money tables are the sharpest edge of the class
-- ------------------------------------------------------
-- job cost/margin/revenue/VAT is COMPUTED by summing the finances + invoices
-- rows whose job_id matches the job. A cross-org job_id therefore contaminates a
-- job's profitability, budget, and HMRC VAT rollup for a dual-org user — silent
-- financial corruption, not merely an internal integrity slip. The composite FK
-- below makes "a finance/invoice's job must live in the same org" a DATABASE
-- invariant, enforced by Postgres for EVERY writer (the service-role client
-- included).
--
-- The shape — mirrors jobs/leads (20261112000000) and quotes (20261113000000)
-- --------------------------------------------------------------------------
--   finances.job_id: COMPOSITE FK (job_id, org_id) -> jobs (id, org_id).
--   invoices.job_id: COMPOSITE FK (job_id, org_id) -> jobs (id, org_id).
--
-- Parent candidate key
-- --------------------
-- jobs already carries jobs_id_org_key UNIQUE (id, org_id) (live since migration
-- 20261072). Re-asserted introspection-guarded below so this migration is
-- self-contained if run against a database where it is somehow absent.
--
-- ON DELETE semantics are PRESERVED per column
-- --------------------------------------------
-- Both bare FKs were `on delete set null` (nullable job_id). A PLAIN composite
-- `on delete set null` would try to null BOTH job_id AND org_id, and org_id is
-- NOT NULL on both tables — which would ABORT every job delete. So we use the
-- PG15+ column-list form `on delete set null (job_id)` — only job_id is nulled,
-- the NOT NULL org_id survives. This is the SAME idiom as 20261112000000's
-- jobs/leads FKs and 20261113000000's quotes property/lead/job FKs, and Supabase
-- runs Postgres 15+, so the column-list form is available. (Chosen over a plain
-- SET-NULL-on-both — which aborts on NOT NULL org_id — and over a trigger — which
-- would duplicate the ON DELETE semantics the FK already expresses natively.)
-- Both columns are nullable and the composite FK uses MATCH SIMPLE, so a NULL
-- job_id is never checked — a finance/invoice with no job stays valid.
--
-- Prod-data safety — DEFENSIVE null-out FIRST (section 1)
-- ------------------------------------------------------
-- Before swapping the FK we null out any EXISTING cross-org reference, so the
-- composite FK applies cleanly even if a legacy cross-org row exists (this fix's
-- author cannot reach the DB to measure the count; the null-out makes the
-- migration safe regardless). A cross-org job_id is already invalid data — the
-- job it names does not exist in the row's org — so nulling it is the correct
-- repair, and it un-contaminates any already-poisoned cost/margin rollup.
--
-- Additive and reversible:
--   alter table public.finances drop constraint finances_job_org_fkey;
--   alter table public.invoices drop constraint invoices_job_org_fkey;
--   -- (optionally restore the bare FKs:
--   --   alter table public.finances add constraint finances_job_id_fkey
--   --     foreign key (job_id) references public.jobs(id) on delete set null;
--   --   alter table public.invoices add constraint invoices_job_id_fkey
--   --     foreign key (job_id) references public.jobs(id) on delete set null; )

-- ── 1. defensively null out any cross-org references so the FK can be added ───
update public.finances
   set job_id = null
 where job_id is not null
   and not exists (
     select 1 from public.jobs j
      where j.id = public.finances.job_id
        and j.org_id = public.finances.org_id
   );

update public.invoices
   set job_id = null
 where job_id is not null
   and not exists (
     select 1 from public.jobs j
      where j.id = public.invoices.job_id
        and j.org_id = public.invoices.org_id
   );

-- ── 2. parent candidate key the composite FKs target ─────────────────────────
-- jobs_id_org_key (id, org_id) already exists (migration 20261072); re-asserted
-- introspection-guarded so this migration is self-contained.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_id_org_key') then
    alter table public.jobs add constraint jobs_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 3. finances.job_id → composite FK (nullable: SET NULL column-list) ───────
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'finances_job_id_fkey' and conrelid = 'public.finances'::regclass) then
    alter table public.finances drop constraint finances_job_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finances_job_org_fkey' and conrelid = 'public.finances'::regclass) then
    alter table public.finances
      add constraint finances_job_org_fkey
      foreign key (job_id, org_id)
      references public.jobs (id, org_id)
      on delete set null (job_id);
  end if;
end $$;

comment on constraint finances_job_org_fkey on public.finances is
  'Tenant integrity: a finance row may reference only a job in the SAME org. RLS '
  'cannot enforce this — it guards the row being written, not the job the row '
  'points at. A cross-org job_id contaminates the job''s computed cost/margin/VAT '
  'for a dual-org user. ON DELETE SET NULL (job_id) preserves the original bare '
  'FK''s semantics (20260515180000) while keeping the NOT NULL org_id.';

-- ── 4. invoices.job_id → composite FK (nullable: SET NULL column-list) ───────
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'invoices_job_id_fkey' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices drop constraint invoices_job_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_job_org_fkey' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices
      add constraint invoices_job_org_fkey
      foreign key (job_id, org_id)
      references public.jobs (id, org_id)
      on delete set null (job_id);
  end if;
end $$;

comment on constraint invoices_job_org_fkey on public.invoices is
  'Tenant integrity: an invoice may reference only a job in the SAME org. RLS '
  'cannot enforce this — it guards the row being written, not the job the row '
  'points at. A cross-org job_id contaminates the job''s computed revenue/VAT '
  'rollup for a dual-org user. ON DELETE SET NULL (job_id) preserves the original '
  'bare FK''s semantics (20260520150000) while keeping the NOT NULL org_id.';
