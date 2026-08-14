-- P2 Signature — drawn e-signature image + richer provenance (ADDITIVE).
--
-- Two existing evidence records only ever captured a TYPED name:
--   * public.signatures            — quote / variation acceptance (already
--                                    carries signer_name, signature_text,
--                                    ip_address (a salted IP HASH), user_agent).
--   * public.safety_acknowledgements — H&S / RAMS / permit operative sign-off
--                                    (only user + version + typed signed_name,
--                                    NO signature image, NO ip / device).
--
-- This migration adds a DRAWN signature image (a PNG captured on a canvas and
-- stored in the private `signatures` storage bucket created in the sibling
-- migration 20261123000001) plus the missing provenance on the H&S table.
--
-- Every column is NULLABLE and additive: the typed-name path keeps working
-- unchanged (a drawn signature is optional/enriching, never required), so no
-- existing row or write path breaks. The image is referenced by its storage
-- (bucket, path) — the bytes never live in the DB.
--
-- Path integrity (defence-in-depth, mirrors lib/storage/owned-path +
-- tg_assert_storage_path_org): a stored key is ALWAYS org-first
-- (`${org_id}/...`), enforced here by a CHECK so a poisoned path pointing at
-- another tenant's object can never be persisted. For safety_acknowledgements
-- org_id is trigger-derived from the subject in a BEFORE trigger, which runs
-- before CHECKs are evaluated, so the constraint sees the authoritative org_id.

-- ---------------------------------------------------------------------------
-- signatures (quotes / variations) — add the drawn-image reference.
-- ---------------------------------------------------------------------------
alter table public.signatures
  add column if not exists signature_image_bucket text,
  add column if not exists signature_image_path   text;

alter table public.signatures
  drop constraint if exists signatures_image_path_org_first;
alter table public.signatures
  add constraint signatures_image_path_org_first
  check (
    signature_image_path is null
    or split_part(signature_image_path, '/', 1) = org_id::text
  );

-- ---------------------------------------------------------------------------
-- safety_acknowledgements (H&S sign-off) — add drawn image + provenance.
--   * signature_image_bucket / signature_image_path — the drawn PNG.
--   * ip_hash    — salted SHA-256 of the signer's IP (never the raw IP).
--   * user_agent — the signing device/browser string.
-- These are set ON INSERT only. The table's append-only trigger
-- (tg_safety_ack_no_update) still forbids any UPDATE, so this evidence is
-- immutable once written — the same discipline the typed name already had.
-- ---------------------------------------------------------------------------
alter table public.safety_acknowledgements
  add column if not exists signature_image_bucket text,
  add column if not exists signature_image_path   text,
  add column if not exists ip_hash                text,
  add column if not exists user_agent             text;

alter table public.safety_acknowledgements
  drop constraint if exists safety_ack_image_path_org_first;
alter table public.safety_acknowledgements
  add constraint safety_ack_image_path_org_first
  check (
    signature_image_path is null
    or split_part(signature_image_path, '/', 1) = org_id::text
  );
