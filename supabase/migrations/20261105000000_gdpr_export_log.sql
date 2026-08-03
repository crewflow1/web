-- GDPR data-portability EXPORT log — an APPEND-ONLY record of every data
-- export an org generates. The accountability half (GDPR Art. 5(2)) of the
-- data-subject / controller EXPORT capability.
--
-- ── SCOPE: EXPORT ONLY ───────────────────────────────────────────────────────
-- This table records that an org's OWN data was EXPORTED (read into a
-- downloadable archive). It has nothing to do with ERASURE. Subject erasure
-- (Art. 17) and org-teardown storage-orphan cleanup are a SEPARATE, legally-
-- gated capability that is NOT implemented in this migration or anywhere it
-- touches. The only `status` value is 'generated'; there is deliberately no
-- 'deleted'/'erased' outcome here.
--
-- ── WHAT THIS IS ─────────────────────────────────────────────────────────────
-- Each time an admin exports the org's data, one row lands here recording WHEN,
-- BY WHOM, in what FORMAT, HOW MANY tables/rows, and whether the export hit the
-- per-table cap (truncated). It is the audit trail a DPO/admin consults to
-- answer "who exported our data, and when".
--
-- ── THIS TABLE HOLDS NO MONEY, NO PII, NO SECRETS ────────────────────────────
-- It is metadata about an export event: a format, two counts, a boolean, an
-- optional note. There is NO amount column, NO trigger, and it never writes any
-- business table. It cannot itself be a data-leak vector.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the accounting_export_log posture)
-- Org-pinned with a composite candidate key `(id, org_id)` for any future
-- child. RLS: every member may READ the export history so the team sees what has
-- left the building; only an admin may WRITE one, because generating an export
-- is an admin act. DB-enforced, not app-only — an app-only gate would leave
-- /rest/v1/gdpr_export_log open to any member holding a JWT.
--
-- APPEND-ONLY. No update policy and no delete policy: an export-log row is
-- evidence, so it is not editable and not targeted-deletable. It disappears only
-- with its org (ON DELETE CASCADE), which keeps teardown safe and — critically —
-- adds NO AFTER DELETE activity trigger, honouring the 20261052 org-teardown
-- cascade rule (a child with both an activity trigger and cascade-to-org breaks
-- `delete from organizations`).
--
-- Additive and reversible. To roll back:
--   drop table public.gdpr_export_log;
-- Migrate-first safe: the export route writes this best-effort and never fails a
-- download over the log write, so an absent table simply means no history.

create table if not exists public.gdpr_export_log (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- WHICH archive shape produced this row.
  format       text not null check (format in ('zip', 'json')),
  -- How many tables the archive covered, and the total rows across them. >= 0:
  -- an empty org is a legitimate export, not an error.
  table_count  integer not null default 0 check (table_count >= 0),
  row_count    integer not null default 0 check (row_count >= 0),
  -- True when any table hit the per-table cap, so the archive omits rows the org
  -- holds (the loud-reads doctrine: a truncated export is never silent).
  truncated    boolean not null default false,
  -- OUTCOME. Only 'generated' today. There is intentionally NO erasure outcome:
  -- deletion is a separate legally-gated capability, not this table's concern.
  status       text not null default 'generated' check (status in ('generated')),
  -- Free-text outcome note (e.g. a truncation summary). Carries no money, no PII.
  note         text,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  -- Composite-FK target for any future child (the 20261089 / 20261093 idiom).
  constraint gdpr_export_log_id_org_key unique (id, org_id)
);

create index if not exists gdpr_export_log_org_created_idx
  on public.gdpr_export_log (org_id, created_at desc);

-- ── RLS — members read, admins write (org-level accountability trail) ────────
alter table public.gdpr_export_log enable row level security;

drop policy if exists "gdpr_export_log: members can select" on public.gdpr_export_log;
create policy "gdpr_export_log: members can select" on public.gdpr_export_log
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "gdpr_export_log: admins can insert" on public.gdpr_export_log;
create policy "gdpr_export_log: admins can insert" on public.gdpr_export_log
  for insert to authenticated with check (public.is_org_admin(org_id));

-- No update policy and no delete policy: a GDPR-export-log row is append-only
-- evidence. It is removed only by org teardown (ON DELETE CASCADE above), and it
-- carries no AFTER DELETE activity trigger (the 20261052 org-teardown rule).
