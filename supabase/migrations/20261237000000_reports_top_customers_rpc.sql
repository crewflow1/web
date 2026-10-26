-- Reports R2 — top-customers-by-revenue as a DB-side grouped aggregate.
--
-- WHY THIS EXISTS
-- ---------------
-- lib/reports/topCustomersByRevenue() used to fetch EVERY paid invoice (no date
-- bound — all-time) AND EVERY customer for the org, then group/sum/sort in
-- TypeScript to a top-10. That is the loudest over-fetch on /reports: both reads
-- scale with the org's lifetime ledger while the output is a 10-row ranking
-- (see ~/crewflow-research/_audit/perf/REPORTS-MAP.md §1.3, §3 O-T, §4 R2). This
-- function moves the `sum, count group by customer` + `order by revenue desc
-- limit N` into SQL, so PostgREST returns only the N rows the report renders.
--
-- RESOLUTION RULE — preserved EXACTLY from the TypeScript it replaces
-- ------------------------------------------------------------------
--   1. invoices.customer_id  (the denormalised anchor, migration 20260915) is
--      preferred. invoices_quote_id_fkey is ON DELETE SET NULL, so a deleted
--      quote nulls quote_id/quote.customer while customer_id survives —
--      resolving via the quote alone would silently drop that invoice's paid
--      revenue from the ranking.
--   2. the quote -> customer link (quotes.customer_id) is the pre-backfill
--      FALLBACK, used only when customer_id is null.
--   3. paid revenue that resolves to NEITHER lands in an explicit "Unattributed"
--      bucket (resolved id = NULL, grouped as one row), NEVER dropped. That is
--      the reconciliation guarantee: Σ(revenue over ALL buckets) equals the sum
--      of every paid invoice's `amount`, so the ranking reconciles with
--      revenuePerMonth (same ex-VAT `amount`, same status='paid' filter) and no
--      row vanishes. The caller maps the NULL id to the UNATTRIBUTED_CUSTOMER_ID
--      sentinel + "Unattributed" label (lib/reports/aggregates.ts owns the
--      label, exactly as before).
--
-- Revenue is EX-VAT: it sums invoices.amount (net subtotal), NEVER the generated
-- GROSS `total` (= amount + vat_total). Summing `total` overstated every
-- customer's revenue by the VAT rate and disagreed with /insights — the same
-- rule the TypeScript carried.
--
-- SECURITY
-- --------
-- SECURITY DEFINER bypasses RLS, so this is a member of the secdef-org-RPC class
-- that __tests__/integration/rls/secdef-org-rpc-guard.test.ts introspects. It
-- MIRRORS the canonical guard shipped on next_invoice_number and the systemic
-- fix in 20261116000000: the FIRST act authorises the caller against p_org_id
-- via public.current_org_ids() and raises 42501 for a non-member, so a Data-API
-- caller with the public anon key cannot read across the tenant boundary.
-- service_role (the delivery-cron render path, which has no JWT) skips the check
-- exactly as the sibling RPCs do, and is STILL org-filtered by p_org_id inside.
-- The explicit `grant execute ... to authenticated` mirrors the invoice/quote/
-- counter RPCs (guarded, not revoked — real members must still call it).

create or replace function public.reports_top_customers_by_revenue(
  p_org_id uuid,
  p_limit int default 10
)
returns table (
  customer_id uuid,
  name text,
  revenue numeric,
  invoice_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Canonical org-membership guard — MUST be the first act (SECURITY DEFINER
  -- bypasses RLS). A non-member calling via the Data API is refused with 42501
  -- before any row is read; service_role (cron/admin render) skips it and is
  -- org-filtered by p_org_id below.
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  return query
  with paid as (
    -- customer_id FIRST, quote->customer as fallback, NULL => Unattributed.
    -- The quote is joined org-pinned so a (defensively) cross-org quote_id can
    -- never contribute a foreign customer id.
    select
      coalesce(i.customer_id, q.customer_id) as resolved_id,
      i.amount                                as amount
    from public.invoices i
    left join public.quotes q
      on q.id = i.quote_id
     and q.org_id = p_org_id
    where i.org_id = p_org_id
      and i.status = 'paid'
  )
  select
    p.resolved_id                     as customer_id,
    coalesce(c.name, '—')             as name,
    coalesce(sum(p.amount), 0)::numeric as revenue,
    count(*)::bigint                  as invoice_count
  from paid p
  left join public.customers c
    on c.id = p.resolved_id
   and c.org_id = p_org_id
  group by p.resolved_id, c.name
  -- Deterministic ranking: revenue desc, then a stable tiebreak so a tie that
  -- straddles the N boundary resolves the same way every call (the old JS sort
  -- was stable but tie order was incidental; this makes it explicit).
  order by revenue desc, invoice_count desc, name asc, p.resolved_id asc nulls last
  limit greatest(coalesce(p_limit, 10), 0);
end;
$$;

grant execute on function public.reports_top_customers_by_revenue(uuid, int) to authenticated;
