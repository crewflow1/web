-- H2-CIS M3 — the deterministic CIS deduction engine + domestic reverse-charge VAT.
--
-- Every tax rule encoded below is traced to HMRC guidance in docs/cis-domain.md,
-- with the source URL and the date it was retrieved (27 July 2026). Nothing here
-- invents tax semantics. Where HMRC is ambiguous the doc names the ambiguity and
-- this migration takes the conservative branch — usually "refuse", never "guess".
--
-- ── WHAT M2 DELIBERATELY DID NOT DO, AND THIS DOES ──────────────────────────
-- 20261047000000 stores the amount the operator *said* they withheld and, in its
-- own words, "does not compute it" — because deducting from materials would
-- produce a WRONG return. This migration supplies the missing half: the basis,
-- the rate authority, and an immutable snapshot of both.
--
--   deduction basis = bill NET − CITB levy − qualifying materials
--   CIS deduction   = basis × rate
--
-- `bill total × rate` is WRONG and appears nowhere. CIS340 §3.12 requires the
-- gross to exclude VAT charged by a VAT-registered subcontractor, and to be
-- reduced by the actual amounts the subcontractor paid for materials, consumable
-- stores, fuel (except for travelling), plant hire and manufacture/prefabrication.
-- CISR15110 additionally removes the CITB levy from the *gross amount of payment*
-- itself (its worked example: £1,000 contract, £7 levy ⇒ £993 reported gross),
-- which is why the levy is a separate column and is subtracted BEFORE materials.
--
-- ── RATE AUTHORITY: SERVER-DERIVED, NEVER CLIENT-TRUSTED ────────────────────
-- A client that posts `cis_rate = 17` (or 20, or 99) must be REFUSED, not obeyed.
-- The rate that governs a payment comes from the subcontractor's M1 verification
-- state and from nowhere else. That is enforced HERE, in a SECURITY DEFINER
-- trigger, not only in the RPC — so a direct PostgREST write, a service_role
-- script and a future background job are all bound identically. M1 established
-- the pattern (a forged rate is an ERROR, never a silent correction); this is the
-- same rule one level down, applied to a payment instead of a profile.
--
-- Pre-outcome statuses (`unverified`, `verification_required`) have NO rate and
-- are therefore refused outright rather than defaulted to 20% or 30%. Guessing
-- either way is a filed return that is wrong; refusing is a conversation.
--
-- ── IMMUTABILITY: WHY A SNAPSHOT AND NOT A JOIN ─────────────────────────────
-- A payment & deduction statement (CIS340 §3.15) must still reproduce the same
-- figures years later. If the deduction were re-derived by joining to the CURRENT
-- profile and the CURRENT bill, then re-verifying a subcontractor 20%→30%, fixing
-- a typo'd UTR, or editing a bill's materials figure would silently rewrite tax
-- history that has already been reported to HMRC and handed to the subcontractor.
--
-- So posting FREEZES the arithmetic and the evidence for it. Reused from M2
-- rather than reinvented: allocations are already immutable outright
-- (tg_supplier_payment_allocations_frozen raises on ANY update), so the snapshot
-- columns added to that table below inherit write-once for free. The
-- payment-level verification snapshot gets the same treatment explicitly.
--
-- ── REVERSE CHARGE IS A TREATMENT, NOT `vat = 0` ────────────────────────────
-- Under the domestic reverse charge the subcontractor charges no VAT, so
-- `finances.vat_rate` is 0 and the gross payable really is the net. But HMRC
-- still requires the invoice to state the statutory legend AND either the VAT
-- amount the customer must account for or the rate it is calculated at. So "0"
-- is only half the fact: the rate and the notional VAT are real, required,
-- printable figures and are stored as such.
--
-- CRITICALLY, THIS FORKS NOTHING. `finances` is not touched — no new column, no
-- changed generated expression, no trigger. `computeVatQuarter` still sums
-- `finances.vat_total` and therefore returns BYTE-IDENTICAL output for every
-- existing row. A reverse-charge bill contributes 0 input VAT, which is also the
-- correct net effect: the customer raises output tax and recovers the same amount
-- as input tax, so the liability moves by nothing.
--
-- Two axes that must never be conflated, and are not:
--   * VAT treatment applies to the WHOLE invoice including materials (HMRC:
--     goods supplied with construction services are a single supply).
--   * The CIS basis still EXCLUDES materials.
--
-- ── THE M2 INVARIANT, RE-PROVED ─────────────────────────────────────────────
-- CIS withholding must NOT reduce commercial cost. Nothing in this migration
-- inserts, updates or deletes a `finances` row — no trigger, no RPC, no generated
-- column, no view. `cis_bill_details` is a SEPARATE 1:1 extension table (the same
-- shape M1 used for `suppliers`) precisely so that adding a labour/materials
-- split cannot move `finances.amount`, which is what
-- `lib/profitability/compute.ts` sums. Job cost and margin are arithmetically
-- untouchable from here. Proven in __tests__/integration/rls/cis-deduction.test.ts.
--
-- Additive, idempotent and reversible. To roll back:
--   drop function if exists public.record_cis_supplier_payment(uuid,uuid,date,text,text,text,jsonb,numeric);
--   drop table if exists public.cis_payment_snapshots;
--   drop table if exists public.cis_bill_details;
--   alter table public.supplier_payment_allocations
--     drop column if exists cis_rate_applied, drop column if exists cis_bill_net,
--     drop column if exists cis_bill_gross, drop column if exists cis_bill_materials,
--     drop column if exists cis_bill_citb, drop column if exists cis_basis,
--     drop column if exists cis_deduction, drop column if exists cis_vat_treatment,
--     drop column if exists cis_reverse_charge_vat;
--   drop function if exists public.tg_supplier_payment_allocation_cis();
--   drop function if exists public.tg_cis_bill_details_guard();
--   drop function if exists public.tg_cis_bill_details_no_delete();
--   drop function if exists public.tg_cis_payment_snapshots_frozen();
--   drop function if exists public.tg_cis_payment_snapshots_no_delete();
--   drop function if exists public.tg_cis_payment_snapshot_totals();
--   drop function if exists public.cis_tax_month_start(date);
--   drop function if exists public.cis_tax_month_end(date);


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. CIS TAX MONTHS — centralised ONCE, because M4 is built on them
-- ═══════════════════════════════════════════════════════════════════════════
-- CIS340 §§3.15 and 4.2: "A tax month runs from the sixth of one month to the
-- fifth of the next month". These are NOT calendar months and getting it wrong
-- files a payment in the wrong return. A payment on 3 June belongs to the
-- 6 May – 5 June month; one on 7 June belongs to 6 June – 5 July.
--
-- IMMUTABLE and pure so they can be indexed and used in generated expressions
-- later. `date` has no timezone, so there is no BST/GMT boundary to get wrong
-- here — the app-side twin in lib/cis/tax-month.ts works in UTC for the same
-- reason.
create or replace function public.cis_tax_month_start(d date)
returns date language sql immutable strict parallel safe as $$
  select case
    when extract(day from d) >= 6
      then (date_trunc('month', d)::date + 5)
    else (date_trunc('month', d)::date - interval '1 month')::date + 5
  end
