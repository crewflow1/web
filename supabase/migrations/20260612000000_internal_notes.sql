-- CrewFlow HQ — Internal Notes OS (HQ-9).
--
-- One table — public.internal_notes — for HQ operators to track
-- customer context, sales conversations, onboarding observations,
-- billing decisions, risk notes, technical follow-ups, success
-- stories.
--
-- Crucial: invisible to tenants. RLS enabled, NO policies (service-
-- role only). Every read/write goes through HQ-side super-admin-
-- gated server actions / pages.
--
-- Layered on top of the existing per-org `organizations.admin_org_notes`
-- TEXT field (HQ-3) which is a single CEO scratchpad. internal_notes
-- is the structured multi-author, categorised, audit-trailed version.

create table if not exists public.internal_notes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,

  -- Author. Mirrors hq-audit's pattern: keep both id and email so
  -- the row stays human-readable if the user is later deleted.
  author_user_id  uuid references public.users(id) on delete set null,
  author_email    text not null,

  title           text check (title is null or char_length(title) between 1 and 200),
  body            text not null check (char_length(body) between 1 and 20000),

  category        text not null default 'general'
                  check (category in (
                    'general',
                    'sales',
                    'onboarding',
                    'billing',
                    'support',
                    'risk',
                    'technical',
                    'success'
                  )),
  priority        text not null default 'normal'
                  check (priority in ('low', 'normal', 'high', 'urgent')),
  pinned          boolean not null default false,
  archived_at     timestamp with time zone,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

alter table public.internal_notes enable row level security;
-- NO policies → service-role only. Customer queries can never see
-- these rows via the user-JWT client.

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

-- Per-org timeline (the customer-detail panel uses this).
create index if not exists internal_notes_org_recent_idx
  on public.internal_notes (org_id, created_at desc);

-- /admin/notes default ordering: pinned first, newest second.
create index if not exists internal_notes_pinned_idx
  on public.internal_notes (pinned desc, created_at desc)
  where archived_at is null;

-- Category + priority filters.
create index if not exists internal_notes_category_idx
  on public.internal_notes (category, created_at desc)
  where archived_at is null;

create index if not exists internal_notes_priority_idx
  on public.internal_notes (priority, created_at desc)
  where archived_at is null;

-- ---------------------------------------------------------------------
-- Touch trigger for updated_at
-- ---------------------------------------------------------------------

create or replace function public._internal_notes_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists internal_notes_touch on public.internal_notes;
create trigger internal_notes_touch
  before update on public.internal_notes
  for each row execute function public._internal_notes_touch();
