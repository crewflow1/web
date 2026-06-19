-- Baseline of CrewFlow production public schema as of 2026-05-15.
--
-- Tables: calls, conversations, customers, leads, memberships, messages, missed_call_textbacks, organizations, properties, quote_line_items, quotes, service_catalog, users, voice_notes, waitlist
--
-- This migration captures the state of every table, constraint, and index
-- that exists in production but was never tracked in supabase/migrations/.
-- It is fully idempotent: every CREATE uses IF NOT EXISTS, every ALTER ...
-- ADD CONSTRAINT is wrapped in a DO block that checks pg_constraint first.
-- Marked as already-applied via `supabase migration repair --status applied
-- 00000000000000` so it never runs against prod.
--
-- DO NOT edit historical migrations after they're applied. To change
-- schema, add a NEW migration that ALTERs or replaces.

-- extensions ----------------------------------------------------------
create extension if not exists "pgcrypto";  -- gen_random_uuid()
create extension if not exists "citext";    -- case-insensitive text (used on customers.email etc.)

-- table: public.calls ----------------------------------------------------
create table if not exists public."calls" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "conversation_id" uuid,
  "lead_id" uuid,
  "direction" text not null,
  "status" text not null,
  "caller_number" text,
  "receiver_number" text,
  "provider" text default 'vapi'::text not null,
  "provider_call_id" text,
  "recording_url" text,
  "transcript" text,
  "transcript_json" jsonb,
  "ai_summary" text,
  "ai_extracted" jsonb,
  "duration_sec" integer,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null
);

-- table: public.conversations ----------------------------------------------------
create table if not exists public."conversations" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "lead_id" uuid,
  "customer_id" uuid,
  "channel" text not null,
  "external_id" text,
  "last_message_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null
);

-- table: public.customers ----------------------------------------------------
create table if not exists public."customers" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "name" text not null,
  "email" public.citext,
  "phone" text,
  "notes" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

-- table: public.leads ----------------------------------------------------
create table if not exists public."leads" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "customer_id" uuid,
  "property_id" uuid,
  "source" text not null,
  "status" text default 'new'::text not null,
  "service" text,
  "urgency" text,
  "postcode" text,
  "preferred_callback_at" timestamp with time zone,
  "ai_summary" text,
  "assigned_to" uuid,
  "first_contact_at" timestamp with time zone default now() not null,
  "last_activity_at" timestamp with time zone default now() not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

-- table: public.memberships ----------------------------------------------------
create table if not exists public."memberships" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "user_id" uuid not null,
  "role" text default 'owner'::text not null,
  "created_at" timestamp with time zone default now() not null
);

-- table: public.messages ----------------------------------------------------
create table if not exists public."messages" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "conversation_id" uuid not null,
  "direction" text not null,
  "from_addr" text,
  "to_addr" text,
  "body" text,
  "media_urls" text[],
  "status" text,
  "provider_id" text,
  "created_at" timestamp with time zone default now() not null
);

-- table: public.missed_call_textbacks ----------------------------------------------------
create table if not exists public."missed_call_textbacks" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "call_id" uuid,
  "caller_number" text not null,
  "template_used" text,
  "status" text default 'queued'::text not null,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null
);

-- table: public.organizations ----------------------------------------------------
create table if not exists public."organizations" (
  "id" uuid default gen_random_uuid() not null,
  "name" text not null,
  "slug" text not null,
  "country" text default 'GB'::text not null,
  "timezone" text default 'Europe/London'::text not null,
  "vat_number" text,
  "address" jsonb,
  "phone" text,
  "email" public.citext,
  "logo_url" text,
  "plan" text default 'trial'::text not null,
  "trial_ends_at" timestamp with time zone,
  "stripe_customer_id" text,
  "onboarding_state" jsonb default '{}'::jsonb not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

-- table: public.properties ----------------------------------------------------
create table if not exists public."properties" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "customer_id" uuid not null,
  "address" jsonb not null,
  "notes" text,
  "created_at" timestamp with time zone default now() not null
);

-- table: public.quote_line_items ----------------------------------------------------
create table if not exists public."quote_line_items" (
  "id" uuid default gen_random_uuid() not null,
  "quote_id" uuid not null,
  "org_id" uuid not null,
  "description" text not null,
  "qty" numeric default 1 not null,
  "unit" text default 'item'::text not null,
  "unit_price" numeric default 0 not null,
  "vat_rate" numeric default 20.00 not null,
  "line_total" numeric default 0 not null,
  "sort_order" integer default 0 not null
);

