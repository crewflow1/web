-- Works Quality — Milestone 2: NCRs + corrective actions, witness invitations,
-- ITP templates, and revision lineage on inspection plans.
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
-- M1 (20261076) shipped the ITP spine: inspection_test_plans /
-- inspection_plan_items / inspection_signoffs, the DB-authoritative hold-point
-- gate (WARN-and-STAMP, never a block) and the atomic issue RPC. This milestone
-- adds what happens when a check FAILS, who watches the witness points, and how
-- a controlled plan is templated and revised:
--
--   non_conformance_reports        a FAILED check (or an observed nonconformity
--                                  against a plan item) with a corrective-action
--                                  lifecycle and a verified closure
--   ncr_corrective_actions         the proposed fixes — each proposal is a row,
--                                  its review decision is write-once, and a
--                                  rejected proposal is replaced, never edited
--   inspection_witness_invitations staff-recorded invitations of a named third
--                                  party to a witness/approve control point
--   inspection_plan_templates(+items)  versioned, RELATIONAL checklists that
--                                  instantiate into a real DRAFT plan's items
--   root_plan_id / revision_number lineage on inspection_test_plans (the RAMS
--                                  20261022 shape) so "revision B of the
--                                  drainage ITP" is a database fact
--
-- ── NCRs ARE NOT SNAGS ──────────────────────────────────────────────────────
-- CrewFlow already has `snags` (20260919): defects FOUND on a walkdown, the
-- open-ended punch list. An NCR is the other direction: works were CHECKED
-- against an issued inspection plan and did NOT CONFORM — it is anchored to a
-- specific plan item (and usually a failed sign-off), carries a severity and a
-- responsible party, and cannot close without a verified corrective action.
-- Nothing in this migration touches the snags domain.
--
-- ── PORTAL WITNESS VISIBILITY IS DEFERRED, STATED PLAINLY ───────────────────
-- Witness invitations are recorded BY STAFF. Read-only portal visibility of
-- upcoming witness points for the job's customer (the site_reports
-- portal-publication precedent) is DELIBERATELY NOT BUILT here, and no
-- token-holder write path exists or is hinted at. When it lands it will be a
-- separate, read-only publication surface.
--
-- ── CONVENTIONS, ALL LIFTED (never invented) ────────────────────────────────
--   · DB transition trigger with role gates + service-role asymmetry
--     (graph for everyone, role checks skipped when auth.uid() is null)
--                                       (material_requests, 20261066/67)
--   · DERIVED statuses reachable only through a transaction-local marker set by
--     the one legitimate writer          (crewflow.mr_fulfilment, 20261067)
--   · write-once decisions with pinned decided_at + immutability trigger
--                                       (material_requests decisions, 20261066)
--   · child org_id trigger-DERIVED from the parent, composite (id, org_id) FKs,
--     `no action deferrable initially deferred` on any FK on the teardown path
--                                       (20261076 / 20261024 / 20261052 lesson)
--   · one-published-per-name partial unique + atomic SECURITY INVOKER publish
--                                       (asset_inspection_templates, 20260929)
--   · root id + revision_number lineage, backfilled self-rooted
--                                       (RAMS revisioning, 20261022)
--   · attachment target widened by introspect-drop-readd, DB CHECK and TS list
--     moved together                    (20261076 §9 + attachment-drift test)
--
-- ── STRICT-SUPERSET REPLACEMENTS (three, each stated) ───────────────────────
-- This migration CREATE OR REPLACEs three M1 functions. Each body is the M1
-- body VERBATIM plus additions; no M1 behaviour is loosened:
--   · tg_itp_lifecycle       — frozen tuple gains root_plan_id, revision_number
--   · tg_signoff_validate    — gains witness_invitation_id same-item validation
--   · tg_signoff_void_only   — frozen tuple gains witness_invitation_id
-- issue_inspection_plan is NOT touched: revision issue composes around it (a
-- revision draft carries its lineage at insert; the RPC's natural-key supersede
-- already retires the series' current plan). A revision therefore takes a fresh
-- ITP-NNNN — a deliberate divergence from RAMS' -R suffix, because M1 already
-- allocates per-issue and sign-offs anchor on the exact reference; lineage is
-- carried by the columns, not the number.
--
-- ── NO MONEY, NO AI ─────────────────────────────────────────────────────────
-- Nothing here writes to `finances`, creates a posting, or references a
-- monetary table. No AI on any path.
--
-- Additive + reversible. Rollback: drop the five new tables (and their
-- triggers/functions/policies), the publish RPC, the two lineage columns and
-- their indexes, the signoff witness_invitation_id column + FK, restore the
-- three replaced functions from 20261076, and re-add the previous
-- tenant_attachments_target_table_check (18 values). No existing row is
-- mutated except the root_plan_id backfill (self-rooting, value = own id).

-- ---------------------------------------------------------------------------
-- 0. inspection_signoffs needs a (id, org_id) candidate key so NCRs and the
--    witness column can bind tenancy with composite FKs (M1 gave plans and
--    items one; sign-offs did not need it until now).
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.inspection_signoffs
    add constraint isg_id_org_key unique (id, org_id);
exception when duplicate_table or duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 1. non_conformance_reports
--
-- Raised from a FAILED sign-off, or standalone against a plan item on a plan
-- that has left draft. Born 'open' with its NCR-NNNN already allocated — unlike
-- a plan there is no draft/issue split, so the allocation lives in the ONE
-- write path (the insert trigger), org-predicated and backstopped by
-- unique (org_id, reference): the same reasoning that put the ITP allocator
-- inside issue_inspection_plan rather than in a standalone SECURITY DEFINER
-- allocator.
--
-- THE TRANSITION GRAPH
--   open                         → corrective_action_proposed | cancelled
--   corrective_action_proposed   → corrective_action_approved | open | cancelled
--   corrective_action_approved   → completed | cancelled
--   completed                    → closed | cancelled
--   closed / cancelled           → TERMINAL
--
-- The three middle edges (→proposed, →approved/→open, →completed) are DERIVED
-- from the corrective-action record and are unreachable by hand: the trigger
-- requires the transaction-local marker only the corrective-action cascade
-- sets (the crewflow.mr_fulfilment idiom, 20261067). A raw JWT cannot
-- PostgREST an NCR to 'completed'.
--
-- WHO MAY WALK THE HAND EDGES
--   close   (completed → closed)  any member, verifying AS THEMSELVES —
--           verified_by/verified_at are server-pinned to the session, the
--           closure comment is structurally required (the sign-off
--           personal-attestation precedent; quality verification is an
--           attestation, not an office decision)
--   cancel  pre-decision (open/proposed): the raiser or an admin
--           post-decision (approved/completed): ADMIN ONLY — once the company
--           has committed to a fix, standing the record down is an office
--           decision (the material_requests cancel split, 20261067)
--
-- RESPONSIBLE PARTY: a member (responsible_user_id) or a free-text
-- subcontractor — at least one, by CHECK. Both user FKs that carry
-- accountability (raised_by, responsible_user_id) are ON DELETE RESTRICT: the
-- inspected_by rule from 20261076 — public.users is never reached by org
-- teardown (no org_id), so RESTRICT here cannot abort `delete from
-- organizations`, and it keeps the accountability record honest. (SET NULL on
-- responsible_user_id would also let a user delete silently violate the
-- at-least-one CHECK with a far more confusing error.)
--
-- NO HARD DELETE for any role: an NCR is numbered quality evidence from birth
-- (its reference exists at raise). The retraction path is 'cancelled'.
-- ---------------------------------------------------------------------------
create table if not exists public.non_conformance_reports (
  id                        uuid primary key default gen_random_uuid(),
  -- Derived from the plan item by trigger (any client value is ignored).
  org_id                    uuid not null,
  inspection_plan_item_id   uuid not null,
  -- The failed sign-off this NCR was raised from, when there is one. Optional:
  -- a nonconformity can be observed against a plan item before anyone records
  -- a formal fail. Must be a 'fail' against the SAME item (trigger).
  source_signoff_id         uuid,
  -- NCR-NNNN, allocated by the insert trigger. Never client-supplied.
  reference                 text not null,
  title                     text not null,
  description               text not null,
  severity                  text not null
    check (severity in ('minor', 'major', 'critical')),
  -- The party answerable for the fix: a member, or a named subcontractor.
  responsible_user_id       uuid references public.users(id) on delete restrict,
  responsible_subcontractor text,
  due_date                  date,
  status                    text not null default 'open'
    check (status in ('open', 'corrective_action_proposed',
                      'corrective_action_approved', 'completed',
                      'closed', 'cancelled')),
  raised_by                 uuid not null references public.users(id) on delete restrict,
  -- Closure verification: who checked the corrective works actually conform,
  -- when, and what they found. verified_by may be SET NULL if that user is
  -- later deleted, so only the timestamp + comment are structurally required
  -- (the material_requests decision-provenance rule, 20261066 note).
  verified_by               uuid references public.users(id) on delete set null,
  verified_at               timestamptz,
  closure_comment           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint ncr_id_org_key unique (id, org_id),
  constraint ncr_org_reference_key unique (org_id, reference),
  constraint ncr_item_org_fk
    foreign key (inspection_plan_item_id, org_id)
    references public.inspection_plan_items (id, org_id) on delete cascade,
  -- Deferred no-action, never cascade/restrict: a sign-off is only ever deleted
  -- by org teardown, where both sides go in the same transaction (20261052).
  constraint ncr_source_signoff_org_fk
    foreign key (source_signoff_id, org_id)
    references public.inspection_signoffs (id, org_id)
    on delete no action deferrable initially deferred,
  constraint ncr_description_present check (btrim(description) <> ''),
  constraint ncr_title_present check (btrim(title) <> ''),
  -- At least one responsible party, always.
  constraint ncr_responsible_party_present
    check (responsible_user_id is not null
           or (responsible_subcontractor is not null
               and btrim(responsible_subcontractor) <> '')),
  -- A closed NCR carries its verification (the trigger pins the values; this
  -- backstops direct writes for every role).
  constraint ncr_closure_provenance
    check (status <> 'closed'
           or (verified_at is not null
               and closure_comment is not null and btrim(closure_comment) <> ''))
);

create index if not exists ncr_org_idx     on public.non_conformance_reports (org_id, created_at desc);
create index if not exists ncr_status_idx  on public.non_conformance_reports (org_id, status);
create index if not exists ncr_item_idx    on public.non_conformance_reports (inspection_plan_item_id);
create index if not exists ncr_source_idx  on public.non_conformance_reports (source_signoff_id)
  where source_signoff_id is not null;

drop trigger if exists ncr_set_updated_at on public.non_conformance_reports;
create trigger ncr_set_updated_at before update on public.non_conformance_reports
  for each row execute function public.tg_set_updated_at();

-- Raise-time validation + org derivation + reference allocation, in ONE
-- BEFORE INSERT authority so no insert path (app, PostgREST, service) can skip
-- any part of it.
create or replace function public.tg_ncr_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_org    uuid;
  v_plan_id     uuid;
  v_plan_status text;
  v_ref         text;
begin
  -- 1. Resolve the item; org_id is authoritative from the parent.
  select i.org_id, i.inspection_test_plan_id
    into v_item_org, v_plan_id
  from public.inspection_plan_items i
  where i.id = new.inspection_plan_item_id;
  if v_item_org is null then
    raise exception 'inspection item % not found', new.inspection_plan_item_id;
  end if;
  new.org_id := v_item_org;

  -- 2. Membership FIRST, so a non-member cannot probe another org's plan state
  --    through the later error messages (the 20261020 lesson).
  if auth.uid() is not null then
    if not exists (select 1 from public.memberships
                   where org_id = v_item_org and user_id = auth.uid()) then
      raise exception 'not a member of this organisation';
    end if;
    -- The raiser is the session, never form input.
    new.raised_by := auth.uid();
  end if;
  if new.raised_by is null then
    raise exception 'an NCR must name who raised it';
  end if;

  -- 3. Only a plan that has LEFT DRAFT can have a nonconformity: a draft is
  --    not a controlled document to not-conform against. Superseded/withdrawn
  --    plans remain valid subjects — the works were checked against them.
  select status into v_plan_status
  from public.inspection_test_plans where id = v_plan_id;
  if v_plan_status = 'draft' then
    raise exception 'an NCR can only be raised against an issued inspection plan';
  end if;

  -- 4. The source sign-off, when named, must be a FAIL against the SAME item.
  if new.source_signoff_id is not null then
    if not exists (
      select 1 from public.inspection_signoffs s
      where s.id = new.source_signoff_id
        and s.inspection_plan_item_id = new.inspection_plan_item_id
        and s.result = 'fail'
    ) then
      raise exception 'the source sign-off must be a failed sign-off of this inspection item';
    end if;
  end if;

  -- 5. Born open, with clean provenance — a direct INSERT can never mint a
  --    closed NCR and skip the corrective-action lifecycle (20261019 P0-1).
  if new.status <> 'open' then
    raise exception 'an NCR is raised open, then worked through its corrective actions';
  end if;
  new.verified_by := null;
  new.verified_at := null;
  new.closure_comment := null;
  new.created_at := now();

  -- 6. Allocate NCR-NNNN — in-function, org-predicated, unique-backstopped
  --    (a read-max race yields a loud unique violation, never a duplicate).
  --    The client's value is ignored.
  select 'NCR-' || lpad(
           (coalesce(max(cast(substring(reference from 'NCR-(\d+)') as int)), 0) + 1)::text,
           4, '0')
    into v_ref
  from public.non_conformance_reports
  where org_id = v_item_org;
  new.reference := v_ref;

  return new;
end;
$$;

drop trigger if exists tg_ncr_before_insert on public.non_conformance_reports;
create trigger tg_ncr_before_insert
  before insert on public.non_conformance_reports
  for each row execute function public.tg_ncr_before_insert();

-- ONE BEFORE UPDATE authority: identity freeze, substance freeze outside
-- 'open', the transition graph, the derived-edge marker, and closure pinning.
-- One function so there is no trigger-ordering hazard (the 20261022 rule).
create or replace function public.tg_ncr_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jwt    boolean;
  v_admin  boolean;
  v_raiser boolean;
  v_marker text;
begin
  -- Identity is frozen at raise, for every status and every role.
  if (new.id, new.org_id, new.reference, new.inspection_plan_item_id,
      new.source_signoff_id, new.raised_by, new.created_at)
     is distinct from
     (old.id, old.org_id, old.reference, old.inspection_plan_item_id,
      old.source_signoff_id, old.raised_by, old.created_at)
  then
    raise exception 'an NCR''s identity (reference, item, source, raiser) is frozen at raise';
  end if;

  -- Terminal states are final.
  if old.status in ('closed', 'cancelled') then
    raise exception 'non-conformance %: % is final', old.id, old.status
      using errcode = 'check_violation';
  end if;

  -- Substance is editable only while OPEN, and never rides in on a transition
  -- (the 20261019 P0-2 lesson).
  if old.status <> 'open' or new.status is distinct from old.status then
    if (new.title, new.description, new.severity, new.responsible_user_id,
        new.responsible_subcontractor, new.due_date)
       is distinct from
       (old.title, old.description, old.severity, old.responsible_user_id,
        old.responsible_subcontractor, old.due_date)
    then
      raise exception 'an NCR under corrective action is frozen; the corrective-action record carries what changed';
    end if;
  end if;

  -- Closure provenance is written by the close transition below, never by hand.
  if not (old.status = 'completed' and new.status = 'closed')
     and (new.verified_by, new.verified_at, new.closure_comment)
         is distinct from (old.verified_by, old.verified_at, old.closure_comment)
  then
    raise exception 'closure verification is written by the close transition, not edited by hand';
  end if;

  if new.status is not distinct from old.status then
    return new;  -- an open-state field edit; nothing more to police
  end if;

  v_jwt    := auth.uid() is not null;
  v_admin  := (not v_jwt) or public.is_org_admin(new.org_id);
  v_raiser := (not v_jwt) or old.raised_by = auth.uid();

  -- ── The DERIVED edges: only ever reached through the corrective-action
  --    cascade (marker names THIS row, so it cannot wave another row through).
  if (old.status = 'open' and new.status = 'corrective_action_proposed')
     or (old.status = 'corrective_action_proposed'
         and new.status in ('corrective_action_approved', 'open'))
     or (old.status = 'corrective_action_approved' and new.status = 'completed')
  then
    v_marker := coalesce(current_setting('crewflow.ncr_cascade', true), '');
    if v_marker <> new.id::text then
      raise exception
        'non-conformance %: this status is DERIVED from the corrective-action record, not set by hand', old.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ── Closing: a member verifies the corrective works AS THEMSELVES.
  if old.status = 'completed' and new.status = 'closed' then
    if new.closure_comment is null or btrim(new.closure_comment) = '' then
      raise exception 'closing an NCR requires a closure comment describing the verification';
    end if;
    new.verified_at := now();
    if v_jwt then
      new.verified_by := auth.uid();
    end if;
    if new.verified_by is null then
      raise exception 'closing an NCR requires the verifying user';
    end if;
    return new;
  end if;

  -- ── Cancelling: raiser-or-admin before a fix is committed to; admin after.
  if new.status = 'cancelled' then
    if old.status in ('open', 'corrective_action_proposed') then
      if not (v_raiser or v_admin) then
        raise exception 'non-conformance %: only the raiser or an admin can cancel it', old.id
          using errcode = 'insufficient_privilege';
      end if;
    elsif not v_admin then
      raise exception 'non-conformance %: once a corrective action is approved, only an admin can cancel it', old.id
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  raise exception 'non-conformance %: % -> % is not a legal transition',
    old.id, old.status, new.status using errcode = 'check_violation';
end;
$$;

drop trigger if exists tg_ncr_update_guard on public.non_conformance_reports;
create trigger tg_ncr_update_guard
  before update on public.non_conformance_reports
  for each row execute function public.tg_ncr_update_guard();

-- An NCR is numbered quality evidence from birth: never hard-deleted, by any
-- role. 'cancelled' is the retraction path. Org teardown passes through the
-- existence escape (20261021).
create or replace function public.tg_ncr_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id) then
    raise exception 'an NCR is quality evidence and cannot be deleted; cancel it instead';
  end if;
  return old;
