-- Accounting export log — an APPEND-ONLY record of every accounting export an
-- org generates or attempts, and the evidence half of the Phase 5 "Xero /
-- QuickBooks / accounting export" integration.
--
-- WHAT THIS IS. Each time an admin exports the org's finance rows for
-- bookkeeping — a CSV download today, a Xero / QuickBooks API push once their
-- OAuth is configured — one row lands here recording WHAT was exported (the
-- period), HOW (the format), HOW MUCH (the canonical row count) and the
-- OUTCOME. It is the audit trail an accountant or an admin consults to answer
-- "did we already export July, and how".
--
-- ── THE DARK-PROVIDER OUTCOME ────────────────────────────────────────────────
-- `status = 'skipped_dark'` is a first-class outcome, not an error. The Xero /
-- QuickBooks adapters are credential-gated seams (lib/integrations/accounting/
-- adapters): with no OAuth credentials they push NOTHING and report themselves
-- unavailable. When an admin asks for a provider push in that state, the action
-- records `skipped_dark` — an honest "we did not contact the provider because
-- it is not connected" — rather than a fake success or a hard failure. The CSV
-- path records `generated`; a live provider push (unreachable today) would
-- record `pushed`.
--
-- ── THIS TABLE HOLDS NO MONEY AND POSTS NOWHERE ─────────────────────────────
-- It is metadata about an export event: a period, a format, a count, an
-- outcome. There is NO amount column, NO trigger, and it never writes
-- `invoices`, `invoice_payments` or `finances`. An export is a read of the
-- finance ledger, so logging one can carry no double-count hazard.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the expense_budgets posture) ────
-- Org-pinned with a composite candidate key `(id, org_id)` for any future
-- child, exactly as 20261089 did. RLS mirrors org-level financial
-- configuration: every member may READ the export history so the team sees what
-- has been sent; only an admin may WRITE one, because generating/pushing an
-- export is an admin act. DB-enforced, not app-only — an app-only gate would
-- leave /rest/v1/accounting_export_log open to any member holding a JWT.
--
-- APPEND-ONLY. There is deliberately NO update policy and NO delete policy: a
-- log entry is evidence, so it is not editable and not targeted-deletable. It
-- disappears only with its org (ON DELETE CASCADE), which keeps teardown safe
-- and adds no AFTER DELETE activity trigger (the 20261052 org-teardown rule).
--
-- Additive and reversible. To roll back:
--   drop table public.accounting_export_log;
-- Migrate-first safe: every surface reads this table best-effort; absent -> no
-- history, and the export UI still functions (the CSV path needs no log to run).

-- ── accounting_export_log ────────────────────────────────────────────────────
create table if not exists public.accounting_export_log (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- The finance period exported. Nullable: an "everything to date" export has
  -- no lower bound, and a caller may leave either edge open.
  period_start date,
  period_end   date,
  -- WHICH export path produced this row. The canonical CSV, or a provider push.
  format       text not null check (format in ('csv', 'xero', 'quickbooks')),
  -- Canonical row count exported (invoices + payments). >= 0: an empty period
  -- is a legitimate export, not an error.
  row_count    integer not null default 0 check (row_count >= 0),
  -- OUTCOME. 'generated' = CSV produced; 'pushed' = a live provider accepted the
  -- rows (unreachable today); 'skipped_dark' = a provider push asked for while
  -- the adapter is credential-less, so nothing was sent.
  status       text not null check (status in ('generated', 'pushed', 'skipped_dark')),
  -- Free-text outcome note. Records a partial-export signal when a read hit the
  -- MAX_ROWS cap (the loud-reads doctrine: a truncated export is never silent),
  -- and is a general slot for future outcome detail. Nullable: most exports have
  -- nothing to note. Carries no money and posts nowhere.
  note         text,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  -- Composite-FK target for any future child (the 20261089 idiom).
  constraint accounting_export_log_id_org_key unique (id, org_id)
);

create index if not exists accounting_export_log_org_created_idx
  on public.accounting_export_log (org_id, created_at desc);

-- ── RLS — members read, admins write (org-level financial audit trail) ───────
alter table public.accounting_export_log enable row level security;

drop policy if exists "accounting_export_log: members can select" on public.accounting_export_log;
create policy "accounting_export_log: members can select" on public.accounting_export_log
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "accounting_export_log: admins can insert" on public.accounting_export_log;
create policy "accounting_export_log: admins can insert" on public.accounting_export_log
  for insert to authenticated with check (public.is_org_admin(org_id));

-- No update policy and no delete policy: an export-log row is append-only
-- evidence. It is removed only by org teardown (ON DELETE CASCADE above).
