-- ROLLBACK for 20261357000000_subscription_cancellation_hq_source (billing #1090, part 3 of 3).
-- Restores the pre-357 state: the 6-argument claim_subscription_cancellation exactly as 20261356000000 defined
-- it (VERBATIM, generated; same service_role-only grants) and the original source CHECK of 20261355000000.
-- REFUSES (raises, changes nothing) if any ledger row has source = 'hq' -- export/resolve those first.
-- App: #1090 calls the 7-argument form -> roll the APP back first. Production d24295e calls neither form.
-- Then: supabase migration repair --status reverted 20261357000000 --linked
begin;
do $$ begin
  if exists (select 1 from public.subscription_cancellations where source = 'hq') then
    raise exception 'rollback-20261357000000: % ledger row(s) have source = hq; resolve them first',
      (select count(*) from public.subscription_cancellations where source = 'hq');
  end if;
end $$;

drop function if exists public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer, text);

-- claim_subscription_cancellation (6 args): supabase/migrations/20261356000000_subscription_cancellation_state_functions.sql:32
create or replace function public.claim_subscription_cancellation(
  p_org_id          uuid,
  p_subscription_id text,
  p_user_id         uuid,
  p_user_email      text,
  p_reason          text,
  p_lease_seconds   integer default 120
)
returns table (outcome text, cancellation_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_row    public.subscription_cancellations%rowtype;
  v_lease  interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 1));
  v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 1000)), '');
  v_id     uuid;
begin
  select o.status into v_status
    from public.organizations o
   where o.id = p_org_id
     for update;
  if not found then
    return query select 'org_not_found'::text, null::uuid;
    return;
  end if;

  if p_subscription_id is not null then
    select * into v_row
      from public.subscription_cancellations c
     where c.org_id = p_org_id
       and c.stripe_subscription_id = p_subscription_id
       for update;
    if found then
      if v_row.state = 'confirmed' then
        return query select 'already_confirmed'::text, v_row.id;
        return;
      end if;
      if v_row.state = 'requested' and v_row.claimed_at is not null
         and v_row.claimed_at > now() - v_lease then
        return query select 'in_flight'::text, v_row.id;
        return;
      end if;
      -- failed, or an orphaned claim past its lease → take it over.
      update public.subscription_cancellations c
         set state = 'requested',
             source = 'owner',
             claimed_at = now(),
             requested_by = p_user_id,
             requested_by_email = p_user_email,
             reason = coalesce(v_reason, c.reason),
             last_error = null
       where c.id = v_row.id;
      return query select 'claimed'::text, v_row.id;
      return;
    end if;

    insert into public.subscription_cancellations
      (org_id, stripe_subscription_id, state, source, requested_by,
       requested_by_email, reason, prior_org_status, claimed_at)
    values
      (p_org_id, p_subscription_id, 'requested', 'owner', p_user_id,
       p_user_email, v_reason, v_status, now())
    returning id into v_id;
    return query select 'claimed'::text, v_id;
    return;
  end if;

  -- LOCAL-ONLY (no Stripe subscription). Not a tombstone: an org may be
  -- reactivated and cancel again, so "already cancelled" is read off the org.
  if v_status = 'cancelled' then
    return query select 'already_confirmed'::text, null::uuid;
    return;
  end if;

  select c.id into v_id
    from public.subscription_cancellations c
   where c.org_id = p_org_id
     and c.stripe_subscription_id is null
     and c.state = 'requested'
     and c.claimed_at > now() - v_lease
   order by c.claimed_at desc
   limit 1;
  if found then
    return query select 'in_flight'::text, v_id;
    return;
  end if;

  insert into public.subscription_cancellations
    (org_id, stripe_subscription_id, state, source, requested_by,
     requested_by_email, reason, prior_org_status, claimed_at)
  values
    (p_org_id, null, 'requested', 'owner', p_user_id,
     p_user_email, v_reason, v_status, now())
  returning id into v_id;
  return query select 'claimed'::text, v_id;
end $$;

revoke all on function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer)
  to service_role;

alter table public.subscription_cancellations
  drop constraint if exists subscription_cancellations_source_check;
alter table public.subscription_cancellations
  add constraint subscription_cancellations_source_check
  check (source in ('owner', 'stripe_webhook'));
commit;