end;
$$;

drop trigger if exists tg_ncr_block_delete on public.non_conformance_reports;
create trigger tg_ncr_block_delete
  before delete on public.non_conformance_reports
  for each row execute function public.tg_ncr_block_delete();

-- ---------------------------------------------------------------------------
-- 2. ncr_corrective_actions — the proposed fixes.
--
-- Each proposal is a ROW. The review decision (accept|reject) is WRITE-ONCE
-- with pinned provenance (material_requests precedent); a rejected proposal is
-- never edited — the NCR falls back to 'open' (derived) and a NEW action is
-- proposed. At most one UNDECIDED proposal per NCR (partial unique).
--
-- The NCR's middle statuses are DERIVED here, in AFTER triggers, through the
-- transaction-local marker the NCR transition trigger requires. LOUD on
-- divergence: if the parent NCR is not in the expected state the cascade
-- raises, so an action can never be decided against a cancelled NCR while the
-- two rows silently disagree.
-- ---------------------------------------------------------------------------
create table if not exists public.ncr_corrective_actions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null,          -- trigger-derived from the NCR
  ncr_id             uuid not null,
  description        text not null,
  assigned_to        uuid references public.users(id) on delete set null,
  due_date           date,
  proposed_by        uuid references public.users(id) on delete set null,
  proposed_at        timestamptz not null default now(),
  -- The write-once review decision.
  decision           text check (decision in ('accepted', 'rejected')),
  decision_reason    text,
  decided_by         uuid references public.users(id) on delete set null,
  decided_at         timestamptz,
  -- Completion of an ACCEPTED action: stamp + comment, required together.
  completed_at       timestamptz,
  completion_comment text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint nca_id_org_key unique (id, org_id),
  constraint nca_ncr_org_fk
    foreign key (ncr_id, org_id)
    references public.non_conformance_reports (id, org_id) on delete cascade,
  constraint nca_description_present check (btrim(description) <> ''),
  -- A decision exists iff its timestamp does (material_requests shape).
  constraint nca_decision_stamped check ((decision is null) = (decided_at is null)),
  -- A rejection must say why — otherwise the next proposal repeats the mistake.
  constraint nca_rejection_reason_required
    check (decision is distinct from 'rejected'
           or (decision_reason is not null and btrim(decision_reason) <> '')),
  -- Completion is stamp + comment together, and only on an accepted action.
  constraint nca_completion_pair
    check ((completed_at is null and completion_comment is null)
           or (completed_at is not null
               and completion_comment is not null and btrim(completion_comment) <> '')),
  constraint nca_completion_requires_acceptance
    check (completed_at is null or decision = 'accepted')
);

