-- RENUMBERED 2026-07-27 (consolidation onto main): was `20260921000000_whatsapp_read_receipt_
-- status.sql`. Supabase keys migration identity on the NUMERIC VERSION PREFIX, not the
-- filename, and version `20260921000000` is already applied in production by an unrelated
-- migration (`20260921000000_toolbox_talks.sql`). This file was authored on a long-lived branch
-- whose base predates that, and had NEVER been applied in any environment (the applied prod tip
-- is `20261042000000`), so it was free to move. Re-slotted to `20261045000000` — after the
-- applied tip, and preserving its original relative order against the two sibling WhatsApp
-- migrations (…0919→43, …0920→44, …0921→45). The SQL below is UNCHANGED, byte for byte.
--
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
