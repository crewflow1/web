-- CrewFlow HQ — Voice Receptionist AI: the HUMAN HANDOFF & REPLY REVIEW INBOX substrate
-- (CEO Directive #018, the AI Receptionist Programme — increment R14:
--  HUMAN HANDOFF & REPLY REVIEW INBOX).
--
-- R3 gave the receptionist a three-verdict policy — allow | review | block. R4 made every
-- attempted reply produce a MANDATORY audit row. R5/R6 carried the ONE auto-sendable class
-- (`allow`) out through the SMS transport, gated in the database so a transport can only ever
-- exist for an `allowed = true` audit. R10–R13 threaded a persistent CONVERSATION substrate, a
-- READ model, a context assembler, and a conversation-aware draft GENERATOR beneath that pipeline.
--
-- One half of the policy was never completed: `review` — "the AI drafts, a HUMAN sends". A
-- review-verdict reply is drafted, enforced and audited (verdict='review', allowed=false), and
-- then it STOPS at the deny-by-default gate. Nothing surfaced it, nobody could own it, and there
-- was no path by which a human could send it. R14 lays the substrate for that missing half: a
-- durable, org-scoped REVIEW QUEUE (a projection over the audit ledger the review reply already
-- wrote), conversation OWNERSHIP/ASSIGNMENT so a human can claim a thread, and an append-only
-- RESOLUTION ledger that records — auditably — what a human decided to do with each held reply.
--
-- IT IS SUBSTRATE + PROJECTION, NOT A SECOND PIPELINE. This migration opens NO new outbound path.
-- The human send REUSES the canonical Enforce → Audit → Transport chain in TypeScript (a new
-- `dispatchHumanReviewedReply` seam in server/services/receptionist.ts): the human's send produces
-- a NEW `ai_reply_audits` row and rides the SAME `ai_reply_transports` ledger through the SAME
-- unbypassable DB transport gate (which still demands an `allowed = true` audit). The absolute
-- `block` prohibition remains unbypassable — never sent, not even by a human. So there is exactly
-- one transport, one audit of record, one policy seam. This migration adds the state a human inbox
-- needs AROUND that pipeline; it never routes around it.
--
-- Reuses the established idioms, feature for feature:
--   • The REVIEW QUEUE is a `security_invoker` VIEW — the R9/R11 projection idiom. It holds no
--     rows, joins the append-only audit ledger to the conversation container and the resolution
--     ledger, is not simply-updatable (so there is no write-through), inherits the caller's RLS,
--     and is granted SELECT to service_role only. A held reply already exists as an audit row;
--     the queue never copies it.
--   • The RESOLUTION ledger mirrors the reply ledgers (ai_reply_audits/transports/receipts):
--     RLS enabled with ZERO policies, APPEND-ONLY (UPDATE/DELETE rejected by triggers even under
--     service_role), a single validated SECURITY DEFINER writer, EXECUTE granted only to
--     service_role. Its org/conversation/audit references are DENORMALISED, un-FK'd facts so the
--     audit of a human decision outlives the rows it describes.
--   • OWNERSHIP is nullable assignment columns on the operational `receptionist_conversations`
--     container, written through a single SECURITY DEFINER entry point — the R10 substrate idiom.
--
-- Provably additive (P2): one nullable column on `ai_reply_audits` (its conversation link, which
-- R13 already threads in TypeScript but did not persist), three nullable columns on
-- `receptionist_conversations` (ownership), one brand-new append-only ledger, one view, and three
-- functions (one of which REPLACES `record_ai_reply_audit` to accept the new conversation param).
-- Every existing row and every existing code path is byte-for-byte unchanged until the service
-- populates the new fields; nothing here changes how a reply is enforced, audited, or transported.

-- ---------------------------------------------------------------------------
-- 1. ai_reply_audits.conversation_id — PERSIST the audit → conversation link.
--    R13 already threads `conversation_id` into the reply's ReplyAuditContext (to fetch the R12
--    context the draft reasons over) but explicitly does NOT persist it. R14 needs a reliable
--    audit → conversation link so the review inbox can open the exact conversation a held reply
--    belongs to. This is that link: a nullable, un-FK'd fact (the same durability rule the other
--    audit anchors follow — an append-only audit outlives the rows it references, so no
--    `on delete cascade`). NULL on every existing row; populated forward by the canonical service.
-- ---------------------------------------------------------------------------
alter table public.ai_reply_audits
  add column if not exists conversation_id uuid;