-- At most ONE undecided proposal per NCR — "what is awaiting review" is a
-- single, unambiguous row (the one-live-per-item idiom applied to proposals).
create unique index if not exists nca_one_pending_per_ncr_idx
  on public.ncr_corrective_actions (ncr_id) where decision is null;

create index if not exists nca_ncr_idx on public.ncr_corrective_actions (ncr_id, created_at);
create index if not exists nca_org_idx on public.ncr_corrective_actions (org_id);

drop trigger if exists nca_set_updated_at on public.ncr_corrective_actions;
create trigger nca_set_updated_at before update on public.ncr_corrective_actions
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_nca_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_status text;
begin
  select org_id, status into v_org, v_status
  from public.non_conformance_reports where id = new.ncr_id;
  if v_org is null then
    raise exception 'non-conformance report % not found', new.ncr_id;
  end if;
  new.org_id := v_org;

  -- Membership first (20261020), then the state check.
  if auth.uid() is not null then
    if not exists (select 1 from public.memberships
                   where org_id = v_org and user_id = auth.uid()) then
      raise exception 'not a member of this organisation';
    end if;
    new.proposed_by := auth.uid();
  end if;

  -- A proposal is only meaningful against an OPEN NCR: after a reject the NCR
  -- is already back at open (derived), so this is also what makes "a rejected
  -- action is replaced, never edited" the only possible flow.
  if v_status <> 'open' then
    raise exception 'a corrective action can only be proposed against an open NCR (status %)', v_status;
  end if;

  -- Born undecided and uncompleted, with pinned proposal provenance.
  new.decision := null;
  new.decision_reason := null;
  new.decided_by := null;
  new.decided_at := null;
  new.completed_at := null;
  new.completion_comment := null;
  new.proposed_at := now();
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists tg_nca_before_insert on public.ncr_corrective_actions;
create trigger tg_nca_before_insert
  before insert on public.ncr_corrective_actions
  for each row execute function public.tg_nca_before_insert();

