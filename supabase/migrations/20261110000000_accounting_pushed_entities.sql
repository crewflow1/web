-- Accounting pushed-entities ledger — the per-entity PUSH high-water-mark that
-- makes a provider sync PUSH-ONCE, so activating Xero / QuickBooks can never
-- duplicate an already-exported invoice or payment.
--
-- ── THE DUPLICATION THIS CLOSES ──────────────────────────────────────────────
-- Before this table, `syncToProvider` built the FULL invoice + payment history
-- (buildAccountingExport with no window / no high-water-mark) on EVERY sync and
-- handed it to the provider adapter. Xero derives its Idempotency-Key from the
-- WHOLE batch body, so once a second sync's batch differs by even one new row
-- ({A,B} → {A,B,C}) the key changes and Xero RE-CREATES A and B — and Xero
-- permits duplicate InvoiceNumbers, so activation silently doubles invoices.
-- (QuickBooks is safer via a per-row requestid, but that still leans on Intuit's
-- ~limited key-retention window and re-attempts the whole history each sync.)
--
-- ── WHAT THIS IS ─────────────────────────────────────────────────────────────
-- One row per (org, provider, entity_type, entity_id) the moment a provider has
-- ACCEPTED that entity (a 2xx on the create). It is the exclusion source: the
-- next sync reads this ledger and pushes ONLY the invoices / payments not yet
-- recorded here, so a re-push can never re-send a row the provider already has.
-- The write happens on success only — a FAILED push records nothing, so it is
-- retried on the next sync. Recording is idempotent (a row pushed once is simply
-- absent from every later batch; the UNIQUE key + ON CONFLICT DO NOTHING makes a
-- re-record a no-op).
--
-- `entity_id` is the CrewFlow primary key of the source row — invoices.id for an
-- invoice, invoice_payments.id for a payment — NOT the provider's id and NOT the
-- (reusable) invoice number. Keyed on the immutable DB id, the ledger answers
-- exactly "have we already pushed THIS row to THIS provider".
--
-- ── HOLDS NO MONEY, POSTS NOWHERE ───────────────────────────────────────────
-- Like accounting_export_log (20261093), this is metadata about an export event:
-- an org, a provider, an entity reference, a timestamp. There is NO amount
-- column, NO trigger, and it never writes invoices / invoice_payments / finances.
-- Recording a push carries no double-count hazard.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the expense_budgets posture) ────
-- Org-pinned with a composite candidate key `(id, org_id)`. Every member may
-- READ what has been pushed so the team can see sync progress; only an admin may
-- WRITE, because a provider push is an admin act (the same role that drives
-- syncToProvider). DB-enforced, not app-only — an app-only gate would leave
-- /rest/v1/accounting_pushed_entities open to any member holding a JWT.
--
-- APPEND-ONLY on the happy path: there is an UPDATE-less, DELETE-less lifecycle
-- for the record itself (a pushed row stays pushed). A provider DISCONNECT that
-- wants a clean re-sync deletes the org+provider rows via the admin-delete policy
-- below (so reconnecting a fresh Xero account re-pushes from zero); teardown is
-- ON DELETE CASCADE with the org.
--
-- Additive and reversible. To roll back:
--   drop table public.accounting_pushed_entities;
-- Migrate-first safe: the exclusion read is best-effort (absent table -> nothing
-- excluded, i.e. current behaviour), and the CSV export path never touches it.

-- ── accounting_pushed_entities ───────────────────────────────────────────────
create table if not exists public.accounting_pushed_entities (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- The bookkeeping provider this entity was pushed to.
  provider     text not null check (provider in ('xero', 'quickbooks')),
  -- WHICH kind of source row. Mirrors the canonical row type.
  entity_type  text not null check (entity_type in ('invoice', 'payment')),
  -- The CrewFlow primary key of the source row (invoices.id / invoice_payments.id)
  -- as text — the immutable identity a re-push is deduped against. NOT the
  -- provider's id and NOT the reusable invoice number.
  entity_id    text not null check (length(entity_id) > 0),
  pushed_at    timestamptz not null default now(),
  created_by   uuid references public.users(id) on delete set null,
  -- PUSH-ONCE: one row per (org, provider, entity_type, entity_id). The second
  -- successful record of the same entity is a no-op (ON CONFLICT DO NOTHING in
  -- the writer), so the ledger is idempotent under retries.
  constraint accounting_pushed_entities_uniq
    unique (org_id, provider, entity_type, entity_id),
  -- Composite-FK target for any future child (the 20261089 idiom).
  constraint accounting_pushed_entities_id_org_key unique (id, org_id)
);

-- The exclusion read filters by (org_id, provider, entity_type); index it.
create index if not exists accounting_pushed_entities_lookup_idx
  on public.accounting_pushed_entities (org_id, provider, entity_type);

-- ── RLS — members read, admins write (org-level integration configuration) ───
alter table public.accounting_pushed_entities enable row level security;

drop policy if exists "accounting_pushed_entities: members can select" on public.accounting_pushed_entities;
create policy "accounting_pushed_entities: members can select" on public.accounting_pushed_entities
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "accounting_pushed_entities: admins can insert" on public.accounting_pushed_entities;
create policy "accounting_pushed_entities: admins can insert" on public.accounting_pushed_entities
  for insert to authenticated with check (public.is_org_admin(org_id));

-- Admin DELETE exists so disconnecting a provider (or binding a fresh account)
-- can reset the high-water-mark and re-sync from zero. No UPDATE policy: a
-- pushed-entity record is not editable in place.
drop policy if exists "accounting_pushed_entities: admins can delete" on public.accounting_pushed_entities;
create policy "accounting_pushed_entities: admins can delete" on public.accounting_pushed_entities
  for delete to authenticated using (public.is_org_admin(org_id));
