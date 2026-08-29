-- =====================================================================
-- 20261226000000_api_request_log_request_id.sql
--
-- Persist the per-request correlation id on the public-API access log.
--
-- lib/api/request-id.ts already mints/propagates one id per HTTP request
-- (the x-request-id response header, Sentry tag) — but nothing persisted
-- it, so "which DB-audited API call was Sentry event X?" was unanswerable.
-- This adds api_request_log.request_id, written by lib/public-api/audit.ts
-- from the SAME validated value the middleware echoes.
--
-- HONEST SCOPE — public API only. api_request_log rows are written solely
-- by the v1 guard for ADMITTED key-authenticated requests; internal RSC
-- page loads never audit-log requests, so there is nothing to attach an
-- id to elsewhere. NULLable: rows written before this migration, and any
-- write where no acceptable id was present, carry NULL.
--
-- The CHECK mirrors lib/api/request-id.ts SAFE_INBOUND_ID exactly
-- (^[A-Za-z0-9._-]{8,200}$): the id appears in response headers and log
-- lines, so the column refuses anything that could smuggle a header line
-- or bloat logs even if a future writer skips the app-side validation.
--
-- No index: the read path is "given a request id from a Sentry event or
-- support ticket, find the one row" — a rare manual lookup on an
-- admin-only telemetry table, not worth taxing every insert on the
-- rate-limited hot path.
-- =====================================================================

alter table public.api_request_log
  add column if not exists request_id text
    check (request_id is null or request_id ~ '^[A-Za-z0-9._-]{8,200}$');

comment on column public.api_request_log.request_id is
  'The x-request-id correlation id for this admitted request (same value '
  'echoed in the response header and tagged in Sentry). Validated against '
  'the SAFE_INBOUND_ID pattern from lib/api/request-id.ts both app-side '
  'and by the CHECK. NULL for pre-migration rows or when no acceptable id '
  'was available.';
