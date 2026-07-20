-- CrewFlow HQ — Voice Receptionist AI: the delivery-monitoring read model
-- (CEO Directive #018, the AI Receptionist Programme — increment R9:
--  DELIVERY MONITORING — OPERATOR VISIBILITY).
--
-- R4–R7 built the outbound lifecycle as three append-only ledgers of record:
--   ai_reply_audits           (R4) — every attempted reply + its enforcement verdict.
--   ai_reply_transports       (R5) — every outbound send attempt (sent / failed).
--   ai_reply_delivery_receipts(R7) — the provider's async terminal fate (delivered / …).
-- R9 adds NOTHING to that pipeline. It gives the HQ operator READ-ONLY visibility over
-- what those ledgers already recorded, so a human can answer, for any reply: was it
-- produced, was it allowed / held / blocked, was a transport attempted, did it send or
-- fail, what was the provider message id, did the provider report a terminal delivery
-- status, WHEN did each step happen, and WHAT caused any failure.
--
-- WHY A VIEW, NOT A NEW TABLE. A read model is a PROJECTION of the source ledgers, never
-- a second source of truth. A view holds no rows of its own: every value it returns is
-- read live from the three ledgers at query time, so it can never drift from — nor
-- outlive — the facts it presents. There is no store to write, no producer to wire, no
-- reconciliation job, no cache to invalidate. This is pure observability appended to the
-- existing chain, exactly the "later read PROJECTION" both ai_reply_audits and
-- ai_reply_delivery_receipts anticipated in their own headers ("A per-organisation read
-- PROJECTION is a deliberate later increment; the ledger of record stays HQ-internal").
--
-- READ-ONLY BY CONSTRUCTION — three independent guarantees, any one sufficient:
--   1. This view JOINS three base relations and uses a LATERAL/aggregate, so PostgreSQL
--      does not classify it as auto-updatable: an INSERT / UPDATE / DELETE against the
--      view is rejected by the database. No INSTEAD OF trigger is defined (and none ever
--      will be), so there is no write path THROUGH the view.
--   2. Even a write that reached a base table is refused: each ledger carries BEFORE
--      UPDATE / DELETE triggers that raise `restrict_violation` even under service_role.
--      The append-only law is upstream of this view and unaffected by it.
--   3. The view is granted SELECT only. INSERT / UPDATE / DELETE are never granted.
--
-- security_invoker = true — THE VIEW INHERITS THE CALLER'S RLS, IT DOES NOT LAUNDER IT.
-- A classic (security-definer) view runs with its OWNER's privileges, which would let a
-- JWT client read HQ-internal ledgers THROUGH the view even though RLS denies them the
-- base tables directly — a privilege-laundering leak. With security_invoker the view
-- executes as the CALLER, so the base tables' RLS applies to whoever selects from it:
--   • service_role (BYPASSRLS) — the HQ admin client — sees the rows. This is the only
--     intended reader (the admin surface calls createAdminClient()).
--   • anon / authenticated — RLS on the three ledgers is enabled with ZERO policies, so
--     it denies them, and the view returns them nothing. HQ data never leaks to a tenant.
-- The SELECT grant is likewise revoked from public / anon / authenticated and granted
-- only to service_role — defence in depth atop the inherited RLS. (Requires PG15+; the
-- deployment target is PG17.)
--
-- Provably additive (P2): a brand-new view + grants. No table is created or altered, no
-- row is written, no trigger or policy on the ledgers is touched. Dropping this view
-- removes operator visibility and nothing else — the ledgers of record are unchanged.

-- ---------------------------------------------------------------------------
-- ai_reply_lifecycle — one row per reply-audit × transport-attempt, LEFT-joined so
-- that:
--   • a reply that was HELD or BLOCKED (and therefore never acquired a transport) still
--     appears — its transport_* and delivery_* columns are simply NULL (the operator
--     sees the reply and why it was stopped);
--   • a transport that has been SENT but whose provider has not yet reported back still
--     appears — its delivery_* columns are NULL (a "missing receipt" is a visible,
--     honest absence, not a hidden row);
--   • a transport with receipts surfaces its MOST SIGNIFICANT one — a terminal receipt
--     if any has arrived, else the latest — via a LATERAL pick ordered
--     (terminal desc, created_at desc), matching the R7 read convention.
-- Every column is sourced verbatim from a ledger of record; none is computed or claimed
-- here beyond the receipt_count roll-up and the lateral's ordering.
-- ---------------------------------------------------------------------------
create or replace view public.ai_reply_lifecycle
with (security_invoker = true) as
select
  -- ===== (1) WAS A REPLY PRODUCED?  (2) ALLOWED / REVIEW / BLOCK? =====
  -- The audit row is the spine: one exists for every attempted reply, so its presence
  -- answers (1) and its verdict/allowed answer (2).
  a.id                    as audit_id,
  a.org_id                as org_id,
  a.employee_slug         as employee_slug,
  a.channel               as channel,
  a.enquiry_id            as enquiry_id,
  a.lead_id               as lead_id,
  a.customer_ref          as customer_ref,
  a.correlation_id        as correlation_id,        -- threads all three ledgers
  a.draft                 as draft,
  a.verdict               as verdict,               -- allow / review / block   (Q2)
  a.allowed               as allowed,               -- deny-by-default fact      (Q2)
  a.categories            as categories,
  a.reason                as enforcement_reason,    -- why a reply was held/blocked (Q8)
  a.safe_text             as safe_text,
  a.created_at            as audit_at,              -- WHEN the reply was produced  (Q7)

  -- ===== (3) TRANSPORT ATTEMPTED?  (4) SENT / FAILED?  (5) PROVIDER MESSAGE ID? =====
  -- LEFT-joined: transport_id IS NULL means no send was attempted (held/blocked, or an
  -- allowed reply not yet carried). A present row carries the terminal attempt outcome.
  t.id                    as transport_id,          -- NULL → no transport attempted (Q3)
  t.status                as transport_status,      -- sent / failed             (Q4)
  t.provider              as transport_provider,
  t.provider_message_id   as provider_message_id,   -- the correlation key       (Q5)
  t.failure_reason        as transport_failure_reason, -- why a send failed      (Q8)
  t.to_ref                as to_ref,                -- the E.164 destination (HQ-only PII)
  t.attempt               as attempt,
  t.cost_usd              as cost_usd,
  t.latency_ms            as latency_ms,
  t.dedup_key             as dedup_key,
  t.created_at            as transport_at,          -- WHEN the send was attempted  (Q7)

  -- ===== (6) TERMINAL DELIVERY STATUS?  (7) WHEN?  (8) WHAT FAILED? =====
  -- The most significant receipt for this transport (terminal preferred, else latest).
  -- All-NULL means the provider has not reported yet — a visible "missing receipt".
  r.id                    as receipt_id,            -- NULL → no receipt yet     (Q6)
  r.status                as delivery_status,       -- delivered / undelivered / … (Q6)
  r.terminal              as delivery_terminal,     -- has the provider finalised? (Q6)
  r.provider_status       as delivery_provider_status, -- raw provider string, if differing
  r.error_code            as delivery_error_code,   -- provider failure code     (Q8)
  r.created_at            as receipt_at,            -- WHEN the status arrived    (Q7)

  -- How many receipts exist for this send (the ordered lifecycle depth: queued → sent →
  -- delivered = 3). 0 when no transport or no receipt yet — an at-a-glance completeness
  -- signal for the operator.
  coalesce(rc.receipt_count, 0) as receipt_count

from public.ai_reply_audits a
left join public.ai_reply_transports t
  on t.reply_audit_id = a.id
-- The most significant receipt for the transport: a terminal one if present, else the
-- newest. One row (or none) per transport.
left join lateral (
  select dr.id, dr.status, dr.terminal, dr.provider_status, dr.error_code, dr.created_at
  from public.ai_reply_delivery_receipts dr
  where dr.transport_id = t.id
  order by dr.terminal desc, dr.created_at desc
  limit 1
) r on true
-- The total receipt count for the transport (independent of the lateral's single pick).
left join lateral (
  select count(*)::int as receipt_count
  from public.ai_reply_delivery_receipts dr
  where dr.transport_id = t.id
) rc on true;

comment on view public.ai_reply_lifecycle is
  'R9 read-only operator visibility (Directive #018). A security_invoker projection of '
  'ai_reply_audits ⟕ ai_reply_transports ⟕ latest ai_reply_delivery_receipts. Holds no '
  'rows of its own and has no write path (multi-relation join, no INSTEAD OF trigger); '
  'the ledgers of record remain the sole source of truth and stay append-only. Readable '
  'only by service_role (the HQ admin client); RLS on the base tables denies every JWT '
  'client through the view.';

-- SELECT-only, service-role-only. INSERT/UPDATE/DELETE are never granted (and could not
-- succeed anyway — see header guarantees 1 & 2). service_role is named in the REVOKE too
-- because Supabase's default privileges grant it ALL on a freshly created relation; we
-- strip those back to SELECT so the grant posture itself reads read-only, belt-and-braces
-- atop the inherited base-table RLS. This mirrors the ledgers' own service-role-only door.
revoke all on public.ai_reply_lifecycle from public, anon, authenticated, service_role;
grant select on public.ai_reply_lifecycle to service_role;
