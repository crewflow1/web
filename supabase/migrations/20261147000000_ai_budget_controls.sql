-- AI Cost Governor — THE EDITABLE CONTROLS: per-org ceiling override + per-employee limits.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.                        ║
-- ║                                                                            ║
-- ║  Until now the £100/org/month ceiling was a hard-coded constant            ║
-- ║  (AI_MONTHLY_CEILING_PENCE in lib/ai/governor/policy.ts) and there was NO  ║
-- ║  per-employee dimension — the budget was keyed by org+feature only. This   ║
-- ║  migration makes the ceiling EDITABLE per org (bounded by a hard safety    ║
-- ║  max) and adds a PER-EMPLOYEE monthly limit, both audited, both enforced   ║
-- ║  FAIL-CLOSED by the atomic reservation (see 20261147000001, which replaces ║
-- ║  ai_reserve_invocation to read these tables under its per-org lock).       ║
-- ║                                                                            ║
-- ║  IT ACTIVATES NOTHING. Every cost tier still maps to no model              ║
-- ║  (lib/ai/governor/registry.ts), so on production these tables are created  ║
-- ║  correct and permanently EMPTY, the reserve path is never reached, and no  ║
-- ║  behaviour a user or a bill can observe changes. This is a control built   ║
-- ║  ahead of the thing it controls, exactly like the reservation before it.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── WHY A HARD SAFETY MAX, NOT JUST AN OVERRIDE ─────────────────────────────
-- The instant an override can change the ceiling, the old constant stops being
-- the hard limit and becomes merely the DEFAULT. Something must still be the
-- hard limit or the override turns the safety cap into a suggestion — the exact
-- property the whole governor exists to prevent. So the override is BOUNDED:
-- `[0, 50000]` pence (£0 .. £500, the whole subscription), enforced by a CHECK
-- here AND re-clamped in the reserve function under its lock, so a row written
-- around the application can never widen the gate. 50000 mirrors
-- AI_MONTHLY_CEILING_HARD_MAX_PENCE in policy.ts; the security suite pins them
-- equal.
--
-- ── RLS POSTURE: identical to ai_invocations / ai_cost_reservations ──────────
-- ADMIN-READ-ONLY per org (is_org_admin), and NO insert/update/delete policy at
-- all. Every write goes through the service-role client via the RPCs below, so a
-- tenant client structurally cannot forge, raise, or clear a limit. A forged
-- ceiling is a spend-authorisation primitive; a forged (low) limit is a
-- denial-of-service primitive. Neither is reachable from a tenant JWT.
--
-- Additive, idempotent, reversible. To roll back:
--   drop function if exists public.ai_clear_employee_limit(uuid, uuid, uuid, text);
--   drop function if exists public.ai_set_employee_limit(uuid, uuid, integer, uuid, text);
--   drop function if exists public.ai_clear_org_ceiling(uuid, uuid, text);
--   drop function if exists public.ai_set_org_ceiling(uuid, integer, uuid, text);
--   drop function if exists public.ai_employee_month_totals(uuid, uuid, date);
--   drop trigger  if exists ai_budget_control_audit_append_only on public.ai_budget_control_audit;
--   drop function if exists public.tg_ai_budget_control_audit_append_only();
--   drop table if exists public.ai_budget_control_audit;
--   drop table if exists public.ai_employee_budget_limits;
--   drop table if exists public.ai_org_budget_ceilings;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE PER-ORG CEILING OVERRIDE — one row per org, or none (⇒ the default)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.ai_org_budget_ceilings (
  org_id uuid primary key references public.organizations(id) on delete cascade,

  -- The EFFECTIVE ceiling this org runs at, in integer pence. Bounded by the
  -- hard safety max (50000 = £500). 0 is valid and means "no AI at all".
  ceiling_pence integer not null
    check (ceiling_pence >= 0 and ceiling_pence <= 50000),

  -- Optional reviewer note explaining WHY this org is off the default.
  note text check (note is null or length(trim(note)) between 1 and 500),

  -- Who set it. `set null` on user deletion: losing the person must not erase
  -- the fact that the org is off the default.
  set_by uuid references public.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_org_budget_ceilings is
  'AI Cost Governor per-org ceiling OVERRIDE. Absent ⇒ the org runs at AI_MONTHLY_CEILING_PENCE (£100). Bounded [0,50000]p by CHECK and re-clamped in ai_reserve_invocation. Admin-read-only; service-role write via ai_set_org_ceiling / ai_clear_org_ceiling only; every change audited.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE PER-EMPLOYEE LIMIT — an additional monthly cap on ONE user's AI spend
-- ═══════════════════════════════════════════════════════════════════════════
-- The employee dimension is the acting user_id — the same one the ledger and the
-- reservation already carry. A limit here is enforced ON TOP OF the org ceiling:
-- a call must fit under BOTH. System / HQ jobs (user_id null on the invocation)
-- have no employee to limit and fall under the org ceiling alone — see
-- lib/ai/governor/attribution.ts.
create table if not exists public.ai_employee_budget_limits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  -- The employee this limit applies to. `on delete cascade`: a limit is
  -- CONFIGURATION, not history — when the employee is gone the config is
  -- meaningless (unlike the reservation's user_id, which is history and is
  -- nulled). Their PAST spend stays in ai_invocations under its own set-null.
  user_id uuid not null references public.users(id) on delete cascade,

  limit_pence integer not null
    check (limit_pence >= 0 and limit_pence <= 50000),

  note text check (note is null or length(trim(note)) between 1 and 500),
  set_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One limit per (org, employee). The upsert RPC keys on this.
  unique (org_id, user_id)
);

