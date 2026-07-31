-- Job warranties + servicing intervals (Phase 7 — Customer Experience).
--
-- After Practical Completion the relationship does not end: a defects-liability
-- period runs, workmanship and product warranties run, and plant needs
-- servicing at intervals. CrewFlow already holds the authoritative clock those
-- periods run on — see section 1 — so this migration stores TERMS ONLY and
-- derives every date.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. START BASIS — THE ISSUED CERTIFICATE, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────────────────────
-- Two dates in this schema could plausibly start a warranty clock:
--
--   (a) completion_certificates.completion_date (20261014) — captured when a
--       Practical Completion Certificate is ISSUED, and FROZEN from that moment
--       by tg_completion_certificates_immutable. There is at most ONE issued
--       certificate per job (completion_certificates_one_live_per_job), so the
--       lookup is deterministic. It is a signed contractual instrument the
--       customer has been served through the portal.
--
--   (b) jobs.practical_completion_date (20261013) — an EDITABLE working field on
--       `jobs`, with admin UPDATE RLS and no freeze, no audit and no issue
--       event. It exists to drive the retention-release FORECAST, which is
--       explicitly a forecast.
--
-- (a) is chosen, exclusively. A warranty expiry is a date the contractor will be
-- held to; deriving it from a field any admin can silently retype would mean the
-- customer-facing expiry could move without a single record of who moved it. The
-- `start_basis` column exists, is CHECK-restricted to the single value
-- 'completion_certificate', and is frozen once published — so adding a second
-- basis is a deliberate migration and a code change, never a data accident.
--
-- WHEN NO CERTIFICATE HAS BEEN ISSUED the warranty has NO honest start date, and
-- this schema says so by storing none. There is deliberately no start_date and
-- no expiry_date column anywhere below: a stored expiry would be a SECOND
-- completion date, free to drift from the certificate that justifies it, and the
-- "not yet started" state would have to be faked with a NULL that looks
-- identical to "we forgot to fill it in". Instead lib/warranties/schedule.ts
-- derives {start, expiry, next service} from the issued certificate at read
-- time, and returns an explicit `pending_completion` state when there is no
-- certificate. The operator screen and the portal both print that state in
-- words. This mirrors the retention-release schedule (20261013), which is
-- likewise derived and never stored.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. REMINDERS ARE DERIVED AND DISPLAYED. NOTHING IS SENT.
-- ─────────────────────────────────────────────────────────────────────────────
-- `service_interval_months` describes a servicing cadence. The occurrences it
-- implies are COMPUTED for display on the operator screen and the customer
-- portal. There is no reminders table, no queue, no due-date column, no cron
-- hook and no notification row — because there is no send. Transactional email
-- is live in production; wiring warranty reminders into it would put real,
-- unrequested mail in front of real customers, which is a product decision and
-- outside the authority of this change. Both module headers say so on screen.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. NOT MONEY
-- ─────────────────────────────────────────────────────────────────────────────
-- A warranty is a liability period, not a transaction. Nothing here writes
-- `finances`, `invoices` or `retention_releases`, and no trigger below touches
-- any money table. Retention release remains the only PC-keyed money path and it
-- is untouched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. TEARDOWN SAFETY (the 20261052 lesson)
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive; org-scoped; every FK on the cascade path is ON DELETE CASCADE, and
-- the only NO ACTION / SET NULL edges point at `public.users` (never cascaded
-- from an org delete). There is NO RESTRICT anywhere and NO AFTER-DELETE trigger
-- — the two shapes that broke `delete from organizations` before. The BEFORE
-- UPDATE guard below cannot fire during a delete cascade at all.

-- No `set local lock_timeout` here, deliberately: unlike 20261013 this migration
-- adds no column to a hot existing table. Everything below is a fresh CREATE, so
-- there is no ACCESS EXCLUSIVE lock on live data to bound.

