-- CrewFlow HQ — AI Employee Framework, Phase 1 (CEO Directive 001).
--
-- FRAMEWORK ONLY. These tables describe a roster of "AI employees"
-- (CEO AI, CTO AI, Sales AI, …) so HQ operators can configure roles,
-- prompts, permissions, and review task/memory history. NOTHING here
-- wires up a model provider, telephony, or autonomous execution. The
-- model_provider / model_name columns are INERT configuration strings;
-- no code reads them to make an API call. permissions default to a
-- locked-down posture (can_execute=false, requires_approval=true).
--
-- Three tables:
--   public.ai_employees        — the roster + per-employee config
--   public.ai_employee_tasks   — task-history rows (manually authored)
--   public.ai_employee_memory  — structured memory entries
--
-- Crucial: HQ-only. RLS enabled, NO policies (service-role only), so
-- the customer/staff user-JWT client can never see or touch these
-- rows. Every read/write goes through HQ-side super-admin-gated server
-- actions / pages, mirroring public.internal_notes (HQ-9).

-- ---------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------

create table if not exists public.ai_employees (
  id              uuid primary key default gen_random_uuid(),

  name            text not null check (char_length(name) between 1 and 120),
  slug            text not null unique check (slug ~ '^[a-z0-9-]{1,60}$'),
  role            text not null check (char_length(role) between 1 and 200),

  department      text not null
                  check (department in (
                    'executive',
                    'engineering',
                    'sales',
                    'marketing',
                    'design',
                    'quality',
                    'documentation',
                    'product',
                    'finance',
                    'support',
                    'operations'
                  )),

  description     text not null default '' check (char_length(description) <= 4000),

  -- Presentation only. `icon` is a lucide-ish key the UI maps to a
  -- glyph; `accent` is a colour token for the card border/badge.
  icon            text not null default 'bot',
  accent          text not null default 'slate',

  status          text not null default 'idle'
                  check (status in (
                    'idle',
                    'working',
                    'waiting_approval',
                    'blocked',
                    'error',
                    'disabled'
                  )),

  -- Inert config. Stored so operators can plan provider/model choices.
  -- Never read to construct a live API call in Phase 1.
  model_provider  text check (model_provider is null or char_length(model_provider) <= 60),
  model_name      text check (model_name is null or char_length(model_name) <= 120),

  system_prompt   text not null default '' check (char_length(system_prompt) <= 20000),

  -- Capability *labels* only — no executor is wired to them.
  tools_allowed   text[] not null default '{}',

  -- Locked-down by default. Shape (Phase 1):
  --   { "can_execute": false, "requires_approval": true,
  --     "scopes": ["read"] }
  permissions     jsonb not null default
                  '{"can_execute": false, "requires_approval": true, "scopes": ["read"]}'::jsonb,

  memory_scope    text not null default 'isolated'
                  check (memory_scope in (
                    'isolated',
                    'department',
                    'organization',
                    'global'
                  )),

  current_task    text check (current_task is null or char_length(current_task) <= 500),
  last_activity_at timestamp with time zone,

  -- Drives the deterministic boardroom ordering (CEO first, …).
  sort_order      integer not null default 0,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

alter table public.ai_employees enable row level security;
-- NO policies → service-role only. Customer/staff JWT clients can
-- never see these rows.

-- ---------------------------------------------------------------------
-- Task history
-- ---------------------------------------------------------------------

create table if not exists public.ai_employee_tasks (
  id              uuid primary key default gen_random_uuid(),
  ai_employee_id  uuid not null references public.ai_employees(id) on delete cascade,

  title           text not null check (char_length(title) between 1 and 300),
  status          text not null default 'pending'
                  check (status in (
                    'pending',
                    'in_progress',
                    'waiting_approval',
                    'completed',
                    'failed',
                    'cancelled'
                  )),
  summary         text check (summary is null or char_length(summary) <= 8000),

  -- Author. Mirrors hq-audit's pattern: keep both id and email so the
  -- row stays human-readable if the user is later deleted.
  created_by_id   uuid references public.users(id) on delete set null,
  created_by_email text,

  metadata        jsonb,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now(),
  completed_at    timestamp with time zone
);

alter table public.ai_employee_tasks enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- Memory
-- ---------------------------------------------------------------------

create table if not exists public.ai_employee_memory (
  id              uuid primary key default gen_random_uuid(),
  ai_employee_id  uuid not null references public.ai_employees(id) on delete cascade,

  scope           text not null default 'isolated'
                  check (scope in (
                    'isolated',
                    'department',
                    'organization',
                    'global'
                  )),

  mem_key         text check (mem_key is null or char_length(mem_key) between 1 and 200),
  content         text not null check (char_length(content) between 1 and 20000),

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

alter table public.ai_employee_memory enable row level security;
-- NO policies → service-role only.

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

-- Boardroom default ordering: by department, then deterministic order.
create index if not exists ai_employees_department_idx
  on public.ai_employees (department, sort_order);

-- Status-card grouping / filters.
create index if not exists ai_employees_status_idx
  on public.ai_employees (status);

-- Per-employee task timeline (detail page).
create index if not exists ai_employee_tasks_recent_idx
  on public.ai_employee_tasks (ai_employee_id, created_at desc);

-- Per-employee memory timeline (detail page).
create index if not exists ai_employee_memory_recent_idx
  on public.ai_employee_memory (ai_employee_id, created_at desc);

-- ---------------------------------------------------------------------
-- Touch trigger for updated_at (shared across the three tables)
-- ---------------------------------------------------------------------

create or replace function public._ai_employees_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ai_employees_touch on public.ai_employees;
create trigger ai_employees_touch
  before update on public.ai_employees
  for each row execute function public._ai_employees_touch();

drop trigger if exists ai_employee_tasks_touch on public.ai_employee_tasks;
create trigger ai_employee_tasks_touch
  before update on public.ai_employee_tasks
  for each row execute function public._ai_employees_touch();

drop trigger if exists ai_employee_memory_touch on public.ai_employee_memory;
create trigger ai_employee_memory_touch
  before update on public.ai_employee_memory
  for each row execute function public._ai_employees_touch();
