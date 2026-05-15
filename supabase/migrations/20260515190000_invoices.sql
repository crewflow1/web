-- Invoices module — phase-3 extension after quotes.
--
-- Touches:
--   - new enum:        public.invoice_status (draft|sent|paid|overdue)
--   - new table:       public.invoices  (org-scoped; quote_id FK SET NULL)
--   - new function:    public.next_invoice_number(uuid) — picks per-org
--                      sequential number `INV-NNNN`
--   - RLS:             members can read; members can insert/update; admins
--                      can delete (per Phase-3 spec)
--
-- Sequential numbering is required by HMRC for VAT-registered businesses.
-- The picker function is NOT race-safe under heavy concurrent insert load
-- (no advisory lock) — acceptable for v1 single-writer UI. If we ever see
-- collisions, promote to a sequence + insert trigger.
--
-- Idempotent: enum / table / function all use IF NOT EXISTS or DROP …
-- IF EXISTS first; policies same.

-- ---------------------------------------------------------------------------
-- status enum
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'invoice_status') then
    create type public.invoice_status as enum ('draft', 'sent', 'paid', 'overdue');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- invoices table
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  -- nullable + SET NULL: invoices outlive their source quote for audit.
  quote_id    uuid references public.quotes(id) on delete set null,
  -- Per-org sequential number. UNIQUE within (org_id, number) below.
  number      text not null,
  amount      numeric(12, 2) not null default 0,  -- ex-VAT subtotal
  vat_total   numeric(12, 2) not null default 0,
  -- Stored generated column ensures total == amount + vat_total at all times.
  total       numeric(12, 2) generated always as (amount + vat_total) stored,
  status      public.invoice_status not null default 'draft',
  due_date    date,
  sent_at     timestamp with time zone,
  paid_at     timestamp with time zone,
  notes       text,
  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone not null default now()
);

-- Per-org unique invoice number (HMRC-required: invoices must be sequential
-- and unique). Global uniqueness across tenants is NOT required.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'invoices_org_number_key'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices add constraint invoices_org_number_key
      unique (org_id, number);
  end if;
end $$;

create index if not exists invoices_org_id_idx       on public.invoices (org_id);
create index if not exists invoices_org_status_idx   on public.invoices (org_id, status);
create index if not exists invoices_org_due_idx      on public.invoices (org_id, due_date);
create index if not exists invoices_quote_id_idx     on public.invoices (quote_id);

drop trigger if exists invoices_set_updated_at on public.invoices;
create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function public.tg_set_updated_at();

alter table public.invoices enable row level security;

-- RLS: members can read/insert/update own org rows; admins can delete.
drop policy if exists "invoices: members can select" on public.invoices;
create policy "invoices: members can select" on public.invoices for select to authenticated
using (org_id in (select public.current_org_ids()));

drop policy if exists "invoices: members can insert" on public.invoices;
create policy "invoices: members can insert" on public.invoices for insert to authenticated
with check (org_id in (select public.current_org_ids()));

drop policy if exists "invoices: members can update" on public.invoices;
create policy "invoices: members can update" on public.invoices for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));

drop policy if exists "invoices: admins can delete" on public.invoices;
create policy "invoices: admins can delete" on public.invoices for delete to authenticated
using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- next_invoice_number(target_org)
-- Returns the next sequential INV-NNNN for the given org, derived from the
-- highest existing number matching that pattern. Uses SECURITY DEFINER so
-- API code can call it without triggering RLS recursion on invoices.
-- ---------------------------------------------------------------------------
create or replace function public.next_invoice_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  select coalesce(
    max(cast(substring(number from 'INV-(\d+)') as int)),
    0
  ) + 1
  into next_num
  from public.invoices
  where org_id = target_org
    and number ~ '^INV-\d+$';

  return 'INV-' || lpad(next_num::text, 4, '0');
end;
$$;
