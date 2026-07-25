-- Health & Safety — evidence-hygiene hardening (M6, final epic adversarial review).
--
-- The final review confirmed the epic is evidence-grade + tenant-safe (single
-- current revision, same-org/same-series lineage, live-doc-only + append-only
-- signatures, pinned issue provenance, frozen contractual fields, RLS-scoped reads
-- + PDFs — all DB-enforced). It found two P3 within-tenant hygiene gaps; closed here
-- with small dedicated triggers (no reproduction of the large lifecycle functions):
--
--   F-A  A permit's lifecycle timestamps (activated_at / suspended_at / closed_at /
--        cancelled_at) were only pinned on a status transition and were not frozen
--        afterwards — a member could PATCH e.g. closed_at to a forged date while the
--        status was unchanged, and that date prints on the evidence PDF. Likewise a
--        control condition's confirmed_at was trusted from the client on the FIRST
--        confirm. Fixed: lifecycle stamps may change ONLY on an actual status
--        transition; confirmed_at/by are pinned server-side on the confirm.
--   F-B  org_id (+ created_by / created_at) were not in the issued-immutability
--        freeze lists — a member of TWO orgs could re-home a zero-child issued
--        RAMS/permit under the other org. Fixed: they freeze once the record leaves
--        draft.
--
-- Reversible: drop the three triggers + their functions. No row is mutated.

-- ---------------------------------------------------------------------------
-- Permit: lifecycle timestamps move only on a transition; org + creation
-- provenance freeze once issued.
-- ---------------------------------------------------------------------------
create or replace function public.tg_permit_evidence_hygiene()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- F-A: with the status unchanged, none of the lifecycle stamps may move — so a
  -- closed permit's closed_at (evidence, printed on the PDF) can't be back-dated,
  -- while a genuine transition is still free to set its own stamp.
  if new.status = old.status
     and (new.activated_at, new.suspended_at, new.closed_at, new.cancelled_at)
       is distinct from (old.activated_at, old.suspended_at, old.closed_at, old.cancelled_at) then
    raise exception 'permit lifecycle timestamps change only on a status transition';
  end if;

  -- F-B: org + creation provenance are immutable once the permit leaves draft.
  if old.status <> 'draft' then
    if new.org_id is distinct from old.org_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'org / creation provenance is immutable once a permit is issued';
    end if;
  end if;

  return new;
end;
$$;

create trigger tg_permit_evidence_hygiene
  before update on public.permits_to_work
  for each row execute function public.tg_permit_evidence_hygiene();

-- ---------------------------------------------------------------------------
-- Permit condition: pin who/when on the FIRST confirm for a real (JWT) caller, so
-- confirmed_at can't be back-dated. (The 20261019 trigger already freezes them
-- once confirmed; this closes the initial-confirm hole.) Service-role stays
-- explicit — same asymmetry as the rest of the epic.
-- ---------------------------------------------------------------------------
create or replace function public.tg_permit_condition_pin_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.confirmed and not old.confirmed and auth.uid() is not null then
    new.confirmed_at := now();
    new.confirmed_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger tg_permit_condition_pin_confirm
  before update on public.permit_conditions
  for each row execute function public.tg_permit_condition_pin_confirm();

-- ---------------------------------------------------------------------------
-- RAMS: org + creation provenance freeze once issued (F-B). issued_by/at + all
-- content are already frozen by tg_ra_immutable_when_issued (20261018/20261022);
-- this adds the org + creation columns without reproducing that function.
-- ---------------------------------------------------------------------------
create or replace function public.tg_ra_evidence_hygiene()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'draft' then
    if new.org_id is distinct from old.org_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'org / creation provenance is immutable once a risk assessment is issued';
    end if;
  end if;
  return new;
end;
$$;

create trigger tg_ra_evidence_hygiene
  before update on public.risk_assessments
  for each row execute function public.tg_ra_evidence_hygiene();
