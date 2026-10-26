-- Workstream R7 — AR/AP ageing as org-guarded SECURITY DEFINER RPCs.
--
-- WHY THIS EXISTS (the over-fetch)
-- --------------------------------
-- /reports/ageing (server/services/aged-ledgers.ts) builds the aged DEBTORS and
-- aged CREDITORS listings by reading WHOLE org ledgers and bucketing in
-- TypeScript: EVERY invoice (including draft / paid / void) plus the ENTIRE
-- invoice_payments table are pulled to the app, folded per invoice, netted, then
-- most of them discarded as settled or non-collectable. The same happens on the
-- payables side with finances + supplier_payment_allocations. Row volume grows
-- with the tenant's whole trading history while only the UNSETTLED tail is ever
-- shown.
--
-- These two functions move the invoice⋈payments (and bill⋈allocations) join, the
-- per-document netting and the settled-exclusion into SQL, returning only the
-- unsettled documents with their outstanding balance and age bucket already
-- computed. The TypeScript layer keeps the SINGLE grouping / sort / totals
-- authority (lib/commercial/ageing.buildAgeingLedger), which is DESIGNED to
-- receive already-settled amounts — so no money derivation is duplicated in the
-- grouping layer and the /cash reconciliation identities are preserved.
--
-- THE DERIVATIONS MIRRORED HERE, AND WHERE THEIR AUTHORITY LIVES
-- -------------------------------------------------------------
-- The two per-document derivations that move into SQL are mirrored EXACTLY from
-- the pure TypeScript authorities, and pinned to byte-equality by the real-PG
-- integration test __tests__/integration/reports/aged-ledgers-rpc.test.ts
-- (snapshot-equality against the legacy whole-fetch path, over a cross-product
-- of status × settlement × age band):
--
--   RECEIVABLES
--     population   lib/invoices/overdue.OVERDUE_COLLECTABLE_STATUSES
--                  = sent · awaiting_payment · partially_paid · overdue
--                  (the legacy `overdue` enum value is still READ). draft / paid
--                  / void are NOT collectable.
--     remaining    lib/invoices/receivables.invoiceRemaining
--                  = round2(max(0, total - round2(Σ invoice_payments.amount)))
--     age_days     lib/invoices/overdue.invoiceDaysOverdue
--                  = NULL unless (collectable AND due_date IS NOT NULL AND
--                    due_date < as-at); otherwise whole days (as-at - due_date).
--
--   PAYABLES (bill-due-date basis, migration 20261088)
--     gross        lib/suppliers/payments.billGross = round2(amount + vat_total)
--     settled      Σ LIVE allocations (supplier_payments.voided_at IS NULL)
--     outstanding  round2(max(0, gross - settled))   (voided payments settle 0)
--     due date     lib/commercial/overdue-payables.billDueDate
--                  = (bill_date ?? Europe/London calendar day of created_at)
--                    + effectiveTermsDays(supplier.payment_terms_days)
--                    where NULL / negative terms fall back to the DISCLOSED
--                    default of 30 days (DEFAULT_PAYMENT_TERMS_DAYS).
--     age_days     lib/schedule/window.daysBetween(dueDate, as-at)
--                  = whole days (as-at - dueDate); may be negative (not yet due)
--                    → bucket `current`; NULL only when the bill has no datable
--                    base at all.
--
--   buckets        lib/commercial/ageing.bucketForAgeDays — CLOSED ON THE RIGHT,
--                  `current` at age ≤ 0 or NULL:
--                    ≤0/NULL → current · 1..30 → d1_30 · 31..60 → d31_60 ·
--                    61..90 → d61_90 · 91+ → d91_plus.
--
-- The as-at day is an ARGUMENT (p_as_at), not now(), so the surface and the test
-- pin one instant exactly as the TS service injects `now`. It is the UTC
-- business day `invoiceBusinessToday` (now.toISOString().slice(0,10)), the same
-- day /cash and the invoice list evaluate against.
--
-- SECURITY
-- --------
-- Both functions are SECURITY DEFINER (they run as owner and BYPASS RLS), so
-- each FIRST authorises the caller with the canonical membership guard
-- (public.current_org_ids() + errcode 42501) — the next_invoice_number idiom the
-- systemic guard test (__tests__/integration/rls/secdef-org-rpc-guard.test.ts)
-- auto-passes.
--
-- PAYABLES ADMIN GATE. supplier_payments / supplier_payment_allocations / the
-- supplier-bill columns of finances are OWNER/ADMIN-ONLY at the RLS layer. A
-- SECURITY DEFINER body bypasses that RLS, so report_aged_payables ADDITIONALLY
-- requires public.is_org_admin(p_org_id): a non-admin member is refused with
-- 42501 and receives NO payables data — mirroring the TS service's
-- canReadPayables gate (server/services/aged-ledgers.ts), which still refuses to
-- even call this RPC for a non-admin role. The admin gate is enforced in BOTH
-- places on purpose (the TS gate drives the UX `creditorsVisible: false`; the
-- RPC gate is the real boundary for any direct caller).
--
-- Both carry an explicit `grant execute ... to authenticated` (guarded, not
-- revoked — real members must call report_aged_receivables, and the admin gate
-- inside report_aged_payables refuses non-admins). No new table is created, so
-- no Data-API table grant applies.
--
-- READ-ONLY + ADDITIVE. Neither function writes any row. This migration is
-- forward-only and creates only these two functions.

