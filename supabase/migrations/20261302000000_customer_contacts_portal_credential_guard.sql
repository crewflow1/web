-- customer_contacts: only the server may mint or change a portal credential
-- (adversarial tenant-isolation programme — register ST-04).
--
-- THE HOLE
-- --------
-- customer_contacts.portal_token (+ portal_access_enabled, portal_token_expires_at) is a
-- BEARER CREDENTIAL. app/customer-portal/_helpers.ts → resolveContactToken() looks it up
-- with the service role and serves the PARENT customer's portal: invoices, quotes,
-- payments, documents, and the ability to act as the customer (accept a quote, upload a
-- payment proof, raise a claim).
--
-- The application never writes those columns from a client. Granting a contact access
-- is "a separate deliberate action" (20261141000000) that has not been built; every
-- in-app insert sends portal_access_enabled = false, portal_token = null. But the table's
-- INSERT/UPDATE policies are member-wide (org_id in current_org_ids()) and the three
-- columns were ordinary client-writable columns, so any member could send
--
--     POST /rest/v1/customer_contacts
--     { org_id, customer_id, name, portal_access_enabled: true, portal_token: <own uuid> }
--
-- and then open /customer-portal/<own uuid>. Proven against the local stack with a
-- `staff` JWT (which RLS denies ALL of invoices / quotes / payments since
-- 20261275000000) assigned to one of the customer's jobs: insert, in-place upgrade of
-- an existing contact, and re-keying / un-expiring a server-minted credential all
-- succeeded. It is an in-tenant privilege escalation (the composite FK
-- customer_contacts_customer_org_fkey already makes a cross-org customer_id
-- unrepresentable), but it hands a restricted role the customer's financial records
-- and the customer's signature.
--
-- THE FIX
-- -------
-- A BEFORE INSERT OR UPDATE guard: the client roles (anon, authenticated) may not SET
-- the credential columns on insert, nor CHANGE them on update. Value-based, not a
-- column REVOKE, on purpose:
--   * the staff contact CRUD (app/(app)/customers/_contact-actions.ts) explicitly sends
--     the default values; a column-level REVOKE would reject that insert outright;
--   * a column-level REVOKE requires dropping the table-level grant, after which every
--     future column needs its own grant — a silent-break hazard.
-- Rows that carry only the defaults pass untouched, so no existing flow changes.
--
-- WHO MAY STILL WRITE THEM: service_role (the admin client — where the future
-- "grant contact access" action must live) and direct database roles (migrations).
-- `current_user` is used rather than a JWT claim: under PostgREST it is the role the
-- request was switched to, it cannot be influenced by request content, and inside a
-- SECURITY DEFINER function it is the function owner — so a future server-vetted RPC
-- can still provision access deliberately.
--
-- data-api:exempt: adds a trigger only; widens no client surface, adds no table.
-- Forward-only, idempotent (create or replace + drop trigger if exists).
--
-- Rollback (manual, not recommended — it reopens ST-04):
--   drop trigger customer_contacts_portal_credential_guard on public.customer_contacts;
--   drop function public.tg_customer_contacts_portal_credential_guard();

create or replace function public.tg_customer_contacts_portal_credential_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.portal_access_enabled is distinct from false
       or new.portal_token is not null
       or new.portal_token_expires_at is not null then
      raise exception 'customer contact portal access can only be granted by the server'
        using errcode = '42501';
    end if;
  else
    if new.portal_access_enabled is distinct from old.portal_access_enabled
       or new.portal_token is distinct from old.portal_token
       or new.portal_token_expires_at is distinct from old.portal_token_expires_at then
      raise exception 'customer contact portal access can only be changed by the server'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_customer_contacts_portal_credential_guard() is
  'ST-04: customer_contacts.portal_token / portal_access_enabled / '
  'portal_token_expires_at are a bearer credential for the customer portal. Client '
  'roles (anon, authenticated) may not set them on INSERT nor change them on UPDATE; '
  'only service_role / a definer function may. Rows carrying the defaults are unaffected.';

-- A trigger function is not callable through PostgREST, but keep the ACL tight anyway:
-- Supabase default privileges grant EXECUTE to anon/authenticated at CREATE time.
revoke all on function public.tg_customer_contacts_portal_credential_guard() from public;
revoke execute on function public.tg_customer_contacts_portal_credential_guard() from anon, authenticated;

drop trigger if exists customer_contacts_portal_credential_guard on public.customer_contacts;
create trigger customer_contacts_portal_credential_guard
  before insert or update on public.customer_contacts
  for each row execute function public.tg_customer_contacts_portal_credential_guard();
