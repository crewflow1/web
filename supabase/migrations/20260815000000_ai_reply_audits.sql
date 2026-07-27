-- CrewFlow HQ — Voice Receptionist AI: the canonical reply audit ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R4:
--  REPLY PRODUCTION & AUDIT PIPELINE).
--
-- R3 made the harvested guardrail LOAD-BEARING: every AI-drafted customer reply
-- must pass the single enforcement chokepoint `enforceReceptionistReply`
-- (server/services/receptionist.ts). R4 completes the INTERNAL pipeline —
-- Draft → Enforce → Audit — by giving every attempted reply a MANDATORY, durable,
-- append-only home. This migration is that home.
--
-- THE AUDIT RULE (Directive #018, R4). "Every AI-generated customer reply must
-- become traceable. No reply may leave the pipeline without producing an audit
-- record. The audit trail is mandatory. It is not optional. It is not best
-- effort. It is not configurable." This migration is that rule made storage.
--
-- Why a DEDICATED table and NOT the HQ Event Spine (`hq_events`). The spine is the
-- best-effort narrative floor: `emitEvent` NEVER throws — a spine hiccup must not
-- break a handler's primary work (20260720000000_hq_event_spine_core.sql, and
-- server/services/event-spine.ts). R4's audit is the OPPOSITE contract: it is
-- MANDATORY, so its write must be able to FAIL LOUDLY and stop the reply. A
-- mandatory record cannot rest on a best-effort producer. So the ledger is its own
-- first-class store with a throw-on-failure write, exactly as the executor-shadow
-- observation store (20260813000000) is its own first-class store rather than an
-- in-band spine fragment. A best-effort spine PROJECTION of the ledger (a
-- `receptionist.reply.*` verb group) is a deliberate later increment behind its own
-- ADR — it must never become the audit of record.
--
-- Reuses the existing AUDIT architecture (Directive #018, R4: "reuse existing audit
-- architecture wherever possible") — the hardening mirrors, line for line, the
-- executor-shadow store and the HQ Event Spine:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER
--     write primitive are the only writers/readers; every JWT client (anon /
--     authenticated) is denied (the admin_activity_log / hq_events / shadow idiom).
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role,
--     so a recorded verdict can never be rewritten or erased ("never silently
--     overwrite history").
--   • A single validated SECURITY DEFINER write entry point, EXECUTE revoked from
--     PUBLIC / anon / authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + function + triggers. No tenant table
-- is touched, no producer is wired by this migration (the canonical service wires
-- the store in TypeScript). References to organisation / conversation / customer are
-- carried as DENORMALISED, un-FK'd facts (the admin_activity_log rule: "historical
-- entries survive a user deletion") — an append-only audit must outlive the rows it
-- describes, so no `on delete cascade` can ever erase audit history.

-- ---------------------------------------------------------------------------
-- 1. ai_reply_audits — one append-only record per ATTEMPTED reply. RLS:hq.
--    Captures WHAT was drafted, the enforcement DECISION (verbatim from the R3
--    seam), and the anchors that thread it to the organisation, conversation and
--    customer it concerns. `allowed` is CHECK-pinned to the deny-by-default law
--    (`allowed = (verdict = 'allow')`), so a row here can NEVER misrepresent a
--    held/refused reply as auto-sent.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_reply_audits (
  id             uuid        primary key default gen_random_uuid(),
  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id         uuid        not null,                 -- the organisation
  employee_slug  text        not null,                 -- the AI employee (voice-receptionist-ai)
  channel        text        not null,                 -- the inbound channel the reply answers
  enquiry_id     uuid,                                  -- the conversation (inbound_enquiries.id)
  lead_id        uuid,                                  -- the customer (leads.id)
  customer_ref   text,                                  -- the caller identifier (phone / handle / email)
  correlation_id uuid        not null,                 -- the end-to-end trace id
  -- WHAT was produced.
  draft          text        not null,                 -- the AI-drafted reply, exactly as enforced
  -- The enforcement DECISION — the R3 seam's verdict, carried verbatim for audit.
  verdict        text        not null
                             check (verdict in ('allow', 'review', 'block')),
  -- DENY BY DEFAULT, in DDL: the outcome is auto-sendable ONLY for a clean `allow`.
  -- Pinned so the ledger cannot record an "allowed" review or block.
  allowed        boolean     not null
                             check (allowed = (verdict = 'allow')),
  categories     text[]      not null default '{}',    -- the guardrail concern classes
  reason         text        not null,                 -- the guardrail's justification (reasoning)
  safe_text      text,                                  -- the auto-sendable remainder, if any
  -- Execution metadata — the producer path, dedup keys, model attribution (later), etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now()
);

create index if not exists ai_reply_audits_org_created_idx
  on public.ai_reply_audits (org_id, created_at desc);
create index if not exists ai_reply_audits_correlation_idx
  on public.ai_reply_audits (correlation_id);
create index if not exists ai_reply_audits_enquiry_idx
  on public.ai_reply_audits (enquiry_id)
  where enquiry_id is not null;
-- Outcome analytics — how many replies were held (`review`) or refused (`block`).
create index if not exists ai_reply_audits_verdict_idx
  on public.ai_reply_audits (verdict, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER
-- write primitive are the only paths in; every JWT client (anon / authenticated) is
-- denied because an RLS-enabled table with no policies defaults to deny. No table
-- grant can open it. (A per-organisation read PROJECTION is a deliberate later
-- increment; the ledger of record stays HQ-internal.)
alter table public.ai_reply_audits enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a recorded reply audit is a fact about one attempt,
--    never updated or deleted. Reject UPDATE/DELETE even under service_role so a
--    recorded verdict can never be rewritten to resemble something it is not
--    ("append-only … never silently overwrite history"). Mirrors the executor
--    shadow store's and the spine's append-only guards.
-- ---------------------------------------------------------------------------
create or replace function public.ai_reply_audits_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_reply_audits is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists ai_reply_audits_no_update on public.ai_reply_audits;
create trigger ai_reply_audits_no_update
  before update on public.ai_reply_audits
  for each row execute function public.ai_reply_audits_block_mutation();

drop trigger if exists ai_reply_audits_no_delete on public.ai_reply_audits;
create trigger ai_reply_audits_no_delete
  before delete on public.ai_reply_audits
  for each row execute function public.ai_reply_audits_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_ai_reply_audit — the single validated write entry point.
--    SECURITY DEFINER, service_role-only (EXECUTE revoked from PUBLIC, anon,
--    authenticated). The canonical receptionist service calls this AND ONLY this to
--    file a reply audit; the write is MANDATORY there (the TypeScript throws if this
--    returns an error), so no reply can proceed unaudited. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.record_ai_reply_audit(
  p_org_id         uuid,
  p_employee_slug  text,
  p_channel        text,
  p_correlation_id uuid,
  p_draft          text,
  p_verdict        text,
  p_allowed        boolean,
  p_reason         text,
  p_categories     text[]  default '{}',
  p_safe_text      text    default null,
  p_enquiry_id     uuid    default null,
  p_lead_id        uuid    default null,
  p_customer_ref   text    default null,
  p_metadata       jsonb   default '{}'
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
    reason, categories, safe_text, enquiry_id, lead_id, customer_ref, metadata
  ) values (
    p_org_id, p_employee_slug, p_channel, p_correlation_id, p_draft, p_verdict, p_allowed,
    p_reason, coalesce(p_categories, '{}'::text[]), p_safe_text, p_enquiry_id, p_lead_id,
    p_customer_ref, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_ai_reply_audit(
  uuid, text, text, uuid, text, text, boolean, text, text[], text, uuid, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_ai_reply_audit(
  uuid, text, text, uuid, text, text, boolean, text, text[], text, uuid, uuid, text, jsonb
) to service_role;