-- ── 1. job_warranties ────────────────────────────────────────────────────────
create table if not exists public.job_warranties (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations(id) on delete cascade,
  -- NOT NULL: a warranty with no job has no completion certificate, therefore no
  -- clock, therefore no meaning. Bound by composite FK below.
  job_id                  uuid not null,

  -- What the customer is being promised.
  title                   text not null check (btrim(title) <> ''),
  kind                    text not null default 'workmanship'
    check (kind in ('workmanship', 'product', 'structural', 'defects_liability', 'other')),
  -- Customer-facing prose: what IS covered. Required — an uncovered warranty is
  -- not a warranty, and "we'll sort it" is not a term.
  cover                   text not null check (btrim(cover) <> ''),
  -- What is NOT covered. Optional but shown verbatim to the customer when set.
  exclusions              text,
  -- Manufacturer / installer / underwriter, and their reference. Customer-safe:
  -- these are the details a customer needs to actually claim.
  provider                text,
  reference               text,

  -- THE TERM. Months from the certificate's completion date. 0 is refused: a
  -- zero-month warranty is a data-entry slip, not a promise. 600 = 50 years,
  -- above any real structural warranty.
  period_months           integer not null check (period_months between 1 and 600),
  -- Restricted to a single value ON PURPOSE — see header §1. A second basis
  -- requires a migration, not a form field.
  start_basis             text not null default 'completion_certificate'
    check (start_basis = 'completion_certificate'),

  -- Servicing cadence. NULL = no servicing obligation. Occurrences are DERIVED
  -- (header §2); this is the interval, not a schedule.
  service_interval_months integer
    check (service_interval_months is null or service_interval_months between 1 and 120),
  service_notes           text,

  -- Lifecycle. A published warranty is corrected by VOIDING it with a reason and
  -- issuing a replacement — never by a silent edit (the goods-received-note
  -- precedent, 20261059).
  status                  text not null default 'active'
    check (status in ('active', 'void')),
  void_reason             text,
  voided_at               timestamp with time zone,
  voided_by               uuid references public.users(id) on delete set null,

  -- Portal delivery. Deliberately OUTSIDE the term-freeze guard so publish and
  -- withdraw always work, exactly as on completion_certificates.
  portal_published_at     timestamp with time zone,
  portal_published_by     uuid references public.users(id) on delete set null,
  portal_withdrawn_at     timestamp with time zone,

  created_by              uuid references public.users(id) on delete set null,
  created_at              timestamp with time zone not null default now(),
  updated_at              timestamp with time zone not null default now(),

  -- ORG BINDING. A warranty can never name another tenant's job: the FK carries
  -- org_id, so a cross-org job_id is unrepresentable for EVERY role including
  -- service_role — the same guard completion_certificates needed 20261024 to
  -- retrofit. CASCADE, never RESTRICT: deleting the job deletes its warranties,
  -- and org teardown removes both without an ordering constraint.
  constraint job_warranties_job_org_fkey
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,

  -- Candidate key so any future child relation (claims, service records,
  -- documents) binds (parent_id, org_id) rather than parent_id alone.
  constraint job_warranties_id_org_key unique (id, org_id),

  -- Void is void-with-a-reason, structurally.
  constraint job_warranties_void_reason_required
    check (status <> 'void' or (void_reason is not null and btrim(void_reason) <> '')),
  constraint job_warranties_void_provenance
    check (status <> 'void' or voided_at is not null)
);

comment on table public.job_warranties is
  'Post-completion warranty TERMS for a job. Stores no start or expiry date: both are derived from the job''s ISSUED completion certificate (20261014) by lib/warranties/schedule.ts, so there is exactly one completion date in the system. Servicing reminders are derived for display and are NEVER sent.';
comment on column public.job_warranties.start_basis is
  'The clock this warranty runs on. Restricted to ''completion_certificate'': the frozen completion_date of the job''s issued certificate. jobs.practical_completion_date is deliberately NOT a permitted basis — it is an editable working field with no freeze and no audit.';
