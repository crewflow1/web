-- Warranty claims → support_tickets link (P3 — Portal completeness).
--
-- A warranty claim is a customer REPORTING AN ISSUE against cover they were
-- given. We do NOT create a new "claims" table: the best existing entity is
-- public.support_tickets, because it already has everything a claim needs and
-- the portal already trusts it:
--
--   • customer_id scoping (20260706) — the exact cross-customer barrier the
--     portal relies on, already proven and already read by the messages page;
--   • a status lifecycle (open → in_progress → waiting_on_customer → resolved →
--     closed) that IS the read-back the customer sees;
--   • support_messages threads — so the customer and the org can actually talk
--     about the claim, with the portal reply UI that already exists.
--
-- This migration adds the ONE thing support_tickets lacks: a link back to the
-- warranty the claim is about, plus a 'warranty_claim' category so staff triage
-- it as a claim and the portal read-back can find it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY — the warranty link is org-bound
-- ─────────────────────────────────────────────────────────────────────────────
-- warranty_id is NULLABLE (the vast majority of tickets are not claims) and,
-- when set, bound by a COMPOSITE FK to job_warranties(id, org_id) (candidate key
-- job_warranties_id_org_key, live since 20261079). So a claim can never point at
-- another tenant's warranty for ANY role incl. service_role — the same guard the
-- warranty itself uses to bind its job. The portal action additionally verifies
-- IN CODE that the warranty belongs to the token-resolved customer before it
-- stamps the ticket (see app/customer-portal/_warranty-claim-action.ts).
--
-- Additive + idempotent. No table rewrite (nullable column, no default). The FK
-- with a NULL column is MATCH SIMPLE, so existing tickets (warranty_id NULL) are
-- unaffected and never checked.

alter table public.support_tickets
  add column if not exists warranty_id uuid;

-- Composite FK — org-bound so a claim can never name another org's warranty.
-- Wrapped so re-apply is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'support_tickets_warranty_org_fkey'
  ) then
    alter table public.support_tickets
      add constraint support_tickets_warranty_org_fkey
      foreign key (warranty_id, org_id)
      references public.job_warranties (id, org_id) on delete set null;
  end if;
end $$;

comment on column public.support_tickets.warranty_id is
  'When set, this ticket is a WARRANTY CLAIM against the named warranty (P3). Org-bound by composite FK to job_warranties(id, org_id); SET NULL on warranty delete so the claim history survives. Stamped only via the portal claim action, which first verifies the warranty belongs to the token-resolved customer.';

create index if not exists support_tickets_warranty_idx
  on public.support_tickets (warranty_id)
  where warranty_id is not null;

-- Extend the category enum with 'warranty_claim'. The original constraint is the
-- inline (auto-named) support_tickets_category_check from 20260610; drop it by
-- name if present and re-add the superset. Idempotent + additive: every existing
-- value is preserved, one new value is allowed.
alter table public.support_tickets
  drop constraint if exists support_tickets_category_check;
alter table public.support_tickets
  add constraint support_tickets_category_check
  check (category in (
    'billing',
    'onboarding',
    'migration',
    'bug',
    'feature_request',
    'account',
    'warranty_claim',
    'other'
  ));
