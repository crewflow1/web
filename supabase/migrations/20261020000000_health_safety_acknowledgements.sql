-- Health & Safety — Operative Sign-off / Acknowledgement (M3).
--
-- A worker confirms "I have read and understood this RAMS / permit". The evidence
-- must answer who, WHAT ISSUED VERSION, when, and be immutable. ONE generic
-- subject-based table serves RAMS + permits (and, later, toolbox talks) so there
-- is a single acknowledgement system, not one per document type.
--
-- SIGNATURE MODEL (deliberate): authenticated user + immutable timestamp +
-- version anchor + a TYPED-NAME attestation. No drawn-signature image — an
-- authenticated identity bound to a specific issued snapshot is stronger,
-- privacy-lighter structured evidence than an unauthenticated scribble.
--
-- VERSION-ANCHORED: the acknowledgement is bound to the subject's ISSUED
-- reference (RA-NNNN / PTW-NNNN) at sign time. Superseding/revising the document
-- (a new issued reference) leaves this record historical and untouched; the
-- worker must acknowledge the new version. Acknowledgements are APPEND-ONLY.
--
-- Additive + reversible: `drop table public.safety_acknowledgements` + its fns.

create table if not exists public.safety_acknowledgements (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  subject_type       text not null check (subject_type in ('risk_assessment', 'permit_to_work')),
  subject_id         uuid not null,
  -- The version anchor: the subject's issued reference at the moment of signing.
  subject_version    text not null,
  -- The operative. A real user; org-membership is enforced on insert (below). We
  -- keep the row if they later leave (on delete restrict — evidence must survive,
  -- so a user with acknowledgements can't be hard-deleted out from under them).
  user_id            uuid not null references public.users(id) on delete restrict,
  acknowledged_at    timestamptz not null default now(),
  -- The exact wording attested to + its version, and the typed-name attestation.
  statement          text not null check (length(trim(statement)) > 0),
  statement_version  text not null default 'v1',
  signed_name        text not null check (length(trim(signed_name)) > 0),
  created_at         timestamptz not null default now(),
  -- One acknowledgement per operative per issued version (no meaningless dupes).
  constraint safety_ack_unique unique (org_id, subject_type, subject_id, subject_version, user_id)
);

create index if not exists safety_ack_subject_idx on public.safety_acknowledgements (org_id, subject_type, subject_id);
create index if not exists safety_ack_user_idx     on public.safety_acknowledgements (org_id, user_id);

-- ---------------------------------------------------------------------------
-- Validation: the subject must exist IN THIS ORG, be currently ISSUED (you can
-- only sign a live document), the version anchor must match the subject's issued
-- reference, and the signer must be a current member. Polymorphic link integrity
-- (a composite FK can't span two parent tables), org_id trigger-derived from the
-- subject so it can never be spoofed across tenants.
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

create trigger tg_safety_ack_validate
  before insert on public.safety_acknowledgements
  for each row execute function public.tg_safety_ack_validate();

-- ---------------------------------------------------------------------------
-- Append-only: an acknowledgement is a signed evidence record — it can never be
-- edited. (Deletion is left to admin RLS for GDPR erasure only.)
-- ---------------------------------------------------------------------------
create or replace function public.tg_safety_ack_no_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'acknowledgements are append-only and cannot be modified';
end;
$$;

create trigger tg_safety_ack_no_update
  before update on public.safety_acknowledgements
  for each row execute function public.tg_safety_ack_no_update();

-- ---------------------------------------------------------------------------
-- RLS — org members read; members insert their own signature (validated above);
-- NO update (append-only trigger also blocks it); NO delete of any kind. A signed
-- acknowledgement is immutable, non-erasable evidence — not even an org admin can
-- destroy it (GDPR erasure, if ever needed, is a controlled+audited redaction of
-- signed_name via a future platform-super-admin path, never a hard delete here).
-- ---------------------------------------------------------------------------
alter table public.safety_acknowledgements enable row level security;

create policy safety_ack_select on public.safety_acknowledgements
  for select using (org_id in (select public.current_org_ids()));
-- A member may only record an acknowledgement AS THEMSELVES (user_id = auth.uid()),
-- in their own org — no signing on another worker's behalf.
create policy safety_ack_insert on public.safety_acknowledgements
  for insert with check (org_id in (select public.current_org_ids()) and user_id = auth.uid());
-- (No UPDATE or DELETE policy → RLS denies both for authenticated; the append-only
--  trigger blocks UPDATE even for the service role.)
