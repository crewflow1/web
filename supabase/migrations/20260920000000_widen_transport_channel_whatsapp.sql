-- Widen the receptionist outbound transport + delivery-receipt channel vocabulary:
-- sms → sms | whatsapp (Directive #018 R6, the WhatsApp AI draft-first milestone).
--
-- WHY: ai_reply_transports.channel and ai_reply_delivery_receipts.channel were pinned
-- to `check (channel in ('sms'))` on purpose — "deliberately narrow so no unreviewed
-- channel slips through" (20260816/20260817). WhatsApp is the second reviewed outbound
-- transport, so the seam widens by exactly one value. The CHECK is the SOLE channel
-- gate on these ledgers (no trigger or RPC validates channel), so widening it here is
-- what makes a WhatsApp transport row RECORDABLE at all — and it MUST land before any
-- WhatsApp transport is attempted, or record_ai_reply_transport raises check_violation
-- and the transport throws instead of degrading to the intended no_provider result.
--
-- SAFETY: this is an additive SUPERSET. Every existing 'sms' row already satisfies the
-- new predicate, so there is no row rewrite and no validation failure. Widening the
-- CHECK does NOT enable outbound WhatsApp on its own: getWhatsAppProvider() is null
-- (dark), so a WhatsApp reply still records failed/no_provider and SENDS NOTHING — this
-- migration only lets that dark disposition be recorded on channel='whatsapp' instead
-- of being rejected by the constraint.
--
-- The delivery-receipts table copies the transport's channel on correlation
-- (20260817 …:321 `v_transport.channel`), so BOTH constraints must widen together or a
-- future WhatsApp receipt would fail its own CHECK.
--
-- Both constraints are anonymous inline column checks, so PostgreSQL auto-named them
-- `<table>_channel_check` (each table has exactly one check on `channel`). Drop by that
-- deterministic name (no IF EXISTS — a wrong name should fail LOUDLY in CI, never leave
-- a stale narrow constraint silently in force alongside the new one).

alter table public.ai_reply_transports
  drop constraint ai_reply_transports_channel_check,
  add constraint ai_reply_transports_channel_check
    check (channel in ('sms', 'whatsapp'));

alter table public.ai_reply_delivery_receipts
  drop constraint ai_reply_delivery_receipts_channel_check,
  add constraint ai_reply_delivery_receipts_channel_check
    check (channel in ('sms', 'whatsapp'));
