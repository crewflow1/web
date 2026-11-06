-- R5 financial isolation — restrict SELECT/INSERT/UPDATE on the POST-SALE
-- billing tables to org ADMINS (owner/admin), closing a confirmed data exposure.
--
-- FINDING (pre-launch security audit, direct staff-JWT PostgREST probe): the
-- SELECT policies on invoices, invoice_payments and payments were
-- `org_id IN current_org_ids()` — i.e. ANY org member, including a restricted
-- `staff` user, could retrieve the ENTIRE organisation's billing records (every
-- invoice total and payment) via a direct authenticated API request, bypassing
-- the route/UI gates. The INSERT/UPDATE policies were likewise org-member-wide,
-- so a staff member could also write billing rows directly. The route middleware
-- and the (now-fixed) job-Overview card only hid this in the browser; the data
-- layer was open.
--
-- SCOPE — why NOT quotes / quote_line_items. Staff drafting, editing and sending
-- quotes is a DELIBERATE, tested workflow (__tests__/integration/rls/
-- quote-approval-authz.test.ts cases 5–8 are "legit": only the approval→'approved'
-- transition is gated, by a trigger). So quotes stay member-level by design; a
-- separate product decision governs whether staff quote *visibility* should
-- tighten. This migration covers only the post-sale billing tables, which have
-- no corresponding legitimate staff flow.
--
-- WHY ADMIN-SCOPING IS CORRECT AND SAFE (verified before writing this):
--   * The capability model (server/auth/capabilities.ts) grants financial
--     capabilities to OWNER (wildcard) and ADMIN (granted subset) only — a
--     `staff` role resolves to NO capabilities ("role !== 'admin' return []").
--     So no legitimate staff workflow reads or writes these tables. Authorised
--     site expenses live in the separate `finances`/costs table, which stays
--     member-open and is untouched here.
--   * Every member-client (RLS) reader/writer of these tables sits behind a
--     route or capability gate that only owner/admin pass (invoices/quotes/
--     payments/cash/reports/tax routes are staff-forbidden; payment + quote
--     writes require owner/admin capabilities). So an admin-scoped policy never
--     blocks a legitimate caller — the RETURNING on their INSERT/UPDATE still
--     reads back because the caller is an admin.
--   * All customer-portal, cron, api/v1 and automation paths use the SERVICE
--     ROLE client, which bypasses RLS entirely — unaffected.
--   * `is_org_admin(org_id)` is the exact predicate already used by the existing
--     `admins can delete` policies on these same tables (and it honours HQ
--     impersonation sessions), so this is consistent, not novel.
--
-- Defence-in-depth: the route/UI/capability gates remain; this adds the missing
-- DB-layer guarantee so the data cannot be retrieved or written by a direct API
-- request. Additive + reversible (a forward migration can restore the member
-- predicate); no data is modified. DELETE policies already admin-scoped — left
-- as-is.

do $$
declare
  t text;
begin
  foreach t in array array['invoices','invoice_payments','payments']
  loop
    -- SELECT — the confirmed read exposure.
    execute format('drop policy if exists %I on public.%I', t || ': members can select', t);
    execute format('drop policy if exists %I on public.%I', t || ': members select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (is_org_admin(org_id))',
      t || ': admins can select', t);

    -- INSERT — staff could otherwise create financial rows via direct API.
    execute format('drop policy if exists %I on public.%I', t || ': members can insert', t);
    execute format('drop policy if exists %I on public.%I', t || ': members insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (is_org_admin(org_id))',
      t || ': admins can insert', t);

    -- UPDATE.
    execute format('drop policy if exists %I on public.%I', t || ': members can update', t);
    execute format('drop policy if exists %I on public.%I', t || ': members update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id))',
      t || ': admins can update', t);
  end loop;
end $$;
