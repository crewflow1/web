-- FEATURE 3 — Staff notification privacy.
--
-- PROBLEM. The notifications_select / notifications_update policies (added in
-- 20260611000000_notifications_os.sql) let EVERY member of an org read an
-- ORG-WIDE row (user_id IS NULL) as long as audience is customer/both:
--
--     user_id = auth.uid()
--     or (user_id is null and org_id in (select public.current_org_ids()))
--
-- Org-wide rows carry billing / stripe / onboarding / migration / support
-- content — company money and the CrewFlow subscription relationship — so a
-- NON-ADMIN staff member saw all of it in the notifications centre. That is a
-- tenant-internal privacy breach: staff must receive ONLY notifications about
-- work that directly concerns them.
--
-- FIX. A per-row recipient-eligibility marker (audience_scope) plus a hard
-- category gate, enforced at the DB as the authoritative READ boundary. The
-- SAME rule is applied in TypeScript to the service-role delivery fan-outs
-- (push / SMS / email digest) that bypass RLS — see lib/notifications/
-- eligibility.ts + recipient-eligibility.ts.
--
-- Additive + forward-only. No data is deleted or rewritten: ADD COLUMN with a
-- constant default is metadata-only, and the default ('admins') makes every
-- EXISTING org-wide row admin-only immediately — the correct, deny-by-default
-- posture, since every current org-wide customer emitter is admin-domain.

-- =====================================================================
-- 1. audience_scope — who within the org may see an org-wide row.
-- =====================================================================
--   'admins'   — owner/admin only (the safe default; deny-by-default).
--   'all'      — every member (reserved for genuine staff-wide news).
--   'assigned' — owner/admin + members assigned to the referenced job
--                (source_module = 'jobs', source_id = the job id).
-- Irrelevant for targeted rows (user_id set): those are read via user_id.

alter table public.notifications
  add column if not exists audience_scope text not null default 'admins'
    check (audience_scope in ('all', 'admins', 'assigned'));

comment on column public.notifications.audience_scope is
  'Staff-privacy scope for org-wide (user_id null) rows: admins | all | assigned. Default admins (deny-by-default). See lib/notifications/eligibility.ts.';

-- Supports the org-wide read path (org + un-dismissed + scope).
create index if not exists notifications_org_scope_idx
  on public.notifications (org_id, audience_scope)
  where user_id is null and dismissed_at is null;

-- =====================================================================
-- 2. RLS — rewrite SELECT + UPDATE with the staff-privacy gate.
-- =====================================================================
-- Unchanged outer boundary: audience in ('customer','both'); a targeted row
-- (user_id = auth.uid()) is always the caller's. The NEW logic applies only to
-- ORG-WIDE rows: admins see everything; a non-admin staff member sees a row only
-- when its category is not in the admin-only set AND its scope admits them.
--
-- The job-assignment check compares source_id (text) against my_assigned_job_ids()
-- cast to text — casting uuid->text is always safe, avoiding an unguarded
-- text->uuid cast on arbitrary source_id values. my_assigned_job_ids() and
-- is_org_admin() are the same SECURITY DEFINER helpers used across R5.

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (
    audience in ('customer', 'both')
    and (
      user_id = auth.uid()
      or (
        user_id is null
        and org_id in (select public.current_org_ids())
        and (
          public.is_org_admin(org_id)
          or (
            category not in (
              'support', 'billing', 'stripe', 'onboarding', 'migration',
              'demo', 'signup', 'health', 'alert', 'system'
            )
            and (
              audience_scope = 'all'
              or (
                audience_scope = 'assigned'
                and source_module = 'jobs'
                and source_id is not null
                and source_id in (
                  select t.job_id::text
                  from public.my_assigned_job_ids() as t(job_id)
                )
              )
            )
          )
        )
      )
    )
  );

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated using (
    audience in ('customer', 'both')
    and (
      user_id = auth.uid()
      or (
        user_id is null
        and org_id in (select public.current_org_ids())
        and (
          public.is_org_admin(org_id)
          or (
            category not in (
              'support', 'billing', 'stripe', 'onboarding', 'migration',
              'demo', 'signup', 'health', 'alert', 'system'
            )
            and (
              audience_scope = 'all'
              or (
                audience_scope = 'assigned'
                and source_module = 'jobs'
                and source_id is not null
                and source_id in (
                  select t.job_id::text
                  from public.my_assigned_job_ids() as t(job_id)
                )
              )
            )
          )
        )
      )
    )
  )
  with check (
    audience in ('customer', 'both')
    and (
      user_id = auth.uid()
      or (
        user_id is null
        and org_id in (select public.current_org_ids())
        and (
          public.is_org_admin(org_id)
          or (
            category not in (
              'support', 'billing', 'stripe', 'onboarding', 'migration',
              'demo', 'signup', 'health', 'alert', 'system'
            )
            and (
              audience_scope = 'all'
              or (
                audience_scope = 'assigned'
                and source_module = 'jobs'
                and source_id is not null
                and source_id in (
                  select t.job_id::text
                  from public.my_assigned_job_ids() as t(job_id)
                )
              )
            )
          )
        )
      )
    )
  );

-- HQ super-admins still read via the service-role client (bypasses RLS) —
-- unchanged. No grant change: audience_scope is a new column on an already
-- client-granted table, not a new client-reachable table.
