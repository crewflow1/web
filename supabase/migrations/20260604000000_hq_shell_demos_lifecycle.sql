-- CrewFlow HQ shell — schema additions for Sprint A.
--
-- Two things:
--
--   1. Extends `demo_requests.status` with the full sales CRM lifecycle
--      the CEO directive lays out:
--
--        pending_demo
--        contacted
--        demo_booked
--        demo_done
--        won
--        lost
--        payment_sent
--        payment_received
--        active_onboarding
--        active
--        (legacy: approved · rejected · cancelled · new · contacted ·
--         qualified · closed_won · closed_lost — kept for backwards
--         compat)
--
--      The superset CHECK preserves every existing value and adds the
--      new lifecycle ones. Default for new rows stays `pending_demo`.
--
--   2. Adds `admin_org_notes` (text, nullable) on `organizations` for
--      Section 10 of the directive — private CEO notes per company.
--      The column is admin-only at the application layer; RLS on
--      organizations already restricts visibility to org members so
--      this isn't user-facing.
--
-- All additive + idempotent.

-- ------------------------------------------------------------------
-- demo_requests — full sales lifecycle
-- ------------------------------------------------------------------

alter table public.demo_requests
  drop constraint if exists demo_requests_status_check;

alter table public.demo_requests
  add constraint demo_requests_status_check
  check (status in (
    -- new lifecycle (CEO directive 2026-05-22)
    'pending_demo',
    'contacted',
    'demo_booked',
    'demo_done',
    'won',
    'lost',
    'payment_sent',
    'payment_received',
    'active_onboarding',
    'active',
    -- previous lifecycle, kept so older panel-driven flows keep working
    'approved',
    'rejected',
    'cancelled',
    -- legacy values from the original demo_requests CHECK
    'new', 'qualified', 'closed_won', 'closed_lost'
  ));

-- ------------------------------------------------------------------
-- organizations — admin-only private notes
-- ------------------------------------------------------------------

alter table public.organizations
  add column if not exists admin_org_notes text;
