-- Slice 3: Customer portal access token.
--
-- Adds customers.portal_token: a unique, unguessable UUID that grants
-- read-only-plus-lifecycle access to a customer's quotes + invoices
-- via /customer-portal/<token>. Generated on demand by the owner from
-- the customer detail page; regeneration revokes the old link.
--
-- Mechanism mirrors the existing quotes.public_token (URL = auth, no
-- login required); this lives at customer scope so a single link
-- gives the customer access to everything you've sent them.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS.

alter table public.customers
  add column if not exists portal_token uuid;

create unique index if not exists customers_portal_token_idx
  on public.customers (portal_token)
  where portal_token is not null;
