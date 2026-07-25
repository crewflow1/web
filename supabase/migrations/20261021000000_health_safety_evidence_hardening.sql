-- Health & Safety — evidence-integrity hardening (M5, final adversarial review).
--
-- Trust boundary that drives this file: the browser ships the anon key and RLS +
-- triggers + CHECKs are the ONLY thing protecting tenant data (see
-- lib/supabase/client.ts). A server action is NOT a boundary — any authenticated
-- member can hit PostgREST directly with their JWT. So every load-bearing H&S
-- guarantee must live in the database, for every role.
--
-- The final review found the RAMS issue path was permissive where the permit path
-- (20261019) was already hardened. This migration closes the gap and makes the
-- evidence guarantees role-independent (triggers, not just RLS policies):
--
--   P0  A RAMS could be INSERTed already-`issued` (forged, back-dated, forged
--       issuer, zero hazards) — the permit table forbids a born-issued INSERT but
--       risk_assessments had no equivalent. Fixed by tg_ra_lifecycle.
--   P1  On the draft→issued transition issued_by / issued_at were client-supplied
--       on BOTH tables (the immutability freeze only bites AFTER issue). Fixed by
--       pinning them to auth.uid()/now() for real (JWT) callers on both tables.
--   P1  The issued-record delete-guard (added earlier this milestone) was an RLS
--       policy — bypassed by the service_role. Re-expressed as BEFORE DELETE
--       triggers so an issued RAMS / permit is un-deletable for EVERY role, while
--       org teardown (cascade) still works.
--   P2  next_ra_number was SECURITY DEFINER with no membership check → a cross-org
--       issued-RAMS count oracle. Gated to the caller's own org (like
--       next_ptw_number).
--
-- Pinning + the DB issue-gate are enforced when auth.uid() is present (every real
-- browser caller). The service_role — trusted server-side code that is never
-- shipped to the browser (fixtures, migrations) — keeps its explicit values, the
-- same asymmetry the acknowledgements validate-trigger already uses (20261020).
--
-- Additive + reversible: drop the four triggers + their functions and re-widen the
-- delete policies / restore next_ra_number to its SQL body. No row is mutated.

-- ---------------------------------------------------------------------------
-- (P0/P1) RAMS lifecycle — born-a-draft, DB issue-gate, pinned provenance.
-- Mirrors tg_permit_lifecycle (20261019) which the permit table already had.
-- ---------------------------------------------------------------------------
create or replace function public.tg_ra_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A RAMS is ALWAYS born a draft. Issue is only ever reached via an UPDATE that
  -- runs the gate below, so a direct INSERT can never mint an already-issued
  -- (forged / back-dated / hazard-less) legal record (P0). Unconditional — even a
  -- service-role insert must start as a draft, exactly like permits.
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a risk assessment is created as a draft, then issued';
    end if;
    return new;
  end if;

  -- Draft -> issued. For a real (JWT) caller the DB re-enforces the readiness gate
  -- (a named assessor + at least one hazard — the canIssue rule) and PINS the
  -- issue provenance server-side, so issued_by / issued_at cannot be forged or
  -- back-dated via a direct PATCH (P0/P1). auth.uid() is always present for a
  -- browser caller; when it is null the caller is the trusted service role.
  if old.status = 'draft' and new.status = 'issued' and auth.uid() is not null then
    if new.assessor_id is null then
      raise exception 'cannot issue: a risk assessment needs a named assessor';
    end if;
    if (select count(*) from public.risk_assessment_hazards
        where risk_assessment_id = new.id) = 0 then
      raise exception 'cannot issue: a risk assessment needs at least one hazard';
    end if;
    new.issued_by := auth.uid();
    new.issued_at := now();
  end if;

  return new;
end;
$$;

create trigger tg_ra_lifecycle
  before insert or update on public.risk_assessments
  for each row execute function public.tg_ra_lifecycle();

