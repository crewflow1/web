-- demo_requests — public-form leads from the landing page.
--
-- Anyone can INSERT (anon role) — this is the marketing-site capture
-- endpoint. Nobody but service-role can SELECT, so a leaked anon key
-- can't enumerate the lead list.

create table if not exists public.demo_requests (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  company               text not null,
  email                 text not null,
  phone                 text,
  employees             text,
  turnover_range        text,
  current_systems       text,
  preferred_demo_time   text,
  notes                 text,
  status                text not null default 'new'
    check (status in ('new', 'contacted', 'qualified', 'closed_won', 'closed_lost')),
  internal_lead_id      uuid references public.leads(id) on delete set null,
  user_agent            text,
  source                text default 'landing',
  created_at            timestamp with time zone not null default now()
);

create index if not exists demo_requests_status_idx on public.demo_requests (status, created_at desc);
create index if not exists demo_requests_email_idx on public.demo_requests (email);

alter table public.demo_requests enable row level security;

drop policy if exists "demo_requests: anyone insert" on public.demo_requests;
create policy "demo_requests: anyone insert" on public.demo_requests
  for insert to anon, authenticated
  with check (true);

-- Deliberately no SELECT policy — only service role reads them.
