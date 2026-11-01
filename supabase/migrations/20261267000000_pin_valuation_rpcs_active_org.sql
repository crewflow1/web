-- ============================================================================
-- Active-org pin for the valuation certify / generate-invoice RPCs.
-- ============================================================================
-- certify_valuation(p_valuation_id) and generate_valuation_invoice(
-- p_valuation_id, p_due_date) derived the org FROM the valuation row and gated
-- only on is_org_admin(v_val.org_id). is_org_admin() is true for EVERY org the
-- caller administers, so a user who is an admin of two orgs, while working in
-- org A, could certify or invoice a valuation belonging to org B by its id —
-- the active-org integrity defect class (the #456 read-side / write-slice class):
-- membership-in-the-row's-org is not the same as the caller's ACTIVE org.
--
-- FIX: both RPCs now take the caller's ACTIVE org id as the first argument
-- (the action layer passes ctx.org.id) and:
--   1. guard it with current_org_ids() + 42501 — the caller must actually belong
--      to p_org_id (this also satisfies the secdef-org-rpc guard, since the
--      functions now take an org id and are executable by `authenticated`);
--   2. fetch the valuation PINNED to that org
--      (where id = p_valuation_id AND org_id = p_org_id) — a valuation outside
--      the active org is now indistinguishable from a missing one (no cross-org
--      oracle), so a dual-org admin can only act within the org they are in.
-- Everything else — the per-job advisory lock, the cumulation/variation fences,
-- the invoice authority, the CAS bind — is UNCHANGED (v_val.org_id now always
-- equals p_org_id, so the existing org-pinned sub-reads behave identically).
--
-- SIGNATURE CHANGE: the old single-arg / (uuid, date) signatures are DROPPED so
-- no unpinned overload survives; the app callers + generated types pass p_org_id.
-- ROLLBACK: re-create the 20261192000000 definitions (and drop these).
-- ============================================================================

drop function if exists public.certify_valuation(uuid);
drop function if exists public.generate_valuation_invoice(uuid, date);

create or replace function public.certify_valuation(p_org_id uuid, p_valuation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_val        public.job_valuations%rowtype;
  v_variations numeric(14,2);
  v_prev       numeric(14,2);
  v_gross      numeric(14,2);
  v_net        numeric(14,2);
  v_rate       numeric(5,2);
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  -- Active-org / membership guard (canonical current_org_ids + 42501).
  if p_org_id not in (select public.current_org_ids()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Fetch PINNED to the active org: a valuation outside it is "not found".
  select * into v_val from public.job_valuations
  where id = p_valuation_id and org_id = p_org_id for update;
  if not found then raise exception 'valuation not found'; end if;
  if not public.is_org_admin(v_val.org_id) then
    raise exception 'only an owner or admin can certify a valuation';
  end if;
  if v_val.status <> 'submitted' then
    raise exception 'only a submitted valuation can be certified (this one is %)', v_val.status;
  end if;

  -- ── SERIALIZE CERTIFICATION PER JOB (concurrent double-count fence) ──────────
  -- The `for update` above locks only THIS row. The cumulation base below is a
  -- sum over the job's OTHER certified/invoiced valuations, read UNLOCKED. Under
  -- READ COMMITTED, two concurrent certifications of SIBLING valuations of the
  -- same job would both read previous_certified_gross before either commits — so
  -- both see the stale base (e.g. 0), both certify the full increment, and Σ
  -- net_certified_this exceeds the true cumulative works: a double invoice.
  --
  -- A transaction-scoped advisory lock keyed on the JOB serializes them: the
  -- second certification blocks here until the first COMMITS, then reads the
  -- first's committed net_certified_this into the base (or the non-negative guard
  -- below rejects the now-over-certified increment). Per-job (not global) so
  -- certifications on different jobs never contend. Released automatically at
  -- transaction end.
  perform pg_advisory_xact_lock(hashtextextended(v_val.job_id::text, 0));

  -- Σ linked variation NET values (org-pinned). Re-validate each is still an
  -- accepted variation with no issued invoice — the same fence as the link guard,
  -- re-checked at the moment of certification.
  select coalesce(sum(jvv.amount), 0) into v_variations
  from public.job_valuation_variations jvv
  join public.quotes q
    on q.id = jvv.variation_quote_id and q.org_id = jvv.org_id
  where jvv.valuation_id = p_valuation_id
    and jvv.org_id = v_val.org_id
    and q.variation_number is not null
    and q.status = 'accepted';

  if exists (
    select 1
    from public.job_valuation_variations jvv
    join public.invoices i
      on i.quote_id = jvv.variation_quote_id and i.org_id = jvv.org_id and i.status <> 'draft'
    where jvv.valuation_id = p_valuation_id and jvv.org_id = v_val.org_id
  ) then
    raise exception 'a linked variation now carries an issued invoice — remove it before certifying';
  end if;

  -- Cumulation: previously certified gross = Σ net_certified_this of PRIOR
  -- certified/invoiced valuations for this job (org-pinned).
  select coalesce(sum(net_certified_this), 0) into v_prev
  from public.job_valuations
  where job_id = v_val.job_id
    and org_id = v_val.org_id
    and id <> p_valuation_id
    and status in ('certified','invoiced');

  v_gross := round(v_val.work_completed_to_date + v_val.materials_on_site + v_variations, 2);
  v_net   := round(v_gross - v_prev - v_val.deductions, 2);
  if v_net < 0 then
    raise exception 'certified amount is negative (gross %, previously certified %, deductions %) — a valuation cannot go backwards below what is already certified',
      v_gross, v_prev, v_val.deductions;
  end if;

  select retention_percent into v_rate from public.jobs
  where id = v_val.job_id and org_id = v_val.org_id;
  v_rate := coalesce(v_rate, 0);

  update public.job_valuations
     set status = 'certified',
         variations_total = v_variations,
         gross_valuation = v_gross,
         previous_certified_gross = v_prev,
         net_certified_this = v_net,
         retention_percent = v_rate,
         certified_at = now(),
         certified_by = auth.uid()
   where id = p_valuation_id;

  perform public._record_activity(
    v_val.org_id, 'valuation.certified', 'job_valuations', p_valuation_id,
    jsonb_build_object(
      'job_id', v_val.job_id, 'sequence', v_val.sequence,
      'gross_valuation', v_gross, 'previous_certified_gross', v_prev,
      'net_certified_this', v_net, 'retention_percent', v_rate
    )
  );

  return p_valuation_id;
end $$;

revoke all on function public.certify_valuation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.certify_valuation(uuid, uuid) to authenticated;

comment on function public.certify_valuation(uuid, uuid) is
  'Admin-only, active-org-pinned (p_org_id). Certifies a submitted valuation: '
  'snapshots variations_total, gross_valuation, previous_certified_gross (Σ prior '
  'certified increments), net_certified_this and retention_percent, then freezes '
  'them. Refuses a negative increment. Retention is not touched — it is derived '
  'from the invoice the next step generates.';

create or replace function public.generate_valuation_invoice(p_org_id uuid, p_valuation_id uuid, p_due_date date default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_val      public.job_valuations%rowtype;
  v_customer uuid;
  v_number   text;
  v_vat      numeric(12,2);
  v_due      date;
  v_invoice  uuid;
  v_desc     text;
  v_draft_inv record;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  -- Active-org / membership guard (canonical current_org_ids + 42501).
  if p_org_id not in (select public.current_org_ids()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Fetch PINNED to the active org: a valuation outside it is "not found".
  select * into v_val from public.job_valuations
  where id = p_valuation_id and org_id = p_org_id for update;
  if not found then raise exception 'valuation not found'; end if;
  if not public.is_org_admin(v_val.org_id) then
    raise exception 'only an owner or admin can generate a valuation invoice';
  end if;
  if v_val.status <> 'certified' then
    raise exception 'only a certified valuation can be invoiced (this one is %)', v_val.status;
  end if;
  if v_val.invoice_id is not null then
    raise exception 'this valuation has already been invoiced';
  end if;
  if coalesce(v_val.net_certified_this, 0) <= 0 then
    raise exception 'a valuation must certify a positive amount to invoice';
  end if;

  -- Re-fence double-bill at generation time (a variation invoice could have been
  -- issued between certify and now).
  if exists (
    select 1
    from public.job_valuation_variations jvv
    join public.invoices i
      on i.quote_id = jvv.variation_quote_id and i.org_id = jvv.org_id and i.status <> 'draft'
    where jvv.valuation_id = p_valuation_id and jvv.org_id = v_val.org_id
  ) then
    raise exception 'a linked variation now carries an issued invoice — cannot generate a valuation invoice';
  end if;

  -- Defense-in-depth supersede: delete any variation DRAFT accept-invoice that
  -- reappeared after linking (e.g. the variation was re-accepted between link and
  -- now). The link-time delete is the primary fence; this closes the
  -- re-accept-between-link-and-generate window so a variation billed via this
  -- valuation can never also be billed by a lingering draft accept-invoice.
  for v_draft_inv in
    select i.id, i.number
    from public.job_valuation_variations jvv
    join public.invoices i
      on i.quote_id = jvv.variation_quote_id and i.org_id = jvv.org_id and i.status = 'draft'
    where jvv.valuation_id = p_valuation_id and jvv.org_id = v_val.org_id
  loop
    delete from public.invoices where id = v_draft_inv.id and org_id = v_val.org_id;
    perform public._record_activity(
      v_val.org_id, 'invoice.superseded_by_valuation', 'invoices', v_draft_inv.id,
      jsonb_build_object(
        'valuation_id', p_valuation_id,
        'invoice_number', v_draft_inv.number,
        'reason', 'variation billed via interim valuation (generate-time supersede)'
      )
    );
  end loop;

  select customer_id into v_customer from public.jobs
  where id = v_val.job_id and org_id = v_val.org_id;
  if v_customer is null then
    raise exception 'this job has no customer — set a customer on the job before invoicing';
  end if;

  v_number := public.next_invoice_number(v_val.org_id);
  v_vat := round(v_val.net_certified_this * v_val.vat_rate / 100.0, 2);
  v_due := coalesce(p_due_date, ((now() at time zone 'utc')::date + 14));
  v_desc := 'Valuation ' || v_val.sequence || ' — works to '
            || to_char(coalesce(v_val.period_end, v_val.valuation_date), 'DD Mon YYYY');

  insert into public.invoices (org_id, job_id, quote_id, customer_id, number, amount, vat_total, status, due_date, notes)
    values (v_val.org_id, v_val.job_id, null, v_customer, v_number,
            v_val.net_certified_this, v_vat, 'draft', v_due, v_desc)
    returning id into v_invoice;

  -- The AFTER-INSERT snapshot trigger only copies quote lines (quote_id is null
  -- here), so write the single valuation line explicitly — same shape as the
  -- stage-invoice path.
  insert into public.invoice_line_items (invoice_id, org_id, description, qty, unit, unit_price, vat_rate, line_total, sort_order)
    values (v_invoice, v_val.org_id, v_desc, 1, 'item', v_val.net_certified_this, v_val.vat_rate, v_val.net_certified_this, 0);

  update public.job_valuations
     set status = 'invoiced', invoice_id = v_invoice
   where id = p_valuation_id;

  perform public._record_activity(
    v_val.org_id, 'valuation.invoiced', 'job_valuations', p_valuation_id,
    jsonb_build_object(
      'job_id', v_val.job_id, 'sequence', v_val.sequence,
      'invoice_id', v_invoice, 'invoice_number', v_number,
      'amount', v_val.net_certified_this, 'vat_total', v_vat
    )
  );

  return v_invoice;
end $$;

revoke all on function public.generate_valuation_invoice(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.generate_valuation_invoice(uuid, uuid, date) to authenticated;

comment on function public.generate_valuation_invoice(uuid, uuid, date) is
  'Admin-only, active-org-pinned (p_org_id). Generates the stage invoice for a '
  'certified valuation through the shared invoice authority (next_invoice_number '
  '+ invoices + invoice_line_items, draft status). ex-VAT amount = '
  'net_certified_this so retention accrues once. CAS-binds invoice_id and flips '
  'status to invoiced; idempotent (refuses if already invoiced).';