comment on table public.ai_employee_budget_limits is
  'AI Cost Governor per-employee monthly limit, in pence, enforced ON TOP OF the org ceiling by ai_reserve_invocation (a call must fit under BOTH). Absent ⇒ the employee is bounded only by the org ceiling. Admin-read-only; service-role write via ai_set_employee_limit / ai_clear_employee_limit only; every change audited.';

create index if not exists ai_employee_budget_limits_org_idx
  on public.ai_employee_budget_limits (org_id, user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE AUDIT TRAIL — every control change, append-only
-- ═══════════════════════════════════════════════════════════════════════════
-- "Changes are audited" is a DB guarantee here, not a hopeful second write: the
-- set/clear RPCs below write the config row AND this audit row in ONE
-- transaction, so a change can never land without its audit entry. The table is
-- APPEND-ONLY by trigger (like ai_invocations): a record of who raised a ceiling
-- and when is worthless if it can be edited afterwards.
create table if not exists public.ai_budget_control_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  control_type text not null check (control_type in ('org_ceiling', 'employee_limit')),
  -- The employee, for an employee_limit change; null for an org_ceiling change.
  target_user_id uuid references public.users(id) on delete set null,
  action text not null check (action in ('set', 'clear')),

  -- The transition, in pence. Null where there was nothing (a first set) or
  -- nothing after (a clear).
  old_pence integer check (old_pence is null or (old_pence >= 0 and old_pence <= 50000)),
  new_pence integer check (new_pence is null or (new_pence >= 0 and new_pence <= 50000)),

  -- Who changed it — the super-admin. Email captured too, because the email
  -- allowlist (not a DB role) is the identity that matters for HQ actions and a
  -- deleted user row must not erase who did it.
  changed_by uuid references public.users(id) on delete set null,
  changed_by_email text check (changed_by_email is null or length(trim(changed_by_email)) between 1 and 320),
  note text check (note is null or length(trim(note)) between 1 and 500),

  created_at timestamptz not null default now()
);

comment on table public.ai_budget_control_audit is
  'AI Cost Governor control-change audit. Append-only (tg_ai_budget_control_audit_append_only): who set/cleared which org ceiling or employee limit, from what to what, and when. Written atomically with the change by the set/clear RPCs. Admin-read-only per org; service-role write only.';

create index if not exists ai_budget_control_audit_org_idx
  on public.ai_budget_control_audit (org_id, created_at desc);

