-- ═══════════════════════════════════════════════════════════════════════════
-- H2-CIS — STALE-VERIFICATION GATE (finance correctness + HMRC compliance)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT THIS CLOSES
-- ----------------------
-- The CIS module CONTRACT (lib/cis/verification.ts, server/services/cis.ts) says
-- the deduction engine "must refuse to compute a deduction when a verification is
-- stale" — a provider outage, or an expired verification, must BLOCK payment and
-- force re-verification, never silently deduct at a stale rate.
--
-- The posting path did not enforce it. Both `record_cis_supplier_payment` and the
-- authority trigger `tg_supplier_payment_allocation_cis` (20261051000000) only
-- checked that `cis_status` is an outcome and `deduction_rate` is non-null. They
-- never read `verification_expires_at`. So once an HMRC verification lapsed (valid
-- for the tax year of verification + the following two tax years) the OLD rate was
-- silently re-applied. If HMRC had by then moved the subcontractor to higher_30,
-- that is a real UNDER-deduction and a contractor liability — the exact failure
-- the freshness rule exists to prevent.
--
-- THE FIX (defense-in-depth, additive, reversible)
-- ------------------------------------------------
--   1. A pure, IMMUTABLE derivation of the HMRC expiry from the verification date,
--      mirroring lib/cis/verification.ts deriveVerificationExpiry EXACTLY, so the
--      DB can compute the effective expiry even for older rows that never had the
--      column populated (the app always populates it on write today, but the
--      backstop must not depend on that).
--   2. The authority TRIGGER — the true backstop, since it fires on EVERY
--      allocation insert including a direct/forged PostgREST or service_role write
--      — now refuses a CIS deduction whose payment date is AFTER the effective
--      expiry.
--   3. The RPC `record_cis_supplier_payment` refuses the same, once, up front,
--      with a per-payment message before any row is written.
--
-- BOUNDARY: a verification is valid THROUGH its expiry date INCLUSIVE. A payment
-- dated ON the expiry date still posts; only a payment STRICTLY AFTER it is
-- refused. This matches verificationFreshness()'s boundary in
-- lib/cis/verification.ts (remaining days < 0 ⇒ expired), where the same
-- daysBetween convention treats the expiry date itself as still current.
--
-- Remediation for the operator is the EXISTING flagForReverification workflow:
-- re-record the HMRC verification (fresh verified_at / expiry) and the payment
-- posts again.

-- ── 1. The HMRC expiry derivation, in SQL ──────────────────────────────────
-- HMRC: you need not re-verify a subcontractor included on a CIS return in the
-- current tax year or the previous two. A verification obtained in tax year Y is
-- therefore good THROUGH the end of tax year Y+2 — i.e. 5 April of calendar year
-- Y+3. The UK tax year runs 6 April → 5 April, so the tax-year start of a date is
-- its calendar year when the date is on/after 6 April, else the previous year.
--
--   verified 2026-07-01 → tax year 2026/27 → good through 2029-04-05
--   verified 2026-04-05 → tax year 2025/26 → good through 2028-04-05
--
-- IMMUTABLE and pure — the twin of lib/cis/verification.ts deriveVerificationExpiry.
create or replace function public.cis_derive_verification_expiry(p_verified date)
returns date
language sql
immutable
set search_path = public
as $$
  select case
    when p_verified is null then null
    else make_date(
      (case
         when extract(month from p_verified) > 4
           or (extract(month from p_verified) = 4 and extract(day from p_verified) >= 6)
         then extract(year from p_verified)::int
         else extract(year from p_verified)::int - 1
       end) + 3,
      4, 5)
  end
$$;

grant execute on function public.cis_derive_verification_expiry(date) to authenticated;


