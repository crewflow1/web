-- Works Quality — Inspection & Test Plan (ITP), Milestone 1.
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
-- CrewFlow already has "inspections": migrations 20260927–20261001 build
-- `asset_inspection*` — the PLANT/EQUIPMENT regime (is this excavator safe to
-- use, has the harness been checked). Routes live at /assets/[id]/inspections.
-- That engine is untouched by this migration and is NOT what a client's QS
-- audits.
--
-- This is the missing WORKS QUALITY regime: proof that the WORKS were built to
-- specification. On a UK job that proof is an ITP — a controlled document,
-- issued before the work starts, listing in order every element to be checked,
-- what "acceptable" means for it, who checks it, and (critically) which of
-- those checks are HOLD POINTS: points past which work must not proceed until
-- the check is signed off. The signed-off ITP is the handover evidence pack.
--
-- Nothing in this migration touches asset inspections, snagging (20260919 —
-- defects FOUND, the inverse question), or site reports.
--
-- ── WHY THESE THREE TABLES ──────────────────────────────────────────────────
--   inspection_test_plans   the controlled document (draft → issued → …)
--   inspection_plan_items   the ordered checks, each typed + hold-point flagged
--   inspection_signoffs     the immutable evidence records against those checks
--
-- Every convention here is LIFTED from the two mature controlled-document
-- verticals rather than invented:
--   · draft → issued → superseded/withdrawn + immutability-on-issue, per-org
--     human reference allocated on issue          (RAMS, 20261018)
--   · child rows frozen once the parent leaves draft; child `org_id` DERIVED
--     from the parent by trigger, never trusted   (RAMS hazards / permit
--                                                  conditions, 20261018/19)
--   · issued documents are NON-DELETABLE via TRIGGER (holds for service_role,
--     unlike an RLS policy) + admin/draft-only delete policy  (20261021)
--   · sign-off evidence is version-anchored to the document's issued reference,
--     bound to the authenticated signer, server-pinned timestamps, append-only
--                                                  (safety_acknowledgements,
--                                                   20261020)
--   · atomic supersede-and-promote in ONE transaction, SECURITY INVOKER so RLS
--     and every trigger still apply to the caller  (issue_rams_revision,
--                                                   20261022)
--   · composite `(id, org_id)` FKs for tenant integrity on every child relation
--                                                  (blueprint_pins / CIS M1)
--   · `no action deferrable initially deferred`, NEVER `restrict`, on any FK
--     that sits on the org-teardown cascade path   (20261059/64, after the
--                                                   20261052 teardown P1)
--
-- Evidence integrity is ALREADY SOLVED platform-wide and is reused, not
-- re-solved: photos/certificates ride `tenant_attachments`, which since
-- 20261031–20261037 carries an org-bound storage path, a SHA-256
-- `content_hash`, and a write-once byte guard for EVERY role including
-- service_role. This migration adds no bucket and no hashing.
--
-- ── NO MONEY ────────────────────────────────────────────────────────────────
-- Quality is not money. This migration writes nothing to `finances`, creates no
-- posting, and references no monetary table. A failed inspection has commercial
-- consequences, but representing them is a commercial-lane decision and
-- inventing a posting here would silently distort every margin on the platform.
-- Asserted in __tests__/security/works-quality.test.ts.
--
-- Additive + reversible. Rollback: drop the three tables, the view, the two
-- functions, `next_itp_number`, the attachment-freeze trigger + function, and
-- re-add the previous `tenant_attachments_target_table_check` (17 values).
-- No existing row in any table is mutated.