create or replace function public.tg_nca_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The proposal itself is never edited — a different fix is a NEW proposal.
  if (new.id, new.org_id, new.ncr_id, new.description, new.assigned_to,
      new.due_date, new.proposed_by, new.proposed_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.ncr_id, old.description, old.assigned_to,
      old.due_date, old.proposed_by, old.proposed_at, old.created_at)
  then
    raise exception 'a proposed corrective action is never edited; reject it and propose a new one';
  end if;

  -- ── The decision: write-once, admin-gated, server-pinned. ────────────────
  if (new.decision, new.decision_reason, new.decided_by, new.decided_at)
     is distinct from
     (old.decision, old.decision_reason, old.decided_by, old.decided_at)
  then
    if old.decision is not null then
      raise exception 'a corrective-action decision is write-once; it cannot be changed';
    end if;
    if new.decision is null then
      raise exception 'a corrective-action decision cannot be blanked or partially written';
    end if;
    -- The house gate for a decision that commits the company: owner/admin
    -- (approveExpenseDraft / reviewLeaveRequest / material_requests). Role
    -- checks are skipped on the service path; the graph never is.
    if auth.uid() is not null and not public.is_org_admin(new.org_id) then
      raise exception 'only an owner or admin can accept or reject a corrective action'
        using errcode = 'insufficient_privilege';
    end if;
    if new.decision = 'rejected'
       and (new.decision_reason is null or btrim(new.decision_reason) = '') then
      raise exception 'rejecting a corrective action requires a reason';
    end if;
    new.decided_at := now();
    if auth.uid() is not null then
      new.decided_by := auth.uid();
    end if;
    if new.decided_by is null then
      raise exception 'a corrective-action decision must name who decided it';
    end if;
  end if;

  -- ── Completion: write-once, only on an already-accepted action. ──────────
  if (new.completed_at, new.completion_comment)
     is distinct from (old.completed_at, old.completion_comment)
  then
    if old.completed_at is not null then
      raise exception 'corrective-action completion is write-once';
    end if;
    -- old.decision, not new: completion cannot ride in with the decision.
    if old.decision is distinct from 'accepted' then
      raise exception 'only an accepted corrective action can be completed';
    end if;
    if new.completed_at is null
       or new.completion_comment is null or btrim(new.completion_comment) = '' then
      raise exception 'completing a corrective action requires the completion comment';
    end if;
    new.completed_at := now();  -- server-pinned; the client cannot backdate it
  end if;

  return new;
end;
$$;

drop trigger if exists tg_nca_update_guard on public.ncr_corrective_actions;
create trigger tg_nca_update_guard
  before update on public.ncr_corrective_actions
  for each row execute function public.tg_nca_update_guard();

-- The cascade: the ONE writer of the NCR's derived statuses. AFTER triggers so
-- the action row's own guards have already accepted the write. LOUD when the
-- parent is not in the expected state — never a silent no-op divergence.
--
-- FOUND IS CAPTURED BEFORE THE MARKER IS CLEARED, deliberately: PERFORM itself
-- sets FOUND (set_config returns a row, so FOUND is true after every PERFORM
-- set_config). Checking FOUND after the clearing PERFORM would therefore
-- ALWAYS pass — dead code — and a decision could land on an action whose NCR
-- was cancelled mid-flight, the exact silent divergence this guard exists to
-- refuse.
create or replace function public.tg_nca_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_moved boolean;
begin
  if tg_op = 'INSERT' then
    perform set_config('crewflow.ncr_cascade', new.ncr_id::text, true);
    update public.non_conformance_reports
       set status = 'corrective_action_proposed'
     where id = new.ncr_id and status = 'open';
    v_moved := found;  -- BEFORE the marker clear (see header)
    perform set_config('crewflow.ncr_cascade', '', true);
    if not v_moved then
      raise exception 'the NCR is not open to receive a proposal';
    end if;
    return new;
  end if;

  if old.decision is null and new.decision = 'accepted' then
    perform set_config('crewflow.ncr_cascade', new.ncr_id::text, true);
    update public.non_conformance_reports
       set status = 'corrective_action_approved'
     where id = new.ncr_id and status = 'corrective_action_proposed';
    v_moved := found;  -- BEFORE the marker clear (see header)
    perform set_config('crewflow.ncr_cascade', '', true);
    if not v_moved then
      raise exception 'the NCR is not awaiting this decision (it may have been cancelled)';
    end if;
  elsif old.decision is null and new.decision = 'rejected' then
    perform set_config('crewflow.ncr_cascade', new.ncr_id::text, true);
    update public.non_conformance_reports
       set status = 'open'
     where id = new.ncr_id and status = 'corrective_action_proposed';
    v_moved := found;  -- BEFORE the marker clear (see header)
    perform set_config('crewflow.ncr_cascade', '', true);
    if not v_moved then
      raise exception 'the NCR is not awaiting this decision (it may have been cancelled)';
    end if;
  end if;

  if old.completed_at is null and new.completed_at is not null then
    perform set_config('crewflow.ncr_cascade', new.ncr_id::text, true);
    update public.non_conformance_reports
       set status = 'completed'
     where id = new.ncr_id and status = 'corrective_action_approved';
    v_moved := found;  -- BEFORE the marker clear (see header)
    perform set_config('crewflow.ncr_cascade', '', true);
    if not v_moved then
      raise exception 'the NCR is not awaiting completion (it may have been cancelled)';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tg_nca_cascade_ins on public.ncr_corrective_actions;
create trigger tg_nca_cascade_ins
  after insert on public.ncr_corrective_actions
  for each row execute function public.tg_nca_cascade();
drop trigger if exists tg_nca_cascade_upd on public.ncr_corrective_actions;
create trigger tg_nca_cascade_upd
  after update on public.ncr_corrective_actions
  for each row execute function public.tg_nca_cascade();

-- Proposals are the audit trail of the fix conversation: never hard-deleted.
create or replace function public.tg_nca_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id) then
    raise exception 'a corrective action is part of the NCR audit trail and cannot be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists tg_nca_block_delete on public.ncr_corrective_actions;
create trigger tg_nca_block_delete
  before delete on public.ncr_corrective_actions
  for each row execute function public.tg_nca_block_delete();

