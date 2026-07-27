-- Security fix (pre-launch) — scope customer-portal support tickets to ONE customer.
--
-- Root cause (HIGH, cross-customer data leak):
--   support_tickets has no customer linkage — only org_id. The customer
--   portal messages page (app/customer-portal/[token]/messages/page.tsx) runs
--   under the service-role admin client (the portal has no Supabase JWT, so
--   RLS cannot scope it) and could therefore only filter tickets by org_id.
--   The result: ANY portal visitor of an org saw EVERY customer's ticket
--   subjects and message previews for that org.
--
-- Fix: add a nullable customer_id foreign key so the portal can filter
--   `.eq("customer_id", <this customer>)` on read and stamp the owning
--   customer on write. RLS still cannot help the portal (admin client bypasses
--   it), so the scope is enforced explicitly in the query — this column is what
--   makes that possible.
--
-- ADDITIVE + IDEMPOTENT: nullable column (no table rewrite, no default), plus a
-- supporting btree index. No existing row's data or behaviour changes;
-- pre-existing tickets keep customer_id = NULL and simply stop appearing in the
-- portal list (safe — no cross-customer disclosure). HQ/tenant support inboxes
-- are unaffected (they never filtered on customer_id).
--
-- Deploy note: apply this migration BEFORE (or together with) the code change
-- that references support_tickets.customer_id, otherwise the portal messages
-- query errors on a missing column. The FK validation + index build take a
-- brief lock; support_tickets is tiny pre-launch so this is sub-second. If
-- re-applied after significant growth, prefer ADD COLUMN (no FK) + a separate
-- `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT`,
-- and build the index CONCURRENTLY outside a transaction.

alter table public.support_tickets
  add column if not exists customer_id uuid
    references public.customers (id) on delete set null;

create index if not exists support_tickets_customer_id_idx
  on public.support_tickets (customer_id);

-- Down (manual; not auto-run by the migration tool):
--   drop index if exists public.support_tickets_customer_id_idx;
--   alter table public.support_tickets drop column if exists customer_id;
