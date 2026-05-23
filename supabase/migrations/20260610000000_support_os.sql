-- CrewFlow HQ — Support OS (HQ-7).
--
-- Two new tables:
--
--   public.support_tickets   — one row per customer-raised support
--                              request. Lives inside the tenant org
--                              (RLS: org members can see/insert,
--                              org admins can update).
--
--   public.support_messages  — the conversation thread for a ticket.
--                              Customer messages are always visible
--                              to both sides; HQ messages can be
--                              marked `internal=true` (visible only
--                              inside /admin/support — RLS hides them
--                              from the tenant).
--
-- Why we use the existing `current_org_ids()` helper rather than a
-- bespoke join: the helper centralises the "what orgs is this user a
-- member of" rule (membership table or guest tokens later), so RLS
-- across every per-tenant table stays consistent.
--
-- Why ticket_number is per-org (NOT a global id): customers see
-- "Ticket #42" in support replies. Per-org counters keep that number
-- small and meaningful even at scale. A trigger auto-assigns it.

-- =====================================================================
-- support_tickets
-- =====================================================================

create table if not exists public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- Per-org human-readable counter assigned by trigger.
  ticket_number   integer not null,

  subject         text not null
                  check (char_length(subject) between 3 and 200),
  status          text not null default 'open'
                  check (status in (
                    'open',
                    'in_progress',
                    'waiting_on_customer',
                    'resolved',
                    'closed'
                  )),
  priority        text not null default 'normal'
                  check (priority in ('low', 'normal', 'high', 'urgent')),
  category        text not null default 'other'
                  check (category in (
                    'billing',
                    'onboarding',
                    'migration',
                    'bug',
                    'feature_request',
                    'account',
                    'other'
                  )),

  -- Identity stamps
  created_by      uuid references public.users(id) on delete set null,
  -- HQ user assigned to it (null = unassigned).
  assigned_to     uuid references public.users(id) on delete set null,

  -- Reply telemetry — drives the "needs attention" sort + the
  -- waiting_on_customer auto-state.
  last_reply_at   timestamp with time zone,
  last_reply_kind text check (last_reply_kind in ('customer', 'hq')),

  resolved_at     timestamp with time zone,
  closed_at       timestamp with time zone,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now(),

  -- Per-org ticket number must be unique.
  unique (org_id, ticket_number)
);

alter table public.support_tickets enable row level security;

-- SELECT: members of the org see their own tickets.
create policy support_tickets_select on public.support_tickets
  for select using (org_id in (select public.current_org_ids()));

-- INSERT: members can raise tickets in their org.
create policy support_tickets_insert on public.support_tickets
  for insert with check (
    org_id in (select public.current_org_ids())
    and (created_by is null or created_by = auth.uid())
  );

-- UPDATE: org admins can update tickets in their org (e.g. customer
-- closing one of their own resolved tickets). HQ super-admins
-- bypass via service-role client.
create policy support_tickets_update on public.support_tickets
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- DELETE: nobody from the tenant side — tickets are an audit trail.
-- (HQ can hard-delete via service role for GDPR; no policy needed.)

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

create index if not exists support_tickets_org_recent_idx
  on public.support_tickets (org_id, created_at desc);

-- The HQ list sorts by priority + status frequently — composite index
-- speeds those queries even at scale.
create index if not exists support_tickets_status_priority_idx
  on public.support_tickets (status, priority, created_at desc);

create index if not exists support_tickets_open_idx
  on public.support_tickets (org_id, last_reply_at desc)
  where status in ('open', 'in_progress', 'waiting_on_customer');

create index if not exists support_tickets_assigned_idx
  on public.support_tickets (assigned_to, status)
  where assigned_to is not null;

-- ---------------------------------------------------------------------
-- Updated-at touch trigger
-- ---------------------------------------------------------------------

create or replace function public._support_tickets_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists support_tickets_touch on public.support_tickets;
create trigger support_tickets_touch
  before update on public.support_tickets
  for each row execute function public._support_tickets_touch();

