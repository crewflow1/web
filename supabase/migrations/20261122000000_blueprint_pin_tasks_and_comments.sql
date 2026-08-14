-- Blueprint Pins — completion wave (P2): task-type pins + threaded comments.
--
-- Extends the Programme B pins model (20261016000000_blueprint_pins.sql)
-- additively:
--   1. A first-class 'task' pin kind: a point on a drawing that carries its OWN
--      lifecycle (open -> in_progress -> done), an assignee, and a due date.
--      Unlike a 'snag' pin (whose status is DERIVED from the linked snag row),
--      a task pin OWNS its status — the pin is the record. Reuses the snag
--      assignment conventions: assigned_to -> users ON DELETE SET NULL.
--   2. A threaded comments table on any pin (blueprint_pin_comments), with the
--      SAME tenant-integrity doctrine as the pins table: org_id derived from the
--      parent pin in a before-write trigger (client values ignored), composite
--      (col, org_id) FKs so Postgres itself blocks cross-org links for EVERY
--      role incl. service_role, RLS scoped to current_org_ids().
--
-- This migration is additive and reversible: it adds columns (all nullable /
-- defaulted so every existing pin still satisfies the widened CHECKs) and one
-- new table. No existing row is mutated. The pin-photo link (widening the
-- tenant_attachments target CHECK) lands in the sibling 20261122000001.
--
-- Next free slot after this pair is 20261122000002.

-- ---------------------------------------------------------------------------
-- 1. Task-pin columns on blueprint_pins.
--    All nullable: a snag/note pin leaves them NULL, and the widened payload
--    CHECK below forbids them on non-task pins — so no existing row is touched.
-- ---------------------------------------------------------------------------
alter table public.blueprint_pins
  add column if not exists task_status text,
  add column if not exists assigned_to uuid references public.users(id) on delete set null,
  add column if not exists due_date    date;

-- Lifecycle domain for a task pin: open -> in_progress -> done. Only ever set
-- on a task pin (enforced by the payload CHECK). NULL on snag/note pins.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'blueprint_pins_task_status_check') then
    alter table public.blueprint_pins
      add constraint blueprint_pins_task_status_check
      check (task_status is null or task_status in ('open', 'in_progress', 'done'));
  end if;
end $$;

comment on column public.blueprint_pins.task_status is
  'Lifecycle of a task pin (open|in_progress|done). NULL for snag/note pins — a task pin OWNS its status; a snag pin derives it from the linked snag.';

-- ---------------------------------------------------------------------------
-- 2. Widen the `kind` domain to include 'task', and rebuild the kind<->payload
--    consistency CHECK so it covers the new kind. Both are dropped by
--    introspected name (the `kind in (...)` check is Postgres-named
--    blueprint_pins_kind_check; the payload check is explicitly named) and
--    re-added, preserving the snag/note rules verbatim.
-- ---------------------------------------------------------------------------
do $$
declare
  kname text;
begin
  -- The column-level `check (kind in (...))`: find it by its definition so a
  -- differing auto-name can't leave the old two-value domain in place.
  select con.conname into kname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'blueprint_pins'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%'
    and pg_get_constraintdef(con.oid) ilike '%snag%'
    and pg_get_constraintdef(con.oid) not ilike '%snag_id%';
  if kname is not null then
    execute format('alter table public.blueprint_pins drop constraint %I', kname);
  end if;
end $$;

alter table public.blueprint_pins
  add constraint blueprint_pins_kind_check
  check (kind in ('snag', 'note', 'task'));

alter table public.blueprint_pins
  drop constraint if exists blueprint_pins_kind_payload;

alter table public.blueprint_pins
  add constraint blueprint_pins_kind_payload check (
    -- snag pin: links a snag, carries no free note; no task fields.
    (kind = 'snag' and snag_id is not null and note is null
       and task_status is null and assigned_to is null and due_date is null) or
    -- note pin: no link, must carry note text; no task fields.
    (kind = 'note' and snag_id is null and note is not null
       and task_status is null and assigned_to is null and due_date is null) or
    -- task pin: no snag link; OWNS a status; note is an optional description;
    -- assignee + due date are optional.
    (kind = 'task' and snag_id is null and task_status is not null)
  );

-- Board query: "open/in-progress task pins assigned to me / on this org".
create index if not exists blueprint_pins_task_idx
  on public.blueprint_pins (org_id, task_status) where kind = 'task';
create index if not exists blueprint_pins_assignee_idx
  on public.blueprint_pins (assigned_to) where assigned_to is not null;