$$;

create or replace function public.cis_tax_month_end(d date)
returns date language sql immutable strict parallel safe as $$
  select (public.cis_tax_month_start(d) + interval '1 month')::date - 1
$$;

comment on function public.cis_tax_month_start(date) is
  'Start of the HMRC CIS tax month containing `d` (CIS340 3.15/4.2: the 6th of '
  'one month to the 5th of the next). NOT a calendar month.';
comment on function public.cis_tax_month_end(date) is
  'End (the 5th) of the HMRC CIS tax month containing `d`.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. cis_bill_details — the DEDUCTION BASIS, as a 1:1 extension on the bill
-- ═══════════════════════════════════════════════════════════════════════════
-- A supplier bill IS a `public.finances` row (20261009000000) and stays one.
-- This table adds only what CIS and the reverse charge need, in a SEPARATE table
-- for two reasons that both matter:
--
--   1. COST SAFETY. `finances.amount` is THE cost figure; profitability sums it
--      directly. A new column on `finances` is a new way for a tax feature to
--      move a margin. A side table cannot.
--   2. VAT SAFETY. `finances.vat_total` is a STORED GENERATED column read by
--      `computeVatQuarter`. Touching `finances` at all risks changing existing
--      VAT reports. Not touching it makes "unchanged" a structural fact rather
--      than a claim.
--
-- Same shape as CIS M1's extension of `suppliers`: composite-key 1:1, admin-only.
create table if not exists public.cis_bill_details (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  finance_id  uuid not null,
  -- Carried as the JOIN COLUMN that makes the org+supplier binding declarative
  -- (identical reasoning to supplier_payment_allocations.supplier_id). Because
  -- `finances.supplier_id` is nullable and this one is NOT NULL, a MATCH SIMPLE
  -- composite FK can never match a finances row with no supplier — a plain cost
  -- with no payee structurally cannot carry a CIS basis.
  supplier_id uuid not null,

  -- ── the deduction basis (docs/cis-domain.md §2) ───────────────────────────
  -- ONE figure covering everything CIS340 3.12 removes: materials the
  -- subcontractor paid for directly, consumable stores, fuel (EXCEPT fuel for
  -- travelling), plant hire, and the cost of manufacture or prefabrication.
  -- Not auto-derived from anything — HMRC requires the ACTUAL amounts the
  -- subcontractor paid, which only the contractor holding the invoice knows.
  materials_amount numeric(12, 2) not null default 0 check (materials_amount >= 0),

  -- CISR15110. The levy reduces the GROSS AMOUNT OF PAYMENT itself, so it is
  -- subtracted BEFORE materials rather than being lumped in with them. Kept
  -- separate because M4's monthly return reports the reduced gross, and merging
  -- the two would make that figure unrecoverable.
  citb_levy_amount numeric(12, 2) not null default 0 check (citb_levy_amount >= 0),

  -- ── VAT treatment (docs/cis-domain.md §6) ─────────────────────────────────
  -- NOT inferred. HMRC's end-user and intermediary-supplier exclusions turn on a
  -- WRITTEN NOTIFICATION this system does not hold, so the treatment is always an
  -- explicit human choice and defaults to normal VAT.
  vat_treatment text not null default 'standard'
                check (vat_treatment in ('standard', 'reverse_charge')),

  -- The rate the CUSTOMER must account for under the reverse charge. This is the
  -- whole reason reverse charge is not modelled as `vat = 0`: HMRC requires the
  -- invoice to show the VAT due under the reverse charge, or failing that the
  -- RATE. Constrained to the same domain as `finances.vat_rate` so the two can
  -- never disagree about what a legal UK VAT rate is.
  reverse_charge_vat_rate numeric(5, 2) check (
                            reverse_charge_vat_rate is null
                            or reverse_charge_vat_rate in (0, 5, 20)
                          ),

  notes      text check (notes is null or length(notes) <= 2000),
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (org_id, finance_id),

  constraint cis_bill_details_bill_fk
    foreign key (finance_id, org_id, supplier_id)
    references public.finances (id, org_id, supplier_id) on delete cascade,

  -- A treatment that names no rate is not a treatment. Written with
  -- `is not distinct from`/`is not null` inside a CASE so it can never evaluate
  -- to NULL and be silently "satisfied" — the exact trap M2 documents on
  -- supplier_payments_void_evidenced and M1 on the rate/status CHECK.
  constraint cis_bill_details_rc_rate_present check (
    case vat_treatment
      when 'reverse_charge' then reverse_charge_vat_rate is not null
      else reverse_charge_vat_rate is null
    end
  )
);

