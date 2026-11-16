-- D-17 — staff FIELD operations at the data layer.
--
-- WHY
-- ---
-- 20261340 made every write on the operations tables owner/admin-only. That closed the
-- direct-API holes, but it also took away ordinary construction duties the founder has
-- ruled staff must keep (D-17, 2026-11-15): scan / inspect / report a defect / take an
-- asset into their own custody, log fuel, issue / transfer / count stock, record goods
-- received. This migration re-opens EXACTLY those shapes — each bound to the caller's
-- own identity, the right lifecycle state and the matching capability — and nothing
-- wider. Approvals, adjustments, corrections, voids, templates, suppliers, purchase
-- orders and every price/value column stay owner/admin (or explicit-grant) only.
--
-- It also closes two self-approval holes the member-level policies left open
-- (material_requests, expense_drafts): a staff member could PATCH / INSERT a row straight
-- to 'approved' through the Data API.
--
-- HOW
-- ---
-- * public.org_is_writable(org)       — org is one of the caller's own AND its status is active|trial. Every other
--   status (pending / suspended / rejected / cancelled — and any future one) is read-only at the data layer: a
--   pending company is locked out by the application, so a direct Data API write must not get around that.
--   Onboarding writes (creating the company, accepting an invite, HQ approval) run with the service role.
-- * public.has_org_capability(org,m,a) — SECURITY DEFINER mirror of lib/auth/capability-rules
--   canWith: caller must be a member; owner passes; admin/staff pass the FIELD baseline
--   (view/create/edit on a *_field module); an admin may also hold an explicit grant (on the
--   module, or on a field module's parent); a staff member never does; a held org passes only 'view'. Returns false (never raises) for
--   a non-member, so it is safe inside a policy.
-- * The "<table>: admin-only <cmd>" RESTRICTIVE policies from 20261340 are replaced, for the
--   tables below, by "<table>: admin or field <cmd>". Restrictive = ANDed with the existing
--   permissive policies, so this can only ever narrow access relative to the pre-20261340
--   world and re-opens access only relative to 20261340.
-- * The stock ledger trigger admits a client JWT only as an admin, or as a field user posting
--   an issue / transfer / goods-receipt row as themselves.
--
-- Code + migration must deploy TOGETHER with 20261341–45 and the app change in this branch:
-- apply 20261346 before (or with) the code. Applying it alone is safe (it widens nothing the
-- current production code can reach). Rollback: re-run the 20261340 policy block for the
-- listed tables and restore tg_stock_movements_admin_writer from 20261340.
--
-- data-api:exempt: functions + policies + trigger only; adds no table and no grant beyond EXECUTE.

-- 1. Predicates ---------------------------------------------------------------------------
create or replace function public.org_is_writable(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Scoped to the caller's OWN orgs (current_org_ids(): memberships + an active HQ
  -- impersonation): a non-member / anon always gets false, so this can never be used to
  -- probe whether another tenant is active.
  select exists (
    select 1
      from public.organizations o
     where o.id = p_org
       and o.status in ('active', 'trial')
       and p_org in (select public.current_org_ids())
  );
$$;

create or replace function public.has_org_capability(p_org uuid, p_module text, p_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_mid uuid;
  v_parent text;
begin
  if auth.uid() is null or p_org is null then return false; end if;
  select m.role, m.id into v_role, v_mid
    from public.memberships m
   where m.org_id = p_org and m.user_id = auth.uid()
   limit 1;
  if v_role is null then return false; end if;                 -- not a member of p_org
  if p_action <> 'view' and not public.org_is_writable(p_org) then
    return false;                                              -- held org: read-only
  end if;
  if v_role = 'owner' then return true; end if;
  if v_role not in ('admin', 'staff') then return false; end if;

  v_parent := case p_module
    when 'assets_field' then 'assets'
    when 'fuel_field' then 'fleet'
    when 'stock_field' then 'stock'
    when 'goods_receiving_field' then 'purchase_orders'
    when 'job_costs_field' then 'expenses'
    when 'site_safety_field' then 'site_safety'
    else null
  end;
  if v_parent is not null and p_action in ('view', 'create', 'edit') then
    return true;                                               -- FIELD baseline
  end if;

  if v_role = 'staff' then return false; end if;               -- staff: baseline only; stray grants ignored

  return exists (
    select 1 from public.membership_permissions mp
     where mp.membership_id = v_mid
       and mp.module in (p_module, coalesce(v_parent, p_module), '*')
       and mp.action in (p_action, 'manage', '*')
  );
end $$;

comment on function public.has_org_capability(uuid, text, text) is
  'D-17: DB mirror of lib/auth/capability-rules canWith. Member of p_org required; owner passes; '
  'admin/staff pass the *_field baseline (view/create/edit) or an explicit grant; a held org '
  'passes only view. Returns false (never raises) for non-members — safe in a policy.';

revoke all on function public.org_is_writable(uuid) from public;
revoke all on function public.has_org_capability(uuid, text, text) from public;
grant execute on function public.org_is_writable(uuid) to authenticated, service_role;
grant execute on function public.has_org_capability(uuid, text, text) to authenticated, service_role;

-- 2. Field policies -----------------------------------------------------------------------
-- (drop the 20261340 admin-only policy for the command, add the admin-or-field one)
create or replace procedure pg_temp.field_policy(
  p_table text, p_cmd text, p_using text, p_check text
) language plpgsql as $$
declare
  v_old text := p_table || ': admin-only ' || p_cmd;
  v_new text := p_table || ': admin or field ' || p_cmd;
begin
  if length(v_new) > 63 then raise exception 'policy name too long: %', v_new; end if;
  execute format('drop policy if exists %I on public.%I', v_old, p_table);
  execute format('drop policy if exists %I on public.%I', v_new, p_table);
  if p_cmd = 'insert' then
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (%s)',
      v_new, p_table, p_check);
  elsif p_cmd = 'update' then
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (%s) with check (%s)',
      v_new, p_table, p_using, p_check);
  else
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (%s)',
      v_new, p_table, p_using);
  end if;
  execute format('comment on policy %I on public.%I is %L', v_new, p_table,
    'D-17: owner/admin, or a field user acting as themselves in the permitted lifecycle state. RESTRICTIVE.');
