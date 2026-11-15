-- customers.portal_token (and customer_contacts.portal_token): the customer-portal
-- bearer credential is no longer readable through the Data API
-- (least-privilege enforcement — register ST-07a).
--
-- THE HOLE
-- --------
-- `customers: scoped select` deliberately shows a `staff` member the customers of the
-- jobs they are assigned to (they need the name, phone and site address). RLS is
-- row-level: the same row carries `portal_token`, the bearer credential behind
-- /customer-portal/<token>. So an assigned staff member could read the token and open
-- that customer's portal — invoices, quotes, payments (tables RLS denies staff
-- outright) — and act as the customer (e.g. accept a quote).
--
-- THE FIX — a column ACL
-- ----------------------
-- Table-level SELECT is replaced, for client roles, by a column-level grant on every
-- column EXCEPT portal_token. No client JWT (staff, admin or owner) can read the
-- credential any more; the "copy portal link" panel reads it server-side with the
-- service role after a `customers:view` capability check
-- (server/services/private-columns.ts → readCustomerPortalToken).
--   * `anon` and `authenticated` keep SELECT on all other columns (anon still has no
--     policy path to a row; removing its dead grants is register ST-12, not this change), so every existing explicit
--     column list and every PostgREST embed keeps working. A client `select=*` on
--     customers now fails (42501) — the app has none; the GDPR export moves customers
--     to its service-role lane (lib/gdpr/org-tables.json).
--   * INSERT / UPDATE / DELETE grants and all RLS policies are untouched: the
--     capability-gated rotate action still UPDATEs portal_token with the user JWT
--     (owner/admin only by RLS), it just cannot read it back.
--   * service_role (portal, e-mails, public API, crons) is unaffected.
--
-- NEW COLUMNS: a column added to public.customers later is NOT client-readable until it
-- is granted. __tests__/integration/rls/private-column-acl.test.ts fails on any column
-- that is neither granted nor listed as private, so this cannot be forgotten silently.
--
-- data-api:exempt: narrows an existing grant; adds no table.
-- Idempotent (revoke + re-grant from the live catalogue).
--
-- Safe to apply before the code deploys: NO — deploy the code first (or together).
--   The pre-change customer detail page selects portal_token with the user JWT and
--   would error (42501) for owners/admins until the new code is live.
-- Production precondition: none (no data is read or rewritten). Optional sanity count:
--   select count(*) from public.customers where portal_token is not null;
--
-- Rollback: grant select on public.customers, public.customer_contacts to authenticated, anon;
--   (reopens ST-07a)

do $$
declare
  t text;
  cols text;
begin
  -- customers: the live credential. customer_contacts: the per-contact credential the
  -- server will mint once contact access ships (none exist today; ST-04 already stops
  -- clients minting one) — closed now so it never becomes readable.
  foreach t in array array['customers', 'customer_contacts']
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
      into cols
      from pg_attribute a
     where a.attrelid = ('public.' || t)::regclass
       and a.attnum > 0
       and not a.attisdropped
       and a.attname <> all (array['portal_token']);

    -- A table-level REVOKE also clears any column-level SELECT grants.
    execute format('revoke select on public.%I from anon, authenticated', t);
    execute format('grant select (%s) on public.%I to anon, authenticated', cols, t);
  end loop;
end $$;

comment on column public.customers.portal_token is
  'Customer-portal bearer credential. NOT client-readable: no SELECT grant for anon / '
  'authenticated (20261341). Read server-side only, after a customers:view check.';
comment on column public.customer_contacts.portal_token is
  'Per-contact portal bearer credential. NOT client-readable (20261341).';
