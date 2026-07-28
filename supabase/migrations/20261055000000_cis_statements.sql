-- H2-CIS M4 — payment & deduction statements + the CIS300-shape monthly return DATASET.
--
-- ══ WHAT THIS MIGRATION IS NOT ══════════════════════════════════════════════
-- IT DOES NOT FILE ANYTHING WITH HMRC. There is no HMRC endpoint, no Government
-- Gateway credential, no transmission of any kind in this migration or anywhere
-- it is called from. The monthly-return status domain is deliberately
-- ('prepared', 'exported') and a CHECK constraint makes any third value
-- impossible — there is NO 'submitted', NO 'filed', NO 'accepted'. A user cannot
-- set a state that claims a return reached HMRC, because no such state exists.
-- CrewFlow produces the FIGURES; the human files them through HMRC's own service
-- or their filing software.
--
-- IT DOES NOT VERIFY ANYTHING WITH HMRC EITHER. M1's verification is a manual
-- admin workflow. Where HMRC requires a verification number on a statement and
-- none is held, this schema stores NULL and the document says so in words. No
-- placeholder, no derived value, no "V0000000000". A statement that invents a
-- verification number is worse than one that admits it lacks one.
--
-- ══ WHAT IT IS ══════════════════════════════════════════════════════════════
-- Two deliverables, both derived ENTIRELY from figures M3 already froze:
--
--   1. cis_statements       — the written statement a contractor must give each
--                             subcontractor for each tax month in which a
--                             payment was made, within 14 days of the tax month
--                             end (CIS340 3.15, CISR12160).
--   2. cis_monthly_returns  — the per-org, per-tax-month dataset a CIS300 return
--                             would need, including the NIL month as a real row.
--
-- ══ NO SECOND DEDUCTION ENGINE ══════════════════════════════════════════════
-- This migration computes NO deduction. It contains no rate, no basis, no
-- materials arithmetic and no apportionment. Every money figure it stores is a
-- SUM of columns M3 already froze on `cis_payment_snapshots` at posting time:
--   cis_gross_payment (HMRC's "gross amount of payment": NET of VAT per CIS340
--   3.12 and NET of the CITB levy per CISR15110), materials_total, cis_deduction.
-- If those figures are right, a statement is right by construction; if they are
-- wrong, the defect is in 20261051000000 and must be fixed there. Summation is
-- the only arithmetic performed here, and `cis_statements_totals_reconcile`
-- below makes even that unforgeable.
--
-- ══ THE HMRC RULES ENCODED HERE (verified 28 July 2026 — docs/cis-domain.md §11)
--   * Statement contents, CIS340 3.15 / CISR12160: "contractor's own name and
--     employer tax reference", "end date of the tax month in which the payment
--     was made", subcontractor name and UTR, "personal verification number if
--     the subcontractor could not be verified and a deduction at the higher rate
--     has been made", "gross amount of the payments made", "cost of any
--     materials that has reduced the amount", "amount of the deduction".
--   * Statement deadline, CISR12160: "The PDS must be issued to the
--     subcontractor within 14 days after the end of the tax month to which it
--     relates."  ⇒ tax_month_end + 14.
--   * GROSS-PAID SUBCONTRACTORS ARE OPTIONAL, CIS340 3.15: "It's good practice
--     for a contractor to give a subcontractor a payment statement where the
--     payment has been made gross, but there is no obligation to do so."
--     Hence `is_statutory`, which distinguishes the two rather than pretending
--     every statement is compelled.
--   * Return deadline, GOV.UK "File your monthly returns": "Send your monthly
--     returns to HMRC by the 19th of every month following the last tax month."
--   * Nil returns, same page: where no payments were made you "file a return
--     showing your payments were 0 (known as a 'nil return')". So a payment-free
--     month is REPORTABLE, not absent — hence `is_nil` as a first-class column.
--   * One line per subcontractor: where a subcontractor's tax treatment changed
--     mid-month "you should only make one entry for that subcontractor showing
--     the total payments and deductions made". Hence the unique index on
--     (return_id, supplier_id) and the `rate_is_uniform` flag for the case where
--     one line spans two rates.
--
-- ══ IMMUTABILITY: THE ESTABLISHED PATTERN, NOT A NEW ONE ════════════════════
-- A statement is a document a subcontractor uses to claim the deduction back. It
-- must reproduce identically years later. This follows the shape already used by
-- toolbox talks (20261025/27) and M2/M3's ledger, deliberately unchanged:
--   * FROZEN COPIES, NEVER JOINS. Every fact on the statement is copied at issue.
--     Re-verifying the subcontractor, correcting a UTR, renaming the supplier or
--     editing the org cannot reach back and alter an issued statement.
--   * WRITE-ONCE + FORWARD-ONLY STATUS. issued → superseded | withdrawn, and
--     nothing else ever changes. Enforced by trigger for EVERY role including
--     service_role, because RLS decides who may write and this decides what a
--     write may say.
--   * SHA-256 content_hash over the frozen facts, hex-constrained and immutable
--     once set — the same `^[a-f0-9]{64}$` idiom as
--     20261033000000_tenant_attachment_content_hash.sql.
--   * NO DELETE, with the org-absence teardown exception copied verbatim in
--     spirit from M2: during an org cascade the parent is already invisible, so
--     a targeted delete is always refused and a teardown always succeeds.
--
-- WHY NO STORAGE BUCKET. The platform's document pattern renders the PDF ON
-- DEMAND from the frozen record (see app/api/health-safety/toolbox-talks/[id]/
-- pdf/route.ts and the completion-certificate route). Nothing is stored, so
-- there are no bytes to mutate and the storage byte-mutation lockdown of
-- 20261032000000 has no surface here. The content_hash is taken over the frozen
-- FACTS, which fully determine the document — that is what makes "this is the
-- statement I issued" provable without keeping a second copy of it.
--
-- ══ VOIDED PAYMENTS: SUPERSEDE, NEVER MUTATE ════════════════════════════════
-- M2 corrects a payment by VOIDING it and recording a new one. So a statement
-- issued in good faith can later cover a payment that no longer exists. Silently
-- rewriting it is not an option — the subcontractor already holds the paper.
--
-- The model therefore makes divergence DETECTABLE and correction EXPLICIT:
--   * `ledger_fingerprint` is a SHA-256 over the exact payments the statement
--     covered and their frozen figures, computed by
--     public.cis_statement_ledger_fingerprint(). Recomputing it against today's
--     ledger and comparing proves, rather than assumes, whether the statement
--     still matches. A void changes the fingerprint; the statement is stale.
--   * REISSUE issues a NEW statement carrying `supersedes_id`, and moves the old
--     one to `superseded`. The old row's CONTENT never changes — only its status
--     and the supersede triple, which are write-once.
--   * If every payment in the month was voided there is nothing left to state,
--     so reissue is impossible by construction (the RPC refuses an empty month).
--     The honest close-out is WITHDRAWAL, with a reason, which preserves the
--     document and records that it should no longer be relied on.
--
-- Additive, idempotent and reversible. To roll back:
--   drop function if exists public.mark_cis_monthly_return_exported(uuid,uuid);
--   drop function if exists public.prepare_cis_monthly_return(uuid,date);
--   drop function if exists public.withdraw_cis_statement(uuid,uuid,text);
--   drop function if exists public.issue_cis_statement(uuid,uuid,date);
--   drop table if exists public.cis_monthly_return_lines;
--   drop table if exists public.cis_monthly_returns;
--   drop table if exists public.cis_statement_payments;
--   drop table if exists public.cis_statements;
--   drop table if exists public.cis_contractor_profiles;
--   drop function if exists public.cis_statement_ledger_fingerprint(uuid,uuid,date);
--   drop function if exists public.cis_statement_due_date(date);
--   drop function if exists public.cis_return_due_date(date);


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. DEADLINES — as SQL functions, so the DB and the app cannot drift
-- ═══════════════════════════════════════════════════════════════════════════
-- Twins of lib/cis/tax-month.ts. IMMUTABLE so they can be used in generated
-- columns and CHECK constraints, which is what makes a stored deadline
-- unforgeable rather than merely conventional.

-- CISR12160: "within 14 days after the end of the tax month to which it relates".
create or replace function public.cis_statement_due_date(d date)
returns date language sql immutable strict parallel safe as $$
  select public.cis_tax_month_end(d) + 14
$$;