comment on table public.cis_bill_details is
  'H2-CIS M3 — the CIS deduction basis and VAT treatment for one supplier bill '
  '(a public.finances row). Deliberately a SIDE TABLE: finances.amount is the '
  'cost figure and finances.vat_total feeds computeVatQuarter, and neither may '
  'move because a tax feature was added. Frozen once the bill has been part-paid '
  'by a CIS payment. Admin-only RLS.';
comment on column public.cis_bill_details.materials_amount is
  'Actual amounts the SUBCONTRACTOR paid for materials, consumable stores, fuel '
  '(except for travelling), plant hire and manufacture/prefabrication — CIS340 '
  '3.12. Excluded from the deduction basis. Materials supplied by the CONTRACTOR '
  'are not a subcontractor cost and do not belong here.';
comment on column public.cis_bill_details.citb_levy_amount is
  'CITB levy recouped from the subcontractor. Per CISR15110 it reduces the GROSS '
  'AMOUNT OF PAYMENT reported on the monthly return, so it is subtracted before '
  'materials — not lumped in with them.';
comment on column public.cis_bill_details.vat_treatment is
  'standard | reverse_charge. Never inferred: the end-user / intermediary-supplier '
  'exclusions turn on a written notification this system does not hold.';
comment on column public.cis_bill_details.reverse_charge_vat_rate is
  'The VAT rate the CUSTOMER must account for under the domestic reverse charge. '
  'Stored because HMRC requires the invoice to state the VAT due, or the rate — '
  'which is why reverse charge is a TREATMENT and not simply vat_rate = 0.';

create index if not exists cis_bill_details_org_supplier_idx
  on public.cis_bill_details (org_id, supplier_id);
create index if not exists cis_bill_details_reverse_charge_idx
  on public.cis_bill_details (org_id) where vat_treatment = 'reverse_charge';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE PER-ALLOCATION SNAPSHOT — added to supplier_payment_allocations
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY ON THE ALLOCATION AND NOT THE PAYMENT. One payment may settle several
-- bills, and each bill has its own labour/materials split and its own VAT
-- treatment. A payment-level basis would have to average them, which is how you
-- deduct 20% from a merchant's materials. The allocation — one payment against
-- one bill — is the only granularity at which the arithmetic is actually defined.
--
-- WHY THESE COLUMNS ARE IMMUTABLE FOR FREE. `tg_supplier_payment_allocations_frozen`
-- (M2) raises on ANY update to this table, for every role including service_role.
-- New columns therefore inherit write-once with no new code — which is the whole
-- point of extending M2's ledger instead of building a parallel one.
alter table public.supplier_payment_allocations
  -- The rate that was ACTUALLY applied, in percent. Not a copy of the profile's
  -- current rate — the profile's rate on the day this was posted, validated
  -- against it at insert and then frozen. Re-verifying the subcontractor later
  -- cannot reach back and change it.
  add column if not exists cis_rate_applied   numeric(5, 2),
  -- The bill as it stood at posting. Kept so the figure can be re-derived and
  -- explained years later without joining to a `finances` row that may since have
  -- been edited, and so a mid-payment change to the bill is DETECTABLE.
  add column if not exists cis_bill_net       numeric(12, 2),
  add column if not exists cis_bill_gross     numeric(12, 2),
  add column if not exists cis_bill_materials numeric(12, 2),
  add column if not exists cis_bill_citb      numeric(12, 2),
  -- This allocation's INCREMENTAL share of the labour basis and of the deduction
  -- (see the cumulative method in tg_supplier_payment_allocation_cis). Σ over a
  -- bill's live allocations is exactly the whole-bill figure, to the penny.
  add column if not exists cis_basis          numeric(12, 2),
  add column if not exists cis_deduction      numeric(12, 2),
  -- The VAT treatment in force at posting, and — under the reverse charge — the
  -- notional VAT attributable to this share, which the CUSTOMER accounts for.
  add column if not exists cis_vat_treatment  text,
  add column if not exists cis_reverse_charge_vat numeric(12, 2);