create index if not exists ai_reply_audits_conversation_idx
  on public.ai_reply_audits (conversation_id)
  where conversation_id is not null;

-- REPLACE the single audit writer to accept the new conversation anchor. The parameter is added
-- with a DEFAULT so the write stays additive at the call site; the TypeScript passes it by name.
-- The old 14-arg signature is dropped first because appending a parameter mints a NEW overload
-- (PostgREST would then see two candidates) — so we drop the exact prior signature and recreate.
drop function if exists public.record_ai_reply_audit(
  uuid, text, text, uuid, text, text, boolean, text, text[], text, uuid, uuid, text, jsonb
);

create or replace function public.record_ai_reply_audit(
  p_org_id          uuid,
  p_employee_slug   text,
  p_channel         text,
  p_correlation_id  uuid,
  p_draft           text,
  p_verdict         text,
  p_allowed         boolean,
  p_reason          text,
  p_categories      text[]  default '{}',
  p_safe_text       text    default null,
  p_enquiry_id      uuid    default null,
  p_lead_id         uuid    default null,
  p_customer_ref    text    default null,
  p_metadata        jsonb   default '{}',
  p_conversation_id uuid    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.ai_reply_audits (
    org_id, employee_slug, channel, correlation_id, draft, verdict, allowed,
    reason, categories, safe_text, enquiry_id, lead_id, customer_ref, metadata,
    conversation_id
  ) values (
    p_org_id, p_employee_slug, p_channel, p_correlation_id, p_draft, p_verdict, p_allowed,
    p_reason, coalesce(p_categories, '{}'::text[]), p_safe_text, p_enquiry_id, p_lead_id,
    p_customer_ref, coalesce(p_metadata, '{}'::jsonb), p_conversation_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_ai_reply_audit(
  uuid, text, text, uuid, text, text, boolean, text, text[], text, uuid, uuid, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.record_ai_reply_audit(
  uuid, text, text, uuid, text, text, boolean, text, text[], text, uuid, uuid, text, jsonb, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 2. receptionist_conversations ownership — CONVERSATION OWNERSHIP & ASSIGNMENT.
--    A human handling the review inbox CLAIMS a conversation. Three nullable columns on the
--    existing operational container carry that ownership: who owns it, when they took it, and who
--    assigned it. NULL = unowned (the AI-only default every existing row keeps). Unlike the
--    append-only ledgers, this is a mutable operational table, so a normal FK to public.users is
--    appropriate (matching jobs.assigned_to) with ON DELETE SET NULL so a departed user's threads
--    simply become unowned rather than vanishing.
-- ---------------------------------------------------------------------------
alter table public.receptionist_conversations
  add column if not exists assignee_id uuid references public.users(id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid references public.users(id) on delete set null;

create index if not exists receptionist_conversations_assignee_idx
  on public.receptionist_conversations (assignee_id)
  where assignee_id is not null;

-- assign_receptionist_conversation — the single validated OWNERSHIP write entry point.
-- SECURITY DEFINER, service_role-only. Org-scoped (the WHERE pins org_id so a caller can only
-- ever (re)assign a conversation in the organisation it names). A NULL assignee RELEASES the
-- conversation (clears the ownership stamp). Returns the conversation id when a row matched, else
-- NULL (no such conversation in this org) so the caller can distinguish a no-op.
create or replace function public.assign_receptionist_conversation(
  p_conversation_id uuid,
  p_org_id          uuid,
  p_assignee_id     uuid,
  p_assigned_by     uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.receptionist_conversations
     set assignee_id = p_assignee_id,
         assigned_at = case when p_assignee_id is null then null else now() end,
         assigned_by = case when p_assignee_id is null then null else p_assigned_by end,
         updated_at  = now()
   where id = p_conversation_id
     and org_id = p_org_id
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.assign_receptionist_conversation(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assign_receptionist_conversation(uuid, uuid, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. receptionist_review_resolutions — the append-only HUMAN-DECISION ledger. One row per held
--    reply a human RESOLVED: they either SENT it (as-is or edited) or DISMISSED it. This is the
--    audit of the human action itself — separate from, and additional to, the `ai_reply_audits`
--    row the human send produces. It never carries message content: it REFERENCES the held reply
--    (`review_audit_id`) and, on a send, the NEW audit the send produced (`sent_audit_id`).
--    UNIQUE(review_audit_id) makes resolution TERMINAL and single: a held reply is resolved
--    exactly once, and two concurrent reviewers can never both resolve the same reply.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_review_resolutions (
  id              uuid        primary key default gen_random_uuid(),
  -- WHO / WHERE — durable, un-FK'd facts (the audit of a decision outlives the rows it concerns).
  org_id          uuid        not null,
  conversation_id uuid,                                  -- the thread the held reply belongs to
  -- THE held reply this resolves — the ai_reply_audits row whose verdict was `review`. A soft
  -- (un-FK'd) reference: the audit ledger is append-only and deliberately un-FK'd, so this ledger
  -- references it as a durable fact without coupling to it. UNIQUE below ⇒ resolved at most once.
  review_audit_id uuid        not null,
  -- The human's decision.
  resolution      text        not null
                              check (resolution in ('sent', 'dismissed')),
  -- On a SEND: the NEW ai_reply_audits row the human send produced (its draft IS the sent text,
  -- its transport IS the send). NULL on a dismiss. Un-FK'd for the same durability reason.
  sent_audit_id   uuid,
  -- Did the human change the proposed draft before sending? Observability for "edits remain
  -- auditable" — the sent text lives verbatim in sent_audit_id's draft; this flags that it differs.
  edited          boolean     not null default false,
  -- WHO decided — the HQ user id + a denormalised email so the decision is attributable even after
  -- the user row is gone (the admin_activity_log durability rule).
  resolved_by       uuid      not null,
  resolved_by_email text,
  -- Optional free-text (e.g. a dismiss reason).
  note            text,
  created_at      timestamptz not null default now(),
  -- Coupling integrity, in DDL: a send carries the audit it produced; a dismiss never does.
  constraint receptionist_review_resolutions_sent_audit_coupling check (
    (resolution = 'sent'      and sent_audit_id is not null) or
    (resolution = 'dismissed' and sent_audit_id is null)
  )
);

-- TERMINAL & SINGLE: a held reply is resolved exactly once. The unique index is the race backstop
-- (two reviewers, one held reply) and the "already resolved" signal the writer returns NULL on.
create unique index if not exists receptionist_review_resolutions_audit_uidx
  on public.receptionist_review_resolutions (review_audit_id);
create index if not exists receptionist_review_resolutions_org_created_idx
  on public.receptionist_review_resolutions (org_id, created_at desc);
create index if not exists receptionist_review_resolutions_conversation_idx
  on public.receptionist_review_resolutions (conversation_id)
  where conversation_id is not null;

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER writer are
-- the only paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled
-- table with no policies defaults to deny. No table grant can open it.
alter table public.receptionist_review_resolutions enable row level security;

-- Append-only guard — a recorded human decision is a fact about one moment, never rewritten or
-- erased (reject UPDATE/DELETE even under service_role). Mirrors the reply ledgers' guards.
create or replace function public.receptionist_review_resolutions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_review_resolutions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_review_resolutions_no_update on public.receptionist_review_resolutions;
create trigger receptionist_review_resolutions_no_update
  before update on public.receptionist_review_resolutions
  for each row execute function public.receptionist_review_resolutions_block_mutation();

drop trigger if exists receptionist_review_resolutions_no_delete on public.receptionist_review_resolutions;
create trigger receptionist_review_resolutions_no_delete
  before delete on public.receptionist_review_resolutions
  for each row execute function public.receptionist_review_resolutions_block_mutation();

-- record_receptionist_review_resolution — the single validated write entry point for the human
-- decision ledger. SECURITY DEFINER, service_role-only. Idempotent-by-uniqueness: an ON CONFLICT
-- DO NOTHING on `review_audit_id` means a second resolution of the same held reply is a no-op that
-- returns NULL — the caller reads NULL as "already resolved" and does not double-send. Returns the
-- new resolution id on success.
create or replace function public.record_receptionist_review_resolution(
  p_org_id           uuid,
  p_review_audit_id  uuid,
  p_resolution       text,
  p_resolved_by      uuid,
  p_conversation_id  uuid    default null,
  p_sent_audit_id    uuid    default null,
  p_edited           boolean default false,
  p_resolved_by_email text   default null,
  p_note             text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_resolution not in ('sent', 'dismissed') then
    raise exception 'receptionist review resolution must be sent|dismissed, got %', p_resolution
      using errcode = 'check_violation';
  end if;

  insert into public.receptionist_review_resolutions (
    org_id, conversation_id, review_audit_id, resolution, sent_audit_id, edited,
    resolved_by, resolved_by_email, note
  ) values (
    p_org_id, p_conversation_id, p_review_audit_id, p_resolution, p_sent_audit_id,
    coalesce(p_edited, false), p_resolved_by, p_resolved_by_email, p_note
  )
  on conflict (review_audit_id) do nothing
  returning id into v_id;

  return v_id;  -- NULL when the held reply was already resolved (ON CONFLICT DO NOTHING)
end;
$$;

revoke all on function public.record_receptionist_review_resolution(
  uuid, uuid, text, uuid, uuid, uuid, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.record_receptionist_review_resolution(
  uuid, uuid, text, uuid, uuid, uuid, boolean, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. receptionist_review_queue — the REVIEW QUEUE read model. One row per HELD reply (every
--    `ai_reply_audits` row whose verdict is `review`), with:
--      • the held draft + the guardrail's reason/categories (WHY a human must look);
--      • the conversation it belongs to, resolved from the audit's own `conversation_id` and,
--        for rows predating that column, falling back to the enquiry's conversation link — plus
--        the container's contact identity and ownership stamp (so the queue shows who owns it);
--      • its resolution state (NULL ⇒ still pending; present ⇒ sent/dismissed, by whom, when).
--
--    It is a PROJECTION, exactly as the R9 lifecycle and R11 timeline views: a security_invoker
--    view over append-only + substrate relations, not simply-updatable (joins + LATERAL ⇒ no
--    write-through), inheriting the caller's RLS (the base tables are RLS:hq with zero policies,
--    so only service_role / BYPASSRLS sees rows), and granted SELECT to service_role only. It
--    holds no rows and copies no reply — the held reply lives in the audit ledger; this reads it.
-- ---------------------------------------------------------------------------
create or replace view public.receptionist_review_queue
  with (security_invoker = true) as
select
  a.id                    as review_audit_id,
  a.org_id                as org_id,
  a.employee_slug         as employee_slug,
  a.channel               as channel,
  a.enquiry_id            as enquiry_id,
  a.lead_id               as lead_id,
  a.customer_ref          as customer_ref,
  a.correlation_id        as correlation_id,
  a.draft                 as draft,
  a.categories            as categories,
  a.reason                as reason,
  a.safe_text             as safe_text,
  a.metadata              as metadata,
  a.created_at            as held_at,

  -- The conversation this held reply belongs to. Prefer the audit's own link (R14 persists it);
  -- fall back to the enquiry's conversation for rows that predate the column but carry an enquiry.
  coalesce(a.conversation_id, e.conversation_id) as conversation_id,
  c.contact_ref           as contact_ref,
  c.contact_name          as contact_name,
  c.status                as conversation_status,
  c.message_count         as message_count,
  c.last_message_at       as last_message_at,

  -- Ownership stamp — who (if anyone) has claimed this conversation.
  c.assignee_id           as assignee_id,
  c.assigned_at           as assigned_at,
  c.assigned_by           as assigned_by,

  -- Resolution state — NULL columns mean the reply is still PENDING review.
  res.id                  as resolution_id,
  res.resolution          as resolution,
  res.sent_audit_id       as sent_audit_id,
  res.edited              as resolution_edited,
  res.resolved_by         as resolved_by,
  res.resolved_by_email   as resolved_by_email,
  res.note                as resolution_note,
  res.created_at          as resolved_at
from public.ai_reply_audits a
  left join public.inbound_enquiries e
    on e.id = a.enquiry_id
  left join public.receptionist_conversations c
    on c.id = coalesce(a.conversation_id, e.conversation_id)
  left join lateral (
    select r.id, r.resolution, r.sent_audit_id, r.edited, r.resolved_by,
           r.resolved_by_email, r.note, r.created_at
    from public.receptionist_review_resolutions r
    where r.review_audit_id = a.id
    order by r.created_at desc
    limit 1
  ) res on true
where a.verdict = 'review';

comment on view public.receptionist_review_queue is
  'R14 review queue (Directive #018). A security_invoker projection of ai_reply_audits (verdict '
  '= review) ⟕ its conversation container ⟕ latest receptionist_review_resolutions. Holds no rows '
  'of its own and has no write path (multi-relation join + LATERAL, no INSTEAD OF trigger); the '
  'held reply lives in the append-only audit ledger. Readable only by service_role (the HQ admin '
  'client); RLS on the base tables denies every JWT client through the view.';

revoke all on public.receptionist_review_queue from public, anon, authenticated, service_role;
grant select on public.receptionist_review_queue to service_role;