-- ---------------------------------------------------------------------------
-- 1. inspection_test_plans — the ITP header (the controlled document)
-- ---------------------------------------------------------------------------
create table if not exists public.inspection_test_plans (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  -- The job whose works this plan governs. An ITP is a per-job document, so a
  -- LIVE plan must name one — enforced by the issue gate, not a CHECK: a CHECK
  -- would abort `delete from jobs` when the set-null below fired (the 20261052
  -- teardown class). Set-null keeps the quality record when the job row goes,
  -- exactly as RAMS keeps the safety record. Same-org integrity is enforced by
  -- trigger (a set-null COMPOSITE fk would null org_id too, which is illegal).
  job_id            uuid references public.jobs(id) on delete set null,
  -- Human reference ITP-NNNN. NULL while draft; allocated per-org on issue.
  reference         text,
  title             text not null,
  -- The scope this plan covers — "Below-ground drainage, Plots 1–4",
  -- "Structural steel erection". With job_id this is the plan's natural key:
  -- one CURRENT plan per work package per job (partial unique index below).
  work_package      text not null,
  location          text,
  -- The specification / drawing revision the works are checked against. A real
  -- ITP is meaningless without it — it is what "acceptable" is measured from.
  specification_ref text,
  -- Who wrote the plan (site/project manager, QA engineer).
  prepared_by       uuid references public.users(id) on delete set null,
  plan_date         date,
  notes             text,
  status            text not null default 'draft'
    check (status in ('draft', 'issued', 'superseded', 'withdrawn')),
  issued_at         timestamptz,
  issued_by         uuid references public.users(id) on delete set null,
  -- The plan this one replaced, set by issue_inspection_plan. Composite so the
  -- lineage can never cross tenants; `no action deferrable initially deferred`
  -- (never restrict) so org teardown, which removes both sides, still commits.
  supersedes_id     uuid,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Candidate key so children can bind tenancy with a composite FK.
  constraint itp_id_org_key unique (id, org_id),
  constraint itp_org_reference_key unique (org_id, reference),
  -- A reference exists iff the document has left draft.
  constraint itp_reference_when_issued
    check ((status = 'draft') = (reference is null)),
  constraint itp_issued_stamp
    check (status = 'draft' or issued_at is not null),
  constraint itp_supersedes_org_fkey
    foreign key (supersedes_id, org_id)
    references public.inspection_test_plans (id, org_id)
    on delete no action deferrable initially deferred,
  constraint itp_no_self_supersede check (supersedes_id is null or supersedes_id <> id)
);

create index if not exists itp_org_idx    on public.inspection_test_plans (org_id);
create index if not exists itp_job_idx    on public.inspection_test_plans (org_id, job_id);
create index if not exists itp_status_idx on public.inspection_test_plans (org_id, status);
create index if not exists itp_supersedes_idx on public.inspection_test_plans (supersedes_id)
  where supersedes_id is not null;

-- THE CURRENT-DOCUMENT INVARIANT. At most ONE issued ITP per (job, work
-- package): two live plans making different claims about the same works is the
-- failure mode this domain exists to prevent, and it is the same load-bearing
-- shape as `risk_assessments_one_current_idx` (one issued per series, 20261022)
-- expressed against this domain's natural key rather than an artificial series
-- id. It is also what makes issue_inspection_plan's supersede step necessary
-- and safe: the index backstops a concurrent double-issue.
-- job_id NULL (job deleted) drops out of the index — a historical plan whose
-- job is gone constrains nothing.
create unique index if not exists itp_one_current_per_package_idx
  on public.inspection_test_plans (org_id, job_id, work_package)
  where status = 'issued';

-- DELIBERATE DIVERGENCE from next_ra_number / next_ptw_number (20261018/19):
-- there is NO standalone ITP-NNNN allocator. Those verticals need one because
-- they have two issue paths (first issue + revision issue) that must agree on
-- the sequence. This domain has exactly ONE issue path — issue_inspection_plan
-- below — so the allocation lives inside it, with the org predicate explicit.
-- That is strictly less surface: no SECURITY DEFINER function reading every
-- org's references (and therefore no membership gate to get wrong), and no
-- second copy of the numbering to drift. `unique (org_id, reference)` backstops
-- the read-max-then-increment race so a collision fails loudly.