do $$ begin
  -- ALL-OR-NOTHING. A row is either a legacy M2 allocation (every CIS column
  -- NULL) or an M3-posted one (every CIS column present). A half-populated row
  -- would be a deduction nobody can explain, which is the exact failure this
  -- milestone exists to prevent.
  if not exists (
    select 1 from pg_constraint where conname = 'supplier_payment_allocations_cis_complete'
  ) then
    alter table public.supplier_payment_allocations
      add constraint supplier_payment_allocations_cis_complete check (
        (cis_deduction is null
         and cis_rate_applied is null and cis_bill_net is null
         and cis_bill_gross is null and cis_bill_materials is null
         and cis_bill_citb is null and cis_basis is null
         and cis_vat_treatment is null and cis_reverse_charge_vat is null)
        or
        (cis_deduction is not null
         and cis_rate_applied is not null and cis_bill_net is not null
         and cis_bill_gross is not null and cis_bill_materials is not null
         and cis_bill_citb is not null and cis_basis is not null
         and cis_vat_treatment is not null and cis_reverse_charge_vat is not null)
      );
  end if;

  -- Arithmetic sanity that holds for every role and needs no lookup. A deduction
  -- can be zero (gross status) but never negative, and never exceeds its basis.
  if not exists (
    select 1 from pg_constraint where conname = 'supplier_payment_allocations_cis_sane'
  ) then
    alter table public.supplier_payment_allocations
      add constraint supplier_payment_allocations_cis_sane check (
        cis_deduction is null
        or (
          cis_rate_applied >= 0 and cis_rate_applied <= 100
          and cis_bill_net >= 0 and cis_bill_gross >= 0
          and cis_bill_materials >= 0 and cis_bill_citb >= 0
          and cis_basis >= 0 and cis_deduction >= 0
          and cis_reverse_charge_vat >= 0
          and cis_deduction <= cis_basis
          -- The basis is derived from NET figures. VAT is never in it
          -- (CIS340 3.12) — this makes that structural rather than a comment.
          and cis_basis <= cis_bill_net
          and cis_bill_materials + cis_bill_citb <= cis_bill_net
          and cis_vat_treatment in ('standard', 'reverse_charge')
          and (cis_vat_treatment = 'reverse_charge' or cis_reverse_charge_vat = 0)
        )
      );
  end if;
end $$;

comment on column public.supplier_payment_allocations.cis_rate_applied is
  'The deduction rate ACTUALLY applied, in percent, validated against the M1 '
  'verification state at insert and frozen thereafter. A client-supplied rate '
  'that disagrees is REFUSED, never silently corrected.';
comment on column public.supplier_payment_allocations.cis_basis is
  'This allocation''s incremental share of the labour basis (bill NET − CITB levy '
  '− qualifying materials). Σ over a bill''s live allocations equals the '
  'whole-bill basis to the penny — see the cumulative method in '
  'tg_supplier_payment_allocation_cis.';
comment on column public.supplier_payment_allocations.cis_deduction is
  'CIS withheld on this allocation. NULL means a legacy M2 allocation posted '
  'before the deduction engine existed, not a zero deduction.';

create index if not exists supplier_payment_allocations_cis_idx
  on public.supplier_payment_allocations (org_id, finance_id)
  where cis_deduction is not null;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. cis_payment_snapshots — WHY that rate, frozen at posting