-- ---------------------------------------------------------------------------
-- 3. inspection_witness_invitations
--
-- Staff invite a NAMED witness (client's clerk of works, CA, building control)
-- to a witness/approve control point on an ISSUED plan, and staff record
-- whether they attended. The witness is not a CrewFlow user and never writes;
-- attendance is stamped with who recorded it and when (server-pinned).
-- Portal visibility is deferred (see header).
-- ---------------------------------------------------------------------------
create table if not exists public.inspection_witness_invitations (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null,   -- trigger-derived from the item
  inspection_plan_item_id  uuid not null,
  witness_name             text not null,
  witness_organisation     text not null,
  witness_email            text,
  -- When the witness point is expected on site (optional planning aid).
  scheduled_for            date,
  status                   text not null default 'invited'
    check (status in ('invited', 'attended', 'not_attended', 'cancelled')),
  invited_by               uuid references public.users(id) on delete set null,
  -- Attendance provenance: WHO recorded the outcome, and when (pinned).
  attendance_recorded_by   uuid references public.users(id) on delete set null,
  attendance_recorded_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint iwi_id_org_key unique (id, org_id),
  constraint iwi_item_org_fk
    foreign key (inspection_plan_item_id, org_id)
    references public.inspection_plan_items (id, org_id) on delete cascade,
  constraint iwi_name_present check (btrim(witness_name) <> ''),
  constraint iwi_organisation_present check (btrim(witness_organisation) <> ''),
  -- An attendance outcome exists iff its stamp does.
  constraint iwi_attendance_stamped
    check ((status in ('attended', 'not_attended')) = (attendance_recorded_at is not null))
);

create index if not exists iwi_item_idx on public.inspection_witness_invitations (inspection_plan_item_id);
create index if not exists iwi_org_idx  on public.inspection_witness_invitations (org_id, status);

drop trigger if exists iwi_set_updated_at on public.inspection_witness_invitations;
create trigger iwi_set_updated_at before update on public.inspection_witness_invitations
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_iwi_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_org      uuid;
  v_plan_id       uuid;
  v_control_point text;
  v_plan_status   text;
begin
  select i.org_id, i.inspection_test_plan_id, i.control_point
    into v_item_org, v_plan_id, v_control_point
  from public.inspection_plan_items i
  where i.id = new.inspection_plan_item_id;
  if v_item_org is null then
    raise exception 'inspection item % not found', new.inspection_plan_item_id;
  end if;
  new.org_id := v_item_org;

  -- Membership first (20261020).
  if auth.uid() is not null then
    if not exists (select 1 from public.memberships
                   where org_id = v_item_org and user_id = auth.uid()) then
      raise exception 'not a member of this organisation';
    end if;
    new.invited_by := auth.uid();
  end if;

  -- Only a witness/approve control point HAS a second party to invite.
  if v_control_point not in ('witness', 'approve') then
    raise exception 'a witness can only be invited to a witness or approve control point';
  end if;

  -- Only an ISSUED plan has live witness points.
  select status into v_plan_status
  from public.inspection_test_plans where id = v_plan_id;
  if v_plan_status is distinct from 'issued' then
    raise exception 'witnesses are invited against an issued plan (status %)',
      coalesce(v_plan_status, 'missing');
  end if;

  -- Born invited, with no attendance yet.
  if new.status <> 'invited' then
    raise exception 'a witness invitation is created as invited, then its attendance recorded';
  end if;
  new.attendance_recorded_by := null;
  new.attendance_recorded_at := null;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists tg_iwi_before_insert on public.inspection_witness_invitations;
create trigger tg_iwi_before_insert
  before insert on public.inspection_witness_invitations
  for each row execute function public.tg_iwi_before_insert();

-- invited → attended | not_attended | cancelled; every outcome is terminal
-- (a correction is a fresh invitation, so the recorded outcome is never
-- silently rewritten). Attendance stamps are server-pinned.
create or replace function public.tg_iwi_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.id, new.org_id, new.inspection_plan_item_id, new.invited_by, new.created_at)
     is distinct from
     (old.id, old.org_id, old.inspection_plan_item_id, old.invited_by, old.created_at)
  then
    raise exception 'a witness invitation cannot be moved or re-attributed';
  end if;

  if old.status <> 'invited' then
    raise exception 'a % witness invitation is final; invite them again instead', old.status;
  end if;

  if new.status is not distinct from old.status then
    -- A typo fix while still invited is fine; attendance fields are not.
    if (new.attendance_recorded_by, new.attendance_recorded_at)
       is distinct from (old.attendance_recorded_by, old.attendance_recorded_at)
    then
      raise exception 'attendance is recorded by the attended/not-attended transition, not by hand';
    end if;
    return new;
  end if;

  if new.status in ('attended', 'not_attended') then
    new.attendance_recorded_at := now();
    if auth.uid() is not null then
      new.attendance_recorded_by := auth.uid();
    end if;
    if new.attendance_recorded_by is null then
      raise exception 'recording attendance requires the recording user';
    end if;
    return new;
  end if;

  if new.status = 'cancelled' then
    new.attendance_recorded_at := null;
    new.attendance_recorded_by := null;
    return new;
  end if;

  raise exception 'witness invitation: % -> % is not a legal transition',
    old.status, new.status using errcode = 'check_violation';
end;
$$;

drop trigger if exists tg_iwi_update_guard on public.inspection_witness_invitations;
create trigger tg_iwi_update_guard
  before update on public.inspection_witness_invitations
  for each row execute function public.tg_iwi_update_guard();

-- A recorded outcome (attended / not attended) is part of the inspection
-- story: only a still-invited row may be deleted (tidy-up); cancel covers the
-- rest. Teardown passes through the existence escape.
create or replace function public.tg_iwi_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'invited'
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception 'a % witness invitation is part of the inspection record and cannot be deleted', old.status;
  end if;
  return old;
end;
$$;

drop trigger if exists tg_iwi_block_delete on public.inspection_witness_invitations;
create trigger tg_iwi_block_delete
  before delete on public.inspection_witness_invitations
  for each row execute function public.tg_iwi_block_delete();

