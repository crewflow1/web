-- Health & Safety — Toolbox Talks evidence foundation (Toolbox M1).
--
-- Evolves the EXISTING Site-Management `toolbox_talks` table (20260921 — a flat,
-- free-text briefing log) into a full H&S evidence artifact with RAMS-parity:
-- a draft->issued("delivered")->superseded lifecycle, a per-org TBT-NNNN reference,
-- a revision series, an immutable-on-issue evidence freeze, and a frozen snapshot —
-- so a toolbox talk becomes a citable, tamper-evident record a UK contractor can
-- produce if challenged (HSWA 1974 s.2/s.3, CDM 2015).
--
-- EXTEND, DO NOT FORK: this is the SAME table the /toolbox pages already read/write.
-- It stays a `tenant_attachments` target (the signed-sheet photo) and keeps its
-- existing columns (topic/presenter/attendees free-text/notes) as the informal
-- sign-in + subcontractor fallback. Worker acknowledgement rides the SHARED
-- safety_acknowledgements engine (wired in M2, 20261026); this migration only
-- prepares the subject (reference + issued status) that engine anchors to.
--
-- Additive + reversible + backward-safe: prod has 0 rows; every column is
-- nullable or constant-defaulted (no table rewrite); the existing createToolboxTalk
-- INSERT (which sets no status) lands a 'draft' and keeps working; every reader is
-- column-explicit. Mirrors risk_assessments (20261018), evidence hardening
-- (20261021), RAMS revisioning (20261022), evidence hygiene (20261023) and the
-- bare-FK org-integrity doctrine (20261024). Rollback: drop the functions + new
-- triggers, then drop the added columns.

-- ---------------------------------------------------------------------------
-- 1. Columns — all metadata-only (nullable or constant default; no rewrite).
-- ---------------------------------------------------------------------------
alter table public.toolbox_talks
  add column if not exists status               text not null default 'draft',
  add column if not exists reference            text,
  add column if not exists key_points           text,      -- the briefing substance an inspector reads
  add column if not exists location             text,      -- specific area/plot; free-text override of the job site
  add column if not exists ppe                  text[] not null default '{}',
  add column if not exists delivered_by         uuid references public.users(id)            on delete set null,
  add column if not exists risk_assessment_id   uuid references public.risk_assessments(id) on delete set null,
  add column if not exists permit_to_work_id    uuid references public.permits_to_work(id)  on delete set null,
  add column if not exists root_toolbox_talk_id uuid,
  add column if not exists revision_number      integer not null default 1,
  add column if not exists supersedes_id        uuid references public.toolbox_talks(id)    on delete set null,
  add column if not exists snapshot             jsonb,     -- issue-time frozen evidence; null while draft
  add column if not exists issued_by            uuid references public.users(id)            on delete set null,
  add column if not exists issued_at            timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Backfill the revision series (every row becomes revision 1 of its own
--    series). No-op in prod (0 rows); revision_number is filled by its default.
-- ---------------------------------------------------------------------------
update public.toolbox_talks set root_toolbox_talk_id = id where root_toolbox_talk_id is null;
alter table public.toolbox_talks alter column root_toolbox_talk_id set not null;

-- ---------------------------------------------------------------------------
-- 3. Constraints + indexes. NULLs are distinct, so unbounded draft rows (all with
--    reference = null) coexist under unique(org_id, reference) — only issued rows
--    carry a TBT-NNNN. (status='draft') = (reference is null) keeps that honest.
-- ---------------------------------------------------------------------------
alter table public.toolbox_talks
  add constraint toolbox_talks_status_check
    check (status in ('draft', 'issued', 'superseded', 'withdrawn')),
  add constraint toolbox_talks_revision_positive check (revision_number >= 1),
  add constraint toolbox_talks_id_org_key        unique (id, org_id),        -- future child composite-FK target
  add constraint toolbox_talks_org_reference_key unique (org_id, reference),
  add constraint toolbox_talks_reference_when_issued check ((status = 'draft') = (reference is null)),
  add constraint toolbox_talks_issued_stamp        check (status = 'draft' or issued_at is not null);

create unique index if not exists toolbox_talks_series_revision_idx
  on public.toolbox_talks (root_toolbox_talk_id, revision_number);
create unique index if not exists toolbox_talks_one_current_idx
  on public.toolbox_talks (root_toolbox_talk_id) where status = 'issued';
create unique index if not exists toolbox_talks_one_draft_idx
  on public.toolbox_talks (root_toolbox_talk_id) where status = 'draft';
create index if not exists toolbox_talks_series_idx
  on public.toolbox_talks (root_toolbox_talk_id, revision_number desc);
create index if not exists toolbox_talks_status_idx  on public.toolbox_talks (org_id, status);
create index if not exists toolbox_talks_ra_idx      on public.toolbox_talks (risk_assessment_id) where risk_assessment_id is not null;
create index if not exists toolbox_talks_ptw_idx     on public.toolbox_talks (permit_to_work_id)  where permit_to_work_id  is not null;