-- ─────────────────────────────────────────────────────────────────────────
-- report_aged_receivables(p_org_id, p_as_at)
--   One row per UNSETTLED, collectable sales invoice in p_org_id, with its
--   outstanding balance and age bucket pre-computed. Settled / non-collectable
--   invoices are excluded in SQL (they would be dropped by the TS netting
--   anyway). customer_id is resolved with the job fallback so a pre-backfill
--   invoice (null customer_id) is still attributed to the right account rather
--   than landing in "Unattributed".
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.report_aged_receivables(p_org_id uuid, p_as_at date)
returns table (
  invoice_id uuid,
  reference  text,
  status     text,
  due_date   date,
  party_id   uuid,       -- resolved customer id (invoice, else its job); null = unattributed
  party_name text,       -- customers.name of party_id (null → TS shows "Unnamed customer")
  remaining  numeric,    -- £, = invoiceRemaining
  age_days   integer,    -- = invoiceDaysOverdue (null unless overdue)
  bucket     text        -- = bucketForAgeDays(age_days)
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Canonical membership guard (current_org_ids + 42501).
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  return query
  with paid as (
    -- Per-invoice Σ payments, org-pinned. round(.,2): invoice_payments.amount is
    -- numeric(12,2), so this equals the TS round2-fold to the penny.
    select ip.invoice_id as inv_id,
           round(coalesce(sum(ip.amount), 0)::numeric, 2) as paid_sum
      from public.invoice_payments ip
     where ip.org_id = p_org_id
     group by ip.invoice_id
  ),
  base as (
    select i.id as inv_id,
           i.number as ref,
           i.status as status,
           i.due_date as due_date,
           coalesce(i.customer_id, j.customer_id) as party_id,
           c.name as party_name,
           -- invoiceRemaining: round2(max(0, total - round2(Σ payments))).
           round(greatest(0::numeric, i.total - coalesce(p.paid_sum, 0))::numeric, 2) as remaining,
           -- invoiceDaysOverdue: null unless overdue (collectable already; due
           -- date present; strictly before the as-at day).
           case
             when i.due_date is not null and i.due_date < p_as_at
               then (p_as_at - i.due_date)
             else null
           end as age_days
      from public.invoices i
      left join paid p on p.inv_id = i.id
      left join public.jobs j on j.id = i.job_id and j.org_id = i.org_id
      left join public.customers c
        on c.id = coalesce(i.customer_id, j.customer_id) and c.org_id = i.org_id
     where i.org_id = p_org_id
       -- isCollectableStatus (OVERDUE_COLLECTABLE_STATUSES). Mirrored here for
       -- the SQL pre-filter; the TS authority remains the source of truth and
       -- the integration test pins this set to it.
       and i.status in ('sent', 'awaiting_payment', 'partially_paid', 'overdue')
  )
  select b.inv_id,
         b.ref,
         b.status,
         b.due_date,
         b.party_id,
         b.party_name,
         b.remaining,
         b.age_days::integer,
         case
           when b.age_days is null then 'current'
           when b.age_days <= 0   then 'current'
           when b.age_days <= 30  then 'd1_30'
           when b.age_days <= 60  then 'd31_60'
           when b.age_days <= 90  then 'd61_90'
           else 'd91_plus'
         end as bucket
    from base b
   -- buildAgeingLedger drops non-positive amounts; exclude settled here so the
   -- whole settled tail never crosses the wire.
   where b.remaining > 0;
end;
$$;

grant execute on function public.report_aged_receivables(uuid, date) to authenticated;

comment on function public.report_aged_receivables(uuid, date) is
  'R7: aged receivables for p_org_id as at p_as_at — per unsettled collectable '
  'invoice, outstanding + age bucket pre-computed. Membership-guarded '
  '(current_org_ids + 42501). Mirrors lib/invoices receivables + overdue + '
  'lib/commercial/ageing; pinned by the aged-ledgers-rpc integration test.';

-- ─────────────────────────────────────────────────────────────────────────
-- report_aged_payables(p_org_id, p_as_at)
--   One row per UNSETTLED supplier bill (a finances row that names a supplier)
--   in p_org_id, aged from its DUE DATE (bill_date/created_at + terms). ADMIN
--   ONLY: the money-out ledger is owner/admin-gated at RLS, and SECURITY DEFINER
--   bypasses RLS, so the admin gate is enforced in the body.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.report_aged_payables(p_org_id uuid, p_as_at date)
returns table (
  bill_id     uuid,
  reference   text,
  party_id    uuid,       -- supplier id; null = unattributed
  party_name  text,       -- suppliers.name of party_id (null → TS shows "Unnamed supplier")
  outstanding numeric,    -- £, = billGross - Σ live allocations, floored at 0
  age_days    integer,    -- = daysBetween(dueDate, as-at); null only when undatable
  bucket      text,       -- = bucketForAgeDays(age_days)
  date_iso    date        -- the due date aged from (null when undatable)
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Canonical membership guard (current_org_ids + 42501) AND the payables ADMIN
  -- gate. A non-admin member is refused and receives NO payables data: an
  -- empty-without-error read would overstate payables by everything already
  -- paid (see server/services/aged-ledgers.ts). Referencing current_org_ids and
  -- raising 42501 keeps this on the systemic guard test's auto-pass lane.
  if auth.role() is distinct from 'service_role'
     and (p_org_id not in (select public.current_org_ids())
          or not public.is_org_admin(p_org_id)) then
    raise exception 'Forbidden: payables are admin-only for this org'
      using errcode = '42501';
  end if;

  return query
  with live_alloc as (
    -- Σ allocations from LIVE (non-voided) payments only — a voided payment
    -- settles nothing (liveAllocations + isLivePayment).
    select a.finance_id as fin_id,
           round(coalesce(sum(a.amount), 0)::numeric, 2) as settled
      from public.supplier_payment_allocations a
      join public.supplier_payments sp
        on sp.id = a.payment_id and sp.org_id = a.org_id
     where a.org_id = p_org_id
       and sp.voided_at is null
     group by a.finance_id
  ),
  base as (
    select f.id as bill_id,
           f.reference as ref,
           f.supplier_id as party_id,
           s.name as party_name,
           -- billGross - Σ live allocations, floored at 0 (per-bill cap).
           round(
             greatest(
               0::numeric,
               round((f.amount + f.vat_total)::numeric, 2) - coalesce(la.settled, 0)
             )::numeric,
             2
           ) as outstanding,
           -- billDueDate: (bill_date ?? Europe/London day of created_at) +
           -- effectiveTermsDays(terms). created_at is NOT NULL, so a datable
           -- base always exists in practice; the undatable branch is kept for
           -- fidelity with the pure function.
           case
             when f.bill_date is not null or f.created_at is not null then
               coalesce(
                 f.bill_date,
                 (f.created_at at time zone 'Europe/London')::date
               )
               + case
                   when s.payment_terms_days is null or s.payment_terms_days < 0 then 30
                   else trunc(s.payment_terms_days)::int
                 end
             else null
           end as due_date_calc,
           (f.bill_date is not null or f.created_at is not null) as datable
      from public.finances f
      left join live_alloc la on la.fin_id = f.id
      left join public.suppliers s on s.id = f.supplier_id and s.org_id = f.org_id
     where f.org_id = p_org_id
       -- Only bills attributable to a supplier can be aged against an account.
       and f.supplier_id is not null
  )
  select b.bill_id,
         b.ref,
         b.party_id,
         b.party_name,
         b.outstanding,
         case when b.datable then (p_as_at - b.due_date_calc)::integer else null end as age_days,
         case
           when not b.datable then 'current'
           when (p_as_at - b.due_date_calc) <= 0  then 'current'
           when (p_as_at - b.due_date_calc) <= 30 then 'd1_30'
           when (p_as_at - b.due_date_calc) <= 60 then 'd31_60'
           when (p_as_at - b.due_date_calc) <= 90 then 'd61_90'
           else 'd91_plus'
         end as bucket,
         case when b.datable then b.due_date_calc else null end as date_iso
    from base b
   where b.outstanding > 0;
end;
$$;

grant execute on function public.report_aged_payables(uuid, date) to authenticated;

comment on function public.report_aged_payables(uuid, date) is
  'R7: aged payables for p_org_id as at p_as_at — per unsettled supplier bill, '
  'outstanding + age bucket pre-computed, aged from the bill due date. '
  'ADMIN-ONLY (current_org_ids + is_org_admin, else 42501). Mirrors '
  'lib/suppliers/payments + lib/commercial/overdue-payables + ageing; pinned by '
  'the aged-ledgers-rpc integration test.';
