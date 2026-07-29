-- M4 — Material requests (the site→office ask, part 1: the RECORD).
--
-- The gap: a worker on site who needs 20 bags of cement has no route into the
-- system. Today that ask happens on WhatsApp, and the office turns it into a
-- purchase order — or forgets to. Nothing links "what site asked for" to "what
-- was ordered" or "what was issued from stock", so nobody can answer "is that
-- request actually satisfied?" without ringing the site.
--
-- This migration makes the ask a FIRST-CLASS RECORD:
--
--   material_requests       — one ask, with a lifecycle and a decision
--   material_request_lines  — what was asked for, per material
--
-- Part 2 (20261067) adds the transition graph and derives FULFILMENT from the
-- stock lane. This migration deliberately contains no fulfilment concept at
-- all: it is the record and its authorisation surface, nothing more.
--
-- SCHEMA DECISIONS AND THEIR EVIDENCE
--
-- 1. FREE TEXT IS A FIRST-CLASS PATH, NOT A FALLBACK. `description` is NOT
--    NULL and `stock_item_id` is NULLABLE. A one-off material ("the odd-size
--    lintel the architect specified on Tuesday") must not force somebody to
--    create a catalogue item before they can ask for it. Follows the
--    goods_received_notes.delivery_location precedent (20261059 note 4): model
--    the thing people actually do, don't make them do paperwork first.
--
-- 2. stock_item_id IS A PLAIN uuid WITH NO FOREIGN KEY. This is a FROZEN
--    CROSS-LANE CONTRACT, not an oversight. The operational-stock lane
--    (stock_items / stock_movements / record_stock_issue) is being built
--    concurrently and does not exist on this branch; a FK to a table that is
--    not there cannot be created, and a migration that depends on another
--    lane's slot landing first is a merge-order landmine. The mirror image
--    holds on their side: stock_movements.material_request_line_id is likewise
--    a plain uuid with no FK to this table.
--    DEFERRED DEBT, STATED PLAINLY: two uuid columns point at each other with
--    no referential integrity in either direction. Org integrity across that
--    seam is enforced in the APP layer (the service validates that a
--    stock_item_id belongs to the active org before writing it, and only when
--    the stock module is present). The unique (id, org_id) candidate key below
--    is added NOW precisely so the eventual composite, org-binding FK can be
--    added by a later migration without touching this table's shape.
--
-- 3. job_id IS NULLABLE, ON DELETE SET NULL, WITH A GUARD TRIGGER — the exact
--    idiom every sibling job-scoped record uses (snags 20260919, site_diary
--    20260920, risk_assessments 20261018) and the one 20261024 argues for
--    explicitly: a composite FK cannot express ON DELETE SET NULL while org_id
--    is NOT NULL, so a composite FK here would force ON DELETE CASCADE and
--    silently destroy the request history when a job is removed. Nullable also
--    happens to be honest: a request for the yard or the van is a real thing.
--
-- 4. rejection_reason IS STRUCTURALLY REQUIRED, not merely validated in the
--    form — the goods_received_notes void_reason precedent (20261059). A
--    rejection with no reason is the single most useless row this table could
--    hold: the requester learns nothing and re-submits the same ask.
--
-- 5. AUTHORISATION LIVES IN THE DATABASE, not only in the server action. RLS
--    admits members to update; the lifecycle trigger (here) and the transition
--    trigger (20261067) decide WHO may make WHICH move. RLS alone cannot
--    express it — a policy sees either OLD or NEW, never both, so
--    "a member may submit their own draft but only an admin may approve it" is
--    not a policy-shaped rule. Doing it in the app only would leave direct
--    PostgREST (/rest/v1/material_requests?id=eq.X with {"status":"approved"})
--    wide open to any member holding a JWT — the same gap 20261060 closed for
--    purchase orders and 20261034 for RAMS.
--
-- 6. PRIORITY IS TWO VALUES, DRAWN FROM THE HOUSE VOCABULARY. The product
--    decision is binary — "does this stop the job or not?" — because a worker
--    choosing between four priorities on a phone chooses badly, and a four-way
--    scale is how everything ends up "high". But the two values are 'normal'
--    and 'urgent', both members of the dominant house set
--    ('low','normal','high','urgent': support_os 20260610, internal_notes
--    20260612, hq_sales 20260716, hq_ai_tasks 20260802), so widening to the
--    full four later is a pure CHECK widening with NO value remapping and no
--    data migration. Deliberately NOT snags' ('low','medium','high') — that
--    set has no 'urgent', which is the only value this table really needs.
--
-- Additive and reversible: two new tables, one new function, three triggers.

-- ── 1. Per-org request number allocator (mirrors next_po_number, 20261006) ──
-- The unique (org_id, number) constraint below — NOT this function — is the
-- real guard: a race yields a unique violation the caller retries, never a
-- duplicate request number. Same contract as next_grn_number (20261059).
create or replace function public.next_material_request_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  select coalesce(max(cast(substring(number from 'MR-(\d+)') as int)), 0) + 1
  into next_num
  from public.material_requests
  where org_id = target_org
    and number ~ '^MR-\d+$';
  return 'MR-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_material_request_number(uuid) to authenticated;

-- ── 2. material_requests ───────────────────────────────────────────────────
create table if not exists public.material_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  -- nullable + SET NULL + guard trigger — see header note 3.
  job_id           uuid references public.jobs(id) on delete set null,
  number           text not null,
  status           text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved',
                      'partially_fulfilled', 'fulfilled', 'rejected', 'cancelled')),
  -- WHO is asking. Distinct from created_by: an office hand may raise a
  -- request on behalf of a site worker who phoned it in, and the queue's
  -- "requester" filter must mean the person who needs the materials.
  requested_by     uuid references public.users(id) on delete set null,
  needed_by        date,
  priority         text not null default 'normal'
    check (priority in ('normal', 'urgent')),          -- header note 6
  notes            text,
  submitted_at     timestamp with time zone,
  decided_by       uuid references public.users(id) on delete set null,
  decided_at       timestamp with time zone,
  rejection_reason text,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamp with time zone not null default now(),
  updated_at       timestamp with time zone not null default now(),
  constraint material_requests_org_number_key unique (org_id, number),
  -- child composite-FK target, AND the candidate key the deferred stock FK
  -- will eventually need (header note 2).
  constraint material_requests_id_org_key unique (id, org_id),
  -- header note 4: a rejection without a reason is refused by the database.
  constraint material_requests_rejection_reason_required
    check (status <> 'rejected' or (rejection_reason is not null
                                    and btrim(rejection_reason) <> '')),
  -- a decision must carry its provenance (mirrors the GRN posted-provenance
  -- CHECK). decided_by may be null if the deciding user is later deleted
  -- (ON DELETE SET NULL), so only the timestamp is structurally required.
  constraint material_requests_decision_provenance
    check (status not in ('approved', 'rejected') or decided_at is not null)
);

