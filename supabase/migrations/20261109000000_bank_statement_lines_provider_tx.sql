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
--   a PARTIAL UNIQUE index on (org_id, provider_tx_id) WHERE provider_tx_id IS NOT
--   NULL — so the feed's "insert new lines" is a safe ON CONFLICT DO NOTHING and a
--   re-sync of an overlapping date window adds no duplicate line.
--
-- ── WHY PARTIAL, WHY (org_id, provider_tx_id) ───────────────────────────────
-- CSV-uploaded lines carry NO provider tx id (provider_tx_id IS NULL) and must be
-- wholly unaffected — a plain UNIQUE would collapse all of them (many NULLs are
-- distinct under UNIQUE, but the intent is explicit: the index only governs
-- feed-imported rows). The key is org-scoped so the same aggregator tx id can
-- never collide across tenants and dedupe is a #456 org-pinned fact, not a global
-- one. This is the "(org, connection, provider_tx_id)" idiom reduced to
-- (org, provider_tx_id): a deployment binds ONE BANKING_PROVIDER, so provider_tx_id
-- is already unique within an org's single active connection.
--
-- ── DARK / ADDITIVE / SAFE ──────────────────────────────────────────────────
-- Additive and reversible. No row is written or altered — existing lines keep
-- provider_tx_id = NULL and are excluded from the partial index. The bank feed is
-- DARK (no credentials, FCA-ungated), so nothing populates this column in any
-- environment today; the column + index simply pre-exist so activation is
-- credentials + flag only. To roll back:
--   drop index if exists public.bank_statement_lines_org_provider_tx_uniq;
--   alter table public.bank_statement_lines drop column if exists provider_tx_id;

alter table public.bank_statement_lines
  add column if not exists provider_tx_id text;

-- Per-org dedupe of feed-imported lines. Partial so CSV rows (NULL) are ignored.
create unique index if not exists bank_statement_lines_org_provider_tx_uniq
  on public.bank_statement_lines (org_id, provider_tx_id)
  where provider_tx_id is not null;