-- ---------------------------------------------------------------------
-- Per-org ticket-number assignment
--
-- A SECURITY DEFINER function locks the parent org row, picks the
-- next number, and assigns it. The UNIQUE (org_id, ticket_number)
-- constraint is the safety net against any race we missed.
-- ---------------------------------------------------------------------

create or replace function public._support_tickets_set_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  if new.ticket_number is null or new.ticket_number = 0 then
    -- Lock the parent org row so concurrent inserts serialise.
    perform 1 from public.organizations where id = new.org_id for update;
    select coalesce(max(ticket_number), 0) + 1
      into v_next
      from public.support_tickets
     where org_id = new.org_id;
    new.ticket_number := v_next;
  end if;
  return new;
end $$;

drop trigger if exists support_tickets_set_number on public.support_tickets;
create trigger support_tickets_set_number
  before insert on public.support_tickets
  for each row execute function public._support_tickets_set_number();

-- =====================================================================
-- support_messages
-- =====================================================================

create table if not exists public.support_messages (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid not null references public.support_tickets(id) on delete cascade,
  -- Convenience denorm: lets RLS scope by org_id without a join,
  -- and lets HQ queries filter by org cheaply.
  org_id          uuid not null references public.organizations(id) on delete cascade,
  author_id       uuid references public.users(id) on delete set null,
  -- 'customer' is always tenant-visible.
  -- 'hq' can be either tenant-visible (a reply) or internal-only.
  author_kind     text not null check (author_kind in ('customer', 'hq')),
  -- Internal note: only surfaced inside /admin/support. RLS hides
  -- internal messages from tenant SELECTs below.
  internal        boolean not null default false,
  body            text not null
                  check (char_length(body) between 1 and 10000),
  created_at      timestamp with time zone not null default now(),

  -- Customer-authored messages can NEVER be internal.
  check (author_kind = 'hq' or internal = false)
);

alter table public.support_messages enable row level security;

-- SELECT: members can see all non-internal messages in their org.
create policy support_messages_select on public.support_messages
  for select using (
    org_id in (select public.current_org_ids())
    and internal = false
  );

-- INSERT: members can insert their own (non-internal, customer-kind)
-- messages on tickets they can see.
create policy support_messages_insert on public.support_messages
  for insert with check (
    org_id in (select public.current_org_ids())
    and author_kind = 'customer'
    and internal = false
    and (author_id is null or author_id = auth.uid())
  );

-- No tenant-side UPDATE/DELETE — messages are immutable from the
-- tenant view. HQ uses service role for any moderation.

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

create index if not exists support_messages_ticket_idx
  on public.support_messages (ticket_id, created_at asc);

create index if not exists support_messages_org_recent_idx
  on public.support_messages (org_id, created_at desc);

-- ---------------------------------------------------------------------
-- Trigger: keep parent ticket's last_reply_at / last_reply_kind fresh
-- + auto-advance status based on who replied.
-- ---------------------------------------------------------------------

create or replace function public._support_messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Internal HQ notes don't change reply telemetry — they're just
  -- side conversation.
  if new.internal then
    return new;
  end if;

  update public.support_tickets t
     set last_reply_at  = new.created_at,
         last_reply_kind = new.author_kind,
         -- Status nudges:
         --  * customer reply on a 'waiting_on_customer' ticket
         --    re-opens it to 'in_progress'.
         --  * HQ reply on an 'open' ticket flips it to 'in_progress'.
         --  * HQ reply on an 'in_progress' ticket flips it to
         --    'waiting_on_customer' (we just bounced the ball).
         status = case
           when new.author_kind = 'customer' and t.status = 'waiting_on_customer'
             then 'in_progress'
           when new.author_kind = 'hq' and t.status = 'open'
             then 'in_progress'
           when new.author_kind = 'hq' and t.status = 'in_progress'
             then 'waiting_on_customer'
           else t.status
         end,
         updated_at = now()
   where t.id = new.ticket_id;
  return new;
end $$;

drop trigger if exists support_messages_after_insert on public.support_messages;
create trigger support_messages_after_insert
  after insert on public.support_messages
  for each row execute function public._support_messages_after_insert();
