-- =========================================================================
-- ai_receptionist_setups — STRUCTURED answering policy (Twilio receptionist PR 2)
--
-- The Wave-9 setup row already carries the white-glove onboarding fields
-- (enabled, business_phone, preferred_voice, free-text business_hours, trade_type).
-- The AI voice runtime now needs a STRUCTURED, machine-evaluable policy to decide
-- WHO takes an inbound call — ring the company's own staff first, hand to the AI
-- receptionist, or take a message — per the three directive modes. This migration
-- adds the columns that `lib/telephony/answering-policy.ts` (decideAnswering) and
-- the voice webhooks consume. The free-text `business_hours` is kept untouched as
-- AI *context*; `weekly_hours` is the new STRUCTURED gate.
--
-- ALL new columns are customer-editable preferences, so they fall under the
-- EXISTING org-admin UPDATE policy — no RLS or grant change is needed (additive
-- columns on an already-client-reachable, already-RLS'd table). Every column is
-- nullable or has a safe default, so existing rows upgrade losslessly and an
-- unconfigured org behaves exactly as before (AI dark, no staff leg).
-- =========================================================================

alter table public.ai_receptionist_setups
  -- WHEN the AI answers: missed_only | out_of_hours | both (see ANSWERING_MODES).
  add column if not exists answering_mode text not null default 'both'
    check (answering_mode in ('missed_only', 'out_of_hours', 'both')),
  -- IANA timezone the weekly hours + closures are evaluated in.
  add column if not exists timezone text not null default 'Europe/London',
  -- Structured per-weekday opening window: {"mon":{"open":"09:00","close":"17:00"},...,"sun":null}.
  -- A missing/null day is treated as closed. Shape validated in the app (Zod); the
  -- DB only pins it is a JSON object when present.
  add column if not exists weekly_hours jsonb
    check (weekly_hours is null or jsonb_typeof(weekly_hours) = 'object'),
  -- Local YYYY-MM-DD dates treated as closed (bank holidays + exceptional closures).
  add column if not exists closures jsonb
    check (closures is null or jsonb_typeof(closures) = 'array'),
  -- Seconds to ring staff before the AI / message path takes a missed call.
  add column if not exists ring_timeout_seconds integer not null default 20
    check (ring_timeout_seconds between 5 and 120),
  -- The org's own staff destination numbers (E.164), rung simultaneously on a
  -- staff-first call. Empty / null ⇒ there is nobody to ring (AI covers directly).
  add column if not exists staff_numbers jsonb
    check (staff_numbers is null or jsonb_typeof(staff_numbers) = 'array'),
  -- Optional single fallback number dialled if the staff numbers cannot be reached.
  add column if not exists fallback_number text,
  -- Optional number an URGENT caller is transferred to (human escalation, PR 6).
  add column if not exists urgent_escalation_number text,
  -- Optional custom spoken greeting override (else the business-name greeting).
  add column if not exists greeting text,
  -- Free-text service areas, AI CONTEXT only.
  add column if not exists service_areas text,
  -- Call recording controls. DARK by default — recording stays OFF until the org
  -- explicitly opts in AND confirms a consent disclosure (UK two-party guidance).
  add column if not exists recording_enabled boolean not null default false,
  add column if not exists transcription_enabled boolean not null default false,
  -- The spoken consent line played before recording when recording is enabled.
  add column if not exists recording_consent_message text,
  -- Where new-lead / missed-call notifications go (in addition to the in-app feed).
  add column if not exists notify_email boolean not null default true,
  add column if not exists notify_sms boolean not null default false;
