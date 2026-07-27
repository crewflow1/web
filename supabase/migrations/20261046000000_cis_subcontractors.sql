-- H2-CIS M1 — subcontractor identity + HMRC CIS verification state.
--
-- MODEL: a subcontractor is NOT staff. Staff are `users` + `memberships`;
-- `users.employment_type` ('contractor'/'self_employed') is an orthogonal
-- WORKFORCE axis and is deliberately NOT overloaded here. A subcontractor is
-- someone you PAY, and `public.suppliers` is the only entity in this schema
-- carrying payable FKs (finances.supplier_id, purchase_orders.supplier_id).
-- So CIS composes on suppliers as a 1:1 EXTENSION keyed (org_id, supplier_id).
-- No parallel payee entity, no second source of truth for "who we pay".
--
-- WHY A SEPARATE TABLE AND NOT COLUMNS ON `suppliers`:
-- suppliers RLS is MEMBER-READABLE (`org_id in (select public.current_org_ids())`,
-- 20260623000000). A UTR is a tax identifier — the direct precedent is
-- `staff_secrets` (20260529000000), which moved NI numbers off the member-readable
-- `users` table into an ADMIN-ONLY table with a format CHECK and app-layer masking.
-- Putting a UTR on `suppliers` would make every labourer in the org able to read
-- every subcontractor's tax identifier. This table follows staff_secrets exactly:
-- one `for all` policy gated on public.is_org_admin(org_id), a regex CHECK on the
-- identifier, and masking (lib/cis/verification.ts maskUtr) at the display layer.
-- Like staff_secrets, values are NOT encrypted at rest — the control is RLS +
-- masking, and that limitation is deliberate and inherited, not an oversight.
--
-- SCOPE: M1 is DOMAIN + VERIFICATION only. No money moves here. There is no
-- deduction ledger, no CIS statement, no monthly return and NO HMRC integration
-- in this migration — those are M2-M5. Verification is a MANUAL admin workflow
-- (an admin verifies with HMRC out-of-band and records the outcome). Nothing in
-- this codebase simulates an HMRC call.
--
-- Additive, idempotent, and reversible. To roll back:
--   drop trigger if exists cis_subcontractors_rate_authority on public.cis_subcontractors;
--   drop function if exists public.tg_cis_rate_authority();
--   drop table if exists public.cis_subcontractors;
--   alter table public.suppliers drop constraint if exists suppliers_id_org_key;
-- (Dropping suppliers_id_org_key is safe only once no other table references it.)

-- ── composite-FK target on suppliers ─────────────────────────────────────────
-- `suppliers` has PK (id) but no (id, org_id) candidate key, so a cross-tenant-safe
-- composite FK is not available yet. Add it.
--
-- WHY A COMPOSITE FK RATHER THAN THE 20261024 SECURITY DEFINER TRIGGER:
-- 20261024000000 chose triggers for completion_certificates/blueprints/payments
-- because those links are ON DELETE SET NULL over a NOT NULL org_id — a composite
-- FK would have forced ON DELETE CASCADE and wrongly deleted the whole row when
-- the job/customer went away. That objection does NOT apply here: this is a 1:1
-- EXTENSION of a supplier, so cascade-on-supplier-delete is exactly the semantics
-- we want (no supplier ⇒ no CIS profile for it). A declarative composite FK is the
-- stronger control: it is enforced for EVERY role including service_role, needs no
-- procedural code, and cannot be bypassed by a direct PostgREST write. A forged
-- supplier_id from another tenant simply has no matching (id, org_id) row.
--
-- Lock note: this builds a small unique index under a brief ACCESS EXCLUSIVE lock.
-- `suppliers` is a per-tenant supplier list (tens-to-hundreds of rows for a
-- 5-50-person builder), so the lock is negligible. Wrapped so re-runs are no-ops.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'suppliers_id_org_key'
  ) then
    alter table public.suppliers add constraint suppliers_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── cis_subcontractors ───────────────────────────────────────────────────────
