-- Job profitability: link invoices to jobs so revenue can roll up per job.
--
-- The existing model:
--   leads → quotes → invoices (FK quote_id, ON DELETE SET NULL)
--   jobs is a separate delivery/scheduling entity, customer-scoped
--
-- We now add an OPTIONAL invoices.job_id FK so the operator can attribute
-- revenue to a specific job for profitability. Nullable + SET NULL so
-- deleting a job doesn't cascade-drop invoices (HMRC retention).
--
-- Cost categorisation lives in finances.category (free-text today) and
-- maps to the 4 profitability buckets in code — no DB change needed
-- there.
--
-- Idempotent.

alter table public.invoices
  add column if not exists job_id uuid references public.jobs(id) on delete set null;

create index if not exists invoices_job_id_idx on public.invoices (job_id);