end $$;

-- asset inspections: a crew member starts / completes their OWN inspection.
call pg_temp.field_policy('asset_inspections', 'insert', null,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'assets_field', 'create')
     and created_by = auth.uid() and status = 'draft')$c$);
call pg_temp.field_policy('asset_inspections', 'update',
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'assets_field', 'edit')
     and created_by = auth.uid())$c$,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'assets_field', 'edit')
     and created_by = auth.uid() and status in ('draft', 'issued'))$c$);

-- defect report: a maintenance case raised by the caller, in the 'reported' state.
call pg_temp.field_policy('asset_maintenance_cases', 'insert', null,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'assets_field', 'create')
     and reported_by = auth.uid() and status = 'reported')$c$);

-- custody: take an asset into one's OWN custody and return one's own; transfers stay admin.
call pg_temp.field_policy('asset_assignments', 'insert', null,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'assets_field', 'edit')
     and assignee_id = auth.uid() and assigned_by = auth.uid() and status = 'open')$c$);
call pg_temp.field_policy('asset_assignments', 'update',
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'assets_field', 'edit')
     and assignee_id = auth.uid())$c$,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'assets_field', 'edit')
     and assignee_id = auth.uid() and status in ('open', 'closed'))$c$);

-- A crew member can SEE the custody records they hold (their own information) — without
-- this the INSERT ... RETURNING of their own check-out would fail the SELECT policy.
drop policy if exists "asset_assignments: assignee reads own" on public.asset_assignments;
create policy "asset_assignments: assignee reads own" on public.asset_assignments
  for select to authenticated
  using (assignee_id = auth.uid() and org_id in (select public.current_org_ids()));
comment on policy "asset_assignments: assignee reads own" on public.asset_assignments is
  'D-17: a user reads the custody records where they are the assignee (own information).';

-- fuel: log a fill as oneself. Editing / deleting a log stays admin.
call pg_temp.field_policy('asset_fuel_logs', 'insert', null,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'fuel_field', 'create')
     and created_by = auth.uid())$c$);

-- goods received: record a delivery as oneself (draft -> posted). Void stays admin.
call pg_temp.field_policy('goods_received_notes', 'insert', null,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'goods_receiving_field', 'create')
     and created_by = auth.uid() and status = 'draft')$c$);
call pg_temp.field_policy('goods_received_notes', 'update',
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'goods_receiving_field', 'edit')
     and created_by = auth.uid())$c$,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'goods_receiving_field', 'edit')
     and created_by = auth.uid() and status in ('draft', 'posted'))$c$);
call pg_temp.field_policy('goods_received_lines', 'insert', null,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'goods_receiving_field', 'create')
     and exists (select 1 from public.goods_received_notes g
                  where g.id = goods_received_note_id and g.org_id = goods_received_lines.org_id
                    and g.created_by = auth.uid() and g.status = 'draft'))$c$);

