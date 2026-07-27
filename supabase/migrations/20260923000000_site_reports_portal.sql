-- Site Reports increment 3 — customer-portal publication.
--
-- Additive publication metadata on site_reports + a portal-query index. The
-- issued snapshot stays immutable (tg_site_reports_immutable guards `content`
-- and `snapshot` only); these publication columns are separate operational
-- state, so publish/withdraw are allowed on an already-issued report WITHOUT
-- touching the frozen customer-visible content.
--
-- Publication is a DELIBERATE, separate step from issuing: a report can be
-- issued internally and only later made visible to the customer.
--
-- Portal visibility rule (enforced in code on the service-role portal path,
-- which has NO customer JWT — the URL token is the credential, resolved by
-- loadCustomerByPortalToken; see lib/site-reports/portal.ts isPortalVisible):
--     visible == status IN ('issued','superseded')      -- current or historical
--             AND portal_published_at  IS NOT NULL
--             AND portal_withdrawn_at  IS NULL
-- A superseded-but-published report stays visible as history (marked superseded,
-- linking to the current revision); withdrawing hides without deleting.
--
-- Additive + reversible: drop the four columns + the index. No RLS change — the
-- portal reads on the admin client filtered in code by the token-resolved
-- customer (exactly like quotes/invoices), and the existing tenant RLS already
-- covers these columns for internal access.

alter table public.site_reports
  add column if not exists portal_published_at  timestamp with time zone,
  add column if not exists portal_published_by  uuid references public.users(id) on delete set null,
  add column if not exists portal_withdrawn_at  timestamp with time zone,
  add column if not exists customer_notified_at timestamp with time zone;

comment on column public.site_reports.portal_published_at is
  'When the issued report was made visible in the customer portal. NULL = not '
  'published. Publishing clears portal_withdrawn_at.';
comment on column public.site_reports.portal_withdrawn_at is
  'When portal visibility was revoked. Set => hidden from the portal without '
  'deleting the report or its audit history.';
comment on column public.site_reports.customer_notified_at is
  'When a customer notification was recorded as delivered. Distinct from '
  'published: notified is a communications fact, not a visibility fact.';

-- Portal list query: this customer's currently-visible issued reports, newest
-- first. Partial index over exactly the visible set.
create index if not exists site_reports_portal_visible_idx
  on public.site_reports (customer_id, portal_published_at desc)
  where status in ('issued', 'superseded')
    and portal_published_at is not null
    and portal_withdrawn_at is null;
