-- Public API-key foundation (Train 9) — SUBSTRATE ONLY.
--
-- Org-scoped API keys for the future public API. This migration ships the
-- credential store and its trust boundary; the only endpoint that consumes it
-- is the /api/v1/me probe (a living proof of the substrate, not a product
-- surface). No product API exists yet — that is an explicit CEO decision, not
-- an omission.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE PLAINTEXT KEY IS NEVER STORED. ANYWHERE. EVER.
-- ─────────────────────────────────────────────────────────────────────────────
-- A key is `crewflow_sk_` + 43 base62 chars (256 bits of entropy). The row
-- stores ONLY:
--   key_hash   — hex sha256 of the FULL plaintext. Unique: it IS the lookup
--                key for Bearer resolution (service-role path only).
--   key_prefix — `crewflow_sk_` + the first 8 secret chars, for display
--                ("which key is this?") in the settings UI. 8 chars of a
--                43-char secret identifies nothing an attacker can use.
-- The plaintext exists exactly once, in the create action's response, and is
-- shown once in the UI ("you will not see this again"). It is never logged,
-- never persisted, never echoed back by any read path.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. key_hash NEVER READS BACK TO A TENANT — COLUMN-LEVEL PRIVILEGE, NOT POLICY
-- ─────────────────────────────────────────────────────────────────────────────
-- RLS decides WHICH ROWS a tenant sees; it cannot hide a column. A tenant
-- admin who can select their own api_keys rows must still never read key_hash:
-- the hash is the credential's verifier, and "admin of the org" is a weaker
-- capability than "holder of the key" (an admin's browser session leaking hashes
-- would hand offline-crack material for every key in the org).
--
-- PRECEDENT SEARCH (mandated): the repo's existing sensitive-column shapes are
--   (a) cis_subcontractors.utr — whole-TABLE admin-only RLS + app-layer
--       maskUtr() for display (20261046), and
--   (b) staff_secrets — the sensitive column moved to its own stricter table.
-- Neither works here: the tenant MUST read most of this row (name, prefix,
-- scopes, timestamps) while ONE column must be unreadable, and splitting a
-- 1:1 `api_key_secrets` table would leave a second table whose only tenant
-- policy is "none" — more surface, same guarantee. So this migration uses the
-- PostgREST-documented column-level privilege mechanism directly:
--
--   revoke select on public.api_keys from authenticated;
--   grant  select (…explicit safe list…) on public.api_keys to authenticated;
--
-- PostgREST honours column privileges: selecting key_hash (explicitly, or via
-- `*`, which Postgres expands to every column) fails with 42501 for the
-- authenticated role. CONSEQUENCE FOR CALLERS: tenant-side reads of this table
-- MUST name their columns — `select('*')` will error by design. The settings
-- page does; the integration suite pins both directions.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. REVOKE, NEVER ERASE
-- ─────────────────────────────────────────────────────────────────────────────
-- There is NO tenant delete policy and no DELETE grant: a key that once
-- existed is audit trail (who created it, when it was last seen, when it was
-- killed). Revocation stamps revoked_at; the resolver refuses revoked keys on
-- EVERY call (no caching), so revocation is immediate. A trigger below makes
-- revocation final and the credential columns immutable FOR EVERY ROLE,
-- including service_role — the same all-role integrity stance as the
-- completion-certificate and warranty freezes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. TEARDOWN SAFETY (the 20261052 lesson)
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive; org-scoped; org FK is ON DELETE CASCADE; the only SET NULL edge
-- points at public.users (never cascaded from an org delete). No RESTRICT, no
-- AFTER-DELETE trigger. The BEFORE UPDATE guard cannot fire during a delete
-- cascade. Fresh CREATE only — no lock_timeout needed (no hot-table ALTER).

-- ── 1. api_keys ──────────────────────────────────────────────────────────────
create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  -- Operator-facing label ("Zapier import", "Warehouse screen").
  name         text not null check (btrim(name) <> ''),

  -- Display identifier: `crewflow_sk_` + first 8 secret chars. NOT a secret,
  -- NOT unique (8 chars can collide; uniqueness lives on the hash).
  key_prefix   text not null check (key_prefix ~ '^crewflow_sk_[0-9A-Za-z]{8}$'),

  -- Hex sha256 of the full plaintext key. THE credential verifier — unique
  -- because Bearer resolution looks up by it. NEVER tenant-readable (see §2).
  key_hash     text not null check (key_hash ~ '^[0-9a-f]{64}$'),

  -- Granted scopes. VALIDATED IN THE APP LAYER against the build-fact SCOPES
  -- registry (lib/api-auth/scopes.ts) — the DB pins shape only (no NULLs, no
  -- blanks), because the registry is a compile-time fact the DB cannot see.
  scopes       text[] not null default '{}'
    check (array_position(scopes, null) is null and array_position(scopes, '') is null),

  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamp with time zone not null default now(),

  -- COARSE usage telemetry: touched by the resolver at most once per minute
  -- (Postgres-enforced debounce, the portal-token shape). Not authority.
  last_used_at timestamp with time zone,

  -- NULL = never expires. The resolver checks this on EVERY call.
  expires_at   timestamp with time zone,
  constraint api_keys_expiry_after_creation
    check (expires_at is null or expires_at > created_at),

  -- NULL = live. Set once, final (trigger below). The audit trail of a kill.
  revoked_at   timestamp with time zone,

  constraint api_keys_key_hash_key unique (key_hash),

  -- Candidate key so any future child relation binds (key_id, org_id) rather
  -- than key_id alone — the house org-pinning shape.
  constraint api_keys_id_org_key unique (id, org_id)
);

