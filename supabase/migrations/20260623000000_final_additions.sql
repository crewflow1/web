-- Final additions consolidated schema.
--
-- One migration for all 8 directive phases:
--   A. AI Receptionist  — `inbound_enquiries`
--   B. Smart follow-ups — `lead_followup_state`
--   C. Lead summaries   — reuses leads.ai_summary (already exists)
--   D. Suppliers + exp  — `suppliers` + `finances.supplier_id` + `expense_drafts`
--   E. Compliance docs  — `compliance_documents`
--   F. Univ attachments — `tenant_attachments`
--   G. E-signatures     — `signatures` (polymorphic; quotes still use
--                         their existing accept_signature jsonb)
--   H. Review requests  — `review_requests`
--
-- Plus storage buckets for compliance-docs + tenant-attachments.
--
-- Every new table:
--   - has org_id (tenant scoping)
--   - has RLS enabled
--   - has policies aligned with `current_org_ids()` for tenant tables
--     or no policies (service-role only) for HQ-only tables
--   - is indexed for the page queries it powers
--
-- This is a big migration but the contents are independent additions
-- — none of them mutate existing rows.

-- ====================================================================
-- A. inbound_enquiries — raw incoming from receptionist channels
-- ====================================================================
create table if not exists public.inbound_enquiries (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- Where the enquiry came from.
  channel       text not null
    check (channel in ('phone', 'sms', 'whatsapp_msg', 'whatsapp_call',
                        'instagram_dm', 'facebook_dm', 'manual')),
  -- The raw payload from the channel webhook (transcript / message body).
  raw_text      text,
  -- Caller identifier (phone, handle, email) — channel-dependent format.
  caller        text,
  -- AI extraction artefacts.
  ai_summary    text,
  ai_confidence smallint check (ai_confidence is null or (ai_confidence between 0 and 100)),
  job_type      text,
  urgency       text check (urgency is null or urgency in ('low', 'medium', 'high', 'urgent')),
  postcode      text,
  budget_gbp    numeric(12, 2),
  -- Lead the AI created from this enquiry, if any.
  lead_id       uuid references public.leads(id) on delete set null,
  -- Lifecycle.
  status        text not null default 'received'
    check (status in ('received', 'processed', 'qualified', 'ignored', 'failed')),
  processed_at  timestamp with time zone,
  error_message text,
  created_at    timestamp with time zone not null default now()
);
create index if not exists inbound_enquiries_org_created_idx
  on public.inbound_enquiries (org_id, created_at desc);
create index if not exists inbound_enquiries_status_idx
  on public.inbound_enquiries (status, created_at desc);
alter table public.inbound_enquiries enable row level security;

create policy inbound_enquiries_select on public.inbound_enquiries
  for select using (org_id in (select public.current_org_ids()));
create policy inbound_enquiries_insert on public.inbound_enquiries
  for insert with check (org_id in (select public.current_org_ids()));
create policy inbound_enquiries_update on public.inbound_enquiries
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy inbound_enquiries_delete on public.inbound_enquiries
  for delete using (public.is_org_admin(org_id));

-- ====================================================================
-- B. lead_followup_state — track which reminder fires fired per lead
-- ====================================================================
create table if not exists public.lead_followup_state (
  lead_id          uuid primary key references public.leads(id) on delete cascade,
  org_id           uuid not null references public.organizations(id) on delete cascade,
  -- Stage-fire timestamps. Once set, never re-fire that stage. The
  -- cron writes here; the owner clearing the stage requires an
  -- explicit dismiss action.
  reminder_72h_at  timestamp with time zone,
  reminder_7d_at   timestamp with time zone,
  -- Owner-facing actions captured for audit. Final = the owner acted.
  acted_at         timestamp with time zone,
  acted_kind       text check (acted_kind is null or acted_kind in ('call', 'message', 'archive')),
  acted_by         uuid references public.users(id) on delete set null,
  created_at       timestamp with time zone not null default now(),
  updated_at       timestamp with time zone not null default now()
);
create index if not exists lead_followup_state_org_idx
  on public.lead_followup_state (org_id);
