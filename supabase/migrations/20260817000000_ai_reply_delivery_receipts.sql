-- CrewFlow HQ — Voice Receptionist AI: the async delivery-receipt ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R7:
--  ASYNC DELIVERY RECEIPTS).
--
-- R5 carried an enforced, audited reply out over one transport and recorded the
-- provider's SYNCHRONOUS acceptance (`ai_reply_transports`, 20260816000000). R6 armed
-- that path behind a default-off flag and captured the acceptance status. But
-- acceptance is not delivery: "Accepted is not enough. Queued is not enough." R7
-- completes the outbound lifecycle by ingesting the provider's ASYNCHRONOUS terminal
-- status (delivered / undelivered / failed / canceled) through an authenticated
-- status-callback webhook. This migration is that receipt's permanent home.
--
-- THE APPEND-ONLY LAW, PRESERVED (Directive #018, R7). `ai_reply_transports` is HARD
-- append-only: its UPDATE/DELETE triggers reject a mutation even under service_role,
-- and its status CHECK admits only ('sent','failed') — it CANNOT hold 'delivered'.
-- That is deliberate, and the transport migration's own header anticipated exactly
-- this increment: "A future increment that ingests receipts would add a superseding
-- row, never mutate this one." So R7 does NOT mutate the transport. It records each
-- terminal (and interim) delivery status as a NEW, append-only receipt row correlated
-- to the transport by the provider's message id. The delivery LIFECYCLE of a message
-- is therefore the transport row PLUS its ordered receipt rows — a join, never an
-- in-place edit. This diverges intentionally from the email precedent
-- (`recordDeliveryEvent` MUTATES `hq_communications.status`): that table has a
-- settle-back state machine; this ledger is append-only by contract.
--
-- Why a DEDICATED receipt ledger and NOT a column on the transport. A delivery status
-- is a fact about a LATER moment than the send; there can be several (queued → sent →
-- delivered), each its own append-only fact; and the transport row is frozen. A
-- sibling ledger — same RLS:hq, same append-only guards, same single SECURITY DEFINER
-- writer — is reuse-of-PATTERN (the established receptionist ledger idiom), not a
-- parallel delivery system. There is NO new transport, NO new provider send, NO new
-- customer behaviour here: purely delivery OBSERVABILITY appended to the existing
-- chain.
--
-- THE CORRELATION IS LOAD-BEARING, IN THE DATABASE. A receipt may only exist for a
-- real SENT transport, and its provider-message-id / org / audit coupling must be
-- HONEST. A BEFORE INSERT trigger (which a CHECK cannot do — it must subquery the
-- transport) resolves the referenced transport and refuses any row that is orphaned,
-- mislinked across tenants, or claims a message id its transport never carried. This
-- is the same boundary technique as ai_reply_transports_guard.
--
-- IDEMPOTENT BY CONSTRUCTION. A provider retries a status callback; a duplicate must
-- never create duplicate history. A UNIQUE index on (provider_message_id, status) is
-- the database backstop, and the write primitive is `on conflict do nothing`: the
-- SAME (message id, status) twice is a no-op that returns the pre-existing receipt.
-- One row per distinct lifecycle transition, no matter how many times it is delivered.
--
-- Reuses the existing AUDIT architecture (the hardening mirrors, line for line,
-- `ai_reply_audits` and `ai_reply_transports`):
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER
--     write primitive are the only writers/readers; every JWT client is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--     A recorded receipt is a fact about one moment; it is never rewritten or erased.
--   • A single validated SECURITY DEFINER write entry point, EXECUTE revoked from
--     PUBLIC / anon / authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + function + triggers. No tenant table is
-- touched; no producer is wired here (the canonical service wires the store in
-- TypeScript, and the authenticated webhook route is the only ingress). The
-- organisation / audit / transport references are carried as DENORMALISED, un-FK'd
-- facts — copied by the writer FROM the authoritative transport row, never trusted
-- from the caller — so an append-only ledger outlives the rows it describes and no
-- `on delete cascade` can ever erase delivery history.

-- ---------------------------------------------------------------------------
-- 1. ai_reply_delivery_receipts — one append-only record per provider-reported
--    delivery status. RLS:hq. Every row is bound (via the guard) to a SENT
--    ai_reply_transports row whose provider message id it correlates to — the proof
--    that this receipt is the downstream lifecycle of a real outbound send.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_reply_delivery_receipts (
  id                   uuid        primary key default gen_random_uuid(),

  -- THE correlation anchor. The ai_reply_transports row this receipt reports on. A
  -- soft (un-FK'd) reference so transport history is durable, but NOT unchecked: the
  -- BEFORE INSERT guard resolves it and refuses any row whose transport is missing,
  -- not `sent`, or whose provider message id / org / audit do not match.
  transport_id         uuid        not null,

  -- The enforcement anchor, denormalised from the transport — so a receipt is
  -- traceable back to the audited reply (and thence the inbound enquiry) without a
  -- second hop. Copied FROM the transport by the writer, verified by the guard.
  reply_audit_id       uuid        not null,

  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id               uuid        not null,                 -- the organisation
  employee_slug        text        not null,                 -- the AI employee (voice-receptionist-ai)

  -- The channel this receipt concerns. R7 ships SMS; the CHECK is the seam later
  -- channels widen — deliberately narrow so no unreviewed channel slips through.
  channel              text        not null
                         check (channel in ('sms')),

  -- The provider that reported the status. A receipt ALWAYS comes from a provider, so
  -- NOT NULL (unlike a born-failed transport that never reached one). 'twilio' in V1.
  provider             text        not null,

  -- The provider's message id — THE correlation key. The webhook carries it; the
  -- writer resolves the transport by it; the guard proves the receipt names the same
  -- id its transport recorded at acceptance. NOT NULL: a receipt with no message id
  -- correlates to nothing.
  provider_message_id  text        not null,

  -- The canonical lifecycle status the provider reported. The vocabulary is the
  -- provider-neutral SMS delivery set (lib/comms/types.ts SMS_DELIVERY_STATUSES),
  -- instantiated by the Twilio adapter. Bounded by CHECK so an unknown status can
  -- never be recorded (the adapter rejects it upstream as a malformed callback).
  status               text        not null
                         check (status in (
                           'accepted','scheduled','queued','sending','sent',
                           'delivered','undelivered','failed','canceled'
                         )),

  -- Whether `status` is a TERMINAL delivery state — the provider will not move on from
  -- it. GENERATED from `status`, not a caller claim, so it can never misrepresent a
  -- non-terminal status as final. This is the "known final state" the directive
  -- demands, made a fact of the row.
  terminal             boolean     not null
                         generated always as (
                           status in ('delivered','undelivered','failed','canceled')
                         ) stored,

  -- The provider's RAW status string, verbatim, when it differs from the canonical
  -- form — audit fidelity. NULL when identical to `status`.
  provider_status      text,

  -- The provider's error code for a non-delivery (Twilio ErrorCode, e.g. 30008), when
  -- it reports one. NULL on a clean delivery. Observability, not control.
  error_code           text,

  -- Threads this receipt into the reply's end-to-end trace (the transport's own).
  correlation_id       uuid        not null,

  -- Execution metadata — the raw provider callback fields, ingest path, etc.
  metadata             jsonb       not null default '{}',
  created_at           timestamptz not null default now()
);

-- Lookup + observability indexes.
--   idempotency: THE no-duplicate backstop — at most one receipt per (message id, status).
--   per-transport: the ordered delivery lifecycle of one send (queued → sent → delivered).
--   per-message:   every receipt for a provider message id (the correlation key's own read).
--   per-org:       one organisation's delivery receipts, newest first.
--   per-audit:     tie a receipt back to the enforced reply it completes.
create unique index if not exists ai_reply_delivery_receipts_idem_idx
  on public.ai_reply_delivery_receipts (provider_message_id, status);
create index if not exists ai_reply_delivery_receipts_transport_idx
  on public.ai_reply_delivery_receipts (transport_id, created_at);
create index if not exists ai_reply_delivery_receipts_provider_msg_idx
  on public.ai_reply_delivery_receipts (provider_message_id);
create index if not exists ai_reply_delivery_receipts_org_created_idx
  on public.ai_reply_delivery_receipts (org_id, created_at desc);
create index if not exists ai_reply_delivery_receipts_audit_idx
  on public.ai_reply_delivery_receipts (reply_audit_id);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER
-- write primitive are the only paths in; every JWT client (anon / authenticated) is
-- denied because an RLS-enabled table with no policies defaults to deny. No table
-- grant can open it.
alter table public.ai_reply_delivery_receipts enable row level security;

-- ---------------------------------------------------------------------------
-- 2. The correlation guard — a receipt may only exist for a real SENT transport,
--    and its coupling must be honest.
--
-- A BEFORE INSERT trigger that NO caller (not even the service-role admin client)
-- can bypass. It proves the receipt reports on a transport that actually reached a
-- provider, belongs to that transport's organisation and audit, and names the same
-- provider message id the transport recorded at acceptance. A CHECK cannot subquery
-- the transport; this trigger can. This is the database half of "correlate the
-- provider response to the exact transport it belongs to".
-- ---------------------------------------------------------------------------
create or replace function public.ai_reply_delivery_receipts_guard()
returns trigger
language plpgsql
as $$
declare
  v_status   text;
  v_pmid     text;
  v_org      uuid;
  v_audit    uuid;
begin
  -- Resolve the referenced transport.
  select t.status, t.provider_message_id, t.org_id, t.reply_audit_id
    into v_status, v_pmid, v_org, v_audit
    from public.ai_reply_transports t
    where t.id = new.transport_id;

  -- (a) The transport must exist and have actually been SENT — only a sent transport
  --     reached a provider and carries a message id a receipt can correlate to.
  if v_status is null then
    raise exception 'ai_reply_delivery_receipts %: transport % does not exist', new.id, new.transport_id
      using errcode = 'check_violation';
  end if;
  if v_status is distinct from 'sent' then
    raise exception 'ai_reply_delivery_receipts %: transport % is not a sent transport (status=%)', new.id, new.transport_id, v_status
      using errcode = 'check_violation';
  end if;

  -- (b) Honest correlation. The receipt must name the SAME provider message id its
  --     transport recorded at acceptance — a receipt cannot be attached to the wrong
  --     message.
  if new.provider_message_id is distinct from v_pmid then
    raise exception 'ai_reply_delivery_receipts %: provider_message_id % does not match its transport''s message id %', new.id, new.provider_message_id, v_pmid
      using errcode = 'check_violation';
  end if;

  -- (c) Linkage integrity. The receipt must belong to the same organisation AND the
  --     same enforced-reply audit as the transport it reports on — never mislinked
  --     across tenants or replies.
  if new.org_id is distinct from v_org then
    raise exception 'ai_reply_delivery_receipts %: org_id % does not match its transport''s org %', new.id, new.org_id, v_org
      using errcode = 'check_violation';
  end if;
  if new.reply_audit_id is distinct from v_audit then
    raise exception 'ai_reply_delivery_receipts %: reply_audit_id % does not match its transport''s audit %', new.id, new.reply_audit_id, v_audit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists ai_reply_delivery_receipts_guard_ins on public.ai_reply_delivery_receipts;
create trigger ai_reply_delivery_receipts_guard_ins
  before insert on public.ai_reply_delivery_receipts
  for each row execute function public.ai_reply_delivery_receipts_guard();

-- ---------------------------------------------------------------------------
-- 3. Append-only guard — a recorded receipt is a fact about one moment, never
--    updated or deleted. Reject UPDATE/DELETE even under service_role so a recorded
--    delivery status can never be rewritten or erased. Mirrors the ai_reply_audits
--    and ai_reply_transports append-only guards.
-- ---------------------------------------------------------------------------
create or replace function public.ai_reply_delivery_receipts_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_reply_delivery_receipts is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists ai_reply_delivery_receipts_no_update on public.ai_reply_delivery_receipts;
create trigger ai_reply_delivery_receipts_no_update
  before update on public.ai_reply_delivery_receipts
  for each row execute function public.ai_reply_delivery_receipts_block_mutation();

drop trigger if exists ai_reply_delivery_receipts_no_delete on public.ai_reply_delivery_receipts;
create trigger ai_reply_delivery_receipts_no_delete
  before delete on public.ai_reply_delivery_receipts
  for each row execute function public.ai_reply_delivery_receipts_block_mutation();

-- ---------------------------------------------------------------------------
-- 4. record_ai_reply_delivery_receipt — the single validated write entry point.
--    SECURITY DEFINER, service_role-only (EXECUTE revoked from PUBLIC, anon,
--    authenticated). The canonical receptionist service calls this AND ONLY this to
--    file a delivery receipt; the authenticated webhook route is the only ingress.
--
--    It performs the MANDATORY FLOW's server half in one atomic step:
--      • TRANSPORT LOOKUP — resolve the SENT transport by its provider message id.
--        A message id the ledger never sent → no transport → record NOTHING and
--        return transport_found = false (the route answers "unknown message").
--      • CORRELATION — insert a receipt whose org / audit / employee / channel /
--        provider are copied FROM the authoritative transport row, never trusted from
--        the caller, so a spoofed field cannot mislink a receipt.
--      • IDEMPOTENCY — `on conflict (provider_message_id, status) do nothing`: a
--        duplicate callback for the same lifecycle transition is a no-op that returns
--        the pre-existing receipt with was_duplicate = true. No duplicate history.
--    Returns exactly one row describing the outcome.
-- ---------------------------------------------------------------------------
create or replace function public.record_ai_reply_delivery_receipt(
  p_provider_message_id text,
  p_status              text,
  p_provider_status     text  default null,
  p_error_code          text  default null,
  p_metadata            jsonb default '{}'
)
returns table (
  receipt_id      uuid,
  transport_id    uuid,
  reply_audit_id  uuid,
  org_id          uuid,
  is_terminal     boolean,
  was_duplicate   boolean,
  transport_found boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transport public.ai_reply_transports%rowtype;
  v_receipt_id uuid;
  v_terminal   boolean;
  v_dupe       boolean := false;
begin
  -- TRANSPORT LOOKUP — a sent transport carries a provider message id (the partial
  -- unique index makes it identify at most one row); a failed transport never does,
  -- so this only ever resolves a real send.
  select *
    into v_transport
    from public.ai_reply_transports t
    where t.provider_message_id = p_provider_message_id
    limit 1;

  if not found then
    -- Unknown provider identifier — nothing to correlate. Record nothing.
    return query
      select null::uuid, null::uuid, null::uuid, null::uuid, null::boolean, false, false;
    return;
  end if;

  -- CORRELATION — a NEW receipt row, its linkage copied from the transport of record.
  insert into public.ai_reply_delivery_receipts (
    transport_id, reply_audit_id, org_id, employee_slug, channel, provider,
    provider_message_id, status, provider_status, error_code, correlation_id, metadata
  ) values (
    v_transport.id, v_transport.reply_audit_id, v_transport.org_id, v_transport.employee_slug,
    v_transport.channel, coalesce(v_transport.provider, 'unknown'), p_provider_message_id,
    p_status, p_provider_status, p_error_code, v_transport.correlation_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (provider_message_id, status) do nothing
  returning id, terminal into v_receipt_id, v_terminal;

  if v_receipt_id is null then
    -- IDEMPOTENCY — the (message id, status) receipt already exists; return it.
    v_dupe := true;
    select r.id, r.terminal
      into v_receipt_id, v_terminal
      from public.ai_reply_delivery_receipts r
      where r.provider_message_id = p_provider_message_id
        and r.status = p_status
      limit 1;
  end if;

  return query
    select v_receipt_id, v_transport.id, v_transport.reply_audit_id, v_transport.org_id,
           v_terminal, v_dupe, true;
end;
$$;

revoke all on function public.record_ai_reply_delivery_receipt(
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_ai_reply_delivery_receipt(
  text, text, text, text, jsonb
) to service_role;
