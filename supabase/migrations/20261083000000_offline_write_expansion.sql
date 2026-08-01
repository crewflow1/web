-- Offline Write Queue — expansion to two more entities (Train 5).
--
-- 20261077000000 built the queue and enabled exactly ONE entity (the site
-- diary), making "enable a second entity" a three-gate act by design: a
-- migration (this file), a registry row (lib/offline/registry.ts) and a server
-- handler (server/services/offline-writes.ts). This migration opens the
-- database gate for TWO more entities, chosen because both are append-only
-- CREATEs with no merge policy to lie about:
--
--   1. snags (CREATE)                       — a defect spotted in a basement is
--      exactly the diary's shape: append-only, single-author, no financial
--      consequence, no sequencing. Photos are excluded offline exactly as the
--      diary excludes them (the queue carries JSON, never binary).
--   2. material_requests (CREATE, DRAFT)    — the site→office ask. Offline it
--      lands as a DRAFT only: submission is a lifecycle transition whose
--      provenance (submitted_at) is pinned server-side by tg_material_request
--      _lifecycle (20261066) and which fans out notifications; replaying a
--      "submission" hours later would forge the one timestamp the trigger
--      exists to protect. The draft is the honest offline artefact.
--
-- ── Why NOT toolbox-talk acknowledgements (the vertical considered first) ────
-- The ack rides safety_acknowledgements, whose SECURITY DEFINER validator
-- (tg_safety_ack_validate, 20261020/20261026) server-pins acknowledged_at :=
-- now() — described there as "the single most load-bearing fact" — binds the
-- signer to auth.uid(), and requires the version anchor to match a talk that is
-- ISSUED at write time. An ack captured offline at 14:00 and replayed at 19:00
-- would be recorded as signed at 19:00, possibly against a revision superseded
-- at 16:00. That is not a delayed record of an attestation; it is a different
-- attestation. The engine's natural key — one ack per (subject, version, user)
-- — would make the replay idempotent, but idempotency cannot make the captured
-- evidence honest, so the vertical was swapped for material requests rather
-- than weakened to fit. No ack column is touched here.
--
-- ── snags: same shape as the diary, one statement, key on the row ────────────
-- The 20261077 receipts-table argument applies unchanged: the key lives ON the
-- entity row so the write is one atomic statement and a replay is a plain
-- 23505 the server translates into "already recorded, here is the id".
--
-- ── material_requests: a TWO-statement create, handled without a receipt ─────
-- A request is a header plus its lines (two tables, two supabase-js
-- statements). The idempotency key lives on the HEADER only, and the replay
-- protocol in server/services/material-request-writes.ts is key-first:
--
--   lookup by (org_id, client_write_key)
--     → found, has lines   : duplicate (done)
--     → found, zero lines  : the previous attempt died between the two
--                            statements — insert the lines NOW, then done
--     → absent             : allocate number, insert header, insert lines
--
-- The header's partial unique index makes step 3's replay collapse; the lines
-- index below makes the zero-lines RECOVERY safe against two concurrent
-- replays (two tabs, a reinstalled service worker racing a manual "Sync now"):
-- both see zero lines, both insert, and the second violates
-- (material_request_id, sort_order) instead of doubling the ask. That index
-- encodes an invariant every existing writer already holds — lines are only
-- ever inserted as one array with sort_order = 0..n-1 by createMaterialRequest,
-- and no code path updates sort_order — so no existing row can violate it.
--
-- A single-statement alternative (an RPC inserting header + lines atomically)
-- was rejected: the queue's entire security argument is "a queued write is not
-- a special write" (no privileged replay path), and a new SECURITY DEFINER
-- write function is exactly the bypass that argument forbids.
--
-- NOTE ON THE NUMBER: a request number (MR-0007) is allocated at SYNC time by
-- the existing next_material_request_number(), never minted offline — offline
-- numbering would fork the per-org sequence, the 20261066-header problem this
-- design refuses to create.
--
-- ── Additive / reversible / teardown-safe (the 20261052 lesson) ──────────────
-- Four nullable columns and three partial/unique indexes on EXISTING tables. No
-- new table, no new function, no new FK, no RESTRICT, no trigger, no RLS or
-- policy change — the existing snags (20260919) and material_requests
-- (20261066/67) policies and triggers govern every replayed write unchanged.
-- Nothing here sits on the `delete from organizations` cascade path.
-- Reverse: drop the three indexes, drop the four columns.

-- ── 1. snags ─────────────────────────────────────────────────────────────────
alter table public.snags
  -- Client-generated idempotency key. Set on EVERY write (the online form path
  -- mints one server-side too) so there is ONE write path to reason about.
  add column if not exists client_write_key uuid,
  -- Device-clock time the snag was authored offline. NULL = authored online.
  -- UNTRUSTED: display-only provenance, never ordered or compared on.
  add column if not exists offline_authored_at timestamp with time zone;

comment on column public.snags.client_write_key is
  'Client-generated idempotency key for the offline write queue. Unique per org (partial unique index) so replaying a queued snag can never create a duplicate row. Set on online writes too — one write path, not two.';
comment on column public.snags.offline_authored_at is
  'Device-clock time this snag was authored while offline; NULL when authored online. UNTRUSTED provenance: display only, never used for ordering, retention or authorization.';

-- THE idempotency guarantee for snags. Org-scoped for the same reason as
-- 20261077: one tenant's replay must never collapse into, or be reported as,
-- another tenant's row. Partial: every pre-existing row has a NULL key.
create unique index if not exists snags_client_write_key_uidx
  on public.snags (org_id, client_write_key)
  where client_write_key is not null;

-- ── 2. material_requests (header) ───────────────────────────────────────────
alter table public.material_requests
  add column if not exists client_write_key uuid,
  add column if not exists offline_authored_at timestamp with time zone;

comment on column public.material_requests.client_write_key is
  'Client-generated idempotency key for the offline write queue (draft creates only). Unique per org (partial unique index). Set on online creates too — one write path, not two. The request NUMBER is always allocated at sync time, never offline.';
comment on column public.material_requests.offline_authored_at is
  'Device-clock time this request was authored while offline; NULL when authored online. UNTRUSTED provenance: display only, never used for ordering, retention or authorization.';

create unique index if not exists material_requests_client_write_key_uidx
  on public.material_requests (org_id, client_write_key)
  where client_write_key is not null;

-- ── 3. material_request_lines: the recovery race-closer ─────────────────────
-- Lines carry NO key of their own; their idempotency derives from the header's
-- key plus this index (see the replay protocol in the file header). Two
-- concurrent zero-lines recoveries both insert sort_order 0..n-1 for the same
-- request; the second one 23505s here and is reported as "already recorded"
-- instead of silently doubling what the site asked for.
create unique index if not exists material_request_lines_request_sort_uidx
  on public.material_request_lines (material_request_id, sort_order);
