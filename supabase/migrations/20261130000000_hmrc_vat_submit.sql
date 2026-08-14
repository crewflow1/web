-- HMRC MTD VAT — the SUBMIT pipeline state machine + receipt columns. DARK.
--
-- WHAT THIS IS. The 20261099 substrate stopped at "prepared/held": it composed
-- and froze the exact 9-box payload a recognised submission would carry, but had
-- NO code path that POSTed it and NO terminal status. This migration adds the
-- missing half — the ability to ADVANCE a prepared return through an actual HMRC
-- submission and record HMRC's receipt (or its rejection) — while keeping the
-- whole thing DARK / recognition-gated.
--
-- ── LEGAL / RECOGNITION BOUNDARY (why this is still dark) ────────────────────
-- HMRC rejects a VAT submission from software it has not RECOGNISED (a legal /
-- commercial vendor-recognition gate + fraud-prevention-header conformance). The
-- submit code (lib/integrations/hmrc/vat-submit.ts + server/services/hmrc-submit.ts)
-- REFUSES before any network call unless HMRC is connectable — client credentials
-- present AND NEXT_PUBLIC_FEATURE_HMRC_CONNECT on (two-switch), which is NEVER
-- today. This migration only carves the columns + widens the status enum; it
-- writes nothing and opens no path on its own. Activation = creds + flag + HMRC
-- recognition (all external / config), no further schema change.
--
-- ── THE STATE MACHINE ───────────────────────────────────────────────────────
-- hmrc_submissions.status gains three post-prepare states:
--   prepared / held  → the frozen record, nothing sent (existing).
--   submitting       → CLAIMED for submission (an in-flight POST). The claim is
--                      an atomic guarded UPDATE (prepared|held → submitting) so
--                      two concurrent submits cannot both proceed — the idempotency
--                      guard that makes a double-submit of one period impossible.
--   submitted        → sent, awaiting HMRC's terminal answer (reserved; MTD VAT
--                      answers synchronously, but the value exists for async APIs).
--   accepted         → HMRC accepted the return; the receipt columns are populated.
--   rejected         → HMRC refused the return (business validation); submit_error
--                      holds the reason. A transient failure does NOT land here —
--                      it reverts submitting → prepared so the period stays retriable.
--
-- ── WHO MAY TRANSITION (append-only for tenants is PRESERVED) ────────────────
-- 20261099 gave hmrc_submissions member-SELECT + admin-INSERT and DELIBERATELY no
-- UPDATE/DELETE policy, so a prepared record is immutable to every tenant caller.
-- That is UNCHANGED here: no UPDATE policy is added. The status transitions are
-- performed ONLY by the service-role submit orchestrator (server/services/
-- hmrc-submit.ts), which bypasses RLS — the SAME pattern the calendar/accounting
-- token stores use for their service-role writes. A tenant JWT still cannot mutate
-- a submission; the statutory audit trail stays un-rewritable by users.
--
-- ── RECEIPT COLUMNS ARE NOT SECRETS ─────────────────────────────────────────
-- processing date / form-bundle number / charge reference / payment indicator are
-- the org's OWN filing receipt — the same class as the payload members already
-- read. So NO column privilege is carved (unlike the token columns on
-- hmrc_connections): members keep full SELECT on hmrc_submissions.
--
-- Additive and reversible. To roll back:
--   alter table public.hmrc_submissions
--     drop column submitted_at, drop column submitted_by,
--     drop column hmrc_processing_date, drop column hmrc_form_bundle_number,
--     drop column hmrc_charge_ref_number, drop column hmrc_payment_indicator,
--     drop column submit_error;
--   -- and restore the status check to ('prepared','held').

-- ── new receipt / provenance columns ─────────────────────────────────────────
alter table public.hmrc_submissions
  add column if not exists submitted_at            timestamptz,
  add column if not exists submitted_by            uuid references public.users(id) on delete set null,
  add column if not exists hmrc_processing_date    timestamptz,
  add column if not exists hmrc_form_bundle_number text,
  add column if not exists hmrc_charge_ref_number  text,
  add column if not exists hmrc_payment_indicator  text,
  add column if not exists submit_error            text;

-- ── widen the status enum to include the submit lifecycle ─────────────────────
-- Drop the original inline CHECK (Postgres names an unnamed column check
-- `<table>_<column>_check`) defensively: a DO block finds and drops ANY check
-- constraint on the table whose definition still restricts status to the old set,
-- so a differently-named constraint cannot block the widen. Idempotent under
-- `supabase db reset` (the new constraint is dropped-if-exists then re-added).
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.hmrc_submissions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
      and pg_get_constraintdef(oid) ilike '%prepared%'
      and pg_get_constraintdef(oid) not ilike '%submitting%'
  loop
    execute format('alter table public.hmrc_submissions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.hmrc_submissions
  drop constraint if exists hmrc_submissions_status_check;
alter table public.hmrc_submissions
  add constraint hmrc_submissions_status_check
  check (status in ('prepared', 'held', 'submitting', 'submitted', 'accepted', 'rejected'));

-- A receipt (form-bundle number) can only exist on a return HMRC actually
-- accepted — the DB refuses a stray form-bundle number on a non-accepted row, so
-- an "accepted" state cannot be faked by writing a receipt onto a prepared row.
alter table public.hmrc_submissions
  drop constraint if exists hmrc_submissions_receipt_needs_accepted;
alter table public.hmrc_submissions
  add constraint hmrc_submissions_receipt_needs_accepted
  check (hmrc_form_bundle_number is null or status = 'accepted');
