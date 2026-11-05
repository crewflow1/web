-- R5 customer-data isolation — staff see only the customers on their ASSIGNED
-- jobs, not the whole organisation's CRM.
--
-- FINDING (pre-launch security audit, direct staff-JWT PostgREST probe): the
-- `customers` SELECT policy was `org_id IN current_org_ids()`, so a restricted
-- `staff` member could read the ENTIRE organisation's customer list — names,
-- emails, phones, addresses, company/VAT numbers — via a direct API request,
-- even though the /customers CRM is not in the staff navigation. INSERT/UPDATE
-- were likewise org-member-wide.
--
-- INTENDED staff need (preserved): a staff member assigned to a job must see
-- that job's customer (the job Overview shows the customer name + site address).
-- That is the ONLY legitimate staff customer access, so SELECT is scoped to the
-- customers referenced by the caller's assigned jobs, plus full access for
-- owner/admin. Customer CRM writes are an owner/admin action (the /customers
-- create/edit pages are management-only; portal/import writes use the service
-- role, which bypasses RLS), so INSERT/UPDATE move to admin-only.
--
-- Additive / reversible; no data modified. DELETE already admin-scoped.

-- Customers of the caller's assigned jobs. SECURITY DEFINER so the job→customer
-- hop does not re-enter jobs RLS (mirrors my_assigned_job_ids()).
create or replace function public.my_assigned_customer_ids()
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct j.customer_id
    from public.jobs j
   where j.id in (select public.my_assigned_job_ids())
     and j.customer_id is not null;
$$;
revoke all on function public.my_assigned_customer_ids() from public, anon;
grant execute on function public.my_assigned_customer_ids() to authenticated, service_role;

-- SELECT — owner/admin see all; staff see only assigned-job customers.
drop policy if exists "customers: members can select" on public.customers;
drop policy if exists "customers: members select" on public.customers;
create policy "customers: scoped select" on public.customers
  for select to authenticated
  using (
    org_id in (select current_org_ids())
    and (is_org_admin(org_id) or id in (select my_assigned_customer_ids()))
  );

-- INSERT / UPDATE — owner/admin only (no staff UI write flow; portal/import use
-- the service role).
drop policy if exists "customers: members can insert" on public.customers;
create policy "customers: admins can insert" on public.customers
  for insert to authenticated with check (is_org_admin(org_id));

drop policy if exists "customers: members can update" on public.customers;
create policy "customers: admins can update" on public.customers
  for update to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id));
