-- WhatsApp AI Assistant (Milestone Ring 1) — phone_number_id -> org routing.
--
-- One global Meta app signs every tenant's inbound webhook (a single
-- WHATSAPP_APP_SECRET), so org attribution is a DATABASE lookup, not a per-org
-- credential — the same trust posture as the shared CHANNEL_INBOUND_SECRET on
-- /api/receptionist/inbound. The routing key is Meta's `phone_number_id` (the
-- infra identity of the WhatsApp sender), which is DISTINCT from the free-text,
-- unindexed display string in ai_receptionist_setups.whatsapp_number — so the
-- mapping cannot be derived and must be provisioned.
--
-- An inbound event whose phone_number_id has no active route is ack-dropped
-- (stamped processed + an HQ notification), never processed against a guessed
-- org — a webhook that can't be attributed must not touch tenant data.

create table if not exists public.whatsapp_number_routes (
  id                   uuid primary key default gen_random_uuid(),
  -- Meta's phone_number_id — the routing key. UNIQUE: one org owns a number.
  phone_number_id      text not null unique,
  waba_id              text,
  display_phone_number text,
  org_id               uuid not null references public.organizations(id) on delete cascade,
  active               boolean not null default true,
  created_at           timestamp with time zone not null default now(),
  updated_at           timestamp with time zone not null default now()
);

create index if not exists whatsapp_number_routes_org_idx
  on public.whatsapp_number_routes (org_id);

alter table public.whatsapp_number_routes enable row level security;

-- Members may READ their org's routes (so an operator can see which number is
-- wired). Provisioning is admin/service-role: the mapping is HQ-populated during
-- onboarding, and the webhook handler resolves it on the service-role client.
drop policy if exists "whatsapp_number_routes: members can select" on public.whatsapp_number_routes;
create policy "whatsapp_number_routes: members can select" on public.whatsapp_number_routes
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

drop policy if exists "whatsapp_number_routes: admins can insert" on public.whatsapp_number_routes;
create policy "whatsapp_number_routes: admins can insert" on public.whatsapp_number_routes
  for insert to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "whatsapp_number_routes: admins can update" on public.whatsapp_number_routes;
create policy "whatsapp_number_routes: admins can update" on public.whatsapp_number_routes
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
