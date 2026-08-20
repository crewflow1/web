-- Offline PHOTO / FILE capture queue — the database idempotency gate.
--
-- The JSON offline write queue (20261077 and friends) deliberately carries no
-- binary; this train adds a SEPARATE browser-local queue for photo/file captures
-- authored with no signal (lib/offline/photo-queue.ts), uploaded on reconnect
-- through server/services/offline-photo-writes.ts. That upload path is the ONLINE
-- photo path (uploadTenantAttachment) specialised for replay, so its idempotency
-- lives where every other offline write's does: a client-generated key ON the row,
-- unique per org.
--
-- tenant_attachments already carries the evidence discipline the offline path
-- reuses verbatim — a frozen SHA-256 content_hash of the exact stored bytes, an
-- org-first storage path, service-role byte writes with tenant-client rows under
-- RLS. This migration adds ONLY the two columns the offline REPLAY needs, mirroring
-- the diary/snag/material-request idempotency columns exactly:
--
--   client_write_key      client-generated idempotency key. A replayed capture
--                         (lost response, reinstalled SW, two tabs, a manual
--                         "Upload now" racing the auto-flush) collapses onto the
--                         one attachment via the partial unique index below,
--                         instead of uploading the same photo twice. Set on the
--                         online path too where a caller supplies one — one write
--                         path, not two — and NULL for every pre-existing row and
--                         for the webhook/service uploads that dedupe on content
--                         hash instead.
--   offline_authored_at   device-clock time the capture was taken with no signal;
--                         NULL when uploaded online. UNTRUSTED provenance: display
--                         only, never ordered/compared/authorized on.
--
-- ── Additive / reversible / teardown-safe (the 20261052 lesson) ──────────────
-- Two nullable columns and one partial unique index on an EXISTING table. No new
-- table, no new function, no new FK, no RESTRICT, no trigger, no RLS/policy/grant
-- change — the existing tenant_attachments policies and the storage-evidence
-- immutability triggers govern every offline-replayed upload unchanged. Nothing
-- here sits on the `delete from organizations` cascade path (org_id already
-- cascades). Reverse: drop the index, drop the two columns.

alter table public.tenant_attachments
  add column if not exists client_write_key uuid,
  add column if not exists offline_authored_at timestamp with time zone;

comment on column public.tenant_attachments.client_write_key is
  'Client-generated idempotency key for the offline photo/file capture queue. Unique per org (partial unique index) so replaying a queued capture can never upload a duplicate attachment. NULL for pre-existing rows and for content-hash-deduped service uploads.';
comment on column public.tenant_attachments.offline_authored_at is
  'Device-clock time this attachment was captured while offline; NULL when uploaded online. UNTRUSTED provenance: display only, never used for ordering, retention or authorization.';

-- THE idempotency guarantee. Org-scoped for the same reason as 20261077: one
-- tenant's replay must never collapse into, or be reported as, another tenant's
-- row. Partial: every pre-existing row (and every content-hash-deduped upload) has
-- a NULL key and is unaffected.
create unique index if not exists tenant_attachments_client_write_key_uidx
  on public.tenant_attachments (org_id, client_write_key)
  where client_write_key is not null;
