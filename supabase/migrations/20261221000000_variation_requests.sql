-- Roadmap G2 — Structured variation-request INTAKE.
--
-- A variation REQUEST is the ask that precedes the commercial Variation Order:
-- "the client wants the kitchen socket moved — someone needs to price it".
-- Today that ask arrives as a phone call or a WhatsApp and evaporates. This
-- table captures it from three directions —
--
--   staff        — the site lead logs it from the job workspace,
--   customer     — "Request a change" in the customer portal (token-authed),
--   worker_token — an external worker flags extra work from the H&S portal,
--
-- and runs it through a small, trigger-guarded state machine:
--
--   requested → reviewing → accepted / rejected
--                            accepted → converted   (a Variation Order exists)
--
-- The COMMERCIAL side is deliberately NOT duplicated here: pricing lives in
-- the existing variation engine (quotes with variation_number — createVariation
-- in app/(app)/quotes/actions.ts). On conversion this row just gets stamped
-- with the resulting quote id, so intake → decision → priced VO is traceable
-- end-to-end without a second money model.
--
-- Conventions mirror snags (20260919000000) — org_id + RLS via
-- current_org_ids(), admin-only hard delete, shared tg_set_updated_at — plus
-- the C36/C37 composite-FK org binding: (job_id, org_id) → jobs (id, org_id)
-- makes a cross-tenant job reference structurally unrepresentable, and the
-- same binding pins the converted quote to the SAME org.
--
-- Photos ride the EXISTING universal tenant_attachments pipeline: the CHECK at
-- the bottom is widened to admit target_table='variation_requests' (the snags
-- idiom — introspect-drop-readd, and the TS allowlist in
-- server/services/tenant-attachments.ts is widened in the same PR; the
-- attachment-target drift test pins the two together).
--
-- Reversible: drop table public.variation_requests, drop the two functions,
-- and narrow the tenant_attachments CHECK. No existing row is mutated.

create table if not exists public.variation_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- The job the change is being asked against. NOT NULL — a variation request
  -- without a job is a lead, and leads already have a pipeline.
  job_id          uuid not null,

  title           text not null check (length(title) between 1 and 200),
  description     text check (description is null or length(description) <= 5000),
  -- WHY the change is wanted ("client changed mind", "unforeseen ground
  -- conditions") — the commercial-context line a reviewer reads first.
  reason          text check (reason is null or length(reason) <= 2000),
  urgency         text not null default 'normal'
    check (urgency in ('low', 'normal', 'high')),

  -- WHO asked. Exactly one of the three intake doors:
  --   staff        → requested_by is the auth user (RLS insert path);
  --   customer     → service-role insert from the portal action, identity
  --                  resolved from the portal token, requester_name stamped;
  --   worker_token → service-role insert from the worker portal, name from
  --                  the sign-off token record.
  requester_type  text not null default 'staff'
    check (requester_type in ('staff', 'customer', 'worker_token')),
  requested_by    uuid references public.users(id) on delete set null,
  requester_name  text check (requester_name is null or length(requester_name) <= 200),

  -- The state machine (guarded by tg_variation_requests_guard below).
  status          text not null default 'requested'
    check (status in ('requested', 'reviewing', 'accepted', 'rejected', 'converted')),

  -- Review outcome — stamped by the admin action, never by the requester.
  review_note     text check (review_note is null or length(review_note) <= 2000),
  reviewed_by     uuid references public.users(id) on delete set null,
  reviewed_at     timestamp with time zone,

  -- The Variation Order this request became. Stamped by the convert hook in
  -- createVariation; the trigger refuses status='converted' without it.
  variation_quote_id uuid,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now(),

  -- Cross-tenant impossibility + cascade-on-job-delete, in one constraint
  -- (requires jobs_id_org_key, present since 20261072/20261113).
  constraint variation_requests_job_fkey
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,

  -- The converted quote must live in the SAME org (quotes_id_org_key,
  -- 20261084). PG15 column-list SET NULL — only the quote pointer clears if
  -- the quote is ever deleted; org_id (NOT NULL) is untouched. The 20261084 /
  -- 20261113 idiom.
  constraint variation_requests_quote_fkey
    foreign key (variation_quote_id, org_id) references public.quotes (id, org_id)
    on delete set null (variation_quote_id),

  -- Candidate key for any future child relation's org-binding composite FK.
  constraint variation_requests_id_org_key unique (id, org_id)
);

-- Org listing, newest first (review queues, dashboards).
create index if not exists variation_requests_org_idx
  on public.variation_requests (org_id, created_at desc);
-- The job-workspace panel: "requests on this job".
create index if not exists variation_requests_job_idx
  on public.variation_requests (job_id, created_at desc);
-- Cheap "what still needs a decision" across the org.
create index if not exists variation_requests_open_idx
  on public.variation_requests (org_id, status)
  where status in ('requested', 'reviewing');
