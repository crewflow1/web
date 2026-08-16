-- AI Cost Governor — RESERVE against the EFFECTIVE ceiling + the per-employee limit.
--
-- This replaces ai_reserve_invocation (20261070000000) so that the atomic gate,
-- still under its per-org advisory lock, now:
--
--   1. Resolves the EFFECTIVE org ceiling — the override in
--      ai_org_budget_ceilings if one exists, else the default passed by the
--      caller — and re-clamps it to the hard safety max (50000p). Resolution
--      happens INSIDE the lock, so an override written concurrently cannot race
--      the reservation, and the clamp here is the authoritative one: a row that
--      somehow held a larger ceiling still cannot widen the gate.
--
--   2. Enforces a PER-EMPLOYEE limit when ai_employee_budget_limits has a row
--      for (org, acting user). The call must fit under BOTH the org ceiling and
--      the employee's own committed+reserved-this-month budget. FAIL-CLOSED,
--      exactly like the org ceiling: over the limit ⇒ blocked, no provider call.
--
-- Everything else is preserved BYTE-FOR-BYTE from 20261070000000: the band gate,
-- the reserve gate, the serialised sliding-window dedupe, the lazy TTL reclaim,
-- the Europe/London month window, SECURITY INVOKER, the claim floor. The ONE
-- signature change is an added `block_reason` output column, which is why this is
-- a DROP + CREATE rather than a CREATE OR REPLACE (a return-type change).
--
-- STILL ACTIVATES NOTHING. No tier is bound, so the reserve path is never
-- reached in production and this file changes nothing observable.
--
-- Rollback: restore the 20261070000000 definition (drop this function first).

drop function if exists public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer);

create function public.ai_reserve_invocation(
  p_org_id                 uuid,
  p_feature                text,
  p_task_class             text,
  p_estimate_pence         integer,
  p_user_id                uuid    default null,
  p_content_hash           text    default null,
  p_ceiling_pence          integer default 10000,
  p_ttl_seconds            integer default 600,
  p_dedupe_window_seconds  integer default 900
)
returns table (
  outcome          text,
  reservation_id   uuid,
  committed_pence  bigint,
  reserved_pence   bigint,
  ceiling_pence    integer,
  duplicate_reason text,
  -- NEW: 'org_ceiling' | 'employee_limit' on a block, else null. Lets the HQ
  -- view and the logs tell "the org is out of budget" from "this employee is".
  block_reason     text
)
language plpgsql
set search_path = ''
as $$
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
  select ceiling_pence into v_override
    from public.ai_org_budget_ceilings
   where org_id = p_org_id;

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
                          else 'org_ceiling'
                        end;
    return;
  end if;

  return query select 'reserved'::text, v_reservation, v_committed, v_reserved,
                      v_ceiling, null::text, null::text;
end $$;

revoke all on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer) from public;
grant execute on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer)
  to service_role;