comment on column public.job_warranties.period_months is
  'Warranty term in whole months from the certificate''s completion date. The expiry is DERIVED, never stored, so it cannot drift from the certificate.';
comment on column public.job_warranties.service_interval_months is
  'Servicing cadence in months, or NULL for none. The occurrences are computed for DISPLAY only — CrewFlow sends no warranty or servicing email.';

create index if not exists job_warranties_org_idx
  on public.job_warranties (org_id, created_at desc);
create index if not exists job_warranties_job_idx
  on public.job_warranties (job_id, created_at desc);
-- Portal scope: the live, published warranties for a set of jobs.
create index if not exists job_warranties_portal_idx
  on public.job_warranties (job_id)
  where status = 'active' and portal_published_at is not null;

-- ── 2. Term freeze once the customer has seen it ─────────────────────────────
-- A warranty the customer has been shown is something they may have relied on.
-- Shortening its term, re-pointing it at another job, or changing what it covers
-- after publication is a rewrite of a promise, so it is refused; the correction
-- path is void + reissue, which leaves both records.
--
-- Withdrawal does NOT thaw the freeze: the customer already saw it.
-- Deliberately NOT frozen: status/void_*, the portal columns, service_notes and
-- the provider reference — a claim phone number changing is an update, not a
-- rewrite.
--
-- BEFORE UPDATE only. It cannot participate in a DELETE cascade, and it writes
-- nothing, so it cannot reproduce the 20261052 org-teardown failure.
create or replace function public.tg_job_warranties_freeze_published()
returns trigger language plpgsql as $$
begin
  if old.portal_published_at is not null then
    if new.period_months is distinct from old.period_months then
      raise exception 'warranty % has been published to the customer; its term is frozen (void and reissue instead)', old.id
        using errcode = 'check_violation';
    end if;
    if new.start_basis is distinct from old.start_basis then
      raise exception 'warranty % has been published to the customer; its start basis is frozen', old.id
        using errcode = 'check_violation';
    end if;
    if new.job_id is distinct from old.job_id then
      raise exception 'warranty % has been published to the customer; it cannot be moved to another job', old.id
        using errcode = 'check_violation';
    end if;
    if new.kind is distinct from old.kind or new.cover is distinct from old.cover then
      raise exception 'warranty % has been published to the customer; what it covers is frozen (void and reissue instead)', old.id
        using errcode = 'check_violation';
    end if;
    -- The first publish stamps this; a later re-publish must not re-date the
    -- moment the promise was made.
    if new.portal_published_at is distinct from old.portal_published_at then
      raise exception 'warranty % has already been published; portal_published_at is frozen', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists job_warranties_freeze_published on public.job_warranties;
create trigger job_warranties_freeze_published
  before update on public.job_warranties
  for each row execute function public.tg_job_warranties_freeze_published();

drop trigger if exists job_warranties_set_updated_at on public.job_warranties;
create trigger job_warranties_set_updated_at before update on public.job_warranties
  for each row execute function public.tg_set_updated_at();

-- ── 3. RLS — tenant-scoped, mirrors completion_certificates ──────────────────
alter table public.job_warranties enable row level security;

drop policy if exists "job_warranties: members select" on public.job_warranties;
create policy "job_warranties: members select" on public.job_warranties
  for select using (org_id in (select public.current_org_ids()));

drop policy if exists "job_warranties: members insert" on public.job_warranties;
create policy "job_warranties: members insert" on public.job_warranties
  for insert with check (org_id in (select public.current_org_ids()));

drop policy if exists "job_warranties: members update" on public.job_warranties;
create policy "job_warranties: members update" on public.job_warranties
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

drop policy if exists "job_warranties: admins delete" on public.job_warranties;
create policy "job_warranties: admins delete" on public.job_warranties
  for delete using (public.is_org_admin(org_id));
