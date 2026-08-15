-- Maintenance / service booking (P3 — Portal completeness).
--
-- The warranties page already DERIVES a servicing schedule (every N months) from
-- the job's completion certificate — but that is a schedule to READ, with no way
-- for the customer to actually BOOK a visit. This adds real, date-based booking
-- against operator-published slots. It is DISTINCT from the loose future-work
-- request (a lead asking for more work): a booking is the customer picking a
-- concrete date the org has opened for servicing.
--
-- Two tables:
--   service_booking_slots — the operator publishes bookable windows (a date +
--                           time + capacity). Org config; admin-managed.
--   service_bookings      — a customer books a slot, optionally against one of
--                           their warranties. Customer-scoped.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY
-- ─────────────────────────────────────────────────────────────────────────────
--   • A booking is bound to (org_id, customer_id) by a COMPOSITE FK to
--     customers(id, org_id): it can never name another org's customer.
--   • slot_id is bound by a COMPOSITE FK to service_booking_slots(id, org_id):
--     a booking can only ever reference a slot in its OWN org — so a customer can
--     never book (or even see, via a crafted id) another org's slot.
--   • warranty_id (optional) is bound by a COMPOSITE FK to job_warranties(id,
--     org_id). The portal action additionally verifies the warranty belongs to
--     the token-resolved customer before stamping.
--   • Capacity is enforced atomically by a BEFORE trigger that locks the slot row
--     and counts live bookings, so two concurrent books can't oversell a slot.
--
-- TEARDOWN SAFETY: additive; org-scoped; slot/customer edges CASCADE, warranty
-- edge SET NULL, user edge SET NULL. No RESTRICT, no AFTER-DELETE trigger.

-- ── 1. service_booking_slots — operator-published bookable windows ────────────
create table if not exists public.service_booking_slots (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,

  starts_at     timestamp with time zone not null,
  ends_at       timestamp with time zone not null,
  -- How many bookings this window accepts (a fitter can do several a day).
  capacity      integer not null default 1 check (capacity between 1 and 100),
  -- Optional human label ("Morning service run — north").
  label         text check (label is null or char_length(label) <= 200),
  -- Withdrawn without deletion (existing bookings survive), like a warranty.
  active        boolean not null default true,

  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now(),

  constraint service_booking_slots_window_order check (ends_at > starts_at),
  -- Candidate key so bookings can bind (slot_id, org_id) rather than slot_id
  -- alone — the cross-org barrier for the booking's slot reference.
  constraint service_booking_slots_id_org_key unique (id, org_id)
);

comment on table public.service_booking_slots is
  'Operator-published bookable service windows (P3). Customers book these from the portal servicing page; capacity-limited and atomically enforced.';

create index if not exists service_booking_slots_org_idx
  on public.service_booking_slots (org_id, starts_at)
  where active;

-- ── 2. service_bookings — a customer's booking of a slot ─────────────────────
create table if not exists public.service_bookings (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  customer_id   uuid not null,
  slot_id       uuid not null,
  -- Optional: which warranty's servicing this visit is for.
  warranty_id   uuid,

  status        text not null default 'requested'
    check (status in ('requested', 'confirmed', 'cancelled', 'completed')),
  -- What the customer wants looked at. Bounded.
  notes         text check (notes is null or char_length(notes) <= 2000),
  -- Copied from the customer record on write (never typed by the requester) so a
  -- portal visitor can't plant a callback number on someone else's booking.
  contact_name  text,
  contact_email text,
  contact_phone text,

  cancelled_at  timestamp with time zone,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now(),

  -- ORG + CUSTOMER binding — the cross-customer barrier.
  constraint service_bookings_customer_org_fkey
    foreign key (customer_id, org_id) references public.customers (id, org_id) on delete cascade,
  -- SLOT binding — a booking can only reference a slot in its OWN org.
  constraint service_bookings_slot_org_fkey
    foreign key (slot_id, org_id) references public.service_booking_slots (id, org_id) on delete cascade,
  -- WARRANTY binding (optional) — org-bound; SET NULL so the booking survives a
  -- warranty delete. MATCH SIMPLE: a NULL warranty_id is never checked.
  constraint service_bookings_warranty_org_fkey
    foreign key (warranty_id, org_id) references public.job_warranties (id, org_id) on delete set null
);

comment on table public.service_bookings is
  'A customer booking of a service_booking_slot (P3), optionally against a warranty. Bound to (org_id, customer_id) and to a same-org slot by composite FKs; capacity enforced atomically.';
comment on column public.service_bookings.warranty_id is
  'Optional warranty this servicing visit is for. Org-bound composite FK; the portal action verifies it belongs to the token-resolved customer before stamping.';

create index if not exists service_bookings_customer_idx
  on public.service_bookings (org_id, customer_id, created_at desc);
create index if not exists service_bookings_slot_idx
  on public.service_bookings (slot_id);
