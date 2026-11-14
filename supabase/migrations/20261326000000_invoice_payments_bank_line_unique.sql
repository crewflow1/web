-- ============================================================================
-- Bank reconciliation — one bank statement line can pay an invoice ONCE.
--
-- THE DEFECT (resilience programme, failure-mode matrix PW-05). Confirming a
-- bank match is two statements with nothing tying them together:
--
--     INSERT invoice_payments (bank_line_id = L)  →  UPDATE bank_statement_lines
--                                                    SET match_status='confirmed'
--
-- and neither the action nor the schema stopped the first from running twice
-- for the same line:
--
--   * RETRY AFTER A PARTIAL FAILURE. If the UPDATE failed after the INSERT
--     committed, the operator was told "match partially failed" and the line
--     still showed as unmatched. Confirming it again inserted a SECOND payment
--     for the same bank transaction — the invoice's receipts were overstated
--     and the debtor understated, from one real transfer.
--   * DOUBLE SUBMIT / STALE TAB. The action never checked the line's current
--     match_status, so two confirms (two tabs, two admins, a re-POST) each
--     recorded the money.
--
-- The existing index on bank_line_id (invoice_payments_bank_line_idx) is NOT
-- unique. This adds the uniqueness the reconciliation model has always assumed
-- (bank_statement_lines.matched_payment_id is a single column: one line, one
-- payment). The application now also reuses an existing payment for the line
-- instead of inserting again, so a retry REPAIRS the half-finished match; this
-- index is the atomic backstop for the concurrent case, exactly as
-- invoices_quote_id_unique is for quote acceptance.
--
-- Pre-flight (production catalogue, aggregate only, 2026-11-13): 0 payments
-- carry a bank_line_id and 0 bank_line_id values are duplicated, so the index
-- builds without conflict. If that ever stops being true the CREATE fails
-- loudly and nothing is changed — resolve the duplicates, never drop the index.
--
-- Additive: one partial unique index. No existing object is altered. Not a
-- client-reachable table or function, so no grant change.
-- ============================================================================

create unique index if not exists invoice_payments_bank_line_uniq
  on public.invoice_payments (bank_line_id)
  where bank_line_id is not null;

comment on index public.invoice_payments_bank_line_uniq is
  'One bank statement line settles at most one invoice payment (idempotency backstop for confirmBankMatch).';
