-- Variation Orders v1
--
-- Variations are scope changes after a quote is accepted. Rather than
-- a parallel system, we EXTEND the quotes table:
--
--   - job_id:           which job this quote/variation belongs to (nullable)
--   - variation_number: per-job sequence, NULL on regular quotes
--   - customer_comment: optional free-text from the customer on accept/decline
--
-- This lets the entire existing quote pipeline (PDF, public token,
-- accept/decline, auto-invoice on accept) handle variations for free.
-- The differentiation surfaces via:
--   - UI: when variation_number IS NOT NULL, render as "Variation #003"
--   - Activity trigger: emits variation.* actions instead of quote.*
--   - Profitability: invoices linked via quote→job aggregate as
--     "variation revenue" on /jobs/[id]

alter table public.quotes
  add column if not exists job_id uuid references public.jobs(id) on delete set null,
  add column if not exists variation_number integer,
  add column if not exists customer_comment text;

create index if not exists quotes_job_id_idx on public.quotes (job_id);

-- Per-job uniqueness for variation numbers. Regular quotes
-- (variation_number IS NULL) are excluded.
create unique index if not exists quotes_job_variation_unique
  on public.quotes (job_id, variation_number)
  where variation_number is not null;

-- next_variation_number(target_job) — picks the smallest integer not
-- yet used. Mirrors next_quote_number / next_invoice_number.
create or replace function public.next_variation_number(target_job uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  -- Verify the caller's JWT has org membership for this job.
  if not exists (
    select 1
    from public.jobs j
    where j.id = target_job
      and j.org_id in (select public.current_org_ids())
  ) then
    raise exception 'next_variation_number: job not found or not allowed';
  end if;

  select coalesce(max(variation_number), 0) + 1
  into v_next
  from public.quotes
  where job_id = target_job
    and variation_number is not null;
  return v_next;
end;
$$;

grant execute on function public.next_variation_number(uuid) to authenticated;

-- Activity trigger update — emit variation.* when variation_number is
-- set; keep quote.* for regular quotes. CREATE OR REPLACE retains the
-- original signature; existing trigger binding is unchanged.
create or replace function public._tg_quotes_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signer text;
  v_is_variation boolean := NEW.variation_number is not null;
  v_label text;
begin
  if TG_OP = 'INSERT' then
    v_label := case when v_is_variation then 'variation.created' else 'quote.created' end;
    perform _record_activity(
      NEW.org_id, v_label, 'quotes', NEW.id,
      jsonb_build_object(
        'number', NEW.number, 'total', NEW.total,
        'customer_id', NEW.customer_id, 'lead_id', NEW.lead_id,
        'job_id', NEW.job_id, 'variation_number', NEW.variation_number
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.sent_at is distinct from OLD.sent_at and NEW.sent_at is not null then
      v_label := case when v_is_variation then 'variation.sent' else 'quote.sent' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number, 'total', NEW.total,
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number
        )
      );
    end if;
    if NEW.viewed_at is distinct from OLD.viewed_at and NEW.viewed_at is not null then
      v_label := case when v_is_variation then 'variation.viewed' else 'quote.viewed' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number,
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number
        ),
        'Customer (public link)'
      );
    end if;
    if NEW.accepted_at is distinct from OLD.accepted_at and NEW.accepted_at is not null then
      v_signer := nullif(NEW.accept_signature ->> 'name', '');
      v_label := case when v_is_variation then 'variation.accepted' else 'quote.accepted' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number, 'total', NEW.total,
          'signer', v_signer,
          'source', NEW.accept_signature ->> 'source',
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number,
          'comment', NEW.customer_comment
        ),
        coalesce(v_signer, null)
      );
    end if;
    if NEW.declined_at is distinct from OLD.declined_at and NEW.declined_at is not null then
      v_label := case when v_is_variation then 'variation.declined' else 'quote.declined' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number,
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number,
          'comment', NEW.customer_comment
        )
      );
    end if;
    return NEW;
  end if;
  return null;
end;
$$;
