-- Subscription cancellation — HQ as an initiator.
--
-- WHY. HQ's "Cancel" lifecycle action marked an organisation `cancelled` without
-- touching Stripe, so the customer was locked out and STILL BILLED. HQ cancel
-- now goes through the same claim → Stripe → confirm path as the owner's
-- self-serve cancel (server/services/subscription-cancellation.ts). The ledger
-- must say who started it, because the two differ in one customer-visible way:
-- an OWNER-initiated cancellation emails that owner a confirmation (including
-- from the webhook, if the action timed out); an HQ-initiated one must not send
-- "you cancelled" to the HQ operator's address held in requested_by_email.
--
--   • subscription_cancellations.source gains 'hq'.
--   • claim_subscription_cancellation gains p_source ('owner' | 'hq', default
--     'owner'). The 6-argument version is DROPPED first: leaving both would make
--     a named-argument call ambiguous (the new parameter has a default).
--
-- Forward-only on top of 20261316000000 / 20261317000000. To roll back (after
-- reverting the application code), re-create the 6-argument function from
-- 20261317000000 and:
--   drop function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer, text);
--   alter table public.subscription_cancellations
--     drop constraint subscription_cancellations_source_check,
--     add constraint subscription_cancellations_source_check
--       check (source in ('owner', 'stripe_webhook'));
--   (only valid once no row has source = 'hq')

alter table public.subscription_cancellations
  drop constraint if exists subscription_cancellations_source_check;
alter table public.subscription_cancellations
  add constraint subscription_cancellations_source_check
  check (source in ('owner', 'hq', 'stripe_webhook'));

drop function if exists public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer);

create or replace function public.claim_subscription_cancellation(
  p_org_id          uuid,
  p_subscription_id text,
  p_user_id         uuid,
  p_user_email      text,
  p_reason          text,
  p_lease_seconds   integer default 120,
  p_source          text default 'owner'
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
  if p_source not in ('owner', 'hq') then
    raise exception 'claim_subscription_cancellation: invalid p_source %', p_source
      using errcode = '22023';
  end if;

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
             source = p_source,
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
      (p_org_id, p_subscription_id, 'requested', p_source, p_user_id,
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
    (p_org_id, null, 'requested', p_source, p_user_id,
     p_user_email, v_reason, v_status, now())
  returning id into v_id;
  return query select 'claimed'::text, v_id;
end $$;

revoke all on function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer, text)
  to service_role;