-- goods received: the crew must be able to READ the order they are receiving against — only while
-- it is open for receipt (sent / partially received) — and its lines. Draft, received and
-- cancelled orders stay owner/admin-only. (Order and line prices are visible on an open order:
-- accepted residual, recorded in PERMISSION-MATRIX.md.)
drop policy if exists "purchase_orders: field reads open orders" on public.purchase_orders;
create policy "purchase_orders: field reads open orders" on public.purchase_orders
  for select to authenticated
  using (status in ('sent', 'partially_received')
         and public.has_org_capability(org_id, 'goods_receiving_field', 'view'));
drop policy if exists "po_line_items: field reads open orders" on public.purchase_order_line_items;
create policy "po_line_items: field reads open orders" on public.purchase_order_line_items
  for select to authenticated
  using (exists (select 1 from public.purchase_orders po
                  where po.id = purchase_order_id and po.org_id = purchase_order_line_items.org_id
                    and po.status in ('sent', 'partially_received'))
         and public.has_org_capability(org_id, 'goods_receiving_field', 'view'));

-- stock count: record a counted quantity on a session that is open for counting. Opening,
-- posting variances and cancelling a session stay admin.
call pg_temp.field_policy('stocktake_lines', 'update',
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'stock_field', 'edit')
     and exists (select 1 from public.stocktake_sessions s
                  where s.id = session_id and s.org_id = stocktake_lines.org_id and s.status = 'counting'))$c$,
  $c$public.is_org_admin(org_id) or (public.has_org_capability(org_id, 'stock_field', 'edit')
     and counted_by = auth.uid() and posted_movement_id is null and posted_variance is null
     and exists (select 1 from public.stocktake_sessions s
                  where s.id = session_id and s.org_id = stocktake_lines.org_id and s.status = 'counting'))$c$);

-- 3. Stock ledger -------------------------------------------------------------------------
create or replace function public.tg_stock_movements_admin_writer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Client JWTs only. service_role and JWT-less sessions (crons, migrations, psql) pass.
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and not public.is_org_admin(new.org_id)
     and not (
       public.has_org_capability(new.org_id, 'stock_field', 'create')
       and new.actor_id = auth.uid()
       and new.movement_type in ('issue', 'transfer_out', 'transfer_in', 'receipt')
     ) then
    raise exception 'Forbidden: only an owner/admin, or a field user issuing / transferring / receiving as themselves, may record this stock movement'
      using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.tg_stock_movements_admin_writer() is
  'Least privilege (ST-11 / D-17): a client JWT may add a stock movement only as an owner/admin, '
  'or as a field user recording an issue / transfer / goods receipt as themselves. Adjustments and '
  'corrections stay owner/admin — also inside the SECURITY DEFINER stock RPCs.';

