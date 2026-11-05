-- 20261290000000_calls_conversation_fk_to_receptionist.sql
--
-- FIX: phone call -> conversation foreign-key linkage silently fails.
--
-- ROOT CAUSE. The telephony linkage writer `updateCallAssociation`
-- (server/services/telephony.ts) — called from the Twilio voice, Twilio status
-- and Vapi webhooks — stores the conversation id returned by
-- `processInboundEnquiry` into `calls.conversation_id`. That id is a
-- `receptionist_conversations.id` (produced by the `resolve_receptionist_conversation`
-- RPC). But the baseline FK `calls_conversation_id_fkey` referenced
-- `public.conversations(id)` — the generic customer/lead messaging table, a
-- DIFFERENT table. So every link UPDATE raised foreign_key_violation and rolled
-- back, silently taking the `lead_id` link with it (both columns were written in
-- one statement). Net effect: no inbound phone call ever linked to its lead or
-- its receptionist conversation, so the tenant-facing /leads/[id] Calls section
-- (which filters `calls.lead_id = id`) could never show a call's duration,
-- transcript, summary or recording.
--
-- FIX. Repoint the FK to the table the id actually comes from,
-- `receptionist_conversations`, and make it ORG-SCOPED so a call can only ever
-- reference a conversation in its OWN organisation — no cross-tenant linkage is
-- representable at the database, matching the single-tenant resolution path.
--
-- Forward-only and safe to re-run. There are no valid pre-existing values to
-- preserve (every historical write FK-violated), but any stray non-NULL
-- conversation_id that is not a real receptionist_conversations row is nulled
-- first so the new constraint validates cleanly regardless of environment state.

-- 1. Drop the mis-targeted baseline FK.
alter table public."calls" drop constraint if exists "calls_conversation_id_fkey";

-- 2. Null any value that would not satisfy the new target (none in practice).
update public."calls" c
set conversation_id = null
where c.conversation_id is not null
  and not exists (
    select 1 from public.receptionist_conversations rc
    where rc.id = c.conversation_id
  );

-- 3. Composite unique target so the FK can be org-scoped. `id` is already the
--    PK, so (org_id, id) is trivially unique; this index exists only so the FK
--    below has a unique key to reference.
create unique index if not exists receptionist_conversations_org_id_id_key
  on public.receptionist_conversations (org_id, id);

-- 4. Re-add the FK as an ORG-SCOPED composite. MATCH SIMPLE (the default) leaves
--    the constraint UNenforced while conversation_id IS NULL (the common case),
--    so an un-linked call is unaffected; once conversation_id is set, BOTH
--    org_id and conversation_id must match a single receptionist_conversations
--    row, so a cross-tenant link cannot be represented. ON DELETE SET NULL
--    (conversation_id) clears only the conversation link when the conversation
--    is deleted — org_id is NOT NULL and must never be nulled (PG15+ column-list
--    SET NULL; this database is PG17).
alter table public."calls"
  add constraint "calls_conversation_id_fkey"
  foreign key (org_id, conversation_id)
  references public.receptionist_conversations (org_id, id)
  on delete set null (conversation_id);