create table if not exists public.cis_subcontractors (
  org_id        uuid not null references public.organizations(id) on delete cascade,
  supplier_id   uuid not null,

  -- ── identity as HMRC knows them ───────────────────────────────────────────
  -- The name on the CIS record is often NOT the trading name on the supplier
  -- row ("Dave's Groundworks" trading, "D J Smith Ltd" filed). Both are kept.
  legal_name          text not null check (length(trim(legal_name)) between 1 and 200),
  trading_name        text check (trading_name is null or length(trim(trading_name)) between 1 and 200),
  -- Companies House number: 8 digits, or 2 letters + 6 digits (SC/NI/OC/…).
  company_number      text check (
                        company_number is null
                        or company_number ~ '^([0-9]{8}|[A-Z]{2}[0-9]{6})$'
                      ),
  -- UK Unique Taxpayer Reference — exactly 10 digits. THE sensitive field.
  -- Nullable so it can be cleared (mirrors staff_secrets.ni_number).
  utr                 text check (utr is null or utr ~ '^[0-9]{10}$'),
  subcontractor_type  text check (
                        subcontractor_type is null
                        or subcontractor_type in ('sole_trader','partnership','company','trust')
                      ),
  vat_registered      boolean not null default false,
  -- UK VAT registration number: 9 or 12 digits, optional GB prefix.
  vat_number          text check (
                        vat_number is null
                        or vat_number ~ '^(GB)?([0-9]{9}|[0-9]{12})$'
                      ),

  -- ── HMRC CIS verification state ───────────────────────────────────────────
  -- Real HMRC semantics. Verification returns one of three payment statuses:
  --   gross       — 0%  (subcontractor holds gross payment status)
  --   standard_20 — 20% (registered, net payment)
  --   higher_30   — 30% (NOT registered / could not be matched)
  -- Plus two local, pre-outcome states:
  --   unverified            — never verified. No authority to deduct yet.
  --   verification_required — was verified, now stale (see verification_expires_at)
  --                           or details changed. Must be re-verified.
  -- And one recorded failure:
  --   failed      — HMRC returned "unmatched". Per HMRC this means the HIGHER
  --                 rate applies, so `failed` carries 30 (see the rate authority
  --                 below). It is kept distinct from higher_30 so the operator can
  --                 see that 30% came from a failed match, not a clean result.
  cis_status              text not null default 'unverified' check (
                            cis_status in ('unverified','verification_required','gross','standard_20','higher_30','failed')
                          ),
  -- Percentage, 0-100. Null ONLY while the status is indeterminate. Its value is
  -- NOT free — see cis_subcontractors_rate_matches_status.
  deduction_rate          numeric(5,2) check (
                            deduction_rate is null
                            or (deduction_rate >= 0 and deduction_rate <= 100)
                          ),
  -- HMRC verification reference (shape 'V' + 10 digits, optional suffix letter for
  -- an unmatched subcontractor). The DB enforces only a sanity bound: this is an
  -- externally-issued reference typed in by hand, and a too-strict CHECK on an
  -- external format is a support trap that needs a migration to relax. The precise
  -- shape is validated in lib/cis/verification.ts, where it can be tuned freely.
  verification_reference  text check (
                            verification_reference is null
                            or length(trim(verification_reference)) between 1 and 40
                          ),
  verified_at             date,
  -- HMRC: verification stays good for the tax year of verification plus the two
  -- following tax years. Derived by lib/cis/verification.ts and stored so the
  -- operator can override it; a past date means "re-verify before you pay".
  verification_expires_at date,
  verified_by             uuid references public.users(id) on delete set null,

  -- ── audit ─────────────────────────────────────────────────────────────────
  notes       text,
  created_by  uuid references public.users(id) on delete set null,
  updated_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 1:1 with a supplier, scoped to the tenant.
  primary key (org_id, supplier_id),

  -- Cross-tenant-safe link: the profile's org MUST equal its supplier's org.
  -- Holds for service_role too — a forged supplier_id cannot cross tenants.
  constraint cis_subcontractors_supplier_fk
    foreign key (supplier_id, org_id) references public.suppliers (id, org_id) on delete cascade,

  -- ── RATE AUTHORITY (declarative half) ─────────────────────────────────────
  -- The STATUS is the authority; the rate is a function of it and can never
  -- contradict it. Written with `is not distinct from` rather than `=` because a
  -- CHECK passes on NULL — `deduction_rate = 20` is NULL (not false) when the
  -- rate is NULL, which would let a status carry no rate at all. `is not
  -- distinct from` always yields a real boolean, so the CASE can never be NULL
  -- and the constraint can never be silently satisfied.
  constraint cis_subcontractors_rate_matches_status check (
    case cis_status
      when 'gross'       then deduction_rate is not distinct from 0
      when 'standard_20' then deduction_rate is not distinct from 20
      when 'higher_30'   then deduction_rate is not distinct from 30
      when 'failed'      then deduction_rate is not distinct from 30
      else deduction_rate is null
    end
  ),

  -- An outcome status must say WHEN it was obtained; a pre-outcome status must not
  -- claim a verification date. Keeps "verified" from being an unevidenced label.
  constraint cis_subcontractors_outcome_dated check (
    case
      when cis_status in ('gross','standard_20','higher_30','failed') then verified_at is not null
      when cis_status = 'unverified' then verified_at is null and verification_reference is null
      else true
    end
  ),
  constraint cis_subcontractors_expiry_after_verified check (
    verification_expires_at is null
    or verified_at is null
    or verification_expires_at >= verified_at
  )
);