-- ---------------------------------------------------------------------------
-- 4. Per-org TBT-NNNN allocator (mirror next_ra_number). SECURITY DEFINER with a
--    membership gate so it is not a cross-org count oracle. The regex captures the
--    numeric root only, so TBT-0001-R02 revisions never advance the sequence.
-- ---------------------------------------------------------------------------
create or replace function public.next_tbt_number(target_org uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_next integer;
begin
  if target_org is null or target_org not in (select public.current_org_ids()) then
    raise exception 'not a member of organisation %', target_org using errcode = '42501';
  end if;
  select coalesce(max(cast(substring(reference from '^TBT-(\d+)') as integer)), 0) + 1
    into v_next
  from public.toolbox_talks
  where org_id = target_org and reference ~ '^TBT-\d+';
  return 'TBT-' || lpad(v_next::text, 4, '0');
end $$;
grant execute on function public.next_tbt_number(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Same-org link integrity (INV-3/4). Trigger, NOT composite FK: these links are
--    ON DELETE SET NULL on a NOT-NULL-org table, so a composite FK would force
--    CASCADE and delete the evidence when the job/RAMS/permit is removed. Mirrors
--    tg_permit_validate_links + the 20261024 doctrine. Closes the latent bare-FK
--    org gap on the pre-existing job_id too.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_validate_links()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_job uuid;
begin
  if new.job_id is not null then
    select org_id into v_org from public.jobs where id = new.job_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'toolbox talk: job % is not in this organisation', new.job_id using errcode = 'check_violation';
    end if;
  end if;
  if new.risk_assessment_id is not null then
    select org_id, job_id into v_org, v_job from public.risk_assessments where id = new.risk_assessment_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'toolbox talk: risk assessment % is not in this organisation', new.risk_assessment_id using errcode = 'check_violation';
    end if;
    if new.job_id is not null and v_job is not null and v_job <> new.job_id then
      raise exception 'toolbox talk: risk assessment % is for a different job', new.risk_assessment_id using errcode = 'check_violation';
    end if;
  end if;
  if new.permit_to_work_id is not null then
    select org_id, job_id into v_org, v_job from public.permits_to_work where id = new.permit_to_work_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'toolbox talk: permit % is not in this organisation', new.permit_to_work_id using errcode = 'check_violation';
    end if;
    if new.job_id is not null and v_job is not null and v_job <> new.job_id then
      raise exception 'toolbox talk: permit % is for a different job', new.permit_to_work_id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists toolbox_talks_validate_links on public.toolbox_talks;
create trigger toolbox_talks_validate_links
  before insert or update on public.toolbox_talks
  for each row execute function public.tg_tt_validate_links();

-- ---------------------------------------------------------------------------
-- 6. Lifecycle: born-draft, issue-gate, provenance pin (INV-5/7/8). Named
--    ...a_lifecycle so it fires before ...m_immutable (Postgres fires per-event
--    triggers alphabetically — the RAMS ordering contract).
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_a_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Born a draft: no INSERT may mint an issued record (unconditional — service role too).
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a toolbox talk is created as a draft, then issued';
  end if;

  -- On the draft->issued transition, for JWT callers: enforce readiness + pin provenance.
  -- auth.uid() null = trusted service role (fixtures) keeps explicit values.
  if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'issued' and auth.uid() is not null then
    if new.topic is null or length(trim(new.topic)) = 0
       or new.key_points is null or length(trim(new.key_points)) = 0 then
      raise exception 'a toolbox talk needs a topic and key points before it can be delivered';
    end if;
    new.issued_by := auth.uid();
    new.issued_at := now();
  end if;

  return new;
end $$;

drop trigger if exists toolbox_talks_a_lifecycle on public.toolbox_talks;
create trigger toolbox_talks_a_lifecycle
  before insert or update on public.toolbox_talks
  for each row execute function public.tg_tt_a_lifecycle();

-- ---------------------------------------------------------------------------
-- 7. Immutable-on-issue (INV-6). Content, links, lineage, provenance + the
--    tenancy/creation columns freeze once out of draft; status is forward-only
--    (issued -> superseded/withdrawn). Runs whenever old.status <> 'draft' — so an
--    edit can't ride in on a status transition. Snapshot is write-once.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_m_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'draft' then
    return new;  -- drafts are freely editable (incl. the transition to issued)
  end if;

  if new.status is distinct from old.status then
    if old.status = 'issued' and new.status in ('superseded', 'withdrawn') then
      null;  -- allowed lifecycle transition
    else
      raise exception 'invalid toolbox talk status transition % -> %', old.status, new.status;
    end if;
  end if;

  if old.snapshot is not null and new.snapshot is distinct from old.snapshot then
    raise exception 'the toolbox talk evidence snapshot is frozen once set';
  end if;

  if (new.topic, new.key_points, new.location, new.ppe, new.talk_date, new.presenter,
      new.job_id, new.risk_assessment_id, new.permit_to_work_id, new.reference,
      new.issued_at, new.issued_by, new.supersedes_id, new.root_toolbox_talk_id,
      new.revision_number, new.org_id, new.created_by, new.created_at)
     is distinct from
     (old.topic, old.key_points, old.location, old.ppe, old.talk_date, old.presenter,
      old.job_id, old.risk_assessment_id, old.permit_to_work_id, old.reference,
      old.issued_at, old.issued_by, old.supersedes_id, old.root_toolbox_talk_id,
      old.revision_number, old.org_id, old.created_by, old.created_at)
  then
    raise exception 'a % toolbox talk is immutable; raise a new revision instead', old.status;
  end if;

  return new;
end $$;

drop trigger if exists toolbox_talks_m_immutable on public.toolbox_talks;
create trigger toolbox_talks_m_immutable
  before update on public.toolbox_talks
  for each row execute function public.tg_tt_m_immutable();

-- ---------------------------------------------------------------------------
-- 8. Revision lineage integrity (INV-11): self-root on insert; series root + the
--    supersede pointer must be same-org, same-series, never self. Mirror
--    tg_ra_revision_integrity.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_revision_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.root_toolbox_talk_id is null then
    new.root_toolbox_talk_id := new.id;
  end if;

  if new.root_toolbox_talk_id <> new.id
     and not exists (select 1 from public.toolbox_talks
                     where id = new.root_toolbox_talk_id and org_id = new.org_id) then
    raise exception 'revision series root % is not a toolbox talk in this organisation', new.root_toolbox_talk_id;
  end if;

  if new.supersedes_id is not null then
    if new.supersedes_id = new.id then
      raise exception 'a toolbox talk cannot supersede itself';
    end if;
    if not exists (select 1 from public.toolbox_talks
                   where id = new.supersedes_id and org_id = new.org_id
                     and root_toolbox_talk_id = new.root_toolbox_talk_id) then
      raise exception 'supersedes_id must be another revision of the same series in this organisation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists toolbox_talks_revision_integrity on public.toolbox_talks;
create trigger toolbox_talks_revision_integrity
  before insert or update on public.toolbox_talks
  for each row execute function public.tg_tt_revision_integrity();

-- ---------------------------------------------------------------------------
-- 9. Issued evidence is non-deletable via the tenant path (INV-13). Trigger blocks
--    delete of a non-draft talk for EVERY role (RLS is service-role-bypassable);
--    the org-exists check lets org teardown cascade. Draft-only delete RLS policy
--    replaces the prior unconditional admin policy.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_block_delete_when_issued()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status <> 'draft'
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception 'a delivered toolbox talk is H&S evidence and cannot be deleted (withdraw it instead)';
  end if;
  return old;
end $$;

drop trigger if exists toolbox_talks_block_delete on public.toolbox_talks;
create trigger toolbox_talks_block_delete
  before delete on public.toolbox_talks
  for each row execute function public.tg_tt_block_delete_when_issued();

drop policy if exists toolbox_talks_delete on public.toolbox_talks;
create policy toolbox_talks_delete on public.toolbox_talks
  for delete using (public.is_org_admin(org_id) and status = 'draft');

-- ---------------------------------------------------------------------------
-- 10. Atomic issue-of-a-revision (INV-12), mirror issue_rams_revision. SECURITY
--     INVOKER: RLS + every toolbox trigger (issue-gate + pin) apply to the caller;
--     the one-issued-per-series index backstops a race. Revision keeps the series'
--     number + -R0n suffix (TBT-0001 -> TBT-0001-R02).
-- ---------------------------------------------------------------------------
create or replace function public.issue_toolbox_talk_revision(p_id uuid)
returns text language plpgsql security invoker set search_path = public as $$
declare
  v_root uuid;
  v_rev  integer;
  v_status text;
  v_base text;
  v_newref text;
begin
  select root_toolbox_talk_id, revision_number, status
    into v_root, v_rev, v_status
  from public.toolbox_talks where id = p_id for update;

  if v_root is null then raise exception 'toolbox talk % not found', p_id; end if;
  if v_status <> 'draft' then raise exception 'only a draft revision can be issued (status %)', v_status; end if;
  if v_rev < 2 then raise exception 'the first issue of a series uses the standard issue flow, not a revision'; end if;

  select reference into v_base
  from public.toolbox_talks where root_toolbox_talk_id = v_root and revision_number = 1;
  if v_base is null then raise exception 'the series has no issued origin revision to number against'; end if;
  v_newref := v_base || '-R' || lpad(v_rev::text, 2, '0');

  update public.toolbox_talks set status = 'superseded'
   where root_toolbox_talk_id = v_root and status = 'issued';

  update public.toolbox_talks
     set status = 'issued', reference = v_newref, issued_at = now(), issued_by = auth.uid()
   where id = p_id;

  return v_newref;
end $$;
grant execute on function public.issue_toolbox_talk_revision(uuid) to authenticated;
