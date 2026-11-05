-- R5 commercial isolation (secondary tables) — price book + leads.
--
-- FINDING (pre-launch direct staff-JWT probe): both tables had org-member-wide
-- SELECT, so a restricted `staff` member could read them via the API even though
-- neither surface is in the staff navigation.
--   * price_book_items — the rate library a quote is built from (unit prices,
--     margins). /price-book is gated to management (price_book:view); no staff
--     reader exists. Scope all of SELECT/INSERT/UPDATE to owner/admin.
--   * leads — the sales pipeline (contact PII, estimated values). All in-app
--     readers are Sales (owner/admin) routes; the only staff-reachable path is
--     global search, which scopes via RLS. A lead CAN be assigned to a staff
--     member (leads.assigned_to), so SELECT = owner/admin OR the assignee — the
--     narrowest scope that preserves "a staff member sees a lead assigned to
--     them" while hiding the rest of the pipeline. Lead WRITES are a management
--     action (the intake form is owner/admin) but are left member-level here to
--     avoid changing an unverified write path; the read exposure is the finding.
--
-- Additive / reversible; no data modified. DELETE already admin-scoped.

-- price_book_items → owner/admin only.
drop policy if exists "price_book_items: members can select" on public.price_book_items;
create policy "price_book_items: admins can select" on public.price_book_items
  for select to authenticated using (is_org_admin(org_id));
drop policy if exists "price_book_items: members can insert" on public.price_book_items;
create policy "price_book_items: admins can insert" on public.price_book_items
  for insert to authenticated with check (is_org_admin(org_id));
drop policy if exists "price_book_items: members can update" on public.price_book_items;
create policy "price_book_items: admins can update" on public.price_book_items
  for update to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- leads → owner/admin see all; a staff member sees only leads assigned to them.
drop policy if exists "leads: members can select" on public.leads;
create policy "leads: scoped select" on public.leads
  for select to authenticated
  using (
    org_id in (select current_org_ids())
    and (is_org_admin(org_id) or assigned_to = auth.uid())
  );
