-- clone_job_template.p_anchor_date → DEFAULT NULL (schema ↔ runtime agreement).
--
-- The function body has ALWAYS handled a NULL anchor (`if p_anchor_date is not
-- null …` — the member/no-scheduled-date path skips the admin-only programme
-- clone), and the sole caller (app/(app)/jobs/actions.ts) legitimately passes
-- `scheduled_date ?? null`. But the parameter had no SQL DEFAULT, so
-- `supabase gen types` typed it as a REQUIRED non-null `string`, forcing a narrow
-- `as string` cast at the call site (Wave A A.3). Adding `default null` makes the
-- generated type nullable/optional so the cast can be removed — schema and
-- runtime semantics now agree.
--
-- ADDITIVE & SAFE: body, SECURITY INVOKER posture, search_path, and the
-- revoke/grant are byte-identical to 20261132000001; only the parameter default
-- changes. A default is not part of the function signature, so
-- `clone_job_template(uuid,uuid,uuid,date)` is unchanged and the existing
-- revoke/grant on that signature still apply — re-stated here for clarity.
-- Idempotent (create or replace). Callers passing all four args are unaffected.
create or replace function public.clone_job_template(
  p_job_id      uuid,
  p_org_id      uuid,
  p_template_id uuid,
  p_anchor_date date default null
)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_baseline_id uuid;
  v_start       date;
  v_end         date;
  v_has_baseline boolean;
  v_idx         int := 0;
  r             record;
begin
  if p_job_id is null or p_org_id is null or p_template_id is null then
    return null;
  end if;
  -- The job and template must both be in this org (structural, not just RLS).
  if not exists (select 1 from public.jobs where id = p_job_id and org_id = p_org_id) then
    raise exception 'that job is not in this workspace';
  end if;
  if not exists (select 1 from public.job_templates where id = p_template_id and org_id = p_org_id) then
    raise exception 'that template is not in this workspace';
  end if;

  -- ── Programme clone (admins, anchored, no existing baseline) ──
  if p_anchor_date is not null and public.is_org_admin(p_org_id) then
    select exists (
      select 1 from public.job_programme_baselines
       where job_id = p_job_id and org_id = p_org_id and superseded_at is null
    ) into v_has_baseline;

    if not v_has_baseline then
      -- Window = the anchor plus the min start / max end offset across milestones.
      select (p_anchor_date + coalesce(min(coalesce(offset_start_days, offset_end_days)), 0) * interval '1 day')::date,
             (p_anchor_date + coalesce(max(offset_end_days), 0) * interval '1 day')::date
        into v_start, v_end
        from public.job_template_milestones
       where template_id = p_template_id and org_id = p_org_id;

      if v_start is not null then
        insert into public.job_programme_baselines (org_id, job_id, revision, planned_start, planned_end, created_by)
        values (p_org_id, p_job_id, 1, v_start, v_end, auth.uid())
        returning id into v_baseline_id;

        for r in
          select * from public.job_template_milestones
           where template_id = p_template_id and org_id = p_org_id
           order by sort asc
        loop
          v_idx := v_idx + 1;
          insert into public.job_milestones (
            org_id, baseline_id, title, planned_start, planned_end,
            weight, customer_visible, sort
          ) values (
            p_org_id, v_baseline_id, r.title,
            case when r.offset_start_days is not null
                 then (p_anchor_date + r.offset_start_days * interval '1 day')::date else null end,
            (p_anchor_date + r.offset_end_days * interval '1 day')::date,
            r.weight, r.customer_visible, v_idx
          );
        end loop;
      end if;
    end if;
  end if;

  -- ── Checklist clone (any member) ──
  v_idx := 0;
  for r in
    select * from public.job_template_checklist_items
     where template_id = p_template_id and org_id = p_org_id
     order by sort asc
  loop
    v_idx := v_idx + 1;
    insert into public.job_checklists (org_id, job_id, label, requires_photo, sort, created_by)
    values (p_org_id, p_job_id, r.label, r.requires_photo, v_idx, auth.uid());
  end loop;

  return v_baseline_id;
end $$;

revoke all on function public.clone_job_template(uuid, uuid, uuid, date) from public, anon;
grant execute on function public.clone_job_template(uuid, uuid, uuid, date) to authenticated;
