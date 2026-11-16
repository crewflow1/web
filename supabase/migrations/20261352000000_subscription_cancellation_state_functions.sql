-- Self-serve subscription cancellation — the ATOMIC STATE TRANSITIONS.
--
-- Three functions, all SERVICE-ROLE ONLY (SECURITY INVOKER, EXECUTE revoked
-- from public/anon/authenticated). Each takes the org row lock (SELECT … FOR
-- UPDATE) first, so the cancel action and the Stripe webhook — which run in
-- separate processes and can interleave in any order — serialise per org.
--
--   claim_subscription_cancellation    the owner action's claim, BEFORE Stripe
--   confirm_subscription_cancellation  exactly-once revocation, action OR webhook
--   apply_stripe_subscription_state    the webhook's subscription.created/updated
--                                      write, refusing to resurrect a tombstone
--
-- None is client-reachable, so the secdef-org-rpc guard (current_org_ids() +
-- 42501) does not apply: the callers are the Stripe webhook (signature-verified,
-- service role) and a server action that derives the org from the caller's own
-- session + membership before it ever reaches the admin client.
--
-- Additive. To roll back (after reverting the application code):
--   drop function public.apply_stripe_subscription_state(uuid, text, text, text, timestamptz);
--   drop function public.confirm_subscription_cancellation(uuid, text, text, jsonb, uuid, boolean, text);
--   drop function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer);

-- ============================================================================
-- claim_subscription_cancellation
-- ============================================================================
-- outcome:
--   claimed            caller holds the claim → go on and call Stripe
--   in_flight          another caller claimed it within the lease → do nothing
--   already_confirmed  this subscription (or, for local-only, this org) is
--                      already cancelled → do nothing
--   org_not_found
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

-- ============================================================================
-- confirm_subscription_cancellation
-- ============================================================================
-- Called when termination is KNOWN: by the action after Stripe returned a
-- canceled subscription (p_via 'action'), or by the webhook on
-- customer.subscription.deleted / updated→canceled (p_via 'webhook').
--
-- newly_confirmed is true for exactly ONE caller per subscription id. Access is
-- revoked (organizations.status → 'cancelled') in that same call — and the
-- UPDATE is conditional on the org not already being cancelled — so:
--   • action then webhook, webhook then action, the same event twice, or two
--     owners at once → one revocation, one HQ alert, one owner email;
--   • an operator who later reactivates the org by hand is never re-cancelled
--     by a late redelivery for the dead subscription.
--
-- STALE-SUBSCRIPTION GUARD (webhook path). If the org has since moved to a
-- DIFFERENT, live subscription (reactivated), a late `deleted` for the old one
-- must not revoke the new access: the tombstone is still written, the org is
-- left alone. The owner action passes p_force_revoke = true because it has just
-- cancelled every live subscription the customer has, so the org must end
-- cancelled whatever stale id it was pointing at.
create or replace function public.confirm_subscription_cancellation(
  p_org_id          uuid,
  p_subscription_id text,
  p_via             text,
  p_details         jsonb default '{}'::jsonb,
  p_cancellation_id uuid default null,
  p_force_revoke    boolean default false,
  p_refund_review   text default null
)
returns table (
  newly_confirmed    boolean,
  access_revoked     boolean,
  cancellation_id    uuid,
  source             text,
  requested_by_email text,
  prior_org_status   text
)
language plpgsql
set search_path = ''
as $$
declare
  v_status  text;
  v_cur_sub text;
  v_row     public.subscription_cancellations%rowtype;
  v_newly   boolean := false;
  v_revoked boolean := false;
  v_stale   boolean := false;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if p_via not in ('action', 'webhook') then
    raise exception 'confirm_subscription_cancellation: invalid p_via %', p_via
      using errcode = '22023';
  end if;

  select o.status, o.stripe_subscription_id into v_status, v_cur_sub
    from public.organizations o
   where o.id = p_org_id
     for update;
  if not found then
    raise exception 'confirm_subscription_cancellation: organisation % not found', p_org_id
      using errcode = 'P0002';
  end if;

  if p_subscription_id is not null then
    select * into v_row
      from public.subscription_cancellations c
     where c.org_id = p_org_id
       and c.stripe_subscription_id = p_subscription_id
       for update;
    if not found then
      insert into public.subscription_cancellations
        (org_id, stripe_subscription_id, state, source, prior_org_status)
      values
        (p_org_id, p_subscription_id, 'requested',
         case when p_via = 'webhook' then 'stripe_webhook' else 'owner' end,
         v_status)
      returning * into v_row;
    end if;
  else
    select * into v_row
      from public.subscription_cancellations c
     where c.id = p_cancellation_id
       and c.org_id = p_org_id
       and c.stripe_subscription_id is null
       for update;
    if not found then
      raise exception 'confirm_subscription_cancellation: local-only cancellation % not found for organisation %',
        p_cancellation_id, p_org_id
        using errcode = 'P0002';
    end if;
  end if;

  v_newly := v_row.state <> 'confirmed';

  -- Revoke on the FIRST confirmation — or whenever the owner action forces it
  -- (it has just cancelled every live subscription, so the org must end
  -- cancelled even if the webhook confirmed this id a moment earlier but left
  -- the org alone under the stale-subscription guard).
  if v_newly or p_force_revoke then
    v_stale := not p_force_revoke
      and p_subscription_id is not null
      and v_cur_sub is not null
      and v_cur_sub <> p_subscription_id
      and not exists (
        select 1
          from public.subscription_cancellations t
         where t.org_id = p_org_id
           and t.stripe_subscription_id = v_cur_sub
           and t.state = 'confirmed'
      );

    if v_status <> 'cancelled' and not v_stale then
      update public.organizations o
         set status = 'cancelled',
             cancelled_at = now(),
             next_renewal_at = null,
             stripe_subscription_id = coalesce(p_subscription_id, o.stripe_subscription_id)
       where o.id = p_org_id;
      v_revoked := true;
    end if;
  end if;

  if v_newly then
    update public.subscription_cancellations c
       set state = 'confirmed',
           confirmed_at = now(),
           confirmed_via = p_via,
           access_revoked = v_revoked,
           prior_org_status = coalesce(c.prior_org_status, v_status),
           refund_review = coalesce(p_refund_review, c.refund_review),
           details = c.details || v_details,
           last_error = null
     where c.id = v_row.id
     returning * into v_row;
  elsif p_via = 'action' then
    -- The webhook confirmed first; the action arrives second carrying what only
    -- it knows (the refund review, the invoices it stopped collecting). Merge
    -- that onto the ledger. refund_review only ever moves TOWARDS 'pending'.
    update public.subscription_cancellations c
       set access_revoked = c.access_revoked or v_revoked,
           details = c.details || v_details,
           refund_review = case
                             when p_refund_review = 'pending'
                              and c.refund_review = 'not_applicable' then 'pending'
                             else c.refund_review
                           end
     where c.id = v_row.id
     returning * into v_row;
  end if;

  return query
    select v_newly, v_revoked, v_row.id, v_row.source,
           v_row.requested_by_email, v_row.prior_org_status;