-- ---------------------------------------------------------------------------
-- (P1) Permit issue/lifecycle provenance — pin issued_by/issued_at and the
-- lifecycle stamps to the server for real (JWT) callers. tg_permit_lifecycle
-- (20261019) already enforces the transition matrix, the issue-gate and the
-- post-issue immutability freeze; this only makes the AUTHORITATIVE fields
-- server-derived at the moment they are first written (the freeze then protects
-- them). Separate trigger so the (correct, tested) lifecycle function is untouched.
-- ---------------------------------------------------------------------------
create or replace function public.tg_permit_pin_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only pin for real browser callers; the trusted service role (auth.uid() null)
  -- keeps the explicit values fixtures/migrations set.
  if auth.uid() is null then
    return new;
  end if;
  if new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'issued' then
      new.issued_by := auth.uid();
      new.issued_at := now();
    elsif new.status = 'active'    then new.activated_at := now();
    elsif new.status = 'suspended' then new.suspended_at := now();
    elsif new.status = 'closed'    then new.closed_at   := now();
    elsif new.status = 'cancelled' then new.cancelled_at := now();
    end if;
  end if;
  return new;
end;
$$;

-- Runs after tg_permit_lifecycle (alphabetical: ...lifecycle < ...pin_provenance).
-- On the issue transition old.status='draft' so the lifecycle freeze is skipped and
-- these fields are free to set; on later transitions the freeze has already
-- rejected any client change to issued_by/issued_at before this fires.
create trigger tg_permit_pin_provenance
  before update on public.permits_to_work
  for each row execute function public.tg_permit_pin_provenance();

-- ---------------------------------------------------------------------------
-- (P1) Issued evidence is NON-DELETABLE — as a trigger, so it holds for the
-- service role too (an RLS delete policy does not). Only a DRAFT (never issued,
-- therefore never acknowledged) may be hard-deleted. Org teardown still cascades:
-- by the time this fires under an org DELETE the organizations row is already gone
-- (the cascade removes it first), so we allow it — the exact idiom the child
-- hazard / condition delete-blocks use (20261018 / 20261019).
-- ---------------------------------------------------------------------------
create or replace function public.tg_ra_block_delete_when_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'draft'
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'an issued risk assessment is evidence and cannot be deleted; withdraw it instead';
  end if;
  return old;
end;
$$;

create trigger tg_ra_block_delete_when_issued
  before delete on public.risk_assessments
  for each row execute function public.tg_ra_block_delete_when_issued();

create or replace function public.tg_permit_block_delete_when_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'draft'
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'an issued permit is evidence and cannot be deleted; cancel or close it instead';
  end if;
  return old;
end;
$$;

create trigger tg_permit_block_delete_when_issued
  before delete on public.permits_to_work
  for each row execute function public.tg_permit_block_delete_when_issued();

-- The draft-only DELETE policies stay as defence-in-depth on the JWT path (a
-- non-admin cannot delete at all; an admin only a draft). The triggers above are
-- the role-independent backstop the service role cannot slip past.
drop policy if exists risk_assessments_delete on public.risk_assessments;
create policy risk_assessments_delete on public.risk_assessments
  for delete using (public.is_org_admin(org_id) and status = 'draft');

drop policy if exists permits_delete on public.permits_to_work;
create policy permits_delete on public.permits_to_work
  for delete using (public.is_org_admin(org_id) and status = 'draft');

-- ---------------------------------------------------------------------------
-- (P2) next_ra_number — gate the caller to their own org (it is SECURITY
-- DEFINER, so without this a member could probe another org's issued-RAMS count).
-- Re-expressed in plpgsql to carry the guard; mirrors next_ptw_number (20261019).
-- ---------------------------------------------------------------------------
create or replace function public.next_ra_number(target_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_num int;
begin
  if target_org not in (select public.current_org_ids()) then
    raise exception 'forbidden: not a member of organisation %', target_org;
  end if;
  select coalesce(max(cast(substring(reference from 'RA-(\d+)') as int)), 0) + 1
    into next_num
  from public.risk_assessments
  where org_id = target_org and reference is not null;
  return 'RA-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_ra_number(uuid) to authenticated;