-- ---------------------------------------------------------------------------
-- 2. inspection_plan_items — the ordered checks (the heart of an ITP)
-- ---------------------------------------------------------------------------
create table if not exists public.inspection_plan_items (
  id                     uuid primary key default gen_random_uuid(),
  -- Derived from the parent by trigger (any client value is ignored) so a
  -- caller can never anchor an item into another tenant.
  org_id                 uuid not null,
  inspection_test_plan_id uuid not null,
  -- Position in the plan. An ITP is a SEQUENCE — the order is the document, and
  -- it is what "past this point" means for a hold point. Unique per plan.
  item_number            integer not null check (item_number >= 1),
  -- The element/activity checked: "Reinforcement fixed — Plot 1 ground slab".
  title                  text not null,
  -- What PASS means. Without this an "inspection" records an opinion, not a
  -- verification, so it is NOT NULL.
  acceptance_criteria    text not null,
  -- How it is verified: visual, measurement, test certificate, pressure test…
  inspection_method      text,
  -- The spec/drawing clause for THIS check (may be finer than the plan's).
  specification_ref      text,
  -- The control regime for this check:
  --   inspect  our own check, recorded by us
  --   witness  a second party is invited to observe (client, CA, building
  --            control). M1 records that a witness attended by name; INVITING
  --            them through the portal is M2.
  --   approve  a formal acceptance is required before the works are accepted.
  control_point          text not null default 'inspect'
    check (control_point in ('inspect', 'witness', 'approve')),
  -- THE HOLD POINT. Work must not proceed past this check until it is signed
  -- off. Modelled here, in the database, because it is the semantic that makes
  -- an ITP an ITP — not a UI adornment. What it does NOT do is refuse writes:
  -- see the WARN-seam note on tg_signoff_stamp_hold_gate below.
  is_hold_point          boolean not null default false,
  required               boolean not null default true,
  created_at             timestamptz not null default now(),
  -- Candidate key for the sign-off composite FK.
  constraint ipi_id_org_key unique (id, org_id),
  -- Tenant integrity: (parent, org) must match a real parent row in the same
  -- org. Cascade so deleting a draft plan removes its items — and so org
  -- teardown reaches this table.
  constraint ipi_parent_org_fk
    foreign key (inspection_test_plan_id, org_id)
    references public.inspection_test_plans (id, org_id) on delete cascade,
  constraint ipi_plan_item_number_key unique (inspection_test_plan_id, item_number),
  -- An OPTIONAL hold point is incoherent: if the works may proceed without the
  -- check, the check is not a point at which they must stop.
  constraint ipi_hold_point_is_required check (not is_hold_point or required)
);

create index if not exists ipi_parent_idx on public.inspection_plan_items (inspection_test_plan_id, item_number);
create index if not exists ipi_org_idx    on public.inspection_plan_items (org_id);
create index if not exists ipi_hold_idx   on public.inspection_plan_items (inspection_test_plan_id)
  where is_hold_point;

-- ---------------------------------------------------------------------------
-- 3. inspection_signoffs — the evidence records
--
-- One live sign-off per item (partial unique index below). A recorded sign-off
-- is IMMUTABLE: correcting one is a VOID-AND-REDO, never an edit — the same
-- decision the RAMS/permit verticals made for issued documents and
-- acknowledgements, because an editable inspection record is not evidence.
-- ---------------------------------------------------------------------------
create table if not exists public.inspection_signoffs (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null,              -- trigger-derived
  inspection_plan_item_id uuid not null,
  -- Version anchor: the plan's issued reference at the moment of sign-off
  -- (safety_acknowledgements precedent). Superseding the plan leaves this
  -- record historical and untouched.
  plan_version            text not null,
  result                  text not null
    check (result in ('pass', 'fail', 'pass_with_comment')),
  comments                text,
  -- The inspector. `on delete restrict` KEEPS THE EVIDENCE — a user who has
  -- signed off works cannot be hard-deleted out from under the record. This is
  -- the safety_acknowledgements.user_id rule, applied to the same question
  -- ("who attested"), and it is NOT the restrict-on-a-cascade-child the
  -- 20261052 teardown P1 forbids: public.users has no org_id and is never
  -- reached by `delete from organizations`, so this FK is not on the teardown
  -- path. (Org teardown removes the signoff rows via the composite FK below,
  -- long before any user row is considered.)
  inspected_by            uuid not null references public.users(id) on delete restrict,
  -- Typed-name attestation — the durable, human-readable signature. Deliberately
  -- not a drawn-signature image: an authenticated identity bound to a specific
  -- issued version is stronger and privacy-lighter structured evidence.
  signed_name             text not null check (length(trim(signed_name)) > 0),
  -- When the physical inspection happened (may precede the record); bounded to
  -- "not in the future" by trigger, since a CHECK cannot call now().
  inspected_at            date not null default current_date,
  -- When the RECORD was written. Server-pinned by trigger — the single most
  -- load-bearing fact on the row, so the client can never backdate it.
  recorded_at             timestamptz not null default now(),
  -- A third party who attended (client's clerk of works, CA, building control).
  -- Free text in M1: they are not CrewFlow users and inviting them to sign for
  -- themselves is the M2 portal-witness milestone. Recording "who watched" as
  -- text is honest; recording it as THEIR signature would not be.
  witness_name            text,
  witness_organisation    text,
  -- Void-and-redo. Set once, together, and the row is terminal thereafter.
  voided_at               timestamptz,
  voided_by               uuid references public.users(id) on delete set null,
  void_reason             text,
  -- HOLD-POINT GATE STAMP (see tg_signoff_stamp_hold_gate). Computed by the
  -- database at insert and frozen: was an EARLIER hold point still open when
  -- this check was signed off, and if so which one. This is the durable form of
  -- the gate — a fact on the record, not a transient UI warning.
  hold_point_breach       boolean not null default false,
  open_hold_item_number   integer,
  created_at              timestamptz not null default now(),
  -- Tenant integrity + teardown reach.
  constraint isg_item_org_fk
    foreign key (inspection_plan_item_id, org_id)
    references public.inspection_plan_items (id, org_id) on delete cascade,
  -- A non-pass result must say why. An unexplained failure is not evidence.
  constraint isg_comment_required_unless_plain_pass
    check (result = 'pass' or (comments is not null and length(trim(comments)) > 0)),
  -- The void triple is all-or-nothing, and a void must be explained.
  constraint isg_void_triple
    check (
      (voided_at is null and voided_by is null and void_reason is null)
      or (voided_at is not null and voided_by is not null
          and void_reason is not null and length(trim(void_reason)) > 0)
    ),
  -- The stamp is self-consistent: a breach names the open hold point.
  constraint isg_breach_names_item
    check (hold_point_breach = (open_hold_item_number is not null))
);

create index if not exists isg_item_idx on public.inspection_signoffs (inspection_plan_item_id);
create index if not exists isg_org_idx  on public.inspection_signoffs (org_id);
create index if not exists isg_breach_idx on public.inspection_signoffs (org_id)
  where hold_point_breach and voided_at is null;

-- ONE LIVE SIGN-OFF PER ITEM. Voided rows stay for the audit trail, so the
-- index is partial. This is what makes "signed off" a single, unambiguous fact
-- per check (the one-issued-per-series idiom, applied per item).
create unique index if not exists isg_one_live_per_item_idx
  on public.inspection_signoffs (inspection_plan_item_id) where voided_at is null;

-- ---------------------------------------------------------------------------
-- 4. THE HOLD-POINT GATE — one authority, in the database
--
-- Returns the item_number of the LOWEST hold point in the plan that is still
-- open, or NULL when none is. A hold point is RELEASED only by a live
-- (non-void) sign-off whose result is pass or pass_with_comment — a `fail`
-- leaves it open, which is construction-correct: a failed check means rework
-- and re-inspection, not permission to proceed.
--
-- SECURITY INVOKER on purpose, and it behaves correctly in both contexts:
--   · called by the app (role `authenticated`) → RLS applies, so a caller can
--     only compute the gate for a plan they are entitled to see;
--   · called from the SECURITY DEFINER stamp trigger below → runs with the
--     definer's privileges and therefore sees every row in the plan, which is
--     exactly what an AUTHORITATIVE stamp requires.
-- One body, so the read-side answer and the stamped answer can never drift.
-- ---------------------------------------------------------------------------
create or replace function public.works_quality_open_hold_point(p_plan_id uuid)
returns integer
language sql
security invoker
stable
set search_path = public
as $$
  select min(i.item_number)
  from public.inspection_plan_items i
  where i.inspection_test_plan_id = p_plan_id
    and i.is_hold_point
    and not exists (
      select 1 from public.inspection_signoffs s
      where s.inspection_plan_item_id = i.id
        and s.voided_at is null
        and s.result in ('pass', 'pass_with_comment')
    );
$$;
grant execute on function public.works_quality_open_hold_point(uuid) to authenticated;

-- Register read-model. ONE security_invoker view so every register surface
-- (global, per-job, the job hub tile) asks the SAME question of the SAME
-- authority — there is no second implementation of the gate to drift from.
-- security_invoker = true: the view inherits the CALLER's RLS, it does not
-- launder it (the 20260818 doctrine).
-- `passed` is the one definition of "this check is done": a LIVE sign-off whose
-- result accepts the works. A live `fail` is therefore still OUTSTANDING, which
-- is the whole point — a failed check that read as "signed off" would be the
-- control-failing-open false negative this domain must never produce.
create or replace view public.works_quality_plan_status
  with (security_invoker = true) as
select
  p.id      as plan_id,
  p.org_id,
  p.job_id,
  p.status,
  count(i.id)::int                                       as total_items,
  count(i.id) filter (where i.is_hold_point)::int        as hold_point_items,
  count(sl.id)::int                                      as signed_off_items,
  count(i.id) filter (where i.required and not coalesce(sl.passed, false))::int
                                                         as outstanding_required_items,
  count(i.id) filter (where i.is_hold_point and not coalesce(sl.passed, false))::int
                                                         as open_hold_points,
  count(sl.id) filter (where sl.result = 'fail')::int     as failed_items,
  count(sl.id) filter (where sl.hold_point_breach)::int   as hold_point_breaches,
  public.works_quality_open_hold_point(p.id)             as open_hold_item_number
from public.inspection_test_plans p
left join public.inspection_plan_items i on i.inspection_test_plan_id = p.id
-- At most one live sign-off per item (isg_one_live_per_item_idx), so this join
-- can never multiply a row and inflate a count.
left join (
  select s.id, s.inspection_plan_item_id, s.result, s.hold_point_breach,
         (s.result in ('pass', 'pass_with_comment')) as passed
  from public.inspection_signoffs s
  where s.voided_at is null
) sl on sl.inspection_plan_item_id = i.id
group by p.id, p.org_id, p.job_id, p.status;

grant select on public.works_quality_plan_status to authenticated;

comment on view public.works_quality_plan_status is
  'Works-quality ITP register read-model (M1). security_invoker: inherits the '
  'caller''s RLS. open_hold_points / open_hold_item_number are the DB-authoritative '
  'hold-point gate — WARN-only, never a work block.';

-- ---------------------------------------------------------------------------
-- 5. Trigger: derive an item's org_id from its parent; items are frozen once
--    the plan leaves draft (the permit_conditions rule, 20261019).
-- ---------------------------------------------------------------------------
create or replace function public.tg_ipi_derive_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org    uuid;
  parent_status text;
begin
  -- Reparenting is forbidden: moving an item to another plan would strip the
  -- evidence trail off an issued document.
  if tg_op = 'UPDATE' and new.inspection_test_plan_id is distinct from old.inspection_test_plan_id then
    raise exception 'an inspection item cannot be moved to another plan';
  end if;

  select org_id, status into parent_org, parent_status
  from public.inspection_test_plans where id = new.inspection_test_plan_id;
  if parent_org is null then
    raise exception 'inspection test plan % not found', new.inspection_test_plan_id;
  end if;
  new.org_id := parent_org;

  if parent_status <> 'draft' then
    raise exception 'cannot modify the items of a % inspection plan (an issued plan is frozen; supersede it instead)', parent_status;
  end if;
  return new;
end;
$$;

create trigger tg_ipi_derive_org_ins
  before insert on public.inspection_plan_items
  for each row execute function public.tg_ipi_derive_org();
create trigger tg_ipi_derive_org_upd
  before update on public.inspection_plan_items
  for each row execute function public.tg_ipi_derive_org();

-- Deleting an item off a non-draft plan would erase part of the document (and
-- with it, via cascade, its sign-offs). Blocked — with the org-teardown escape
-- the whole codebase uses: under `delete from organizations` the org row is
-- already gone when this fires, so the cascade is allowed through.
create or replace function public.tg_ipi_block_delete_when_issued()
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
  from public.inspection_test_plans where id = old.inspection_test_plan_id;
  -- parent_status null = parent already gone (cascade from a draft delete) → allow.
  if parent_status is not null and parent_status <> 'draft' then
    raise exception 'cannot delete an item from a % inspection plan (the document is frozen)', parent_status;
  end if;
  return old;
end;
$$;

create trigger tg_ipi_block_delete_when_issued
  before delete on public.inspection_plan_items
  for each row execute function public.tg_ipi_block_delete_when_issued();

-- ---------------------------------------------------------------------------
-- 6. Trigger: same-org integrity for the plan's job link.
-- ---------------------------------------------------------------------------
create or replace function public.tg_itp_validate_job_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  job_org uuid;
begin
  if new.job_id is not null then
    select org_id into job_org from public.jobs where id = new.job_id;
    if job_org is null or job_org <> new.org_id then
      raise exception 'job % does not belong to this organisation', new.job_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger tg_itp_validate_job_org
  before insert or update on public.inspection_test_plans
  for each row execute function public.tg_itp_validate_job_org();

-- ---------------------------------------------------------------------------
-- 7. Trigger: lifecycle + issue gate + immutability-on-issue.
--
--   draft                -> may edit anything, or move to issued
--   issued               -> only status may move, and only to superseded/withdrawn
--   superseded/withdrawn -> terminal
--
-- A plan is ALWAYS born a draft, so a direct INSERT can never mint an
-- already-issued plan and skip the gate (the 20261019 P0-1 lesson).
-- ---------------------------------------------------------------------------
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
  -- UPDATE also changes status — so an edit can never ride in on a transition
  -- (the 20261019 P0-2 lesson).
  if old.status <> 'draft' then
    if (new.title, new.work_package, new.location, new.specification_ref, new.job_id,
        new.reference, new.prepared_by, new.plan_date, new.notes,
        new.issued_at, new.issued_by, new.supersedes_id, new.created_by, new.created_at)
       is distinct from
       (old.title, old.work_package, old.location, old.specification_ref, old.job_id,
        old.reference, old.prepared_by, old.plan_date, old.notes,
        old.issued_at, old.issued_by, old.supersedes_id, old.created_by, old.created_at)
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

  -- ISSUE GATE. A plan is only issuable when it is a usable quality document:
  -- it names its job, and it has at least one check. A plan with hold points
  -- must also be ordered coherently — guaranteed structurally by the unique
  -- (plan, item_number).
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

create trigger tg_itp_lifecycle
  before insert or update on public.inspection_test_plans
  for each row execute function public.tg_itp_lifecycle();

create trigger itp_set_updated_at
  before update on public.inspection_test_plans
  for each row execute function public.tg_set_updated_at();

-- An issued/superseded/withdrawn plan is evidence and cannot be hard-deleted —
-- as a TRIGGER, so it binds the service role too (an RLS delete policy does
-- not). Org teardown is allowed through by the existence escape (20261021).
create or replace function public.tg_itp_block_delete_when_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'draft'
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'an issued inspection plan is quality evidence and cannot be deleted; withdraw it instead';
  end if;
  return old;
end;
$$;

create trigger tg_itp_block_delete_when_issued
  before delete on public.inspection_test_plans
  for each row execute function public.tg_itp_block_delete_when_issued();

-- ---------------------------------------------------------------------------
-- 8. Trigger: sign-off validation + the HOLD-POINT GATE STAMP.
--
-- ══ THE GATE IS A WARN SEAM, NOT A WORK BLOCK ══════════════════════════════
-- This trigger DOES NOT REFUSE a sign-off recorded past an open hold point.
-- That is a deliberate product decision, and it follows the H&S epic exactly:
-- 20260928 shipped its asset safety-block as a hard refusal because the subject
-- was a PIECE OF PLANT the platform controls custody of, while the H&S epic's
-- "job in progress with no current RAMS" signal shipped as a WARN because
-- blocking real site work on software state is a decision the business makes,
-- not a trigger. A works quality hold point is in the second category: the
-- concrete pour either happened or it did not, and refusing to RECORD an
-- out-of-sequence inspection would not stop it — it would only destroy the
-- evidence that it happened out of sequence, which is the single most
-- audit-relevant fact on the row.
--
-- So the gate is captured instead: `hold_point_breach` + `open_hold_item_number`
-- are stamped by the database, frozen, and surfaced loudly in the register, on
-- the job hub and on the plan itself. Nothing is silently blocked, and nothing
-- is silently lost.
-- ---------------------------------------------------------------------------
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
  --    themselves. Recording a colleague's signature is forgery, and the whole
  --    value of the record is that it is personal. auth.uid() is null on a
  --    service path (fixtures/teardown); the app never writes sign-offs with the
  --    service key, and the RLS insert policy also pins inspected_by = auth.uid().
  if auth.uid() is not null and new.inspected_by is distinct from auth.uid() then
    raise exception 'an inspector can only sign off as themselves';
  end if;

  -- 4. Only an ISSUED plan can be signed off against. A draft is not a
  --    controlled document, and a superseded/withdrawn one is history.
  if v_plan_status is distinct from 'issued' then
    raise exception 'cannot sign off against a % inspection plan', coalesce(v_plan_status, 'missing');
  end if;

  -- 5. Version anchor must match the plan's issued reference.
  if new.plan_version is distinct from v_plan_ref then
    raise exception 'version mismatch: the plan is at % not %', coalesce(v_plan_ref, 'unissued'), new.plan_version;
  end if;

  -- 6. The physical inspection cannot be in the future (a CHECK cannot call
  --    now(); this can).
  if new.inspected_at > current_date then
    raise exception 'the inspection date cannot be in the future';
  end if;

  -- 7. Server-pin the record timestamps — the client can never backdate them.
  new.recorded_at := now();
  new.created_at := now();

  -- 8. A sign-off is never born void.
  new.voided_at := null;
  new.voided_by := null;
  new.void_reason := null;

  -- 9. STAMP THE GATE (see the WARN-seam note above — this never refuses).
  --    Computed BEFORE this row exists, so a hold point can never release
  --    itself. A breach means an EARLIER hold point was still open; signing off
  --    the open hold point itself is exactly how it gets released, and is not a
  --    breach.
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

create trigger tg_signoff_validate
  before insert on public.inspection_signoffs
  for each row execute function public.tg_signoff_validate();

-- A recorded sign-off is immutable. The ONLY permitted UPDATE is the one-way
-- void transition (void-and-redo instead of edit); a voided row is terminal.
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
      new.hold_point_breach, new.open_hold_item_number, new.created_at)
     is distinct from
     (old.inspection_plan_item_id, old.org_id, old.plan_version, old.result,
      old.comments, old.inspected_by, old.signed_name, old.inspected_at,
      old.recorded_at, old.witness_name, old.witness_organisation,
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

create trigger tg_signoff_void_only
  before update on public.inspection_signoffs
  for each row execute function public.tg_signoff_void_only();

-- A sign-off is never hard-deleted: voiding is the audited way to retract one,
-- and the voided row stays. Trigger, so it binds service_role too. Org teardown
-- passes through via the existence escape.
create or replace function public.tg_signoff_block_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'an inspection sign-off is quality evidence and cannot be deleted; void it instead';
  end if;
  return old;
end;
$$;

create trigger tg_signoff_block_delete
  before delete on public.inspection_signoffs
  for each row execute function public.tg_signoff_block_delete();

-- ---------------------------------------------------------------------------
-- 9. Sign-off evidence rides tenant_attachments (photos, test certificates).
--
-- Introspect + rebuild, preserving EVERY prior target. The 17 values below were
-- read back from the LIVE applied constraint (pg_get_constraintdef on the
-- 20261060 schema), never reconstructed from memory — the introspection DROPS
-- whatever is there, so an under-stated list would silently REVOKE attachment
-- support for a whole domain. 20261060000000 is the last migration that widened
-- it; 'inspection_signoffs' is the 18th.
--
-- MERGE NOTE: nine other lanes are in flight. If any of them also widens this
-- CHECK, the merge must UNION both lists (and both TS lists) — taking one side
-- wholesale silently drops the other's target. __tests__/security/
-- attachment-target-drift.test.ts turns a mismatch between the last re-add and
-- ATTACHMENT_TARGET_TABLES into a red build, which is the tripwire for exactly
-- that mistake.
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
                          'goods_received_notes', 'inspection_signoffs'));

