-- Add contact identity fields to leads.
--
-- Why: until now a "lead" could be saved with just a `source` (the schema
-- defaulted to "phone"). Nothing in the form forced the operator to write
-- down WHO had got in touch — so we could end up with a row representing
-- an enquiry with no name, no email, no phone. Useless.
--
-- This migration adds three nullable columns. The app layer enforces
-- contact_name as required and (contact_email OR contact_phone) at the
-- validation step (lib/leads/schema.ts), so the DB stays permissive for
-- legacy rows and import flows that backfill contact info later.
--
-- All three columns are indexed lightly (text_pattern_ops) only on email
-- because that's the column we'll use for de-dup lookups (e.g. "is this
-- enquiry already in the pipeline?"). Name + phone are searched via the
-- generic search rank path so they don't need their own index here.

alter table public.leads
  add column if not exists contact_name  text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text;

create index if not exists leads_org_contact_email_idx
  on public.leads (org_id, contact_email)
  where contact_email is not null;
