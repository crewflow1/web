-- ============================================================================
-- Quote acceptance — make the job + invoice an accepted quote implies ATOMIC
-- and EXACTLY-ONCE.
--
-- THE DEFECT (resilience programme, failure-mode matrix PW-01/PW-02/PW-03).
-- An accepted quote implies two artifacts: a job (unless it already has one —
-- variations carry the parent's) and a draft invoice. The application created
-- them as a chain of independent PostgREST statements:
--
--     insert job → update quotes.job_id → select invoice → rpc next_invoice_number
--     → insert invoice
--
-- supabase-js issues one statement per call, so nothing tied them together:
--
--   * DUPLICATE JOB. Two accepts in flight for the same quote each read
--     `job_id IS NULL` and each inserted a job. The invoice was protected by
--     invoices_quote_id_unique; the job had no such fence. Three concurrent
--     re-accepts produced three jobs (proved on real Postgres before this fix).
--   * INVOICE-LESS ACCEPTED QUOTE. `next_invoice_number` is max()+1 with no
--     lock, so two DIFFERENT quotes of one org accepted at the same moment were
--     handed the same number; the loser's insert hit invoices_org_number_key and
--     the failure was only logged. The customer saw "accepted"; the business got
--     no invoice and nobody was told.
--   * HALF-WRITTEN ACCEPT. When the invoice step failed, the job and its
--     backlink were already committed.
--
-- THE FIX. One function, one transaction:
--
--   1. lock the quote row (FOR UPDATE) — concurrent callers for the same quote
--      queue here and the second one sees the first one's job + invoice;
--   2. create the job + backlink only if the quote has none;
--   3. reuse any invoice already linked to the quote, else take a per-org
--      transaction-scoped advisory lock (so callers of THIS function never race
--      each other for a number), allocate, and insert — retrying a bounded number
--      of times if a different, unlocked invoice writer took the number first.
--
-- Any failure rolls back ALL of it: the quote is left exactly as it was
-- (accepted, artifact-less) and the next accept — public or owner — heals it.
--
-- SECURITY INVOKER on purpose (the allocate_payment precedent, 20261010000000):
-- the caller's own RLS and grants apply to every statement, so this function
-- adds NO privilege. The owner path (user JWT) needs exactly the rights it
-- already needed to do the same writes by hand; the public token path runs it
-- as service_role, exactly as before. The explicit membership check gives a
-- clean 42501 instead of an RLS-shaped "not found", and p_org_id pins the
-- ACTIVE org so a multi-org member can never act on another org's quote.
--
-- Additive: one new function. No table, policy, grant or existing function is
-- changed.
-- ============================================================================

create or replace function public.ensure_accepted_quote_artifacts(
  p_org_id            uuid,
  p_quote_id          uuid,
  p_job_site_address  text default null,
  p_job_notes         text default null,
  p_due_date          date default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_quote            public.quotes%rowtype;
  v_job_id           uuid;
  v_invoice_id       uuid;
  v_created_job      boolean := false;
  v_created_invoice  boolean := false;
  v_number           text;
  v_attempt          int := 0;
  v_constraint       text;
begin
  -- Tenant fence. service_role is the public-token accept path (no user JWT).
  if p_org_id is null
     or (auth.role() is distinct from 'service_role'
         and p_org_id not in (select public.current_org_ids())) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- (1) Serialise every caller for this quote. Pinned to the ACTIVE org: a
  --     quote in another org is "not found", never acted on.
  select * into v_quote
    from public.quotes
   where id = p_quote_id and org_id = p_org_id
     for update;
  if not found then
    raise exception 'quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_quote.status is distinct from 'accepted' then
    raise exception 'quote % is not accepted', p_quote_id using errcode = 'check_violation';
  end if;

  -- (2) JOB — reuse the quote's job (variations carry the parent's); create one
  --     only for a quote that has a customer to attach it to.
  v_job_id := v_quote.job_id;
  if v_job_id is null and v_quote.customer_id is not null then
    insert into public.jobs (org_id, customer_id, status, site_address_line1, notes)
    values (p_org_id, v_quote.customer_id, 'new', p_job_site_address, p_job_notes)
    returning id into v_job_id;

    update public.quotes
       set job_id = v_job_id
     where id = p_quote_id and org_id = p_org_id;
    v_created_job := true;
  end if;

  -- (3) INVOICE — reuse one already linked to this quote (idempotency + heal).
  select id into v_invoice_id
    from public.invoices
   where quote_id = p_quote_id and org_id = p_org_id
   limit 1;

  if v_invoice_id is null then
    -- Callers of this function never race each other for a number.
    perform pg_advisory_xact_lock(hashtextextended('crewflow:invoice_number:' || p_org_id::text, 0));

    loop
      v_attempt := v_attempt + 1;
      v_number := public.next_invoice_number(p_org_id);
      begin
        insert into public.invoices
          (org_id, quote_id, customer_id, number, amount, vat_total, status, job_id, due_date)
        values
          (p_org_id, p_quote_id, v_quote.customer_id, v_number,
           v_quote.subtotal, v_quote.vat_total, 'draft', v_job_id,
           coalesce(p_due_date, (now() at time zone 'utc')::date + 14))
        returning id into v_invoice_id;
        v_created_invoice := true;
        exit;
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'invoices_quote_id_unique' then
          -- Another writer that does not take the quote lock (the manual
          -- "create invoice from quote" route) linked one first — reuse it.
          select id into v_invoice_id
            from public.invoices
           where quote_id = p_quote_id and org_id = p_org_id
           limit 1;
          exit;
        end if;
        -- invoices_org_number_key: an invoice writer outside this function took
        -- the number between allocation and insert. Re-allocate, bounded.
        if v_attempt >= 5 then
          raise;
        end if;
      end;
    end loop;
  end if;

  return jsonb_build_object(
    'job_id', v_job_id,
    'invoice_id', v_invoice_id,
    'created_job', v_created_job,
    'created_invoice', v_created_invoice
  );
end;
$$;

comment on function public.ensure_accepted_quote_artifacts(uuid, uuid, text, text, date) is
  'Atomically and idempotently ensure the job + draft invoice of an ACCEPTED quote exist. SECURITY INVOKER — caller RLS applies; service_role is the public-token accept path.';

-- Trust boundary: the default PUBLIC EXECUTE is stripped. `authenticated` is the
-- owner-accept path (RLS-fenced, see header); `service_role` is the public
-- token path. `anon` holds nothing.
revoke all on function public.ensure_accepted_quote_artifacts(uuid, uuid, text, text, date) from public;
revoke all on function public.ensure_accepted_quote_artifacts(uuid, uuid, text, text, date) from anon;
grant execute on function public.ensure_accepted_quote_artifacts(uuid, uuid, text, text, date) to authenticated;
grant execute on function public.ensure_accepted_quote_artifacts(uuid, uuid, text, text, date) to service_role;
