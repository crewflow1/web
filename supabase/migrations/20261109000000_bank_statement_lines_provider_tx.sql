-- Bank-feed idempotency — provider_tx_id + a per-org dedupe unique index on
-- bank_statement_lines (20260524_payment_tracking).
--
-- WHAT THIS IS. The Open-Banking bank-feed substrate (20261100, DARK) maps
-- aggregator-fetched transactions ONTO the EXISTING bank_statement_lines table so
-- the reconciliation UI lights up at activation. A live feed re-runs on a schedule
-- and MUST NOT re-import the same transaction twice. This migration carves the one
-- column + unique index the sync engine needs to make an import IDEMPOTENT:
--   provider_tx_id  — the aggregator's stable transaction id (TrueLayer
--                     transaction_id / Plaid transaction_id / Nordigen
--                     transactionId). NULL for every existing (CSV-uploaded) row.
--   a PLAIN UNIQUE index on (org_id, provider_tx_id) — so the feed's "insert new
--   lines" is a safe ON CONFLICT DO NOTHING and a re-sync of an overlapping date
--   window adds no duplicate line.
--
-- ── WHY PLAIN (NOT PARTIAL), WHY (org_id, provider_tx_id) ────────────────────
-- The index MUST be plain, not partial. The sync engine (server/services/
-- bank-sync.ts) inserts via PostgREST `.upsert(rows, { onConflict:
-- "org_id,provider_tx_id", ignoreDuplicates: true })`, which emits
-- `INSERT ... ON CONFLICT (org_id, provider_tx_id) DO NOTHING`. Postgres CANNOT
-- infer a PARTIAL index as the ON CONFLICT arbiter unless the statement repeats
-- the index's exact WHERE predicate — which PostgREST does not emit — so a
-- partial index would raise 42P10 ("no unique or exclusion constraint matching
-- the ON CONFLICT specification") on EVERY feed insert. A plain unique index IS
-- inferrable by `ON CONFLICT (org_id, provider_tx_id)`.
--
-- CSV-uploaded lines carry NO provider tx id (provider_tx_id IS NULL) and stay
-- wholly unaffected: Postgres treats NULLs as DISTINCT under a UNIQUE index by
-- default, so the many NULL-provider_tx_id CSV rows never collide with each other
-- and coexist freely. The index only ever constrains feed-imported rows (those
-- with a non-NULL provider_tx_id). The key is org-scoped so the same aggregator
-- tx id can never collide across tenants and dedupe is a #456 org-pinned fact,
-- not a global one. This is the "(org, connection, provider_tx_id)" idiom reduced
-- to (org, provider_tx_id): a deployment binds ONE BANKING_PROVIDER, so
-- provider_tx_id is already unique within an org's single active connection.
--
-- ── DARK / ADDITIVE / SAFE ──────────────────────────────────────────────────
-- Additive and reversible. No row is written or altered — existing lines keep
-- provider_tx_id = NULL, and NULLs-distinct means those CSV rows are unaffected
-- by the unique index. The bank feed is DARK (no credentials, FCA-ungated), so
-- nothing populates this column in any environment today; the column + index
-- simply pre-exist so activation is credentials + flag only. To roll back:
--   drop index if exists public.bank_statement_lines_org_provider_tx_uniq;
--   alter table public.bank_statement_lines drop column if exists provider_tx_id;

alter table public.bank_statement_lines
  add column if not exists provider_tx_id text;

-- Per-org dedupe of feed-imported lines. PLAIN (not partial) so it is inferrable
-- by the sync engine's `ON CONFLICT (org_id, provider_tx_id) DO NOTHING`; NULLs
-- are distinct under UNIQUE, so CSV rows (provider_tx_id NULL) are unaffected.
create unique index if not exists bank_statement_lines_org_provider_tx_uniq
  on public.bank_statement_lines (org_id, provider_tx_id);
