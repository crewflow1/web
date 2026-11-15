-- Staff cannot forge audit columns, re-status a drawing, or publish / void a warranty
-- by direct PATCH (least-privilege enforcement — register ST-10 / ST-10b).
--
-- THE HOLE (what was left after 20261340)
-- ---------------------------------------
-- Ten tables remain legitimately writable by `staff` (site diary-side records the
-- product gives them: delay events, checklists, job documents, progress observations,
-- permit conditions, site visitors, drawings, inspection-plan templates). On those a
-- staff JWT could, straight at PostgREST:
--   * set created_by / recorded_by / completed_by / confirmed_by / signed_in_by /
--     signed_out_by / done_by / updated_by … to a COLLEAGUE's id, or rewrite created_at
--     — attribute a record to someone else or back-date it;
--   * change blueprints.status, which the app reserves for owner/admin
--     (setBlueprintStatus);
--   * set job_warranties.portal_published_at / voided_* — publish a warranty to the
--     customer portal or void it — although every warranty action is owner/admin only.
--
-- THE FIX
-- -------
-- 1. job_warranties: RESTRICTIVE owner/admin write policies (every in-app writer is
--    already admin-gated: app/(app)/jobs/[id]/warranties/actions.ts → requireAdmin).
-- 2. A BEFORE INSERT/UPDATE guard on the nine staff-writable tables, active only for a
--    client JWT that is NOT an owner/admin of the row's org:
--      - INSERT: created_by is stamped auth.uid() and created_at now() (whatever was sent);
--      - UPDATE: created_by / created_at are frozen at their stored values;
--      - an actor column (listed per table as a trigger argument) may only be set or
--        changed to the caller's own id (or cleared) — else 42501;
--      - an `admin:<column>` argument (blueprints.status) may not be changed — 42501.
--    Owners/admins, service_role and JWT-less sessions are untouched, so no existing
--    office or server flow changes behaviour. (An admin can therefore still edit these
--    columns directly — accepted residual, P3.)
--
-- data-api:exempt: policy + trigger only; adds no table and no grant.
-- Additive, idempotent.
--
-- Safe to apply before the code deploys: yes (no code depends on it; the app already
-- writes the caller's own id into these columns).
-- Production precondition: none.
--
-- Rollback (manual — reopens ST-10):
--   drop trigger client_audit_columns_guard on public.<table>;      (nine tables)
--   drop function public.tg_client_audit_columns_guard();
--   drop policy "job_warranties: admin-only <cmd>" on public.job_warranties;

-- 1. job_warranties — owner/admin writes only -------------------------------------
do $$
declare
  c text;
  pol text;
begin
  foreach c in array array['insert', 'update', 'delete']
  loop
    pol := 'job_warranties: admin-only ' || c;
    execute format('drop policy if exists %I on public.job_warranties', pol);
    if c = 'insert' then
      execute format(
        'create policy %I on public.job_warranties as restrictive for insert to authenticated '
        'with check (public.is_org_admin(org_id))', pol);
    elsif c = 'update' then
      execute format(
        'create policy %I on public.job_warranties as restrictive for update to authenticated '
        'using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id))', pol);
    else
      execute format(
        'create policy %I on public.job_warranties as restrictive for delete to authenticated '
        'using (public.is_org_admin(org_id))', pol);
    end if;
  end loop;
end $$;

-- 2. audit-column / status guard ----------------------------------------------------
create or replace function public.tg_client_audit_columns_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  n     jsonb := to_jsonb(new);
  o     jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  uid   uuid  := auth.uid();
  patch jsonb := '{}'::jsonb;
  arg   text;
  col   text;
begin
  -- Client JWTs only; the server (service_role / no JWT) is trusted.
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  -- Owners/admins of the row's org keep today's behaviour.
  if public.is_org_admin((n ->> 'org_id')::uuid) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if n ? 'created_by' then patch := patch || jsonb_build_object('created_by', uid); end if;
    if n ? 'created_at' then patch := patch || jsonb_build_object('created_at', now()); end if;
  else
    if n ? 'created_by' then patch := patch || jsonb_build_object('created_by', o -> 'created_by'); end if;
    if n ? 'created_at' then patch := patch || jsonb_build_object('created_at', o -> 'created_at'); end if;
  end if;

  foreach arg in array tg_argv
  loop
    if arg like 'admin:%' then
      col := substr(arg, 7);
      if tg_op = 'UPDATE' and (n -> col) is distinct from (o -> col) then
        raise exception 'Forbidden: only an owner or admin can change %', col
          using errcode = '42501';
      end if;
    else
      col := arg;
      if (n ->> col) is not null
         and (tg_op = 'INSERT' or (n -> col) is distinct from (o -> col))
         and (n ->> col) is distinct from uid::text then
        raise exception 'Forbidden: % can only be set to the signed-in user', col
          using errcode = '42501';
      end if;
    end if;
  end loop;

  if patch <> '{}'::jsonb then
    new := jsonb_populate_record(new, patch);
  end if;
  return new;
end $$;

comment on function public.tg_client_audit_columns_guard() is
  'ST-10/ST-10b: for a non-admin client JWT, stamps/freezes created_by + created_at, '
  'allows an actor column (trigger args) to be set only to auth.uid(), and refuses a '
  'change to an `admin:<column>` argument.';

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('delay_events',                   array['recorded_by', 'withdrawn_by']),
      ('inspection_plan_templates',      array['published_by']),
      ('inspection_plan_template_items', array[]::text[]),
      ('job_checklists',                 array['done_by']),
      ('job_documents',                  array['completed_by', 'updated_by']),
      ('job_progress_observations',      array['recorded_by']),
      ('permit_conditions',              array['confirmed_by']),
      ('site_visitors',                  array['signed_in_by', 'signed_out_by']),
      ('blueprints',                     array['updated_by', 'admin:status'])
    ) as v(tbl, args)
  loop
    execute format('drop trigger if exists client_audit_columns_guard on public.%I', spec.tbl);
    execute format(
      'create trigger client_audit_columns_guard before insert or update on public.%I '
      'for each row execute function public.tg_client_audit_columns_guard(%s)',
      spec.tbl,
      coalesce((select string_agg(quote_literal(a), ', ') from unnest(spec.args) a), ''));
  end loop;
end $$;
