-- Issue #349 Phase 2 — invoice line-item snapshotting.
--
-- Phase 1 (20260915000000) anchored the invoice's CUSTOMER directly. This does
-- the same for its LINE ITEMS: an invoice's rendered lines came from
-- quote_line_items via quote_id, so a later quote edit silently rewrote a
-- historical invoice, and a deleted quote (quote_id is ON DELETE SET NULL) left
-- the invoice with a correct total and ZERO lines on its PDF. This makes the
-- lines an immutable, invoice-owned snapshot taken at creation.
--
-- The snapshot is created by an AFTER INSERT trigger on invoices — the sole
-- creation authority (CEO decision, Option A). The trigger runs in the invoice
-- insert's OWN transaction, so it is atomic (snapshot failure rolls the invoice
-- back) and covers EVERY writer automatically (manual POST, both quote-accept
-- paths, imports) with no app-code snapshot call to forget or duplicate.
--
-- Measured before writing this (linked project jzntbskdqdopzwdqwvkp,
-- read-only): 0 invoices, and 0 that are quote_id-null / quote-has-no-lines /
-- total-disagrees / dangling. Other environments were NOT measured; the backfill
-- below is written to be safe and idempotent regardless.

-- =========================================================================
-- 1. The snapshot table
-- =========================================================================
-- Fields are exactly those needed to reproduce the invoice independently
-- (copied from quote_line_items) plus the anchors + identity/timestamp. No
-- quote_id: a snapshot must not point back at the mutable source.
create table if not exists public.invoice_line_items (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  description  text not null,
  qty          numeric(12, 2) not null default 1,
  unit         text not null default 'item',
  unit_price   numeric(12, 2) not null default 0,
  vat_rate     numeric(5, 2)  not null default 20.00,
  line_total   numeric(12, 2) not null default 0,
  sort_order   integer not null default 0,
  created_at   timestamp with time zone not null default now(),
  -- Tenant integrity, the #351/#357 composite-FK pattern: a snapshot row may
  -- reference only an invoice in the SAME org. invoices_id_org_key (id, org_id)
  -- is the candidate key added in 20260911000000. ON DELETE CASCADE: deleting an
  -- invoice removes its snapshot; deleting a QUOTE can't (there is no quote_id).
  constraint invoice_line_items_invoice_org_fkey
    foreign key (invoice_id, org_id)
    references public.invoices (id, org_id)
    on delete cascade
);

comment on constraint invoice_line_items_invoice_org_fkey on public.invoice_line_items is
  'Tenant integrity: a snapshot line may reference only an invoice in the same '
  'org (composite FK, #351/#357 pattern). CASCADE ties the snapshot lifecycle to '
  'the invoice, never the quote.';

-- Deterministic ordering + the hot read (all lines for one invoice).
create index if not exists invoice_line_items_invoice_idx
  on public.invoice_line_items (invoice_id, sort_order);

alter table public.invoice_line_items enable row level security;

-- RLS mirrors quote_line_items: org members read their own; writes happen via
-- the SECURITY DEFINER trigger (and the service-role client), not tenant DML.
drop policy if exists "invoice_line_items: members can select" on public.invoice_line_items;
create policy "invoice_line_items: members can select" on public.invoice_line_items
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

-- =========================================================================
-- 2. The snapshot trigger — the sole creation authority
-- =========================================================================
create or replace function public._tg_invoices_snapshot_line_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Copy the source quote's lines into an immutable snapshot, in the SAME
  -- transaction as the invoice insert. Same-org only (li.org_id = NEW.org_id).
  -- A NULL quote_id, or a quote with no lines, copies zero rows — which is
  -- consistent with current rules: invoice totals live on the invoice itself
  -- (amount/vat_total/total), independent of line items, so a zero-line invoice
  -- is already valid and is NOT silently "completed" into something new here.
  if NEW.quote_id is not null then
    insert into public.invoice_line_items (
      invoice_id, org_id, description, qty, unit,
      unit_price, vat_rate, line_total, sort_order
    )
    select
      NEW.id, NEW.org_id, li.description, li.qty, li.unit,
      li.unit_price, li.vat_rate, li.line_total, li.sort_order
    from public.quote_line_items li
    where li.quote_id = NEW.quote_id
      and li.org_id = NEW.org_id
    order by li.sort_order;
  end if;
  return NEW;
  -- Any failure here propagates and rolls back the invoice insert — the
  -- atomicity guarantee. No completed invoice can exist without its snapshot.
end;
$fn$;

drop trigger if exists invoices_snapshot_line_items on public.invoices;
create trigger invoices_snapshot_line_items
  after insert on public.invoices
  for each row execute function public._tg_invoices_snapshot_line_items();

-- =========================================================================
-- 3. Legacy backfill — safe + idempotent
-- =========================================================================
-- For every existing quote-linked invoice with NO snapshot yet, copy its
-- quote's same-org lines. The `not exists` guard makes re-running a no-op (no
-- duplicate rows). Same-org join only; nothing else is touched. If an invoice's
-- quote/customer relationship were invalid the composite FK would reject the
-- insert and the migration would FAIL LOUDLY rather than write bad data.
insert into public.invoice_line_items (
  invoice_id, org_id, description, qty, unit,
  unit_price, vat_rate, line_total, sort_order
)
select
  i.id, i.org_id, li.description, li.qty, li.unit,
  li.unit_price, li.vat_rate, li.line_total, li.sort_order
from public.invoices i
join public.quote_line_items li
  on li.quote_id = i.quote_id
 and li.org_id = i.org_id
where i.quote_id is not null
  and not exists (
    select 1 from public.invoice_line_items existing
    where existing.invoice_id = i.id
  );
