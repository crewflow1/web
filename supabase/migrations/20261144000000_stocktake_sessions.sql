-- O3 OPERATIONAL STOCK — STOCKTAKE / CYCLE-COUNT SESSIONS + BARCODE (part 1 of 2).
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — READ THIS BEFORE CHANGING ANYTHING HERE.      ║
-- ║                                                                          ║
-- ║  A stocktake is an OPERATIONAL QUANTITY reconciliation. It records what  ║
-- ║  was COUNTED against what was EXPECTED and posts the difference as a     ║
-- ║  quantity movement — never a cost, never a value, never a journal.       ║
-- ║  NOTHING in this migration adds a money column, writes to                ║
-- ║  `public.finances`, or puts a trigger on it. A variance is posted        ║
-- ║  through the existing movement ledger as an adjustment_in / _out         ║
-- ║  (20261065000000 / 20261071000000), which carries NO cost — materials    ║
-- ║  are already expensed by recordSupplierBill, so a second posting would   ║
-- ║  double-count the same spend. Stock valuation is CEO decision D1 and is  ║
-- ║  UNDECIDED; a stocktake VALUATION report is explicitly OUT OF SCOPE      ║
-- ║  (the D1 decision), so no valuation is computed here or anywhere that    ║
-- ║  reads these tables.                                                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── WHAT A STOCKTAKE IS, AND WHY IT IS NOT A STORED BALANCE ──────────────────
-- Today the only way to reconcile a count is a single-item `adjustment` (admin-
-- gated, 20261065000000 §4). That is fine for "found 12 more of one thing"; it
-- is unusable for "walk the lock-up and count everything". A stocktake session
-- is the multi-item, snapshot-then-count-then-post workflow:
--
--   1. OPEN     — freeze the EXPECTED quantity of every item at ONE site into
--                 stocktake_lines. The snapshot is `expected_qty`, computed once
--                 from the movement ledger (sum(effect)) and then IMMUTABLE. It
--                 is NOT a stored balance that anything reads back — the live
--                 balance is still derived from stock_movements for ever
--                 (20261064000000). It is a frozen photograph of the ledger at
--                 the moment counting began, so the variance is deterministic
--                 and auditable no matter what moves afterwards.
--   2. COUNTING — capture `counted_qty` per line (by hand or by barcode scan).
--   3. POSTED   — for every line whose count differs from its snapshot, post the
--                 variance (counted − expected) as an adjustment movement, admin-
--                 gated, through record_stock_adjustment (20261071000000). The
--                 posted movement id is stamped back onto the line, so every
--                 variance is traceable to the exact ledger row it created.
--
-- Lifecycle: open → counting → posted, plus cancelled (abandon from open or
-- counting). posted / cancelled are TERMINAL. Enforced by
-- tg_stocktake_session_transition below, not merely by the app.
--
-- ── WHY THE SNAPSHOT IS PER-SITE ────────────────────────────────────────────
-- A session names ONE site. A count happens at a physical place — you walk one
-- yard, one container, one lock-up — and the per-(item, site) advisory lock the
-- posting path takes (20261065000000) is exactly this granularity, so a per-site
-- session posts without ever blocking a different site's issues. Counting a
-- whole company at once is just several sessions, one per place, which is also
-- how the physical work is actually divided between people.
--
-- ── BARCODE / EAN — a SECOND identifier, not a rename of `sku` ───────────────
-- `stock_items.sku` (20261063000000) is the company's OWN code. A `barcode` is
-- the manufacturer's scannable code (EAN-13, UPC, Code-128) printed on the
-- product — a different thing that a scanner reads directly. Both are nullable,
-- both unique-per-org WHERE PRESENT, both case-insensitive (a scanner never
-- disagrees on case, but a hand-typed fallback might). Scan-to-find / scan-to-
-- count matches a scanned string against EITHER, so an item found by its own
-- code or by the barcode on the box resolves to the same row.
--
-- ── TENANCY ─────────────────────────────────────────────────────────────────
-- Both new tables carry org_id, RLS enabled, and every cross-table reference is
-- a COMPOSITE (id, org_id) FK so a cross-tenant session/line is unrepresentable
-- for every role (the 20261064000000 note-2 posture). Reads are ADDITIONALLY
-- active-org pinned in the service layer (`.eq("org_id", orgId)`), the #456/#468
-- discipline, because current_org_ids() admits every org a dual-org member is in.
--
-- ── AUTHORITY IS IN THE DATABASE, not only the app ──────────────────────────
-- Lines are snapshotted only by open_stocktake_session (gated by the
-- crewflow.stocktake_open transaction marker); counts change only while the
-- session is `counting`; posted_* is written only inside post_stocktake_session
-- (gated by crewflow.stocktake_post); and the session may only reach `posted`
-- through that same marker AND by an admin. This is the transaction-marker idiom
-- already proven for stock_movements (crewflow.stock_write, 20261071000000 §2)
-- and material requests (crewflow.mr_fulfilment, 20261067000000). service_role
-- is trusted server-side code and bypasses the JWT-gated checks, exactly as
-- every other authority check in this schema does.
--
-- Additive and reversible. To roll back:
--   drop trigger if exists stocktake_lines_guard on public.stocktake_lines;
--   drop function if exists public.tg_stocktake_lines_guard();
--   drop trigger if exists stocktake_lines_authorised_insert on public.stocktake_lines;
--   drop function if exists public.tg_stocktake_lines_authorised_insert();
--   drop table if exists public.stocktake_lines;
--   drop trigger if exists stocktake_sessions_set_updated_at on public.stocktake_sessions;
--   drop trigger if exists stocktake_sessions_transition on public.stocktake_sessions;
--   drop function if exists public.tg_stocktake_session_transition();
--   drop trigger if exists stocktake_sessions_insert_open on public.stocktake_sessions;
--   drop function if exists public.tg_stocktake_session_insert_open();
--   drop table if exists public.stocktake_sessions;
--   drop index if exists public.stock_items_org_barcode_unique;
--   alter table public.stock_items drop column if exists barcode;