-- ── Sign-offs may reference the invitation that was honoured ────────────────
-- Nullable column, populated AT INSERT (a sign-off is immutable AFTER insert,
-- so adding the column + the strict-superset trigger replacements below is
-- compatible with M1's immutability). Deferred no-action FK: an invitation
-- referenced by a sign-off cannot be deleted, and org teardown (both sides in
-- one transaction) still commits.
alter table public.inspection_signoffs
  add column if not exists witness_invitation_id uuid;

do $$
begin
  alter table public.inspection_signoffs
    add constraint isg_witness_invitation_org_fk
    foreign key (witness_invitation_id, org_id)
    references public.inspection_witness_invitations (id, org_id)
    on delete no action deferrable initially deferred;
exception when duplicate_object then null;
end $$;

create index if not exists isg_witness_invitation_idx
  on public.inspection_signoffs (witness_invitation_id)
  where witness_invitation_id is not null;

-- STRICT SUPERSET of the 20261076 body: steps 1–9 are verbatim; step 4b (the
-- witness invitation must belong to the SAME item, and not be cancelled) is
-- the only addition.
create or replace function public.tg_signoff_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_org    uuid;
  v_plan_id     uuid;
  v_item_number int;
  v_plan_org    uuid;
  v_plan_ref    text;
  v_plan_status text;
  v_gate        int;
begin
  -- 1. Resolve the item, and through it the plan. org_id is authoritative from
  --    the parent, so a spoofed org can never cross tenants.
  select i.org_id, i.inspection_test_plan_id, i.item_number
    into v_item_org, v_plan_id, v_item_number
  from public.inspection_plan_items i where i.id = new.inspection_plan_item_id;
  if v_item_org is null then
    raise exception 'inspection item % not found', new.inspection_plan_item_id;
  end if;
  new.org_id := v_item_org;

  select org_id, reference, status into v_plan_org, v_plan_ref, v_plan_status
  from public.inspection_test_plans where id = v_plan_id;

  -- 2. Membership FIRST, so a non-member cannot probe another org's plan
  --    status/reference through the error messages below (the 20261020
  --    cross-tenant-leak-through-errors lesson).
  if not exists (select 1 from public.memberships
                 where org_id = v_item_org and user_id = new.inspected_by) then
    raise exception 'the inspector is not a member of this organisation';
  end if;

  -- 3. Bind the record to the authenticated session: an inspector signs only as
  --    themselves.
  if auth.uid() is not null and new.inspected_by is distinct from auth.uid() then
    raise exception 'an inspector can only sign off as themselves';
  end if;

  -- 4. Only an ISSUED plan can be signed off against.
  if v_plan_status is distinct from 'issued' then
    raise exception 'cannot sign off against a % inspection plan', coalesce(v_plan_status, 'missing');
  end if;

  -- 4b. (M2) The honoured witness invitation, when named, must belong to THIS
  --     item in THIS org and must not have been cancelled. Same-org is already
  --     structural (composite FK); same-ITEM is the semantic bind.
  if new.witness_invitation_id is not null then
    if not exists (
      select 1 from public.inspection_witness_invitations w
      where w.id = new.witness_invitation_id
        and w.inspection_plan_item_id = new.inspection_plan_item_id
        and w.status <> 'cancelled'
    ) then
      raise exception 'the witness invitation does not belong to this inspection item (or was cancelled)';
    end if;
  end if;

  -- 5. Version anchor must match the plan's issued reference.
  if new.plan_version is distinct from v_plan_ref then
    raise exception 'version mismatch: the plan is at % not %', coalesce(v_plan_ref, 'unissued'), new.plan_version;
  end if;

  -- 6. The physical inspection cannot be in the future.
  if new.inspected_at > current_date then
    raise exception 'the inspection date cannot be in the future';
  end if;

  -- 7. Server-pin the record timestamps.
  new.recorded_at := now();
  new.created_at := now();

  -- 8. A sign-off is never born void.
  new.voided_at := null;
  new.voided_by := null;
  new.void_reason := null;

  -- 9. STAMP THE GATE (WARN seam — this never refuses; see 20261076).
  v_gate := public.works_quality_open_hold_point(v_plan_id);
  if v_gate is not null and v_gate < v_item_number then
    new.hold_point_breach := true;
    new.open_hold_item_number := v_gate;
  else
    new.hold_point_breach := false;
    new.open_hold_item_number := null;
  end if;

  return new;
end;
$$;

-- STRICT SUPERSET of the 20261076 body: the frozen tuple gains
-- witness_invitation_id, so the new column is exactly as immutable as every
-- other fact on a recorded sign-off. Nothing else changed.
create or replace function public.tg_signoff_void_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.voided_at is not null then
    raise exception 'a voided sign-off is terminal and cannot be changed';
  end if;

  -- Everything except the void triple is frozen.
  if (new.inspection_plan_item_id, new.org_id, new.plan_version, new.result,
      new.comments, new.inspected_by, new.signed_name, new.inspected_at,
      new.recorded_at, new.witness_name, new.witness_organisation,
      new.witness_invitation_id,
      new.hold_point_breach, new.open_hold_item_number, new.created_at)
     is distinct from
     (old.inspection_plan_item_id, old.org_id, old.plan_version, old.result,
      old.comments, old.inspected_by, old.signed_name, old.inspected_at,
      old.recorded_at, old.witness_name, old.witness_organisation,
      old.witness_invitation_id,
      old.hold_point_breach, old.open_hold_item_number, old.created_at)
  then
    raise exception 'a recorded sign-off is immutable; void it and record a new one';
  end if;

  if new.voided_at is null then
    raise exception 'a recorded sign-off is immutable; void it and record a new one';
  end if;

  -- Pin the void stamp server-side and bind it to the authenticated voider.
  new.voided_at := now();
  if auth.uid() is not null then
    new.voided_by := auth.uid();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. ITP templates — RELATIONAL, versioned, one published per (org, name).
--
-- Items are RELATIONAL (inspection_plan_template_items mirrors the plan item
-- shape exactly) because instantiation must produce REAL inspection_plan_items
-- rows on a DRAFT plan — never a jsonb snapshot a picker has to re-interpret.
-- Versioning follows asset_inspection_templates (20260929) with this domain's
-- natural key: (org_id, name) is the family, and at most one PUBLISHED version
-- per family (partial unique). Published substance is frozen; a change is the
-- NEXT draft version. Instantiation happens in the app on a draft plan only —
-- M1's item-freeze trigger already guarantees items cannot be injected into an
-- issued plan, so no new enforcement surface is needed there.
-- ---------------------------------------------------------------------------
create table if not exists public.inspection_plan_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  name          text not null,
  version       integer not null default 1 check (version >= 1),
  description   text,
  status        text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  created_by    uuid references public.users(id) on delete set null,
  published_by  uuid references public.users(id) on delete set null,
  published_at  timestamptz,
  -- The version this one was drafted from (lineage). Deferred no-action so the
  -- org-teardown cascade, which removes both sides, still commits (20261052).
  supersedes_id uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint ipt_id_org_key unique (id, org_id),
  constraint ipt_org_name_version_key unique (org_id, name, version),
  constraint ipt_name_present check (btrim(name) <> ''),
  constraint ipt_supersedes_org_fk
    foreign key (supersedes_id, org_id)
    references public.inspection_plan_templates (id, org_id)
    on delete no action deferrable initially deferred,
  constraint ipt_no_self_supersede check (supersedes_id is null or supersedes_id <> id),
  constraint ipt_publish_stamped check (status <> 'published' or published_at is not null)
);

-- THE live-version invariant: which checklist is current is a DB fact.
create unique index if not exists ipt_one_published_per_name_idx
  on public.inspection_plan_templates (org_id, name) where status = 'published';

create index if not exists ipt_org_status_idx on public.inspection_plan_templates (org_id, status);
create index if not exists ipt_org_name_idx   on public.inspection_plan_templates (org_id, name, version desc);

drop trigger if exists ipt_set_updated_at on public.inspection_plan_templates;
create trigger ipt_set_updated_at before update on public.inspection_plan_templates
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_ipt_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_count int;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a template version is created as a draft, then published';
    end if;
    new.published_at := null;
    new.published_by := null;
    return new;
  end if;

  -- Substance is frozen once the version has left draft (whether or not this
  -- UPDATE also changes status — the 20261019 P0-2 lesson).
  if old.status <> 'draft' then
    if (new.name, new.description, new.version, new.supersedes_id,
        new.created_by, new.created_at, new.published_at, new.published_by)
       is distinct from
       (old.name, old.description, old.version, old.supersedes_id,
        old.created_by, old.created_at, old.published_at, old.published_by)
    then
      raise exception 'a published template version is immutable; create a new version instead';
    end if;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
       (old.status = 'draft'     and new.status in ('published', 'archived'))
    or (old.status = 'published' and new.status = 'archived')
  ) then
    raise exception 'invalid template transition % -> %', old.status, new.status;
  end if;

  if new.status = 'published' then
    select count(*) into item_count
    from public.inspection_plan_template_items where template_id = new.id;
    if item_count = 0 then
      raise exception 'cannot publish: a template needs at least one inspection item';
    end if;
    new.published_at := now();
    if auth.uid() is not null then
      new.published_by := auth.uid();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tg_ipt_lifecycle on public.inspection_plan_templates;
create trigger tg_ipt_lifecycle
  before insert or update on public.inspection_plan_templates
  for each row execute function public.tg_ipt_lifecycle();

