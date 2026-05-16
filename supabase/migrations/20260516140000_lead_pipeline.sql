-- Slice 2: Lead pipeline.
--
-- Touches:
--   - public.leads: + estimated_value numeric(12,2)  pipeline forecast field
--                   + notes text                     free-text observations
--
-- Status remains a free-text column (no CHECK constraint) so the
-- pipeline can evolve without DB migrations every time a stage is
-- renamed. The canonical stage list lives in lib/leads/schema.ts.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

alter table public.leads
  add column if not exists estimated_value numeric(12, 2),
  add column if not exists notes           text;

create index if not exists leads_org_status_idx       on public.leads (org_id, status);
create index if not exists leads_org_assigned_idx     on public.leads (org_id, assigned_to);
create index if not exists leads_org_last_activity_idx on public.leads (org_id, last_activity_at desc);
