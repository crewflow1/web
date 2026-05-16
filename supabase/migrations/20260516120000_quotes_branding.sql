-- Quotes module — owner-controlled branding + sequential quote numbering.
--
-- Touches:
--   - public.organizations  (additive nullable columns for PDF rendering)
--   - new function:         public.next_quote_number(uuid) — per-org
--                           sequential Q-NNNN allocator, same pattern as
--                           next_invoice_number().
--
-- Idempotent: every column uses IF NOT EXISTS; function uses OR REPLACE.

-- Branding fields rendered on quote + invoice PDFs.
alter table public.organizations
  add column if not exists logo_url      text,
  add column if not exists default_terms text,
  add column if not exists bank_details  jsonb;

-- Per-org sequential quote number. Matches the Q-NNNN format the app uses.
-- Existing seeded numbers like "Q-2026-0001" are intentionally NOT matched
-- by the regex — they don't influence the next-number calculation, so
-- production starts cleanly at Q-0001.
create or replace function public.next_quote_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  select coalesce(
    max(cast(substring(number from 'Q-(\d+)') as int)),
    0
  ) + 1
  into next_num
  from public.quotes
  where org_id = target_org
    and number ~ '^Q-\d+$';

  return 'Q-' || lpad(next_num::text, 4, '0');
end;
$$;

grant execute on function public.next_quote_number(uuid) to authenticated;
