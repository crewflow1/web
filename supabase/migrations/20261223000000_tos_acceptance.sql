-- =====================================================================
-- 20261223000000_tos_acceptance.sql
--
-- Terms-of-Service acceptance persistence (platform/ops completion).
--
-- WHY ORG-LEVEL, NOT USER-LEVEL. The contracting party for CrewFlow is
-- the ORGANISATION (the company buying the product), not each individual
-- member: staff are invited into a workspace under their employer's
-- agreement and never see or accept the ToS themselves, so a per-user
-- stamp would be legally meaningless noise (rows asserting acceptance by
-- people who were never shown the terms). The owner who creates the org
-- accepts on the company's behalf by continuing through onboarding —
-- that person is recorded in tos_accepted_by. If a future ToS revision
-- requires re-acceptance, the flow compares tos_version against the
-- current constant (lib/legal/tos.ts) and re-prompts the OWNER — still
-- an org-level decision.
--
-- Columns (all nullable — a pre-launch org created outside onboarding,
-- e.g. seeded by HQ, may legitimately have no acceptance yet; the HQ
-- customer page shows that honestly as "—"):
--   tos_accepted_at  when the terms were accepted
--   tos_accepted_by  the user who accepted on the org's behalf. FK to
--                    public.users ON DELETE SET NULL — GDPR erasure of
--                    the person must not fabricate or destroy the org's
--                    acceptance fact, only anonymise who clicked.
--   tos_version      which terms were accepted ('2026-08' constant from
--                    lib/legal/tos.ts at stamping time)
--
-- BACKFILL — honest, not fabricated: existing orgs signed up while the
-- terms were presented but acceptance wasn't persisted. We stamp their
-- created_at as the acceptance time and version 'legacy' so nobody can
-- mistake a backfilled row for a recorded click on a specific version.
-- tos_accepted_by stays NULL for them (we genuinely don't know).
-- SCOPE: only orgs with at least one membership — an org with NO members
-- (a bare seeded shell) has nobody who could have accepted anything, so
-- stamping it would fabricate the very fact the header promises can stay
-- honestly NULL ("—" on the HQ customer page).
-- =====================================================================

alter table public.organizations
  add column if not exists tos_accepted_at timestamptz,
  add column if not exists tos_accepted_by uuid
    references public.users(id) on delete set null,
  add column if not exists tos_version text
    check (tos_version is null or (btrim(tos_version) <> '' and length(tos_version) <= 40));

comment on column public.organizations.tos_accepted_at is
  'When the organisation accepted the Terms of Service. Org-level: the '
  'org is the contracting party; members join under the employer''s '
  'agreement. Backfilled with created_at (version=''legacy'') for orgs '
  'that predate persistence.';
comment on column public.organizations.tos_accepted_by is
  'The user who accepted on the org''s behalf (the creating owner). NULL '
  'for backfilled/legacy rows or after that user''s erasure.';
comment on column public.organizations.tos_version is
  'The ToS version accepted (lib/legal/tos.ts CURRENT_TOS_VERSION at '
  'stamping time). ''legacy'' marks the migration backfill — an honest '
  '"accepted under whatever terms were live at signup", never a claim '
  'about a specific version.';

-- Backfill existing orgs (idempotent: only rows never stamped; membered
-- orgs only — see SCOPE above).
update public.organizations o
set tos_accepted_at = o.created_at,
    tos_version = 'legacy'
where o.tos_accepted_at is null
  and exists (select 1 from public.memberships m where m.org_id = o.id);
