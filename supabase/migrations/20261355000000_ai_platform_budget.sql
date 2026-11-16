-- 20261355000000 — CrewFlow-wide AI spending ceiling.
--
-- WHY: every AI call is already reserved atomically against a per-org monthly
-- ceiling (default £100, hard-clamped at £500) and, optionally, a per-employee
-- limit (20261070000000, 20261147000000/1). Nothing bounded the SUM across
-- orgs: worst-case application-bounded spend grew linearly with the number of
-- companies. This adds one platform-wide monthly budget, enforced inside the
-- same reservation transaction, so a call must fit under org AND employee AND
-- platform headroom.
--
-- This is an APPLICATION budget. It does not bound a leaked provider key or a
-- code path that skips the governor; provider-side caps remain a founder
-- console setting (docs/programme/security-secrets/AI-SPEND-GOVERNANCE.md §6).
--
-- Default: 50000p (£500) per Europe/London month across all orgs — a founder
-- decision to confirm; production spend was £2.74 in the 30 days to 2026-11-13.
-- Changing it is a super-admin action through ai_set_platform_ceiling, which
-- clamps to 1,000,000p and writes an audit row in the same transaction.
--
-- Rollback: re-apply the previous ai_reserve_invocation definition from
-- 20261147000001 (the RPC signature and result columns are unchanged), then
-- drop ai_set_platform_ceiling, ai_platform_budget_audit, ai_platform_budget.

begin;