-- ── 2. The authority trigger — the backstop on EVERY allocation insert ──────
-- Recreated verbatim from 20261051000000 with two additions: the profile SELECT
-- now also reads verified_at / verification_expires_at, and a STALE-VERIFICATION
-- GATE sits immediately after the rate-authority check. Everything else is
-- unchanged. SECURITY DEFINER and the search_path pin are preserved.
create or replace function public.tg_supplier_payment_allocation_cis()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status      text;
  v_rate        numeric(5, 2);
  v_verified    date;
  v_expires     date;
  v_eff_expiry  date;
  v_paid        date;
  v_net         numeric(12, 2);
  v_gross       numeric(12, 2);
  v_materials   numeric(12, 2);
  v_citb        numeric(12, 2);
  v_treatment   text;
  v_rc_rate     numeric(5, 2);
  v_prior       numeric(12, 2);
  v_prior_basis numeric(12, 2);
  v_prior_ded   numeric(12, 2);
  v_prior_rows  int;
  v_mismatch    int;
  v_cum         numeric(12, 2);
  v_cum_basis   numeric(12, 2);
  v_cum_ded     numeric(12, 2);
  v_basis       numeric(12, 2);
  v_ded         numeric(12, 2);
  v_rc_vat      numeric(12, 2);
begin
  -- Legacy M2 allocation (no CIS figures at all) — out of scope, unchanged.
  if new.cis_deduction is null then
    return new;
  end if;

  -- ── RATE AUTHORITY ────────────────────────────────────────────────────────
  select c.cis_status, c.deduction_rate, c.verified_at, c.verification_expires_at
    into v_status, v_rate, v_verified, v_expires
    from public.cis_subcontractors c
   where c.org_id = new.org_id and c.supplier_id = new.supplier_id;

  if not found then
    raise exception
      'supplier % has no CIS subcontractor record — a CIS deduction cannot be posted against it',
      new.supplier_id using errcode = 'check_violation';
  end if;

  -- Pre-outcome statuses carry NO rate (M1's CHECK forces deduction_rate NULL).
  -- HMRC applies the higher rate only where it cannot identify the subcontractor;
  -- "we have not asked yet" is not that. Refusing is the conservative branch —
  -- see docs/cis-domain.md §7.
  if v_status not in ('gross', 'standard_20', 'higher_30', 'failed') or v_rate is null then
    raise exception
      'supplier % is not verified for CIS (status %) — verify with HMRC before deducting',
      new.supplier_id, v_status using errcode = 'check_violation';
  end if;

  -- ── STALE-VERIFICATION GATE ───────────────────────────────────────────────
  -- An HMRC verification is valid for the tax year it was obtained plus the two
  -- following tax years. Once it lapses there is NO authority to deduct at the old
  -- rate — the subcontractor must be re-verified, because HMRC may have moved them
  -- to the higher rate in the interim. Refuse rather than under-deduct.
  --
  -- The effective expiry prefers the stored column (an operator may set a shorter
  -- internal policy) and falls back to the HMRC-derived default, so rows written
  -- before the app populated the column are still covered. Boundary: valid THROUGH
  -- the expiry date; refused only when the payment date is STRICTLY after it.
  select p.paid_at into v_paid
    from public.supplier_payments p where p.id = new.payment_id;
  v_eff_expiry := coalesce(v_expires, public.cis_derive_verification_expiry(v_verified));
  if v_eff_expiry is not null and v_paid is not null and v_paid > v_eff_expiry then
    raise exception
      'CIS verification for supplier % expired on % — re-verify with HMRC before posting a deduction dated %',
      new.supplier_id, v_eff_expiry, v_paid using errcode = 'check_violation';
  end if;

  -- THE forgery gate. The client does not get to choose the rate.
  if new.cis_rate_applied is distinct from v_rate then
    raise exception
      'CIS rate of % percent does not match this subcontractor''s verified rate of % percent — the rate is derived from HMRC verification, not supplied',
      new.cis_rate_applied, v_rate using errcode = 'check_violation';
  end if;

  -- ── THE BILL, AS IT STANDS NOW ────────────────────────────────────────────
  select f.amount, round(f.amount + coalesce(f.vat_total, 0), 2)
    into v_net, v_gross
    from public.finances f where f.id = new.finance_id;
  if not found then
    raise exception 'bill % not found', new.finance_id using errcode = 'check_violation';
  end if;

  select coalesce(d.materials_amount, 0), coalesce(d.citb_levy_amount, 0),
         coalesce(d.vat_treatment, 'standard'), d.reverse_charge_vat_rate
    into v_materials, v_citb, v_treatment, v_rc_rate
    from public.cis_bill_details d
   where d.org_id = new.org_id and d.finance_id = new.finance_id;
  -- No details row = no materials claimed = the whole net value is labour. That
  -- is the CONSERVATIVE default: it deducts MORE, never less, so a forgotten
  -- materials figure cannot under-deduct and under-report to HMRC.
  if not found then
    v_materials := 0; v_citb := 0; v_treatment := 'standard'; v_rc_rate := null;
  end if;

  if v_gross <= 0 then
    raise exception 'bill % has no positive value to settle', new.finance_id
      using errcode = 'check_violation';
  end if;

  -- The client's copy of the bill must be the real bill.
  if new.cis_bill_net       is distinct from v_net
     or new.cis_bill_gross     is distinct from v_gross
     or new.cis_bill_materials is distinct from v_materials
     or new.cis_bill_citb      is distinct from v_citb
     or new.cis_vat_treatment  is distinct from v_treatment
  then
    raise exception
      'the submitted CIS basis does not match bill % (net %, gross %, materials %, CITB %, VAT %) — it is derived from the bill, not supplied',
      new.finance_id, v_net, v_gross, v_materials, v_citb, v_treatment
      using errcode = 'check_violation';
  end if;

  -- ── PRIORS — LIVE allocations against this bill, this one excluded ────────
  select coalesce(sum(a.amount), 0),
         coalesce(sum(a.cis_basis), 0),
         coalesce(sum(a.cis_deduction), 0),
         count(*) filter (where a.cis_deduction is not null),
         count(*) filter (
           where a.cis_deduction is not null
             and (a.cis_bill_net is distinct from v_net
                  or a.cis_bill_gross is distinct from v_gross
                  or a.cis_bill_materials is distinct from v_materials
                  or a.cis_bill_citb is distinct from v_citb)
         )
    into v_prior, v_prior_basis, v_prior_ded, v_prior_rows, v_mismatch
    from public.supplier_payment_allocations a
    join public.supplier_payments p on p.id = a.payment_id
   where a.finance_id = new.finance_id
     and a.id <> new.id
     and p.voided_at is null;

  -- The bill moved between two CIS payments. cis_bill_details is frozen once
  -- part-paid, but `finances.amount` itself belongs to the general cost ledger
  -- and this migration deliberately does not police writes to it. So detect the
  -- change and refuse, rather than quietly apportioning against a denominator
  -- that no longer matches what the earlier payment was calculated from.
  if v_mismatch > 0 then
    raise exception
      'bill % has changed since it was part-paid under CIS — void the earlier payment before posting another',
      new.finance_id using errcode = 'check_violation';
  end if;

  -- ── THE CUMULATIVE ARITHMETIC ─────────────────────────────────────────────
  v_cum := round(v_prior + new.amount, 2);
  if v_cum > v_gross then
    -- Unreachable in practice: M2's CAP 2 refuses this first (with a ±0.005
    -- tolerance). Clamped rather than raised so a half-penny float artefact
    -- cannot produce a ratio above 1 and an over-deduction.
    v_cum := v_gross;
  end if;

  v_cum_basis := round(greatest(v_net - v_citb - v_materials, 0) * v_cum / v_gross, 2);
  v_cum_ded   := round(v_cum_basis * v_rate / 100, 2);

  v_basis := greatest(v_cum_basis - v_prior_basis, 0);
  v_ded   := greatest(v_cum_ded   - v_prior_ded,   0);

  if new.cis_basis is distinct from v_basis or new.cis_deduction is distinct from v_ded then
    raise exception
      'CIS figures for bill % are wrong: basis % / deduction % submitted, % / % derived from the bill and the verified rate',
      new.finance_id, new.cis_basis, new.cis_deduction, v_basis, v_ded
      using errcode = 'check_violation';
  end if;

  -- ── REVERSE-CHARGE VAT ────────────────────────────────────────────────────
  -- The notional VAT the CUSTOMER must account for on this share. Apportioned on
  -- the NET value (not the basis) because the reverse charge applies to the whole
  -- supply INCLUDING materials, while the CIS basis excludes them — two different
  -- axes, deliberately not conflated. See docs/cis-domain.md §6.4.
  if v_treatment = 'reverse_charge' then
    v_rc_vat := round(round(v_net * v_cum / v_gross, 2) * coalesce(v_rc_rate, 0) / 100, 2)
              - round(round(v_net * v_prior / v_gross, 2) * coalesce(v_rc_rate, 0) / 100, 2);
    v_rc_vat := greatest(v_rc_vat, 0);
  else
    v_rc_vat := 0;
  end if;

  if new.cis_reverse_charge_vat is distinct from v_rc_vat then
    raise exception
      'reverse-charge VAT for bill % is wrong: % submitted, % derived',
      new.finance_id, new.cis_reverse_charge_vat, v_rc_vat
      using errcode = 'check_violation';
  end if;

  return new;