-- A published/archived version has been (or may have been) inspected against:
-- undeletable as a TRIGGER so it binds service_role too. Drafts may be deleted
-- (admin-only by policy); teardown passes through the existence escape.
create or replace function public.tg_ipt_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'draft'
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception 'a % template version is a controlled document and cannot be deleted; archive it instead', old.status;
  end if;
  return old;
end;
$$;

drop trigger if exists tg_ipt_block_delete on public.inspection_plan_templates;
create trigger tg_ipt_block_delete
  before delete on public.inspection_plan_templates
  for each row execute function public.tg_ipt_block_delete();

-- ── Template items: the relational mirror of inspection_plan_items ─────────
create table if not exists public.inspection_plan_template_items (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,   -- trigger-derived from the template
  template_id         uuid not null,
  item_number         integer not null check (item_number >= 1),
  title               text not null,
  acceptance_criteria text not null,
  inspection_method   text,
  specification_ref   text,
  control_point       text not null default 'inspect'
    check (control_point in ('inspect', 'witness', 'approve')),
  is_hold_point       boolean not null default false,
  required            boolean not null default true,
  created_at          timestamptz not null default now(),
  constraint ipti_id_org_key unique (id, org_id),
  constraint ipti_template_org_fk
    foreign key (template_id, org_id)
    references public.inspection_plan_templates (id, org_id) on delete cascade,
  constraint ipti_template_item_number_key unique (template_id, item_number),
  -- Same structural rule as the plan item: an optional hold point is incoherent.
  constraint ipti_hold_point_is_required check (not is_hold_point or required)
);

create index if not exists ipti_template_idx on public.inspection_plan_template_items (template_id, item_number);
create index if not exists ipti_org_idx      on public.inspection_plan_template_items (org_id);

-- Derive org from the template; items are frozen once the version leaves draft
-- (the tg_ipi_derive_org shape, 20261076 §5).
create or replace function public.tg_ipti_derive_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org    uuid;
  parent_status text;
begin
  if tg_op = 'UPDATE' and new.template_id is distinct from old.template_id then
    raise exception 'a template item cannot be moved to another template';
  end if;

  select org_id, status into parent_org, parent_status
  from public.inspection_plan_templates where id = new.template_id;
  if parent_org is null then
    raise exception 'inspection plan template % not found', new.template_id;
  end if;
  new.org_id := parent_org;

  if parent_status <> 'draft' then
    raise exception 'cannot modify the items of a % template version (create a new version instead)', parent_status;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_ipti_derive_org_ins on public.inspection_plan_template_items;
create trigger tg_ipti_derive_org_ins
  before insert on public.inspection_plan_template_items
  for each row execute function public.tg_ipti_derive_org();
drop trigger if exists tg_ipti_derive_org_upd on public.inspection_plan_template_items;
create trigger tg_ipti_derive_org_upd
  before update on public.inspection_plan_template_items
  for each row execute function public.tg_ipti_derive_org();

create or replace function public.tg_ipti_block_delete_when_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_status text;
begin
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return old;  -- org teardown
  end if;
  select status into parent_status
  from public.inspection_plan_templates where id = old.template_id;
  -- null = parent already gone (cascade from a draft delete) → allow.
  if parent_status is not null and parent_status <> 'draft' then
    raise exception 'cannot delete an item from a % template version (the version is frozen)', parent_status;
  end if;
  return old;
end;
$$;

drop trigger if exists tg_ipti_block_delete_when_published on public.inspection_plan_template_items;
create trigger tg_ipti_block_delete_when_published
  before delete on public.inspection_plan_template_items
  for each row execute function public.tg_ipti_block_delete_when_published();