-- GOV.UK: "by the 19th of every month following the last tax month". A CIS tax
-- month always ENDS on the 5th, so the 19th of the end date's own month is that
-- date — 6 May–5 June is due 19 June. Deriving it from the END rather than the
-- start is what makes that come out right.
-- NOTE THE EXPLICIT ::timestamp. `date_trunc('month', <date>)` resolves to the
-- date_trunc(text, timestamptz) overload, which is only STABLE — it depends on
-- the session TimeZone, so the same date could truncate to a different month for
-- two users. Casting to `timestamp` selects the IMMUTABLE overload, which is
-- both correct (a CIS tax month has no timezone) and what lets this function be
-- used in the generated column below. Postgres rejected the generated column
-- outright until this cast was added.
create or replace function public.cis_return_due_date(d date)
returns date language sql immutable strict parallel safe as $$
  select date_trunc('month', public.cis_tax_month_end(d)::timestamp)::date + 18
$$;

comment on function public.cis_statement_due_date(date) is
  'Deadline for giving a subcontractor their payment and deduction statement for '
  'the CIS tax month containing `d`: 14 days after the tax month end (CISR12160).';
comment on function public.cis_return_due_date(date) is
  'Deadline for the CIS monthly return covering the tax month containing `d`: the '
  '19th of the month following the tax month (GOV.UK, "File your monthly returns"). '
  'CrewFlow does NOT file it — this is a date we show, not an action we take.';