-- FK-side index for the quote pointer (rarely queried, keeps deletes cheap).
create index if not exists variation_requests_quote_idx
  on public.variation_requests (variation_quote_id)
  where variation_quote_id is not null;

alter table public.variation_requests enable row level security;

-- SELECT: any member of the org — the requester, the crew and the reviewer all
-- see the same queue (snags idiom).
create policy variation_requests_select on public.variation_requests
  for select using (org_id in (select public.current_org_ids()));

-- INSERT (authenticated path = STAFF ONLY): a member may raise a request in
-- their own org, AS THEMSELVES. Portal/worker intakes arrive via the
-- service-role client (which bypasses RLS) with token-resolved identity, so an
-- authenticated user can never forge a 'customer' or 'worker_token' request,
-- nor pin someone else as the requester.
create policy variation_requests_insert on public.variation_requests
  for insert with check (
    org_id in (select public.current_org_ids())
    and requester_type = 'staff'
    and requested_by = auth.uid()
  );

-- UPDATE: admin/owner only. Review transitions are a management decision;
-- members request, they do not decide. (The state machine itself is enforced
-- below for EVERY role, service_role included.)
create policy variation_requests_update on public.variation_requests
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- Hard delete admin-only: an intake trail is audit-worthy — reviewers reject
-- with a note rather than erase (snags/compliance_documents idiom).
create policy variation_requests_delete on public.variation_requests
  for delete using (public.is_org_admin(org_id));

-- updated_at maintenance — the shared trigger fn from 20260515150000.
drop trigger if exists variation_requests_set_updated_at on public.variation_requests;
create trigger variation_requests_set_updated_at
  before update on public.variation_requests
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- State machine guard. Runs for EVERY writer (RLS roles AND service_role), so
-- no code path — portal action, admin action, convert hook — can skip a state
-- or resurrect a decided request. The matrix here is mirrored in
-- lib/variation-requests/schema.ts (VARIATION_REQUEST_TRANSITIONS); the pure
-- unit test asserts that mirror, this trigger enforces it.
--
--   requested → reviewing | accepted | rejected   (an admin may decide
--   reviewing → accepted | rejected                without formally opening
--   accepted  → converted                          a review first)
--   rejected  → (terminal)
--   converted → (terminal)
-- ---------------------------------------------------------------------------
create or replace function public.tg_variation_requests_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Rows are BORN requested. Inserting straight into a decided/converted
    -- state would bypass the review trail entirely.
    if new.status <> 'requested' then
      raise exception 'variation_requests: rows are created as ''requested'' (got ''%'')', new.status
        using errcode = 'check_violation';
    end if;
    if new.variation_quote_id is not null then
      raise exception 'variation_requests: variation_quote_id is stamped on conversion, not at intake'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE — the transition matrix, forward-only.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'requested' and new.status in ('reviewing', 'accepted', 'rejected'))
      or (old.status = 'reviewing' and new.status in ('accepted', 'rejected'))
      or (old.status = 'accepted'  and new.status = 'converted')
    ) then
      raise exception 'variation_requests: illegal status transition ''%'' -> ''%''', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'converted' and new.variation_quote_id is null then
      raise exception 'variation_requests: ''converted'' requires variation_quote_id'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The quote pointer may only be STAMPED as part of conversion. (Clearing it
  -- is allowed — that is the FK's SET NULL when a quote is deleted.)
  if new.variation_quote_id is distinct from old.variation_quote_id
     and new.variation_quote_id is not null
     and new.status <> 'converted' then
    raise exception 'variation_requests: variation_quote_id may only be set when converting'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists variation_requests_guard on public.variation_requests;
create trigger variation_requests_guard
  before insert or update on public.variation_requests
  for each row execute function public.tg_variation_requests_guard();

-- ---------------------------------------------------------------------------
-- Photos for a variation request ride the EXISTING universal attachments
-- pipeline (tenant_attachments + the 'tenant-attachments' bucket). Storage RLS
-- keys on the org-id path prefix, not target_table (20260626000000), so
-- widening this CHECK is the only change needed. Introspect-drop-readd (the
-- snags 20260919 idiom) so we never end up with two overlapping CHECKs.
-- The value set below = the 20261145000001 set + 'variation_requests'; the
-- attachment-target drift test reads THIS block as the DB truth.
-- ---------------------------------------------------------------------------
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'tenant_attachments'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%target_table%';
  if cname is not null then
    execute format('alter table public.tenant_attachments drop constraint %I', cname);
  end if;
end $$;

alter table public.tenant_attachments
  add constraint tenant_attachments_target_table_check
  check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                          'suppliers', 'memberships', 'leads', 'snags',
                          'site_diary_entries', 'toolbox_talks', 'site_reports',
                          'assets', 'asset_assignments', 'asset_inspections',
                          'asset_maintenance_cases', 'asset_fuel_logs',
                          'goods_received_notes', 'inspection_signoffs',
                          'non_conformance_reports', 'blueprint_pins',
                          'asset_calibration_certificates',
                          'variation_requests'));
