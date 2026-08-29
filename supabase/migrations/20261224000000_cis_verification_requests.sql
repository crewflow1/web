-- ═══════════════════════════════════════════════════════════════════════════
-- H2-CIS G5 — verification SOURCE provenance (dark HMRC verification adapter)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. G5 adds a DARK HMRC CIS verification adapter
-- (lib/integrations/hmrc/cis-verify.ts). The adapter records its outcome
-- through the EXACT same write authority the manual workflow uses
-- (server/services/cis.ts recordVerification) — one writer, one guard chain,
-- one rate derivation. What the row could not say until now is WHERE the
-- outcome came from: an admin typing in a result they obtained from HMRC
-- out-of-band, or the (future, activation-gated) HMRC online verification
-- call. For a tax record that provenance matters: an auditor asking "who told
-- you 20%?" gets a different answer for 'manual' than for 'hmrc_api'.
--
-- WHAT THIS IS NOT. No `cis_verification_requests` table is created despite
-- the filename reserving that workstream name. The audit trail for a
-- verification already exists three times over — the row's own
-- verified_at/verified_by/verification_reference, the bounded audit line
-- appended to `notes`, and the org-level admin activity log — and a parallel
-- request table would be a second source of truth for the same fact. The only
-- genuinely missing schema is the provenance column below.
--
-- SAFETY. Additive and instant: NOT NULL with a DEFAULT backfills existing
-- rows to 'manual', which is TRUE for every row that exists today (there has
-- never been another way to record a verification). The admin-only RLS policy
-- from 20261046000000 covers the new column automatically; no policy changes,
-- so the "last migration to define a cis_subcontractors policy" pin holds.
--
-- The value vocabulary is mirrored in lib/cis/types.ts
-- (CIS_VERIFICATION_SOURCES) — keep the two in sync.

alter table public.cis_subcontractors
  add column if not exists verification_source text not null default 'manual'
    constraint cis_subcontractors_verification_source_known
      check (verification_source in ('manual', 'hmrc_api'));

comment on column public.cis_subcontractors.verification_source is
  'Provenance of the CURRENT verification outcome: ''manual'' = an org admin '
  'verified with HMRC out-of-band (CIS online service / helpline) and typed '
  'the result in; ''hmrc_api'' = recorded by the HMRC online verification '
  'adapter (lib/integrations/hmrc/cis-verify.ts — DARK until HMRC credentials '
  '+ NEXT_PUBLIC_FEATURE_HMRC_CONNECT + vendor recognition). Written only by '
  'recordVerification (server/services/cis.ts), the single verification write '
  'authority.';
