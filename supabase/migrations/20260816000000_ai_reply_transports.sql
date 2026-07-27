-- CrewFlow HQ — Voice Receptionist AI: the outbound transport ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R5:
--  FIRST OUTBOUND TRANSPORT).
--
-- R4 completed the INTERNAL reply pipeline — Draft → Enforce → Audit — and gave
-- every attempted reply a mandatory, append-only home (`ai_reply_audits`,
-- 20260815000000). R5 proves the FIRST complete end-to-end communication path: it
-- carries an enforced, audited, auto-sendable reply out through exactly one
-- outbound transport (SMS / missed-call text-back, via the reused lib/comms
-- provider seam). This migration is that path's permanent record.
--
-- THE TRANSPORT RULE (Directive #018, R5). "There must be no execution path capable
-- of reaching a transport adapter without first passing through both the canonical
-- enforcement seam and the mandatory audit ledger." A transport attempt is not a
-- free-standing act: it is the DOWNSTREAM consequence of an enforced, AUTO-SENDABLE
-- reply. This migration makes that law load-bearing IN THE DATABASE — a transport
-- row may only be inserted against an `ai_reply_audits` row whose enforcement
-- verdict is `allow` (`allowed = true`). The gate is a BEFORE INSERT trigger that no
-- caller — not even the service-role admin client, which BYPASSES RLS — can evade.
-- It is the same boundary technique the Communication Layer uses to pin every
-- delivery to an approved action (hq_communications_guard, 20260801000000): a CHECK
-- cannot subquery; a trigger can. This is validation criterion #3 ("no transport can
-- bypass enforcement") made unbypassable.
--
-- Why a DEDICATED transport ledger and NOT `hq_communications`. The Communication
-- Layer's delivery table is welded to the Approval Engine: `approval_id` is a NOT
-- NULL FK and its BEFORE INSERT guard rejects any row whose `hq_approvals` state is
-- not `approved`; its channel CHECK admits `email` only. The receptionist does NOT
-- use the Approval Engine — its human-safety gate is the R3 guardrail seam, and its
-- mandatory audit of record is `ai_reply_audits`, NOT `hq_events` (a CEO-approved R4
-- separation). Routing a receptionist SMS through `hq_communications` would demand
-- fabricating fake approval rows to satisfy a gate that means something else — a
-- worse violation than a purpose-built ledger. So R5 REUSES the established PATTERN
-- (an append-only, RLS:hq, enforcement-gated, cost-accounted ledger with a single
-- SECURITY DEFINER writer) rather than the wrong TABLE, exactly as the receptionist
-- already has its own audit store beside the spine. This is reuse-of-pattern, not
-- parallel transport infrastructure: the provider ABSTRACTION (lib/comms) is shared,
-- not duplicated.
--
-- Reuses the existing AUDIT architecture (the hardening mirrors, line for line,
-- `ai_reply_audits` and the executor-shadow store):
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER
--     write primitive are the only writers/readers; every JWT client is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--     A transport attempt is a fact about one moment; it is never rewritten or erased.
--     (Unlike hq_communications, this ledger has NO settle-back state machine: the
--     receptionist deliberately does not consume provider delivery webhooks in R5, so
--     there is no live `sent → delivered` transition to model. A future increment that
--     ingests receipts would add a superseding row, never mutate this one.)
--   • A single validated SECURITY DEFINER write entry point, EXECUTE revoked from
--     PUBLIC / anon / authenticated and granted only to service_role.
--
-- MANDATORY, even in failure (validation criterion #4: "failed transport attempts
-- remain fully audited"). Every outcome of an attempt lands here: a clean `sent`, and
-- every `failed` — no configured provider (`no_provider`), an undialable destination
-- (`invalid_destination`), a provider that threw (`provider_error`). The service's
-- write is throw-on-failure, so a reply can no more reach a provider un-recorded than
-- it can be drafted un-audited.
--
-- NO DUPLICATES (validation criterion #5: "no duplicate messages generated"). A
-- partial UNIQUE index on `dedup_key` (where a message actually went out —
-- status = 'sent') is the database backstop: a second successful send that carries the
-- same idempotency key cannot be recorded, and the TypeScript short-circuits before it
-- ever reaches the provider. The key defaults to the conversation (enquiry) so a
-- missed-call text-back fires at most once per call.
--
-- Provably additive (P2): a brand-new table + function + triggers. No tenant table is
-- touched; no producer is wired here (the canonical service wires the store in
-- TypeScript). The organisation / audit / customer references are carried as
-- DENORMALISED, un-FK'd facts — an append-only ledger must outlive the rows it
-- describes, so no `on delete cascade` can ever erase transport history. The audit
-- link (`reply_audit_id`) is likewise a soft reference the gate resolves, not an FK,
-- for the same durability reason.

-- ---------------------------------------------------------------------------
-- 1. ai_reply_transports — one append-only record per ATTEMPTED outbound send.
--    RLS:hq. Every row is bound (via the gate) to an ALLOWED ai_reply_audits row —
--    the proof that this transport is the downstream consequence of an enforced,
--    auto-sendable reply and nothing else.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_reply_transports (
  id                   uuid        primary key default gen_random_uuid(),

  -- THE enforcement anchor. The ai_reply_audits row this transport carries out. A
  -- soft (un-FK'd) reference so audit history is durable, but NOT unchecked: the
  -- BEFORE INSERT gate resolves it and refuses any row whose audit is missing or
  -- whose verdict was not `allow`. This is the load-bearing boundary.
  reply_audit_id       uuid        not null,

  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id               uuid        not null,                 -- the organisation
  employee_slug        text        not null,                 -- the AI employee (voice-receptionist-ai)

  -- The channel this attempt used. R5 ships SMS; the CHECK is the seam later
  -- transports widen — deliberately narrow so no unreviewed channel slips through.
  channel              text        not null
                         check (channel in ('sms')),

  -- The provider that carried it. NULL on a born `failed` attempt that never reached
  -- one (no_provider / invalid_destination). 'twilio' on a real attempt.
  provider             text,

  -- WHERE it went (the E.164 destination). PII — stays sealed in this RLS-locked row.
  to_ref               text        not null,

  -- The provider's message id — the correlation key a delivery receipt would carry
  -- back. Present on `sent`, forbidden on `failed` (it never reached a provider).
  provider_message_id  text,

  -- The terminal outcome of the attempt. There is no active state: an SMS attempt
  -- either was accepted by the provider (`sent`) or was not (`failed`). Both freeze.
  status               text        not null
                         check (status in ('sent','failed')),

  -- Why a failed attempt failed (no_provider / invalid_destination / provider_error).
  -- NULL on a clean send. Observability, not control.
  failure_reason       text,

  -- The cost ledger, inline (mirrors hq_communications / hq_drafts). NULL when the
  -- provider/channel is unpriced — cost is observability, never a gate.
  cost_usd             numeric,
  latency_ms           integer,

  -- Which attempt this is (1 = first). A future retry mints a NEW row; this one never
  -- mutates.
  attempt              integer     not null default 1 check (attempt >= 1),

  -- The idempotency key. Defaults (in the service) to the conversation so one inbound
  -- event yields at most one successful outbound. The partial unique index below makes
  -- a duplicate `sent` physically un-recordable.
  dedup_key            text,

  -- Threads this transport into the reply's end-to-end trace.
  correlation_id       uuid        not null,

  -- Execution metadata — the producer path, provider raw ids, etc.
  metadata             jsonb       not null default '{}',
  created_at           timestamptz not null default now()
);

-- Lookup + observability indexes.
--   per-org:      one organisation's outbound attempts, newest first.
--   per-audit:    every transport attempt for a given enforced reply (the linkage).
--   per-trace:    all rows in one correlation.
--   webhook:      correlate a provider receipt back to its row (unique per message).
--   dedup:        THE no-duplicate backstop — at most one SENT row per idempotency key.
create index if not exists ai_reply_transports_org_created_idx
  on public.ai_reply_transports (org_id, created_at desc);
create index if not exists ai_reply_transports_audit_idx
  on public.ai_reply_transports (reply_audit_id);
create index if not exists ai_reply_transports_correlation_idx
  on public.ai_reply_transports (correlation_id);
create unique index if not exists ai_reply_transports_provider_msg_idx
  on public.ai_reply_transports (provider_message_id)
  where provider_message_id is not null;
create unique index if not exists ai_reply_transports_dedup_idx
  on public.ai_reply_transports (dedup_key)
  where status = 'sent' and dedup_key is not null;

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER
-- write primitive are the only paths in; every JWT client (anon / authenticated) is
-- denied because an RLS-enabled table with no policies defaults to deny. No table
-- grant can open it. The destination + provider ids stay sealed here.
alter table public.ai_reply_transports enable row level security;

-- ---------------------------------------------------------------------------
-- 2. The transport guard — THE enforcement gate + the born-state coupling.
--
-- A BEFORE INSERT trigger that NO caller (not even the service-role admin client)
-- can bypass. It proves the transport is the downstream consequence of an enforced,
-- AUTO-SENDABLE reply, that it belongs to that reply's organisation, and that its
-- provider-message-id coupling is honest. This is the database half of the R5 law:
-- "no transport … without first passing through both the canonical enforcement seam
-- and the mandatory audit ledger."
-- ---------------------------------------------------------------------------
create or replace function public.ai_reply_transports_guard()
returns trigger
language plpgsql
as $$
declare
  v_allowed   boolean;
  v_audit_org uuid;
begin
  -- (a) THE enforcement gate. A transport may only exist for an ai_reply_audits row
  --     whose enforcement verdict was `allow` (allowed = true). The `is distinct
  --     from true` form rejects BOTH a non-allow verdict (review / block → allowed
  --     false) AND a missing audit (subquery → NULL): an orphan or a held/refused
  --     reply can never acquire a transport. A CHECK cannot subquery; this trigger
  --     can. This is the load-bearing security boundary.
  select a.allowed, a.org_id
    into v_allowed, v_audit_org
    from public.ai_reply_audits a
    where a.id = new.reply_audit_id;

  if v_allowed is distinct from true then
    raise exception 'ai_reply_transports: reply audit % is not an allowed reply — a transport may only carry an enforced, auto-sendable reply', new.reply_audit_id
      using errcode = 'check_violation';
  end if;

  -- (b) Linkage integrity. The transport must belong to the same organisation as the
  --     audit it carries — a transport cannot be mislinked across tenants.
  if new.org_id is distinct from v_audit_org then
    raise exception 'ai_reply_transports %: org_id % does not match its reply audit''s org %', new.id, new.org_id, v_audit_org
      using errcode = 'check_violation';
  end if;

  -- (c) Born-state coupling. A `sent` attempt carries the provider's message id (the
  --     correlation key); a `failed` attempt never reached a provider, so it must not.
  if new.status = 'sent' and (new.provider_message_id is null or btrim(new.provider_message_id) = '') then
    raise exception 'ai_reply_transports %: a sent transport requires a provider_message_id', new.id
      using errcode = 'check_violation';
  end if;
  if new.status = 'failed' and new.provider_message_id is not null then
    raise exception 'ai_reply_transports %: a failed transport never reached a provider and must not carry a provider_message_id', new.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists ai_reply_transports_guard_ins on public.ai_reply_transports;
create trigger ai_reply_transports_guard_ins
  before insert on public.ai_reply_transports
  for each row execute function public.ai_reply_transports_guard();

-- ---------------------------------------------------------------------------
-- 3. Append-only guard — a recorded transport attempt is a fact about one moment,
--    never updated or deleted. Reject UPDATE/DELETE even under service_role so a
--    recorded send/failure can never be rewritten or erased. Mirrors the
--    ai_reply_audits and executor-shadow append-only guards.
-- ---------------------------------------------------------------------------
create or replace function public.ai_reply_transports_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_reply_transports is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists ai_reply_transports_no_update on public.ai_reply_transports;
create trigger ai_reply_transports_no_update
  before update on public.ai_reply_transports
  for each row execute function public.ai_reply_transports_block_mutation();

drop trigger if exists ai_reply_transports_no_delete on public.ai_reply_transports;
create trigger ai_reply_transports_no_delete
  before delete on public.ai_reply_transports
  for each row execute function public.ai_reply_transports_block_mutation();

-- ---------------------------------------------------------------------------
-- 4. record_ai_reply_transport — the single validated write entry point.
--    SECURITY DEFINER, service_role-only (EXECUTE revoked from PUBLIC, anon,
--    authenticated). The canonical receptionist service calls this AND ONLY this to
--    file a transport attempt; the write is MANDATORY there (the TypeScript throws if
--    this returns an error), so no attempt can reach a provider un-recorded. The
--    BEFORE INSERT gate still runs inside this SECURITY DEFINER path — the enforcement
--    boundary is not something the writer can opt out of. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.record_ai_reply_transport(
  p_reply_audit_id      uuid,
  p_org_id              uuid,
  p_employee_slug       text,
  p_channel             text,
  p_to_ref              text,
  p_status              text,
  p_correlation_id      uuid,
  p_provider            text     default null,
  p_provider_message_id text     default null,
  p_failure_reason      text     default null,
  p_cost_usd            numeric  default null,
  p_latency_ms          integer  default null,
  p_attempt             integer  default 1,
  p_dedup_key           text     default null,
  p_metadata            jsonb    default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.ai_reply_transports (
    reply_audit_id, org_id, employee_slug, channel, to_ref, status, correlation_id,
    provider, provider_message_id, failure_reason, cost_usd, latency_ms, attempt,
    dedup_key, metadata
  ) values (
    p_reply_audit_id, p_org_id, p_employee_slug, p_channel, p_to_ref, p_status, p_correlation_id,
    p_provider, p_provider_message_id, p_failure_reason, p_cost_usd, p_latency_ms, coalesce(p_attempt, 1),
    p_dedup_key, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_ai_reply_transport(
  uuid, uuid, text, text, text, text, uuid, text, text, text, numeric, integer, integer, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_ai_reply_transport(
  uuid, uuid, text, text, text, text, uuid, text, text, text, numeric, integer, integer, text, jsonb
) to service_role;