end $$;

-- ============================================================================
-- apply_stripe_subscription_state
-- ============================================================================
-- The webhook's access-granting subscription write — customer.subscription
-- .created / .updated, and checkout.session.completed for a subscription —
-- made atomic with the tombstone check. A NULL customer id / renewal date
-- leaves the stored value alone. p_org_status is 'active' | 'suspended' | NULL
-- (NULL = leave organizations.status alone — incomplete / paused / …).
-- 'cancelled' is NOT accepted here: termination goes through confirm_… so it is
-- revoked exactly once.
--
-- outcome:
--   applied
--   ignored_cancelled_subscription   the subscription id is tombstoned — a late
--                                    or out-of-order event; nothing is written
--   org_not_found
create or replace function public.apply_stripe_subscription_state(
  p_org_id          uuid,
  p_subscription_id text,
  p_customer_id     text,
  p_org_status      text,
  p_next_renewal_at timestamptz
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_org_status is not null and p_org_status not in ('active', 'suspended') then
    raise exception 'apply_stripe_subscription_state: invalid p_org_status %', p_org_status
      using errcode = '22023';
  end if;

  select o.status into v_status
    from public.organizations o
   where o.id = p_org_id
     for update;
  if not found then
    return 'org_not_found';
  end if;

  if exists (
    select 1
      from public.subscription_cancellations c
     where c.org_id = p_org_id
       and c.stripe_subscription_id = p_subscription_id
       and c.state = 'confirmed'
  ) then
    return 'ignored_cancelled_subscription';
  end if;

  update public.organizations o
     set stripe_subscription_id = p_subscription_id,
         stripe_customer_id = coalesce(p_customer_id, o.stripe_customer_id),
         next_renewal_at = coalesce(p_next_renewal_at, o.next_renewal_at),
         status = coalesce(p_org_status, o.status),
         -- A NEW subscription lifting a cancelled org back to active is a
         -- reactivation: clear the stale cancellation stamp (as the HQ
         -- lifecycle action does).
         cancelled_at = case
                          when p_org_status = 'active' and o.status = 'cancelled' then null
                          else o.cancelled_at
                        end
   where o.id = p_org_id;
  return 'applied';
end $$;

-- ── Grants — service_role only ───────────────────────────────────────────────
revoke all on function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_subscription_cancellation(uuid, text, uuid, text, text, integer)
  to service_role;

revoke all on function public.confirm_subscription_cancellation(uuid, text, text, jsonb, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.confirm_subscription_cancellation(uuid, text, text, jsonb, uuid, boolean, text)
  to service_role;

revoke all on function public.apply_stripe_subscription_state(uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_state(uuid, text, text, text, timestamptz)
  to service_role;
