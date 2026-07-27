-- Security wave — final adversarial-review hardening (two integrity fixes).
--
-- [P1 integrity] RAMS issued-hazard reparent bypass. tg_rah_derive_org validated only the
-- DESTINATION parent on UPDATE, so a member could reparent a hazard row off an ISSUED
-- (frozen) risk assessment onto a throwaway DRAFT — silently stripping a documented hazard
-- from a legal record and falsifying any acknowledgements captured against the original set.
-- Direct-PostgREST only (the app never reparents), within-tenant, but it defeats the RAMS
-- immutability guarantee ("once issued it is a legal record — it must be immutable"). Fix:
-- on a reparent (risk_assessment_id changes) the SOURCE parent must also be a draft.
--
-- [P3 latent] job-photo path poisoning. append_job_photo stored the client-supplied
-- photo_path verbatim with no org check — the same storage_path-poisoning class S0
-- (20261031) fixed on the four evidence tables, left unbound on the fifth path store
-- (jobs.photos). Inert today (the gallery signs on the RLS tenant client, which denies a
-- foreign-org path), but a live cross-tenant read the moment any service-role consumer of
-- jobs.photos is added. Bind the path to the job's org, mirroring tg_assert_storage_path_org.
--
-- Additive + reversible: CREATE OR REPLACE of two existing functions only (triggers/ grants
-- already bound). No schema/data change. Rollback: restore the 20261018 / 20260515200000 bodies.

-- ---------------------------------------------------------------------------
-- 1. RAMS hazards: a reparent must start from a draft (source immutability).
-- ---------------------------------------------------------------------------
create or replace function public.tg_rah_derive_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org uuid;
  parent_status text;
  old_parent_status text;
begin
  select org_id, status into parent_org, parent_status
  from public.risk_assessments where id = new.risk_assessment_id;
  if parent_org is null then
    raise exception 'risk_assessment % not found', new.risk_assessment_id;
  end if;
  -- Destination parent must be a draft (blocks attaching/editing hazards on issued records).
  if parent_status <> 'draft' then
    raise exception 'cannot modify hazards of a % risk assessment (issued records are immutable)', parent_status;
  end if;
  -- Reparent guard: the SOURCE parent must ALSO be a draft, else a hazard could be moved off
  -- an issued (frozen) assessment to a throwaway draft, stripping it from the legal record.
  if tg_op = 'UPDATE' and new.risk_assessment_id is distinct from old.risk_assessment_id then
    select status into old_parent_status from public.risk_assessments where id = old.risk_assessment_id;
    if old_parent_status is not null and old_parent_status <> 'draft' then
      raise exception 'cannot move a hazard off a % risk assessment (issued records are immutable)', old_parent_status;
    end if;
  end if;
  new.org_id := parent_org;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Job photos: bind the appended path to the job's own org (anti-poison).
-- ---------------------------------------------------------------------------
create or replace function public.append_job_photo(
  target_job_id uuid,
  photo_path text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  job_org uuid;
begin
  select org_id into job_org from public.jobs where id = target_job_id;
  if job_org is null then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.memberships
    where user_id = auth.uid() and org_id = job_org
  ) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- The photo path MUST live under the job's own org (first segment = org_id). Blocks a
  -- member poisoning jobs.photos with another org's object key. JWT-gated (auth.uid() present
  -- for a browser caller); the trusted service role writes org-first paths itself. The honest
  -- route builds `${ctx.org.id}/${jobId}/…`, so it always passes.
  if auth.uid() is not null and split_part(photo_path, '/', 1) is distinct from job_org::text then
    raise exception 'job photo path must live under the job''s org' using errcode = '42501';
  end if;

  update public.jobs
  set photos = (
    select array_agg(distinct p)
    from unnest(coalesce(photos, '{}') || array[photo_path]) as p
  )
  where id = target_job_id;
end;
$$;
grant execute on function public.append_job_photo(uuid, text) to authenticated;
