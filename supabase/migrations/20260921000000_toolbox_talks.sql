-- Site Management (Stage One) — Toolbox Talks / RAMS briefings.
--
-- A toolbox talk is a short, recorded on-site safety briefing (working at
-- height, manual handling, a specific RAMS method statement). UK sites must
-- evidence that talks happened and who attended — the record is a compliance +
-- dispute artifact. Third vertical in the Site Management cluster, mirroring
-- snags (20260919) and site diary (20260920) verbatim.
--
-- Additive and dark: nothing reads this table until the /toolbox pages ship.
-- Reversible: drop the table + narrow the tenant_attachments CHECK.

create table if not exists public.toolbox_talks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  -- The job/site the talk was delivered on. Nullable + on delete set null: the
  -- record outlives the job.
  job_id         uuid references public.jobs(id) on delete set null,
  talk_date      date not null default current_date,
  -- The safety topic — "Working at height", "Manual handling", a RAMS ref.
  topic          text not null,
  -- Who delivered it. Free text (may be a subcontractor's supervisor, not an
  -- org user).
  presenter      text,
  -- Who attended — a free-text list of names / trades (the sign-in), plus an
  -- optional count for the summary. The signed sheet itself is a photo.
  attendees      text,
  attendee_count integer check (attendee_count is null or attendee_count >= 0),
  notes          text,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamp with time zone not null default now(),
  updated_at     timestamp with time zone not null default now()
);

create index if not exists toolbox_talks_org_idx
  on public.toolbox_talks (org_id, talk_date desc, created_at desc);
create index if not exists toolbox_talks_job_idx
  on public.toolbox_talks (job_id) where job_id is not null;

alter table public.toolbox_talks enable row level security;

create policy toolbox_talks_select on public.toolbox_talks
  for select using (org_id in (select public.current_org_ids()));
create policy toolbox_talks_insert on public.toolbox_talks
  for insert with check (org_id in (select public.current_org_ids()));
create policy toolbox_talks_update on public.toolbox_talks
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Hard delete is admin-only: a safety briefing record is H&S evidence.
create policy toolbox_talks_delete on public.toolbox_talks
  for delete using (public.is_org_admin(org_id));

drop trigger if exists toolbox_talks_set_updated_at on public.toolbox_talks;
create trigger toolbox_talks_set_updated_at before update on public.toolbox_talks
  for each row execute function public.tg_set_updated_at();

-- --------------------------------------------------------------------------
-- Let toolbox talks carry the signed attendance sheet as a photo through the
-- universal attachments pipeline. Widen the shared tenant_attachments CHECK by
-- introspection (preserving the values snags + site diary already added, so this
-- third stacked migration never narrows the constraint).
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'tenant_attachments'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%target_table%';
  if cname is not null then
    execute format('alter table public.tenant_attachments drop constraint %I', cname);
  end if;
end $$;

alter table public.tenant_attachments
  add constraint tenant_attachments_target_table_check
  check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                          'suppliers', 'memberships', 'leads', 'snags',
                          'site_diary_entries', 'toolbox_talks'));