alter table public.lead_followup_state enable row level security;
create policy lead_followup_state_select on public.lead_followup_state
  for select using (org_id in (select public.current_org_ids()));
create policy lead_followup_state_insert on public.lead_followup_state
  for insert with check (org_id in (select public.current_org_ids()));
create policy lead_followup_state_update on public.lead_followup_state
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

-- ====================================================================
-- D. suppliers + finances.supplier_id + expense_drafts
-- ====================================================================
create table if not exists public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  phone       text,
  email       public.citext,
  category    text,
  notes       text,
  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone not null default now()
);
create index if not exists suppliers_org_idx on public.suppliers (org_id);
create unique index if not exists suppliers_org_name_unique
  on public.suppliers (org_id, lower(name));
alter table public.suppliers enable row level security;
create policy suppliers_select on public.suppliers
  for select using (org_id in (select public.current_org_ids()));
create policy suppliers_insert on public.suppliers
  for insert with check (org_id in (select public.current_org_ids()));
create policy suppliers_update on public.suppliers
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy suppliers_delete on public.suppliers
  for delete using (public.is_org_admin(org_id));

alter table public.finances
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;
create index if not exists finances_supplier_idx on public.finances (supplier_id);

create table if not exists public.expense_drafts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- Upload that fed this draft. portal_uploads is reused for the file
  -- itself; this row is the AI-extracted snapshot awaiting approval.
  upload_id       uuid,
  supplier_id     uuid references public.suppliers(id) on delete set null,
  supplier_name   text,
  amount          numeric(12, 2),
  vat_rate        numeric(5, 2),
  vat_total       numeric(12, 2),
  total           numeric(12, 2),
  category        text,
  invoice_date    date,
  reference       text,
  ai_confidence   smallint check (ai_confidence is null or (ai_confidence between 0 and 100)),
  -- Lifecycle.
  status          text not null default 'extracted'
    check (status in ('extracted', 'approved', 'rejected')),
  -- finances.id stamped when the operator approves the draft.
  finance_id      uuid references public.finances(id) on delete set null,
  approved_at     timestamp with time zone,
  approved_by     uuid references public.users(id) on delete set null,
  rejected_at     timestamp with time zone,
  rejection_reason text,
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
create index if not exists expense_drafts_org_idx
  on public.expense_drafts (org_id, created_at desc);
create index if not exists expense_drafts_status_idx
  on public.expense_drafts (status, created_at desc);
alter table public.expense_drafts enable row level security;
create policy expense_drafts_select on public.expense_drafts
  for select using (org_id in (select public.current_org_ids()));
create policy expense_drafts_insert on public.expense_drafts
  for insert with check (org_id in (select public.current_org_ids()));
create policy expense_drafts_update on public.expense_drafts
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ====================================================================
-- E. compliance_documents
-- ====================================================================
create table if not exists public.compliance_documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- What kind of doc this is.
  kind          text not null
    check (kind in ('insurance', 'certificate', 'permit', 'contract', 'other')),
  title         text not null,
  -- Storage path under `compliance-docs` bucket.
  storage_path  text not null,
  filename      text,
  mime_type     text,
  size_bytes    integer,
  -- Compliance docs have explicit expiry tracking — drives the
  -- cron's "your insurance expires in 14 days" reminder.
  expires_at    date,
  -- Reminder fires recorded so we don't spam.
  reminded_30d_at  timestamp with time zone,
  reminded_7d_at   timestamp with time zone,
  reminded_today_at timestamp with time zone,
  notes         text,
  uploaded_by   uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);
create index if not exists compliance_documents_org_idx
  on public.compliance_documents (org_id, created_at desc);
create index if not exists compliance_documents_expiry_idx
  on public.compliance_documents (expires_at) where expires_at is not null;
alter table public.compliance_documents enable row level security;
create policy compliance_documents_select on public.compliance_documents
  for select using (org_id in (select public.current_org_ids()));
