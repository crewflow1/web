-- Merchant catalogue + order submissions — the data tables a live merchant link
-- populates, alongside merchant_connections (20261124000000).
--
-- WHAT THIS IS. Two DARK data tables:
--   1. merchant_catalogue_items    — the org's imported trade price file: one row
--      per merchant SKU + agreed price, mapped from a fetched price file by the
--      PURE parser (lib/integrations/merchants/price-file.ts).
--   2. merchant_po_submissions     — an append-only LEDGER of purchase orders
--      submitted electronically to a merchant (via the cXML builder,
--      lib/integrations/merchants/cxml.ts) and the merchant's ack.
-- Both clone the telematics_readings posture (20261103): org-pinned, a COMPOSITE
-- FK to merchant_connections (id, org_id) so a row can never bind to another
-- org's connection, member-read, service-role-write (a live import/submit runs as
-- service_role), and — for the ledger — append-only.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- No code path writes here today: an import/submit only runs after a merchant is
-- `connected`, which is unreachable without credentials + the flag + a contract.
-- Both tables stay empty until activation.
--
-- ── PURCHASE ORDERS CORE IS UNTOUCHED ───────────────────────────────────────
-- merchant_po_submissions references a purchase order by id ONLY (a plain uuid +
-- org_id, indexed) — it does NOT foreign-key into purchase_orders and adds no
-- column/trigger/constraint there. The merchant substrate connects INTO the
-- Purchase Orders core solely through the lib/integrations/merchants abstraction;
-- this ledger records the OUTCOME of a submission without coupling the two schemas.
--
-- Additive and reversible. To roll back:
--   drop table public.merchant_po_submissions;
--   drop table public.merchant_catalogue_items;

-- ── merchant_catalogue_items — the imported trade price file ──────────────────
create table if not exists public.merchant_catalogue_items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  provider           text not null check (provider in ('jp_corry', 'jewson', 'travis_perkins', 'haldane_fisher')),
  -- The connection that produced this catalogue (provenance). Composite-FK'd so
  -- it cannot name another org's connection.
  connection_id      uuid not null,
  -- The merchant's stock code — the join key onto purchase-order lines.
  sku                text not null,
  description        text not null default '',
  unit               text,
  pack_size          text,
  -- Agreed trade price in INTEGER PENCE (money is never a float here).
  unit_price_pence   integer not null check (unit_price_pence >= 0),
  currency           text not null default 'GBP',
  vat_code           text,
  effective_date     date,
  imported_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Cross-tenant control: the connection FK carries org_id.
  constraint merchant_catalogue_items_connection_org_fk
    foreign key (connection_id, org_id) references public.merchant_connections (id, org_id)
    on update cascade on delete cascade,
  -- One row per (org, merchant, SKU): a re-import UPSERTS the price, not dupes it.
  constraint merchant_catalogue_items_org_provider_sku_uniq unique (org_id, provider, sku)
);

-- The hot read: an org's catalogue for one merchant, by SKU.
create index if not exists merchant_catalogue_items_lookup_idx
  on public.merchant_catalogue_items (org_id, provider, sku);

drop trigger if exists merchant_catalogue_items_set_updated_at on public.merchant_catalogue_items;
create trigger merchant_catalogue_items_set_updated_at before update on public.merchant_catalogue_items
  for each row execute function public.tg_set_updated_at();

-- ── merchant_po_submissions — the append-only submission ledger ───────────────
create table if not exists public.merchant_po_submissions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  provider           text not null check (provider in ('jp_corry', 'jewson', 'travis_perkins', 'haldane_fisher')),
  connection_id      uuid not null,
  -- The CrewFlow purchase order this submission is for. A plain uuid — NO FK into
  -- purchase_orders (see header: the PO core is untouched). Org-pinned + indexed.
  purchase_order_id  uuid not null,
  -- SUBMISSION LIFECYCLE.
  --   queued       — recorded, not yet sent.
  --   submitted    — sent to the merchant, awaiting/without an explicit ack.
  --   acknowledged — the merchant accepted the order (carries external_order_ref).
  --   rejected     — the merchant declined the order (see response_text).
  --   error        — the submission failed (network / auth / build).
  status             text not null default 'queued'
                       check (status in ('queued', 'submitted', 'acknowledged', 'rejected', 'error')),
  -- The wire format used. Today only cXML; a small closed set.
  request_format     text not null default 'cxml' check (request_format in ('cxml', 'oci')),
  -- The merchant's own order reference, when it returns one.
  external_order_ref text,
  -- A short, NON-SECRET snippet of the merchant response (for the audit log). The
  -- request body (which carries the shared secret) is NEVER stored here.
  response_text      text,
  submitted_by       uuid references public.users(id) on delete set null,
  submitted_at       timestamptz,
  created_at         timestamptz not null default now(),

  -- Cross-tenant control: the connection FK carries org_id.
  constraint merchant_po_submissions_connection_org_fk
    foreign key (connection_id, org_id) references public.merchant_connections (id, org_id)
    on update cascade on delete cascade
);

-- The hot read: an org's submissions for a purchase order, newest-first.
create index if not exists merchant_po_submissions_po_idx
  on public.merchant_po_submissions (org_id, purchase_order_id, created_at desc);

-- ── APPEND-ONLY immutability trigger ─────────────────────────────────────────
-- A submission record is a historical fact — the outcome of a send at a moment.
-- Raising on UPDATE makes every row immutable for EVERY role (service-role
-- included), so a re-send writes a NEW ledger row rather than mutating history.
-- DELETE is left to RLS + cascade so org teardown / retention still work.
create or replace function public.tg_merchant_po_submissions_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'merchant_po_submissions rows are append-only and cannot be updated'
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists merchant_po_submissions_immutable on public.merchant_po_submissions;
create trigger merchant_po_submissions_immutable before update on public.merchant_po_submissions
  for each row execute function public.tg_merchant_po_submissions_immutable();

-- ── RLS — members read; writes are service-role only (the live import/submit) ─
-- A live import/submit runs as service_role, so authenticated has NO
-- insert/update/delete policy on either table — a tenant JWT can only READ its own
-- org's catalogue and submission ledger. Nothing is writable dark from any tenant
-- surface; the substrate is the sole writer, unreachable until activation.
alter table public.merchant_catalogue_items enable row level security;
alter table public.merchant_po_submissions enable row level security;

drop policy if exists "merchant_catalogue_items: members can select" on public.merchant_catalogue_items;
create policy "merchant_catalogue_items: members can select" on public.merchant_catalogue_items
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "merchant_po_submissions: members can select" on public.merchant_po_submissions;
create policy "merchant_po_submissions: members can select" on public.merchant_po_submissions
  for select to authenticated using (org_id in (select public.current_org_ids()));

-- anon: no surface on either table.
revoke all on table public.merchant_catalogue_items from anon;
revoke all on table public.merchant_po_submissions from anon;
