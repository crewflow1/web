-- Phase 3 — Customer portal uploads.
--
-- One table to capture every file a customer uploads via their
-- portal token: payment proofs, photos on a job, signed PDFs, etc.
-- The polymorphic shape (target_table + target_id) keeps schema
-- migrations down to one and lets HQ reuse the same table to query
-- "all customer-uploaded docs for invoice X" or "all docs for org Y".
--
-- Auth model: there's no auth.uid in the portal, so RLS allows
-- service-role only. The portal server action validates the token,
-- resolves the customer + org, then writes through the admin client.
-- Customer can only upload against their OWN customer_id; the action
-- enforces this by filtering the upload's target through the loaded
-- portal session.

create table if not exists public.portal_uploads (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  -- Polymorphic link. Allowed: 'invoices' | 'quotes' | 'jobs' | 'customers' | 'support_tickets'.
  target_table    text not null
    check (target_table in ('invoices', 'quotes', 'jobs', 'customers', 'support_tickets')),
  target_id       uuid not null,
  -- Free-form bucket key. The "kind" classifies the upload (payment_proof,
  -- site_photo, signed_doc, message_attachment) so HQ can filter cleanly.
  kind            text not null
    check (kind in ('payment_proof', 'site_photo', 'signed_doc', 'message_attachment', 'other')),
  filename        text not null,
  storage_path    text not null, -- bucket + key, e.g. portal-uploads/{org}/{customer}/{uuid}.pdf
  mime_type       text,
  size_bytes      integer,
  notes           text,
  uploaded_at     timestamp with time zone not null default now()
);

create index if not exists portal_uploads_org_idx
  on public.portal_uploads (org_id, uploaded_at desc);
create index if not exists portal_uploads_target_idx
  on public.portal_uploads (target_table, target_id);
create index if not exists portal_uploads_customer_idx
  on public.portal_uploads (customer_id, uploaded_at desc);

-- RLS — service-role only.
alter table public.portal_uploads enable row level security;

-- Storage bucket for portal uploads. Idempotent.
insert into storage.buckets (id, name, public)
values ('portal-uploads', 'portal-uploads', false)
on conflict (id) do nothing;
