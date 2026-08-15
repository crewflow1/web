-- P3 Reporting — scheduled report delivery: the report_subscriptions store.
--
-- The /reports surface can render + export (PDF/CSV) profit, cashflow, staff
-- utilisation, sales pipeline and the overview aggregates on demand, but nothing
-- DELIVERS a report on a cadence. This migration is the durable home for that: a
-- per-org subscription (report key + cadence + recipients + format) that a daily
-- cron (app/api/cron/report-delivery) drains — composing the SAME deterministic
-- report the page/export routes build and emailing it as an attachment.
--
-- ───────────────────────────────────────────────────────────────────────────
-- POSTURE — the expense_budgets / maintenance_reminder_log tenant table posture
-- ───────────────────────────────────────────────────────────────────────────
-- Org-pinned, RLS enabled, MEMBERS read / ADMINS write. The cron drain runs on
-- the service-role client (createAdminClient), which BYPASSES RLS entirely; it
-- pins every read to org_id in-statement, so the drain never blends orgs. The
-- authenticated subscribe UI (owner/admin) writes under RLS, so a non-admin can
-- neither create nor delete a subscription even by forging a request.
--
-- Provably additive: one brand-new table, its own RLS + updated_at trigger, no
-- tenant table touched, no producer wired by this migration (the cron + the
-- subscribe UI wire it in TypeScript).

-- ---------------------------------------------------------------------------
-- 1. report_subscriptions — the scheduled-delivery config. RLS: members read,
--    admins write. One row = "email <recipients> the <report_key> report as
--    <format> every <cadence>".
-- ---------------------------------------------------------------------------
create table if not exists public.report_subscriptions (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.organizations(id) on delete cascade,

  -- The report to render. CHECK-pinned to the deterministic report registry
  -- (lib/reports/registry.ts REPORT_KEYS) so a subscription can only ever name a
  -- report the delivery cron knows how to compose. Adding a report widens BOTH
  -- the registry and this CHECK in lock-step.
  report_key    text        not null
                            check (report_key in ('overview','profit','cashflow','utilisation','pipeline')),

  -- Delivery format. PDF (branded, letterheaded) or CSV (machine-readable) —
  -- both produced by the ONE shared document builder, never re-derived.
  format        text        not null default 'pdf'
                            check (format in ('pdf','csv')),

  -- How often to send. The cron gates each cadence deterministically:
  -- daily → every run; weekly → Mondays; monthly → the 1st.
  cadence       text        not null
                            check (cadence in ('daily','weekly','monthly')),

  -- Where to send it. At least one recipient; each must look like an email. The
  -- cron additionally routes every send through the shared sendEmail self-loop
  -- guard, so a bad address fails soft (logged) rather than 500-ing the run.
  recipients    text[]      not null
                            check (
                              array_length(recipients, 1) >= 1
                              and array_length(recipients, 1) <= 20
                              and not exists (
                                select 1 from unnest(recipients) r
                                where r !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                              )
                            ),

  -- Paused subscriptions are retained but never delivered.
  active        boolean     not null default true,

  -- FAIRNESS + SELF-DRAINING CURSOR. The cron advances this to the run's London
  -- day after a successful (or dark-skipped) delivery, and its candidate filter
  -- excludes any subscription whose last_run_on = today — so a delivered
  -- subscription LEAVES the day's candidate set (self-draining) and the drain
  -- orders by last_run_on ASC NULLS FIRST (stalest first), so no head can be
  -- re-serviced while a tail waits. See the cron-fairness allowlist entry.
  last_run_on   date,

  created_by    uuid        references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists report_subscriptions_org_idx
  on public.report_subscriptions (org_id);

-- The drain's candidate scan: active subscriptions ordered by the fairness
-- cursor (stalest first, nulls — never delivered — first).
create index if not exists report_subscriptions_due_idx
  on public.report_subscriptions (active, last_run_on asc nulls first);

-- ---------------------------------------------------------------------------
-- 2. RLS — members read, admins write (the expense_budgets posture). The cron
--    drain writes via the service-role client, which bypasses RLS entirely.
-- ---------------------------------------------------------------------------
alter table public.report_subscriptions enable row level security;

drop policy if exists "report_subscriptions: members can select" on public.report_subscriptions;
create policy "report_subscriptions: members can select" on public.report_subscriptions
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "report_subscriptions: admins can insert" on public.report_subscriptions;
create policy "report_subscriptions: admins can insert" on public.report_subscriptions
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "report_subscriptions: admins can update" on public.report_subscriptions;
create policy "report_subscriptions: admins can update" on public.report_subscriptions
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "report_subscriptions: admins can delete" on public.report_subscriptions;
create policy "report_subscriptions: admins can delete" on public.report_subscriptions
  for delete to authenticated using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 3. updated_at trigger — keep the audit column honest on every UPDATE.
-- ---------------------------------------------------------------------------
create or replace function public.report_subscriptions_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists report_subscriptions_set_updated_at on public.report_subscriptions;
create trigger report_subscriptions_set_updated_at
  before update on public.report_subscriptions
  for each row execute function public.report_subscriptions_set_updated_at();

comment on table public.report_subscriptions is
  'Scheduled report delivery config (P3 Reporting). Members read, admins write; the report-delivery cron drains it on the service-role client. report_key CHECK is kept in lock-step with lib/reports/registry.ts.';
