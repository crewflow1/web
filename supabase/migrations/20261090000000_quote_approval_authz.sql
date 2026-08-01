-- Quote approval authorization — defense-in-depth at the DATABASE layer.
--
-- STATUS.md known-risk #4 (quotes arm). The owner/admin approval gate lives in
-- the server action `requireQuoteApprover` (app/(app)/quotes/actions.ts) and in
-- reviewQuote's separation-of-duties check. But RLS on `quotes` is MEMBER level:
--
--     "quotes: members can update" … using  (org_id in (select current_org_ids()))
--                                    with check (org_id in (select current_org_ids()))
--
-- so a staff-role JWT that skips the UI can go straight to PostgREST and
--
--     UPDATE quotes SET status='approved', approved_by=<self> WHERE id=…
--
-- self-approving a quote the app would never let them approve, or
--
--     UPDATE quotes SET status='sent' WHERE id=…   (draft → sent)
--
-- sending an un-approved quote to the customer. The app gate never runs.
--
-- This migration mirrors the SAME already-shipped product decision at the DB
-- layer with a BEFORE INSERT OR UPDATE trigger (INSERT matters too — see the
-- note at the trigger definition). It introduces NO new policy: it enforces
-- the manager-only transitions the application already enforces, so that the key
-- that matters (an owner/admin) is required whether the write arrives through the
-- server action or through a raw PostgREST call. It is a SEPARATE trigger from
-- the activity trigger (20260522) and the accepted-freeze trigger (20261004);
-- all coexist.
--
-- WHAT IS BLOCKED (only for a caller that is NOT service_role AND NOT an admin):
--   (a) moving a quote INTO status 'approved'  — self-approval;
--   (b) setting/CHANGING approved_by / approved_at to a NON-NULL value — stamping
--       approval provenance. Clearing them to NULL stays allowed, because that is
--       exactly the legitimate "edit reverts approval" flow (updateQuote /
--       requestQuoteApproval set approved_by = NULL when reverting to
--       pending_approval);
--   (c) moving a quote INTO 'sent' UNLESS the OLD status was already 'approved'
--       — a staff member may SEND an already-approved quote (legit), but may not
--       skip the gate by going draft → sent directly.
--
-- WHAT STAYS ALLOWED (nothing above is widened):
--   · draft edits and other field changes that leave status alone;
--   · draft → pending_approval (submit for approval);
--   · approved/sent → pending_approval with approved_by → NULL (edit reverts);
--   · staff sending an already-approved quote (approved → sent);
--   · EVERY service_role transition — customer accept via public token sets
--     status='accepted' through the service_role key, the expiry cron, and all
--     server/system flows run as service_role, which never belongs to a staff
--     user;
--   · every transition an owner/admin performs (the app gates them here too,
--     and reuses the impersonation-aware public.is_org_admin).
--
-- Additive and idempotent (create or replace + drop trigger if exists).

create or replace function public.enforce_quote_approval_authz()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role (customer accept via public token, expiry cron, server flows)
  -- is exempt: the service_role key is server-only and never held by a staff
  -- user. Matches the codebase's canonical service_role detection
  -- (auth.role() … 'service_role', e.g. 20260708000001, 20261008000000).
  if auth.role() is not distinct from 'service_role' then
    return new;
  end if;

  -- Owners/admins may perform ANY transition — the app already gates them here
  -- too. is_org_admin is impersonation-aware (20260701000000), so an operator
  -- impersonating the org is treated as an admin of that org and nobody else.
  if public.is_org_admin(new.org_id) then
    return new;
  end if;

  -- ── Non-admin, non-service-role from here down. ──────────────────────────
  -- (a) self-approval — moving INTO 'approved' is the manager-only act.
  if new.status = 'approved' and old.status is distinct from 'approved' then
    raise exception 'quote approval requires an owner or admin'
      using errcode = 'insufficient_privilege';
  end if;

  -- (b) stamping approval provenance. Setting or CHANGING approved_by /
  -- approved_at to a non-null value is manager-only; clearing to NULL is the
  -- legitimate edit-reverts-approval flow and MUST remain allowed.
  if new.approved_by is not null and new.approved_by is distinct from old.approved_by then
    raise exception 'quote approval fields require an owner or admin'
      using errcode = 'insufficient_privilege';
  end if;
  if new.approved_at is not null and new.approved_at is distinct from old.approved_at then
    raise exception 'quote approval fields require an owner or admin'
      using errcode = 'insufficient_privilege';
  end if;

  -- (c) sending an un-approved quote to the customer. Moving INTO 'sent' is
  -- allowed ONLY out of 'approved' (a staff member sending an already-approved
  -- quote is a legit flow); draft → sent would skip the whole gate.
  if new.status = 'sent'
     and old.status is distinct from 'sent'
     and old.status is distinct from 'approved' then
    raise exception 'a quote must be approved before it can be sent'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- BEFORE INSERT OR UPDATE. INSERT matters as much as UPDATE: a staff JWT can
-- otherwise skip the gate by CREATING a quote already at status='approved'
-- (self-approval) or 'sent' (un-approved → customer). The predicates above hold
-- on INSERT for free — OLD is NULL, so `NULL is distinct from 'approved'` is
-- TRUE and a staff INSERT at approved/sent, or one stamping approved_by, raises;
-- the only non-admin INSERT paths (createQuote / createVariation) always insert
-- status='draft' with no approval provenance, so they stay green.
drop trigger if exists enforce_quote_approval_authz on public.quotes;
create trigger enforce_quote_approval_authz
  before insert or update on public.quotes
  for each row execute function public.enforce_quote_approval_authz();

-- KNOWN P2 (out of scope; flagged, not closed here): transitions INTO 'accepted'
-- are NOT guarded. A non-admin can currently record a customer acceptance
-- (acceptQuoteAsOwner runs on the user client with no approver gate, and accepts
-- from any status). Closing that safely is a PRODUCT decision — whether staff may
-- record acceptances at all — so it is deliberately left to a follow-up rather
-- than risk breaking the legitimate "client confirmed by phone" flow. This
-- migration's objective is the approval/send gate (risk #4), now closed on both
-- INSERT and UPDATE.
