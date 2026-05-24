-- Customer portal token — DEFAULT + backfill.
--
-- Real-URL audit (PR #102 era) found that newly created `customers`
-- ship with `portal_token = NULL`. The portal at
-- `/customer-portal/[token]` is unreachable until the operator
-- clicks "Rotate token" on the customer detail page. Every first
-- portal hand-off required an extra hidden step.
--
-- Fix:
--   1. Add `default gen_random_uuid()` to the column so every future
--      INSERT auto-mints a token regardless of which code path
--      (manual `/customers/new`, Migration OS commit, demo internal
--      org sidecar, /api/demo's CRM lead) created the row.
--   2. Backfill existing NULL rows with fresh UUIDs.
--
-- Safety:
--   - `coalesce` on the backfill prevents overwriting any non-null
--     value (no token rotation on already-active portals).
--   - The existing `rotateCustomerPortalToken` server action keeps
--     working unchanged — it sets the column to a fresh UUID and
--     the DEFAULT only fires when no value is provided.
--   - Customers with archived/deleted state stay in the same place
--     (the schema has no soft-delete flag on customers; rows are
--     hard-deleted via DELETE cascades, so there's nothing else to
--     skip).

alter table public.customers
  alter column portal_token set default gen_random_uuid();

update public.customers
   set portal_token = gen_random_uuid()
 where portal_token is null;