-- ════════════════════════════════════════════════════════════════════════════
-- §1. BARCODE on the item register
-- ════════════════════════════════════════════════════════════════════════════
alter table public.stock_items
  add column if not exists barcode text
    check (barcode is null or length(btrim(barcode)) between 1 and 64);

-- One barcode per org WHERE PRESENT. Partial + case-insensitive, exactly like
-- stock_items_org_sku_unique: two items cannot share a scannable code, while the
-- majority that have none stay unconstrained.
create unique index if not exists stock_items_org_barcode_unique
  on public.stock_items (org_id, lower(barcode))
  where barcode is not null;

comment on column public.stock_items.barcode is
  'Manufacturer/EAN/UPC scannable code (NOT the company sku, which is its own code). Nullable, unique per org where present, case-insensitive. Scan-to-find matches this OR sku.';

-- ════════════════════════════════════════════════════════════════════════════
-- §2. stocktake_sessions
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.stocktake_sessions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,

  -- WHERE it is counted. Composite FK: a session naming another tenant's site is
  -- unrepresentable, for every role. NOT NULL — a count is always at a place.
  site_id     uuid not null,

  -- A human handle for the count ("Q3 lock-up", "van reset"). Optional.
  reference   text check (reference is null or length(btrim(reference)) between 1 and 120),

  -- open → counting → posted, plus cancelled. posted/cancelled are terminal;
  -- transitions enforced by tg_stocktake_session_transition below.
  status      text not null default 'open'
              check (status in ('open', 'counting', 'posted', 'cancelled')),

  notes       text check (notes is null or length(notes) <= 2000),

  opened_by   uuid references public.users(id) on delete set null,
  opened_at   timestamp with time zone not null default now(),
  posted_by   uuid references public.users(id) on delete set null,
  posted_at   timestamp with time zone,
  cancelled_by uuid references public.users(id) on delete set null,
  cancelled_at timestamp with time zone,

  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone not null default now(),

  -- Candidate key for the lines' composite (id, org_id) FK.
  constraint stocktake_sessions_id_org_key unique (id, org_id),

  constraint stocktake_sessions_site_org_fkey
    foreign key (site_id, org_id)
    references public.sites (id, org_id)
    on delete no action deferrable initially deferred
);

