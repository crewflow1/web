-- R5 quote isolation — quotes + quote_line_items are owner/admin only.
--
-- PRODUCT DECISION (D-13, founder-approved 2026-11-02): ordinary staff must not
-- retrieve, create, edit or delete company quotations through the UI, PostgREST,
-- APIs or RPCs. A dedicated estimating permission may be introduced later, but
-- the current member-wide access is removed — a staff JWT could otherwise read
-- every quote + line price via the API (there is no staff Sales UI).
--
-- An older test (quote-approval-authz) described staff quote drafting/sending as
-- intended and gated only the *approval* transition via a trigger
-- (enforce_quote_approval_authz). Per the decision, that staff access is NOT
-- preserved; the trigger remains as defence-in-depth but admin-only RLS is now
-- the primary gate (it fires before the trigger for non-admins).
--
-- PRESERVED: customer-portal acceptance + decline (acceptQuoteByToken /
-- declineQuoteByToken use the SERVICE-ROLE client → bypass RLS), the expiry cron
-- and all server flows (service role). Owner/admin quote lifecycle uses the
-- member client on owner/admin-gated routes, so is_org_admin passes. The
-- quote→invoice/job automation runs on the admin client. Verified before change.
--
-- `is_org_admin(org_id)` is the predicate the existing `admins can delete`
-- policies already use (impersonation-aware). Additive / reversible; no data
-- modified.

do $$
declare t text;
begin
  foreach t in array array['quotes','quote_line_items']
  loop
    execute format('drop policy if exists %I on public.%I', t || ': members can select', t);
    execute format('create policy %I on public.%I for select to authenticated using (is_org_admin(org_id))', t || ': admins can select', t);

    execute format('drop policy if exists %I on public.%I', t || ': members can insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (is_org_admin(org_id))', t || ': admins can insert', t);

    execute format('drop policy if exists %I on public.%I', t || ': members can update', t);
    execute format('create policy %I on public.%I for update to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id))', t || ': admins can update', t);
    -- DELETE policies are already admin-scoped (…: admins can delete) — left as-is.
  end loop;
end $$;