-- ═══════════════════════════════════════════════════════════════════════════
-- The per-allocation columns record WHAT was deducted. This records WHY, so a
-- payment & deduction statement (CIS340 3.15) reproduces years later even after
-- the subcontractor is re-verified, their UTR corrected or their supplier record
-- renamed. Every field is a COPY taken at posting, never a live join.
create table if not exists public.cis_payment_snapshots (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  payment_id  uuid not null,
  supplier_id uuid not null,

  -- ── the verification state that justified the rate ────────────────────────
  cis_status             text not null check (
                           cis_status in ('gross', 'standard_20', 'higher_30', 'failed')
                         ),
  deduction_rate         numeric(5, 2) not null check (deduction_rate >= 0 and deduction_rate <= 100),
  verification_reference text,
  verified_at            date,
  verification_expires_at date,
  legal_name             text not null,
  -- MASKED, never raw. The UTR is the single most sensitive field in the CIS
  -- domain (M1 gives it admin-only RLS and a maskUtr helper). A statement needs
  -- to prove WHICH UTR was used, not to republish it, so only the mask is copied
  -- — a second unmasked home for it would be a new place to leak from.
  utr_masked             text,

  -- ── the frozen arithmetic, summed across this payment's allocations ───────
  -- 'Gross amount of payment' in HMRC's sense: NET of VAT and NET of the CITB
  -- levy (CISR15110). This is the figure M4 reports, and it is deliberately NOT
  -- supplier_payments.gross_amount, which is VAT-inclusive cash.
  cis_gross_payment numeric(12, 2) not null check (cis_gross_payment >= 0),
  materials_total   numeric(12, 2) not null check (materials_total >= 0),
  citb_total        numeric(12, 2) not null check (citb_total >= 0),
  cis_basis         numeric(12, 2) not null check (cis_basis >= 0),
  cis_deduction     numeric(12, 2) not null check (cis_deduction >= 0),

  -- ── the CIS tax month this payment falls in (see §1) ──────────────────────
  -- Stored rather than computed on read so a return that has been FILED cannot
  -- be re-bucketed by a later change to the helper.
  tax_month_start date not null,
  tax_month_end   date not null,

  created_at timestamptz not null default now(),

  primary key (org_id, payment_id),

  constraint cis_payment_snapshots_payment_fk
    foreign key (payment_id, org_id, supplier_id)
    references public.supplier_payments (id, org_id, supplier_id) on delete cascade,

  constraint cis_payment_snapshots_deduction_within_basis
    check (cis_deduction <= cis_basis),
  constraint cis_payment_snapshots_basis_within_gross
    check (cis_basis <= cis_gross_payment),
  constraint cis_payment_snapshots_tax_month
    check (tax_month_end > tax_month_start)
);

comment on table public.cis_payment_snapshots is
  'H2-CIS M3 — the immutable tax facts of one CIS payment: the verification state '
  'that justified the rate, the frozen basis and deduction, and the CIS tax month. '
  'Copies, never live joins: re-verifying a subcontractor, correcting a UTR or '
  'editing a bill must not rewrite a payment already reported to HMRC. Frozen '
  'outright — no UPDATE, no targeted DELETE. Admin-only RLS.';
comment on column public.cis_payment_snapshots.cis_gross_payment is
  'HMRC''s "gross amount of payment": NET of VAT (CIS340 3.12) and NET of the CITB '
  'levy (CISR15110). NOT supplier_payments.gross_amount, which is VAT-inclusive cash.';
comment on column public.cis_payment_snapshots.utr_masked is
  'Masked UTR only. Proves which UTR was used without creating a second '
  'unmasked home for the most sensitive field in the domain.';

