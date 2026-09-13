-- WhatsApp activation hardening (2026-09-13 from-zero audit) — the DB layer.
--
-- Everything here ships DARK-SAFE: the WhatsApp channel flag stays off, no Meta
-- contact exists, and every change below makes a gate STRONGER, never weaker.
--
--   P1-1  whatsapp_number_routes: tenant admins could INSERT/UPDATE routes via
--         PostgREST and CLAIM A FOREIGN phone_number_id (first-claim wins the
--         UNIQUE) — cross-tenant message interception at activation. PROVEN
--         exploit. Provisioning becomes service-role only.
--   P1-2  ai_receptionist_setups: tenant admins could UPDATE status='live'
--         directly (the RLS update policy is row-level, not column-level), and
--         canRunReceptionistChannel trusts status='live' — tenant self-arming
--         of the AI channel. PROVEN exploit. HQ-only columns get a trigger lock.
--   P2-4  whatsapp_webhook_events: attempts counter + dead-letter stamp for the
--         failed-event sweep cron (mirrors the embedding worker's max-attempts
--         dead-letter doctrine).
--   P2-6  ai_reply_send_claims: the claim-BEFORE-the-provider-call table that
--         closes the double-approve wire race (two concurrent approvals of one
--         held reply could both reach provider.send; the partial-unique sent
--         index only stops the second RECORD, not the second WIRE SEND).
--   P2-7  whatsapp_optouts: the STOP/opt-out suppression list.

-- ═══════════════════════════════════════════════════════════════════════════
-- P1-1 — whatsapp_number_routes: provisioning is SERVICE-ROLE ONLY.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The 20260918 policies granted INSERT/UPDATE to is_org_admin(org_id) — but the
-- WITH CHECK only proves the CLAIMING org is the caller's own; nothing verifies
-- the claimed phone_number_id BELONGS to that org (that fact lives at Meta, not
-- in tenant-writable data). So any tenant admin could pre-claim another tenant's
-- phone_number_id and, at activation, receive their inbound messages.
--
-- Provisioning is an HQ act performed during onboarding. NO application surface
-- INSERTs into this table today (verified 2026-09-13: the only code references
-- are the service-role webhook lookup `resolveOrgForNumber` and the inbound-org
-- resolver) — there is no HQ provisioning UI yet, so provisioning is
-- service-role SQL for now (an HQ surface, when built, runs on the super-admin
-- service-role client like app/admin/ai-receptionist does). Dropping these
-- policies therefore breaks nothing and closes the interception primitive.
--
-- Tenant members KEEP their org-scoped SELECT (the 20260918 policy, untouched)
-- so an operator can still see which number is wired.

drop policy if exists "whatsapp_number_routes: admins can insert" on public.whatsapp_number_routes;
drop policy if exists "whatsapp_number_routes: admins can update" on public.whatsapp_number_routes;

-- ═══════════════════════════════════════════════════════════════════════════
-- P1-2 — ai_receptionist_setups: HQ-only columns locked at the DB layer.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The 20260625 comment said "status + checklist + configured_at/by are HQ-only —
-- gated at the application layer". That gate never ran for a raw PostgREST
-- UPDATE, so a tenant admin could set status='live' + enabled=true and self-arm
-- the WhatsApp AI channel (canRunReceptionistChannel requires exactly that
-- pair). This trigger mirrors the already-shipped product decision at the DB
-- layer, the same posture as enforce_quote_approval_authz (20261090):
--
--   • service_role is exempt — the HQ admin surface (app/admin/ai-receptionist)
--     and every server flow run on the service-role client, which no tenant
--     ever holds. Canonical detection: auth.role() (20260708000001, 20261008).
--   • NO is_org_admin exemption — tenant admins are precisely who this lock is
--     against; their legitimate fields (enabled, business_phone,
--     whatsapp_number, facebook_page, instagram_handle, preferred_voice,
--     business_hours, trade_type — the exact payload of
--     saveAiReceptionistSetup) stay freely editable.
--   • BEFORE INSERT matters too: without it a tenant could CREATE the row
--     already at status='live' (the app always inserts the default
--     'not_started' with no HQ fields, so legitimate inserts stay green).
--   • hq_notes is included: it is written only by the HQ notes action on the
--     service-role client, never by the tenant form.

create or replace function public.enforce_ai_receptionist_hq_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- HQ + server flows (super-admin client, crons) are service_role — exempt.
  if auth.role() is not distinct from 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A tenant INSERT must be the vanilla enable/save: lifecycle at its
    -- default, no test stamps, no configuration provenance, no HQ notes.
    if new.status is distinct from 'not_started'
       or new.test_call_at is not null
       or new.test_sms_at is not null
       or new.test_whatsapp_at is not null
       or new.test_meta_at is not null
       or new.test_voice_at is not null
       or new.test_lead_at is not null
       or new.configured_at is not null
       or new.configured_by is not null
       or new.hq_notes is not null then
      raise exception 'ai_receptionist_setups: status/test/configured/hq fields are HQ-only'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- UPDATE: any CHANGE to an HQ-only column is refused for a tenant caller.
  if new.status is distinct from old.status
     or new.test_call_at is distinct from old.test_call_at
     or new.test_sms_at is distinct from old.test_sms_at
     or new.test_whatsapp_at is distinct from old.test_whatsapp_at
     or new.test_meta_at is distinct from old.test_meta_at
     or new.test_voice_at is distinct from old.test_voice_at
     or new.test_lead_at is distinct from old.test_lead_at
     or new.configured_at is distinct from old.configured_at
     or new.configured_by is distinct from old.configured_by
     or new.hq_notes is distinct from old.hq_notes then
    raise exception 'ai_receptionist_setups: status/test/configured/hq fields are HQ-only'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_ai_receptionist_hq_fields on public.ai_receptionist_setups;
