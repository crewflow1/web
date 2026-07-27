-- Asset Management — Milestone 3: QR asset-identity platform (identity core).
--
-- A permanent, revocable, tenant-safe identity for each asset — the thing a
-- printed QR label resolves to. The QR *image* (rendered from `qrcode` in a
-- later slice) carries ONLY this opaque token; all business data stays behind an
-- authenticated, tenant-scoped scan resolver.
--
-- Security invariants enforced at the DB (never the frontend):
--   1. ONE ACTIVE IDENTITY PER ASSET — a partial unique index. Regeneration
--      revokes the old (active=false) and inserts a new active one atomically;
--      concurrent generation can't produce two active identities.
--   2. TOKEN UNIQUENESS — a unique index; a scan resolves by exact token.
--   3. SAME-ORG asset — a guard trigger (the identity's asset must be in its org).
--
-- Threat model on the token: a HIGH-ENTROPY opaque random (24 bytes, base64url),
-- stored raw — the same posture as customers.portal_token (also a raw,
-- revocable, high-entropy credential). It encodes no org/customer/asset id, is
-- enumeration-resistant, and is revoked (active=false) so old printed labels stop
-- resolving. Hashing was considered and deferred: raw storage matches the proven
-- portal-token pattern and keeps the scan a single indexed lookup; revocation +
-- entropy carry the security, not secrecy-at-rest.
--
-- Additive + reversible. No new dependency (the opaque token is crypto random;
-- `qrcode` is only for image rendering, added in the label slice).

create table if not exists public.asset_qr_identities (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  asset_id          uuid not null references public.assets(id) on delete cascade,
  token             text not null unique,
  active            boolean not null default true,
  generated_by      uuid references public.users(id) on delete set null,
  generated_at      timestamp with time zone not null default now(),
  revoked_by        uuid references public.users(id) on delete set null,
  revoked_at        timestamp with time zone,
  revocation_reason text,
  -- Lineage: the identity this one replaced (set on regenerate).
  regenerated_from  uuid references public.asset_qr_identities(id) on delete set null,
  created_at        timestamp with time zone not null default now(),
  updated_at        timestamp with time zone not null default now()
);

-- THE INVARIANT: at most one ACTIVE identity per asset.
create unique index if not exists asset_qr_identities_one_active_idx
  on public.asset_qr_identities (asset_id) where active;
-- Scan resolution: fast lookup of an active identity by token.
create unique index if not exists asset_qr_identities_token_idx
  on public.asset_qr_identities (token);
create index if not exists asset_qr_identities_asset_idx
  on public.asset_qr_identities (asset_id, generated_at desc);

alter table public.asset_qr_identities enable row level security;

create policy asset_qr_identities_select on public.asset_qr_identities
  for select using (org_id in (select public.current_org_ids()));
create policy asset_qr_identities_insert on public.asset_qr_identities
  for insert with check (org_id in (select public.current_org_ids()));
create policy asset_qr_identities_update on public.asset_qr_identities
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- History is audit-worthy — hard delete admin-only (revoke, don't delete).
create policy asset_qr_identities_delete on public.asset_qr_identities
  for delete using (public.is_org_admin(org_id));

drop trigger if exists asset_qr_identities_set_updated_at on public.asset_qr_identities;
create trigger asset_qr_identities_set_updated_at before update on public.asset_qr_identities
  for each row execute function public.tg_set_updated_at();

-- Same-org: the identity's asset must belong to the identity's org.
create or replace function public.tg_asset_qr_same_org()
returns trigger language plpgsql as $$
declare
  a_org uuid;
begin
  select org_id into a_org from public.assets where id = new.asset_id;
  if a_org is null or a_org <> new.org_id then
    raise exception 'asset % is not in org %', new.asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_qr_identities_same_org on public.asset_qr_identities;
create trigger asset_qr_identities_same_org before insert or update on public.asset_qr_identities
  for each row execute function public.tg_asset_qr_same_org();

-- Atomic generate/regenerate: revoke the asset's current active identity (if any)
-- and insert a new active one, in ONE transaction. SECURITY INVOKER so the
-- caller's RLS + the same-org guard + the one-active partial index all apply —
-- concurrent rotations can't leave two active identities (the loser's insert hits
-- the partial unique index and the whole rotation rolls back). Works for the
-- first generation (no active row) and every regeneration. The token is minted
-- in app code (crypto-random) and passed in.
create or replace function public.rotate_asset_qr_identity(
  p_asset_id      uuid,
  p_org_id        uuid,
  p_token         text,
  p_generated_by  uuid
) returns uuid
language plpgsql
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  update public.asset_qr_identities
     set active = false, revoked_at = now(), revoked_by = p_generated_by,
         revocation_reason = 'regenerated'
   where asset_id = p_asset_id and org_id = p_org_id and active
   returning id into v_old;

  insert into public.asset_qr_identities (
    org_id, asset_id, token, active, generated_by, regenerated_from
  ) values (
    p_org_id, p_asset_id, p_token, true, p_generated_by, v_old
  ) returning id into v_new;

  return v_new;
end $$;