-- ── Atomic publish: archive the (org, name) family's current published
--    version and publish this draft in ONE transaction. SECURITY INVOKER: RLS
--    and every trigger above still apply to the caller; the one-published
--    partial unique backstops a race. (publish_inspection_template, 20260929.)
create or replace function public.publish_inspection_plan_template(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org    uuid;
  v_name   text;
  v_status text;
begin
  select org_id, name, status into v_org, v_name, v_status
  from public.inspection_plan_templates
  where id = p_id
  for update;

  if v_org is null then
    raise exception 'inspection plan template % not found', p_id;
  end if;
  if v_status <> 'draft' then
    raise exception 'only a draft template version can be published (status %)', v_status;
  end if;

  update public.inspection_plan_templates
     set status = 'archived'
   where org_id = v_org and name = v_name and status = 'published';

  -- draft → published fires tg_ipt_lifecycle: item gate + published_at/by pin.
  update public.inspection_plan_templates
     set status = 'published'
   where id = p_id;
end;
$$;
grant execute on function public.publish_inspection_plan_template(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Revision lineage on inspection_test_plans (the RAMS 20261022 shape).
--
--   root_plan_id     the series identity; equals `id` for revision 1, copied
--                    forward onto every later revision (backfilled self-rooted).
--   revision_number  1, 2, 3 … unique within a series.
--
-- The new-draft-from-current flow copies the header AND every item — hold
-- points included — into a draft carrying (root, revision+1). Issue goes
-- through the UNTOUCHED issue_inspection_plan: its natural-key supersede
-- retires the series' current plan and points supersedes_id at it. The
-- one-draft-per-series partial unique means a series can never fork into two
-- concurrent revision drafts; one-issued-per-series backstops the (rare) case
-- where a revision draft's work package was edited away from the original —
-- if that would leave a series with two issued plans, the issue fails loudly
-- (change the work package = start a NEW plan, not a revision).
-- ---------------------------------------------------------------------------
alter table public.inspection_test_plans
  add column if not exists root_plan_id uuid,
  add column if not exists revision_number integer not null default 1
    check (revision_number >= 1);

update public.inspection_test_plans set root_plan_id = id
  where root_plan_id is null;

alter table public.inspection_test_plans alter column root_plan_id set not null;

create unique index if not exists itp_series_revision_idx
  on public.inspection_test_plans (root_plan_id, revision_number);
create unique index if not exists itp_one_draft_per_series_idx
  on public.inspection_test_plans (root_plan_id) where status = 'draft';
create unique index if not exists itp_one_issued_per_series_idx
  on public.inspection_test_plans (root_plan_id) where status = 'issued';
create index if not exists itp_series_idx
  on public.inspection_test_plans (root_plan_id, revision_number desc);

-- Lineage integrity: self-root on insert, same-org same-series validation,
-- and the lineage is immutable from the moment the row exists (it is identity,
-- not substance). Trigger-validated rather than a self-referencing FK — the
-- RAMS 20261022 decision, for the same reasons.
create or replace function public.tg_itp_revision_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Revision 1 self-roots (the client never needs to set this).
    if new.root_plan_id is null then
      new.root_plan_id := new.id;
    end if;
    if new.root_plan_id = new.id then
      if new.revision_number <> 1 then
        raise exception 'a series origin is revision 1';
      end if;
    else
      if new.revision_number < 2 then
        raise exception 'a revision of an existing series is numbered 2 or higher';
      end if;
      -- The root must itself be a SERIES ROOT (self-rooted revision 1), not an
      -- arbitrary mid-series revision. Without the self-root clause a same-org
      -- PostgREST insert could point root_plan_id at revision 2 of a real
      -- series and mint a shadow sub-series that escapes the one-draft /
      -- one-issued partial uniques (adversarial P2). Same-org still required.
      if not exists (select 1 from public.inspection_test_plans
                     where id = new.root_plan_id and org_id = new.org_id
                       and root_plan_id = id and revision_number = 1) then
        raise exception 'revision series root % is not a series origin in this organisation', new.root_plan_id;
      end if;
    end if;
    return new;
  end if;

  -- Lineage is identity: frozen for every status, draft included.
  if new.root_plan_id is distinct from old.root_plan_id
     or new.revision_number is distinct from old.revision_number then
    raise exception 'a plan''s revision lineage is fixed at creation';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_itp_revision_integrity on public.inspection_test_plans;
create trigger tg_itp_revision_integrity
  before insert or update on public.inspection_test_plans
  for each row execute function public.tg_itp_revision_integrity();

-- STRICT SUPERSET of the 20261076 body: the two immutability tuples gain
-- root_plan_id + revision_number (so lineage cannot be rewritten after issue
-- even if the revision-integrity trigger were ever dropped). Every message,
-- gate and transition is otherwise verbatim.
create or replace function public.tg_itp_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_count int;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'an inspection plan is created as a draft, then issued';
    end if;
    return new;
  end if;

  -- Immutability runs whenever the plan has LEFT draft, whether or not this
  -- UPDATE also changes status (the 20261019 P0-2 lesson).
  if old.status <> 'draft' then
    if (new.title, new.work_package, new.location, new.specification_ref, new.job_id,
        new.reference, new.prepared_by, new.plan_date, new.notes,
        new.issued_at, new.issued_by, new.supersedes_id, new.created_by, new.created_at,
        new.root_plan_id, new.revision_number)
       is distinct from
       (old.title, old.work_package, old.location, old.specification_ref, old.job_id,
        old.reference, old.prepared_by, old.plan_date, old.notes,
        old.issued_at, old.issued_by, old.supersedes_id, old.created_by, old.created_at,
        old.root_plan_id, old.revision_number)
    then
      raise exception 'an issued inspection plan is immutable; supersede it with a new plan instead';
    end if;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
       (old.status = 'draft'  and new.status in ('issued', 'withdrawn'))
    or (old.status = 'issued' and new.status in ('superseded', 'withdrawn'))
  ) then
    raise exception 'invalid inspection plan transition % -> %', old.status, new.status;
  end if;

  -- ISSUE GATE (verbatim from 20261076).
  if new.status = 'issued' then
    if new.job_id is null then
      raise exception 'cannot issue: an inspection plan must name the job whose works it governs';
    end if;
    select count(*) into item_count
    from public.inspection_plan_items where inspection_test_plan_id = new.id;
    if item_count = 0 then
      raise exception 'cannot issue: an inspection plan needs at least one inspection item';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. RLS — tenant isolation for the five new tables (mirrors 20261076 §11).
-- ---------------------------------------------------------------------------
alter table public.non_conformance_reports        enable row level security;
alter table public.ncr_corrective_actions         enable row level security;
alter table public.inspection_witness_invitations enable row level security;
alter table public.inspection_plan_templates      enable row level security;
alter table public.inspection_plan_template_items enable row level security;

create policy ncr_select on public.non_conformance_reports
  for select using (org_id in (select public.current_org_ids()));
create policy ncr_insert on public.non_conformance_reports
  for insert with check (org_id in (select public.current_org_ids()));
create policy ncr_update on public.non_conformance_reports
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- No DELETE policy → RLS denies it for authenticated, and the block trigger
-- denies it for the service role too. NCRs are cancelled, never deleted.

create policy nca_select on public.ncr_corrective_actions
  for select using (org_id in (select public.current_org_ids()));
create policy nca_insert on public.ncr_corrective_actions
  for insert with check (org_id in (select public.current_org_ids()));
create policy nca_update on public.ncr_corrective_actions
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- No DELETE policy: proposals are the audit trail.

create policy iwi_select on public.inspection_witness_invitations
  for select using (org_id in (select public.current_org_ids()));
create policy iwi_insert on public.inspection_witness_invitations
  for insert with check (org_id in (select public.current_org_ids()));
create policy iwi_update on public.inspection_witness_invitations
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Delete only while still 'invited' (the trigger enforces the status half for
-- every role, service included).
create policy iwi_delete on public.inspection_witness_invitations
  for delete using (org_id in (select public.current_org_ids()));

create policy ipt_select on public.inspection_plan_templates
  for select using (org_id in (select public.current_org_ids()));
create policy ipt_insert on public.inspection_plan_templates
  for insert with check (org_id in (select public.current_org_ids()));
create policy ipt_update on public.inspection_plan_templates
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Admin-only, drafts only — the trigger re-enforces the draft half for the
-- service role (20261021).
create policy ipt_delete on public.inspection_plan_templates
  for delete using (public.is_org_admin(org_id) and status = 'draft');

create policy ipti_select on public.inspection_plan_template_items
  for select using (org_id in (select public.current_org_ids()));
create policy ipti_insert on public.inspection_plan_template_items
  for insert with check (org_id in (select public.current_org_ids()));
create policy ipti_update on public.inspection_plan_template_items
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy ipti_delete on public.inspection_plan_template_items
  for delete using (org_id in (select public.current_org_ids()));

-- ---------------------------------------------------------------------------
-- 7. NCR evidence rides tenant_attachments (photos of the nonconformity, the
--    rework, the re-test certificate).
--
-- Introspect + rebuild, preserving EVERY prior target. The 18 values below are
-- the set 20261076 re-added (verified in this repo — 20261076 is the LAST
-- migration that widened it); 'non_conformance_reports' is the 19th. The TS
-- list (server/services/tenant-attachments.ts ATTACHMENT_TARGET_TABLES) moves
-- in this same commit; __tests__/security/attachment-target-drift.test.ts
-- pins the two sets equal.
--
-- MERGE NOTE: if another in-flight lane also widens this CHECK, the merge must
-- UNION both value lists (and both TS lists) — taking one side wholesale
-- silently drops the other's target.
-- ---------------------------------------------------------------------------
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'tenant_attachments'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%target_table%';
  if cname is not null then
    execute format('alter table public.tenant_attachments drop constraint %I', cname);
  end if;
end $$;

alter table public.tenant_attachments
  add constraint tenant_attachments_target_table_check
  check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                          'suppliers', 'memberships', 'leads', 'snags',
                          'site_diary_entries', 'toolbox_talks', 'site_reports',
                          'assets', 'asset_assignments', 'asset_inspections',
                          'asset_maintenance_cases', 'asset_fuel_logs',
                          'goods_received_notes', 'inspection_signoffs',
                          'non_conformance_reports'));

-- ---------------------------------------------------------------------------
-- NCR EVIDENCE IS APPEND-ONLY — the missing counterpart to M1's sign-off
-- freeze (20261076 tg_tenant_attachment_freeze_signoff). An NCR and its
-- corrective actions are undeletable quality evidence; the photographs and
-- certificates attached to them must be too, or the record survives while the
-- proof behind it can be quietly removed from a closed, verified NCR. Adding
-- files is always fine (this is a DELETE guard); removing one is refused for
-- every role incl. service_role, for the NCR's whole life. Same escapes as the
-- sign-off trigger: the org-teardown cascade and a vanished NCR both pass.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tenant_attachment_freeze_ncr()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.target_table <> 'non_conformance_reports' then
    return old;
  end if;
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;
  if not exists (select 1 from public.non_conformance_reports where id = old.target_id) then
    return old;
  end if;
  raise exception 'evidence attached to a non-conformance report is frozen — add new files, never remove or replace one';
end $$;

drop trigger if exists tenant_attachments_freeze_ncr on public.tenant_attachments;
create trigger tenant_attachments_freeze_ncr
  before delete on public.tenant_attachments
  for each row execute function public.tg_tenant_attachment_freeze_ncr();
