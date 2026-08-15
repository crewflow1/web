-- Multi-contact per customer (P3 — Portal completeness).
--
-- Today a customer has exactly ONE portal identity: customers.portal_token, a
-- raw UUID that IS the whole auth surface (see app/customer-portal/_helpers.ts).
-- Real customers are households and businesses with several people who should be
-- reachable (a spouse, a facilities manager, an accounts contact). This table
-- adds NAMED CONTACTS as an ADDITIVE capability: it never touches the existing
-- single-token path, and it can OPTIONALLY carry a per-contact portal token so a
-- named contact gets scoped portal access WITHOUT sharing the primary link.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY — org + customer binding, and the additive token
-- ─────────────────────────────────────────────────────────────────────────────
-- A contact belongs to (org_id, customer_id). The pair is bound by a COMPOSITE
-- FK to customers(id, org_id) (candidate key customers_id_org_key, live since
-- 20260915), so a contact can NEVER name a customer in another org — the same
-- guard job_warranties / invoices use. RLS scopes staff reads/writes to the org.
--
-- portal_token is NULLABLE and unique when set. A NULL token = a contact with no
-- portal access (the common case: a reachable person, not a login). A set token
-- grants that ONE contact scoped access, resolved by _helpers.ts to the SAME
-- parent customer + org — never a second tenant boundary. Provisioning a contact
-- token is a STAFF action (RLS admin-gated below); the portal itself never mints
-- one, so a portal visitor can add a reachable contact but cannot self-escalate
-- into a second credential.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TEARDOWN SAFETY (the 20261052 lesson)
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive; org-scoped; every FK on the cascade path is ON DELETE CASCADE, and
-- the only SET NULL edge points at public.users (never cascaded from an org
-- delete). No RESTRICT, no AFTER-DELETE trigger.

create table if not exists public.customer_contacts (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.organizations(id) on delete cascade,
  -- The owning customer. Bound to the SAME org by the composite FK below, so a
  -- cross-org customer_id is unrepresentable for every role incl. service_role.
  customer_id               uuid not null,

  -- The person.
  name                      text not null check (btrim(name) <> '' and char_length(name) <= 200),
  email                     text check (email is null or char_length(email) <= 320),
  phone                     text check (phone is null or char_length(phone) <= 50),
  -- Their relationship to the account. Restricted set so staff filters stay
  -- meaningful; 'other' is the escape hatch.
  role                      text not null default 'other'
    check (role in ('primary', 'billing', 'site', 'partner', 'tenant', 'other')),
  -- Free-form staff note (who they are, when to call). Bounded.
  notes                     text check (notes is null or char_length(notes) <= 2000),

  -- OPTIONAL scoped portal access. NULL = no login (a reachable contact only).
  -- When set it is a raw v4 UUID exactly like customers.portal_token, resolved
  -- by _helpers.ts to the SAME parent customer. Minted by staff only (RLS below).
  portal_access_enabled     boolean not null default false,
  portal_token              uuid,
  portal_token_expires_at   timestamp with time zone,
  portal_token_last_used_at timestamp with time zone,

  created_by                uuid references public.users(id) on delete set null,
  created_at                timestamp with time zone not null default now(),
  updated_at                timestamp with time zone not null default now(),

  -- ORG + CUSTOMER binding — the cross-customer barrier at the schema level.
  constraint customer_contacts_customer_org_fkey
    foreign key (customer_id, org_id) references public.customers (id, org_id) on delete cascade,

  -- A token only exists when access is enabled, and enabled access requires a
  -- token — the two can never disagree, so a disabled contact can never be
  -- reached by a stale token and an enabled contact always has a credential.
  constraint customer_contacts_token_access_agree
    check (
      (portal_access_enabled = true and portal_token is not null)
      or (portal_access_enabled = false and portal_token is null)
    )
);

comment on table public.customer_contacts is
  'Named contacts for a customer (P3 portal completeness). Additive to the single customers.portal_token path. An OPTIONAL per-contact portal_token grants ONE contact scoped access to the SAME parent customer + org (resolved in app/customer-portal/_helpers.ts); tokens are minted by staff only.';
comment on column public.customer_contacts.portal_token is
  'Optional raw v4 UUID granting this ONE contact scoped portal access to the parent customer. NULL = no login. Redacted from GDPR export by the token-name rule.';

-- A raw token is a credential — it must be globally unique so a lookup resolves
-- exactly one contact. Partial (only rows that actually carry a token).
create unique index if not exists customer_contacts_portal_token_key
  on public.customer_contacts (portal_token)
  where portal_token is not null;

create index if not exists customer_contacts_customer_idx
  on public.customer_contacts (org_id, customer_id, created_at desc);

-- ── org-binding guard: the token, if set, must belong to this org's customer ──
-- Belt-and-braces beside the composite FK: also stops a customer_id that exists
-- but is not the one the composite FK points at (defensive; the FK already binds
-- the pair). BEFORE INSERT/UPDATE only — cannot participate in a delete cascade.
create or replace function public.tg_customer_contacts_guard()
returns trigger language plpgsql as $$
declare
  c_org uuid;
begin
  select org_id into c_org from public.customers where id = new.customer_id;
  if c_org is null or c_org <> new.org_id then
    raise exception 'customer % is not in org %', new.customer_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists customer_contacts_guard on public.customer_contacts;
create trigger customer_contacts_guard
  before insert or update on public.customer_contacts
  for each row execute function public.tg_customer_contacts_guard();

drop trigger if exists customer_contacts_set_updated_at on public.customer_contacts;
create trigger customer_contacts_set_updated_at
  before update on public.customer_contacts
  for each row execute function public.tg_set_updated_at();

-- ── RLS — tenant-scoped. Members read/insert/update; provisioning a portal
--    token (the credential) is admin-only, enforced in code + policy scope. ────
alter table public.customer_contacts enable row level security;

drop policy if exists "customer_contacts: members select" on public.customer_contacts;
create policy "customer_contacts: members select" on public.customer_contacts
  for select using (org_id in (select public.current_org_ids()));

drop policy if exists "customer_contacts: members insert" on public.customer_contacts;
create policy "customer_contacts: members insert" on public.customer_contacts
  for insert with check (org_id in (select public.current_org_ids()));

drop policy if exists "customer_contacts: members update" on public.customer_contacts;
create policy "customer_contacts: members update" on public.customer_contacts
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

drop policy if exists "customer_contacts: admins delete" on public.customer_contacts;
create policy "customer_contacts: admins delete" on public.customer_contacts
  for delete using (public.is_org_admin(org_id));