-- table: public.quotes ----------------------------------------------------
create table if not exists public."quotes" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "lead_id" uuid,
  "customer_id" uuid not null,
  "property_id" uuid,
  "number" text not null,
  "status" text default 'draft'::text not null,
  "currency" text default 'GBP'::text not null,
  "subtotal" numeric default 0 not null,
  "vat_total" numeric default 0 not null,
  "total" numeric default 0 not null,
  "notes" text,
  "terms" text,
  "valid_until" date,
  "public_token" text default replace((gen_random_uuid())::text, '-'::text, ''::text) not null,
  "sent_at" timestamp with time zone,
  "viewed_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "accept_signature" jsonb,
  "declined_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

-- table: public.service_catalog ----------------------------------------------------
create table if not exists public."service_catalog" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "name" text not null,
  "description" text,
  "default_price" numeric,
  "unit" text default 'item'::text not null,
  "vat_rate" numeric default 20.00 not null,
  "is_active" boolean default true not null,
  "sort_order" integer default 0 not null,
  "created_at" timestamp with time zone default now() not null
);

-- table: public.users ----------------------------------------------------
create table if not exists public."users" (
  "id" uuid not null,
  "email" public.citext not null,
  "full_name" text,
  "phone" text,
  "avatar_url" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

-- table: public.voice_notes ----------------------------------------------------
create table if not exists public."voice_notes" (
  "id" uuid default gen_random_uuid() not null,
  "org_id" uuid not null,
  "recorded_by" uuid,
  "audio_url" text not null,
  "duration_sec" integer,
  "transcript" text,
  "transcript_confidence" numeric,
  "intent" text,
  "intent_confidence" numeric,
  "ai_summary" text,
  "ai_extracted" jsonb,
  "target_type" text,
  "target_id" uuid,
  "status" text default 'received'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "actioned_at" timestamp with time zone
);

-- table: public.waitlist ----------------------------------------------------
create table if not exists public."waitlist" (
  "id" uuid default gen_random_uuid() not null,
  "email" public.citext not null,
  "company_name" text,
  "phone" text,
  "trade" text,
  "employees" text,
  "source" text,
  "user_agent" text,
  "ip_hash" text,
  "created_at" timestamp with time zone default now() not null
);

-- constraints ---------------------------------------------------------
-- Each constraint is added inside a DO block that first checks pg_constraint,
-- making the migration safe to re-run.
-- Applied in two passes so the migration bootstraps a FRESH database, not
-- just an already-migrated one: a FOREIGN KEY can only reference a column
-- that already carries a PRIMARY KEY / UNIQUE constraint. Pass 1 adds all
-- PK/UNIQUE; pass 2 adds the FKs. Every block is idempotent, so this stays
-- a no-op on production (all constraints already exist) while becoming the
-- correct dependency order on a clean Postgres. See OQ-16 / CI integration.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calls_pkey' and conrelid = 'public.calls'::regclass) then
    alter table public."calls" add constraint "calls_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_pkey' and conrelid = 'public.conversations'::regclass) then
    alter table public."conversations" add constraint "conversations_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customers_pkey' and conrelid = 'public.customers'::regclass) then
    alter table public."customers" add constraint "customers_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_pkey' and conrelid = 'public.leads'::regclass) then
    alter table public."leads" add constraint "leads_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_pkey' and conrelid = 'public.memberships'::regclass) then
    alter table public."memberships" add constraint "memberships_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_org_id_user_id_key' and conrelid = 'public.memberships'::regclass) then
    alter table public."memberships" add constraint "memberships_org_id_user_id_key" UNIQUE (org_id, user_id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'messages_pkey' and conrelid = 'public.messages'::regclass) then
    alter table public."messages" add constraint "messages_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'missed_call_textbacks_pkey' and conrelid = 'public.missed_call_textbacks'::regclass) then
    alter table public."missed_call_textbacks" add constraint "missed_call_textbacks_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_pkey' and conrelid = 'public.organizations'::regclass) then
    alter table public."organizations" add constraint "organizations_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_slug_key' and conrelid = 'public.organizations'::regclass) then
    alter table public."organizations" add constraint "organizations_slug_key" UNIQUE (slug);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_pkey' and conrelid = 'public.properties'::regclass) then
    alter table public."properties" add constraint "properties_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quote_line_items_pkey' and conrelid = 'public.quote_line_items'::regclass) then
    alter table public."quote_line_items" add constraint "quote_line_items_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_pkey' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_org_id_number_key' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_org_id_number_key" UNIQUE (org_id, number);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_public_token_key' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_public_token_key" UNIQUE (public_token);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'service_catalog_pkey' and conrelid = 'public.service_catalog'::regclass) then
    alter table public."service_catalog" add constraint "service_catalog_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_pkey' and conrelid = 'public.users'::regclass) then
    alter table public."users" add constraint "users_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'voice_notes_pkey' and conrelid = 'public.voice_notes'::regclass) then
    alter table public."voice_notes" add constraint "voice_notes_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'waitlist_pkey' and conrelid = 'public.waitlist'::regclass) then
    alter table public."waitlist" add constraint "waitlist_pkey" PRIMARY KEY (id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'waitlist_email_key' and conrelid = 'public.waitlist'::regclass) then
    alter table public."waitlist" add constraint "waitlist_email_key" UNIQUE (email);
  end if;
end $$;

-- foreign keys (every PK/UNIQUE target above now exists) ---------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calls_conversation_id_fkey' and conrelid = 'public.calls'::regclass) then
    alter table public."calls" add constraint "calls_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calls_lead_id_fkey' and conrelid = 'public.calls'::regclass) then
    alter table public."calls" add constraint "calls_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calls_org_id_fkey' and conrelid = 'public.calls'::regclass) then
    alter table public."calls" add constraint "calls_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_customer_id_fkey' and conrelid = 'public.conversations'::regclass) then
    alter table public."conversations" add constraint "conversations_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_lead_id_fkey' and conrelid = 'public.conversations'::regclass) then
    alter table public."conversations" add constraint "conversations_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_org_id_fkey' and conrelid = 'public.conversations'::regclass) then
    alter table public."conversations" add constraint "conversations_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customers_org_id_fkey' and conrelid = 'public.customers'::regclass) then
    alter table public."customers" add constraint "customers_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_assigned_to_fkey' and conrelid = 'public.leads'::regclass) then
    alter table public."leads" add constraint "leads_assigned_to_fkey" FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_customer_id_fkey' and conrelid = 'public.leads'::regclass) then
    alter table public."leads" add constraint "leads_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_org_id_fkey' and conrelid = 'public.leads'::regclass) then
    alter table public."leads" add constraint "leads_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_property_id_fkey' and conrelid = 'public.leads'::regclass) then
    alter table public."leads" add constraint "leads_property_id_fkey" FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_org_id_fkey' and conrelid = 'public.memberships'::regclass) then
    alter table public."memberships" add constraint "memberships_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_user_id_fkey' and conrelid = 'public.memberships'::regclass) then
    alter table public."memberships" add constraint "memberships_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'messages_conversation_id_fkey' and conrelid = 'public.messages'::regclass) then
    alter table public."messages" add constraint "messages_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'messages_org_id_fkey' and conrelid = 'public.messages'::regclass) then
    alter table public."messages" add constraint "messages_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'missed_call_textbacks_call_id_fkey' and conrelid = 'public.missed_call_textbacks'::regclass) then
    alter table public."missed_call_textbacks" add constraint "missed_call_textbacks_call_id_fkey" FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'missed_call_textbacks_org_id_fkey' and conrelid = 'public.missed_call_textbacks'::regclass) then
    alter table public."missed_call_textbacks" add constraint "missed_call_textbacks_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_customer_id_fkey' and conrelid = 'public.properties'::regclass) then
    alter table public."properties" add constraint "properties_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_org_id_fkey' and conrelid = 'public.properties'::regclass) then
    alter table public."properties" add constraint "properties_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quote_line_items_org_id_fkey' and conrelid = 'public.quote_line_items'::regclass) then
    alter table public."quote_line_items" add constraint "quote_line_items_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quote_line_items_quote_id_fkey' and conrelid = 'public.quote_line_items'::regclass) then
    alter table public."quote_line_items" add constraint "quote_line_items_quote_id_fkey" FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_created_by_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_customer_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_lead_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_org_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_property_id_fkey' and conrelid = 'public.quotes'::regclass) then
    alter table public."quotes" add constraint "quotes_property_id_fkey" FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'service_catalog_org_id_fkey' and conrelid = 'public.service_catalog'::regclass) then
    alter table public."service_catalog" add constraint "service_catalog_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_id_fkey' and conrelid = 'public.users'::regclass) then
    alter table public."users" add constraint "users_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'voice_notes_org_id_fkey' and conrelid = 'public.voice_notes'::regclass) then
    alter table public."voice_notes" add constraint "voice_notes_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'voice_notes_recorded_by_fkey' and conrelid = 'public.voice_notes'::regclass) then
    alter table public."voice_notes" add constraint "voice_notes_recorded_by_fkey" FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL;
  end if;