comment on table public.cis_subcontractors is
  'CIS M1 — 1:1 admin-only extension of public.suppliers holding UK CIS identity '
  '(UTR) and HMRC verification state. Admin-only RLS because it holds tax '
  'identifiers; the supplier row itself stays member-readable.';
comment on column public.cis_subcontractors.utr is
  'UK Unique Taxpayer Reference (10 digits). Sensitive: admin-only via RLS, masked '
  'for display by maskUtr (lib/cis/verification.ts). Never expose on a portal path.';
comment on column public.cis_subcontractors.deduction_rate is
  'Derived from cis_status and constrained to match it. Never set independently.';

-- Sweep index for "who needs re-verifying" without scanning the whole tenant set.
create index if not exists cis_subcontractors_expiry_idx
  on public.cis_subcontractors (org_id, verification_expires_at)
  where verification_expires_at is not null;
create index if not exists cis_subcontractors_status_idx
  on public.cis_subcontractors (org_id, cis_status);

-- ── RATE AUTHORITY (procedural half) + updated_at ────────────────────────────
-- The CHECK above REJECTS a rate that contradicts the status. This trigger makes
-- the honest path ergonomic without weakening that: it only ever fills a rate the
-- caller did not supply, and never overwrites one they did.
--
--   * INSERT with a NULL rate            → derive it from the status.
--   * UPDATE that changes the status but leaves the rate untouched (e.g. a
--     PostgREST PATCH of cis_status alone) → re-derive from the NEW status.
--   * ANY explicitly-supplied rate       → left exactly as given, so the CHECK
--     fires and the forged write is REJECTED with an error.
--
-- Deriving-and-silently-overwriting unconditionally was rejected: a caller that
-- sends higher_30 with rate 0 would get a success response for a write that did
-- not do what they asked. A forged rate should be an ERROR, not a silent fix.
--
-- KNOWN AND ACCEPTED LIMIT: an UPDATE cannot distinguish "column explicitly set
-- to the value it already had" from "column not mentioned" — both arrive as an
-- unchanged NEW. So a forged rate that HAPPENS TO EQUAL the previous rate is
-- read as untouched and gets re-derived instead of refused. That is a weaker
-- ERROR guarantee, not a weaker DATA guarantee: the value stored is still the
-- one the status implies, and it corrects in the SAFE direction — filing a
-- higher_30 result at the old 20 stores 30, never 20. The invariant that
-- actually matters, "a stored (status, rate) pair is always consistent", is held
-- unconditionally by the CHECK above, which no trigger behaviour can loosen.
-- Every unambiguous forgery (any rate differing from the previous one) errors.
create or replace function public.tg_cis_rate_authority()
returns trigger language plpgsql set search_path = public as $$
declare
  v_derived numeric(5,2);
begin
  v_derived := case new.cis_status
    when 'gross'       then 0
    when 'standard_20' then 20
    when 'higher_30'   then 30
    when 'failed'      then 30
    else null
  end;

  if tg_op = 'INSERT' then
    if new.deduction_rate is null then
      new.deduction_rate := v_derived;
    end if;
  else
    -- Status moved and the caller did not touch the rate ⇒ the rate is stale, not
    -- forged. Re-derive. If they DID touch it, leave it for the CHECK to judge.
    if new.cis_status is distinct from old.cis_status
       and new.deduction_rate is not distinct from old.deduction_rate then
      new.deduction_rate := v_derived;
    end if;
    new.updated_at := now();
  end if;

  return new;
end $$;

drop trigger if exists cis_subcontractors_rate_authority on public.cis_subcontractors;
create trigger cis_subcontractors_rate_authority
  before insert or update on public.cis_subcontractors
  for each row execute function public.tg_cis_rate_authority();

-- ── RLS — ADMIN ONLY, no member read ─────────────────────────────────────────
-- Deliberately NOT the member-read/admin-write shape used by operational tables
-- (job_billing_plans, 20261039000000). This table holds tax identifiers, so it
-- takes the staff_secrets shape (20260529000000): ONE `for all` policy gated on
-- is_org_admin for both read and write. A member of the same org gets zero rows,
-- not a redacted row — and because the gate is in the DB, a direct PostgREST
-- caller bypassing the app is refused identically.
alter table public.cis_subcontractors enable row level security;

drop policy if exists "cis_subcontractors: admin all" on public.cis_subcontractors;
create policy "cis_subcontractors: admin all" on public.cis_subcontractors
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