create policy compliance_documents_insert on public.compliance_documents
  for insert with check (org_id in (select public.current_org_ids()));
create policy compliance_documents_update on public.compliance_documents
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy compliance_documents_delete on public.compliance_documents
  for delete using (public.is_org_admin(org_id));

-- ====================================================================
-- F. tenant_attachments — polymorphic file attachments (tenant-side)
-- ====================================================================
create table if not exists public.tenant_attachments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- Polymorphic link.
  target_table  text not null
    check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                             'suppliers', 'memberships', 'leads')),
  target_id     uuid not null,
  filename      text not null,
  storage_path  text not null,
  mime_type     text,
  size_bytes    integer,
  uploaded_by   uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now()
);
create index if not exists tenant_attachments_org_idx
  on public.tenant_attachments (org_id, created_at desc);
create index if not exists tenant_attachments_target_idx
  on public.tenant_attachments (target_table, target_id);
alter table public.tenant_attachments enable row level security;
create policy tenant_attachments_select on public.tenant_attachments
  for select using (org_id in (select public.current_org_ids()));
create policy tenant_attachments_insert on public.tenant_attachments
  for insert with check (org_id in (select public.current_org_ids()));
create policy tenant_attachments_delete on public.tenant_attachments
  for delete using (org_id in (select public.current_org_ids()));

-- ====================================================================
-- G. signatures — polymorphic e-signatures (quotes still have their
--                 existing accept_signature jsonb; this covers
--                 contracts + future non-quote entities).
-- ====================================================================
create table if not exists public.signatures (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  target_table  text not null
    check (target_table in ('quotes', 'contracts', 'invoices')),
  target_id     uuid not null,
  signer_name   text not null,
  signer_email  text,
  -- The signature blob — typically a typed full name with timestamp.
  -- Image-based signatures could be added later as a storage_path field.
  signature_text text,
  signed_at     timestamp with time zone not null default now(),
  ip_address    text,
  user_agent    text,
  created_at    timestamp with time zone not null default now()
);
create index if not exists signatures_target_idx
  on public.signatures (target_table, target_id);
create index if not exists signatures_org_idx
  on public.signatures (org_id, signed_at desc);
alter table public.signatures enable row level security;
create policy signatures_select on public.signatures
  for select using (org_id in (select public.current_org_ids()));
create policy signatures_insert on public.signatures
  for insert with check (org_id in (select public.current_org_ids()));

-- ====================================================================
-- H. review_requests
-- ====================================================================
create table if not exists public.review_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  customer_id   uuid references public.customers(id) on delete set null,
  job_id        uuid references public.jobs(id) on delete set null,
  -- Where the operator wants the review posted.
  platform      text not null
    check (platform in ('google', 'facebook', 'trustpilot', 'other')),
  -- Delay before send. NULL/0 means immediate.
  delay_days    integer not null default 0
    check (delay_days >= 0 and delay_days <= 90),
  -- Scheduled send time (now + delay_days).
  send_at       timestamp with time zone not null,
  -- Lifecycle.
  status        text not null default 'scheduled'
    check (status in ('scheduled', 'sent', 'completed', 'ignored', 'cancelled')),
  sent_at       timestamp with time zone,
  completed_at  timestamp with time zone,
  requested_by  uuid references public.users(id) on delete set null,
  notes         text,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);
create index if not exists review_requests_org_idx
  on public.review_requests (org_id, created_at desc);
create index if not exists review_requests_status_send_idx
  on public.review_requests (status, send_at);
alter table public.review_requests enable row level security;
create policy review_requests_select on public.review_requests
  for select using (org_id in (select public.current_org_ids()));
create policy review_requests_insert on public.review_requests
  for insert with check (org_id in (select public.current_org_ids()));
create policy review_requests_update on public.review_requests
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

-- ====================================================================
-- Storage buckets
-- ====================================================================
insert into storage.buckets (id, name, public)
values ('compliance-docs', 'compliance-docs', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('tenant-attachments', 'tenant-attachments', false)
on conflict (id) do nothing;
