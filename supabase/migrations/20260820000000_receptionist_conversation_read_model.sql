-- CrewFlow HQ — Voice Receptionist AI: the CONVERSATION TIMELINE READ MODEL
-- (CEO Directive #018, the AI Receptionist Programme — increment R11:
--  CONVERSATION TIMELINE READ MODEL).
--
-- R10 laid a WRITE-ONLY substrate: a persistent, org-scoped CONVERSATION container
-- (receptionist_conversations) plus a threaded MESSAGE index (receptionist_messages) that
-- REFERENCES its authoritative content (an inbound enquiry, or a reply audit) rather than
-- copying it. Nothing READ it — there was no way to reconstruct a conversation's history.
-- R11 turns that substrate into the canonical conversation READ layer: the single, shared,
-- authoritative mechanism for reconstructing a receptionist conversation. No feature may roll
-- its own reconstruction logic; every future consumer (an HQ view, channel continuity, memory
-- retrieval, human handoff, a portal projection) reads THROUGH this read model.
--
-- IT IS A PROJECTION, NOT BEHAVIOUR. The deterministic acknowledgement, the canonical
-- Draft → Policy → Audit → Transport → Delivery-Receipt pipeline, the three append-only
-- ledgers, and the R10 substrate are ALL UNTOUCHED. This read model sits BENEATH the pipeline
-- as shared infrastructure that resolves content AT READ TIME. It stores nothing, duplicates
-- no message body, and introduces no second source of truth: a timeline entry resolves its
-- inbound text from public.inbound_enquiries and its outbound reply/transport/receipt from the
-- R9 lifecycle projection — both by reference, keyed off the substrate's own pointers.
--
-- Reuses the established projection architecture already in the repository — the shape mirrors,
-- guarantee for guarantee, the R9 delivery-lifecycle view (public.ai_reply_lifecycle,
-- 20260818000000): a `security_invoker = true` VIEW that holds no rows, joins append-only /
-- substrate relations, and is granted SELECT to service_role only. Read-only by THREE
-- structural guarantees, exactly as R9:
--   1. Each view joins multiple relations (with LATERAL), so it is NOT a simply-updatable view:
--      Postgres refuses INSERT / UPDATE / DELETE through it — there is no write-through.
--   2. `security_invoker = true` runs the view with the QUERYING role's privileges, so it
--      inherits the caller's RLS and can never launder a JWT client past the base tables'
--      RLS:hq deny (receptionist_* have RLS enabled with zero policies; only service_role,
--      which is BYPASSRLS, sees rows).
--   3. Only SELECT is granted, and only to service_role — anon / authenticated get nothing.
--
-- Provably additive (P2): two brand-new VIEWS, zero tables, zero functions, zero columns, zero
-- triggers. No ledger, substrate table, or pipeline object is altered. No producer is wired and
-- no outbound path is opened — a read model cannot send. Every existing row and code path is
-- byte-for-byte unchanged; the views simply expose, for reading, what the substrate already
-- records.

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_timeline — the ordered EVENT STREAM of one conversation.
--    One row per receptionist_messages entry, with its authoritative content RESOLVED (not
--    copied) at read time:
--      • inbound  → resolved from public.inbound_enquiries via m.enquiry_id
--                   (its raw_text IS the customer's message);
--      • outbound → resolved from public.ai_reply_lifecycle via m.audit_id
--                   (its draft + guardrail decision IS the AI reply, plus the transport and
--                    delivery-receipt references the R9 projection already joins for us).
--
--    Because ai_reply_lifecycle is audits ⟕ transports (one row PER transport of an audit), a
--    single outbound message could match several lifecycle rows once retries exist. To keep the
--    timeline DETERMINISTIC — exactly one row per message, always reconstructing identically —
--    the outbound resolution is collapsed by a LATERAL … LIMIT 1 that picks the latest transport
--    (transport_at desc) with a total-order tiebreak on transport_id. An outbound entry whose
--    audit never produced a transport (e.g. a blocked reply) still resolves its audit fields,
--    with NULL transport / receipt — the correct picture of a reply that was drafted but not sent.
--
--    The view carries NO ORDER BY: the canonical event order (event_at asc, then message_id asc
--    as a stable tiebreak for same-instant entries) is applied by the read layer, so ordering is
--    defined in exactly ONE place and cannot be silently dropped when the view is wrapped.
-- ---------------------------------------------------------------------------
create or replace view public.receptionist_conversation_timeline
  with (security_invoker = true) as
select
  m.id                          as message_id,
  m.conversation_id,
  m.org_id,
  m.direction,
  m.channel,
  m.created_at                  as event_at,

  -- Inbound resolution — the customer's message, referenced from the enquiries table.
  m.enquiry_id,
  e.raw_text                    as inbound_text,
  e.caller                      as inbound_caller,
  e.ai_summary                  as inbound_summary,
  e.job_type                    as inbound_job_type,
  e.urgency                     as inbound_urgency,
  e.postcode                    as inbound_postcode,
  e.ai_confidence               as inbound_confidence,
  e.status                      as inbound_status,
  e.created_at                  as inbound_at,

  -- Outbound resolution — the AI reply + its guardrail decision, referenced from the R9
  -- lifecycle projection (which itself resolves the audit, transport and delivery receipt).
  m.audit_id,
  life.employee_slug            as outbound_employee_slug,
  life.correlation_id           as outbound_correlation_id,
  life.customer_ref             as outbound_customer_ref,
  life.draft                    as outbound_draft,
  life.verdict                  as outbound_verdict,
  life.allowed                  as outbound_allowed,
  life.categories               as outbound_categories,
  life.enforcement_reason       as outbound_enforcement_reason,
  life.safe_text                as outbound_safe_text,
  life.audit_at                 as outbound_audit_at,

  -- Transport reference (how the reply left the building).
  life.transport_id,
  life.transport_status,
  life.transport_provider,
  life.provider_message_id,
  life.transport_failure_reason,
  life.transport_at,

  -- Delivery-receipt reference (what the provider said happened to it).
  life.receipt_id,
  life.delivery_status,
  life.delivery_terminal,
  life.delivery_provider_status,
  life.delivery_error_code,
  life.receipt_at,
  life.receipt_count
from public.receptionist_messages m
  left join public.inbound_enquiries e
    on e.id = m.enquiry_id
  left join lateral (
    select
      l.employee_slug,
      l.correlation_id,
      l.customer_ref,
      l.draft,
      l.verdict,
      l.allowed,
      l.categories,
      l.enforcement_reason,
      l.safe_text,
      l.audit_at,
      l.transport_id,
      l.transport_status,
      l.transport_provider,
      l.provider_message_id,
      l.transport_failure_reason,
      l.transport_at,
      l.receipt_id,
      l.delivery_status,
      l.delivery_terminal,
      l.delivery_provider_status,
      l.delivery_error_code,
      l.receipt_at,
      l.receipt_count
    from public.ai_reply_lifecycle l
    where l.audit_id = m.audit_id
    order by l.transport_at desc nulls last, l.transport_id desc nulls last
    limit 1
  ) life on true;

-- Read-only, service_role-only (guarantee 3). anon / authenticated get nothing; service_role
-- (BYPASSRLS) is the sole reader, exactly as the R9 lifecycle projection.
revoke all on public.receptionist_conversation_timeline
  from public, anon, authenticated, service_role;
grant select on public.receptionist_conversation_timeline to service_role;

-- ---------------------------------------------------------------------------
-- 2. receptionist_conversation_list — the org-scoped CONVERSATION INDEX. One row per
--    conversation container, carrying its metadata (status, message_count, first/last activity)
--    and contact identity (channel, contact_ref, contact_name), plus a LATERAL pick of the last
--    message's direction and instant so a caller can order and preview conversations without
--    walking each timeline. Counters and timestamps are read straight from the container that
--    append_receptionist_message already maintains — the list never recomputes them, so the
--    container remains the single source of truth for "how many" and "when last".
-- ---------------------------------------------------------------------------
create or replace view public.receptionist_conversation_list
  with (security_invoker = true) as
select
  c.id                          as conversation_id,
  c.org_id,
  c.employee_slug,
  c.channel,
  c.contact_ref,
  c.contact_name,
  c.status,
  c.message_count,
  c.first_message_at,
  c.last_message_at,
  c.created_at,
  c.updated_at,
  last_msg.direction            as last_direction,
  last_msg.event_at             as last_event_at
from public.receptionist_conversations c
  left join lateral (
    select m.direction, m.created_at as event_at
    from public.receptionist_messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) last_msg on true;

revoke all on public.receptionist_conversation_list
  from public, anon, authenticated, service_role;
grant select on public.receptionist_conversation_list to service_role;
