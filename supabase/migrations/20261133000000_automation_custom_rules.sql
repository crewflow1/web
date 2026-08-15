-- Automation OS — per-org, no-code CUSTOM rules (the workflow builder).
--
-- WHAT THIS ADDS
-- --------------
-- The engine already has: a static built-in catalogue (lib/automation/rules.ts),
-- an event registry (lib/automation/events.ts), a concurrency-safe dispatcher
-- with an atomic claim + lease + per-action isolation + idempotent
-- (rule_id, correlation_id) telemetry (server/services/automation-dispatcher.ts),
-- per-org enable-state OVERRIDES of the catalogue (automation_rules, 20261096) and
-- time-triggered SCHEDULES (automation_schedules, 20261096). What it LACKED was any
-- way for a tenant to AUTHOR their own rule: a trigger + condition(s) + action(s)
-- of their choosing, optionally gated behind a human approval.
--
--   automation_custom_rules — a per-org, user-composed rule. It carries the same
--     three shapes the built-in catalogue has (trigger, ordered actions) PLUS what
--     the catalogue cannot express: a condition tree (field/operator/value with
--     AND/OR groups) and an optional approval gate. The dispatcher loads these
--     ALONGSIDE the built-in catalogue for the event's org, so both fire from the
--     same producers with the same idempotency — a custom rule is not a second
--     engine, it is more rows the one engine evaluates.
--
-- WHY jsonb `definition`, NOT a wide column set
-- --------------------------------------------
-- A no-code rule is a small tree (conditions nest; actions carry per-type params).
-- Modelling it as columns would force a migration on every new operator or action
-- param. The tree lives in `definition` jsonb and is validated in code by a Zod
-- schema (lib/automation/custom-rules.ts) on EVERY write and re-validated on read
-- before dispatch. That schema is the injection boundary: params are DATA only —
-- whitelisted keys, bounded strings, enum values — never identifiers, table names,
-- SQL, or free-form recipients. The DB stores the tree; the code is the gate.
--
-- `trigger_event` IS A TOP-LEVEL COLUMN (not inside the jsonb) because the
-- dispatcher looks rules up by (org_id, trigger_event) on the hot path — it must be
-- indexable. It is free text validated in code against AUTOMATION_EVENT_TYPES
-- (the rule_key doctrine from 20261096: the catalogue lives in code and evolves
-- with code, so a CHECK enumerating event ids would force a migration per change).
--
-- TENANCY IS STRUCTURAL — THE #456 LEAK CLASS
-- -------------------------------------------
-- Org-pinned, cascade-on-org-delete, composite candidate key. Every dispatch the
-- engine performs off one of these rows carries THIS row's org_id as the event's
-- org context, and every wired action pins event.org_id — so a custom rule can
-- only ever act inside its own organisation.
--
-- RLS — MEMBER-READ, ADMIN-WRITE (the expense_budgets / automation_rules rule)
-- ---------------------------------------------------------------------------
-- Every member may SEE the org's automations; only an admin may author/change
-- them. DB-enforced, not app-only.
--
-- Additive + idempotent. Reversible: drop table public.automation_custom_rules;

create table if not exists public.automation_custom_rules (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- Human label + optional description shown in Settings → Automations.
  name          text not null check (length(btrim(name)) > 0 and length(name) <= 120),
  description   text check (description is null or length(description) <= 500),
  -- The event type that fires this rule (an AUTOMATION_EVENT_TYPES id). Free text,
  -- validated in code; indexed for the dispatcher's per-org lookup.
  trigger_event text not null check (length(btrim(trigger_event)) > 0),
  -- The rule tree: { conditions, actions[], requiresApproval, approvalPosition }.
  -- Validated by lib/automation/custom-rules.ts on every write, re-validated on
  -- read before dispatch. The empty default is an inert rule (no actions → no-op).
  definition    jsonb not null default '{}'::jsonb,
  enabled       boolean not null default true,
  created_by    uuid references public.users(id) on delete set null,
  updated_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Composite candidate key for any future child (the house additive idiom).
  constraint automation_custom_rules_id_org_key unique (id, org_id)
);

create index if not exists automation_custom_rules_org_idx
  on public.automation_custom_rules (org_id);
-- The dispatcher's hot path: "every enabled custom rule for this org + trigger".
-- Partial on enabled so disabled rules are skipped by the index entirely.
create index if not exists automation_custom_rules_dispatch_idx
  on public.automation_custom_rules (org_id, trigger_event)
  where enabled;

drop trigger if exists automation_custom_rules_set_updated_at on public.automation_custom_rules;
create trigger automation_custom_rules_set_updated_at before update on public.automation_custom_rules
  for each row execute function public.tg_set_updated_at();

alter table public.automation_custom_rules enable row level security;

drop policy if exists "automation_custom_rules: members can select" on public.automation_custom_rules;
create policy "automation_custom_rules: members can select" on public.automation_custom_rules
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "automation_custom_rules: admins can insert" on public.automation_custom_rules;
create policy "automation_custom_rules: admins can insert" on public.automation_custom_rules
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "automation_custom_rules: admins can update" on public.automation_custom_rules;
create policy "automation_custom_rules: admins can update" on public.automation_custom_rules
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "automation_custom_rules: admins can delete" on public.automation_custom_rules;
create policy "automation_custom_rules: admins can delete" on public.automation_custom_rules
  for delete to authenticated using (public.is_org_admin(org_id));
