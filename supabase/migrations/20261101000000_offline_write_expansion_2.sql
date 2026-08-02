-- Offline Write Queue — expansion to two more entities (Train "offl").
--
-- 20261077000000 built the queue and enabled ONE entity (the site diary);
-- 20261083000000 added snags + material-request DRAFTS. Enabling an entity is a
-- three-gate act by design: a migration (this file), a registry row
-- (lib/offline/registry.ts) and a server handler reachable from
-- dispatchOfflineWrite (server/services/offline-writes.ts). A no-drift test
-- asserts (2) and (3) stay in lockstep; (1) cannot be faked in code.
--
-- This migration opens the database gate for TWO more entities, both chosen
-- because they are the DRAFT create of a controlled record — append-only,
-- single-author, no money, and no lifecycle transition captured offline (the
-- material_request.create precedent verbatim):
--
--   1. delay_events (CREATE, DRAFT)   — an EOT delay event (20261084). Its whole
--      value is CONTEMPORANEOUS capture: "what stopped the work, when, and what
--      records were kept AT THE TIME" is exactly what a foreman with no signal
--      needs to record before the detail is lost. It is born 'draft'
--      (status default), and the 'recorded'/'withdrawn' transitions — whose
--      provenance (recorded_at/by) the transition trigger pins server-side and
--      whose draft-CHECK makes pre-forged provenance unrepresentable — are NOT
--      captured offline, exactly as material_request.submit is not. The draft is
--      the honest offline artefact; a human promotes it to 'recorded' online.
--      Carries no money: working_days_lost is the recorder's CLAIM, never
--      computed, and nothing here touches finances.
--
--   2. site_reports (CREATE, DRAFT)   — the site report (20260922). Offline it
--      lands as a DRAFT (status 'draft', revision 1). The report_number is a
--      per-org COSMETIC label allocated at SYNC time by the same count-based
--      helper the online action uses (never minted offline), and the lifecycle
--      (ready_for_review → approved → issued, with server-pinned issued_at and
--      the snapshot freeze) stays online-only. The draft is the honest offline
--      artefact; a human completes and issues it online.
--
-- ── Why NOT the other field candidates considered this train ─────────────────
-- toolbox-talk sign-off / ITP inspection sign-off: both are ATTESTATIONS whose
-- timestamp is server-pinned evidence (safety_acknowledgements.acknowledged_at,
-- 20261020/26; inspection_signoffs.recorded_at, 20261076 — "the single most
-- load-bearing fact on the row, so the client can never backdate it"), version-
-- anchored to a document ISSUED at write time, and carrying a typed-name
-- signature with legal force. An attestation captured at 14:00 and replayed at
-- 19:00 is recorded as signed at 19:00, possibly against a revision superseded
-- in between — a DIFFERENT attestation, not a delayed record of one.
-- Idempotency cannot make dishonest evidence honest, so both are left offline
-- read-only. No ack/signoff column is touched here.
--
-- time / labour capture: PAYROLL. A replayed or duplicated time entry becomes
-- money paid; it deserves its own approval design, not the append-only queue.
--
-- job_progress_observations: its ONLINE write path is an UPSERT on the natural
-- key (job_id, observed_on) — a create-OR-CORRECT. Replaying it hours later
-- would silently revert a correction someone made while the device was offline,
-- the exact reason site_diary/snag UPDATE are not offline-writable, and forking
-- it to an insert-only offline path would break the "a queued write is not a
-- special write" property (one shared write core, online and offline). Left
-- read-only offline.
--
-- ── Additive / reversible / teardown-safe (the 20261052 lesson) ──────────────
-- Four nullable columns and two partial/unique indexes on EXISTING tables. No
-- new table, no new function, no new FK, no RESTRICT, no trigger, no RLS or
-- policy change — the existing delay_events (20261084) and site_reports
-- (20260922) policies and triggers govern every replayed write unchanged.
-- Both tables' org_id FK already cascades on `delete from organizations`;
-- nothing here sits on that cascade path or blocks it.
-- Reverse: drop the two indexes, drop the four columns.

-- ── 1. delay_events ──────────────────────────────────────────────────────────
alter table public.delay_events
  -- Client-generated idempotency key. Set on EVERY write (the online form path
  -- mints one server-side too) so there is ONE write path to reason about.
  add column if not exists client_write_key uuid,
  -- Device-clock time the delay event was authored offline. NULL = authored
  -- online. UNTRUSTED: display-only provenance, never ordered or compared on.
  add column if not exists offline_authored_at timestamp with time zone;

comment on column public.delay_events.client_write_key is
  'Client-generated idempotency key for the offline write queue (draft creates only). Unique per org (partial unique index) so replaying a queued delay event can never create a duplicate row. Set on online writes too — one write path, not two.';
comment on column public.delay_events.offline_authored_at is
  'Device-clock time this delay event was authored while offline; NULL when authored online. UNTRUSTED provenance: display only, never used for ordering, retention or authorization.';

-- THE idempotency guarantee for delay events. Org-scoped for the same reason as
-- 20261077/20261083: one tenant's replay must never collapse into, or be
-- reported as, another tenant's row. Partial: every pre-existing row has a NULL
-- key.
create unique index if not exists delay_events_client_write_key_uidx
  on public.delay_events (org_id, client_write_key)
  where client_write_key is not null;

-- ── 2. site_reports ──────────────────────────────────────────────────────────
alter table public.site_reports
  add column if not exists client_write_key uuid,
  add column if not exists offline_authored_at timestamp with time zone;

comment on column public.site_reports.client_write_key is
  'Client-generated idempotency key for the offline write queue (draft creates only). Unique per org (partial unique index). Set on online creates too — one write path, not two. The report_number is always a cosmetic label allocated at sync time, never offline.';
comment on column public.site_reports.offline_authored_at is
  'Device-clock time this report draft was authored while offline; NULL when authored online. UNTRUSTED provenance: display only, never used for ordering, retention or authorization.';

create unique index if not exists site_reports_client_write_key_uidx
  on public.site_reports (org_id, client_write_key)
  where client_write_key is not null;