-- F-1: the session list is `where org_id = ? order by opened_at desc, id desc`.
create index if not exists stocktake_sessions_org_recent_idx
  on public.stocktake_sessions (org_id, opened_at desc, id desc);
-- "open counts at this site" — the pre-open duplicate check and the site page.
create index if not exists stocktake_sessions_site_idx
  on public.stocktake_sessions (org_id, site_id, status);

drop trigger if exists stocktake_sessions_set_updated_at on public.stocktake_sessions;
create trigger stocktake_sessions_set_updated_at before update on public.stocktake_sessions
  for each row execute function public.tg_set_updated_at();

-- ── A session is BORN 'open' ─────────────────────────────────────────────────
-- The transition trigger only fires on UPDATE, so a direct PostgREST INSERT of a
-- row already reading 'posted' would sidestep it entirely. JWT-gated: service
-- role (seeds/backfills) may insert any state.
create or replace function public.tg_stocktake_session_insert_open()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.status <> 'open' then
    raise exception 'a stocktake starts open — it cannot be created already %', new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists stocktake_sessions_insert_open on public.stocktake_sessions;
create trigger stocktake_sessions_insert_open
  before insert on public.stocktake_sessions
  for each row execute function public.tg_stocktake_session_insert_open();

-- ── THE LIFECYCLE ───────────────────────────────────────────────────────────
-- open → counting        any member (counting is operational, no ledger write)
-- open → cancelled       requester or admin
-- counting → posted      ONLY through post_stocktake_session (the marker) AND an
--                        admin — posting writes admin-gated adjustment movements
-- counting → cancelled   requester or admin
-- posted / cancelled     TERMINAL
--
-- SECURITY DEFINER + pinned search_path (the tg_material_request_transition
-- posture): it reads is_org_admin and the transaction marker; it returns no data.
create or replace function public.tg_stocktake_session_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_jwt    boolean;
  v_admin  boolean;
  v_own    boolean;
  v_marker text;
begin
  if new.status is not distinct from old.status then
    return new; -- ordinary field edit (updated_at, notes); not a transition
  end if;

  v_jwt   := auth.uid() is not null;
  v_admin := (not v_jwt) or public.is_org_admin(new.org_id);
  v_own   := (not v_jwt) or old.opened_by = auth.uid();
  v_marker := coalesce(current_setting('crewflow.stocktake_post', true), '');

  -- Terminal states are frozen.
  if old.status in ('posted', 'cancelled') then
    raise exception 'stocktake %: % is final', old.id, old.status
      using errcode = 'check_violation';
  end if;

  -- → posted: only the marker-gated posting path, only from counting, only admin.
  if new.status = 'posted' then
    if v_marker <> new.id::text then
      raise exception
        'stocktake %: variances are POSTED through post_stocktake_session, not set by hand', old.id
        using errcode = 'check_violation';
    end if;
    if not v_admin then
      raise exception 'stocktake %: only an owner or admin can post a stocktake', old.id
        using errcode = 'insufficient_privilege';
    end if;
    if old.status <> 'counting' then
      raise exception 'stocktake %: a stocktake is posted from counting, not from %', old.id, old.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- open → counting
  if old.status = 'open' and new.status = 'counting' then
    return new;
  end if;

  -- → cancelled (from open or counting), by the opener or an admin
  if new.status = 'cancelled' and old.status in ('open', 'counting') then
    if not (v_own or v_admin) then
      raise exception 'stocktake %: only the person who opened it or an admin can cancel it', old.id
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  raise exception 'stocktake %: % -> % is not a legal transition',
    old.id, old.status, new.status using errcode = 'check_violation';