-- 4. Self-approval holes ------------------------------------------------------------------
-- A member could PATCH a material request straight to 'approved' / 'fulfilled' (the
-- permissive "members can update" policy has no state check), or INSERT an expense draft
-- already 'approved'. Decisions are owner/admin (and the app's capability check).
drop policy if exists "material_requests: no member decision" on public.material_requests;
create policy "material_requests: no member decision" on public.material_requests
  as restrictive for update to authenticated
  using (true)
  with check (
    public.is_org_admin(org_id)
    or (status in ('draft', 'submitted', 'cancelled') and decided_by is null and decided_at is null)
  );
comment on policy "material_requests: no member decision" on public.material_requests is
  'D-17: only an owner/admin may move a material request into a decided state. RESTRICTIVE.';

drop policy if exists "material_requests: no member decided insert" on public.material_requests;
create policy "material_requests: no member decided insert" on public.material_requests
  as restrictive for insert to authenticated
  with check (
    public.is_org_admin(org_id)
    or (status in ('draft', 'submitted') and decided_by is null and decided_at is null)
  );
comment on policy "material_requests: no member decided insert" on public.material_requests is
  'D-17: a member may only raise a request in draft / submitted. RESTRICTIVE.';

drop policy if exists "expense_drafts: no member approved insert" on public.expense_drafts;
create policy "expense_drafts: no member approved insert" on public.expense_drafts
  as restrictive for insert to authenticated
  with check (
    public.is_org_admin(org_id)
    or (status = 'extracted' and approved_by is null and approved_at is null
        and finance_id is null and rejected_at is null)
  );
comment on policy "expense_drafts: no member approved insert" on public.expense_drafts is
  'D-17: a member may submit a PENDING (extracted) cost entry only; approval is owner/admin. RESTRICTIVE.';

-- 5. Site safety: DRAFT vs APPROVE ---------------------------------------------------------
-- Drafting is a field duty; issuing / superseding / withdrawing a risk assessment or
-- issuing / activating / suspending / closing a permit is an approval (site_safety:approve:
-- the owner, or an admin holding the grant). Before this, any member could PATCH the status
-- straight to 'issued' through the Data API.
drop policy if exists "risk_assessments: publish needs approval" on public.risk_assessments;
create policy "risk_assessments: publish needs approval" on public.risk_assessments
  as restrictive for update to authenticated
  using (true)
  with check (status = 'draft' or public.has_org_capability(org_id, 'site_safety', 'approve'));
drop policy if exists "risk_assessments: publish needs approval ins" on public.risk_assessments;
create policy "risk_assessments: publish needs approval ins" on public.risk_assessments
  as restrictive for insert to authenticated
  with check (status = 'draft' or public.has_org_capability(org_id, 'site_safety', 'approve'));

drop policy if exists "permits_to_work: issue needs approval" on public.permits_to_work;
create policy "permits_to_work: issue needs approval" on public.permits_to_work
  as restrictive for update to authenticated
  using (true)
  with check (status in ('draft', 'cancelled') or public.has_org_capability(org_id, 'site_safety', 'approve'));
drop policy if exists "permits_to_work: issue needs approval ins" on public.permits_to_work;
create policy "permits_to_work: issue needs approval ins" on public.permits_to_work
  as restrictive for insert to authenticated
  with check (status = 'draft' or public.has_org_capability(org_id, 'site_safety', 'approve'));

-- 6. Held companies (pending / suspended / rejected / cancelled) ---------------------------
-- D-17: block ordinary operational WRITES; reads stay (the owner keeps read-only access for
-- billing, export and recovery — see server/auth/session.ts). A RESTRICTIVE write policy on
-- every org-scoped table that clients can write, except the billing / export / recovery /
-- security-settings tables below, which an owner of a held company must still be able to use.
-- Triggers fire INSIDE SECURITY DEFINER functions (which skip RLS), so this closes the
-- RPC bypass: record_stock_*, add_/remove_job_worker, append_/remove_job_photo,
-- certify_valuation, generate_valuation_invoice, marketplace_submit_listing, ... all write
-- as the table owner and would otherwise let an admin of a held company keep writing.
create or replace function public.tg_held_org_write_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_org uuid;
begin
  -- Client JWTs only; service_role and JWT-less sessions (crons, migrations, HQ) pass.
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then v_org := old.org_id; else v_org := new.org_id; end if;
  -- Only a MEMBER of a non-writable org is refused here. A non-member is left to RLS / the
  -- function's own membership guard, which refuse with their own (accurate) error.
  if v_org is not null and v_org in (select public.current_org_ids()) and not public.org_is_writable(v_org) then
    raise exception 'Forbidden: this company is not active (pending, suspended, rejected or cancelled) and is read-only'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

comment on function public.tg_held_org_write_guard() is
  'D-17: refuses a client-JWT write (incl. inside SECURITY DEFINER RPCs) to an org that is not active / trial.';

do $$
declare
  r record;
  cmd text;
  pol text;
  v_client_writable boolean;
begin
  for r in
    select c.oid as reloid, c.relname as t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
     where c.relkind = 'r'
       and c.relrowsecurity
       and c.relname not in (
         'organizations', 'memberships', 'membership_permissions', 'org_subscriptions',
         'billing_invoices', 'subscription_cancellations', 'org_data_exports',
         'impersonation_sessions', 'permission_events'
       )
       and c.relname not like 'billing\_%' escape '\'
       and c.relname not like 'gdpr\_%' escape '\'
  loop
    -- (a) the write TRIGGER goes on EVERY org-scoped table, including tables clients cannot
    --     write directly: those are written by SECURITY DEFINER RPCs, which skip RLS.
    execute format('drop trigger if exists held_org_write_guard on public.%I', r.t);
    execute format('create trigger held_org_write_guard before insert or update or delete on public.%I for each row execute function public.tg_held_org_write_guard()', r.t);

    -- (b) the RESTRICTIVE policies only where a client can write directly.
    v_client_writable :=
         has_table_privilege('authenticated', r.reloid, 'INSERT')
      or has_table_privilege('authenticated', r.reloid, 'UPDATE')
      or has_table_privilege('authenticated', r.reloid, 'DELETE');
    if not v_client_writable then continue; end if;
    foreach cmd in array array['insert', 'update', 'delete'] loop
      pol := left(r.t, 40) || ': held org read-only ' || cmd;
      execute format('drop policy if exists %I on public.%I', pol, r.t);
      if cmd = 'insert' then
        execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.org_is_writable(org_id))', pol, r.t);
      elsif cmd = 'update' then
        execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.org_is_writable(org_id)) with check (public.org_is_writable(org_id))', pol, r.t);
      else
        execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.org_is_writable(org_id))', pol, r.t);
      end if;
    end loop;
  end loop;