-- Live bookings per slot — the capacity trigger's counting index.
create index if not exists service_bookings_slot_live_idx
  on public.service_bookings (slot_id)
  where status in ('requested', 'confirmed');

-- ── 3. Capacity guard + org-consistency, atomic under a row lock ─────────────
-- Verifies the warranty (if any) belongs to the SAME customer, then locks the
-- slot row and refuses the insert if live bookings already fill capacity. The
-- FOR UPDATE lock serialises concurrent books on the same slot, so capacity can
-- never be oversold. BEFORE INSERT/UPDATE only — cannot run in a delete cascade.
create or replace function public.tg_service_bookings_guard()
returns trigger language plpgsql as $$
declare
  slot_cap   integer;
  slot_org   uuid;
  slot_active boolean;
  live_count integer;
  war_job    uuid;
  war_cust   uuid;
begin
  -- Warranty (if named) must belong to this customer's own job, same org. The
  -- composite FK already forces same-org; this additionally forces same-CUSTOMER.
  if new.warranty_id is not null then
    select w.job_id into war_job
      from public.job_warranties w
      where w.id = new.warranty_id and w.org_id = new.org_id;
    if war_job is null then
      raise exception 'warranty % is not in org %', new.warranty_id, new.org_id
        using errcode = 'check_violation';
    end if;
    select j.customer_id into war_cust from public.jobs j where j.id = war_job;
    if war_cust is distinct from new.customer_id then
      raise exception 'warranty % does not belong to customer %', new.warranty_id, new.customer_id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Only enforce capacity when the booking is (or becomes) live.
  if new.status in ('requested', 'confirmed') then
    -- Lock the slot row so concurrent books serialise on it.
    select capacity, org_id, active into slot_cap, slot_org, slot_active
      from public.service_booking_slots
      where id = new.slot_id
      for update;
    if slot_cap is null or slot_org <> new.org_id then
      raise exception 'slot % is not in org %', new.slot_id, new.org_id
        using errcode = 'check_violation';
    end if;
    if not slot_active then
      raise exception 'slot % is no longer bookable', new.slot_id
        using errcode = 'check_violation';
    end if;
    select count(*) into live_count
      from public.service_bookings b
      where b.slot_id = new.slot_id
        and b.status in ('requested', 'confirmed')
        and b.id is distinct from new.id;
    if live_count >= slot_cap then
      raise exception 'slot % is fully booked', new.slot_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.status = 'cancelled' and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;
  return new;
end $$;

drop trigger if exists service_bookings_guard on public.service_bookings;
create trigger service_bookings_guard
  before insert or update on public.service_bookings
  for each row execute function public.tg_service_bookings_guard();

drop trigger if exists service_booking_slots_set_updated_at on public.service_booking_slots;
create trigger service_booking_slots_set_updated_at
  before update on public.service_booking_slots
  for each row execute function public.tg_set_updated_at();

drop trigger if exists service_bookings_set_updated_at on public.service_bookings;
create trigger service_bookings_set_updated_at
  before update on public.service_bookings
  for each row execute function public.tg_set_updated_at();

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
-- Slots are standing org config that generate customer-facing availability:
-- admin writes, member reads (mirrors asset_service_schedules).
alter table public.service_booking_slots enable row level security;

drop policy if exists "service_booking_slots: members select" on public.service_booking_slots;
create policy "service_booking_slots: members select" on public.service_booking_slots
  for select using (org_id in (select public.current_org_ids()));

drop policy if exists "service_booking_slots: admins insert" on public.service_booking_slots;
create policy "service_booking_slots: admins insert" on public.service_booking_slots
  for insert with check (public.is_org_admin(org_id));

drop policy if exists "service_booking_slots: admins update" on public.service_booking_slots;
create policy "service_booking_slots: admins update" on public.service_booking_slots
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "service_booking_slots: admins delete" on public.service_booking_slots;
create policy "service_booking_slots: admins delete" on public.service_booking_slots
  for delete using (public.is_org_admin(org_id));

-- Bookings: org members read/insert/update; admins delete. (The portal writes on
-- the service-role admin client, scoped in code — RLS is the staff-side guard.)
alter table public.service_bookings enable row level security;

drop policy if exists "service_bookings: members select" on public.service_bookings;
create policy "service_bookings: members select" on public.service_bookings
  for select using (org_id in (select public.current_org_ids()));

drop policy if exists "service_bookings: members insert" on public.service_bookings;
create policy "service_bookings: members insert" on public.service_bookings
  for insert with check (org_id in (select public.current_org_ids()));

drop policy if exists "service_bookings: members update" on public.service_bookings;
create policy "service_bookings: members update" on public.service_bookings
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

drop policy if exists "service_bookings: admins delete" on public.service_bookings;
create policy "service_bookings: admins delete" on public.service_bookings
  for delete using (public.is_org_admin(org_id));