comment on table public.api_keys is
  'Org-scoped API keys (Train 9 substrate). Stores ONLY the sha256 hash of the key plus a display prefix — the plaintext is returned once from the create action and exists nowhere else. key_hash is excluded from tenant readback by COLUMN-LEVEL privilege (revoke select from authenticated + explicit safe-column grant), so tenant reads must name their columns; select(*) fails by design. No tenant DELETE: revoke, never erase.';
comment on column public.api_keys.key_hash is
  'Hex sha256 of the full plaintext key. The Bearer-resolution lookup key (service-role only). NEVER readable by the authenticated role — enforced by column-level privilege, not RLS, and pinned by __tests__/security/api-keys.test.ts + the integration suite. Immutable once written (trigger).';
comment on column public.api_keys.key_prefix is
  'crewflow_sk_ + first 8 secret chars, for display only. Not unique, not a secret, never sufficient to authenticate.';
comment on column public.api_keys.scopes is
  'Granted scopes, validated in the app layer against the compile-time SCOPES registry (lib/api-auth/scopes.ts — v1 defines exactly read:jobs). Immutable after creation: to change scopes, revoke and mint a new key.';
comment on column public.api_keys.last_used_at is
  'Coarse telemetry: the resolver updates this at most once per 60s per key, with the debounce re-checked in the UPDATE''s own WHERE (the portal-token shape). Never authority, never blocks resolution.';
comment on column public.api_keys.revoked_at is
  'Set once by an org admin to kill the key; the resolver refuses revoked keys on every call. FINAL: the trigger refuses any later change, so a key cannot be silently un-revoked. There is no delete — this stamp is the audit trail.';

create index if not exists api_keys_org_idx
  on public.api_keys (org_id, created_at desc);

-- ── 2. Credential immutability + revocation finality (every role) ────────────
-- Column-level grants stop the AUTHENTICATED role from touching these columns,
-- but service_role bypasses grants and policies alike. This trigger makes the
-- invariants hold for every role: the credential a key was born with is the
-- credential it dies with, and a revocation can never be quietly undone.
--
-- BEFORE UPDATE only; writes nothing; cannot fire during a delete cascade.
create or replace function public.tg_api_keys_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.key_hash is distinct from old.key_hash then
    raise exception 'api_keys.key_hash is immutable — mint a new key instead'
      using errcode = 'check_violation';
  end if;
  if new.key_prefix is distinct from old.key_prefix then
    raise exception 'api_keys.key_prefix is immutable'
      using errcode = 'check_violation';
  end if;
  if new.org_id is distinct from old.org_id then
    raise exception 'api_keys.org_id is immutable — a key never changes tenant'
      using errcode = 'check_violation';
  end if;
  if new.scopes is distinct from old.scopes then
    raise exception 'api_keys.scopes are immutable — revoke and mint a new key'
      using errcode = 'check_violation';
  end if;
  if new.expires_at is distinct from old.expires_at then
    raise exception 'api_keys.expires_at is immutable — revoke and mint a new key'
      using errcode = 'check_violation';
  end if;
  if new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'api_keys provenance (created_at/created_by) is immutable'
      using errcode = 'check_violation';
  end if;
  -- Revocation is set-once-final: NULL → timestamp is the only legal move.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'api_key % is revoked; revocation is final and cannot be edited or undone', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists api_keys_immutable on public.api_keys;
create trigger api_keys_immutable
  before update on public.api_keys
  for each row execute function public.tg_api_keys_immutable();

-- ── 3. RLS — org-ADMIN manage; no delete for anyone below service_role ───────
alter table public.api_keys enable row level security;

-- Admin-only, NOT current_org_ids: a plain member must neither see that keys
-- exist nor mint one. Per-command policies (not `for all`) because DELETE must
-- have NO policy at all — revoke, never erase.
drop policy if exists "api_keys: admins select" on public.api_keys;
create policy "api_keys: admins select" on public.api_keys
  for select to authenticated
  using (public.is_org_admin(org_id));

drop policy if exists "api_keys: admins insert" on public.api_keys;
create policy "api_keys: admins insert" on public.api_keys
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "api_keys: admins update" on public.api_keys;
create policy "api_keys: admins update" on public.api_keys
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- Deliberately NO delete policy. RLS default-denies DELETE, and the grant is
-- revoked below as a second, independent lock.

-- ── 4. Column-level privileges — the key_hash readback exclusion (§2) ────────
-- Supabase's default privileges grant ALL on new public tables to anon and
-- authenticated; RLS alone would still let an admin select key_hash on their
-- own rows. Rebuild the grants explicitly. Idempotent: REVOKE of an absent
-- privilege is a no-op; repeated GRANT is a no-op. Replay-clean.

-- anon: nothing at all. There is no anonymous surface on this table.
revoke all on table public.api_keys from anon;

-- authenticated: start from zero for select/update/delete/truncate/references/
-- trigger, then grant back exactly what the settings surface needs.
revoke select, update, delete, truncate, references, trigger
  on table public.api_keys from authenticated;

-- The explicit safe column list — every column EXCEPT key_hash. Adding a
-- column to this table does NOT expose it: it must be granted here by name.
grant select (id, org_id, name, key_prefix, scopes, created_by, created_at,
              last_used_at, expires_at, revoked_at)
  on public.api_keys to authenticated;

-- Tenant updates are rename + revoke ONLY. scopes/expires_at/key_hash etc. are
-- not updatable by the authenticated role at all (and are immutable for every
-- role via the trigger above).
grant update (name, revoked_at)
  on public.api_keys to authenticated;

-- INSERT keeps its default full-column grant: the create action inserts the
-- hash through the user client so the admin-only RLS insert policy is the
-- authority. Writing key_hash is fine — READING it back is what is forbidden,
-- and the create action never selects after insert.