end $$;

-- 7. Who may even READ a non-active company (D-17 reconciliation) ---------------------------
-- The application already locks every non-owner member of a suspended / cancelled company out on
-- /access-pending, and locks a pending / rejected company out entirely. The database must say the
-- same thing, or a member who is locked out of the UI can still read the company's data straight
-- through the Data API. current_org_ids / is_org_member / is_org_admin are the three predicates the
-- policies are built on, so tightening them applies the rule to every table and every SECURITY
-- DEFINER guard at once:
--     active / trial          — every member, as before
--     suspended / cancelled   — the OWNER only (read-only: the restrictive policies + trigger above
--                               refuse every write) — billing, export and recovery stay reachable
--     pending / rejected      — nobody (onboarding and HQ approval use the service role)
-- Active HQ impersonation is unchanged (HQ reads the tenant it is helping).
-- The organisations row itself (name, status — what the lock screen shows) stays readable to its
-- own members, or the lock screen could not tell them why they are locked out.
create or replace function public.org_status_admits(p_status text, p_role text)
returns boolean
language sql
immutable
as $$
  select p_status in ('active', 'trial')
      or (p_status in ('suspended', 'cancelled') and p_role = 'owner');
$$;
revoke all on function public.org_status_admits(text, text) from public;
grant execute on function public.org_status_admits(text, text) to authenticated, service_role;

create or replace function public.current_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  -- 1. Active impersonation: the operator sees ONLY the target org(s). (unchanged)
  select target_org_id
    from public.impersonation_sessions
   where admin_user_id = auth.uid()
     and ended_at is null
     and started_at > now() - interval '24 hours'

  union all

  -- 2. No active session: the orgs the caller belongs to AND is admitted to by the org's status
  --    (see above). The NOT EXISTS guard keeps the two branches mutually exclusive. (unchanged)
  select m.org_id
    from public.memberships m
    join public.organizations o on o.id = m.org_id
   where m.user_id = auth.uid()
     and public.org_status_admits(o.status, m.role)
     and not exists (
       select 1
         from public.impersonation_sessions
        where admin_user_id = auth.uid()
          and ended_at is null
          and started_at > now() - interval '24 hours'
     );
$$;

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.memberships m
      join public.organizations o on o.id = m.org_id
     where m.user_id = auth.uid() and m.org_id = target_org
       and public.org_status_admits(o.status, m.role)
  );
$$;

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1
        from public.impersonation_sessions
       where admin_user_id = auth.uid()
         and ended_at is null
         and started_at > now() - interval '24 hours'
    )
    then
      -- During impersonation: admin ONLY in the impersonated org(s). (unchanged)
      exists (
        select 1
          from public.impersonation_sessions
         where admin_user_id = auth.uid()
           and target_org_id = target_org
           and ended_at is null
           and started_at > now() - interval '24 hours'
      )
    else
      -- Normal: a real owner/admin membership that the org's status admits.
      exists (
        select 1
          from public.memberships m
          join public.organizations o on o.id = m.org_id
         where m.user_id = auth.uid()
           and m.org_id = target_org
           and m.role in ('owner', 'admin')
           and public.org_status_admits(o.status, m.role)
      )
  end;
$$;

-- Compensation: a person always reads THEIR OWN pay record (own information); reading or writing
-- SOMEONE ELSE's needs an owner/admin membership that the company's status admits.
create or replace function public.can_read_compensation(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_user = auth.uid()
    or exists (
      select 1
      from public.memberships mt
      join public.memberships me on me.org_id = mt.org_id
      join public.organizations o on o.id = me.org_id
      where mt.user_id = target_user
        and me.user_id = auth.uid()
        and me.role in ('owner', 'admin')
        and public.org_status_admits(o.status, me.role)
    );
$$;

create or replace function public.can_write_compensation(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mt
    join public.memberships me on me.org_id = mt.org_id
    join public.organizations o on o.id = me.org_id
    where mt.user_id = target_user
      and me.user_id = auth.uid()
      and me.role in ('owner', 'admin')
      and public.org_status_admits(o.status, me.role)
  );
$$;

-- The org row stays readable to its own members whatever the status (the lock screen needs it).
drop policy if exists "Users can read organizations they belong to" on public.organizations;
create policy "Users can read organizations they belong to" on public.organizations
  for select to authenticated
  using (
    id in (select public.current_org_ids())
    or id in (select m.org_id from public.memberships m where m.user_id = auth.uid())
  );