end $$;

drop trigger if exists stocktake_sessions_transition on public.stocktake_sessions;
create trigger stocktake_sessions_transition
  before update on public.stocktake_sessions
  for each row execute function public.tg_stocktake_session_transition();

-- ── RLS — members S/I/U, admins delete (the stock_items posture) ────────────
alter table public.stocktake_sessions enable row level security;

drop policy if exists "stocktake_sessions: members can select" on public.stocktake_sessions;
create policy "stocktake_sessions: members can select" on public.stocktake_sessions
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "stocktake_sessions: members can insert" on public.stocktake_sessions;
create policy "stocktake_sessions: members can insert" on public.stocktake_sessions
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "stocktake_sessions: members can update" on public.stocktake_sessions;
create policy "stocktake_sessions: members can update" on public.stocktake_sessions
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "stocktake_sessions: admins can delete" on public.stocktake_sessions;
create policy "stocktake_sessions: admins can delete" on public.stocktake_sessions
  for delete to authenticated using (public.is_org_admin(org_id));

comment on table public.stocktake_sessions is
  'A stocktake / cycle-count at ONE site: freeze expected quantities, capture counts, post variances through the movement ledger. Holds NO value (D1 undecided). Lifecycle open→counting→posted (+cancelled), enforced by tg_stocktake_session_transition.';

-- ════════════════════════════════════════════════════════════════════════════
-- §3. stocktake_lines — one per (session, item)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.stocktake_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,

  -- The session owns the line; deleting a session removes its lines.
  session_id     uuid not null,

  stock_item_id  uuid not null,

  -- THE FROZEN SNAPSHOT. sum(effect) for this item at the session's site at the
  -- moment of open, then IMMUTABLE (tg_stocktake_lines_guard). Not a stored
  -- balance — the live balance is still derived from stock_movements.
  expected_qty   numeric(12, 2) not null,

  -- What was physically counted. Null until counted; a count is never negative.
  counted_qty    numeric(12, 2) check (counted_qty is null or counted_qty >= 0),
  counted_at     timestamp with time zone,
  counted_by     uuid references public.users(id) on delete set null,

  -- The adjustment movement this line's variance produced, and the signed
  -- variance that was posted. Written ONLY inside post_stocktake_session (the
  -- crewflow.stocktake_post marker). Composite FK: it can only name a movement
  -- in the same org.
  posted_movement_id uuid,
  posted_variance    numeric(12, 2),

  created_at     timestamp with time zone not null default now(),

  constraint stocktake_lines_session_item_uniq unique (session_id, stock_item_id),

  constraint stocktake_lines_session_org_fkey
    foreign key (session_id, org_id)
    references public.stocktake_sessions (id, org_id)
    on delete cascade,

  constraint stocktake_lines_item_org_fkey
    foreign key (stock_item_id, org_id)
    references public.stock_items (id, org_id)
    on delete no action deferrable initially deferred,

  constraint stocktake_lines_movement_org_fkey
    foreign key (posted_movement_id, org_id)
    references public.stock_movements (id, org_id)
    on delete no action deferrable initially deferred
);

-- F-1: the line list is `where org_id = ? and session_id = ? order by …`. The
-- composite FK to stock_items also needs a candidate key on the child side is
-- not required; the parent's stock_items_id_org_key already exists.
create index if not exists stocktake_lines_session_idx
  on public.stocktake_lines (org_id, session_id, stock_item_id);

