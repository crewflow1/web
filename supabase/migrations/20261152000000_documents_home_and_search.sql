-- ============================================================================
-- Central Documents home + extended global search.
--
-- Two purely-additive changes, no drops / no data mutation:
--
--   1. tenant_attachments.portal_visible — a per-attachment flag (default FALSE)
--      so a quote / job attachment can later be surfaced in the customer portal
--      document library. Default FALSE means ZERO behaviour change until a row
--      is explicitly flagged; the portal read (lib/customers/portal-documents.ts
--      + app/customer-portal/_attachments.ts) only ever admits flagged rows that
--      ALSO resolve to an entity owned by the token-resolved customer.
--
--   2. pg_trgm GIN indexes on the text columns newly reached by the global
--      search route (app/api/search/route.ts) — job_documents, snags,
--      purchase_orders and site_reports. The search matches with ILIKE `%term%`,
--      which is only index-backed by a trigram GIN index (mirrors the address
--      search work in 20261042000000_address_search_trgm.sql). Without these the
--      new branches would seq-scan each table.
--
-- Idempotent: every statement is `if not exists`.
-- ============================================================================

-- 1. Portal-visibility flag ---------------------------------------------------
alter table public.tenant_attachments
  add column if not exists portal_visible boolean not null default false;

-- Partial index: only flagged rows are ever read by the portal, and they are
-- rare, so the index stays tiny and the portal lookup is index-only.
create index if not exists tenant_attachments_portal_visible_idx
  on public.tenant_attachments (org_id, target_table, target_id)
  where portal_visible;

-- 2. Trigram search indexes ---------------------------------------------------
create extension if not exists pg_trgm;

-- job_documents: title + external_reference are the ILIKE'd columns.
create index if not exists job_documents_title_trgm
  on public.job_documents using gin (title gin_trgm_ops);
create index if not exists job_documents_external_reference_trgm
  on public.job_documents using gin (external_reference gin_trgm_ops);

-- snags: title / description / location / trade.
create index if not exists snags_title_trgm
  on public.snags using gin (title gin_trgm_ops);
create index if not exists snags_description_trgm
  on public.snags using gin (description gin_trgm_ops);
create index if not exists snags_location_trgm
  on public.snags using gin (location gin_trgm_ops);
create index if not exists snags_trade_trgm
  on public.snags using gin (trade gin_trgm_ops);

-- purchase_orders: number / supplier_reference / notes.
create index if not exists purchase_orders_number_trgm
  on public.purchase_orders using gin (number gin_trgm_ops);
create index if not exists purchase_orders_supplier_reference_trgm
  on public.purchase_orders using gin (supplier_reference gin_trgm_ops);
create index if not exists purchase_orders_notes_trgm
  on public.purchase_orders using gin (notes gin_trgm_ops);

-- site_reports: title / report_number.
create index if not exists site_reports_title_trgm
  on public.site_reports using gin (title gin_trgm_ops);
create index if not exists site_reports_report_number_trgm
  on public.site_reports using gin (report_number gin_trgm_ops);
