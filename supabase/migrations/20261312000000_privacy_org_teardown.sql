-- ACCOUNT & DATA DELETION — company deletion (privacy/account-deletion, 2 of 4).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NOT BUILT ON public.gdpr_erase_org (20261169)
-- ═════════════════════════════════════════════════════════════════════════════
-- gdpr_erase_org anonymises 38 "statutory" tables in place and hard-deletes the
-- rest with targeted `delete … where org_id = $1` statements. Run against a
-- populated synthetic org on real Postgres (docs/programme/deletion/
-- DELETION-EVIDENCE.md §1) it cannot complete:
--   • its generic PII scrub writes '[erased]' into columns bound by CHECK
--     constraints (cis_subcontractors_outcome_dated, supplier_payments_void_
--     evidenced) — and because it is one transaction, that rolls EVERYTHING back;
--   • its targeted deletes are refused by the immutability guards that protect
--     evidence tables (comm_events, job_milestones, job_programme_baselines,
--     asset_inspections.template_id, …). Those guards deliberately permit only
--     ONE delete path: the tenant-teardown cascade, recognised by "the
--     organisation row is already gone" (the 20261052 teardown rule).
-- It is left in place, untouched and DARK. Company deletion here goes with the
-- grain of the schema instead: it removes the ORGANISATION ROW and lets the
-- teardown cascade — the path every guard was written to allow — do the work.
--
-- A processor has no statutory duty to keep a former customer's ledgers (the
-- customer does, and is offered an export first), so nothing tenant-side is
-- "anonymised and kept". What CrewFlow keeps is its OWN accounting record of
-- having billed that customer, copied in minimised form to
-- privacy_retained_billing_records before the row goes. (Legal confirmation of
-- that position is called out in DELETION-DESIGN.md §8.)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- PART A — MAKE THE REMAINING APPEND-ONLY GUARDS TEARDOWN-SAFE
-- ═════════════════════════════════════════════════════════════════════════════
-- 19 guard functions raised UNCONDITIONALLY on DELETE, so `delete from
-- organizations` failed outright for any org holding one row in any of these
-- tables ("comm_events is append-only — DELETE is not permitted"): a tenant with
-- a single logged communication could never be deleted at all. Each gains the
-- SAME escape every other evidence guard already has — a DELETE is let through
-- only when the row's organisation no longer exists, i.e. only inside a teardown
-- cascade. While the organisation exists the tables are exactly as append-only
-- as before, for every role including service_role; UPDATE is never permitted.
-- Messages and SQLSTATEs are preserved verbatim.
do $patch$
declare
  v_tbl text;
begin
  foreach v_tbl in array array[
    'ai_reply_audits',
    'ai_reply_delivery_receipts',
    'ai_reply_transports',
    'receptionist_conversation_actions',
    'receptionist_conversation_authorisations',
    'receptionist_conversation_claim_reassignments',
    'receptionist_conversation_claim_releases',
    'receptionist_conversation_claims',
    'receptionist_conversation_coordinations',
    'receptionist_conversation_executions',
    'receptionist_conversation_fulfilments',
    'receptionist_conversation_lifecycles',
    'receptionist_conversation_orchestrations',
    'receptionist_conversation_outcomes',
    'receptionist_conversation_recoveries',
    'receptionist_conversation_resolutions',
    'receptionist_conversation_verifications',
    'receptionist_review_resolutions'
  ] loop
    -- Migrate-first tolerance: skip a guard whose table is absent here.
    continue when to_regclass('public.' || quote_ident(v_tbl)) is null;
    execute format($f$
      create or replace function public.%I() returns trigger
      language plpgsql as $body$
      begin
        -- Teardown escape (the 20261052 rule): a tenant-teardown cascade removes
        -- the organisation row FIRST; only then may its append-only children go.
        if tg_op = 'DELETE'
           and not exists (select 1 from public.organizations where id = old.org_id) then
          return old;
        end if;
        raise exception '%s is append-only; %% is not permitted', tg_op
          using errcode = 'restrict_violation';
      end;
      $body$;
    $f$, v_tbl || '_block_mutation', v_tbl);
  end loop;
end $patch$;

