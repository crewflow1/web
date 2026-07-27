-- Security wave S2 — SHA-256 content_hash + universal write-once evidence immutability.
--
-- DETECTION layer (complements S1's prevention): freeze a SHA-256 of the exact uploaded
-- bytes as immutable evidence metadata, so any later byte swap is cryptographically
-- detectable ("these are the exact bytes CrewFlow recorded for this attachment" — NOT a
-- digital signature or legal non-repudiation; CrewFlow has no such mechanism). Mirrors the
-- shipped blueprint_versions.content_hash precedent, hardened per its review:
--   * blueprint's column is nullable + unconstrained → here a CHECK pins well-formed hex.
--   * hash is app-computed on the raw Uint8Array (binary-safe), then written at INSERT.
--
-- SECOND FIX (a real gap the audit found): the delivered-evidence freeze
-- (tg_tenant_attachment_freeze_delivered_toolbox, 20261028/29) is TOOLBOX-ONLY. For every
-- other target (snags/site_diary/site_reports/asset_inspections/asset_assignments photos),
-- a service-role write could silently repoint storage_path / rewrite size_bytes / mime_type
-- / content_hash in place. This adds a UNIVERSAL, target-agnostic write-once guard on those
-- identity columns for EVERY role — composing with (not forking) the toolbox freeze.
--
-- Additive + reversible: nullable column + CHECK + one function + one trigger. Existing rows
-- and the app's existing INSERTs (which will now also send content_hash) stay valid; the app
-- never UPDATEs this table, so the freeze is invisible to it. Historical rows keep a NULL
-- hash (nullable by design — no backfill, no re-upload of customer files); new evidence is
-- hashed by the upload path. Rollback: drop the trigger + function, drop the column.

alter table public.tenant_attachments
  add column if not exists content_hash text;

do $$ begin
  alter table public.tenant_attachments
    add constraint tenant_attachments_content_hash_hex
    check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$');
exception when duplicate_object then null; end $$;

-- Universal write-once identity/evidence guard (BEFORE UPDATE, every role incl. service_role).
-- null->value is permitted once (one-time backfill path); value->different is rejected. A file
-- is replaced by delete+reinsert (append-only), never by in-place rewrite — so storage_path is
-- fully write-once. Column-scoped: benign edits (e.g. filename) remain allowed.
create or replace function public.tg_tenant_attachment_evidence_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.content_hash is not null and new.content_hash is distinct from old.content_hash then
    raise exception 'tenant_attachments.content_hash is immutable once set (attachment %)', old.id using errcode = 'check_violation';
  end if;
  if new.storage_path is distinct from old.storage_path then
    raise exception 'tenant_attachments.storage_path is immutable (attachment %)', old.id using errcode = 'check_violation';
  end if;
  if old.size_bytes is not null and new.size_bytes is distinct from old.size_bytes then
    raise exception 'tenant_attachments.size_bytes is immutable once set (attachment %)', old.id using errcode = 'check_violation';
  end if;
  if old.mime_type is not null and new.mime_type is distinct from old.mime_type then
    raise exception 'tenant_attachments.mime_type is immutable once set (attachment %)', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists tenant_attachments_immutable_evidence on public.tenant_attachments;
create trigger tenant_attachments_immutable_evidence
  before update on public.tenant_attachments
  for each row execute function public.tg_tenant_attachment_evidence_immutable();
