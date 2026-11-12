-- Caller recognition — a phone "significant digits" signature on leads, mirroring
-- the one already on customers (20261261000000), so an inbound caller's number can
-- be matched EXACTLY against an existing open lead (a repeat caller who is not yet a
-- customer) the same way it is matched against customers.
--
-- The expression is BYTE-IDENTICAL to customers.phone_sig: strip to digits, drop a
-- leading UK country code ("44") or national trunk "0", so "+44 7700 900123",
-- "07700 900123" and "447700900123" all reduce to "7700900123". It MUST stay in
-- lock-step with lib/phone.ts `phoneSignificantDigits`, which computes the same
-- value in TypeScript for the lookup key.
--
-- Rollback (manual):
--   drop index if exists public.leads_org_contact_phone_sig_idx;
--   alter table public.leads drop column if exists contact_phone_sig;

alter table public.leads
  add column if not exists contact_phone_sig text
    generated always as (
      nullif(
        case
          when regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g') like '44%'
            then substr(regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g'), 3)
          when regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g') like '0%'
            then substr(regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g'), 2)
          else regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g')
        end,
        ''
      )
    ) stored;

-- Org-scoped lookup index for the exact-match recognition query
-- (org_id, contact_phone_sig) filtered to rows that actually carry a signature.
-- Built without `concurrently`: Supabase wraps each migration in a transaction,
-- which disallows concurrent index builds; the brief build lock is immaterial at
-- launch volumes (same note as 20261261000000).
create index if not exists leads_org_contact_phone_sig_idx
  on public.leads (org_id, contact_phone_sig)
  where contact_phone_sig is not null;

-- contact_phone_sig carries NO information beyond the already-exposed contact_phone,
-- so — exactly as the customers phone_sig/phone_normalized columns — it needs no
-- GRANT of its own; the existing table-level grants on public.leads cover it.
-- data-api:exempt: derived column, no new client-reachable surface.
