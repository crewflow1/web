-- Invoice auto-generation from completed work (Master Plan).
--
-- Today a completed job only *suggests* an invoice: the automation rule
-- `job_completed_suggest_invoice` fires a "Job marked complete — send the
-- invoice?" notification. The Master Plan wants the DRAFT invoice generated
-- automatically from the job's remaining billing-plan basis — a human still
-- reviews and sends it (drafts only; money is never posted without a person).
--
-- This migration adds the SERVICE-ROLE path the automation dispatcher needs,
-- WITHOUT forking any invoice math:
--
--   1. `_generate_stage_invoice_row(stage, due)` — the EXACT stage→invoice body
--      that `generate_stage_invoice` already used (number allocation, per-stage
--      VAT, one line-item snapshot, draft status, invoice_id CAS binding), lifted
--      verbatim into an internal helper WITHOUT the caller-identity checks. This
--      is the single source of the invoice math.
--   2. `generate_stage_invoice(stage, due)` — REPOINTED at the helper. Its
--      external contract is unchanged: it still requires auth.uid() and
--      is_org_admin(stage.org_id) before doing anything, then delegates. The
--      manual "Generate invoice" button behaves exactly as before.
--   3. `automation_invoice_job_completion(job, org)` — NEW, service-role only.
--      For a job's ACTIVE billing plan it generates a draft invoice for EVERY
--      remaining un-invoiced stage, reusing (1) so the math is byte-identical to
--      the manual path. Org is passed EXPLICITLY and pinned on every hop (the
--      dispatcher runs service-role, where auth.uid() is null and RLS is
--      bypassed — so tenancy MUST be enforced in the function). It never sends
--      (drafts only) and is idempotent: an already-invoiced stage is excluded by
--      the `invoice_id is null` filter and the stage's invoice_id CAS, so a
--      re-fired `job.completed` never double-bills. When there is no active plan,
--      no customer, or nothing remaining, it returns a status the caller maps to
--      a documented skip — falling back to the existing "suggest" behaviour
--      rather than inventing an amount.
--
-- Additive + reversible. To roll back:
--   drop function public.automation_invoice_job_completion(uuid, uuid);
--   -- then restore generate_stage_invoice's inline body (20261039000000) and
--   drop function public._generate_stage_invoice_row(uuid, date);
-- No table, bucket, cron, provider or env added.