-- Evidence attached to a sign-off is APPEND-ONLY from the moment the sign-off
-- exists — the record itself is immutable, so its evidence must be too. New
-- files can still be added (upload the test certificate that arrived the next
-- day); nothing already attached can be removed or repointed. Mirrors
-- tg_tenant_attachment_freeze_delivered_toolbox (20261028) as a SEPARATE
-- trigger, leaving that one untouched. The byte-level guard
-- (tg_tenant_attachment_evidence_immutable, 20261033) already makes
-- storage_path/size/mime write-once for every role; this closes DELETE.
create or replace function public.tg_tenant_attachment_freeze_signoff()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.target_table <> 'inspection_signoffs' then
    return old;
  end if;
  -- Allow the org-teardown cascade (the org row is already gone by then).
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;
  -- A sign-off that no longer exists cannot be protected; anything else is frozen.
  if not exists (select 1 from public.inspection_signoffs where id = old.target_id) then
    return old;
  end if;
  raise exception 'evidence attached to an inspection sign-off is frozen — add new files, never remove or replace one';
end $$;

drop trigger if exists tenant_attachments_freeze_signoff on public.tenant_attachments;
create trigger tenant_attachments_freeze_signoff
  before delete on public.tenant_attachments
  for each row execute function public.tg_tenant_attachment_freeze_signoff();