grant execute on function public.cis_statement_due_date(date) to authenticated;
grant execute on function public.cis_return_due_date(date) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. cis_contractor_profiles — the CONTRACTOR's own CIS identity
-- ═══════════════════════════════════════════════════════════════════════════
-- A statement must carry "contractor's own name and employer tax reference"
-- (CIS340 3.15). CrewFlow held NEITHER: `organizations` has name, vat_number and
-- address but no employer PAYE reference and no contractor UTR. Without this
-- table a statement is legally incomplete, so the RPC below REFUSES to issue one
-- until the reference is on file. It is not invented, defaulted or derived.
--
-- Admin-only, the staff_secrets / cis_subcontractors shape (20260529000000,
-- 20261046000000): these are tax identifiers for the business itself.
--
-- ONE ROW PER ORG — org_id is the primary key, so the 1:1 is structural.
create table if not exists public.cis_contractor_profiles (
  org_id uuid primary key references public.organizations(id) on delete cascade,

  -- The contractor's name AS REGISTERED WITH HMRC, which is often not the
  -- trading name on `organizations.name` ("Dave's Builders" trading, "D J Smith
  -- Ltd" registered). Same reasoning as M1's legal_name/trading_name split.
  legal_name text not null check (length(trim(legal_name)) between 1 and 200),

  -- Employer PAYE reference, e.g. '123/AB45678'. THE field a statement cannot
  -- omit. The DB enforces only a sanity bound, NOT a shape: M1 made exactly this
  -- call for verification_reference and the reasoning is unchanged — an
  -- externally-issued reference typed in by hand, policed by a too-strict CHECK,
  -- is a support trap that needs a migration to relax. The precise shape is
  -- validated in lib/cis/contractor.ts where it can be tuned freely.
  employer_paye_reference text not null
    check (length(trim(employer_paye_reference)) between 3 and 20),

  -- Accounts Office reference (e.g. '123PX00123456'). Not required on a
  -- statement; held because it is required to PAY the deductions over, and an
  -- operator looking at a return wants it in one place. Optional by design.
  accounts_office_reference text
    check (accounts_office_reference is null
           or length(trim(accounts_office_reference)) between 3 and 20),

  -- The contractor's own UTR. Not a statement field; kept for completeness of
  -- the filing pack. Same 10-digit shape M1 enforces on the subcontractor's.
  contractor_utr text check (contractor_utr is null or contractor_utr ~ '^[0-9]{10}$'),

  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.cis_contractor_profiles is
  'H2-CIS M4 — the CONTRACTOR''s own CIS identity: legal name and employer PAYE '
  'reference, both required on every payment and deduction statement (CIS340 '
  '3.15). Admin-only: these are the business''s own tax identifiers. A statement '
  'cannot be issued without a row here — the reference is never invented.';
comment on column public.cis_contractor_profiles.employer_paye_reference is
  'Employer PAYE reference (HMRC "employer tax reference"). Mandatory on a payment '
  'and deduction statement. Shape validated in lib/cis/contractor.ts, not by a '
  'CHECK — see M1''s verification_reference for the same deliberate choice.';

create or replace function public.tg_cis_contractor_profiles_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists cis_contractor_profiles_touch on public.cis_contractor_profiles;
create trigger cis_contractor_profiles_touch
  before update on public.cis_contractor_profiles
  for each row execute function public.tg_cis_contractor_profiles_touch();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE LEDGER FINGERPRINT — what makes staleness provable
-- ═══════════════════════════════════════════════════════════════════════════
-- SHA-256 over the ORDERED list of live CIS payments in one (org, subcontractor,
-- tax month) and the figures M3 froze on each. Computed by ONE function so the
-- value taken at issue and the value recomputed later can never differ by
-- algorithm — only by the ledger genuinely having changed.
--
-- Ordered by payment_id so the digest is deterministic regardless of plan.
-- Voided payments are excluded, which is precisely why voiding one moves the
-- fingerprint and marks every statement covering it as stale.
--
-- SECURITY DEFINER: the tables it reads are admin-only, and a caller with a
-- partial view would compute a fingerprint over a subset and wrongly conclude a
-- statement was stale (or wasn't). The answer must not depend on who is asking.
-- It leaks nothing: the return value is a one-way digest.
create or replace function public.cis_statement_ledger_fingerprint(
  p_org_id uuid, p_supplier_id uuid, p_tax_month_end date
) returns text
language sql stable security definer set search_path = public as $$
  select encode(
    extensions.digest(
      coalesce(
        string_agg(
          s.payment_id::text || ':' || s.cis_gross_payment::text || ':'
            || s.materials_total::text || ':' || s.citb_total::text || ':'
            || s.cis_basis::text || ':' || s.cis_deduction::text,
          '|' order by s.payment_id
        ),
        ''  -- an empty month has a stable, well-defined fingerprint of its own
      ),
      'sha256'
    ),
    'hex'
  )
  from public.cis_payment_snapshots s
  join public.supplier_payments p on p.id = s.payment_id
 where s.org_id = p_org_id
   and s.supplier_id = p_supplier_id
   and s.tax_month_end = p_tax_month_end
   and p.voided_at is null
$$;

comment on function public.cis_statement_ledger_fingerprint(uuid, uuid, date) is
  'SHA-256 over the live (non-voided) CIS payments of one subcontractor in one tax '
  'month and their frozen M3 figures. Stored on a statement at issue; recomputing '
  'it and comparing PROVES whether the statement still matches the ledger. A void '
  'moves it, which is how a statement covering a voided payment becomes detectably '
  'stale instead of silently wrong.';

grant execute on function public.cis_statement_ledger_fingerprint(uuid, uuid, date)
  to authenticated;

-- The same idea for a whole month across every subcontractor, so a PREPARED
-- return can be checked against today's ledger. Defined ONCE and used both by
-- prepare_cis_monthly_return (to store the value) and by the operator surface
-- (to recompute and compare) — a TypeScript reimplementation would turn "the
-- ledger has not moved" into "two implementations still agree", which is a
-- weaker and much easier claim to break.
create or replace function public.cis_monthly_return_ledger_fingerprint(
  p_org_id uuid, p_tax_month_end date
) returns text
language sql stable security definer set search_path = public as $$
  select encode(extensions.digest(
    coalesce(string_agg(
      x.supplier_id::text || ':' || x.gross::text || ':'
        || x.materials::text || ':' || x.deduction::text,
      '|' order by x.supplier_id), ''), 'sha256'), 'hex')
  from (
    select s.supplier_id,
           sum(s.cis_gross_payment) as gross,
           sum(s.materials_total)   as materials,
           sum(s.cis_deduction)     as deduction
      from public.cis_payment_snapshots s
      join public.supplier_payments p on p.id = s.payment_id
     where s.org_id = p_org_id
       and s.tax_month_end = p_tax_month_end
       and p.voided_at is null
     group by s.supplier_id
  ) x
$$;

comment on function public.cis_monthly_return_ledger_fingerprint(uuid, date) is
  'SHA-256 over every subcontractor''s live totals in one CIS tax month. Stored on '
  'a prepared return; recomputing and comparing proves whether the prepared '
  'figures still match the ledger. An empty month hashes the empty string, so a '
  'nil return has a stable fingerprint of its own.';

grant execute on function public.cis_monthly_return_ledger_fingerprint(uuid, date)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. cis_statements — the issued payment & deduction statement
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.cis_statements (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null,

  -- Human reference, per-org sequence. Not an HMRC requirement — an operator
  -- and filing aid, and the PDF's filename.
  statement_number text not null,
  sequence_no      integer not null check (sequence_no > 0),

  -- ── the tax month (CIS340 3.15: "end date of the tax month") ──────────────
  -- Both stored, and pinned to each other by CHECK so a statement can never
  -- claim a period that is not a real CIS tax month. Deadlines are GENERATED,
  -- so they cannot be typed in wrong or drift from the rule.
  tax_month_start  date not null,
  tax_month_end    date not null,
  statement_due_on date generated always as (tax_month_end + 14) stored,

  -- ── frozen CONTRACTOR facts (CIS340 3.15) ─────────────────────────────────
  contractor_name            text not null check (length(trim(contractor_name)) between 1 and 200),
  contractor_paye_reference  text not null check (length(trim(contractor_paye_reference)) between 3 and 20),

  -- ── frozen SUBCONTRACTOR facts ────────────────────────────────────────────
  subcontractor_name text not null check (length(trim(subcontractor_name)) between 1 and 200),
  -- MASKED, exactly as M3 stores it. A statement must prove WHICH UTR was used;
  -- republishing the raw value would create a second unmasked home for the most
  -- sensitive field in the domain. The full UTR is on the printed document only,
  -- rendered from the admin-only source at render time — never persisted twice.
  subcontractor_utr_masked text,

  -- ── the verification number, handled HONESTLY ─────────────────────────────
  -- CISR12160: required "only if the subcontractor could not be verified and a
  -- deduction at the higher rate has been applied". So:
  --   * `verification_number_required` records whether HMRC wants one here.
  --   * `verification_number` is a COPY of what M3 froze, or NULL.
  -- There is deliberately NO default and NO derivation. A required-but-absent
  -- number is a legitimate, representable state, and the document prints the
  -- absence in words. Inventing one would be a fabricated tax record.
  verification_number_required boolean not null,
  verification_number          text
    check (verification_number is null or length(trim(verification_number)) between 1 and 40),

  -- ── the money (SUMS of M3's frozen figures — no arithmetic of our own) ────
  -- HMRC's "gross amount of the payments made": NET of VAT (CIS340 3.12) and NET
  -- of the CITB levy (CISR15110). NOT supplier_payments.gross_amount, which is
  -- VAT-inclusive cash and would over-report every VAT-registered subcontractor.
  gross_amount     numeric(12, 2) not null check (gross_amount >= 0),
  materials_amount numeric(12, 2) not null check (materials_amount >= 0),
  deduction_amount numeric(12, 2) not null check (deduction_amount >= 0),
  payment_count    integer not null check (payment_count > 0),

  -- ── rate provenance ───────────────────────────────────────────────────────
  -- A subcontractor re-verified mid-month can have two payments at two rates in
  -- one statement. HMRC does not require the rate ON the statement, and one
  -- entry must cover the whole month — so rather than pick a rate or average
  -- one, the uniform case records it and the mixed case records that it is
  -- mixed. Written as a CASE so the constraint can never evaluate to NULL and be
  -- silently satisfied (the trap M1 documents on its rate/status CHECK).
  rate_is_uniform boolean not null,
  deduction_rate  numeric(5, 2) check (deduction_rate is null
                                       or (deduction_rate >= 0 and deduction_rate <= 100)),
  cis_status      text check (cis_status is null
                              or cis_status in ('gross', 'standard_20', 'higher_30', 'failed')),

  -- CIS340 3.15: a statement is COMPELLED only where a deduction was made; for a
  -- gross-paid subcontractor it is "good practice ... but there is no obligation
  -- to do so". Recording which one this is keeps the document truthful about its
  -- own status instead of implying every statement is statutory.
  is_statutory boolean not null,

  -- ── evidence ──────────────────────────────────────────────────────────────
  -- SHA-256 of the canonical frozen content (see issue_cis_statement). Same
  -- hex-64 idiom as tenant_attachments.content_hash (20261033000000).
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  -- SHA-256 of the ledger this was derived from — see §3.
  ledger_fingerprint text not null check (ledger_fingerprint ~ '^[a-f0-9]{64}$'),

  -- ── lifecycle ─────────────────────────────────────────────────────────────
  -- No 'draft'. A statement is derived wholly from the ledger, so there is
  -- nothing to draft — the preview is computed live and never stored. Issuing is
  -- the act, and the terminal states are the two honest ways it stops applying.
  status text not null default 'issued'
         check (status in ('issued', 'superseded', 'withdrawn')),

  issued_at timestamptz not null default now(),
  issued_on date not null default (now() at time zone 'utc')::date,
  issued_by uuid references public.users(id) on delete set null,

  -- Reissue lineage. `supersedes_id` points BACKWARD from the replacement to the
  -- statement it replaces, so the chain is append-only and the old row's content
  -- is untouched by the act of replacing it.
  supersedes_id uuid references public.cis_statements(id) on delete restrict,
  superseded_at timestamptz,
  superseded_by uuid references public.users(id) on delete set null,

  withdrawn_at    timestamptz,
  withdrawn_by    uuid references public.users(id) on delete set null,
  withdraw_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cis_statements_supplier_fk
    foreign key (supplier_id, org_id) references public.suppliers (id, org_id),

  constraint cis_statements_number_unique unique (org_id, statement_number),
  constraint cis_statements_sequence_unique unique (org_id, sequence_no),

  -- The period must be a REAL CIS tax month, not any two dates.
  constraint cis_statements_tax_month_real check (
    tax_month_start = public.cis_tax_month_start(tax_month_end)
    and tax_month_end = public.cis_tax_month_end(tax_month_start)
  ),

  -- Arithmetic sanity that needs no lookup and holds for every role.
  -- materials REDUCED the basis, so they can never exceed the gross they were
  -- taken out of; the deduction can never exceed what remained after them.
  constraint cis_statements_money_coherent check (
    materials_amount <= gross_amount
    and deduction_amount <= gross_amount - materials_amount
  ),

  -- Uniform ⇒ both facts present; mixed ⇒ both absent. Never half-stated.
  constraint cis_statements_rate_provenance check (
    case rate_is_uniform
      when true  then deduction_rate is not null and cis_status is not null
      else deduction_rate is null and cis_status is null
    end
  ),

  -- A statement is statutory exactly when a deduction was actually made.
  constraint cis_statements_statutory_matches
    check (is_statutory = (deduction_amount > 0)),

  -- Status and its evidence move together. A superseded statement was superseded
  -- at a time; a withdrawn one carries a reason (and note the explicit
  -- `is not null` — without it the CHECK has the NULL hole M2 documents on
  -- supplier_payments_void_evidenced and would pass a reasonless withdrawal).
  constraint cis_statements_status_evidenced check (
    case status
      when 'issued' then superseded_at is null and withdrawn_at is null
      when 'superseded' then superseded_at is not null and withdrawn_at is null
      else withdrawn_at is not null
           and withdraw_reason is not null
           and length(trim(withdraw_reason)) between 1 and 500
           and superseded_at is null
    end
  ),

  -- A statement cannot supersede itself.
  constraint cis_statements_no_self_supersede check (supersedes_id is distinct from id)
);

comment on table public.cis_statements is
  'H2-CIS M4 — the payment and deduction statement a contractor must give a '
  'subcontractor for each tax month in which a payment was made, within 14 days of '
  'the tax month end (CIS340 3.15, CISR12160). Every figure is a SUM of M3''s '
  'frozen snapshots; no deduction is computed here. Immutable once issued — '
  'corrected by issuing a replacement, never by editing. Admin-only RLS.';
comment on column public.cis_statements.gross_amount is
  'HMRC''s "gross amount of the payments made": NET of VAT (CIS340 3.12) and NET of '
  'the CITB levy (CISR15110). Σ of cis_payment_snapshots.cis_gross_payment for the '
  'month. NOT supplier_payments.gross_amount, which is VAT-inclusive cash.';
comment on column public.cis_statements.verification_number is
  'The verification number M3 froze, or NULL. NEVER invented, defaulted or derived. '
  'Required by CISR12160 only where the subcontractor could not be verified and the '
  'higher rate was applied — see verification_number_required. When required and '
  'NULL, the document states the absence in words.';
comment on column public.cis_statements.is_statutory is
  'True when a deduction was made and the statement is legally required. False '
  'when the subcontractor was paid gross — CIS340 3.15 makes that statement good '
  'practice but not an obligation.';
comment on column public.cis_statements.ledger_fingerprint is
  'SHA-256 of the payments this statement covered, at issue. Recompute with '
  'cis_statement_ledger_fingerprint() and compare to detect that a covered payment '
  'has since been voided — the statement is then stale and must be reissued.';
comment on column public.cis_statements.status is
  'issued | superseded | withdrawn. Forward-only. There is no draft (a statement is '
  'wholly derived) and no state that claims anything was sent to HMRC.';

-- ONE current statement per subcontractor per tax month. A reissue must supersede
-- the old one first — enforced by the index, not merely by the RPC.
create unique index if not exists cis_statements_one_current_idx
  on public.cis_statements (org_id, supplier_id, tax_month_end)
  where status = 'issued';

create index if not exists cis_statements_org_month_idx
  on public.cis_statements (org_id, tax_month_end, supplier_id);
create index if not exists cis_statements_supplier_idx
  on public.cis_statements (org_id, supplier_id, tax_month_end desc);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. cis_statement_payments — PROVENANCE BINDING
-- ═══════════════════════════════════════════════════════════════════════════
-- Exactly which payments a statement summarised, with the figures as they stood.
-- This is what turns "the totals look right" into "the totals ARE the ledger":
-- cis_statements_totals_reconcile (below) makes the parent's totals equal the sum
-- of these rows at COMMIT, for every role, so a forged statement header cannot
-- coexist with honest lines or vice versa.
--
-- Frozen outright, exactly like supplier_payment_allocations (M2): every column
-- is either money, a binding or an audit stamp, so no UPDATE is ever legitimate.
create table if not exists public.cis_statement_payments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  statement_id uuid not null references public.cis_statements(id) on delete cascade,
  payment_id   uuid not null,
  supplier_id  uuid not null,

  -- Copies of M3's frozen snapshot figures at the moment of issue. Held here as
  -- well as on the snapshot so the statement remains fully self-explaining even
  -- if the payment is later voided (the snapshot survives a void, but the
  -- statement must not depend on re-reading it to justify its own totals).
  paid_on           date not null,
  cis_gross_payment numeric(12, 2) not null check (cis_gross_payment >= 0),
  materials_total   numeric(12, 2) not null check (materials_total >= 0),
  cis_deduction     numeric(12, 2) not null check (cis_deduction >= 0),
  deduction_rate    numeric(5, 2) not null check (deduction_rate >= 0 and deduction_rate <= 100),
  cis_status        text not null check (cis_status in ('gross','standard_20','higher_30','failed')),

  created_at timestamptz not null default now(),

  -- Cross-tenant-safe binding to the payment itself: org AND supplier in one
  -- declarative constraint, which holds for service_role too. A forged
  -- payment_id from another tenant simply has no matching row.
  constraint cis_statement_payments_payment_fk
    foreign key (payment_id, org_id, supplier_id)
    references public.supplier_payments (id, org_id, supplier_id),

  -- A payment appears at most once on a statement.
  constraint cis_statement_payments_once unique (statement_id, payment_id)
);

comment on table public.cis_statement_payments is
  'H2-CIS M4 — provenance binding: exactly which supplier payments a statement '
  'summarised and the M3 figures frozen on each. Frozen outright (no UPDATE, no '
  'targeted DELETE). The parent statement''s totals are constrained to equal the '
  'sum of these rows at COMMIT.';

create index if not exists cis_statement_payments_statement_idx
  on public.cis_statement_payments (statement_id);
create index if not exists cis_statement_payments_payment_idx
  on public.cis_statement_payments (org_id, payment_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. cis_monthly_returns — THE CIS300-SHAPE DATASET. DATA ONLY.
-- ═══════════════════════════════════════════════════════════════════════════
-- READ THE STATUS DOMAIN BELOW BEFORE CHANGING IT. It is ('prepared','exported')
-- and that is a deliberate, load-bearing limit, not an unfinished enum:
--
--   prepared — the figures have been assembled and frozen. Nothing was sent.
--   exported — the operator took the figures out of CrewFlow (downloaded them).
--              Still nothing was sent. "Exported" describes an act CrewFlow
--              genuinely performed; it makes no claim about HMRC.
--
-- There is NO 'submitted', NO 'filed', NO 'accepted', and adding one would be a
-- product decision with legal consequences, not a schema tidy-up. CrewFlow has
-- no HMRC integration; a status a user could set to "filed" without a filing
-- having happened is a false record of a statutory obligation, and the penalty
-- for a missed CIS return starts at £100 and rises to £3,000. The CHECK makes
-- the false state unrepresentable rather than merely discouraged.
create table if not exists public.cis_monthly_returns (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  tax_month_start date not null,
  tax_month_end   date not null,
  -- GOV.UK: "by the 19th of every month following the last tax month". Generated,
  -- so it is a fact about the period rather than something a caller can supply.
  return_due_on   date generated always as (public.cis_return_due_date(tax_month_end)) stored,

  -- Frozen contractor identity, same reasoning as the statement.
  contractor_name           text not null check (length(trim(contractor_name)) between 1 and 200),
  contractor_paye_reference text not null check (length(trim(contractor_paye_reference)) between 3 and 20),
  accounts_office_reference text,

  -- ── the return-level facts ────────────────────────────────────────────────
  -- A month with no payments is REPORTABLE (GOV.UK: "file a return showing your
  -- payments were 0"). Modelling it as an absent row would make "nothing to do"
  -- and "a nil return is due" indistinguishable — the second is an obligation.
  is_nil               boolean not null,
  subcontractor_count  integer not null check (subcontractor_count >= 0),
  payment_count        integer not null check (payment_count >= 0),
  total_gross          numeric(12, 2) not null check (total_gross >= 0),
  total_materials      numeric(12, 2) not null check (total_materials >= 0),
  total_deduction      numeric(12, 2) not null check (total_deduction >= 0),

  status text not null default 'prepared' check (status in ('prepared', 'exported')),

  ledger_fingerprint text not null check (ledger_fingerprint ~ '^[a-f0-9]{64}$'),
  content_hash       text not null check (content_hash ~ '^[a-f0-9]{64}$'),

  prepared_at timestamptz not null default now(),
  prepared_by uuid references public.users(id) on delete set null,
  exported_at timestamptz,
  exported_by uuid references public.users(id) on delete set null,

  -- Re-preparing supersedes rather than overwrites, so "what did we prepare on
  -- the 12th" stays answerable after the ledger moves.
  supersedes_id uuid references public.cis_monthly_returns(id) on delete restrict,
  superseded_at timestamptz,
  superseded_by uuid references public.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cis_monthly_returns_tax_month_real check (
    tax_month_start = public.cis_tax_month_start(tax_month_end)
    and tax_month_end = public.cis_tax_month_end(tax_month_start)
  ),

  -- A nil return is nil in every respect. Stated as a CASE so it cannot be
  -- half-true: "nil" with a subcontractor on it is not a nil return.
  constraint cis_monthly_returns_nil_coherent check (
    case is_nil
      when true then subcontractor_count = 0 and payment_count = 0
                     and total_gross = 0 and total_materials = 0 and total_deduction = 0
      else subcontractor_count > 0 and payment_count > 0
    end
  ),
  constraint cis_monthly_returns_money_coherent check (
    total_materials <= total_gross
    and total_deduction <= total_gross - total_materials
  ),
  constraint cis_monthly_returns_export_evidenced check (
    (status = 'prepared' and exported_at is null)
    or (status = 'exported' and exported_at is not null)
  ),
  constraint cis_monthly_returns_no_self_supersede check (supersedes_id is distinct from id)
);

comment on table public.cis_monthly_returns is
  'H2-CIS M4 — the dataset a CIS300 monthly return would need, per org per CIS tax '
  'month. DATA ONLY: CrewFlow does not file, and the status domain '
  '(prepared|exported) contains no state that claims otherwise. A payment-free '
  'month is a real row with is_nil = true, because a nil return is itself '
  'reportable. Admin-only RLS.';
comment on column public.cis_monthly_returns.status is
  'prepared | exported. NEITHER MEANS FILED. "exported" records that the operator '
  'took the figures out of CrewFlow; it asserts nothing about HMRC. Do not add a '
  '"submitted" state without an actual submission integration — see this table''s '
  'header in 20261055000000.';
comment on column public.cis_monthly_returns.is_nil is
  'True when no CIS payments were made in the tax month. GOV.UK requires a nil '
  'return in that case, so the obligation is modelled as a row rather than as the '
  'absence of one.';
comment on column public.cis_monthly_returns.return_due_on is
  'The 19th of the month following the tax month (GOV.UK, "File your monthly '
  'returns"). A deadline CrewFlow SHOWS. It does not file, and does not track '
  'whether the user did.';

create unique index if not exists cis_monthly_returns_one_current_idx
  on public.cis_monthly_returns (org_id, tax_month_end)
  where superseded_at is null;

create index if not exists cis_monthly_returns_org_month_idx
  on public.cis_monthly_returns (org_id, tax_month_end desc);


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. cis_monthly_return_lines — one entry per subcontractor
-- ═══════════════════════════════════════════════════════════════════════════
-- CIS300 carries one line per subcontractor with the month's combined totals,
-- including where their tax treatment changed mid-month. Frozen outright.
create table if not exists public.cis_monthly_return_lines (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references public.organizations(id) on delete cascade,
  return_id uuid not null references public.cis_monthly_returns(id) on delete cascade,
  supplier_id uuid not null,

  subcontractor_name       text not null,
  subcontractor_utr_masked text,
  -- Same honesty rule as the statement: copied or NULL, never invented.
  verification_number          text,
  verification_number_required boolean not null,

  rate_is_uniform boolean not null,
  deduction_rate  numeric(5, 2) check (deduction_rate is null
                                       or (deduction_rate >= 0 and deduction_rate <= 100)),
  cis_status      text check (cis_status is null
                              or cis_status in ('gross','standard_20','higher_30','failed')),

  gross_amount     numeric(12, 2) not null check (gross_amount >= 0),
  materials_amount numeric(12, 2) not null check (materials_amount >= 0),
  deduction_amount numeric(12, 2) not null check (deduction_amount >= 0),
  payment_count    integer not null check (payment_count > 0),

  created_at timestamptz not null default now(),

  constraint cis_monthly_return_lines_supplier_fk
    foreign key (supplier_id, org_id) references public.suppliers (id, org_id),

  -- HMRC: "you should only make one entry for that subcontractor".
  constraint cis_monthly_return_lines_one_per_sub unique (return_id, supplier_id),

  constraint cis_monthly_return_lines_money_coherent check (
    materials_amount <= gross_amount
    and deduction_amount <= gross_amount - materials_amount
  ),
  constraint cis_monthly_return_lines_rate_provenance check (
    case rate_is_uniform
      when true  then deduction_rate is not null and cis_status is not null
      else deduction_rate is null and cis_status is null
    end
  )
);

comment on table public.cis_monthly_return_lines is
  'H2-CIS M4 — one line per subcontractor on a prepared monthly return, with the '
  'tax month''s combined totals (HMRC: one entry per subcontractor even where the '
  'tax treatment changed mid-month). Frozen outright.';

create index if not exists cis_monthly_return_lines_return_idx
  on public.cis_monthly_return_lines (return_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. IMMUTABILITY — write-once, forward-only status, no delete
-- ═══════════════════════════════════════════════════════════════════════════
-- The toolbox-talk shape (20261025000000 §7), applied to a tax document. Runs
-- for EVERY role including service_role: RLS decides WHO may write, this decides
-- WHAT a write may say, and the two are independent controls.
create or replace function public.tg_cis_statements_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Terminal states are terminal. A withdrawn or superseded statement is history.
  if old.status in ('superseded', 'withdrawn') then
    raise exception
      'statement % is % — a closed statement is final. Issue a replacement instead',
      old.statement_number, old.status using errcode = 'check_violation';
  end if;

  -- Forward-only: issued → superseded | withdrawn, and nothing else.
  if new.status is distinct from old.status
     and new.status not in ('superseded', 'withdrawn') then
    raise exception
      'invalid statement status transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- EVERY substantive fact is frozen. Only the two closing transitions and their
  -- evidence may move — listed positively below rather than by omission, so a
  -- column added later is frozen by default rather than editable by accident.
  if (new.id, new.org_id, new.supplier_id, new.statement_number, new.sequence_no,
      new.tax_month_start, new.tax_month_end,
      new.contractor_name, new.contractor_paye_reference,
      new.subcontractor_name, new.subcontractor_utr_masked,
      new.verification_number_required, new.verification_number,
      new.gross_amount, new.materials_amount, new.deduction_amount, new.payment_count,
      new.rate_is_uniform, new.deduction_rate, new.cis_status, new.is_statutory,
      new.content_hash, new.ledger_fingerprint,
      new.issued_at, new.issued_on, new.issued_by, new.supersedes_id, new.created_at)
     is distinct from
     (old.id, old.org_id, old.supplier_id, old.statement_number, old.sequence_no,
      old.tax_month_start, old.tax_month_end,
      old.contractor_name, old.contractor_paye_reference,
      old.subcontractor_name, old.subcontractor_utr_masked,
      old.verification_number_required, old.verification_number,
      old.gross_amount, old.materials_amount, old.deduction_amount, old.payment_count,
      old.rate_is_uniform, old.deduction_rate, old.cis_status, old.is_statutory,
      old.content_hash, old.ledger_fingerprint,
      old.issued_at, old.issued_on, old.issued_by, old.supersedes_id, old.created_at)
  then
    raise exception
      'statement % is immutable once issued — issue a replacement statement instead',
      old.statement_number using errcode = 'check_violation';
  end if;

  -- Attribute a closure that arrived as a direct PATCH without naming its author.
  -- auth.uid() is NULL for service_role, which is correct: an unattributable act
  -- is recorded as unattributed, never as someone.
  if new.superseded_at is not null and new.superseded_by is null then
    new.superseded_by := auth.uid();
  end if;
  if new.withdrawn_at is not null and new.withdrawn_by is null then
    new.withdrawn_by := auth.uid();
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists cis_statements_immutable on public.cis_statements;
create trigger cis_statements_immutable
  before update on public.cis_statements
  for each row execute function public.tg_cis_statements_immutable();

-- No delete, except when the tenant itself goes. Same org-absence test as M2/M3:
-- during a cascade the parent org is already invisible from inside the trigger,
-- so a targeted delete is always refused and a teardown always succeeds. No
-- session flags, nothing a caller can spoof.
create or replace function public.tg_cis_statements_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'statement % cannot be deleted — withdraw it instead (issued statements are permanent)',
      old.statement_number using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists cis_statements_no_delete on public.cis_statements;
create trigger cis_statements_no_delete
  before delete on public.cis_statements
  for each row execute function public.tg_cis_statements_no_delete();

-- Provenance rows are frozen outright — there is no legitimate edit to a record
-- of which payment a statement covered.
create or replace function public.tg_cis_statement_payments_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception
    'statement provenance rows are immutable (row %) — issue a replacement statement',
    old.id using errcode = 'check_violation';
end $$;

drop trigger if exists cis_statement_payments_frozen on public.cis_statement_payments;
create trigger cis_statement_payments_frozen
  before update on public.cis_statement_payments
  for each row execute function public.tg_cis_statement_payments_frozen();

create or replace function public.tg_cis_statement_payments_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.cis_statements where id = old.statement_id)
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'statement provenance row % cannot be deleted', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists cis_statement_payments_no_delete on public.cis_statement_payments;
create trigger cis_statement_payments_no_delete
  before delete on public.cis_statement_payments
  for each row execute function public.tg_cis_statement_payments_no_delete();

-- ── THE RECONCILIATION CONSTRAINT ───────────────────────────────────────────
-- A statement's totals MUST equal the payments it claims to summarise. Without
-- this, a caller could write honest provenance rows and a header saying something
-- else, and every reader downstream would have to guess which was true.
--
-- DEFERRABLE INITIALLY DEFERRED because the statement and its provenance rows are
-- necessarily written in separate statements inside one transaction; an immediate
-- check would fire before the set is complete. Deferring makes the rule "true at
-- COMMIT", the only point at which it is meaningful. Same shape and reasoning as
-- M3's cis_payment_snapshot_totals.
create or replace function public.tg_cis_statements_totals_reconcile()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_gross numeric(12, 2);
  v_mat   numeric(12, 2);
  v_ded   numeric(12, 2);
  v_n     integer;
begin
  select coalesce(sum(cis_gross_payment), 0), coalesce(sum(materials_total), 0),
         coalesce(sum(cis_deduction), 0), count(*)
    into v_gross, v_mat, v_ded, v_n
    from public.cis_statement_payments
   where statement_id = new.id;

  if v_n = 0 then
    raise exception
      'statement % covers no payments — a statement is only issued for a tax month in which a payment was made',
      new.statement_number using errcode = 'check_violation';
  end if;

  if new.payment_count is distinct from v_n
     or new.gross_amount is distinct from v_gross
     or new.materials_amount is distinct from v_mat
     or new.deduction_amount is distinct from v_ded then
    raise exception
      'statement % does not reconcile to its payments (header % / % / % over % payments; payments sum to % / % / % over %)',
      new.statement_number,
      new.gross_amount, new.materials_amount, new.deduction_amount, new.payment_count,
      v_gross, v_mat, v_ded, v_n
      using errcode = 'check_violation';
  end if;

  return null;
end $$;

drop trigger if exists cis_statements_totals_reconcile on public.cis_statements;
create constraint trigger cis_statements_totals_reconcile
  after insert on public.cis_statements
  deferrable initially deferred
  for each row execute function public.tg_cis_statements_totals_reconcile();

-- ── monthly return immutability ─────────────────────────────────────────────
-- Only two things may ever move: prepared → exported (with its stamp), and the
-- supersede triple. Everything else is frozen the moment it is prepared.
create or replace function public.tg_cis_monthly_returns_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.superseded_at is not null then
    raise exception
      'this monthly return has been superseded — prepare a new one instead'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status and
     not (old.status = 'prepared' and new.status = 'exported') then
    raise exception
      'invalid monthly return status transition % -> % (CrewFlow does not file returns, so there is no state beyond "exported")',
      old.status, new.status using errcode = 'check_violation';
  end if;

  if (new.id, new.org_id, new.tax_month_start, new.tax_month_end,
      new.contractor_name, new.contractor_paye_reference, new.accounts_office_reference,
      new.is_nil, new.subcontractor_count, new.payment_count,
      new.total_gross, new.total_materials, new.total_deduction,
      new.ledger_fingerprint, new.content_hash,
      new.prepared_at, new.prepared_by, new.supersedes_id, new.created_at)
     is distinct from
     (old.id, old.org_id, old.tax_month_start, old.tax_month_end,
      old.contractor_name, old.contractor_paye_reference, old.accounts_office_reference,
      old.is_nil, old.subcontractor_count, old.payment_count,
      old.total_gross, old.total_materials, old.total_deduction,
      old.ledger_fingerprint, old.content_hash,
      old.prepared_at, old.prepared_by, old.supersedes_id, old.created_at)
  then
    raise exception
      'a prepared monthly return is immutable — prepare a new one instead'
      using errcode = 'check_violation';
  end if;

  if new.exported_at is not null and new.exported_by is null then
    new.exported_by := auth.uid();
  end if;
  if new.superseded_at is not null and new.superseded_by is null then
    new.superseded_by := auth.uid();
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists cis_monthly_returns_immutable on public.cis_monthly_returns;
create trigger cis_monthly_returns_immutable
  before update on public.cis_monthly_returns
  for each row execute function public.tg_cis_monthly_returns_immutable();

create or replace function public.tg_cis_monthly_returns_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'a prepared monthly return cannot be deleted — prepare a new one, which supersedes it'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists cis_monthly_returns_no_delete on public.cis_monthly_returns;
create trigger cis_monthly_returns_no_delete
  before delete on public.cis_monthly_returns
  for each row execute function public.tg_cis_monthly_returns_no_delete();

create or replace function public.tg_cis_monthly_return_lines_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception
    'monthly return lines are immutable (line %) — prepare a new return instead', old.id
    using errcode = 'check_violation';
end $$;

drop trigger if exists cis_monthly_return_lines_frozen on public.cis_monthly_return_lines;
create trigger cis_monthly_return_lines_frozen
  before update on public.cis_monthly_return_lines
  for each row execute function public.tg_cis_monthly_return_lines_frozen();

create or replace function public.tg_cis_monthly_return_lines_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.cis_monthly_returns where id = old.return_id)
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception 'monthly return lines cannot be deleted (line %)', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists cis_monthly_return_lines_no_delete on public.cis_monthly_return_lines;
create trigger cis_monthly_return_lines_no_delete
  before delete on public.cis_monthly_return_lines
  for each row execute function public.tg_cis_monthly_return_lines_no_delete();

-- The return's totals must equal its lines, at COMMIT. Same reasoning as the
-- statement's reconciliation trigger. A nil return has no lines, and that is the
-- one case where zero lines is correct — hence the is_nil branch.
create or replace function public.tg_cis_monthly_returns_reconcile()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_gross numeric(12, 2);
  v_mat   numeric(12, 2);
  v_ded   numeric(12, 2);
  v_pay   integer;
  v_n     integer;
begin
  select coalesce(sum(gross_amount), 0), coalesce(sum(materials_amount), 0),
         coalesce(sum(deduction_amount), 0), coalesce(sum(payment_count), 0), count(*)
    into v_gross, v_mat, v_ded, v_pay, v_n
    from public.cis_monthly_return_lines
   where return_id = new.id;

  if new.is_nil and v_n > 0 then
    raise exception
      'a nil return cannot carry subcontractor lines — it reports that no payments were made'
      using errcode = 'check_violation';
  end if;

  if new.subcontractor_count is distinct from v_n
     or new.payment_count is distinct from v_pay
     or new.total_gross is distinct from v_gross
     or new.total_materials is distinct from v_mat
     or new.total_deduction is distinct from v_ded then
    raise exception
      'monthly return does not reconcile to its lines (header % / % / % over % subcontractors; lines sum to % / % / % over %)',
      new.total_gross, new.total_materials, new.total_deduction, new.subcontractor_count,
      v_gross, v_mat, v_ded, v_n
      using errcode = 'check_violation';
  end if;

  return null;
end $$;

drop trigger if exists cis_monthly_returns_reconcile on public.cis_monthly_returns;
create constraint trigger cis_monthly_returns_reconcile
  after insert on public.cis_monthly_returns
  deferrable initially deferred
  for each row execute function public.tg_cis_monthly_returns_reconcile();


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. issue_cis_statement — the atomic issue / reissue path
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER, exactly as M2's and M3's RPCs: RLS, the composite FKs and
-- every trigger above apply to the caller. A definer function would hand every
-- authenticated user the admin's authority over tax documents.
--
-- WHAT THE CALLER DOES NOT GET TO SEND: any money figure, any rate, any name,
-- the verification number, the statement number, or either hash. All are read
-- from frozen M3 snapshots and the contractor profile, and the reconciliation
-- trigger independently re-checks the totals at COMMIT — so bypassing this
-- function buys nothing.
--
-- CONCURRENCY: a transaction-scoped advisory lock on (org, supplier, tax month)
-- serialises two operators issuing the same statement at once. Without it, both
-- could read "no current statement", both insert, and the partial unique index
-- would reject the loser with an index-violation instead of the sequence simply
-- waiting. The lock lives in its own namespace so it cannot deadlock against
-- M2's row locks, and releases at commit or rollback.
create or replace function public.issue_cis_statement(
  p_org_id      uuid,
  p_supplier_id uuid,
  p_tax_month_end date
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id           uuid;
  v_prev         uuid;
  v_seq          integer;
  v_number       text;
  v_start        date;
  v_c_name       text;
  v_c_paye       text;
  v_sub_name     text;
  v_utr_masked   text;
  v_ver          text;
  v_ver_required boolean;
  v_rates        numeric[];
  v_statuses     text[];
  v_uniform      boolean;
  v_rate         numeric(5, 2);
  v_status       text;
  v_gross        numeric(12, 2);
  v_mat          numeric(12, 2);
  v_ded          numeric(12, 2);
  v_n            integer;
  v_ids          uuid[];
  v_fingerprint  text;
  v_hash         text;
begin
  if p_org_id is null or not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can issue a CIS statement'
      using errcode = 'insufficient_privilege';
  end if;
  if p_tax_month_end is null or p_tax_month_end <> public.cis_tax_month_end(p_tax_month_end) then
    raise exception
      'a statement covers a CIS tax month, which always ends on the 5th — % is not a tax month end',
      p_tax_month_end using errcode = 'invalid_parameter_value';
  end if;
  v_start := public.cis_tax_month_start(p_tax_month_end);

  perform pg_advisory_xact_lock(
    hashtext('cis_statement_issue'),
    hashtext(p_org_id::text || ':' || p_supplier_id::text || ':' || p_tax_month_end::text)
  );

  -- ── the contractor's own identity — required, never invented ──────────────
  select legal_name, employer_paye_reference into v_c_name, v_c_paye
    from public.cis_contractor_profiles where org_id = p_org_id;
  if not found then
    raise exception
      'your CIS contractor details are not set up — a payment and deduction statement must show your name and employer PAYE reference (CIS340 3.15)'
      using errcode = 'check_violation';
  end if;

  -- ── THE COVERED SET, PINNED ONCE ──────────────────────────────────────────
  -- Every figure below, and the provenance rows, derive from THIS array and
  -- nothing else. Pinning the set in one query is what makes the header and its
  -- provenance rows provably agree: a payment voided a millisecond later cannot
  -- land between the two writes and leave the statement disagreeing with itself.
  -- (It makes the statement STALE, which the fingerprint reports — a different
  -- and honest outcome.)
  select array_agg(s.payment_id order by s.payment_id) into v_ids
    from public.cis_payment_snapshots s
    join public.supplier_payments p on p.id = s.payment_id
   where s.org_id = p_org_id
     and s.supplier_id = p_supplier_id
     and s.tax_month_end = p_tax_month_end
     and p.voided_at is null;

  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception
      'there are no live CIS payments to this subcontractor in the tax month ending % — a statement is only required for a month in which a payment was made',
      p_tax_month_end using errcode = 'check_violation';
  end if;

  -- ── the frozen figures, SUMMED. No deduction is computed here. ────────────
  select coalesce(sum(s.cis_gross_payment), 0), coalesce(sum(s.materials_total), 0),
         coalesce(sum(s.cis_deduction), 0), count(*),
         array_agg(distinct s.deduction_rate), array_agg(distinct s.cis_status),
         -- The identity fields come from the LATEST payment in the month: they
         -- are the most recent record of who this subcontractor was when paid.
         (array_agg(s.legal_name order by p.paid_at desc, s.payment_id desc))[1],
         (array_agg(s.utr_masked order by p.paid_at desc, s.payment_id desc))[1]
    into v_gross, v_mat, v_ded, v_n, v_rates, v_statuses, v_sub_name, v_utr_masked
    from public.cis_payment_snapshots s
    join public.supplier_payments p on p.id = s.payment_id
   where s.org_id = p_org_id and s.payment_id = any(v_ids);

  if coalesce(v_n, 0) = 0 then
    raise exception
      'there are no live CIS payments to this subcontractor in the tax month ending % — a statement is only required for a month in which a payment was made',
      p_tax_month_end using errcode = 'check_violation';
  end if;

  v_uniform := array_length(v_rates, 1) = 1 and array_length(v_statuses, 1) = 1;
  v_rate    := case when v_uniform then v_rates[1] else null end;
  v_status  := case when v_uniform then v_statuses[1] else null end;

  -- CISR12160: the verification number belongs on the statement ONLY where the
  -- subcontractor could not be verified and the HIGHER rate was applied. Both
  -- 'higher_30' (unmatched) and 'failed' (a recorded unmatched result) are that
  -- case. If ANY payment in the month was at the higher rate, the statement
  -- needs the number.
  v_ver_required := exists (
    select 1 from unnest(v_statuses) st where st in ('higher_30', 'failed')
  );

  -- The number itself, taken from the frozen snapshot of a higher-rate payment.
  -- NULL when none is held — that is a real, representable answer and the
  -- document prints it in words. NOTHING here derives or fabricates a number.
  select s.verification_reference into v_ver
    from public.cis_payment_snapshots s
    join public.supplier_payments p on p.id = s.payment_id
   where s.org_id = p_org_id
     and s.payment_id = any(v_ids)
     and s.cis_status in ('higher_30', 'failed')
     and s.verification_reference is not null
   order by p.paid_at desc, s.payment_id desc
   limit 1;

  v_fingerprint := public.cis_statement_ledger_fingerprint(p_org_id, p_supplier_id, p_tax_month_end);

  -- ── supersede the statement this one replaces ─────────────────────────────
  select id into v_prev
    from public.cis_statements
   where org_id = p_org_id and supplier_id = p_supplier_id
     and tax_month_end = p_tax_month_end and status = 'issued'
   for update;

  if found then
    update public.cis_statements
       set status = 'superseded', superseded_at = now(), superseded_by = auth.uid()
     where id = v_prev;
  end if;

  -- ── the per-org statement number ──────────────────────────────────────────
  -- Serialised by the advisory lock below; the unique constraints are the
  -- backstop. Sequence is per ORG so it reads as a register of issued documents.
  perform pg_advisory_xact_lock(hashtext('cis_statement_number'), hashtext(p_org_id::text));
  select coalesce(max(sequence_no), 0) + 1 into v_seq
    from public.cis_statements where org_id = p_org_id;
  v_number := 'CIS-' || to_char(p_tax_month_end, 'YYYY-MM') || '-' || lpad(v_seq::text, 4, '0');

  -- Canonical content digest. Field order is fixed and every field the document
  -- shows is included, so any change to what was issued changes the hash.
  v_hash := encode(extensions.digest(
    concat_ws('|',
      'cis-statement-v1',
      p_org_id::text, p_supplier_id::text,
      v_start::text, p_tax_month_end::text,
      v_c_name, v_c_paye,
      v_sub_name, coalesce(v_utr_masked, ''),
      case when v_ver_required then 'ver-required' else 'ver-not-required' end,
      coalesce(v_ver, ''),
      v_gross::text, v_mat::text, v_ded::text, v_n::text,
      coalesce(v_rate::text, 'mixed'), coalesce(v_status, 'mixed'),
      v_fingerprint
    ), 'sha256'), 'hex');

  insert into public.cis_statements (
    org_id, supplier_id, statement_number, sequence_no,
    tax_month_start, tax_month_end,
    contractor_name, contractor_paye_reference,
    subcontractor_name, subcontractor_utr_masked,
    verification_number_required, verification_number,
    gross_amount, materials_amount, deduction_amount, payment_count,
    rate_is_uniform, deduction_rate, cis_status, is_statutory,
    content_hash, ledger_fingerprint, status, issued_by, supersedes_id
  ) values (
    p_org_id, p_supplier_id, v_number, v_seq,
    v_start, p_tax_month_end,
    v_c_name, v_c_paye,
    v_sub_name, v_utr_masked,
    v_ver_required, v_ver,
    v_gross, v_mat, v_ded, v_n,
    v_uniform, v_rate, v_status, v_ded > 0,
    v_hash, v_fingerprint, 'issued', auth.uid(), v_prev
  ) returning id into v_id;

  -- Provenance: the exact payments summarised, with their frozen figures.
  insert into public.cis_statement_payments (
    org_id, statement_id, payment_id, supplier_id, paid_on,
    cis_gross_payment, materials_total, cis_deduction, deduction_rate, cis_status
  )
  select p_org_id, v_id, s.payment_id, p_supplier_id, p.paid_at,
         s.cis_gross_payment, s.materials_total, s.cis_deduction,
         s.deduction_rate, s.cis_status
    from public.cis_payment_snapshots s
    join public.supplier_payments p on p.id = s.payment_id
   where s.org_id = p_org_id and s.payment_id = any(v_ids);

  return v_id;
end $$;

grant execute on function public.issue_cis_statement(uuid, uuid, date) to authenticated;

comment on function public.issue_cis_statement(uuid, uuid, date) is
  'Issue (or reissue) a payment and deduction statement for one subcontractor and '
  'one CIS tax month. Every figure is a SUM of M3''s frozen snapshots — no '
  'deduction is computed. Reissuing supersedes the previous statement rather than '
  'editing it. Refuses without a contractor PAYE reference on file, and refuses a '
  'month with no live payments.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. withdraw_cis_statement — the close-out when there is nothing to reissue
-- ═══════════════════════════════════════════════════════════════════════════
-- When every payment a statement covered has been voided, reissue is impossible
-- (there is nothing to state) and silently deleting it would erase a document
-- the subcontractor holds. Withdrawal keeps the record, records who withdrew it
-- and why, and marks it as no longer to be relied on.
create or replace function public.withdraw_cis_statement(
  p_org_id uuid, p_statement_id uuid, p_reason text
) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if p_org_id is null or not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can withdraw a CIS statement'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a withdrawal must say why — the subcontractor holds this document'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.cis_statements
     set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(),
         withdraw_reason = left(trim(p_reason), 500)
   where id = p_statement_id and org_id = p_org_id and status = 'issued';

  if not found then
    raise exception 'no issued statement % to withdraw', p_statement_id
      using errcode = 'check_violation';
  end if;
end $$;

grant execute on function public.withdraw_cis_statement(uuid, uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. prepare_cis_monthly_return — the CIS300 dataset. STILL NOT FILED.
-- ═══════════════════════════════════════════════════════════════════════════
-- Assembles and freezes the figures for one tax month, INCLUDING the nil case.
-- It sends nothing anywhere. The only side effects are rows in this database.
create or replace function public.prepare_cis_monthly_return(
  p_org_id uuid, p_tax_month_end date
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id      uuid;
  v_prev    uuid;
  v_start   date;
  v_c_name  text;
  v_c_paye  text;
  v_c_aor   text;
  v_gross   numeric(12, 2) := 0;
  v_mat     numeric(12, 2) := 0;
  v_ded     numeric(12, 2) := 0;
  v_pay     integer := 0;
  v_subs    integer := 0;
  v_hash    text;
  v_finger  text;
  v_ids     uuid[];
begin
  if p_org_id is null or not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can prepare a CIS monthly return'
      using errcode = 'insufficient_privilege';
  end if;
  if p_tax_month_end is null or p_tax_month_end <> public.cis_tax_month_end(p_tax_month_end) then
    raise exception
      'a CIS return covers a tax month, which always ends on the 5th — % is not a tax month end',
      p_tax_month_end using errcode = 'invalid_parameter_value';
  end if;
  v_start := public.cis_tax_month_start(p_tax_month_end);

  perform pg_advisory_xact_lock(
    hashtext('cis_monthly_return'), hashtext(p_org_id::text || ':' || p_tax_month_end::text)
  );

  select legal_name, employer_paye_reference, accounts_office_reference
    into v_c_name, v_c_paye, v_c_aor
    from public.cis_contractor_profiles where org_id = p_org_id;
  if not found then
    raise exception
      'your CIS contractor details are not set up — a monthly return needs your name and employer PAYE reference'
      using errcode = 'check_violation';
  end if;

  -- Supersede the previous preparation for this month rather than overwrite it,
  -- so "what did we prepare, and when" stays answerable after the ledger moves.
  select id into v_prev
    from public.cis_monthly_returns
   where org_id = p_org_id and tax_month_end = p_tax_month_end and superseded_at is null
   for update;
  if found then
    update public.cis_monthly_returns
       set superseded_at = now(), superseded_by = auth.uid()
     where id = v_prev;
  end if;

  -- ── THE COVERED SET, PINNED ONCE ──────────────────────────────────────────
  -- Same discipline as issue_cis_statement, and for the same reason: the header
  -- totals and the per-subcontractor lines are written by two statements, and
  -- they MUST agree (the deferred reconciliation trigger refuses the transaction
  -- otherwise). Deriving both from one pinned array of payment ids makes that
  -- agreement structural instead of a race that usually goes the right way.
  --
  -- An empty array is the NIL RETURN and is entirely legitimate — the month is
  -- still reportable. It is handled by the same code path, not a special case.
  select coalesce(array_agg(s.payment_id order by s.payment_id), '{}') into v_ids
    from public.cis_payment_snapshots s
    join public.supplier_payments p on p.id = s.payment_id
   where s.org_id = p_org_id
     and s.tax_month_end = p_tax_month_end
     and p.voided_at is null;

  -- Grand totals over the per-subcontractor aggregate. The FINGERPRINT is taken
  -- from the shared function rather than recomputed here, so the value stored on
  -- the return is by construction the same value a later staleness check
  -- produces — there is one algorithm, not two that must be kept in step.
  v_finger := public.cis_monthly_return_ledger_fingerprint(p_org_id, p_tax_month_end);

  select coalesce(count(*), 0)::integer,
         coalesce(sum(x.payments), 0)::integer,
         coalesce(sum(x.gross), 0),
         coalesce(sum(x.materials), 0),
         coalesce(sum(x.deduction), 0)
    into v_subs, v_pay, v_gross, v_mat, v_ded
    from (
      select s.supplier_id,
             sum(s.cis_gross_payment) as gross,
             sum(s.materials_total)   as materials,
             sum(s.cis_deduction)     as deduction,
             count(*)                 as payments
        from public.cis_payment_snapshots s
       where s.org_id = p_org_id and s.payment_id = any(v_ids)
       group by s.supplier_id
    ) x;

  v_hash := encode(extensions.digest(
    concat_ws('|', 'cis-monthly-return-v1', p_org_id::text,
      v_start::text, p_tax_month_end::text, v_c_name, v_c_paye,
      (v_subs = 0)::text, v_subs::text, v_pay::text,
      v_gross::text, v_mat::text, v_ded::text, v_finger),
    'sha256'), 'hex');

  insert into public.cis_monthly_returns (
    org_id, tax_month_start, tax_month_end,
    contractor_name, contractor_paye_reference, accounts_office_reference,
    is_nil, subcontractor_count, payment_count,
    total_gross, total_materials, total_deduction,
    status, ledger_fingerprint, content_hash, prepared_by, supersedes_id
  ) values (
    p_org_id, v_start, p_tax_month_end,
    v_c_name, v_c_paye, v_c_aor,
    (v_subs = 0), v_subs, v_pay, v_gross, v_mat, v_ded,
    'prepared', v_finger, v_hash, auth.uid(), v_prev
  ) returning id into v_id;

  -- ── one line per subcontractor (HMRC: one entry each, combined totals) ────
  -- Every per-line scalar is computed inside the aggregate, so a subcontractor
  -- re-verified mid-month yields ONE line that honestly reports its rate as
  -- non-uniform rather than picking one of the two or averaging them.
  insert into public.cis_monthly_return_lines (
    org_id, return_id, supplier_id,
    subcontractor_name, subcontractor_utr_masked,
    verification_number, verification_number_required,
    rate_is_uniform, deduction_rate, cis_status,
    gross_amount, materials_amount, deduction_amount, payment_count
  )
  select p_org_id, v_id, s.supplier_id,
         (array_agg(s.legal_name order by p.paid_at desc, s.payment_id desc))[1],
         (array_agg(s.utr_masked order by p.paid_at desc, s.payment_id desc))[1],
         -- Copied from a higher-rate payment's frozen snapshot, or NULL. Never
         -- invented — see the statement RPC for the full reasoning.
         (array_agg(s.verification_reference order by p.paid_at desc, s.payment_id desc)
            filter (where s.cis_status in ('higher_30', 'failed')
                      and s.verification_reference is not null))[1],
         bool_or(s.cis_status in ('higher_30', 'failed')),
         (count(distinct s.deduction_rate) = 1 and count(distinct s.cis_status) = 1),
         case when count(distinct s.deduction_rate) = 1
                   and count(distinct s.cis_status) = 1
              then min(s.deduction_rate) end,
         case when count(distinct s.deduction_rate) = 1
                   and count(distinct s.cis_status) = 1
              then min(s.cis_status) end,
         sum(s.cis_gross_payment), sum(s.materials_total), sum(s.cis_deduction),
         count(*)::integer
    from public.cis_payment_snapshots s
    join public.supplier_payments p on p.id = s.payment_id
   where s.org_id = p_org_id and s.payment_id = any(v_ids)
   group by s.supplier_id;

  return v_id;
end $$;

grant execute on function public.prepare_cis_monthly_return(uuid, date) to authenticated;

comment on function public.prepare_cis_monthly_return(uuid, date) is
  'Assemble and FREEZE the CIS300-shape dataset for one tax month. Creates a real '
  'row for a payment-free month (is_nil = true), because a nil return is itself '
  'reportable. FILES NOTHING — there is no HMRC integration anywhere in CrewFlow. '
  'Re-preparing supersedes the previous preparation.';

-- NOTE ON WRITE SHAPE. `prepare_cis_monthly_return` inserts the header with its
-- FINAL totals and never updates it, so the immutability guard above needs no
-- exemption window and the DEFERRED reconciliation trigger sees the row exactly
-- as it will be committed. An earlier draft of this migration inserted
-- placeholder zeros and corrected them afterwards; that is unsound, because a
-- deferred AFTER INSERT trigger re-reads the tuple version it was queued
-- against, so it would have reconciled the PLACEHOLDERS against the real lines
-- and failed every preparation. Do not reintroduce that shape.


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. mark_cis_monthly_return_exported — records OUR act, not HMRC's
-- ═══════════════════════════════════════════════════════════════════════════
-- "Exported" means the operator downloaded the figures from CrewFlow. It says
-- nothing whatsoever about whether they were filed, and must never be presented
-- as if it did.
create or replace function public.mark_cis_monthly_return_exported(
  p_org_id uuid, p_return_id uuid
) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if p_org_id is null or not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can export a CIS monthly return'
      using errcode = 'insufficient_privilege';
  end if;

  update public.cis_monthly_returns
     set status = 'exported', exported_at = now(), exported_by = auth.uid()
   where id = p_return_id and org_id = p_org_id
     and status = 'prepared' and superseded_at is null;

  if not found then
    raise exception 'no current prepared return % to mark as exported', p_return_id
      using errcode = 'check_violation';
  end if;
end $$;

grant execute on function public.mark_cis_monthly_return_exported(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13. RLS — ADMIN ONLY on every table
-- ═══════════════════════════════════════════════════════════════════════════
-- Same posture as CIS M1, M2 and M3, and for the same reason. These rows carry
-- tax identifiers (the org's own PAYE reference, subcontractors' masked UTRs and
-- verification numbers) and constitute the documents a subcontractor uses to
-- reclaim tax. A member of the same org gets ZERO rows, not a redacted row, and a
-- direct PostgREST caller bypassing the app is refused identically.
--
-- Note what this does NOT restrict: `finances` stays member-readable, so job
-- costs and profitability are unchanged for every member.
alter table public.cis_contractor_profiles   enable row level security;
alter table public.cis_statements            enable row level security;
alter table public.cis_statement_payments    enable row level security;
alter table public.cis_monthly_returns       enable row level security;
alter table public.cis_monthly_return_lines  enable row level security;

drop policy if exists "cis_contractor_profiles: admin all" on public.cis_contractor_profiles;
create policy "cis_contractor_profiles: admin all" on public.cis_contractor_profiles
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "cis_statements: admin all" on public.cis_statements;
create policy "cis_statements: admin all" on public.cis_statements
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "cis_statement_payments: admin all" on public.cis_statement_payments;
create policy "cis_statement_payments: admin all" on public.cis_statement_payments
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "cis_monthly_returns: admin all" on public.cis_monthly_returns;
create policy "cis_monthly_returns: admin all" on public.cis_monthly_returns
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "cis_monthly_return_lines: admin all" on public.cis_monthly_return_lines;
create policy "cis_monthly_return_lines: admin all" on public.cis_monthly_return_lines
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