create index if not exists material_requests_org_idx
  on public.material_requests (org_id, created_at desc);
-- the office queue's hot path: "what is waiting on me, soonest need first".
create index if not exists material_requests_org_status_idx
  on public.material_requests (org_id, status, needed_by);
create index if not exists material_requests_job_idx
  on public.material_requests (job_id) where job_id is not null;
create index if not exists material_requests_requester_idx
  on public.material_requests (org_id, requested_by);

drop trigger if exists material_requests_set_updated_at on public.material_requests;
create trigger material_requests_set_updated_at before update on public.material_requests
  for each row execute function public.tg_set_updated_at();

-- ── 3. material_request_lines ──────────────────────────────────────────────
create table if not exists public.material_request_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  material_request_id uuid not null,
  -- header note 1: free text is the PRIMARY path, not a degraded one.
  description         text not null,
  -- numeric(12,2) matches purchase_order_line_items.qty and
  -- goods_received_lines.qty_received exactly, so a decimal unit (12.5 m³ of
  -- concrete) crosses request → PO → receipt → issue without a rounding fork.
  qty                 numeric(12, 2) not null check (qty > 0),
  unit                text,
  -- PLAIN uuid, NO FK — the frozen cross-lane contract (header note 2).
  stock_item_id       uuid,
  sort_order          integer not null default 0,
  created_at          timestamp with time zone not null default now(),
  constraint material_request_lines_description_present
    check (btrim(description) <> ''),
  constraint material_request_lines_request_org_fkey
    foreign key (material_request_id, org_id)
    references public.material_requests (id, org_id) on delete cascade,
  -- the candidate key the stock lane's deferred FK will target (header note 2).
  constraint material_request_lines_id_org_key unique (id, org_id)
);

