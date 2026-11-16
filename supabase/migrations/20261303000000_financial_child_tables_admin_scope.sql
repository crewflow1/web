-- Financial CHILD tables: owner/admin only at the data layer
-- (adversarial tenant-isolation programme — register ST-05).
--
-- THE HOLE
-- --------
-- 20261275000000 scoped invoices / invoice_payments / payments to owner/admin after a
-- direct staff-JWT PostgREST probe read the whole org's billing records.
-- 20261277000000 did the same for price_book_items, and #1040 for quotes /
-- quote_line_items. Each closed the PARENT and left its children and siblings
-- member-wide, so the same probe, repeated by this programme against every org-scoped
-- table, still returned to a restricted `staff` JWT:
--
--   invoice_line_items       every invoice's lines: description, qty, unit price, total
--                            (the invoice itself is admin-only — its contents were not)
--   quote_versions           the frozen snapshot of every quote: subtotal / VAT / total
--                            and the full line_items jsonb (quotes are admin-only)
--   invoice_payment_intents  per-invoice card-payment attempts: amount, customer id,
--                            Stripe account / session / payment-intent ids
--   bank_statements          the org's uploaded bank statements
--   bank_statement_lines     every bank transaction (amount, description, reference) —
--                            and staff could INSERT and UPDATE them (re-match a line
--                            to a different invoice/payment)
--   quote_templates          saved quote templates …
--   quote_template_lines     … with their unit prices — the two siblings of
--                            price_book_items (lib/pricing/queries.ts: "these three
--                            tables"); staff could read, edit and DELETE them
--
-- A `staff` membership resolves to NO capabilities (server/auth/capabilities.ts), and
-- every in-app reader/writer of these seven tables sits behind an owner/admin route or
-- capability gate (invoices, quotes, payments/reconcile, price-book; the customer
-- portal, crons and webhooks use the service role). So there is no legitimate staff
-- flow to preserve — the route gates only hid the data in the browser.
--
-- THE FIX
-- -------
-- One RESTRICTIVE policy per table: `is_org_admin(org_id)` for every command, for the
-- authenticated role. A restrictive policy is ANDed with the existing permissive
-- ones, so:
--   * it can only ever REMOVE access — nothing here widens anything;
--   * the existing permissive policies (which still supply the org-membership
--     predicate, and any narrower per-command rule) are left exactly as they are —
--     this migration drops and alters nothing;
--   * a future permissive policy added to one of these tables cannot accidentally
--     re-open it to staff.
-- `is_org_admin` is the predicate the precedent migrations use; it honours HQ
-- impersonation sessions. service_role bypasses RLS and is unaffected.
--
-- DELIBERATELY NOT INCLUDED (recorded in the register as observations, not changed):
--   * hmrc_submissions — member-wide SELECT is an asserted design decision
--     (__tests__/integration/rls/hmrc-connections.test.ts "a MEMBER may READ
--     submissions"); changing it needs a product decision, not a drive-by.
--   * expense_drafts — members INSERT (receipt capture); read scope is tied to that flow.
--
-- data-api:exempt: policy-only change; adds no table and no grant.
-- Additive, idempotent (drop policy if exists on the NEW policy name only).
--
-- Rollback (manual, not recommended — it reopens ST-05):
--   drop policy "<table>: admins only (restrictive)" on public.<table>;

do $$
declare
  t text;
  pol text;
begin
  foreach t in array array[
    'invoice_line_items',
    'quote_versions',
    'invoice_payment_intents',
    'bank_statements',
    'bank_statement_lines',
    'quote_templates',
    'quote_template_lines'
  ]
  loop
    pol := t || ': admins only (restrictive)';
    execute format('drop policy if exists %I on public.%I', pol, t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      'using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id))',
      pol, t);
    execute format(
      'comment on policy %I on public.%I is %L',
      pol, t,
      'ST-05: financial child/sibling table — owner/admin only at the data layer. '
      'RESTRICTIVE (ANDed with the permissive org-membership policies), so it can only '
      'remove access. A staff JWT must not read or write this via the Data API.');
  end loop;
end $$;