create or replace function public.tg_comm_events_frozen() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Teardown escape (the 20261052 rule) — see the header of 20261312000000.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;
  raise exception 'comm_events is append-only — % is not permitted', tg_op
    using errcode = 'check_violation';
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B — LOCKOUT: close every tenant door before anything is destroyed
-- ═════════════════════════════════════════════════════════════════════════════
-- DELETION RACING AN IN-FLIGHT WRITE. Tenant writes are authorised by RLS
-- through memberships (current_org_ids()). Removing the memberships — and the
-- API keys — in their own committed transaction means that by the time the
-- teardown runs, no user session and no API client can still be authorised to
-- write into this org. The teardown then takes the organisation row itself,
-- after which any straggling write fails its org_id foreign key outright.
--
-- The member ids are captured into the ledger's transient `work` set in the same
-- transaction, because the memberships that named them are about to be gone and
-- the identity step still needs to know whose account may now be orphaned.
--
-- Requires the Stripe step to be recorded first: a company must never be torn
-- down while its subscription is still billing.
create or replace function public.privacy_org_lockout(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row     public.privacy_deletion_requests%rowtype;
  v_members uuid[];
  v_keys    integer := 0;
  v_detail  jsonb;
begin
  perform public._privacy_require_service_role('privacy_org_lockout');

  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found or v_row.kind <> 'org' or v_row.status <> 'running' then
    raise exception 'privacy_org_lockout: not a running company-deletion request' using errcode = 'check_violation';
  end if;
  if v_row.steps ? 'lockout' then
    return v_row.steps -> 'lockout';
  end if;
  if not (v_row.steps ? 'stripe_cancel') then
    raise exception 'privacy_org_lockout: the subscription step has not run — refusing' using errcode = 'check_violation';
  end if;

  -- Serialise against anything else touching this org's access.
  perform 1 from public.organizations where id = v_row.target_org_id for update;
  if not found then
    v_detail := jsonb_build_object('members', 0, 'api_keys', 0, 'org_present', false, 'done_at', now());
    update public.privacy_deletion_requests
       set steps = steps || jsonb_build_object('lockout', v_detail),
           work = work || jsonb_build_object('member_ids', coalesce(work -> 'member_ids', '[]'::jsonb))
     where id = p_request_id;
    return v_detail;
  end if;

  select coalesce(array_agg(user_id order by user_id), '{}') into v_members
    from public.memberships where org_id = v_row.target_org_id;

  update public.organizations
     set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now())
   where id = v_row.target_org_id;

  -- memberships → membership_permissions, staff_qualifications cascade.
  delete from public.memberships where org_id = v_row.target_org_id;
  if to_regclass('public.api_keys') is not null then
    delete from public.api_keys where org_id = v_row.target_org_id;
    get diagnostics v_keys = row_count;
  end if;

  v_detail := jsonb_build_object(
    'members', coalesce(array_length(v_members, 1), 0), 'api_keys', v_keys,
    'org_present', true, 'done_at', now());
  update public.privacy_deletion_requests
     set steps = steps || jsonb_build_object('lockout', v_detail),
         work = work || jsonb_build_object('member_ids', to_jsonb(v_members))
   where id = p_request_id;
  return v_detail;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART C — TEARDOWN: one transaction, fail-closed, catalogue-verified
