-- ============================================================================
-- Quote edit — replace a quote's header + line items ATOMICALLY.
--
-- THE DEFECT (resilience programme, failure-mode matrix PW-04). updateQuote
-- saved an edit as three independent PostgREST statements:
--
--     UPDATE quotes (new totals) → DELETE quote_line_items → INSERT quote_line_items
--
-- supabase-js issues one statement per call. If the INSERT failed after the
-- DELETE committed — a dropped connection, a statement timeout, pool
-- exhaustion, a constraint, or the freeze trigger firing because the customer
-- accepted in the gap — the quote was left with totals describing line items
-- that no longer existed. The previously saved, priced scope was destroyed; the
-- only copy of the replacement was the form state in one browser tab.
--
-- A second hazard hid in the same gap: tg_quote_line_items_freeze_accepted
-- guards INSERT/UPDATE but not DELETE, so an edit racing a customer acceptance
-- could delete the lines of a quote that had just become a firm agreement and
-- then be refused the re-insert — an ACCEPTED quote with no line items (and an
-- invoice snapshot taken from nothing).
--
-- THE FIX. One function, one transaction: lock the quote row, refuse an
-- accepted quote BEFORE touching anything, update the header (reverting an
-- approved/sent/viewed quote to pending_approval, decided on the LOCKED row
-- rather than a stale read), delete the old lines, insert the new ones. Any
-- failure rolls back all of it — the previous header and lines survive intact.
-- A concurrent acceptance now queues on the row lock and sees either the whole
-- edit or none of it.
--
-- SECURITY INVOKER (the allocate_payment precedent, 20261010000000): the
-- caller's RLS and grants apply to every statement — this adds NO privilege
-- over the three statements it replaces. p_org_id pins the ACTIVE org; the
-- membership fence gives a clean 42501.
--
-- Additive: one new function. Nothing existing is changed.
-- ============================================================================

create or replace function public.replace_quote_content(
  p_org_id    uuid,
  p_quote_id  uuid,
  p_header    jsonb,
  p_lines     jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_quote       public.quotes%rowtype;
  v_revert      boolean;
  v_line_count  int := 0;
  v_status      text;
begin
  if p_org_id is null
     or (auth.role() is distinct from 'service_role'
         and p_org_id not in (select public.current_org_ids())) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  if p_header is null or jsonb_typeof(p_header) <> 'object' then
    raise exception 'header must be a json object' using errcode = 'invalid_parameter_value';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines must be a json array' using errcode = 'invalid_parameter_value';
  end if;

  -- Serialise against every other writer of this quote (a concurrent edit, and
  -- — because the accepting UPDATE needs the same row lock — an acceptance).
  select * into v_quote
    from public.quotes
   where id = p_quote_id and org_id = p_org_id
     for update;
  if not found then
    raise exception 'quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  -- An accepted quote is a firm agreement: refuse BEFORE the delete, which the
  -- line-item freeze trigger does not cover.
  if v_quote.accepted_at is not null or v_quote.status = 'accepted' then
    raise exception 'quote % has been accepted; it cannot be edited', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- Past the approval gate → the approver re-confirms the new numbers.
  v_revert := v_quote.status in ('approved', 'sent', 'viewed');

  update public.quotes
     set customer_id = (p_header->>'customer_id')::uuid,
         property_id = nullif(p_header->>'property_id', '')::uuid,
         lead_id     = nullif(p_header->>'lead_id', '')::uuid,
         subtotal    = (p_header->>'subtotal')::numeric,
         vat_total   = (p_header->>'vat_total')::numeric,
         total       = (p_header->>'total')::numeric,
         notes       = p_header->>'notes',
         terms       = p_header->>'terms',
         valid_until = nullif(p_header->>'valid_until', '')::date,
         status      = case when v_revert then 'pending_approval' else status end,
         approved_by = case when v_revert then null else approved_by end,
         approved_at = case when v_revert then null else approved_at end
   where id = p_quote_id and org_id = p_org_id
   returning status into v_status;

  delete from public.quote_line_items
   where quote_id = p_quote_id and org_id = p_org_id;

  insert into public.quote_line_items
    (quote_id, org_id, description, qty, unit, unit_price, vat_rate, line_total, sort_order)
  select p_quote_id, p_org_id, l.description, l.qty, l.unit, l.unit_price, l.vat_rate, l.line_total, l.sort_order
    from jsonb_to_recordset(p_lines) as l(
      description text, qty numeric, unit text, unit_price numeric,
      vat_rate numeric, line_total numeric, sort_order int
    );
  get diagnostics v_line_count = row_count;

  return jsonb_build_object('status', v_status, 'line_count', v_line_count);
end;
$$;

comment on function public.replace_quote_content(uuid, uuid, jsonb, jsonb) is
  'Atomically replace a non-accepted quote''s header + line items. SECURITY INVOKER — caller RLS applies.';

revoke all on function public.replace_quote_content(uuid, uuid, jsonb, jsonb) from public;
revoke all on function public.replace_quote_content(uuid, uuid, jsonb, jsonb) from anon;
grant execute on function public.replace_quote_content(uuid, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.replace_quote_content(uuid, uuid, jsonb, jsonb) to service_role;