-- ---------------------------------------------------------------------------
-- 10. Atomic issue: supersede the current plan for this work package and
--     promote this draft in ONE transaction, so there is never a window with
--     two current plans (or an old one retired but the new issue failing).
--
--     SECURITY INVOKER: RLS and every trigger above still apply to the caller;
--     itp_one_current_per_package_idx backstops a race.
--     Mirrors issue_rams_revision (20261022).
-- ---------------------------------------------------------------------------
create or replace function public.issue_inspection_plan(p_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org      uuid;
  v_job      uuid;
  v_package  text;
  v_status   text;
  v_prior    uuid;
  v_ref      text;
begin
  select org_id, job_id, work_package, status
    into v_org, v_job, v_package, v_status
  from public.inspection_test_plans
  where id = p_id
  for update;

  if v_org is null then
    raise exception 'inspection plan % not found', p_id;
  end if;
  if v_status <> 'draft' then
    raise exception 'only a draft inspection plan can be issued (status %)', v_status;
  end if;
  if v_job is null then
    raise exception 'cannot issue: an inspection plan must name the job whose works it governs';
  end if;

  -- The plan this one replaces, if the work package already has a current one.
  select id into v_prior
  from public.inspection_test_plans
  where org_id = v_org and job_id = v_job and work_package = v_package
    and status = 'issued'
  for update;

  -- Allocate ITP-NNNN. SECURITY INVOKER means this read is RLS-scoped to the
  -- caller AND carries an explicit org predicate, so it can neither see nor
  -- count another tenant's plans — which is why no separate membership gate (and
  -- no SECURITY DEFINER allocator) is needed here.
  select 'ITP-' || lpad(
           (coalesce(max(cast(substring(reference from 'ITP-(\d+)') as int)), 0) + 1)::text,
           4, '0')
    into v_ref
  from public.inspection_test_plans
  where org_id = v_org and reference is not null;

  if v_prior is not null then
    update public.inspection_test_plans set status = 'superseded' where id = v_prior;
  end if;

  update public.inspection_test_plans
     set status = 'issued', reference = v_ref,
         issued_at = now(), issued_by = auth.uid(),
         supersedes_id = v_prior
   where id = p_id;

  return v_ref;
