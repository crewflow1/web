-- 20261366000000 — per-company AI off switch (compliance gap G-13).
--
-- WHY: a company owner (and HQ) must be able to turn ALL AI features off for
-- their company, and when off no AI provider request may be made for it. The
-- existing per-org ceiling override set to 0 already blocks, but it is
-- HQ-service-role only (a tenant cannot reach it), it is a money control rather
-- than a consent control, and HQ clearing/raising it would silently re-enable
-- AI. This adds an explicit, owner-reachable, audited switch.
--
-- ENFORCEMENT: inside ai_reserve_invocation, the single choke point every
-- governed call (text, vision, transcription, embeddings, HTTP routes) takes
-- before any provider request. Under the per-org advisory lock, before the
-- ceiling. Absent row = ON. 'ai_disabled' is a distinct block_reason.
--
-- WRITES: ai_owner_set_ai_enabled (authenticated; SECURITY DEFINER; caller must
-- be an OWNER of the org via current_org_ids() + memberships, else 42501;
-- switching ON also requires org_is_writable = not held/suspended/cancelled;
-- switching OFF is always allowed to an owner — the safe direction) and
-- ai_hq_set_ai_enabled (service_role only; HQ super-admin action). Both write
-- the switch row and an audit row in one transaction.
--
-- Rollback: docs/engineering/release/rollback-20261366000000.sql (restores the
-- 20261358000000 ai_reserve_invocation, drops the functions and tables).
--
-- data-api: ai_org_switches is member-readable (RLS), service-role writable;
-- the audit table is service-role only.

begin;

create table if not exists public.ai_org_switches (
  org_id     uuid primary key references public.organizations(id) on delete cascade,
  ai_enabled boolean not null,
  set_by     uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
comment on table public.ai_org_switches is
  'Per-company AI off switch. Absent row = AI on. ai_enabled=false => ai_reserve_invocation refuses every call (block_reason ai_disabled). Owner/admin read (the only user-session reader is the owner settings page; enforcement reads it inside ai_reserve_invocation); writes only via ai_owner_set_ai_enabled / ai_hq_set_ai_enabled (audited).';

create table if not exists public.ai_org_switch_audit (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  old_enabled      boolean,
  new_enabled      boolean not null,
  actor_kind       text not null check (actor_kind in ('owner', 'hq')),
  changed_by       uuid references public.users(id) on delete set null,
  changed_by_email text check (changed_by_email is null or length(trim(changed_by_email)) between 1 and 320),
  created_at       timestamptz not null default now()
);
create index if not exists ai_org_switch_audit_org_idx
  on public.ai_org_switch_audit (org_id, created_at desc);
comment on table public.ai_org_switch_audit is
  'Append-only audit of every per-company AI switch change. Service-role / definer write only.';

alter table public.ai_org_switches enable row level security;
alter table public.ai_org_switch_audit enable row level security;

revoke all on table public.ai_org_switches from anon, authenticated, public;
revoke all on table public.ai_org_switch_audit from anon, authenticated, public;
grant select on table public.ai_org_switches to authenticated;
grant select, insert, update on table public.ai_org_switches to service_role;
grant select, insert on table public.ai_org_switch_audit to service_role;

drop policy if exists ai_org_switches_member_read on public.ai_org_switches;
create policy ai_org_switches_member_read on public.ai_org_switches
  for select to authenticated
  using (public.is_org_admin(org_id));

-- HQ super-admin write (service-role only). Role/identity is enforced by the
-- /admin action (isSuperAdminEmail); here only the transaction + audit.
create or replace function public.ai_hq_set_ai_enabled(
  p_org_id uuid, p_enabled boolean, p_set_by uuid default null
)
returns table(old_enabled boolean, new_enabled boolean)
language plpgsql
set search_path to ''
as $function$
declare
  v_old   boolean;
  v_email text;
begin
  if p_org_id is null or p_enabled is null then
    raise exception 'organisation and state are required' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org_id) then
    raise exception 'organisation not found' using errcode = 'invalid_parameter_value';
  end if;

  -- Same per-org lock the reservation takes: a switch cannot interleave with a claim.
  perform pg_advisory_xact_lock(hashtext('ai_budget_reservation'), hashtext(p_org_id::text));

  select s.ai_enabled into v_old from public.ai_org_switches s where s.org_id = p_org_id;
  select u.email into v_email from public.users u where u.id = p_set_by;

  insert into public.ai_org_switches (org_id, ai_enabled, set_by, updated_at)
  values (p_org_id, p_enabled, p_set_by, now())
  on conflict (org_id) do update
    set ai_enabled = excluded.ai_enabled, set_by = excluded.set_by, updated_at = now();

  insert into public.ai_org_switch_audit (org_id, old_enabled, new_enabled, actor_kind, changed_by, changed_by_email)
  values (p_org_id, v_old, p_enabled, 'hq', p_set_by, v_email);

  return query select v_old, p_enabled;