create trigger enforce_ai_receptionist_hq_fields
  before insert or update on public.ai_receptionist_setups
  for each row execute function public.enforce_ai_receptionist_hq_fields();

-- ═══════════════════════════════════════════════════════════════════════════
-- P2-4 — whatsapp_webhook_events: sweep bookkeeping (attempts + dead-letter).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The claim protocol left failed / lease-expired rows RECLAIMABLE — but only a
-- Meta REDELIVERY ever exercised the reclaim, and Meta stops retrying within
-- hours. The sweep cron (app/api/cron/whatsapp-events-sweep) is the missing
-- retry driver. `attempts` counts sweep re-runs; at the cap the row is
-- DEAD-LETTERED (stamped, never silently dropped, excluded from every reclaim)
-- and surfaced to HQ — the embedding worker's doctrine.

alter table public.whatsapp_webhook_events
  add column if not exists attempts integer not null default 0,
  add column if not exists dead_lettered_at timestamp with time zone;

comment on column public.whatsapp_webhook_events.attempts is
  'Sweep re-processing attempts. At WHATSAPP_SWEEP_MAX_ATTEMPTS the row is dead-lettered.';
comment on column public.whatsapp_webhook_events.dead_lettered_at is
  'Terminal give-up stamp: set by the sweep after max attempts. A dead-lettered row is '
  'excluded from every reclaim and surfaced to HQ; processed_at stays NULL (it never completed).';

-- The sweep scans retryable rows oldest-first; excludes the completed majority
-- and the dead-lettered tail.
create index if not exists whatsapp_webhook_events_sweep_idx
  on public.whatsapp_webhook_events (created_at)
  where processed_at is null and dead_lettered_at is null;

-- ═══════════════════════════════════════════════════════════════════════════
-- P2-6 — ai_reply_send_claims: claim BEFORE the provider call.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The partial-unique index on ai_reply_transports (dedup_key where
-- status='sent') is a backstop on the RECORD, written AFTER provider.send — so
-- two concurrent approvals of one held reply could both hit the wire and the
-- customer received the message twice. This table moves the atomic claim AHEAD
-- of the provider call: INSERT (PK collision = someone else holds the send) is
-- the claim, exactly the whatsapp_webhook_events idiom. A claim whose send
-- FAILED is deleted (retry allowed); a claim that produced a SENT transport is
-- kept as the durable tombstone; a claim orphaned by a crash mid-send is
-- reclaimable after a lease, but ONLY when no SENT transport exists.
--
-- Service-role only: RLS enabled, ZERO policies — the same posture as
-- whatsapp_webhook_events / billing_events. Tenants never read or write claims.

create table if not exists public.ai_reply_send_claims (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  dedup_key  text not null,
  claimed_at timestamp with time zone not null default now(),
  primary key (org_id, dedup_key)
);

comment on table public.ai_reply_send_claims is
  'Pre-send claim ledger for ai_reply_transports: the INSERT is taken BEFORE provider.send '
  'so two concurrent dispatches of one dedup_key cannot both reach the wire. The partial-'
  'unique sent index remains the post-hoc backstop.';

alter table public.ai_reply_send_claims enable row level security;
-- No policies: service-role / SECURITY DEFINER only.

-- ═══════════════════════════════════════════════════════════════════════════
-- P2-7 — whatsapp_optouts: the STOP suppression list.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per (org, wa_id) that has explicitly opted out (STOP / UNSUBSCRIBE /
-- "opt out" as a whole message). While a row exists: no AI drafting for that
-- sender's enquiries and transportReply REFUSES the recipient (recorded
-- refusal "opted_out"). Only an explicit START / UNSTOP removes the row —
-- an ordinary follow-up message NEVER silently re-subscribes (deliberately
-- conservative; documented in lib/receptionist/optout.ts).
--
-- wa_id is stored NORMALISED to digits only (Meta wa_ids carry no '+'), so the
-- outbound E.164 check and the inbound wa_id agree on identity.
--
-- RLS: org members may SELECT their own org's opt-outs (operators must be able
-- to see why a send was refused); every write is service-role only.

create table if not exists public.whatsapp_optouts (
  org_id       uuid not null references public.organizations(id) on delete cascade,
  wa_id        text not null,
  opted_out_at timestamp with time zone not null default now(),
  -- The inbound message that carried the STOP — provenance for audits/disputes.
  source_wamid text,
  primary key (org_id, wa_id)
);

comment on table public.whatsapp_optouts is
  'WhatsApp STOP/opt-out suppression list. Present row = suppressed (no AI drafting, '
  'outbound refused as "opted_out"). Removed only by an explicit START/UNSTOP message. '
  'wa_id is digits-only normalised.';

alter table public.whatsapp_optouts enable row level security;

drop policy if exists "whatsapp_optouts: members can select" on public.whatsapp_optouts;
create policy "whatsapp_optouts: members can select" on public.whatsapp_optouts
  for select to authenticated
  using (org_id in (select public.current_org_ids()));
-- No INSERT/UPDATE/DELETE policies: the opt-out ledger is written only by the
-- inbound pipeline on the service-role client — a tenant cannot fabricate or
-- erase a customer's opt-out.