end;
$$;
grant execute on function public.issue_inspection_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. RLS — tenant isolation (mirrors RAMS / permits / snags exactly)
-- ---------------------------------------------------------------------------
alter table public.inspection_test_plans  enable row level security;
alter table public.inspection_plan_items  enable row level security;
alter table public.inspection_signoffs    enable row level security;

create policy itp_select on public.inspection_test_plans
  for select using (org_id in (select public.current_org_ids()));
create policy itp_insert on public.inspection_test_plans
  for insert with check (org_id in (select public.current_org_ids()));
create policy itp_update on public.inspection_test_plans
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Admin-only, drafts only — and the trigger re-enforces the draft half for the
-- service role, which an RLS policy cannot reach (20261021).
create policy itp_delete on public.inspection_test_plans
  for delete using (public.is_org_admin(org_id) and status = 'draft');

create policy ipi_select on public.inspection_plan_items
  for select using (org_id in (select public.current_org_ids()));
create policy ipi_insert on public.inspection_plan_items
  for insert with check (org_id in (select public.current_org_ids()));
create policy ipi_update on public.inspection_plan_items
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy ipi_delete on public.inspection_plan_items
  for delete using (org_id in (select public.current_org_ids()));

create policy isg_select on public.inspection_signoffs
  for select using (org_id in (select public.current_org_ids()));
-- A member may only record a sign-off AS THEMSELVES, in their own org.
create policy isg_insert on public.inspection_signoffs
  for insert with check (
    org_id in (select public.current_org_ids()) and inspected_by = auth.uid()
  );
-- UPDATE exists only so a member can VOID; the trigger above restricts what an
-- update may change to the void triple and nothing else.
create policy isg_update on public.inspection_signoffs
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- No DELETE policy → RLS denies it for authenticated, and the block trigger
-- denies it for the service role too. Sign-offs are voided, never deleted.
