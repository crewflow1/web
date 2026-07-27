-- Admit WhatsApp's `read` delivery status into the receipt ledger (Directive #018 R6, PR3).
--
-- WhatsApp reports sent | delivered | read | failed. The first three of those (and the SMS
-- nine) were already accepted; `read` is the one net-new lifecycle value, so the receipt
-- status CHECK widens by exactly one. This is what lets a WhatsApp read receipt be RECORDED
-- (previously the adapter dropped it); the correlation, idempotency and out-of-order
-- guarantees are unchanged — a receipt is still one immutable append-only row per
-- (provider_message_id, status).
--
-- SAFETY: additive superset — every existing row already satisfies the new predicate, so no
-- rewrite. `read` is DELIBERATELY NOT terminal: the `terminal` generated column
-- (status in ('delivered','undelivered','failed','canceled')) is untouched, so `read` is an
-- interim fact appended after `delivered` and can never regress a terminal state. The
-- constraint is an anonymous inline column check, auto-named `<table>_status_check`; drop by
-- that deterministic name (no IF EXISTS — a wrong name must fail loudly in CI).
--
-- Only the receipt table widens: `read` is a delivery-lifecycle status, never a transport
-- disposition, so ai_reply_transports.status ('sent'|'failed') is intentionally left alone.

alter table public.ai_reply_delivery_receipts
  drop constraint ai_reply_delivery_receipts_status_check,
  add constraint ai_reply_delivery_receipts_status_check
    check (status in (
      'accepted',
      'scheduled',
      'queued',
      'sending',
      'sent',
      'delivered',
      'undelivered',
      'failed',
      'canceled',
      'read'
    ));
