-- Allow org members (not only admins) to attach + detach photos on jobs
-- in their org WITHOUT loosening the broader jobs UPDATE RLS policy.
--
-- The two SECURITY DEFINER functions verify the caller is a member of the
-- job's org, then perform the photos-array mutation with elevated
-- privileges. The existing "jobs: admins can update" policy remains in
-- place for every other column — only the photos field is reachable
-- through these RPCs by non-admin members.
--
-- Idempotent: CREATE OR REPLACE for functions; explicit GRANT EXECUTE.

-- ---------------------------------------------------------------------------
-- append_job_photo: idempotently append a storage path to jobs.photos
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
  -- Look up the job's org; SECURITY DEFINER lets us bypass jobs RLS for
  -- this read (we'll re-check membership against it next).
  select org_id into job_org from public.jobs where id = target_job_id;
  if job_org is null then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;

  -- Caller must be a member of the job's org. auth.uid() reflects the
  -- end-user JWT even inside SECURITY DEFINER (definer changes the SQL
  -- role, not the request context).
  if not exists (
    select 1 from public.memberships
    where user_id = auth.uid() and org_id = job_org
  ) then
    raise exception 'Forbidden: not a member of this org'
      using errcode = '42501';
  end if;

  -- De-dupe via array_agg(distinct ...) so re-appending the same path
  -- is a no-op rather than producing a duplicate entry.
  update public.jobs
  set photos = (
    select array_agg(distinct p)
    from unnest(coalesce(photos, '{}') || array[photo_path]) as p
  )
  where id = target_job_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_job_photo: remove a path from jobs.photos
-- ---------------------------------------------------------------------------
create or replace function public.remove_job_photo(
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
    raise exception 'Forbidden: not a member of this org'
      using errcode = '42501';
  end if;

  update public.jobs
  set photos = array_remove(coalesce(photos, '{}'), photo_path)
  where id = target_job_id;
end;
$$;

-- Expose via PostgREST RPC to authenticated callers (anon stays blocked).
grant execute on function public.append_job_photo(uuid, text) to authenticated;
grant execute on function public.remove_job_photo(uuid, text) to authenticated;