-- ── APPEND-ONLY GUARD ───────────────────────────────────────────────────────
-- No UPDATE and no DELETE, with the SAME two FK-driven anonymisation holes the
-- ledger and the reservation cut: target_user_id -> null and changed_by -> null
-- are permitted (a departed employee / admin) when every other column is
-- byte-identical. DELETE is otherwise refused so a row cannot be erased, EXCEPT
-- that `organizations ... on delete cascade` must still tear an org down — which
-- a BEFORE DELETE guard would abort, re-opening the teardown/GDPR failure the
-- storage wave fixed. So the guard allows a delete only when the org row is
-- itself gone (the cascade), and refuses every other delete.
create or replace function public.tg_ai_budget_control_audit_append_only()
returns trigger language plpgsql
set search_path = ''
as $$
declare
  v_expected public.ai_budget_control_audit%rowtype;
begin
  if tg_op = 'DELETE' then
    -- Permit ONLY the org-teardown cascade: the parent org row is already gone.
    if not exists (select 1 from public.organizations o where o.id = old.org_id) then
      return old;
    end if;
    raise exception
      'ai_budget_control_audit is append-only — an audit row cannot be deleted'
      using errcode = 'check_violation';
  end if;

  -- UPDATE: only the FK-driven null of target_user_id / changed_by, nothing else.
  v_expected := old;
  if old.target_user_id is not null and new.target_user_id is null then
    v_expected.target_user_id := null;
  end if;
  if old.changed_by is not null and new.changed_by is null then
    v_expected.changed_by := null;
  end if;
  if new is not distinct from v_expected then
    return new;
  end if;

  raise exception
    'ai_budget_control_audit is append-only — a recorded change cannot be rewritten'
    using errcode = 'check_violation';
end $$;

drop trigger if exists ai_budget_control_audit_append_only on public.ai_budget_control_audit;
create trigger ai_budget_control_audit_append_only
  before update or delete on public.ai_budget_control_audit
  for each row execute function public.tg_ai_budget_control_audit_append_only();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS — admin-read-only per org, no tenant write anywhere
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.ai_org_budget_ceilings     enable row level security;
alter table public.ai_employee_budget_limits  enable row level security;
alter table public.ai_budget_control_audit    enable row level security;

drop policy if exists ai_org_budget_ceilings_select on public.ai_org_budget_ceilings;
create policy ai_org_budget_ceilings_select on public.ai_org_budget_ceilings
  for select using (public.is_org_admin(org_id));

drop policy if exists ai_employee_budget_limits_select on public.ai_employee_budget_limits;
create policy ai_employee_budget_limits_select on public.ai_employee_budget_limits
  for select using (public.is_org_admin(org_id));