create table if not exists public.ai_platform_budget (
  id            boolean primary key default true check (id),
  ceiling_pence integer not null check (ceiling_pence >= 0 and ceiling_pence <= 1000000),
  note          text check (note is null or length(trim(note)) between 1 and 500),
  set_by        uuid references public.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

comment on table public.ai_platform_budget is
  'Single row: CrewFlow-wide monthly AI application budget (pence). Service-role only; read by ai_reserve_invocation.';

insert into public.ai_platform_budget (id, ceiling_pence, note)
values (true, 50000, 'initial default (20261355000000)')
on conflict (id) do nothing;

create table if not exists public.ai_platform_budget_audit (
  id               uuid primary key default gen_random_uuid(),
  old_pence        integer check (old_pence is null or (old_pence >= 0 and old_pence <= 1000000)),
  new_pence        integer not null check (new_pence >= 0 and new_pence <= 1000000),
  changed_by       uuid references public.users(id) on delete set null,
  changed_by_email text check (changed_by_email is null or length(trim(changed_by_email)) between 1 and 320),
  note             text check (note is null or length(trim(note)) between 1 and 500),
  created_at       timestamptz not null default now()
);

create index if not exists ai_platform_budget_audit_created_idx
  on public.ai_platform_budget_audit (created_at desc);

-- Platform-wide live-claim sum is read on every reservation.
create index if not exists ai_cost_reservations_platform_live_idx
  on public.ai_cost_reservations (created_at)
  where state = 'reserved';

alter table public.ai_platform_budget enable row level security;
alter table public.ai_platform_budget_audit enable row level security;
-- No policies: service role only. Remove the Supabase default grants too.
revoke all on table public.ai_platform_budget from anon, authenticated, public;
revoke all on table public.ai_platform_budget_audit from anon, authenticated, public;
grant select, insert, update on table public.ai_platform_budget to service_role;
grant select, insert on table public.ai_platform_budget_audit to service_role;

create or replace function public.ai_set_platform_ceiling(
  p_ceiling_pence integer,
  p_set_by uuid default null,
  p_note text default null
)
returns table(old_pence integer, new_pence integer)
language plpgsql
set search_path to ''
as $function$
declare
  v_old   integer;
  v_new   integer;
  v_email text;
begin
  if p_ceiling_pence is null then
    raise exception 'ceiling is required' using errcode = 'invalid_parameter_value';
  end if;
  v_new := greatest(0, least(p_ceiling_pence, 1000000));

  -- Same lock the reservation takes: a change cannot interleave with a claim.
  perform pg_advisory_xact_lock(hashtext('ai_platform_budget'), 0);

  select b.ceiling_pence into v_old from public.ai_platform_budget b where b.id;
  select u.email into v_email from public.users u where u.id = p_set_by;

  insert into public.ai_platform_budget (id, ceiling_pence, note, set_by, updated_at)
  values (true, v_new, nullif(trim(coalesce(p_note, '')), ''), p_set_by, now())
  on conflict (id) do update
    set ceiling_pence = excluded.ceiling_pence,
        note          = excluded.note,
        set_by        = excluded.set_by,
        updated_at    = now();

  insert into public.ai_platform_budget_audit
    (old_pence, new_pence, changed_by, changed_by_email, note)
  values
    (v_old, v_new, p_set_by, v_email, nullif(trim(coalesce(p_note, '')), ''));

  return query select v_old, v_new;
end $function$;

revoke all on function public.ai_set_platform_ceiling(integer, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_set_platform_ceiling(integer, uuid, text) to service_role;

-- HQ read model: the same three numbers the reservation compares, for /admin/ai-costs.
create or replace function public.ai_platform_month_usage()
returns table(ceiling_pence integer, committed_pence bigint, reserved_pence bigint)
language sql
stable
set search_path to ''
as $function$
  with m as (
    select (date_trunc('month', (now() at time zone 'Europe/London')) at time zone 'Europe/London') as s,
           ((date_trunc('month', (now() at time zone 'Europe/London')) + interval '1 month') at time zone 'Europe/London') as e
  )
  select
    least(coalesce((select b.ceiling_pence from public.ai_platform_budget b where b.id), 50000), 1000000),
    (select coalesce(sum(i.estimated_cost_pence), 0)::bigint from public.ai_invocations i, m
      where i.created_at >= m.s and i.created_at < m.e),
    (select coalesce(sum(r.estimate_pence), 0)::bigint from public.ai_cost_reservations r, m
      where r.state = 'reserved' and r.expires_at > now() and r.created_at >= m.s and r.created_at < m.e)
$function$;

revoke all on function public.ai_platform_month_usage() from public, anon, authenticated;
grant execute on function public.ai_platform_month_usage() to service_role;


create or replace function public.ai_reserve_invocation(p_org_id uuid, p_feature text, p_task_class text, p_estimate_pence integer, p_user_id uuid DEFAULT NULL::uuid, p_content_hash text DEFAULT NULL::text, p_ceiling_pence integer DEFAULT 10000, p_ttl_seconds integer DEFAULT 600, p_dedupe_window_seconds integer DEFAULT 900)
 RETURNS TABLE(outcome text, reservation_id uuid, committed_pence bigint, reserved_pence bigint, ceiling_pence integer, duplicate_reason text, block_reason text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_month_start     timestamptz;
  v_month_end       timestamptz;
  v_committed       bigint  := 0;
  v_reserved        bigint  := 0;
  v_user_committed  bigint  := 0;
  v_user_reserved   bigint  := 0;
  v_claim           integer;
  v_ttl             integer;
  v_window          integer;
  v_reservation     uuid;
  v_dup             text;
  v_override        integer;
  v_ceiling         integer;
  v_emp_limit       integer;
  v_plat_ceiling    integer;
  v_plat_committed  bigint  := 0;
  v_plat_reserved   bigint  := 0;
begin
  if p_org_id is null or p_feature is null or p_task_class is null then
    raise exception 'organisation, feature and task class are all required'
      using errcode = 'invalid_parameter_value';
  end if;

  v_claim  := greatest(1, coalesce(p_estimate_pence, 1));
  v_ttl    := greatest(1, coalesce(p_ttl_seconds, 600));
  v_window := greatest(0, coalesce(p_dedupe_window_seconds, 900));

  -- ── THE SERIALISATION POINT ────────────────────────────────────────────────
  -- Everything from here to COMMIT is serialised per org — including the
  -- override read, so a concurrent ceiling change cannot race this reservation.
  perform pg_advisory_xact_lock(hashtext('ai_budget_reservation'), hashtext(p_org_id::text));

  -- ── EFFECTIVE CEILING = override ?? default, clamped to the hard safety max ──
  -- Mirrors effectiveCeilingPence() in lib/ai/governor/policy.ts; the security
  -- suite pins the two. The clamp is authoritative: no override can widen the
  -- gate past 50000p (£500), and a non-positive effective ceiling means "no AI".
  select ai_org_budget_ceilings.ceiling_pence into v_override
    from public.ai_org_budget_ceilings
   where ai_org_budget_ceilings.org_id = p_org_id;

  v_ceiling := least(coalesce(v_override, p_ceiling_pence), 50000);

  if v_ceiling is null or v_ceiling <= 0 then
    return query select 'blocked'::text, null::uuid, 0::bigint, 0::bigint,
                        coalesce(v_ceiling, 0), null::text, 'org_ceiling'::text;
    return;
  end if;

  -- The EUROPE/LONDON budget month, identical to ai_invocations_month_totals.
  v_month_start := (date_trunc('month', (now() at time zone 'Europe/London'))
                      at time zone 'Europe/London');
  v_month_end   := ((date_trunc('month', (now() at time zone 'Europe/London'))
                      + interval '1 month') at time zone 'Europe/London');

  -- LAZY TTL RECLAIM (cosmetic — every aggregate filters expires_at > now()).
  update public.ai_cost_reservations
     set state = 'expired', settled_at = now()
   where org_id = p_org_id
     and state = 'reserved'
     and expires_at <= now();

  -- ORG committed spend, this UK month (immutable ledger).
  select coalesce(sum(i.estimated_cost_pence), 0)::bigint
    into v_committed
    from public.ai_invocations i
   where i.org_id = p_org_id
     and i.created_at >= v_month_start
     and i.created_at <  v_month_end;

  -- ORG live claims (unexpired) this UK month.
  select coalesce(sum(r.estimate_pence), 0)::bigint
    into v_reserved
    from public.ai_cost_reservations r
   where r.org_id = p_org_id
     and r.state = 'reserved'
     and r.expires_at > now()
     and r.created_at >= v_month_start
     and r.created_at <  v_month_end;

  -- ── PLATFORM-WIDE CEILING (20261355000000) ─────────────────────────────────
  -- One CrewFlow-wide monthly budget across EVERY org (HQ included), on top of
  -- the per-org ceiling and the per-employee limit. Taken AFTER the org lock —
  -- every caller locks org → platform in the same order, so no deadlock — and
  -- held to COMMIT, so the platform sum cannot race. A missing row means the
  -- built-in default (50000p = £500), never "unlimited"; a non-positive ceiling means no
  -- AI anywhere. The clamp (1,000,000p) is authoritative.
  perform pg_advisory_xact_lock(hashtext('ai_platform_budget'), 0);

  select least(coalesce(
           (select b.ceiling_pence from public.ai_platform_budget b where b.id),
           50000), 1000000)
    into v_plat_ceiling;

  if v_plat_ceiling is null or v_plat_ceiling <= 0 then
    return query select 'blocked'::text, null::uuid, v_committed, v_reserved,
                        v_ceiling, null::text, 'platform_ceiling'::text;
    return;
  end if;

  select coalesce(sum(i.estimated_cost_pence), 0)::bigint
    into v_plat_committed
    from public.ai_invocations i
   where i.created_at >= v_month_start
     and i.created_at <  v_month_end;

  select coalesce(sum(r.estimate_pence), 0)::bigint
    into v_plat_reserved
    from public.ai_cost_reservations r
   where r.state = 'reserved'
     and r.expires_at > now()
     and r.created_at >= v_month_start
     and r.created_at <  v_month_end;

  -- ── PER-EMPLOYEE LIMIT (only when one is configured for this acting user) ───
  -- System / HQ jobs (p_user_id null) have no employee to limit — the org
  -- ceiling alone governs them. When a limit row exists, read this user's own
  -- committed + live-reserved this month, under the SAME lock, so the employee
  -- gate is as race-free as the org gate.
  if p_user_id is not null then
    select limit_pence into v_emp_limit
      from public.ai_employee_budget_limits
     where org_id = p_org_id and user_id = p_user_id;

    if v_emp_limit is not null then
      select coalesce(sum(i.estimated_cost_pence), 0)::bigint
        into v_user_committed
        from public.ai_invocations i
       where i.org_id = p_org_id and i.user_id = p_user_id
         and i.created_at >= v_month_start
         and i.created_at <  v_month_end;

      select coalesce(sum(r.estimate_pence), 0)::bigint
        into v_user_reserved
        from public.ai_cost_reservations r
       where r.org_id = p_org_id and r.user_id = p_user_id
         and r.state = 'reserved'
         and r.expires_at > now()
         and r.created_at >= v_month_start
         and r.created_at <  v_month_end;
    end if;
  end if;

  -- ── DEDUPE, SERIALISED BY THE LOCK ABOVE (unchanged from 20261070000000) ────
  if p_content_hash is not null then
    select case when r.state = 'reserved' then 'in_flight' else 'recent_success' end
      into v_dup
      from public.ai_cost_reservations r
     where r.org_id = p_org_id
       and r.feature = p_feature
       and r.content_hash = p_content_hash
       and r.created_at >= now() - make_interval(secs => v_window)
       and (
         (r.state = 'reserved' and r.expires_at > now())
         or (r.state = 'settled' and r.success)
       )
     order by r.created_at desc
     limit 1;

    if v_dup is not null then
      return query select 'duplicate'::text, null::uuid, v_committed, v_reserved,
                          v_ceiling, v_dup, null::text;
      return;
    end if;
  end if;

  -- ── THE CONDITIONAL INSERT: org gate AND employee gate, one statement ───────
  insert into public.ai_cost_reservations (
    org_id, user_id, feature, task_class, estimate_pence, content_hash, expires_at
  )
  select p_org_id, p_user_id, p_feature, p_task_class, v_claim, p_content_hash,
         now() + make_interval(secs => v_ttl)
   where v_committed + v_reserved < v_ceiling                       -- (a) org band
     and v_committed + v_reserved + v_claim <= v_ceiling            -- (b) org reserve
     and (                                                          -- (c) employee reserve
       v_emp_limit is null
       or v_user_committed + v_user_reserved + v_claim <= v_emp_limit
     )
     and v_plat_committed + v_plat_reserved + v_claim <= v_plat_ceiling  -- (d) platform
  returning id into v_reservation;

  if v_reservation is null then
    -- Which gate refused? The org ceiling is the more fundamental, so it wins
    -- the label when both would refuse.
    return query select 'blocked'::text, null::uuid, v_committed, v_reserved, v_ceiling,
                        null::text,
                        case
                          when v_committed + v_reserved >= v_ceiling
                            or v_committed + v_reserved + v_claim > v_ceiling
                            then 'org_ceiling'
                          when v_emp_limit is not null
                            and v_user_committed + v_user_reserved + v_claim > v_emp_limit
                            then 'employee_limit'
                          when v_plat_committed + v_plat_reserved + v_claim > v_plat_ceiling
                            then 'platform_ceiling'
                          else 'org_ceiling'
                        end;
    return;
  end if;

  return query select 'reserved'::text, v_reservation, v_committed, v_reserved,
                      v_ceiling, null::text, null::text;
end $function$;

revoke all on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer) to service_role;

commit;