-- ── Lines are snapshotted only from inside the open path ─────────────────────
-- A member with a JWT could otherwise INSERT arbitrary lines into any session in
-- their org. The open RPC sets crewflow.stocktake_open = session_id before its
-- bulk insert; this trigger requires it. JWT-gated so service_role stays trusted.
create or replace function public.tg_stocktake_lines_authorised_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then
    return new; -- trusted service role
  end if;
  if coalesce(current_setting('crewflow.stocktake_open', true), '') <> new.session_id::text then
    raise exception
      'a stocktake line is created by opening a session (open_stocktake_session), not by direct insert'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists stocktake_lines_authorised_insert on public.stocktake_lines;
create trigger stocktake_lines_authorised_insert
  before insert on public.stocktake_lines
  for each row execute function public.tg_stocktake_lines_authorised_insert();

-- ── What may change on a line, and when ─────────────────────────────────────
-- expected_qty / identity columns are IMMUTABLE. counted_qty may change only
-- while the parent session is `counting`. posted_* may be written only inside
-- the posting path (the crewflow.stocktake_post marker). JWT-gated throughout.
-- SECURITY DEFINER + pinned search_path so the parent-status read is not
-- filtered by the caller's RLS.
create or replace function public.tg_stocktake_lines_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_marker text;
begin
  if auth.uid() is null then
    return new; -- trusted service role
  end if;

  -- The frozen snapshot and the line's identity never move.
  if new.expected_qty  is distinct from old.expected_qty
     or new.org_id     is distinct from old.org_id
     or new.session_id is distinct from old.session_id
     or new.stock_item_id is distinct from old.stock_item_id then
    raise exception 'a stocktake line''s snapshot and identity are immutable'
      using errcode = 'check_violation';
  end if;

  v_marker := coalesce(current_setting('crewflow.stocktake_post', true), '');

  -- posted_* is the posting path's alone.
  if (new.posted_movement_id is distinct from old.posted_movement_id
      or new.posted_variance is distinct from old.posted_variance)
     and v_marker <> new.session_id::text then
    raise exception 'a stocktake variance is posted through post_stocktake_session'
      using errcode = 'insufficient_privilege';
  end if;

  -- A count may only be entered/changed while the session is counting (unless we
  -- are inside the posting path, which touches posted_* not counted_qty).
  if new.counted_qty is distinct from old.counted_qty and v_marker <> new.session_id::text then
    select status into v_status from public.stocktake_sessions
      where id = new.session_id and org_id = new.org_id;
    if v_status <> 'counting' then
      raise exception 'this stocktake is not open for counting (it is %)', coalesce(v_status, 'missing')
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists stocktake_lines_guard on public.stocktake_lines;
create trigger stocktake_lines_guard
  before update on public.stocktake_lines
  for each row execute function public.tg_stocktake_lines_guard();

-- ── RLS — members S/I/U, admins delete ──────────────────────────────────────
alter table public.stocktake_lines enable row level security;

drop policy if exists "stocktake_lines: members can select" on public.stocktake_lines;
create policy "stocktake_lines: members can select" on public.stocktake_lines
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "stocktake_lines: members can insert" on public.stocktake_lines;
create policy "stocktake_lines: members can insert" on public.stocktake_lines
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "stocktake_lines: members can update" on public.stocktake_lines;
create policy "stocktake_lines: members can update" on public.stocktake_lines
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "stocktake_lines: admins can delete" on public.stocktake_lines;
create policy "stocktake_lines: admins can delete" on public.stocktake_lines
  for delete to authenticated using (public.is_org_admin(org_id));

comment on table public.stocktake_lines is
  'One (session, item) count line. expected_qty is a frozen snapshot of the derived balance at open; counted_qty is captured during counting; posted_movement_id links the adjustment the variance produced. No cost anywhere (D1 undecided).';
comment on column public.stocktake_lines.expected_qty is
  'Frozen snapshot of sum(effect) for this item at the session site at open. Immutable. NOT a stored balance — the live balance stays derived from stock_movements.';