create index if not exists material_request_lines_request_idx
  on public.material_request_lines (material_request_id, sort_order);
create index if not exists material_request_lines_org_idx
  on public.material_request_lines (org_id);
create index if not exists material_request_lines_stock_item_idx
  on public.material_request_lines (stock_item_id) where stock_item_id is not null;

-- ── 4. job_id must belong to the SAME org (header note 3) ───────────────────
-- Mirrors tg_ra_validate_job_org (20261018) and
-- tg_completion_certificate_org_integrity (20261024). Without it, RLS checks
-- only the row's own org_id and a member of org A could POST a request
-- referencing org B's job — a cross-tenant WRITE, and a job-name leak once the
-- office queue renders the job it points at.
create or replace function public.tg_material_request_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select org_id into v_org from public.jobs where id = new.job_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'material request: job % is not in this org', new.job_id
        using errcode = 'check_violation';
    end if;
  end if;
  -- requested_by must be a member of THIS org — mirrors the GRN received_by
  -- guard (20261059) and the asset_assignments assignee guard (20260925). A
  -- requester from another tenant would put a foreign name on this org's queue.
  if new.requested_by is not null
     and not exists (select 1 from public.memberships
                      where user_id = new.requested_by and org_id = new.org_id) then
    raise exception 'material request: % is not a member of this org', new.requested_by
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists material_requests_org_integrity on public.material_requests;
create trigger material_requests_org_integrity
  before insert or update on public.material_requests
  for each row execute function public.tg_material_request_org_integrity();

-- ── 5. Lifecycle: born draft, provenance pinned, decided record frozen ──────
-- Shape borrowed from tg_goods_received_note_lifecycle (20261059) and
-- tg_ra_lifecycle (20261034). The GRAPH itself lives in 20261067; this trigger
-- owns birth, provenance and immutability — the things that must be true
-- regardless of which edge is being walked.
--
-- Born-draft is UNCONDITIONAL, so there is exactly one way a request can reach
-- 'approved' and that way runs the transition trigger.
create or replace function public.tg_material_request_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a material request is created as a draft, then submitted'
        using errcode = 'check_violation';
    end if;
    if new.submitted_at is not null or new.decided_at is not null
       or new.decided_by is not null or new.rejection_reason is not null then
      raise exception 'a new material request cannot carry submission or decision provenance'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ── UPDATE ───────────────────────────────────────────────────────────────
  -- PIN provenance server-side so a submission or a decision can be neither
  -- forged nor back-dated. JWT-gated, so the trusted service role may still
  -- seed historical data — the deliberate 20261034 asymmetry.
  if old.status = 'draft' and new.status = 'submitted' then
    if auth.uid() is not null then
      new.submitted_at := now();
    else
      new.submitted_at := coalesce(new.submitted_at, now());
    end if;
  end if;

  if old.status = 'submitted' and new.status in ('approved', 'rejected') then
    if auth.uid() is not null then
      new.decided_by := auth.uid();
      new.decided_at := now();
    else
      new.decided_at := coalesce(new.decided_at, now());
    end if;
  end if;

  -- A rejection reason belongs to the rejection. Setting one on any other
  -- status is either a mistake or an attempt to pre-load the field.
  if new.status <> 'rejected' and new.rejection_reason is distinct from old.rejection_reason
     and new.rejection_reason is not null then
    raise exception 'a rejection reason belongs to a rejected request (MR %)', old.id
      using errcode = 'check_violation';
  end if;

  -- ONCE SUBMITTED, THE ASK IS FROZEN. What was requested is the whole point of
  -- the record: an approver approves a specific quantity of a specific
  -- material, and a request whose contents can drift after approval approves
  -- nothing. Correction = cancel and raise a new one. (Same argument as the
  -- posted-GRN freeze, 20261059 note 5.)
  if old.status <> 'draft' then
    if new.job_id is distinct from old.job_id
       or new.number is distinct from old.number
       or new.requested_by is distinct from old.requested_by
       or new.needed_by is distinct from old.needed_by
       or new.priority is distinct from old.priority
       or new.notes is distinct from old.notes
       or new.submitted_at is distinct from old.submitted_at then
      raise exception 'a submitted material request is frozen — cancel it and raise a new one (MR %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- The decision record itself is write-once.
  if old.status in ('approved', 'rejected')
     and (new.decided_by is distinct from old.decided_by
          or new.decided_at is distinct from old.decided_at) then
    raise exception 'the decision on MR % is immutable', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists material_requests_lifecycle on public.material_requests;
