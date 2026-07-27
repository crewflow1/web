-- Customer portal token — optional expiry + usage tracking.
--
-- The portal token (customers.portal_token, a v4 UUID) is the ENTIRE auth
-- surface for the customer portal: there is no JWT, and knowledge of the UUID
-- is the credential. Until now every token was permanently live from the moment
-- its row was inserted (default gen_random_uuid()), with no way to time-bound it
-- and no record of use. This adds both, additively, so no existing link breaks.
--
-- Both columns are NULLABLE with no default:
--   portal_token_expires_at    NULL  = never expires (preserves today's
--                                      behaviour for every existing and future
--                                      row — nothing is time-bounded unless an
--                                      expiry is explicitly set).
--   portal_token_last_used_at  NULL  = never used (or not yet touched).
--
-- So this migration alone invalidates NO link: a row with no expiry stays valid
-- exactly as before. Expiry is opt-in.
--
-- Enforcement lives in ONE place — loadCustomerByPortalToken (_helpers.ts) —
-- which every portal read and write already funnels through (11 call sites,
-- verified). It is NOT enforced by RLS or a DB constraint: the loader runs on
-- the service-role client (the token is the auth), so the check is application
-- logic at the single chokepoint, and pages/actions inherit it.
--
-- last_used_at is TELEMETRY, never authority. It is written by a debounced,
-- fire-and-forget touch AFTER a successful load; its failure never blocks a
-- valid request, and expiry never depends on it. The debounce is enforced in
-- the UPDATE's own WHERE (last_used_at IS NULL OR older than the interval), so
-- it holds under concurrency with no app state — the same "let Postgres decide
-- whether to write" pattern used by invoice_reminders and the automation claim.
--
-- Measured before writing this: 0 customers / 0 tokens in the linked project
-- (jzntbskdqdopzwdqwvkp). Other environments were NOT measured. The change is
-- safe regardless — additive nullable columns, no backfill, no default.

alter table public.customers
  add column if not exists portal_token_expires_at   timestamp with time zone,
  add column if not exists portal_token_last_used_at timestamp with time zone;

comment on column public.customers.portal_token_expires_at is
  'Optional expiry for the portal token. NULL = never expires (default, so no '
  'existing link is invalidated). Enforced ONLY in loadCustomerByPortalToken, '
  'the single portal auth chokepoint — an expired token fails closed to null.';
comment on column public.customers.portal_token_last_used_at is
  'Telemetry: last successful portal auth with this token. Written by a '
  'debounced fire-and-forget touch after a valid load; never authoritative, '
  'never a precondition for access.';

-- Partial index for the debounced touch (WHERE portal_token = $1 AND
-- last_used_at is stale). The token lookup itself is already served by the
-- existing unique index on portal_token; this supports operational "recently
-- active links" queries without touching the hot auth path's plan.
create index if not exists customers_portal_last_used_idx
  on public.customers (portal_token_last_used_at desc)
  where portal_token is not null;