create index if not exists cis_payment_snapshots_tax_month_idx
  on public.cis_payment_snapshots (org_id, tax_month_end, supplier_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. cis_bill_details GUARD — validate against the bill, freeze once paid
-- ═══════════════════════════════════════════════════════════════════════════
-- Three jobs, all of which a CHECK cannot do because they need another table:
--
--   1. BASIS SANITY. materials + CITB levy can never exceed the bill's NET value.
--      HMRC describes no negative basis and this system will not invent one.
--   2. REVERSE-CHARGE COHERENCE. Under the reverse charge the subcontractor
--      charges no VAT, so `finances.vat_rate` MUST be 0. A bill marked
--      reverse-charge while still charging 20% is an invoice that cannot legally
--      exist, and would double-count VAT the moment the customer also accounted
--      for it.
--   3. FREEZE ONCE PART-PAID. This is not cosmetic. The partial-payment maths
--      apportions the basis by `cumulative allocated / bill gross`; changing the
--      materials figure halfway through would make the second payment's share
--      inconsistent with the first, and the total would no longer be the
--      whole-bill deduction. Correct a mis-keyed split by voiding the payment.
--
-- SECURITY DEFINER: the guard must give the same answer on every write path,
-- including service_role and a caller who cannot see the allocations.
create or replace function public.tg_cis_bill_details_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_net      numeric(12, 2);
  v_vat_rate numeric(5, 2);
  v_paid     boolean;
begin
  select amount, vat_rate into v_net, v_vat_rate
    from public.finances where id = new.finance_id;
  if not found then
    raise exception 'bill % not found', new.finance_id using errcode = 'check_violation';
  end if;

  if round(new.materials_amount + new.citb_levy_amount, 2) > coalesce(v_net, 0) then
    raise exception
      'materials (%) plus CITB levy (%) exceed the bill''s net value (%) — the CIS basis cannot be negative',
      new.materials_amount, new.citb_levy_amount, v_net
      using errcode = 'check_violation';
  end if;

  -- NOTE ON `%` IN raise: plpgsql reads `%` as a placeholder, so a literal
  -- percent sign has to be `%%`. Every message below spells the unit out in
  -- words instead — an error a support engineer misreads is worse than a plain one.
  if new.vat_treatment = 'reverse_charge' and coalesce(v_vat_rate, 0) <> 0 then
    raise exception
      'bill % charges VAT at a rate of % percent — under the domestic reverse charge the supplier charges no VAT, so set the bill''s VAT rate to 0 and record the reverse-charge rate here',
      new.finance_id, v_vat_rate
      using errcode = 'check_violation';
  end if;

  -- Frozen once a CIS payment has been posted against the bill. Voided payments
  -- do not count — voiding is precisely how you release a bill to be corrected.
  select exists (
    select 1
      from public.supplier_payment_allocations a
      join public.supplier_payments p on p.id = a.payment_id
     where a.finance_id = new.finance_id
       and a.cis_deduction is not null
       and p.voided_at is null
  ) into v_paid;

  if tg_op = 'UPDATE' and v_paid and (
       new.materials_amount        is distinct from old.materials_amount
    or new.citb_levy_amount        is distinct from old.citb_levy_amount
    or new.vat_treatment           is distinct from old.vat_treatment
    or new.reverse_charge_vat_rate is distinct from old.reverse_charge_vat_rate
  ) then
    raise exception
      'bill % has already been part-paid under CIS — its labour/materials split and VAT treatment are frozen. Void the payment to change them',
      new.finance_id using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;

drop trigger if exists cis_bill_details_guard on public.cis_bill_details;
create trigger cis_bill_details_guard
  before insert or update on public.cis_bill_details
  for each row execute function public.tg_cis_bill_details_guard();

-- Deleting the basis of a bill that has been paid under CIS would orphan the
-- explanation of a filed deduction. Same org-absence test as M2's delete guards:
-- during a cascade the parent is already invisible, so teardown still works.
create or replace function public.tg_cis_bill_details_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id)
     and exists (
       select 1
         from public.supplier_payment_allocations a
         join public.supplier_payments p on p.id = a.payment_id
        where a.finance_id = old.finance_id
          and a.cis_deduction is not null
          and p.voided_at is null
     )
  then
    raise exception
      'bill % has been part-paid under CIS — its CIS details cannot be deleted. Void the payment first',
      old.finance_id using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists cis_bill_details_no_delete on public.cis_bill_details;
create trigger cis_bill_details_no_delete
  before delete on public.cis_bill_details
  for each row execute function public.tg_cis_bill_details_no_delete();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. THE DEDUCTION ENGINE — rate authority + the cumulative partial-payment maths
-- ═══════════════════════════════════════════════════════════════════════════
-- This is the load-bearing trigger of the milestone. It runs on every INSERT of
-- an allocation carrying CIS figures and INDEPENDENTLY RECOMPUTES all of them
-- from the subcontractor's verification state and the bill, refusing anything
-- that does not match. Following M2's stated philosophy, it VALIDATES rather than
-- overwrites: a caller who sends a forged rate or a forged basis gets an ERROR,
-- not a silent correction to a number they did not ask for.
--
-- ── TRIGGER ORDER MATTERS AND IS DELIBERATE ─────────────────────────────────
-- Postgres fires same-event triggers in NAME order. 'supplier_payment_allocation_guard'
-- sorts before 'supplier_payment_allocations_cis' ('_' < 's' at the shared
-- prefix), so M2's guard has ALREADY taken `FOR UPDATE` on the payment and then
-- the bill by the time this runs. That is what makes the cumulative read below
-- race-free, and it is why this trigger takes NO locks of its own — acquiring one
-- in a different order is how you turn a correct calculation into a deadlock.
--
-- ── THE CUMULATIVE METHOD (docs/cis-domain.md §9) ───────────────────────────
-- The requirement is that the deductions across all payments of a bill sum to
-- EXACTLY the deduction a single full payment would have produced. A naive
-- per-payment `round2(share × rate)` drifts: a £100 bill with £33.33 labour at
-- 20% (true total £6.67) paid £50 twice gives £3.33 + £3.33 = £6.66, a penny
-- short, and the subcontractor's statement no longer reconciles.
--
-- So nothing is ever apportioned per payment. Each allocation recomputes the
-- CUMULATIVE figure for everything settled so far and subtracts what has already
-- been frozen:
--
--   prior      = Σ amount of LIVE earlier allocations against this bill
--   cumulative = prior + this amount
--   cum_basis  = round2(whole-bill basis × cumulative / bill gross)
--   cum_ded    = round2(cum_basis × rate / 100)
--   this       = cum_* − Σ already-snapshotted prior values
--
-- The last allocation therefore absorbs the entire rounding residue and the total
-- is exact (£3.33 + £3.34 = £6.67). The material allowance is baked into the
-- BILL-LEVEL basis, so it is never "applied" per payment and cannot be
-- double-counted however the payments are split. And because only the CURRENT
-- allocation is computed — priors are read, never rewritten — this is fully
-- compatible with M2's write-once ledger.
--
-- VOIDS: a voided payment drops out of `prior`, so the next payment picks up the
-- deduction it was carrying and the total stays exact. The already-frozen figures
-- on other live allocations may then reflect a different split of the pennies
-- than a fresh calculation would choose — that is CORRECT and intended. Those are
-- historical facts that have been reported; the invariant that must hold is that
-- the TOTAL is right, not that history is retrospectively re-apportioned.
--
-- The `greatest(0, ...)` clamps exist for that same reason: after voids, a
-- subset-sum of frozen increments can in principle exceed the fresh cumulative by
-- a penny. Clamping keeps the deduction non-negative and never over-deducts,
-- which is the conservative direction.
--
-- SECURITY DEFINER because `cis_subcontractors` is admin-only under RLS — the
-- rate authority must hold identically for service_role, for a direct PostgREST
-- write, and for a future background job, not just for a caller who happens to be
-- able to see the profile.
create or replace function public.tg_supplier_payment_allocation_cis()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status      text;
  v_rate        numeric(5, 2);
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
  select c.cis_status, c.deduction_rate into v_status, v_rate
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

