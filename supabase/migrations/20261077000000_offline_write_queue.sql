-- Offline Write Queue — DATABASE-LEVEL idempotency for replayed offline writes.
--
-- Until now "offline mode" meant offline READ only: the PWA shell (Programme F)
-- and the IndexedDB drawing cache (Programme E) let a foreman with no signal open
-- a pre-downloaded drawing, and nothing else. This migration is the server half of
-- the first offline WRITE path (the daily site diary): it makes "retrying a queued
-- write can never create a duplicate" a property of Postgres rather than a
-- property of some JavaScript that a reinstalled service worker, a cleared tab, a
-- double-tap or two open tabs can all defeat.
--
-- ── Why the key lives ON the entity row (and not in a receipts table) ──────────
-- The obvious generic design is a side table — `offline_write_receipts(org_id,
-- client_key, target_id)` — written alongside the entity. It is WRONG here, and
-- the reason is worth writing down because it is the difference between an
-- idempotent queue and a data-loss machine:
--
--   insert receipt;   ← succeeds
--   insert entity;    ← connection dies / statement fails
--
-- leaves a receipt with no entity. The next replay sees the receipt, reports
-- "already recorded", and the foreman's day is gone with a green tick on it. The
-- two statements are only safe inside one transaction, and supabase-js issues one
-- statement per call — so that design forces a SECURITY-context RPC purely to buy
-- atomicity, which is a privileged write path bolted onto a feature whose whole
-- security argument is "no privileged bypass path" (§4).
--
-- Putting the key on the row makes the write ONE statement, so atomicity is
-- structural: either the row (with its key) exists or it does not. A replay is a
-- plain unique-violation the caller translates into "already recorded, here is the
-- id" — see server/services/offline-writes.ts. No transaction window exists to
-- lose anything in.
--
-- The cost of that choice is deliberate and is the FEATURE, not the drawback:
-- enabling offline writes for a second entity needs a migration (this column +
-- this index) as well as a registry entry, so no entity can quietly become
-- offline-writable by a code change alone. lib/offline/registry.ts is the code-side
-- gate; this file is the database-side gate. Both must be opened on purpose.
--
-- ── Scope of `client_write_key` uniqueness: (org_id, key) ──────────────────────
-- Org-scoped, not global. The key is generated on a device by crypto.randomUUID(),
-- so a collision across two orgs is not a realistic event — but scoping the index
-- to org_id means that even if one ever happened, one tenant's replay could never
-- collapse into, or be reported as, another tenant's row. It also keeps the index
-- aligned with every other tenant index in this schema (org_id leading).
--
-- Partial (`where client_write_key is not null`): every diary row written before
-- this migration has a NULL key, and NULLs are not equal in a unique index anyway —
-- the WHERE clause just keeps the index small and says the intent out loud.
--
-- ── `offline_authored_at` ─────────────────────────────────────────────────────
-- A site diary is dispute and handover EVIDENCE. An entry written in a basement at
-- 16:02 and synced at 18:30 when the van found signal would otherwise carry only
-- created_at = 18:30, which misrepresents when the record was made. This column
-- preserves the device-clock time the foreman actually wrote it.
--
-- It is UNTRUSTED provenance and is treated as such: it is a device clock, so it
-- can be wrong, skewed or deliberately set. It is therefore NEVER used for
-- ordering, retention, authorization or any comparison — only displayed, and only
-- labelled as written offline. NULL for every online write (the overwhelming
-- majority), so its absence is meaningful: "this entry was authored online".
--
-- ── Additive / reversible / teardown-safe ─────────────────────────────────────
-- Two nullable columns and one partial index on an EXISTING table. No new table,
-- no new foreign key, no RESTRICT, no trigger, no RLS change — the existing
-- site_diary_entries policies (20260920000000) continue to govern every write, and
-- a queued write replays through them unchanged.
--
-- Org teardown (the 20261052 lesson) is unaffected BY CONSTRUCTION: this migration
-- adds no referencing object. site_diary_entries.org_id remains
-- `on delete cascade`, so `delete from organizations` still removes these rows;
-- dropping an index and two columns as part of that cascade is not a thing
-- Postgres has to do. Proven, not assumed, in
-- __tests__/integration/rls/offline-write-idempotency.test.ts.
--
-- Reverse: drop the index, drop the two columns.

alter table public.site_diary_entries
  -- Client-generated idempotency key. Set on EVERY write (the online form path
  -- generates one server-side too) so there is exactly ONE write path to reason
  -- about, not an online path and a divergent offline path.
  add column if not exists client_write_key uuid,
  -- Device-clock time the entry was authored offline. NULL = authored online.
  -- UNTRUSTED: display-only provenance, never ordered or compared on.
  add column if not exists offline_authored_at timestamp with time zone;

comment on column public.site_diary_entries.client_write_key is
  'Client-generated idempotency key for the offline write queue. Unique per org (partial unique index) so replaying a queued write can never create a duplicate row. Set on online writes too — one write path, not two.';
comment on column public.site_diary_entries.offline_authored_at is
  'Device-clock time this entry was authored while offline; NULL when authored online. UNTRUSTED provenance: display only, never used for ordering, retention or authorization.';

-- THE idempotency guarantee. A replayed queued write raises 23505 here, which
-- server/services/offline-writes.ts translates into "already recorded" and the
-- original row id. One row, no matter how many times the queue retries.
create unique index if not exists site_diary_entries_client_write_key_uidx
  on public.site_diary_entries (org_id, client_write_key)
  where client_write_key is not null;
