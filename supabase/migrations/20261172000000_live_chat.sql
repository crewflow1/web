-- MP Phase 8 "Live Chat" — the customer-facing, in-app live chat surface.
--
-- WHAT THIS IS. A real, human-staffed live chat between a customer (in the
-- Customer Portal) and the company (in the unified inbox). The customer opens a
-- chat panel in their portal, sends a message, and the company sees it as a
-- `conversations` row with channel='chat' in `/inbox/conversations` and replies
-- with the EXISTING composer. Delivery is IN-APP: a message is a row; the
-- customer's panel receives staff replies by HONEST near-real-time polling of a
-- token-scoped read endpoint (no external provider, no websocket claim).
--
-- ── REUSE, NOT DUPLICATE ────────────────────────────────────────────────────
-- The thread container/timeline pair this needs ALREADY EXISTS and is already
-- wired for the tenant inbox: `public.conversations` + `public.messages`
-- (hardened by 20261135000000, projected into by 20261135000001). channel='chat'
-- is already in the conversations/messages CHECK vocabulary; a per-contact thread
-- is already keyed by the partial unique (org_id, channel, contact_ref). So this
-- migration mints NO new table — a portal chat is a `conversations` row with
-- channel='chat', customer_id set, and contact_ref = 'customer:<customer_id>'
-- (one chat thread per customer per org). Both tables keep their existing RLS
-- (member-scoped select/insert/update, admin delete) and are already registered
-- in lib/gdpr/org-tables.json. This migration only adds the integrity + provenance
-- guarantees a customer-bound, in-app, (future) AI-assisted thread requires.
--
-- ── ADDITIVE + SAFE ─────────────────────────────────────────────────────────
-- One new nullable-defaulted column, one composite FK (NOT VALID → new/updated
-- rows only), one partial index, and a defensive guard-add of the customers
-- candidate key the FK targets. No column dropped, no policy changed, no RLS
-- loosened, no data rewritten. Safe to apply against populated tables.
--
-- Rollback: drop the index, drop the FK, drop the column. (customers_id_org_key
-- is shared infrastructure — leave it.)

-- ── (a) customers candidate key — the composite-FK target ────────────────────
-- The (id, org_id) unique the cross-tenant FK below references. It already exists
-- in every environment (added 20260915000000); this guard-add makes the migration
-- self-contained and idempotent, matching the invoices_id_org_key / quotes idiom.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_id_org_key'
  ) then
    alter table public.customers
      add constraint customers_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── (b) conversations — bind a chat thread to its owning customer, cross-tenant-safe ─
-- A portal chat thread is owned by exactly one customer. The baseline FKs
-- customer_id → customers(id) and org_id → organizations(id) INDEPENDENTLY, which
-- alone would let a forged row pair a customer from org A with org_id = B. This
-- COMPOSITE FK onto customers(id, org_id) makes that structurally impossible: a
-- conversation's customer must live in the conversation's own org. NOT VALID so it
-- governs only rows this feature writes; NULL customer_id (every enquiry-projected
-- thread) is unconstrained under MATCH SIMPLE, so existing rows are untouched.
alter table public.conversations
  drop constraint if exists conversations_customer_org_fk;
alter table public.conversations
  add constraint conversations_customer_org_fk
    foreign key (customer_id, org_id)
    references public.customers (id, org_id)
    on delete cascade
    not valid;

-- Fast lookup of a customer's chat thread from the portal (org + customer, chat only).
create index if not exists conversations_org_customer_chat_idx
  on public.conversations (org_id, customer_id)
  where channel = 'chat' and customer_id is not null;

-- ── (c) messages — provenance for AUTOMATED replies (deterministic today, AI-dark) ─
-- auto_generated marks a message the SYSTEM produced rather than a human: today,
-- ONLY the deterministic acknowledgement the portal posts when a customer sends
-- (see server/services/chat-auto-reply.ts). It is FALSE for every human reply and
-- every inbound customer message. When (and only when) an inference tier is bound,
-- the same flag will mark a governed AI-generated reply — so the UI can always
-- label an automated message honestly and never pass one off as a person. NOT NULL
-- DEFAULT false: existing rows and all human writes are correctly false with no
-- backfill. NOT VALID CHECK is unnecessary — a boolean default already constrains it.
alter table public.messages
  add column if not exists auto_generated boolean not null default false;