end $$;

-- indexes -------------------------------------------------------------
-- pg_indexes already returns 'CREATE INDEX' DDL; we substitute IF NOT EXISTS
-- to keep this re-runnable. PK and UNIQUE indexes are excluded as they're
-- already covered by the constraints above.
CREATE INDEX IF NOT EXISTS calls_org_id_started_at_idx ON public.calls USING btree (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_org_id_status_idx ON public.calls USING btree (org_id, status);
CREATE INDEX IF NOT EXISTS calls_provider_call_id_idx ON public.calls USING btree (provider_call_id);
CREATE INDEX IF NOT EXISTS conversations_org_id_channel_last_message_at_idx ON public.conversations USING btree (org_id, channel, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_org_id_lead_id_idx ON public.conversations USING btree (org_id, lead_id);
CREATE INDEX IF NOT EXISTS customers_org_id_email_idx ON public.customers USING btree (org_id, email);
CREATE INDEX IF NOT EXISTS customers_org_id_idx ON public.customers USING btree (org_id);
CREATE INDEX IF NOT EXISTS customers_org_id_phone_idx ON public.customers USING btree (org_id, phone);
CREATE INDEX IF NOT EXISTS leads_customer_id_idx ON public.leads USING btree (customer_id);
CREATE INDEX IF NOT EXISTS leads_org_id_source_idx ON public.leads USING btree (org_id, source);
CREATE INDEX IF NOT EXISTS leads_org_id_status_last_activity_at_idx ON public.leads USING btree (org_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS memberships_org_id_idx ON public.memberships USING btree (org_id);
CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON public.memberships USING btree (user_id);
CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_idx ON public.messages USING btree (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_org_id_created_at_idx ON public.messages USING btree (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS missed_call_textbacks_org_id_caller_number_created_at_idx ON public.missed_call_textbacks USING btree (org_id, caller_number, created_at DESC);
CREATE INDEX IF NOT EXISTS properties_customer_id_idx ON public.properties USING btree (customer_id);
CREATE INDEX IF NOT EXISTS properties_org_id_idx ON public.properties USING btree (org_id);
CREATE INDEX IF NOT EXISTS quote_line_items_quote_id_idx ON public.quote_line_items USING btree (quote_id);
CREATE INDEX IF NOT EXISTS quotes_customer_id_idx ON public.quotes USING btree (customer_id);
CREATE INDEX IF NOT EXISTS quotes_org_id_status_created_at_idx ON public.quotes USING btree (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS service_catalog_org_id_is_active_sort_order_idx ON public.service_catalog USING btree (org_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS voice_notes_org_id_recorded_by_idx ON public.voice_notes USING btree (org_id, recorded_by);
CREATE INDEX IF NOT EXISTS voice_notes_org_id_status_created_at_idx ON public.voice_notes USING btree (org_id, status, created_at DESC);

-- enable RLS on all tables that have it in prod (no-op if already enabled) -
alter table public."calls" enable row level security;
alter table public."conversations" enable row level security;
alter table public."customers" enable row level security;
alter table public."leads" enable row level security;
alter table public."memberships" enable row level security;
alter table public."messages" enable row level security;
alter table public."missed_call_textbacks" enable row level security;
alter table public."organizations" enable row level security;
alter table public."properties" enable row level security;
alter table public."quote_line_items" enable row level security;
alter table public."quotes" enable row level security;
alter table public."service_catalog" enable row level security;
alter table public."users" enable row level security;
alter table public."voice_notes" enable row level security;
alter table public."waitlist" enable row level security;