drop trigger if exists supplier_payment_allocations_cis on public.supplier_payment_allocations;
create trigger supplier_payment_allocations_cis
  before insert on public.supplier_payment_allocations
  for each row execute function public.tg_supplier_payment_allocation_cis();


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. cis_payment_snapshots — frozen outright, and TIED TO THE ALLOCATIONS
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.tg_cis_payment_snapshots_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception
    'CIS payment snapshot for payment % is immutable — void the payment and record a corrected one',
    old.payment_id using errcode = 'check_violation';
end $$;

drop trigger if exists cis_payment_snapshots_frozen on public.cis_payment_snapshots;
create trigger cis_payment_snapshots_frozen
  before update on public.cis_payment_snapshots
  for each row execute function public.tg_cis_payment_snapshots_frozen();

create or replace function public.tg_cis_payment_snapshots_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.supplier_payments where id = old.payment_id)
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'CIS payment snapshot for payment % cannot be deleted — void the payment instead',
      old.payment_id using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists cis_payment_snapshots_no_delete on public.cis_payment_snapshots;
create trigger cis_payment_snapshots_no_delete
  before delete on public.cis_payment_snapshots
  for each row execute function public.tg_cis_payment_snapshots_no_delete();

-- ── THE CLOSING CONSTRAINT ───────────────────────────────────────────────────
-- The snapshot's totals must equal the sum of the allocations they claim to
-- summarise, AND the payment's `cis_withheld` — the figure M2 already reports and
-- that HMRC will be told. Without this, a caller could post correct allocations
-- and then a snapshot claiming a different deduction, and every downstream
-- consumer would have to guess which one was true.
--
-- DEFERRABLE INITIALLY DEFERRED because the payment, its allocations and the
-- snapshot are necessarily written in separate statements inside one transaction;
-- an immediate check would fire before the set is complete. Deferring makes the
-- rule "true at COMMIT", which is the only point at which it is meaningful.
--
-- Scoped to snapshotted payments only: legacy M2 payments have no snapshot row,
-- so this trigger never fires for them and their behaviour is untouched.
create or replace function public.tg_cis_payment_snapshot_totals()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_alloc_ded   numeric(12, 2);
  v_alloc_basis numeric(12, 2);
  v_alloc_n     int;
  v_withheld    numeric(12, 2);
  v_gross       numeric(12, 2);
begin
  select coalesce(sum(cis_deduction), 0), coalesce(sum(cis_basis), 0),
         count(*) filter (where cis_deduction is null)
    into v_alloc_ded, v_alloc_basis, v_alloc_n
    from public.supplier_payment_allocations
   where payment_id = new.payment_id;

  if v_alloc_n > 0 then
    raise exception
      'payment % mixes CIS and non-CIS allocations — every bill on a CIS payment must carry its own basis',
      new.payment_id using errcode = 'check_violation';
  end if;

  select cis_withheld, gross_amount into v_withheld, v_gross
    from public.supplier_payments where id = new.payment_id;
  if not found then
    raise exception 'supplier payment % not found', new.payment_id
      using errcode = 'check_violation';
  end if;

  if new.cis_deduction is distinct from v_alloc_ded
     or new.cis_basis is distinct from v_alloc_basis then
    raise exception
      'CIS snapshot for payment % does not match its allocations (snapshot basis % / deduction %, allocations % / %)',
      new.payment_id, new.cis_basis, new.cis_deduction, v_alloc_basis, v_alloc_ded
      using errcode = 'check_violation';
  end if;

  if v_withheld is distinct from v_alloc_ded then
    raise exception
      'payment % withholds % but its CIS allocations total % — the withholding is derived, not declared',
      new.payment_id, v_withheld, v_alloc_ded
      using errcode = 'check_violation';
  end if;

  return null;
end $$;

