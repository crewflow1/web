-- Train 4 — Customer Portal evolution: contact & communication preferences.
--
-- ONE new table. Everything else in this train is zero-DDL:
--   * portal photos read published site_reports snapshots + tenant_attachments
--     that already exist;
--   * future-work requests are rows in the EXISTING public.leads table
--     (source = 'portal', customer linkage via the existing leads.customer_id);
--   * profile-change REQUESTS are rows in the EXISTING public.support_tickets
--     (category = 'account') — the portal never writes public.customers.
--
-- customer_portal_preferences — how the customer wants to be contacted.
--
-- WRITE MODEL (matches every other portal write): the portal has no Supabase
-- JWT, so writes arrive on the service-role admin client from a server action
-- that has ALREADY resolved the URL token to a (customer_id, org_id) pair via
-- loadCustomerByPortalToken. RLS cannot scope that client; the action scopes it
-- in code. Therefore there are NO tenant INSERT/UPDATE/DELETE policies here —
-- the absence is deliberate and load-bearing: a tenant-side write policy would
-- add a second write path this train has not reviewed.
--
-- READ MODEL: staff SHOULD see the preference next to the customer, so org
-- members get SELECT via the standard current_org_ids() membership helper.
--
-- INTEGRITY: the composite FK (customer_id, org_id) → customers (id, org_id)
-- (the unique pair exists since 20260915000000_invoice_customer_denormalisation)
-- makes a cross-org row UNREPRESENTABLE: you cannot store a preference for a
-- customer under an org the customer does not belong to, even via service role.
--
-- IDEMPOTENT + ADDITIVE: create-if-not-exists only; touches no existing row,
-- table, bucket or policy.

create table if not exists public.customer_portal_preferences (
  org_id       uuid not null references public.organizations (id) on delete cascade,
  customer_id  uuid not null,

  -- The channel the customer ASKS us to prefer. Free-text is banned: an
  -- unconstrained value would end up rendered in staff UI verbatim.
  preferred_channel text not null default 'email'
    check (preferred_channel in ('email', 'phone', 'whatsapp', 'post')),

  -- Bounded free text ("mornings only", "don't call before 9am"). The bound is
  -- enforced here AND in the zod schema — the DB check holds even if the
  -- action's validation is edited away.
  contact_notes text
    check (contact_notes is null or char_length(contact_notes) <= 500),

  created_at   timestamp with time zone not null default now(),
  updated_at   timestamp with time zone not null default now(),

  -- One row per customer per org; the natural key IS the primary key, which is
  -- also what makes the portal upsert idempotent (on conflict do update).
  primary key (org_id, customer_id),

  -- Org-binding: the referenced customer must belong to the referenced org.
  constraint customer_portal_preferences_customer_org_fk
    foreign key (customer_id, org_id)
    references public.customers (id, org_id)
    on delete cascade
);

comment on table public.customer_portal_preferences is
  'Customer-set contact/communication preferences, written ONLY by the customer '
  'portal (service-role action, token-resolved identity). Staff read via org '
  'membership; no tenant write policies on purpose.';

alter table public.customer_portal_preferences enable row level security;

-- Staff read the preference; nobody on the tenant side writes it. The portal's
-- service-role client bypasses RLS by design — its scoping lives in the action.
drop policy if exists customer_portal_preferences_select
  on public.customer_portal_preferences;
create policy customer_portal_preferences_select
  on public.customer_portal_preferences
  for select using (org_id in (select public.current_org_ids()));

-- updated_at touch on every service-role upsert, same shape as
-- _support_tickets_touch.
create or replace function public._customer_portal_preferences_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists customer_portal_preferences_touch
  on public.customer_portal_preferences;
create trigger customer_portal_preferences_touch
  before update on public.customer_portal_preferences
  for each row execute function public._customer_portal_preferences_touch();

-- Down (manual; not auto-run by the migration tool):
--   drop trigger if exists customer_portal_preferences_touch on public.customer_portal_preferences;
--   drop function if exists public._customer_portal_preferences_touch();
--   drop table if exists public.customer_portal_preferences;