-- ── internal core: the stage→invoice body, WITHOUT identity checks ────────────
-- Lifted verbatim from generate_stage_invoice (20261039000000). Callers are
-- responsible for authorising (the public RPC checks auth.uid()+is_org_admin; the
-- automation wrapper pins the org). NOT granted to anyone: reachable only through
-- the two SECURITY DEFINER callers below, which run as this function's owner.
create or replace function public._generate_stage_invoice_row(p_stage_id uuid, p_due_date date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_stage    public.job_billing_stages%rowtype;
  v_customer uuid;
  v_number   text;
  v_vat      numeric(12,2);
  v_due      date;
  v_invoice  uuid;
begin
  select * into v_stage from public.job_billing_stages where id = p_stage_id for update;
  if not found then raise exception 'billing stage not found'; end if;
  if (select status from public.job_billing_plans where id = v_stage.plan_id) <> 'active' then
    raise exception 'the billing plan is not active';
  end if;
  if v_stage.invoice_id is not null then raise exception 'this stage has already been invoiced'; end if;
  if v_stage.amount <= 0 then raise exception 'a stage must have a positive amount to invoice'; end if;

  select customer_id into v_customer from public.jobs where id = v_stage.job_id;
  if v_customer is null then
    raise exception 'this job has no customer — set a customer on the job before invoicing';
  end if;

  v_number := public.next_invoice_number(v_stage.org_id);
  v_vat := round(v_stage.amount * v_stage.vat_rate / 100.0, 2);
  v_due := coalesce(p_due_date, v_stage.due_date, ((now() at time zone 'utc')::date + 14));

  insert into public.invoices (org_id, job_id, quote_id, customer_id, number, amount, vat_total, status, due_date, notes)
    values (v_stage.org_id, v_stage.job_id, null, v_customer, v_number, v_stage.amount, v_vat, 'draft', v_due, v_stage.name)
    returning id into v_invoice;

  insert into public.invoice_line_items (invoice_id, org_id, description, qty, unit, unit_price, vat_rate, line_total, sort_order)
    values (v_invoice, v_stage.org_id, v_stage.name, 1, 'item', v_stage.amount, v_stage.vat_rate, v_stage.amount, 0);

  update public.job_billing_stages set invoice_id = v_invoice where id = p_stage_id;
  return v_invoice;
end $$;

-- Supabase ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions to
-- anon + authenticated directly (not via PUBLIC), so revoking from PUBLIC alone
-- leaves this raw, unguarded (no current_org_ids/is_org_admin) secdef invoice-
-- creation core reachable by any authenticated caller — a cross-tenant write
-- primitive. Revoke from all three roles: internal only, reached solely via the
-- two definer callers below (they execute it as the owner).
revoke all on function public._generate_stage_invoice_row(uuid, date) from public, anon, authenticated;

-- ── public RPC: identity checks preserved EXACTLY, body delegated ─────────────
-- Same signature, same guards, same behaviour as 20261039000000 — the manual
-- "Generate invoice" button is unaffected. Only the shared body now lives in the
-- helper, so the automation path and the manual path can never drift.
create or replace function public.generate_stage_invoice(p_stage_id uuid, p_due_date date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select org_id into v_org from public.job_billing_stages where id = p_stage_id;
  if not found then raise exception 'billing stage not found'; end if;
  if not public.is_org_admin(v_org) then
    raise exception 'only an owner or admin can generate a stage invoice';
  end if;
  return public._generate_stage_invoice_row(p_stage_id, p_due_date);
end $$;

revoke all on function public.generate_stage_invoice(uuid, date) from public;
grant execute on function public.generate_stage_invoice(uuid, date) to authenticated;

-- ── automation wrapper: draft invoices for a completed job's remaining stages ─
-- SERVICE-ROLE only (the automation dispatcher runs service-role). Org is passed
-- explicitly and pinned on every hop — a forged/foreign job_id resolves to
-- nothing, so this can only ever bill within its own org. Returns a jsonb status
-- the dispatcher maps to a run result:
--   {status:'no_job'}            → job absent in this org         → suggest fallback
--   {status:'no_plan'}           → no active billing plan         → suggest fallback
--   {status:'no_customer'}       → job has no customer to bill     → suggest fallback
--   {status:'nothing_remaining'} → plan exists, all stages billed  → nothing to do
--   {status:'created', count, invoices:[{stage_id, invoice_id}...]} → drafts made
-- Never sends; the helper writes status 'draft'. Idempotent: already-invoiced
-- stages are excluded, so a re-fired job.completed cannot double-invoice.
create or replace function public.automation_invoice_job_completion(p_job_id uuid, p_org_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_plan     uuid;
  v_customer uuid;
  v_found    boolean;
  v_stage    record;
  v_inv      uuid;
  v_created  jsonb := '[]'::jsonb;
  v_count    int := 0;
begin
  if p_job_id is null or p_org_id is null then
    return jsonb_build_object('status', 'invalid_args');
  end if;

  -- Org pin: the job must belong to the passed org.
  select customer_id into v_customer from public.jobs where id = p_job_id and org_id = p_org_id;
  get diagnostics v_found = row_count;
  if not v_found then
    return jsonb_build_object('status', 'no_job');
  end if;

  -- The job's ACTIVE billing plan (org-pinned). No plan → the caller falls back
  -- to the existing suggest behaviour rather than inventing a value.
  select id into v_plan from public.job_billing_plans
    where job_id = p_job_id and org_id = p_org_id and status = 'active' limit 1;
  if v_plan is null then
    return jsonb_build_object('status', 'no_plan');
  end if;

  -- A stage invoice needs a customer (the helper would raise otherwise); a
  -- customer-less job is an ambiguous basis → suggest fallback, not a failure.
  if v_customer is null then
    return jsonb_build_object('status', 'no_customer');
  end if;

  -- Generate a draft for every remaining un-invoiced, positive-amount stage,
  -- in plan order. Reuses the shared core, so VAT + line snapshot + numbering
  -- are identical to the manual path. Runs in the caller's single transaction
  -- (all-or-nothing), so a mid-loop failure rolls back cleanly and a retry
  -- re-bills only the still-uninvoiced stages.
  for v_stage in
    select id from public.job_billing_stages
      where plan_id = v_plan and org_id = p_org_id and job_id = p_job_id
        and invoice_id is null and amount > 0
      order by sequence asc, created_at asc
  loop
    v_inv := public._generate_stage_invoice_row(v_stage.id, null);
    v_created := v_created || jsonb_build_array(
      jsonb_build_object('stage_id', v_stage.id, 'invoice_id', v_inv)
    );
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    return jsonb_build_object('status', 'nothing_remaining');
  end if;
  return jsonb_build_object('status', 'created', 'count', v_count, 'invoices', v_created);
end $$;

-- Revoke from anon + authenticated too (Supabase default-grants them EXECUTE at
-- CREATE time): this is service-role only — the automation dispatcher runs as
-- service_role. A tenant caller must never reach it directly.
revoke all on function public.automation_invoice_job_completion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.automation_invoice_job_completion(uuid, uuid) to service_role;
