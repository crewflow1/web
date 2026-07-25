-- Health & Safety — RAMS revisioning (M6a).
--
-- An issued RAMS is a frozen legal record and must NEVER be edited in place. When
-- the assessment changes you raise a REVISION: a new draft is created from the
-- issued snapshot (header + hazards copied), edited, then issued — at which point
-- the previous issued revision becomes `superseded` and the new one is the single
-- current record. Old acknowledgements stay attached to the old revision; the new
-- revision starts unsigned (each revision is its own subject row, so re-sign falls
-- out for free — no acknowledgement is ever copied or mutated).
--
-- This mirrors the versioned-publish house pattern proven for asset inspection
-- templates (20260929: family_id + version + a `one published per family` partial
-- unique index + an atomic SECURITY INVOKER publish RPC). It composes with the M5
-- issue hardening (20261021 tg_ra_lifecycle): the promote step is a draft->issued
-- UPDATE, so the issue-gate (assessor + >=1 hazard) and the issued_by/issued_at
-- pinning still fire on every revision.
--
-- Lineage model (smallest clear shape; no denormalised forward pointer — derive it):
--   root_risk_assessment_id  the series identity; equals `id` for revision 1,
--                            copied forward onto every later revision.
--   revision_number          1, 2, 3 … (unique within a series).
--   supersedes_id            the revision this one replaced (already existed on the
--                            table since 20261018 — finally used).
--
-- Additive + reversible: drop the two columns, the three partial indexes, the
-- lineage trigger + the RPC, and restore tg_ra_immutable_when_issued's frozen list.

-- ---------------------------------------------------------------------------
-- Columns + backfill (every existing RAMS becomes revision 1 of its own series).
-- ---------------------------------------------------------------------------
alter table public.risk_assessments
  add column if not exists root_risk_assessment_id uuid,
  add column if not exists revision_number integer not null default 1
    check (revision_number >= 1);

update public.risk_assessments set root_risk_assessment_id = id
  where root_risk_assessment_id is null;

alter table public.risk_assessments alter column root_risk_assessment_id set not null;

-- ---------------------------------------------------------------------------
-- Invariants.
--   (root, revision_number) unique  → no duplicate revision numbers in a series.
--   one ISSUED per series            → the single "current" record (load-bearing).
--   one DRAFT  per series            → at most one revision-in-progress (no fork /
--                                      race to two concurrent drafts).
-- ---------------------------------------------------------------------------
create unique index if not exists risk_assessments_series_revision_idx
  on public.risk_assessments (root_risk_assessment_id, revision_number);
create unique index if not exists risk_assessments_one_current_idx
  on public.risk_assessments (root_risk_assessment_id) where status = 'issued';
create unique index if not exists risk_assessments_one_draft_idx
  on public.risk_assessments (root_risk_assessment_id) where status = 'draft';
create index if not exists risk_assessments_series_idx
  on public.risk_assessments (root_risk_assessment_id, revision_number desc);

-- ---------------------------------------------------------------------------
-- Lineage integrity: default the series id on insert, and validate the series /
-- supersede pointers stay same-org + same-series (no loops, no cross-org, no
-- self-supersede). One trigger so there is no ordering hazard with M5's triggers.
-- ---------------------------------------------------------------------------
create or replace function public.tg_ra_revision_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Revision 1 self-roots (the client never sets this); later revisions carry the
  -- series id the create-revision path copied from their source.
  if tg_op = 'INSERT' and new.root_risk_assessment_id is null then
    new.root_risk_assessment_id := new.id;
  end if;

  -- A revision's series root must be a real RAMS in the same org.
  if new.root_risk_assessment_id <> new.id
     and not exists (select 1 from public.risk_assessments
                     where id = new.root_risk_assessment_id and org_id = new.org_id) then
    raise exception 'revision series root % is not a risk assessment in this organisation', new.root_risk_assessment_id;
  end if;

  -- The supersede pointer must be a different revision of the SAME series in the
  -- same org (blocks self-supersede, cross-series and cross-org lineage).
  if new.supersedes_id is not null then
    if new.supersedes_id = new.id then
      raise exception 'a risk assessment cannot supersede itself';
    end if;
    if not exists (select 1 from public.risk_assessments
                   where id = new.supersedes_id and org_id = new.org_id
                     and root_risk_assessment_id = new.root_risk_assessment_id) then
      raise exception 'supersedes_id must be another revision of the same series in this organisation';
    end if;
  end if;

  return new;