drop policy if exists ai_budget_control_audit_select on public.ai_budget_control_audit;
create policy ai_budget_control_audit_select on public.ai_budget_control_audit
  for select using (public.is_org_admin(org_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. THE WRITE RPCs — config + audit in ONE transaction
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER (note the absence of `security definer`), exactly like the
-- reservation RPCs. They are GRANTed to service_role only; service_role bypasses
-- RLS, so it can write the no-policy config tables, and a tenant calling these
-- directly is refused. Every one clamps to the hard max (defence in depth behind
-- the CHECK and the editor) and writes the audit row in the same statement
-- sequence, so a config change cannot exist without its audit.

-- 5a. Set (upsert) the per-org ceiling override.
create or replace function public.ai_set_org_ceiling(
  p_org_id       uuid,
  p_ceiling_pence integer,
  p_set_by       uuid default null,
  p_note         text default null
)
returns table (old_pence integer, new_pence integer)
language plpgsql
set search_path = ''
as $$
declare
  v_old   integer;
  v_new   integer;
  v_email text;
begin
  if p_org_id is null or p_ceiling_pence is null then
    raise exception 'organisation and ceiling are required'
      using errcode = 'invalid_parameter_value';
  end if;
  -- Clamp to the hard safety max. A value outside [0,50000] is refused by the
  -- CHECK, but clamping first means a caller that passes a larger number gets
  -- the capped ceiling rather than a raw error — the safe, documented behaviour.
  v_new := greatest(0, least(p_ceiling_pence, 50000));

  select ceiling_pence into v_old
    from public.ai_org_budget_ceilings where org_id = p_org_id;

  select email into v_email from public.users where id = p_set_by;

  insert into public.ai_org_budget_ceilings (org_id, ceiling_pence, note, set_by, updated_at)
  values (p_org_id, v_new, nullif(trim(coalesce(p_note, '')), ''), p_set_by, now())
  on conflict (org_id) do update
    set ceiling_pence = excluded.ceiling_pence,
        note          = excluded.note,
        set_by        = excluded.set_by,
        updated_at    = now();

  insert into public.ai_budget_control_audit
    (org_id, control_type, target_user_id, action, old_pence, new_pence,
     changed_by, changed_by_email, note)
  values
    (p_org_id, 'org_ceiling', null, 'set', v_old, v_new,
     p_set_by, v_email, nullif(trim(coalesce(p_note, '')), ''));

  return query select v_old, v_new;
end $$;

-- 5b. Clear the override (fall back to the default).
create or replace function public.ai_clear_org_ceiling(
  p_org_id uuid,
  p_set_by uuid default null,
  p_note   text default null
)
returns table (old_pence integer)
language plpgsql
set search_path = ''
as $$
declare
  v_old   integer;
  v_email text;
begin
  if p_org_id is null then
    raise exception 'organisation is required' using errcode = 'invalid_parameter_value';
  end if;

  select ceiling_pence into v_old
    from public.ai_org_budget_ceilings where org_id = p_org_id;
  if v_old is null then
    -- Nothing to clear; do not write a phantom audit row.
    return query select null::integer;
    return;
  end if;

  delete from public.ai_org_budget_ceilings where org_id = p_org_id;

  select email into v_email from public.users where id = p_set_by;
  insert into public.ai_budget_control_audit
    (org_id, control_type, target_user_id, action, old_pence, new_pence,
     changed_by, changed_by_email, note)
  values
    (p_org_id, 'org_ceiling', null, 'clear', v_old, null,
     p_set_by, v_email, nullif(trim(coalesce(p_note, '')), ''));

  return query select v_old;
end $$;

-- 5c. Set (upsert) a per-employee limit.
create or replace function public.ai_set_employee_limit(
  p_org_id      uuid,
  p_user_id     uuid,
  p_limit_pence integer,
  p_set_by      uuid default null,
  p_note        text default null
)
returns table (old_pence integer, new_pence integer)
language plpgsql
set search_path = ''
as $$
declare
  v_old   integer;
  v_new   integer;
  v_email text;
begin
  if p_org_id is null or p_user_id is null or p_limit_pence is null then
    raise exception 'organisation, employee and limit are all required'
      using errcode = 'invalid_parameter_value';
  end if;
  v_new := greatest(0, least(p_limit_pence, 50000));

  select limit_pence into v_old
    from public.ai_employee_budget_limits
   where org_id = p_org_id and user_id = p_user_id;

  select email into v_email from public.users where id = p_set_by;

  insert into public.ai_employee_budget_limits
    (org_id, user_id, limit_pence, note, set_by, updated_at)
  values
    (p_org_id, p_user_id, v_new, nullif(trim(coalesce(p_note, '')), ''), p_set_by, now())
  on conflict (org_id, user_id) do update
    set limit_pence = excluded.limit_pence,
        note        = excluded.note,
        set_by      = excluded.set_by,
        updated_at  = now();

  insert into public.ai_budget_control_audit
    (org_id, control_type, target_user_id, action, old_pence, new_pence,
     changed_by, changed_by_email, note)
  values
    (p_org_id, 'employee_limit', p_user_id, 'set', v_old, v_new,
     p_set_by, v_email, nullif(trim(coalesce(p_note, '')), ''));

  return query select v_old, v_new;
end $$;

-- 5d. Clear a per-employee limit.
create or replace function public.ai_clear_employee_limit(
  p_org_id  uuid,
  p_user_id uuid,
  p_set_by  uuid default null,
  p_note    text default null
)
returns table (old_pence integer)
language plpgsql
set search_path = ''
as $$
declare
  v_old   integer;
  v_email text;
begin
  if p_org_id is null or p_user_id is null then
    raise exception 'organisation and employee are required'
      using errcode = 'invalid_parameter_value';
  end if;

  select limit_pence into v_old
    from public.ai_employee_budget_limits
   where org_id = p_org_id and user_id = p_user_id;
  if v_old is null then
    return query select null::integer;
    return;
  end if;

  delete from public.ai_employee_budget_limits
   where org_id = p_org_id and user_id = p_user_id;

  select email into v_email from public.users where id = p_set_by;
  insert into public.ai_budget_control_audit
    (org_id, control_type, target_user_id, action, old_pence, new_pence,
     changed_by, changed_by_email, note)
  values
    (p_org_id, 'employee_limit', p_user_id, 'clear', v_old, null,
     p_set_by, v_email, nullif(trim(coalesce(p_note, '')), ''));

  return query select v_old;
end $$;

revoke all on function public.ai_set_org_ceiling(uuid, integer, uuid, text)      from public;
revoke all on function public.ai_clear_org_ceiling(uuid, uuid, text)             from public;
revoke all on function public.ai_set_employee_limit(uuid, uuid, integer, uuid, text) from public;
revoke all on function public.ai_clear_employee_limit(uuid, uuid, uuid, text)    from public;
grant execute on function public.ai_set_org_ceiling(uuid, integer, uuid, text)      to service_role;
grant execute on function public.ai_clear_org_ceiling(uuid, uuid, text)             to service_role;
grant execute on function public.ai_set_employee_limit(uuid, uuid, integer, uuid, text) to service_role;
grant execute on function public.ai_clear_employee_limit(uuid, uuid, uuid, text)    to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. ai_employee_month_totals — one employee's committed + live-reserved spend
-- ═══════════════════════════════════════════════════════════════════════════
-- The per-employee analogue of ai_reservations_month_totals: what has THIS user
-- spent (committed) and claimed (live) this UK month, so the limits editor can
-- show usage against the limit and the tests can prove attribution. SECURITY
-- INVOKER + empty search_path, exactly like the other rollups — a definer-rights
-- aggregate over an org-scoped table is the cross-tenant read primitive the
-- storage wave eliminated. The Europe/London window matches the reserve function.
create or replace function public.ai_employee_month_totals(
  p_org_id  uuid,
  p_user_id uuid,
  p_month   date default current_date
)
returns table (
  org_id          uuid,
  user_id         uuid,
  month_start     date,
  committed_pence bigint,
  live_pence      bigint,
  invocations     bigint
)
language sql
stable
set search_path = ''
as $$
  with bounds as (
    select
      date_trunc('month', p_month::timestamp)                      as naive_start,
      date_trunc('month', p_month::timestamp) + interval '1 month' as naive_end
  )
  select
    p_org_id  as org_id,
    p_user_id as user_id,
    (select naive_start from bounds)::date as month_start,
    coalesce((
      select sum(i.estimated_cost_pence) from public.ai_invocations i, bounds b
       where i.org_id = p_org_id and i.user_id = p_user_id
         and i.created_at >= (b.naive_start at time zone 'Europe/London')
         and i.created_at <  (b.naive_end   at time zone 'Europe/London')
    ), 0)::bigint as committed_pence,
    coalesce((
      select sum(r.estimate_pence) from public.ai_cost_reservations r, bounds b
       where r.org_id = p_org_id and r.user_id = p_user_id
         and r.state = 'reserved' and r.expires_at > now()
         and r.created_at >= (b.naive_start at time zone 'Europe/London')
         and r.created_at <  (b.naive_end   at time zone 'Europe/London')
    ), 0)::bigint as live_pence,
    coalesce((
      select count(*) from public.ai_invocations i, bounds b
       where i.org_id = p_org_id and i.user_id = p_user_id
         and i.created_at >= (b.naive_start at time zone 'Europe/London')
         and i.created_at <  (b.naive_end   at time zone 'Europe/London')
    ), 0)::bigint as invocations;
$$;

revoke all on function public.ai_employee_month_totals(uuid, uuid, date) from public;
grant execute on function public.ai_employee_month_totals(uuid, uuid, date)
  to anon, authenticated, service_role;