-- ═════════════════════════════════════════════════════════════════════════════
-- The target organisation is read FROM THE LEDGER ROW, never from the caller: a
-- retry, a replay or a buggy executor cannot point this at another tenant.
--
-- Order (load-bearing):
--   a. refuse unless lockout AND storage are recorded, and unless Storage is
--      verifiably EMPTY for this org (bytes are removed through the Storage API
--      by the executor; a row-only delete here would orphan them).
--   b. COUNT every table carrying this org's rows — the tombstone's evidence.
--   c. ARCHIVE CrewFlow's own billing facts in minimised form.
--   d. clear the references the cascade would NOT remove: every FK to
--      organizations that is not ON DELETE CASCADE. Provider-webhook logs
--      (billing_events, email_webhook_events, whatsapp_webhook_events) are
--      ON DELETE SET NULL — left alone they would survive as org-less rows still
--      holding the payload. demo_requests (the sales record that became this
--      customer) is scrubbed in place, keeping only its funnel facts.
--   e. `delete from organizations` — the teardown cascade.
--   f. VERIFY against the live catalogue: no public table may still hold a row
--      with this org_id. Anything left RAISES and the whole transaction rolls
--      back — a new table that neither cascades nor is handled here cannot be
--      silently skipped.
create or replace function public.privacy_org_teardown(
  p_request_id      uuid,
  p_retention_until date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row      public.privacy_deletion_requests%rowtype;
  v_org      uuid;
  v_tbl      text;
  v_col      text;
  v_n        bigint;
  v_counts   jsonb := '{}'::jsonb;
  v_tables   integer := 0;
  v_rows     bigint := 0;
  v_archived integer := 0;
  v_rc       integer;
  v_left     text[] := '{}';
  v_detail   jsonb;
begin
  perform public._privacy_require_service_role('privacy_org_teardown');

  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found or v_row.kind <> 'org' or v_row.status <> 'running' then
    raise exception 'privacy_org_teardown: not a running company-deletion request' using errcode = 'check_violation';
  end if;
  if v_row.steps ? 'teardown' then
    return v_row.steps -> 'teardown';
  end if;
  if not (v_row.steps ? 'lockout') or not (v_row.steps ? 'storage') then
    raise exception 'privacy_org_teardown: lockout and storage must run first — refusing' using errcode = 'check_violation';
  end if;
  if p_retention_until is null or p_retention_until <= current_date then
    raise exception 'privacy_org_teardown: a future retention date is required' using errcode = 'check_violation';
  end if;
  v_org := v_row.target_org_id;

  -- a. Storage must already be empty for this org (objects are org-prefixed).
  select count(*) into v_n from storage.objects where split_part(name, '/', 1) = v_org::text;
  if v_n > 0 then
    raise exception 'privacy_org_teardown: % storage object(s) remain for this org — re-run the storage step', v_n
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.organizations where id = v_org) then
    -- b. Evidence: per-table row counts (tables with rows only).
    for v_tbl in
      select c.relname
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.atttypid = 'uuid'::regtype
      order by c.relname
    loop
      execute format('select count(*) from public.%I where org_id = $1', v_tbl) into v_n using v_org;
      if v_n > 0 then
        v_counts := v_counts || jsonb_build_object(v_tbl, v_n);
        v_tables := v_tables + 1;
        v_rows   := v_rows + v_n;
      end if;
    end loop;

    -- c. CrewFlow's own billing record of this customer, minimised.
    insert into public.privacy_retained_billing_records
      (request_id, former_org_id, record_kind, source_id, plan,
       stripe_customer_id, stripe_subscription_id, source_created_at, retention_until)
    select p_request_id, o.id, 'org_account', o.id, o.plan,
           o.stripe_customer_id, o.stripe_subscription_id, o.created_at, p_retention_until
    from public.organizations o where o.id = v_org
    on conflict (request_id, record_kind, source_id) do nothing;
    get diagnostics v_rc = row_count;
    v_archived := v_archived + v_rc;

    insert into public.privacy_retained_billing_records
      (request_id, former_org_id, record_kind, source_id,
       stripe_invoice_id, stripe_payment_intent_id, invoice_kind, invoice_status,
       amount_gbp, currency, period_start, period_end, due_date, paid_at,
       source_created_at, retention_until)
    select p_request_id, b.org_id, 'billing_invoice', b.id,
           b.stripe_invoice_id, b.stripe_payment_intent_id, b.kind, b.status,
           b.amount_gbp, b.currency, b.period_start, b.period_end, b.due_date, b.paid_at,
           b.created_at, p_retention_until
    from public.billing_invoices b where b.org_id = v_org
    on conflict (request_id, record_kind, source_id) do nothing;
    get diagnostics v_rc = row_count;
    v_archived := v_archived + v_rc;

    -- d. References the cascade would leave behind.
    for v_tbl, v_col in
      select rel.relname, att.attname
      from pg_constraint c
      join pg_class rel on rel.oid = c.conrelid
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.confrelid = 'public.organizations'::regclass
        and c.confdeltype <> 'c'
        and rel.relnamespace = 'public'::regnamespace
        and array_length(c.conkey, 1) = 1
      order by rel.relname
    loop
      if v_tbl = 'demo_requests' then
        -- CrewFlow's own sales record of the person who became this customer:
        -- keep the funnel facts (status, timestamps, Stripe session), drop identity.
        execute format(
          'update public.demo_requests set name = %L, company = %L, email = %L, phone = null, '
          'notes = null, user_agent = null, current_systems = null, preferred_demo_time = null, '
          'employees = null, turnover_range = null, rejection_reason = null, notification_error = null '
          'where %I = $1',
          '[erased]', '[erased]', 'erased@deleted.invalid', v_col) using v_org;
      else
        execute format('delete from public.%I where %I = $1', v_tbl, v_col) using v_org;
      end if;
      get diagnostics v_rc = row_count;
      if v_rc > 0 and not (v_counts ? v_tbl) then
        v_counts := v_counts || jsonb_build_object(v_tbl, v_rc);
      end if;
    end loop;

    -- e. The teardown cascade.
    delete from public.organizations where id = v_org;
  end if;

  -- f. Catalogue-wide verification — nothing may still carry this org id.
  for v_tbl in
    select c.relname
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.atttypid = 'uuid'::regtype
    order by c.relname
  loop
    execute format('select count(*) from public.%I where org_id = $1', v_tbl) into v_n using v_org;
    if v_n > 0 then
      v_left := array_append(v_left, v_tbl || '=' || v_n);
    end if;
  end loop;
  if array_length(v_left, 1) is not null then
    raise exception 'privacy_org_teardown: rows survive the teardown cascade in: % — NOTHING committed', v_left
      using errcode = 'raise_exception';
  end if;

  v_detail := jsonb_build_object(
    'tables', v_tables, 'rows', v_rows, 'billing_records_archived', v_archived, 'done_at', now());
  update public.privacy_deletion_requests
     set steps = steps || jsonb_build_object('teardown', v_detail),
         counts = counts || jsonb_build_object('org_tables', v_counts),
         retention_until = p_retention_until
   where id = p_request_id;
  return v_detail;
end;
$$;

-- ── PRIVILEGE LOCKDOWN (service_role only) ───────────────────────────────────
revoke all on function public.privacy_org_lockout(uuid) from public;
revoke execute on function public.privacy_org_lockout(uuid) from anon, authenticated;
grant  execute on function public.privacy_org_lockout(uuid) to service_role;

revoke all on function public.privacy_org_teardown(uuid, date) from public;
revoke execute on function public.privacy_org_teardown(uuid, date) from anon, authenticated;
grant  execute on function public.privacy_org_teardown(uuid, date) to service_role;