end;
$$;

create trigger tg_ra_revision_integrity
  before insert or update on public.risk_assessments
  for each row execute function public.tg_ra_revision_integrity();

-- ---------------------------------------------------------------------------
-- Freeze the lineage fields once issued (extend the 20261018 immutability list so
-- root_risk_assessment_id + revision_number can't be rewritten post-issue). The
-- body is otherwise identical to the original.
-- ---------------------------------------------------------------------------
create or replace function public.tg_ra_immutable_when_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'draft' then
    return new;  -- drafts are freely editable (incl. the transition to issued)
  end if;

  if new.status is distinct from old.status then
    if old.status = 'issued' and new.status in ('superseded', 'withdrawn') then
      null;  -- allowed lifecycle transition
    else
      raise exception 'invalid RAMS status transition % -> %', old.status, new.status;
    end if;
  end if;

  if (new.title, new.activity, new.location, new.job_id, new.reference,
      new.assessor_id, new.assessment_date, new.review_date, new.ppe,
      new.method_statement, new.issued_at, new.issued_by, new.supersedes_id,
      new.root_risk_assessment_id, new.revision_number)
     is distinct from
     (old.title, old.activity, old.location, old.job_id, old.reference,
      old.assessor_id, old.assessment_date, old.review_date, old.ppe,
      old.method_statement, old.issued_at, old.issued_by, old.supersedes_id,
      old.root_risk_assessment_id, old.revision_number)
  then
    raise exception 'a % risk assessment is immutable; raise a new revision instead', old.status;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic issue-of-a-revision. Supersede the series' currently-issued revision and
-- promote this draft in ONE transaction, so there is never a window with two
-- current revisions (or an old one retired but the new issue failing). SECURITY
-- INVOKER: RLS + every RAMS trigger (incl. M5's issue-gate + provenance pin) still
-- apply to the caller; the `one issued per series` partial index backstops a race.
--
-- The revision keeps the series' human number and appends its revision (RA-0001 ->
-- RA-0001-R02, R03 …) so the lineage is legible on the document itself and the
-- unique(org_id,reference) constraint is honoured. Revision 1 keeps its bare
-- RA-NNNN (never rewritten). Revisions do NOT consume a new RA-NNNN sequence value
-- (next_ra_number parses the numeric part, ignoring the -R suffix).
-- ---------------------------------------------------------------------------
create or replace function public.issue_rams_revision(p_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_root   uuid;
  v_org    uuid;
  v_rev    integer;
  v_status text;
  v_base   text;
  v_newref text;
begin
  select root_risk_assessment_id, org_id, revision_number, status
    into v_root, v_org, v_rev, v_status
  from public.risk_assessments
  where id = p_id
  for update;

  if v_root is null then
    raise exception 'risk assessment % not found', p_id;
  end if;
  if v_status <> 'draft' then
    raise exception 'only a draft revision can be issued (status %)', v_status;
  end if;
  if v_rev < 2 then
    raise exception 'the first issue of a series uses the standard issue flow, not a revision';
  end if;

  -- The series' canonical number is revision 1's reference (RA-NNNN).
  select reference into v_base
  from public.risk_assessments
  where root_risk_assessment_id = v_root and revision_number = 1;
  if v_base is null then
    raise exception 'the series has no issued origin revision to number against';
  end if;
  v_newref := v_base || '-R' || lpad(v_rev::text, 2, '0');

  -- Retire the currently-issued revision (if any), then promote this draft. The
  -- draft->issued UPDATE fires tg_ra_lifecycle → issue-gate + issued_by/at pin.
  update public.risk_assessments
     set status = 'superseded'
   where root_risk_assessment_id = v_root and status = 'issued';

  update public.risk_assessments
     set status = 'issued', reference = v_newref,
         issued_at = now(), issued_by = auth.uid()
   where id = p_id;

  return v_newref;
end;
$$;

grant execute on function public.issue_rams_revision(uuid) to authenticated;