end $$;


-- ── 3. The RPC — the same refusal, once, up front, before any write ─────────
-- `record_cis_supplier_payment` already reads verified_at / verification_expires_at
-- into v_verified / v_expires (for the payment snapshot). It is recreated verbatim
-- from 20261051000000 with ONE addition: a stale-verification gate immediately
-- after the rate-authority checks, before pass 1 derives any figure. SECURITY
-- INVOKER, the search_path pin, the advisory-lock discipline and the signature
-- (including the p_expected_rate default) are all preserved.
create or replace function public.record_cis_supplier_payment(
  p_org_id        uuid,
  p_supplier_id   uuid,
  p_paid_at       date,
  p_method        text,
  p_reference     text,
  p_notes         text,
  p_allocations   jsonb,
  p_expected_rate numeric default null
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_payment_id uuid;
  v_status     text;
  v_rate       numeric(5, 2);
  v_legal_name text;
  v_utr        text;
  v_ref        text;
  v_verified   date;
  v_expires    date;
  v_eff_expiry date;

  v_fin        uuid[]    := '{}';
  v_amt        numeric[] := '{}';
  v_net        numeric[] := '{}';
  v_gross      numeric[] := '{}';
  v_mat        numeric[] := '{}';
  v_citb       numeric[] := '{}';
  v_treat      text[]    := '{}';
  v_basis      numeric[] := '{}';
  v_ded        numeric[] := '{}';
  v_rcvat      numeric[] := '{}';

  v_tot_amt    numeric(12, 2) := 0;
  v_tot_basis  numeric(12, 2) := 0;
  v_tot_ded    numeric(12, 2) := 0;
  v_tot_mat    numeric(12, 2) := 0;
  v_tot_citb   numeric(12, 2) := 0;
  v_tot_cisgr  numeric(12, 2) := 0;

  r            record;
  b_net        numeric(12, 2);
  b_gross      numeric(12, 2);
  b_mat        numeric(12, 2);
  b_citb       numeric(12, 2);
  b_treat      text;
  b_rcrate     numeric(5, 2);
  b_prior      numeric(12, 2);
  b_pbasis     numeric(12, 2);
  b_pded       numeric(12, 2);
  b_cum        numeric(12, 2);
  b_cumbasis   numeric(12, 2);
  b_cumded     numeric(12, 2);
  i            int;
begin
  if p_org_id is null or not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can record a supplier payment'
      using errcode = 'insufficient_privilege';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception
      'a CIS payment must settle at least one bill — there is no deduction basis without one'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── rate authority, read ONCE and used for every line ─────────────────────
  select c.cis_status, c.deduction_rate, c.legal_name, c.utr,
         c.verification_reference, c.verified_at, c.verification_expires_at
    into v_status, v_rate, v_legal_name, v_utr, v_ref, v_verified, v_expires
    from public.cis_subcontractors c
   where c.org_id = p_org_id and c.supplier_id = p_supplier_id;

  if not found then
    raise exception
      'supplier % is not set up as a CIS subcontractor — record this as an ordinary supplier payment instead',
      p_supplier_id using errcode = 'check_violation';
  end if;
  if v_status not in ('gross', 'standard_20', 'higher_30', 'failed') or v_rate is null then
    raise exception
      'supplier % is not verified for CIS (status %) — verify with HMRC before deducting',
      p_supplier_id, v_status using errcode = 'check_violation';
  end if;

  -- ── STALE-VERIFICATION GATE ───────────────────────────────────────────────
  -- Refuse a deduction against a lapsed HMRC verification: the old rate has no
  -- authority once the verification is out of date, and posting it silently would
  -- under-deduct if HMRC has since moved the subcontractor to the higher rate.
  -- Prefers the stored expiry, falls back to the HMRC-derived default. Valid
  -- THROUGH the expiry date; refused only when strictly after it. The remedy is
  -- the existing re-verification workflow.
  v_eff_expiry := coalesce(v_expires, public.cis_derive_verification_expiry(v_verified));
  if v_eff_expiry is not null and p_paid_at > v_eff_expiry then
    raise exception
      'CIS verification for supplier % expired on % — re-verify with HMRC before recording a payment dated %',
      p_supplier_id, v_eff_expiry, p_paid_at using errcode = 'check_violation';
  end if;

  if p_expected_rate is not null and round(p_expected_rate, 2) <> v_rate then
    raise exception
      'CIS rate of % percent does not match this subcontractor''s verified rate of % percent — refresh and check the verification before posting',
      p_expected_rate, v_rate using errcode = 'check_violation';
  end if;

  -- ── PASS 1 — derive every figure, locking the bills in a total order ──────
  for r in
    select (elem->>'finance_id')::uuid as finance_id,
           round((elem->>'amount')::numeric, 2) as amount
      from jsonb_array_elements(p_allocations) as elem
     order by 1
  loop
    if r.amount is null or r.amount <= 0 then
      raise exception 'every bill line needs an amount above zero'
        using errcode = 'invalid_parameter_value';
    end if;
    if r.finance_id = any (v_fin) then
      raise exception 'bill % appears twice on the same payment — combine it into one line',
        r.finance_id using errcode = 'invalid_parameter_value';
    end if;

    -- Serialise concurrent CIS postings against this bill (see the header).
    perform pg_advisory_xact_lock(
      hashtext('cis_bill_settlement'), hashtext(r.finance_id::text)
    );

    select f.amount, round(f.amount + coalesce(f.vat_total, 0), 2)
      into b_net, b_gross
      from public.finances f
     where f.id = r.finance_id and f.org_id = p_org_id and f.supplier_id = p_supplier_id;
    if not found then
      raise exception 'bill % is not an open bill for this supplier', r.finance_id
        using errcode = 'check_violation';
    end if;
    if b_gross <= 0 then
      raise exception 'bill % has no positive value to settle', r.finance_id
        using errcode = 'check_violation';
    end if;

    select coalesce(d.materials_amount, 0), coalesce(d.citb_levy_amount, 0),
           coalesce(d.vat_treatment, 'standard'), d.reverse_charge_vat_rate
      into b_mat, b_citb, b_treat, b_rcrate
      from public.cis_bill_details d
     where d.org_id = p_org_id and d.finance_id = r.finance_id;
    if not found then
      b_mat := 0; b_citb := 0; b_treat := 'standard'; b_rcrate := null;
    end if;

    select coalesce(sum(a.amount), 0), coalesce(sum(a.cis_basis), 0),
           coalesce(sum(a.cis_deduction), 0)
      into b_prior, b_pbasis, b_pded
      from public.supplier_payment_allocations a
      join public.supplier_payments p on p.id = a.payment_id
     where a.finance_id = r.finance_id and p.voided_at is null;

    b_cum := least(round(b_prior + r.amount, 2), b_gross);
    b_cumbasis := round(greatest(b_net - b_citb - b_mat, 0) * b_cum / b_gross, 2);
    b_cumded   := round(b_cumbasis * v_rate / 100, 2);

    v_fin   := v_fin   || r.finance_id;
    v_amt   := v_amt   || r.amount;
    v_net   := v_net   || b_net;
    v_gross := v_gross || b_gross;
    v_mat   := v_mat   || b_mat;
    v_citb  := v_citb  || b_citb;
    v_treat := v_treat || b_treat;
    v_basis := v_basis || greatest(b_cumbasis - b_pbasis, 0);
    v_ded   := v_ded   || greatest(b_cumded - b_pded, 0);
    v_rcvat := v_rcvat || (
      case when b_treat = 'reverse_charge' then greatest(
        round(round(b_net * b_cum / b_gross, 2) * coalesce(b_rcrate, 0) / 100, 2)
        - round(round(b_net * b_prior / b_gross, 2) * coalesce(b_rcrate, 0) / 100, 2), 0)
      else 0 end
    );

    v_tot_amt   := round(v_tot_amt + r.amount, 2);
    v_tot_basis := round(v_tot_basis + greatest(b_cumbasis - b_pbasis, 0), 2);
    v_tot_ded   := round(v_tot_ded + greatest(b_cumded - b_pded, 0), 2);
    -- The materials and levy ATTRIBUTABLE TO THIS PAYMENT'S SHARE, so the
    -- snapshot's own figures reconcile: gross_payment − materials − levy = basis.
    v_tot_mat   := round(v_tot_mat  + round(b_mat  * b_cum / b_gross, 2)
                                    - round(b_mat  * b_prior / b_gross, 2), 2);
    v_tot_citb  := round(v_tot_citb + round(b_citb * b_cum / b_gross, 2)
                                    - round(b_citb * b_prior / b_gross, 2), 2);
    v_tot_cisgr := round(v_tot_cisgr + round((b_net - b_citb) * b_cum / b_gross, 2)
                                     - round((b_net - b_citb) * b_prior / b_gross, 2), 2);
  end loop;

  -- ── PASS 2 — write, atomically ────────────────────────────────────────────
  insert into public.supplier_payments (
    org_id, supplier_id, paid_at, method, reference,
    gross_amount, cis_withheld, net_paid, notes, created_by
  ) values (
    p_org_id, p_supplier_id, p_paid_at,
    coalesce(p_method, 'bank_transfer'), p_reference,
    v_tot_amt, v_tot_ded, round(v_tot_amt - v_tot_ded, 2),
    p_notes, auth.uid()
  )
  returning id into v_payment_id;

  for i in 1 .. array_length(v_fin, 1) loop
    insert into public.supplier_payment_allocations (
      org_id, payment_id, supplier_id, finance_id, amount, created_by,
      cis_rate_applied, cis_bill_net, cis_bill_gross, cis_bill_materials,
      cis_bill_citb, cis_basis, cis_deduction, cis_vat_treatment,
      cis_reverse_charge_vat
    ) values (
      p_org_id, v_payment_id, p_supplier_id, v_fin[i], v_amt[i], auth.uid(),
      v_rate, v_net[i], v_gross[i], v_mat[i],
      v_citb[i], v_basis[i], v_ded[i], v_treat[i],
      v_rcvat[i]
    );
  end loop;

  insert into public.cis_payment_snapshots (
    org_id, payment_id, supplier_id,
    cis_status, deduction_rate, verification_reference, verified_at,
    verification_expires_at, legal_name, utr_masked,
    cis_gross_payment, materials_total, citb_total, cis_basis, cis_deduction,
    tax_month_start, tax_month_end
  ) values (
    p_org_id, v_payment_id, p_supplier_id,
    v_status, v_rate, v_ref, v_verified,
    v_expires, v_legal_name,
    -- Masked here, in SQL, so the raw UTR never leaves the admin-only table even
    -- in transit. Mirrors lib/cis/verification.ts maskUtr.
    case when v_utr is null then null
         else repeat('•', greatest(length(v_utr) - 4, 0)) || right(v_utr, 4) end,
    v_tot_cisgr, v_tot_mat, v_tot_citb, v_tot_basis, v_tot_ded,
    public.cis_tax_month_start(p_paid_at), public.cis_tax_month_end(p_paid_at)
  );

  return v_payment_id;
end $$;