create trigger material_requests_lifecycle
  before insert or update on public.material_requests
  for each row execute function public.tg_material_request_lifecycle();

-- ── 6. Lines are only writable while the request is a DRAFT ────────────────
-- The requested quantities ARE the ask; freezing the header but leaving its
-- lines editable would let an approved request quietly become a different one.
-- Mirrors tg_goods_received_line_draft_only (20261059).
create or replace function public.tg_material_request_line_draft_only()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_req    uuid;
begin
  v_req := coalesce(new.material_request_id, old.material_request_id);
  select status into v_status from public.material_requests where id = v_req;
  if v_status is null then
    -- parent already gone (cascade) — nothing to protect.
    return coalesce(new, old);
  end if;
  if v_status <> 'draft' then
    raise exception 'material request % is % — its lines are frozen', v_req, v_status
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists material_request_lines_draft_only on public.material_request_lines;
create trigger material_request_lines_draft_only
  before insert or update or delete on public.material_request_lines
  for each row execute function public.tg_material_request_line_draft_only();

-- ── 7. RLS — members S/I/U; admin delete of DRAFTS ONLY ────────────────────
-- Mirrors goods_received_notes (20261059 note 7) with the same evidence
-- posture: once a request has been submitted it is part of the site's record
-- of what it asked for and when, so even an owner cannot make it disappear —
-- the only exit is 'cancelled', which leaves the row and its history in place.
--
-- ROLE GATING IS **NOT** HERE. A policy sees OLD or NEW, never both, so
-- "only an admin may move submitted → approved" is not expressible as a
-- policy. It lives in the transition trigger (20261067), which sees both.
alter table public.material_requests enable row level security;
alter table public.material_request_lines enable row level security;

drop policy if exists "material_requests: members can select" on public.material_requests;
create policy "material_requests: members can select" on public.material_requests
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "material_requests: members can insert" on public.material_requests;
create policy "material_requests: members can insert" on public.material_requests
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "material_requests: members can update" on public.material_requests;
create policy "material_requests: members can update" on public.material_requests
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "material_requests: admins can delete drafts" on public.material_requests;
create policy "material_requests: admins can delete drafts" on public.material_requests
  for delete to authenticated using (public.is_org_admin(org_id) and status = 'draft');

drop policy if exists "material_request_lines: members can select" on public.material_request_lines;
create policy "material_request_lines: members can select" on public.material_request_lines
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "material_request_lines: members can insert" on public.material_request_lines;
create policy "material_request_lines: members can insert" on public.material_request_lines
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "material_request_lines: members can update" on public.material_request_lines;
create policy "material_request_lines: members can update" on public.material_request_lines
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "material_request_lines: members can delete" on public.material_request_lines;
create policy "material_request_lines: members can delete" on public.material_request_lines
  for delete to authenticated using (org_id in (select public.current_org_ids()));

-- ── 8. Tenant visibility (activity_log) ────────────────────────────────────
-- Triggers are the ONLY legal writers of activity_log (20260516200000).
-- AFTER UPDATE / AFTER INSERT only — never AFTER DELETE — so neither sits on
-- the `delete from organizations` cascade path that 20261052 had to rescue.
create or replace function public._tg_material_requests_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform _record_activity(
      NEW.org_id, 'material_request.created', 'material_requests', NEW.id,
      jsonb_build_object('number', NEW.number, 'job_id', NEW.job_id,
                         'priority', NEW.priority, 'needed_by', NEW.needed_by)
    );
    return null;
  end if;

  if NEW.status is distinct from OLD.status then
    perform _record_activity(
      NEW.org_id, 'material_request.' || NEW.status, 'material_requests', NEW.id,
      jsonb_build_object(
        'number', NEW.number, 'from', OLD.status, 'to', NEW.status,
        'job_id', NEW.job_id, 'priority', NEW.priority,
        'needed_by', NEW.needed_by,
        'reason', NEW.rejection_reason,
        'lines', (select count(*) from public.material_request_lines
                   where material_request_id = NEW.id)
      )
    );
  end if;
  return null;
end $$;

drop trigger if exists material_requests_activity on public.material_requests;
create trigger material_requests_activity
  after insert or update on public.material_requests
  for each row execute function public._tg_material_requests_activity();