-- ---------------------------------------------------------------------------
-- 3. (id, org_id) candidate key on blueprint_pins so the comments table can
--    bind tenancy with a composite FK (mirrors the version/snag keys the pins
--    migration added). `id` is already PK, so this grants no new uniqueness —
--    it exists solely as an FK target.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'blueprint_pins_id_org_key') then
    alter table public.blueprint_pins
      add constraint blueprint_pins_id_org_key unique (id, org_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Threaded comments on a pin.
-- ---------------------------------------------------------------------------
create table if not exists public.blueprint_pin_comments (
  id                uuid primary key default gen_random_uuid(),
  -- Tenancy — DERIVED from the parent pin by the before-write trigger.
  org_id            uuid not null,
  pin_id            uuid not null,
  -- Threading: a reply points at an earlier comment on the SAME pin. NULL = a
  -- root comment. Composite self-FK carries tenancy; a trigger enforces
  -- same-pin (see below).
  parent_comment_id uuid,
  body              text not null check (char_length(btrim(body)) between 1 and 2000),
  author_id         uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Pin link + cross-tenant integrity (declarative, every role). Deleting the
  -- pin removes its whole thread.
  constraint blueprint_pin_comments_pin_org_fkey
    foreign key (pin_id, org_id)
    references public.blueprint_pins (id, org_id) on delete cascade,

  -- (id, org_id) candidate key so the self-referential parent FK has a target.
  constraint blueprint_pin_comments_id_org_key unique (id, org_id),

  -- Reply link + cross-tenant integrity. MATCH SIMPLE: only checked when
  -- parent_comment_id is non-null. ON DELETE CASCADE: deleting a parent removes
  -- its replies (the sub-thread has no meaning without its root).
  constraint blueprint_pin_comments_parent_org_fkey
    foreign key (parent_comment_id, org_id)
    references public.blueprint_pin_comments (id, org_id) on delete cascade
);

comment on table public.blueprint_pin_comments is
  'Threaded discussion on a blueprint pin. org_id derived from the parent pin; composite FKs block cross-org links; RLS scopes to current_org_ids(). P2 pins wave.';

-- Read path: "this pin''s thread, oldest first" (the UI query).
create index if not exists blueprint_pin_comments_thread_idx
  on public.blueprint_pin_comments (org_id, pin_id, created_at);
create index if not exists blueprint_pin_comments_parent_idx
  on public.blueprint_pin_comments (parent_comment_id) where parent_comment_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Anti-spoof derivation + same-pin reply guard (before insert OR update).
--    SECURITY DEFINER + pinned search_path. org_id is derived from the parent
--    pin (client value ignored), and a reply''s parent must live on the SAME
--    pin (a cross-pin reply would corrupt the thread).
-- ---------------------------------------------------------------------------
create or replace function public.tg_blueprint_pin_comment_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org        uuid;
  v_parent_pin uuid;
begin
  select org_id into v_org from public.blueprint_pins where id = new.pin_id;
  if v_org is null then
    raise exception 'blueprint pin % does not exist', new.pin_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Client-sent tenancy is ignored: the parent pin is authoritative.
  new.org_id := v_org;

  if new.parent_comment_id is not null then
    select pin_id into v_parent_pin
      from public.blueprint_pin_comments where id = new.parent_comment_id;
    if v_parent_pin is null then
      raise exception 'parent comment % does not exist', new.parent_comment_id
        using errcode = 'foreign_key_violation';
    end if;
    if v_parent_pin is distinct from new.pin_id then
      raise exception 'a reply must be on the same pin as its parent (% vs %)', v_parent_pin, new.pin_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists blueprint_pin_comments_before_write on public.blueprint_pin_comments;
create trigger blueprint_pin_comments_before_write
  before insert or update on public.blueprint_pin_comments
  for each row execute function public.tg_blueprint_pin_comment_before_write();

drop trigger if exists blueprint_pin_comments_set_updated_at on public.blueprint_pin_comments;
create trigger blueprint_pin_comments_set_updated_at
  before update on public.blueprint_pin_comments
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. RLS — tenant-scoped. Members read + post; a comment''s AUTHOR may edit or
--    delete their own; an org admin may delete any (moderation). Mirrors the
--    operator-only posture of the pins table.
-- ---------------------------------------------------------------------------
alter table public.blueprint_pin_comments enable row level security;

create policy "blueprint_pin_comments: members select" on public.blueprint_pin_comments
  for select using (org_id in (select public.current_org_ids()));

create policy "blueprint_pin_comments: members insert" on public.blueprint_pin_comments
  for insert with check (
    org_id in (select public.current_org_ids())
    and author_id = auth.uid()
  );

create policy "blueprint_pin_comments: author update" on public.blueprint_pin_comments
  for update using (org_id in (select public.current_org_ids()) and author_id = auth.uid())
  with check (org_id in (select public.current_org_ids()) and author_id = auth.uid());

create policy "blueprint_pin_comments: author or admin delete" on public.blueprint_pin_comments
  for delete using (
    org_id in (select public.current_org_ids())
    and (author_id = auth.uid() or public.is_org_admin(org_id))
  );
