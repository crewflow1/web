-- Toolbox Talks M2 — acknowledgement engine integration.
--
-- EXTEND the existing safety_acknowledgements engine (20261020) to accept a third
-- subject type, `toolbox_talk`. There is deliberately NO toolbox_acknowledgements
-- table: one generic, version-anchored, append-only sign-off system serves RAMS,
-- permits AND toolbox talks. A worker acknowledging "I attended and understood this
-- briefing" is the same evidence shape as acknowledging a RAMS.
--
-- What this migration changes, and nothing else:
--   1. Widen the subject_type CHECK to admit 'toolbox_talk' (drop + re-add idiom,
--      mirror 20260617_widen_import_rows_entity_check).
--   2. Teach tg_safety_ack_validate to resolve a toolbox talk's org/reference/status
--      and gate acknowledgement to an ISSUED (current) talk — a draft, superseded or
--      withdrawn talk can never be acknowledged as current.
--
-- Everything else the engine already guarantees is inherited unchanged: org_id is
-- trigger-derived from the subject (no cross-tenant spoof), membership-first (no
-- status probe), signer bound to auth.uid(), timestamps pinned server-side, version
-- anchor must match the issued reference, one-ack-per-(version,user), append-only,
-- non-erasable, RLS-scoped. Additive + reversible.

-- ---------------------------------------------------------------------------
-- 1. Admit 'toolbox_talk'. The prod table only holds RAMS/permit acks today, so a
--    straight drop+re-add of the auto-named CHECK is safe and idempotent.
-- ---------------------------------------------------------------------------
alter table public.safety_acknowledgements
  drop constraint if exists safety_acknowledgements_subject_type_check;
alter table public.safety_acknowledgements
  add constraint safety_acknowledgements_subject_type_check
  check (subject_type in ('risk_assessment', 'permit_to_work', 'toolbox_talk'));

-- ---------------------------------------------------------------------------
-- 2. Resolve + gate the toolbox_talk subject. CREATE OR REPLACE the existing
--    validator with a third branch; the rest of the body is unchanged from 20261020.
-- ---------------------------------------------------------------------------
create or replace function public.tg_safety_ack_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s_org    uuid;
  s_ref    text;
  s_status text;
  s_from   timestamptz;
  s_until  timestamptz;
begin
  -- 1. Resolve the subject's org (+ reference/status) WITHOUT revealing anything yet.
  if new.subject_type = 'risk_assessment' then
    select org_id, reference, status into s_org, s_ref, s_status
    from public.risk_assessments where id = new.subject_id;
  elsif new.subject_type = 'permit_to_work' then
    select org_id, reference, status, valid_from, valid_until into s_org, s_ref, s_status, s_from, s_until
    from public.permits_to_work where id = new.subject_id;
  elsif new.subject_type = 'toolbox_talk' then
    select org_id, reference, status into s_org, s_ref, s_status
    from public.toolbox_talks where id = new.subject_id;
  else
    raise exception 'unknown subject_type %', new.subject_type;
  end if;
  if s_org is null then
    raise exception 'subject % not found', new.subject_id;
  end if;

  -- org_id is authoritative from the subject — a spoofed org can't cross tenants.
  new.org_id := s_org;

  -- 2. Membership FIRST — so a non-member can't probe another org's document
  --    status/reference via the error messages below (cross-tenant leak).
  if not exists (select 1 from public.memberships where org_id = s_org and user_id = new.user_id) then
    raise exception 'signer is not a member of this organisation';
  end if;
  -- 3. Bind the record to the authenticated session — a worker signs only as
  --    themselves. (auth.uid() is null on a service path; app never writes acks
  --    with the service key, and RLS also enforces user_id = auth.uid().)
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
    raise exception 'a worker can only acknowledge as themselves';
  end if;

  -- 4. The document must be LIVE + signable.
  if new.subject_type = 'risk_assessment' then
    if s_status is distinct from 'issued' then
      raise exception 'cannot acknowledge a % risk assessment', coalesce(s_status, 'missing');
    end if;
  elsif new.subject_type = 'toolbox_talk' then
    -- Only the current (issued) revision is acknowledgeable. A superseded or
    -- withdrawn talk is historical evidence — readable, never re-signable as current.
    if s_status is distinct from 'issued' then
      raise exception 'cannot acknowledge a % toolbox talk', coalesce(s_status, 'missing');
    end if;
  else
    if s_status not in ('issued', 'active') then
      raise exception 'cannot acknowledge a % permit', coalesce(s_status, 'missing');
    end if;
    -- a permit is only live WITHIN its validity window (expiry is derived).
    if (s_from is not null and now() < s_from) or (s_until is not null and now() >= s_until) then
      raise exception 'cannot acknowledge a permit outside its validity window';
    end if;
  end if;

  -- 5. Version anchor must match the subject's issued reference.
  if new.subject_version is distinct from s_ref then
    raise exception 'version mismatch: subject is at % not %', coalesce(s_ref, 'unissued'), new.subject_version;
  end if;

  -- 6. Pin the evidence timestamps server-side — the signing time can't be
  --    backdated by the client (the single most load-bearing fact).
  new.acknowledged_at := now();
  new.created_at := now();
  return new;
end;
$$;
