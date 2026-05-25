-- ============================================================================
-- demo_requests.linked_org_id — connects a demo to the customer org provisioned
-- by HQ's "Move to onboarding" action.
--
-- This both:
--   1. Lets the activity timeline + Customers OS surface the link from a
--      demo to the resulting tenant org.
--   2. Provides idempotency for the move-to-onboarding action — if a demo
--      already has linked_org_id set, retrying the move is a no-op.
--
-- on delete set null so deleting a tenant org doesn't orphan or destroy
-- the historical demo_requests row.
-- ============================================================================

alter table public.demo_requests
  add column if not exists linked_org_id uuid
    references public.organizations(id) on delete set null;

create index if not exists demo_requests_linked_org_idx
  on public.demo_requests (linked_org_id)
  where linked_org_id is not null;
