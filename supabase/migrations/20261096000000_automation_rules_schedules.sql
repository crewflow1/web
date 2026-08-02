-- Automation OS — per-org rule overrides + time-triggered schedules.
--
-- WHAT THIS ADDS, AND WHY IT IS TWO TABLES
-- ----------------------------------------
-- The automation engine already exists: a static catalogue of built-in rules
-- (lib/automation/rules.ts), an event registry (lib/automation/events.ts), and
-- a concurrency-safe dispatcher with an atomic claim + lease + per-action
-- isolation + idempotent (rule_id, correlation_id) telemetry
-- (server/services/automation-dispatcher.ts, table 20260621/20260912). What it
-- LACKED was any per-org control: the catalogue's `enabled` flag was hardcoded,
-- so "disable a rule for this one org" meant editing code and shipping, and
-- there was no way to fire a rule on a CLOCK rather than a domain event.
--
--   automation_rules      — a per-org OVERRIDE of a catalogue rule's enabled
--                           state. The static catalogue is the DEFAULT/seed; a
--                           row here overrides enabled-state for ONE org only.
--                           No row → the catalogue default stands (so this table
--                           is empty for every org until someone toggles a rule,
--                           and the engine behaves exactly as before).
--   automation_schedules  — a TIME-triggered rule: a cron expression whose due
--                           occurrences the drain cron dispatches, org-scoped,
--                           through the SAME dispatcher (same claim/idempotency).
--
-- TENANCY IS STRUCTURAL — THE #456 LEAK CLASS
-- -------------------------------------------
-- Both tables are org-pinned, and every dispatch the engine performs off a row
-- here carries that row's org_id as the event's org context. A rule or schedule
-- can therefore only ever act WITHIN its own organisation — the dispatcher pins
-- its override lookup and every wired action to `event.org_id`, so a schedule in
-- org A can never reach into org B. RLS is the OUTER boundary; the org pin the
-- engine applies is the scope.
--
-- RLS POSTURE — MEMBER-READ, ADMIN-WRITE (the expense_budgets / job_budgets rule)
-- -----------------------------------------------------------------------------
-- Configuring automations is an admin act: every member may READ which rules and
-- schedules are on (the whole team sees the org's automation posture), but only
-- an admin may CHANGE them. DB-enforced, not app-only: an app-only gate would
-- leave /rest/v1/automation_rules open to any member holding a JWT.
--
-- rule_key IS FREE TEXT, VALIDATED IN CODE — NOT A DB CHECK
-- --------------------------------------------------------
-- `rule_key` references a catalogue rule id, but the catalogue lives in code and
-- evolves with code. A CHECK constraint enumerating the ids would force a
-- migration on every catalogue change and could silently reject a rule the code
-- already knows about. The service layer (server/services/automation-rules.ts)
-- validates `rule_key` against AUTOMATION_RULES before any write, and an override
-- for an unknown key is simply ignored on read (merged only against known rules).
-- This is additive and forward-compatible, deliberately.
--
-- Additive + idempotent throughout (create table if not exists / drop policy if
-- exists → create). Reversible:
--   drop table public.automation_schedules;
--   drop table public.automation_rules;

-- ── 1. automation_rules — per-org override of a catalogue rule's enabled state ─
create table if not exists public.automation_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  -- The catalogue rule id this row overrides (lib/automation/rules.ts). Free
  -- text; validated in the service layer against the code catalogue.
  rule_key    text not null check (length(btrim(rule_key)) > 0),
  -- The override. When a row exists, THIS value wins over the catalogue default;
  -- when absent, the catalogue default stands.
  enabled     boolean not null default true,
  updated_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- ONE override per (org, rule). A toggle UPDATEs the existing row (the service
  -- upserts on this key), so there is never a coin-flip over which override wins.
  constraint automation_rules_org_rule_uniq unique (org_id, rule_key),
  -- Composite candidate key for any future child (the house additive idiom).
  constraint automation_rules_id_org_key unique (id, org_id)
);

create index if not exists automation_rules_org_idx
  on public.automation_rules (org_id);

drop trigger if exists automation_rules_set_updated_at on public.automation_rules;
create trigger automation_rules_set_updated_at before update on public.automation_rules
  for each row execute function public.tg_set_updated_at();

alter table public.automation_rules enable row level security;

drop policy if exists "automation_rules: members can select" on public.automation_rules;
create policy "automation_rules: members can select" on public.automation_rules
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "automation_rules: admins can insert" on public.automation_rules;
create policy "automation_rules: admins can insert" on public.automation_rules
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "automation_rules: admins can update" on public.automation_rules;
create policy "automation_rules: admins can update" on public.automation_rules
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "automation_rules: admins can delete" on public.automation_rules;
create policy "automation_rules: admins can delete" on public.automation_rules
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── 2. automation_schedules — a time-triggered rule ──────────────────────────
create table if not exists public.automation_schedules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- The catalogue rule this schedule dispatches when due. Free text; validated
  -- in the service layer against the code catalogue.
  rule_key     text not null check (length(btrim(rule_key)) > 0),
  -- Standard 5-field cron expression (minute hour day-of-month month
  -- day-of-week), interpreted in UTC for determinism (no BST/GMT ambiguity).
  -- Parsed + validated by lib/automation/cron.ts before any write.
  cron_expr    text not null check (length(btrim(cron_expr)) > 0),
  enabled      boolean not null default true,
  -- The next UTC instant this schedule is due. Deterministically computed from
  -- cron_expr at create/edit time and advanced by the drain each time it fires.
  next_run_at  timestamptz not null,
  -- The last instant the drain actually dispatched this schedule. NULL until the
  -- first fire.
  last_run_at  timestamptz,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint automation_schedules_id_org_key unique (id, org_id)
);

-- The drain's hot path: "every enabled schedule whose next_run_at has passed".
-- Partial on enabled so the scan ignores paused schedules entirely.
create index if not exists automation_schedules_due_idx
  on public.automation_schedules (next_run_at)
  where enabled;
create index if not exists automation_schedules_org_idx
  on public.automation_schedules (org_id);

drop trigger if exists automation_schedules_set_updated_at on public.automation_schedules;
create trigger automation_schedules_set_updated_at before update on public.automation_schedules
  for each row execute function public.tg_set_updated_at();

alter table public.automation_schedules enable row level security;

drop policy if exists "automation_schedules: members can select" on public.automation_schedules;
create policy "automation_schedules: members can select" on public.automation_schedules
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "automation_schedules: admins can insert" on public.automation_schedules;
create policy "automation_schedules: admins can insert" on public.automation_schedules
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "automation_schedules: admins can update" on public.automation_schedules;
create policy "automation_schedules: admins can update" on public.automation_schedules
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "automation_schedules: admins can delete" on public.automation_schedules;
create policy "automation_schedules: admins can delete" on public.automation_schedules
  for delete to authenticated using (public.is_org_admin(org_id));
