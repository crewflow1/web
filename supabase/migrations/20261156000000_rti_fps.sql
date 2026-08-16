-- HMRC RTI — widen hmrc_submissions.kind to accept the FPS composer output. DARK.
--
-- WHAT THIS IS. The 20261099 substrate composed + froze VAT / CIS300 submission
-- payloads in hmrc_submissions (status prepared|held, NO filed state) and the
-- 20261130 migration added the VAT SUBMIT lifecycle. This migration adds RTI's
-- Full Payment Submission (FPS) to the SAME append-only, prepared/held store —
-- the only new thing is a third `kind` value, `fps`. The FPS composer
-- (lib/integrations/hmrc/rti-fps.ts) folds a finalised payroll run's stored
-- `payroll_lines` into the FPS payload; the prepare/hold writer
-- (server/services/hmrc-connections.ts prepareFpsReturn) freezes it here. There
-- is NO code path that POSTs an FPS to HMRC.
--
-- ── LEGAL / RECOGNITION BOUNDARY (why this stays dark) ───────────────────────
-- RTI filing requires HMRC to RECOGNISE the software (a legal / commercial
-- vendor-recognition gate + fraud-prevention-header conformance), which is not in
-- place. The composer REFUSES to build unless HMRC is connectable
-- (NEXT_PUBLIC_FEATURE_HMRC_CONNECT + client credentials — a two-switch that is
-- NEVER on today), except for the internal prepare/hold path which never leaves
-- CrewFlow. This migration only widens a CHECK; it writes nothing and opens no
-- transmission path on its own. Activation is external config, no further schema.
--
-- ── APPEND-ONLY IS PRESERVED (no new policy) ────────────────────────────────
-- 20261099 gave hmrc_submissions member-SELECT + admin-INSERT and DELIBERATELY no
-- UPDATE/DELETE policy, so a prepared record is immutable to every tenant caller.
-- That is UNCHANGED here — this migration adds NO policy and creates NO table, so
-- an FPS record inherits the exact same tenancy, RLS and append-only immutability
-- as the VAT/CIS records it now sits alongside.
--
-- Additive and reversible. To roll back:
--   alter table public.hmrc_submissions
--     drop constraint if exists hmrc_submissions_kind_check;
--   alter table public.hmrc_submissions
--     add constraint hmrc_submissions_kind_check
--     check (kind in ('vat_return', 'cis300'));

-- ── widen the kind CHECK to include 'fps' ────────────────────────────────────
-- Drop the original inline CHECK defensively: a DO block finds and drops ANY
-- check constraint on the table whose definition still restricts kind to the old
-- set (a differently-named constraint cannot block the widen). Idempotent under
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
      and pg_get_constraintdef(oid) ilike '%kind%'
      and pg_get_constraintdef(oid) ilike '%vat_return%'
      and pg_get_constraintdef(oid) not ilike '%fps%'
  loop
    execute format('alter table public.hmrc_submissions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.hmrc_submissions
  drop constraint if exists hmrc_submissions_kind_check;
alter table public.hmrc_submissions
  add constraint hmrc_submissions_kind_check
  check (kind in ('vat_return', 'cis300', 'fps'));