end $function$;

revoke all on function public.ai_hq_set_ai_enabled(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.ai_hq_set_ai_enabled(uuid, boolean, uuid) to service_role;

-- Owner write. SECURITY DEFINER; identity from auth.uid(), org must be one of
-- the caller's own (current_org_ids) AND the caller an owner of it.
create or replace function public.ai_owner_set_ai_enabled(p_org_id uuid, p_enabled boolean)
returns table(old_enabled boolean, new_enabled boolean)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid   uuid := auth.uid();
  v_old   boolean;
  v_email text;
begin
  if v_uid is null or p_org_id is null or p_enabled is null
     or p_org_id not in (select public.current_org_ids())
     or not exists (select 1 from public.memberships m
                     where m.org_id = p_org_id and m.user_id = v_uid and m.role = 'owner') then
    raise exception 'only a company owner can change the AI setting' using errcode = '42501';
  end if;

  -- Turning AI back ON is a write like any other: refused for a held,
  -- suspended or cancelled company. Turning it OFF is always allowed.
  if p_enabled and not public.org_is_writable(p_org_id) then
    raise exception 'this company is not active' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('ai_budget_reservation'), hashtext(p_org_id::text));

  select s.ai_enabled into v_old from public.ai_org_switches s where s.org_id = p_org_id;
  select u.email into v_email from public.users u where u.id = v_uid;

  insert into public.ai_org_switches (org_id, ai_enabled, set_by, updated_at)
  values (p_org_id, p_enabled, v_uid, now())
  on conflict (org_id) do update
    set ai_enabled = excluded.ai_enabled, set_by = excluded.set_by, updated_at = now();

  insert into public.ai_org_switch_audit (org_id, old_enabled, new_enabled, actor_kind, changed_by, changed_by_email)
  values (p_org_id, v_old, p_enabled, 'owner', v_uid, v_email);

  return query select v_old, p_enabled;
end $function$;

revoke all on function public.ai_owner_set_ai_enabled(uuid, boolean) from public, anon;
grant execute on function public.ai_owner_set_ai_enabled(uuid, boolean) to authenticated, service_role;

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

  -- ── PER-COMPANY AI OFF SWITCH (20261366000000) ─────────────────────────────
  -- A company that has switched AI off gets NO reservation, so no provider
  -- request can be made for it. Read under the SAME per-org lock as the claim,
  -- so a switch-off cannot interleave with an in-flight reservation. ABSENT ROW
  -- = ON (the default); a read error raises and the governor refuses the call.
  -- Checked before the ceiling, so an off company is never reported as "budget
  -- used up" and raises no spend alert.
  if exists (select 1 from public.ai_org_switches s
              where s.org_id = p_org_id and s.ai_enabled is false) then
    return query select 'blocked'::text, null::uuid, 0::bigint, 0::bigint,
                        0, null::text, 'ai_disabled'::text;
    return;
  end if;

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

  -- ── PLATFORM-WIDE CEILING (20261358000000) ─────────────────────────────────
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