drop trigger if exists cis_payment_snapshot_totals on public.cis_payment_snapshots;
create constraint trigger cis_payment_snapshot_totals
  after insert on public.cis_payment_snapshots
  deferrable initially deferred
  for each row execute function public.tg_cis_payment_snapshot_totals();

-- The mirror of the above: an allocation carrying CIS figures may not exist
-- without the payment-level snapshot that explains the rate. Also deferred —
-- allocations are inserted before the snapshot within the RPC's transaction.
create or replace function public.tg_supplier_payment_allocation_cis_snapshot_required()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cis_deduction is null then return null; end if;
  if not exists (
    select 1 from public.cis_payment_snapshots
     where org_id = new.org_id and payment_id = new.payment_id
  ) then
    raise exception
      'allocation % carries a CIS deduction but payment % has no CIS snapshot to explain the rate',
      new.id, new.payment_id using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists supplier_payment_allocations_cis_snapshot_required
  on public.supplier_payment_allocations;
create constraint trigger supplier_payment_allocations_cis_snapshot_required
  after insert on public.supplier_payment_allocations
  deferrable initially deferred
  for each row execute function public.tg_supplier_payment_allocation_cis_snapshot_required();


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. record_cis_supplier_payment — the atomic posting path
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER, exactly as M2's RPC: RLS, both composite FKs, M2's caps and
-- every trigger above apply to the caller. A definer function would hand every
-- authenticated user the admin's write authority, which is the opposite of what a
-- tax ledger needs.
--
-- WHAT THE CALLER DOES NOT GET TO SEND: the rate, the basis, the deduction, or
-- the withheld total. All are derived here and then INDEPENDENTLY re-derived and
-- checked by the triggers, so bypassing this function buys an attacker nothing.
-- `p_expected_rate` is an optional ASSERTION — if the client believes the rate is
-- 20 and it is really 30, the write is REFUSED rather than silently posted at 30.
-- That protects against the real-world race where the form was rendered before a
-- re-verification landed.
--
-- WHY `gross_amount` IS Σ ALLOCATIONS AND NOT AN INPUT: a CIS deduction has no
-- basis without a bill. M2 permits an unallocated on-account payment; a CIS one
-- cannot exist, because there would be nothing to split into labour and
-- materials. Non-CIS and on-account payments keep using record_supplier_payment,
-- which is unchanged.
--
-- ── CONCURRENCY ─────────────────────────────────────────────────────────────
-- Pass 1 reads each bill's prior settlement to compute the cumulative deduction.
-- Two simultaneous postings against the same bill would otherwise both read the
-- same "already paid" and both compute the same increment. The trigger would
-- still catch it — the second one recomputes under M2's FOR UPDATE lock, sees a
-- different prior and rolls the whole payment back — so a wrong deduction can
-- never be stored either way. But "your payment was rejected, try again" is a
-- much worse answer than simply waiting, so pass 1 takes a transaction-scoped
-- ADVISORY lock per bill, IN FINANCE_ID ORDER.
--
-- Advisory rather than `SELECT … FOR UPDATE`: this function is SECURITY INVOKER,
-- and a row lock on `finances` would demand UPDATE privilege plus a pass through
-- the finances UPDATE policy — coupling a CIS posting to the mutability of the
-- general cost ledger for no benefit. An advisory lock needs no table privilege,
-- lives in its own namespace so it cannot deadlock against M2's row locks, and
-- releases automatically at commit or rollback.
--
-- Sorting by finance_id gives a TOTAL ORDER over the contended keys, which is
-- what makes deadlock between two concurrent postings impossible. Pass 2 inserts
-- in the same order, so M2's guard also takes its row locks in that order. The
-- payment row itself is brand new and therefore uncontended.
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

grant execute on function public.record_cis_supplier_payment(
  uuid, uuid, date, text, text, text, jsonb, numeric
) to authenticated;

grant execute on function public.cis_tax_month_start(date) to authenticated;
grant execute on function public.cis_tax_month_end(date) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. RLS — ADMIN ONLY on both new tables
-- ═══════════════════════════════════════════════════════════════════════════
-- Same posture as CIS M1 and M2, and for the same reason: these rows determine
-- what gets reported to HMRC and what appears on a subcontractor's payment and
-- deduction statement. A member of the same org gets ZERO rows, not a redacted
-- row, and a direct PostgREST caller bypassing the app is refused identically.
--
-- Note what this does NOT restrict: `finances` stays member-readable, so job
-- costs, PO billing and profitability are unchanged for every member. Only the
-- TAX layer sitting beside the bill is admin-gated.
alter table public.cis_bill_details enable row level security;
alter table public.cis_payment_snapshots enable row level security;

drop policy if exists "cis_bill_details: admin all" on public.cis_bill_details;
create policy "cis_bill_details: admin all" on public.cis_bill_details
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "cis_payment_snapshots: admin all" on public.cis_payment_snapshots;
create policy "cis_payment_snapshots: admin all" on public.cis_payment_snapshots
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
