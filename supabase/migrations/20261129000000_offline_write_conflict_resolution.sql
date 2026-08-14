-- Offline Write Queue — CONFLICT RESOLUTION, and the first offline UPDATEs.
--
-- 20261077 built the queue and enabled ONE create (the site diary); 20261083 and
-- 20261101 added four more DRAFT/append-only CREATEs. Every entity enabled so far
-- shares one property that made the milestone honest WITHOUT a merge policy:
-- APPEND-ONLY. A replay could only ever add a row, never touch one somebody else
-- had edited in the meantime, so "no conflict UI in this milestone" (the registry
-- header's exact words) was a safe stance — insert-only idempotency and nothing
-- more.
--
-- This migration is the database half of the step that stance was always deferring:
-- offline UPDATEs, made safe by CONFLICT RESOLUTION. It opens the gate for the two
-- entities the registry header names as blocked SOLELY on the absence of a conflict
-- UI — the site diary and the snag — now that one exists:
--
--   site_diary.update   The diary is dispute/handover EVIDENCE that admins amend.
--                       A foreman correcting yesterday's entry from a basement is
--                       the exact no-signal moment the queue exists for; the risk
--                       the header flagged ("replaying an update silently reverts
--                       their change") is precisely what the merge below removes.
--   snag.update         A defect's free-text detail (title, location, trade, the
--                       fix note) edited on site with no signal, reconciled field
--                       by field against whatever the office changed meanwhile.
--
-- Neither replays a LIFECYCLE transition: snag.status / resolved_at stay online
-- only (server-pinned provenance, the toolbox-ack ground the header records), and
-- the update payload cannot carry a status at all (Zod strips it — see
-- lib/snags/schema.ts updateSnagSchema, built from the create schema which has no
-- status field). An offline update touches only owned free-text/scalar columns.
--
-- ── The version anchor is updated_at, which ALREADY EXISTS ────────────────────
-- Optimistic concurrency needs a per-row version the client captured at read time
-- and the server compares at replay time. Both tables already carry
-- `updated_at timestamptz not null default now()`, maintained by the shared
-- tg_set_updated_at() trigger (20260919 snags, 20260920 diary). So there is NO new
-- version column: the client sends the updated_at it rendered the edit form with,
-- and the server (server/services/offline-writes.ts) does a 3-way field merge
-- against the current row and a compare-and-swap keyed on the CURRENT updated_at it
-- just read. A change landing between the read and the swap fails the swap and is
-- retried — race-free, no lock, no new column.
--
-- ── Why ONE new column: last_offline_write_key ────────────────────────────────
-- The create path's idempotency is structural: the key lives ON the row and the
-- unique index on (org_id, client_write_key) makes a replayed INSERT a plain 23505
-- (20261077's argument, unchanged). An UPDATE creates no new row, so that index
-- cannot protect it, and updated_at is the WRONG marker to dedupe on: the first
-- successful replay bumps updated_at (the trigger), so a second delivery of the
-- SAME queued update (a lost response, a reinstalled service worker) would see a
-- moved version and could not tell "I already applied this" from "someone else
-- changed it". So each update-enabled row carries the client key of the LAST
-- offline update applied to it. Replay protocol (one statement, structural like the
-- create path):
--
--   read row (fields + updated_at + last_offline_write_key)
--     last_offline_write_key = THIS item's key  -> duplicate (already applied; done)
--     otherwise -> 3-way merge, then CAS UPDATE ... where updated_at = <read version>
--                  SET ..., last_offline_write_key = <this key>
--
-- The marker is set in the SAME statement as the merged fields, so "the row was
-- changed" and "the row records who last changed it offline" can never disagree.
-- It is deliberately NOT unique: one queued update targets exactly one row, and two
-- different updates to the same row are ordered by the queue's seq + the client's
-- stop-on-first-transient-failure flush (documented in the write core), so the
-- pathological "K applied, J applied, K re-applied" cannot arise through the flush.
--
-- last_offline_write_key is distinct from client_write_key on purpose: the latter
-- anchors the row's CREATE idempotency (and its unique index) and must never be
-- rewritten by an edit. A row created online then edited offline keeps its original
-- client_write_key (or NULL) and gains a last_offline_write_key.
--
-- ── No new write privilege — the whole security argument is preserved ─────────
-- A queued update is still not a special write: it runs under the caller's own
-- session, through the TENANT (user-JWT) client, against the SAME RLS UPDATE
-- policies that already govern the online edit action, and against the SAME Zod
-- schema. This migration adds NO function, NO SECURITY DEFINER, NO RPC, NO trigger,
-- NO policy, NO grant — the merge and the CAS are ordinary tenant-scoped statements
-- in server/services/offline-writes.ts. The security suite pins that absence.
--
-- ── Additive / reversible / teardown-safe (the 20261052 lesson) ──────────────
-- One nullable column per table, no index, no FK, no RESTRICT, nothing on the
-- `delete from organizations` cascade path (both tables' org_id already cascades).
-- Reverse: drop the two columns.

alter table public.site_diary_entries
  -- Client key of the LAST offline UPDATE applied to this row. Lets a re-delivered
  -- queued update be recognised as already-applied (duplicate) instead of racing
  -- its own bumped updated_at. NULL until an offline edit lands. NOT unique.
  add column if not exists last_offline_write_key uuid;

comment on column public.site_diary_entries.last_offline_write_key is
  'Client key of the last offline UPDATE applied to this row (offline write queue conflict resolution). Distinct from client_write_key (which anchors CREATE idempotency and is never rewritten). Used to make a re-delivered queued update idempotent against its own updated_at bump. Not unique.';

alter table public.snags
  add column if not exists last_offline_write_key uuid;

comment on column public.snags.last_offline_write_key is
  'Client key of the last offline UPDATE applied to this row (offline write queue conflict resolution). Distinct from client_write_key (which anchors CREATE idempotency and is never rewritten). Used to make a re-delivered queued update idempotent against its own updated_at bump. Not unique.';
