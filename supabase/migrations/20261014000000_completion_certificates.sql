-- Completion Certificates (Phase 7 — Customer Experience).
--
-- A Practical Completion Certificate is a point-in-time CONTRACTUAL instrument:
-- issued when a job reaches Practical Completion, frozen forever after, and
-- delivered to the customer portal. It REUSES the site_reports pattern
-- (immutable content + write-once snapshot, portal publish/withdraw columns,
-- react-pdf) as a SIBLING table — exactly as purchase_orders reused the quotes
-- pattern. It is NOT a site_report type: a cert has no reporting period, no
-- diary/snags aggregation, and is one-final-per-job (site reports are periodic
-- and routinely re-issued).
--
-- Self-contained by design: the cert carries its OWN completion_date (captured
-- at issue), so this migration has NO dependency on jobs.practical_completion_date
-- (which lives on a separate unmerged branch). The app pre-fills it from the job
-- when present; the snapshot philosophy means the cert freezes its own date anyway.
--
-- Additive + dark-safe + reversible (drop table + function).

-- Per-org CERT-NNNN allocator (mirrors next_po_number). The unique constraint
-- below — not this function — is the real guard; a race yields a retry, never a
-- duplicate contractual number.
create or replace function public.next_certificate_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  select coalesce(max(cast(substring(certificate_number from 'CERT-(\d+)') as int)), 0) + 1
  into next_num
  from public.completion_certificates
  where org_id = target_org
    and certificate_number ~ '^CERT-\d+$';
  return 'CERT-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_certificate_number(uuid) to authenticated;

create table if not exists public.completion_certificates (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  -- nullable + SET NULL: the issued snapshot has frozen the job identity, so the
  -- contractual record survives if the job is later removed (mirrors site_reports).
  job_id               uuid references public.jobs(id) on delete set null,
  -- denormalised so the portal can scope "which customer may see this cert".
  customer_id          uuid references public.customers(id) on delete set null,
  certificate_number   text not null,
  status               text not null default 'draft'
    check (status in ('draft', 'issued', 'superseded', 'archived')),
  -- the cert's OWN Practical Completion date (frozen on issue).
  completion_date      date not null,
  revision             integer not null default 1 check (revision >= 1),
  supersedes_id        uuid references public.completion_certificates(id) on delete set null,
  -- editable working draft; frozen customer-SAFE snapshot (write-once at issue).
  content              jsonb not null default '{}'::jsonb,
  snapshot             jsonb,
  prepared_by          uuid references public.users(id) on delete set null,
  issued_by            uuid references public.users(id) on delete set null,
  issued_at            timestamp with time zone,
  -- portal delivery — OUTSIDE the immutability guard so publish/withdraw never
  -- touch the frozen snapshot (mirrors site_reports portal columns).
  portal_published_at  timestamp with time zone,
  portal_published_by  uuid references public.users(id) on delete set null,
  portal_withdrawn_at  timestamp with time zone,
  customer_notified_at timestamp with time zone,
  created_at           timestamp with time zone not null default now(),
  updated_at           timestamp with time zone not null default now(),
  constraint completion_certificates_org_number_key unique (org_id, certificate_number)
);

-- One LIVE issued cert per job (historical superseded rows are allowed). This is
-- the cert-specific invariant site_reports deliberately lacks.
create unique index if not exists completion_certificates_one_live_per_job
  on public.completion_certificates (job_id) where status = 'issued' and job_id is not null;

create index if not exists completion_certificates_org_idx
  on public.completion_certificates (org_id, created_at desc);
create index if not exists completion_certificates_job_idx
  on public.completion_certificates (job_id) where job_id is not null;
-- portal scope: a customer's published, live certs.
create index if not exists completion_certificates_portal_idx
  on public.completion_certificates (customer_id, status)
  where status = 'issued' and portal_published_at is not null;

-- Immutability: snapshot write-once; content frozen once terminal; and — per the
-- 20261007 accepted-quote-freeze lesson — the contractual ANCHORS (completion_date,
-- certificate_number) frozen once issued, so the record can never be re-anchored.
create or replace function public.tg_completion_certificates_immutable()
returns trigger language plpgsql as $$
begin
  if old.snapshot is not null and new.snapshot is distinct from old.snapshot then
    raise exception 'completion_certificates.snapshot is immutable once set (cert %)', old.id
      using errcode = 'check_violation';
  end if;
  if old.status in ('issued', 'superseded', 'archived') then
    if new.content is distinct from old.content then
      raise exception 'completion_certificates.content is frozen after issue (cert %, status %)', old.id, old.status
        using errcode = 'check_violation';
    end if;
  end if;
  if old.issued_at is not null then
    if new.completion_date is distinct from old.completion_date then
      raise exception 'completion_certificates.completion_date is frozen once issued (cert %)', old.id
        using errcode = 'check_violation';
    end if;
    if new.certificate_number is distinct from old.certificate_number then
      raise exception 'completion_certificates.certificate_number is frozen once issued (cert %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists completion_certificates_immutable on public.completion_certificates;
create trigger completion_certificates_immutable
  before update on public.completion_certificates
  for each row execute function public.tg_completion_certificates_immutable();

drop trigger if exists completion_certificates_set_updated_at on public.completion_certificates;
create trigger completion_certificates_set_updated_at before update on public.completion_certificates
  for each row execute function public.tg_set_updated_at();

-- RLS — tenant-scoped, mirrors site_reports / purchase_orders.
alter table public.completion_certificates enable row level security;
create policy "completion_certificates: members select" on public.completion_certificates
  for select using (org_id in (select public.current_org_ids()));
create policy "completion_certificates: members insert" on public.completion_certificates
  for insert with check (org_id in (select public.current_org_ids()));
create policy "completion_certificates: members update" on public.completion_certificates
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy "completion_certificates: admins delete" on public.completion_certificates
  for delete using (public.is_org_admin(org_id));
