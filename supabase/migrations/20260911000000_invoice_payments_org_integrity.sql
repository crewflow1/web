-- Tenant integrity — an invoice_payments row may only reference an invoice
-- belonging to the SAME organisation.
--
-- Why this exists
-- ---------------
-- `invoice_payments` carries both `org_id` and `invoice_id`, and until now
-- NOTHING tied them together:
--
--   * the FK `invoice_payments_invoice_id_fkey` checks only that invoice_id
--     names SOME invoice — any org's;
--   * the RLS INSERT policy is `with check (public.is_org_member(org_id))`
--     (20260524000000_payment_tracking.sql), which constrains only the `org_id`
--     column the caller supplies — it never references invoice_id, so an insert
--     naming another org's invoice satisfies it;
--   * `_tg_invoice_payments_sync_status` is SECURITY DEFINER
--     (20260618000000_fix_invoice_payments_sync_trigger.sql), so it then reads
--     that foreign invoice and writes its status with RLS bypassed.
--
-- A crafted invoice_id therefore recorded a payment against another org's
-- invoice and moved its status. That was fixed in the application layer for the
-- one vulnerable writer (confirmBankMatch), but the CLASS stayed open: every
-- writer, present and future, had to remember the check, and nothing
-- structural caught the ones that didn't. This closes it at the database, where
-- forgetting is not possible.
--
-- Shape
-- -----
-- Postgres can only target a UNIQUE/PK constraint with a foreign key, and no
-- unique on (id, org_id) existed — so:
--
--   1. add a candidate key on invoices (id, org_id). `id` is already the
--      primary key, so this grants NO new uniqueness and cannot reject any row
--      the PK already admits; it exists solely to give the composite FK below
--      something to reference.
--   2. add the composite FK from invoice_payments (invoice_id, org_id).
--
-- Enforcement is by Postgres, so it holds for EVERY writer regardless of role —
-- the service-role/admin client and the postgres superuser included. That is the
-- point: RLS protects the row being inserted, never the foreign key it points
-- at, so RLS could never have closed this.
--
-- `invoice_payments_invoice_id_fkey` is deliberately LEFT IN PLACE. The
-- composite FK subsumes it, but dropping it is churn on a hot table for no
-- behavioural gain, and it remains a correct (if weaker) statement of the same
-- relationship. Smallest durable change: add only.
--
-- ON DELETE CASCADE mirrors the existing invoice_id FK, so deleting an invoice
-- keeps removing its payments exactly as before. ON UPDATE is left at the
-- default (NO ACTION): moving an invoice between organisations is not a
-- supported operation, and this makes the database say so.
--
-- Existing rows: verified against the linked project before writing this —
-- 0 rows violate `invoice_payments.org_id = invoices.org_id` (and 0 rows exist
-- at all), so both statements validate immediately. Should any violating row
-- exist in another environment, `add constraint` VALIDATES by default and the
-- migration will FAIL LOUDLY rather than silently drop or rewrite data.
--
-- No index is added: the unique constraint creates its own index on the
-- referenced side, and the referencing side is already served by the existing
-- `invoice_payments_invoice_idx (invoice_id)` prefix.

-- 1. Candidate key on invoices so the composite FK has a target.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_id_org_key'
  ) then
    alter table public.invoices
      add constraint invoices_id_org_key unique (id, org_id);
  end if;
end $$;

-- 2. The invariant: a payment's invoice must live in the payment's org.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoice_payments_invoice_org_fkey'
  ) then
    alter table public.invoice_payments
      add constraint invoice_payments_invoice_org_fkey
      foreign key (invoice_id, org_id)
      references public.invoices (id, org_id)
      on delete cascade;
  end if;
end $$;

comment on constraint invoice_payments_invoice_org_fkey on public.invoice_payments is
  'Tenant integrity: a payment may only reference an invoice in the same org. '
  'RLS cannot enforce this — its INSERT policy checks only the org_id column '
  'supplied by the caller, not the invoice the row points at.';
